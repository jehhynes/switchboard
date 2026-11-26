import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sessionName } from '@switchboard/core';
import type { ConversationMessage, Session } from '@switchboard/core';
import { findTranscript } from '@switchboard/claude';
import { SessionCommands, SessionConversation, SessionInput, SNAPSHOT_SCROLLBACK, TranscriptContext, readSnapshot } from '@switchboard/conversation';
import type { ContextView, InputOutcome, SlashCommand } from '@switchboard/conversation';
import type { ConversationServiceDeps } from './conversation.js';
import type { ConversationAdapter, ConversationChanged, SendGuard, ResolveGuard } from './conversationAdapter.js';

const SCREEN_AFTER_MS = 5_000;
const HOLDER_ANSWER_MS = 5_000;
const RESTARTED = 'Switchboard restarted while the message was being typed and could not read its input box: check the terminal before sending it again.';
const RESTARTED_UNTYPED = 'Switchboard restarted before typing the message. Send it again.';
/** How often, and how many times, a turn end waits for Claude Code to write the turn's last lines. */
const TURN_END_POLL_MS = 50;
const TURN_END_TRIES = 40;
/** How much of a transcript's end the first turn-end check reads. */
const TURN_TAIL_BYTES = 256 * 1024;
/**
 * How many sessions a poll reads at once: the holder takes 15 ms or more for each busy session's screen, so 30 read one after another took
 * 450 ms or more (mechanics M165).
 */
const POLL_READS = 4;
/** Reads with a clock: when each event was sent, for the latency check of architecture.md § Conversation. */
interface Reader {
  conversation: SessionConversation;
  workItemId: number;
  lastBusy: number;
  rev: number | null;
  /** The transcript file found for a Claude session ID. */
  path: { nativeSessionId: string; path: string } | null;
  titleVersion?: string;
  titleOffset?: number;
  lastTitle?: string;
  lastTitleOrigin?: 'provider-manual' | 'provider-auto';
  turnOffset?: number;
  /** The transcript read so far ends inside a turn. */
  inTurn?: boolean;
  /** Why the conversation's last transcript read failed, logged once. */
  readError?: string;
}


/** Claude's transcript, screen and guarded terminal input, isolated from the shared conversation service. */
export class ClaudeConversationAdapter implements ConversationAdapter {
  readonly #readers = new Map<string, Reader>();
  readonly #inputs = new Map<string, SessionInput>();
  readonly #commands = new Map<string, SessionCommands>();
  /** Each shown session's context reading, with the transcript it reads, found again only when the Claude session ID changes. */
  readonly #contexts = new Map<string, { nativeSessionId: string; path: string | null; reader: TranscriptContext }>();
  readonly #ansiTheme: boolean;
  constructor(private readonly deps: ConversationServiceDeps, private readonly changed: ConversationChanged) {
    this.#ansiTheme = ansiTheme(deps.claudeConfig);
  }
  supports(session: Session): boolean { return session.codeMode === true; }
  cannotSend(): string | null { return this.deps.input.cannotType(); }
  close(): void { this.#readers.clear(); this.#commands.clear(); this.#contexts.clear(); }
  context(session: Session): ContextView | null {
    const native = session.nativeSessionId;

    if (!this.supports(session) || native === null) {
      this.#contexts.delete(session.id);
      return null;
    }

    let context = this.#contexts.get(session.id);

    if (context?.nativeSessionId !== native) {
      const reader = this.#readers.get(session.id);
      const path = reader?.path?.nativeSessionId === native ? reader.path.path : (findTranscript(this.deps.projectsDir, session.cwd, native)?.path ?? null);

      context = { nativeSessionId: native, path, reader: context?.reader ?? new TranscriptContext() };
      this.#contexts.set(session.id, context);
    } else if (context.path === null) {
      // A transcript not written yet when first looked for.
      context.path = this.#readers.get(session.id)?.path?.path ?? null;
    }

    return context.reader.read(context.path);
  }
  async poll(sessions: Session[]): Promise<void> {
    const live = sessions.filter(session => this.supports(session) && session.nativeSessionId !== null && session.state !== 'starting');
    await eachAtMost(live, POLL_READS, (session) => this.#read(session));
    for (const [id, reader] of this.#readers) {
      if (live.some(s => s.id === id)) continue;
      const ended = this.deps.store.session(id);
      if (ended !== null) this.#readTranscript(reader, ended);
      reader.conversation.end(); this.#readers.delete(id); this.#commands.delete(id);
    }
    for (const [id, input] of this.#inputs) if (!this.#readers.has(id) && input.pending === 0) this.#inputs.delete(id);
  }
  readEnded(session: Session): void {
    if (session.state !== 'ended' || this.#readers.has(session.id)) return;
    const reader = this.#reader(session);
    this.#readTranscript(reader, session); reader.conversation.end(); this.#readers.delete(session.id);
  }
  /** Reads the transcript of a live session at once, as a poll would, without its screen. */
  readNow(session: Session): void {
    if (this.supports(session) && session.nativeSessionId !== null && session.state !== 'starting' && session.state !== 'ended') this.#readTranscript(this.#reader(session), session);
  }
  /** Whether the transcript is not yet read up to the end of the session's current turn, so its last reply may not be written yet. */
  pending(session: Session): boolean {
    if (!this.supports(session) || session.nativeSessionId === null || session.state === 'starting' || session.state === 'ended') return false;
    const reader = this.#reader(session);
    const path = this.#path(reader, session);
    if (path === null) return false;
    try {
      const size = statSync(path).size;
      // A first read starts near the end, so a long transcript is not read whole at a turn end; a shrunk or replaced file starts over.
      if (reader.turnOffset === undefined || size < reader.turnOffset) {
        reader.turnOffset = Math.max(0, size - TURN_TAIL_BYTES);
        delete reader.inTurn;
      }
      const read = linesFrom(path, reader.turnOffset);
      reader.turnOffset = read.offset;
      for (const line of read.lines) {
        let entry: Record<string, unknown>;
        try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (entry['isSidechain'] === true) continue;
        // Claude Code writes stop_hook_summary after a turn's last reply when a Stop hook ran, and turn_duration after it for most turns.
        if (entry['type'] === 'system' && (entry['subtype'] === 'stop_hook_summary' || entry['subtype'] === 'turn_duration')) reader.inTurn = false;
        else if (entry['type'] === 'assistant' || (entry['type'] === 'user' && entry['isMeta'] !== true)) reader.inTurn = true;
      }
    } catch { /* The transcript may be replaced while it is read. */ }
    return reader.inTurn === true;
  }
  /** Waits until the transcript is read up to the end of the current turn, or gives up after about 2 s, so the turn end's read sees its last reply. */
  async catchUp(session: Session): Promise<void> {
    for (let tries = 0; tries < TURN_END_TRIES; tries++) {
      const now = this.deps.store.session(session.id);
      if (now === null || !this.pending(now)) return;
      await this.#sleep(TURN_END_POLL_MS);
    }
  }
  send(session: Session, _message: ConversationMessage, text: string, done: (outcome: InputOutcome) => void, guard: SendGuard): void { void this.#input(session).send(text, done, guard); }
  resolve(message: ConversationMessage, text: string, done: (outcome: InputOutcome) => void, guard: ResolveGuard): void {
    const session = this.deps.store.session(message.sessionId);
    if (session === null || message.pastedAt === null || message.launch == null) { done({delivery:'not-sent',error:message.pastedAt === null ? RESTARTED_UNTYPED : RESTARTED}); return; }
    void this.#input(session).resolve(text, message.pastedAt, done, RESTARTED, guard);
  }
  commands(session: Session): SlashCommand[] {
    let commands = this.#commands.get(session.id);
    if (commands === undefined) { commands = new SessionCommands(); this.#commands.set(session.id, commands); }
    return commands.list(transcriptOf(this.#readers.get(session.id), this.deps.projectsDir, session));
  }
  #reader(session: Session): Reader {
    let reader = this.#readers.get(session.id);

    if (reader === undefined) {
      reader = {
        conversation: new SessionConversation(session.id, session.workItemId, {
          store: this.deps.store,
          now: this.deps.now,
          newId: this.deps.newId,
          onChange: (change) => this.changed(session.id, change),
          log: this.deps.log,
        }),
        workItemId: session.workItemId,
        lastBusy: 0,
        rev: null,
        path: null,
      };
      this.#readers.set(session.id, reader);
    }

    return reader;
  }

  /** The transcript of the session's current Claude session ID, looked up again when the ID changes. */
  #path(reader: Reader, session: Session): string | null {
    const native = session.nativeSessionId;

    if (native === null) {
      return null;
    }

    if (reader.path?.nativeSessionId !== native) {
      const found = findTranscript(this.deps.projectsDir, session.cwd, native);

      reader.path = found === null ? null : { nativeSessionId: native, path: found.path };
      reader.titleOffset = 0;
      delete reader.turnOffset;
      delete reader.inTurn;
      delete reader.lastTitle;
      delete reader.lastTitleOrigin;
      delete reader.titleVersion;
    }

    return reader.path?.path ?? null;
  }

  #readTranscript(reader: Reader, session: Session): void {
    if (session.nativeSessionId === null) {
      return;
    }

    const path = this.#path(reader, session);
    try {
      reader.conversation.readTranscript(path);
      delete reader.readError;
    } catch (error) {
      // A transcript the conversation cannot read, such as one too large for a string, still gives its title, and stops no other session's read.
      const message = String(error);
      if (reader.readError !== message) this.deps.log(`session ${session.id} conversation read failed: ${message}`);
      reader.readError = message;
    }
    if (path === null || this.deps.providerTitle === undefined) return;
    const item = this.deps.store.workItem(session.workItemId);
    const ticket = item === null ? null : this.deps.store.ticket(item.ticketId);
    if (item === null || ticket?.source !== 'adhoc' || !(item.interactive || ticket.hostWindow != null)) return;
    try {
      const stat = statSync(path);
      const version = `${stat.mtimeMs}:${stat.size}`;
      if (reader.titleVersion === version) return;
      reader.titleVersion = version;
      const lines = titleLines(path, reader.titleOffset ?? 0, (offset) => (reader.titleOffset = offset));
      let latest: { title: string; origin: 'provider-manual' | 'provider-auto' } | null = null;
      for (const line of lines) {
        let entry: Record<string, unknown>;
        try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const origin = entry['type'] === 'custom-title' ? 'provider-manual' : entry['type'] === 'ai-title' ? 'provider-auto' : null;
        const title = entry['customTitle'] ?? entry['aiTitle'] ?? entry['title'];
        if (origin !== null && typeof title === 'string' && title.trim() !== '' && title !== sessionName(session.kind, item, ticket)) latest = { title: title.trim(), origin };
      }
      if (latest !== null && (latest.title !== reader.lastTitle || latest.origin !== reader.lastTitleOrigin)) {
        reader.lastTitle = latest.title;
        reader.lastTitleOrigin = latest.origin;
        this.deps.providerTitle(session.workItemId, latest.title, latest.origin);
      }
    } catch { /* The transcript may be replaced while it is read. */ }
  }

  async #read(session: Session): Promise<void> {
    const reader = this.#reader(session);
    const busy = session.state === 'running';
    const now = this.deps.now();

    if (busy) {
      reader.lastBusy = now;
    }

    // The screen first, so a reply drawn just before its transcript line was written is held for it, not published from the screen after it.
    if (now - reader.lastBusy < SCREEN_AFTER_MS) {
      const screen = await this.deps.screen(session.id, SNAPSHOT_SCROLLBACK).catch(() => null);

      if (screen !== null && screen.rev !== reader.rev) {
        reader.rev = screen.rev;
        reader.conversation.readScreen(await readSnapshot(screen, this.#ansiTheme));
      }
    }

    this.#readTranscript(reader, session);
    reader.conversation.tick(busy);
  }

  #input(session: Session): SessionInput {
    let input = this.#inputs.get(session.id);

    if (input === undefined) {
      const id = session.id;

      input = new SessionInput(id, {
        snapshot: async () => {
          const screen = await answered(this.deps.screen(id, 0), this.deps.holderAnswerMs);

          if (screen === null) {
            throw new Error('The terminal holder is not connected.');
          }

          return { ...screen, keyAt: screen.keyAt ?? null };
        },
        write: (data) => answered(this.deps.input.write(id, data), this.deps.holderAnswerMs),
        transcriptPath: () => transcriptOf(this.#readers.get(id), this.deps.projectsDir, this.deps.store.session(id)),
        check: () => this.#check(id, this.deps.store.session(id)?.launchId ?? null),
        reserve: () => this.deps.input.reserve(id, this.deps.store.session(id)?.launchId ?? null),
        now: this.deps.now,
        sleep: (ms) => this.#sleep(ms),
        log: this.deps.log,
      });
      this.#inputs.set(id, input);
    }

    return input;
  }


  #sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }

  #check(id: string, launch: string | null): string | null {
    const session = this.deps.store.session(id);
    return session === null || session.state === 'ended' ? 'The session ended.' : (session.launchId ?? null) !== launch ? 'The session was relaunched.' : null;
  }
}
/** Runs `run` for each item, at most `limit` at once and each item once; once all have settled, throws the first failure. */
async function eachAtMost<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const failures: unknown[] = [];

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      try { await run(items[next++]!); } catch (error) { failures.push(error); }
    }
  }));

  if (failures.length > 0) throw failures[0];
}

/** The holder's answer, or a failure once it has not answered in `HOLDER_ANSWER_MS`, so a typed message never waits on it for ever. */
function answered<T>(request: Promise<T>, ms = HOLDER_ANSWER_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([request, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('The terminal holder did not answer.')), ms)))]).finally(() => clearTimeout(timer));
}

/** The complete lines written to a file after `offset`, and the offset after the last of them; a file that shrank is read from its start. */
function linesFrom(path: string, offset: number): { lines: string[]; offset: number } {
  const size = statSync(path).size;
  const start = size < offset ? 0 : offset;
  const buffer = Buffer.alloc(size - start);
  const handle = openSync(path, 'r');
  let read = 0;
  try {
    while (read < buffer.length) {
      const count = readSync(handle, buffer, read, buffer.length - read, start + read);
      if (count === 0) break;
      read += count;
    }
  } finally { closeSync(handle); }
  const end = read === 0 ? 0 : buffer.lastIndexOf(10, read - 1) + 1;
  return { lines: end === 0 ? [] : buffer.toString('utf8', 0, end - 1).split('\n'), offset: start + end };
}

/** How much of a transcript one title read holds at once. */
const TITLE_CHUNK = 4 << 20;
/** Bytes every title line holds, its `type`. */
const TITLE_KEYS = [Buffer.from('ai-title'), Buffer.from('custom-title')];

/**
 * The whole lines after `offset` that may name a title, found by their bytes before any is decoded, read `chunk` bytes at a time, so a
 * transcript too large for one string still yields its titles (mechanics M165). A line longer than a chunk is no title line and is passed over;
 * a file that shrank is read from its start. `advance` gets the offset after each chunk's last whole line, so the next read starts there even
 * when a line does not parse or the read fails part way.
 */
export function titleLines(path: string, offset: number, advance: (offset: number) => void, chunk = TITLE_CHUNK): string[] {
  const size = statSync(path).size;
  let start = size < offset ? 0 : offset;
  const lines: string[] = [];
  const buffer = Buffer.alloc(Math.min(chunk, Math.max(size - start, 0)));
  const handle = openSync(path, 'r');
  // Inside a line longer than a chunk, which is passed over to its end.
  let skipping = false;

  try {
    while (start < size) {
      const count = readSync(handle, buffer, 0, Math.min(buffer.length, size - start), start);
      if (count === 0) break;
      const data = buffer.subarray(0, count);
      const end = data.lastIndexOf(10) + 1;

      if (end === 0) {
        // No line ends in this chunk: a line longer than a chunk, unless the file ends here, when its last line is not written whole yet.
        if (start + count >= size) break;
        skipping = true;
        start += count;
        continue;
      }

      let from = 0;

      if (skipping) {
        from = data.indexOf(10) + 1;
        skipping = false;
      }

      const whole = data.subarray(from, end);
      const found = new Set<number>();

      for (const key of TITLE_KEYS) {
        for (let at = whole.indexOf(key); at >= 0; at = whole.indexOf(key, at + key.length)) {
          found.add(whole.lastIndexOf(10, at) + 1);
        }
      }

      for (const lineStart of [...found].sort((a, b) => a - b)) {
        const lineEnd = whole.indexOf(10, lineStart);
        lines.push(whole.toString('utf8', lineStart, lineEnd));
      }

      start += end;
      advance(start);
    }
  } catch {
    // The transcript may be replaced while it is read; the lines found so far stand, and the next change reads on from the last whole chunk.
  } finally {
    closeSync(handle);
  }

  return lines;
}

/** The transcript file of a session's current Claude session ID, from its reader's lookup when it has one. */
function transcriptOf(reader: Reader | undefined, projectsDir: string, session: Session | null): string | null {
  if (session?.nativeSessionId == null) {
    return null;
  }

  return reader?.path?.nativeSessionId === session.nativeSessionId ? reader.path.path : (findTranscript(projectsDir, session.cwd, session.nativeSessionId)?.path ?? null);
}

/** Whether Claude Code draws in one of its ANSI themes, from the global config the session reads (claude-collab `session.js`). */
export function ansiTheme(claudeConfig: string): boolean {
  try {
    return /ansi/i.test(String((JSON.parse(readFileSync(claudeConfig, 'utf8')) as { theme?: unknown }).theme ?? ''));
  } catch {
    return false;
  }
}

/** Claude's projects folder and global config for a settings path under `CLAUDE_CONFIG_DIR` or `~/.claude`. */
export function claudePaths(claudeRoot: string, home: string, configDirSet: boolean): { projectsDir: string; claudeConfig: string } {
  return { projectsDir: join(claudeRoot, 'projects'), claudeConfig: configDirSet ? join(claudeRoot, '.claude.json') : join(home, '.claude.json') };
}
