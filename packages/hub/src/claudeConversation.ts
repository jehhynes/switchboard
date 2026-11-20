import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationMessage, Session } from '@switchboard/core';
import { findTranscript } from '@switchboard/claude';
import { SessionCommands, SessionConversation, SessionInput, SNAPSHOT_SCROLLBACK, readSnapshot } from '@switchboard/conversation';
import type { InputOutcome, SlashCommand } from '@switchboard/conversation';
import type { ConversationServiceDeps } from './conversation.js';
import type { ConversationAdapter, ConversationChanged, SendGuard, ResolveGuard } from './conversationAdapter.js';

const SCREEN_AFTER_MS = 5_000;
const HOLDER_ANSWER_MS = 5_000;
const RESTARTED = 'Switchboard restarted while the message was being typed and could not read its input box: check the terminal before sending it again.';
const RESTARTED_UNTYPED = 'Switchboard restarted before typing the message. Send it again.';
/** Reads with a clock: when each event was sent, for the latency check of architecture.md § Conversation. */
interface Reader {
  conversation: SessionConversation;
  workItemId: number;
  lastBusy: number;
  rev: number | null;
  /** The transcript file found for a Claude session ID. */
  path: { nativeSessionId: string; path: string } | null;
}


/** Claude's transcript, screen and guarded terminal input, isolated from the shared conversation service. */
export class ClaudeConversationAdapter implements ConversationAdapter {
  readonly #readers = new Map<string, Reader>();
  readonly #inputs = new Map<string, SessionInput>();
  readonly #commands = new Map<string, SessionCommands>();
  readonly #ansiTheme: boolean;
  constructor(private readonly deps: ConversationServiceDeps, private readonly changed: ConversationChanged) {
    this.#ansiTheme = ansiTheme(deps.claudeConfig);
  }
  supports(session: Session): boolean { return session.codeMode === true; }
  cannotSend(): string | null { return this.deps.input.cannotType(); }
  close(): void { this.#readers.clear(); this.#commands.clear(); }
  async poll(sessions: Session[]): Promise<void> {
    const live = sessions.filter(session => this.supports(session) && session.nativeSessionId !== null && session.state !== 'starting');
    for (const session of live) await this.#read(session);
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

  #readTranscript(reader: Reader, session: Session): void {
    const native = session.nativeSessionId;

    if (native === null) {
      return;
    }

    if (reader.path?.nativeSessionId !== native) {
      const found = findTranscript(this.deps.projectsDir, session.cwd, native);

      reader.path = found === null ? null : { nativeSessionId: native, path: found.path };
    }

    reader.conversation.readTranscript(reader.path?.path ?? null);
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
        sleep: this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        log: this.deps.log,
      });
      this.#inputs.set(id, input);
    }

    return input;
  }


  #check(id: string, launch: string | null): string | null {
    const session = this.deps.store.session(id);
    return session === null || session.state === 'ended' ? 'The session ended.' : (session.launchId ?? null) !== launch ? 'The session was relaunched.' : null;
  }
}
/** The holder's answer, or a failure once it has not answered in `HOLDER_ANSWER_MS`, so a typed message never waits on it for ever. */
function answered<T>(request: Promise<T>, ms = HOLDER_ANSWER_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([request, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('The terminal holder did not answer.')), ms)))]).finally(() => clearTimeout(timer));
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
