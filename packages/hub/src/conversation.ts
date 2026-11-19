import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inTranscript } from '@switchboard/core';
import type { ConversationMessage, ConversationReply, Session, Store } from '@switchboard/core';
import { CONVERSATION_RULES_VERSION, PERMISSION_PROMPT, START_PROMPT } from '@switchboard/core';
import { findTranscript } from '@switchboard/claude';
import { MAX_MESSAGE_CHARS, NotWritten, SNAPSHOT_SCROLLBACK, SessionConversation, SessionInput, readSnapshot } from '@switchboard/conversation';
import type { ConversationChange, InputOutcome } from '@switchboard/conversation';
import { SESSION_ENDED, SESSION_RELAUNCHED } from './runtime.js';
import type { WindowScope, WindowScopes } from './windows.js';

/** Conversation API version (architecture.md § Conversation API). */
export const CONVERSATION_PROTOCOL = 1;
/** How often the hub reads each live Code Mode session's transcript, and its screen while it works. */
export const CONVERSATION_POLL_MS = 300;
/** The screen is read this long after the session last worked, so a reply drawn as its turn ends is read. */
const SCREEN_AFTER_MS = 5_000;
/** Items a window's `hello` and each `history` page carry. */
export const PAGE_ITEMS = 100;

/** How a session shows in a window's Conversation view. */
export interface SessionView {
  id: string;
  kind: 'setup' | 'task';
  title: string;
  state: 'starting' | 'running' | 'waiting' | 'idle' | 'ended';
  waitingFor: 'question' | 'permission' | 'start-prompt' | null;
  launch: string | null;
  current: boolean;
  /** `full`: a live, observed Code Mode session; `read-only`: one that ended or is unobserved; `none`: a background session. */
  conversation: 'full' | 'read-only' | 'none';
  reason: string | null;
  /** Whether its prompt carries the current conversation rules; a session without them shows its replies whole. */
  rules: 'current' | 'older' | 'none';
}

export type MessageView = { type: 'message' } & Omit<ConversationMessage, 'workItemId' | 'transcriptUuid' | 'opId' | 'pastedAt'>;
/** `provisional`: not in the transcript yet, so placed by when it was first seen (`inTranscript`). */
export type ReplyView = { type: 'reply'; provisional: boolean } & Omit<ConversationReply, 'workItemId' | 'transcriptUuid'>;
export type ItemView = MessageView | ReplyView;

export function sessionView(session: Session, current: boolean, hooks: boolean): SessionView {
  const state = session.state === 'failed' ? 'idle' : session.state;
  const waitingFor = session.state !== 'waiting' ? null : session.stateDetail === PERMISSION_PROMPT ? 'permission' : session.stateDetail === START_PROMPT ? 'start-prompt' : 'question';
  const conversation = session.codeMode !== true ? 'none' : session.state === 'ended' || !hooks ? 'read-only' : 'full';
  const reason =
    conversation === 'none'
      ? 'This session runs in the background; open it in Claude to talk to it.'
      : session.state === 'ended'
        ? 'The session has ended. Open it in the terminal to resume it.'
        : conversation === 'read-only'
          ? 'Switchboard cannot follow this session while sessions.installHooks is off.'
          : null;

  return {
    id: session.id,
    kind: session.kind,
    title: `${session.kind === 'setup' ? 'Setup' : 'Task'} session ${session.shortId ?? session.id}`,
    state,
    waitingFor,
    launch: session.launchId ?? null,
    current,
    conversation,
    reason,
    rules: session.rulesVersion === CONVERSATION_RULES_VERSION ? 'current' : session.rulesVersion == null ? 'none' : 'older',
  };
}

export function itemView(item: ({ type: 'message' } & ConversationMessage) | ({ type: 'reply' } & ConversationReply)): ItemView {
  const { workItemId: _workItemId, transcriptUuid: _transcriptUuid, ...view } = item;

  if (view.type === 'message') {
    delete (view as { opId?: unknown }).opId;
    delete (view as { pastedAt?: unknown }).pastedAt;
  }

  return { ...view, provisional: !inTranscript(item) } as ItemView;
}

/** A screen read of a held session from the holder; null when the holder is not connected or does not serve snapshots. */
export type ReadHeldScreen = (session: string, scrollback: number) => Promise<{ data: string; cols: number; rows: number; rev: number; keyAt?: number | null } | null>;

/** Typing into held sessions (architecture.md § Typing a message): the runtime's input reservation and the holder's `write`. */
export interface HeldInput {
  reserve(sessionId: string, launch: string | null): Promise<{ release(): void } | { refused: string }>;
  write(session: string, data: string): Promise<{ rev: number }>;
  /** Why the holder cannot take `write`, as one from an older build cannot; null when it can. */
  cannotType(): string | null;
}

/** Why a message waiting to be typed is no longer typed into its session. */
export const NEWER_SESSION = 'A newer session of this work item started; the message was not sent.';
const RESTARTED = 'Switchboard restarted while the message was being typed; check the terminal.';

export interface ConversationServiceDeps {
  store: Store;
  windows: WindowScopes;
  /** Claude's `projects` folder, under `CLAUDE_CONFIG_DIR` or `~/.claude`. */
  projectsDir: string;
  /** Claude's global config, whose theme says whether inline code is palette blue. */
  claudeConfig: string;
  screen: ReadHeldScreen;
  input: HeldInput;
  hooks(): boolean;
  now(): number;
  /** How long a typed message waits for the holder's answer; `HOLDER_ANSWER_MS` by default. */
  holderAnswerMs?: number;
  /** Waits between screen reads while a message is typed; a timer by default. */
  sleep?(ms: number): Promise<void>;
  newId(): string;
  log(line: string): void;
}

type Send = (type: string, payload: Record<string, unknown>) => void;

/** Reads with a clock: when each event was sent, for the latency check of architecture.md § Conversation. */
interface Reader {
  conversation: SessionConversation;
  workItemId: number;
  lastBusy: number;
  rev: number | null;
  /** The transcript file found for a Claude session ID. */
  path: { nativeSessionId: string; path: string } | null;
}

/**
 * The conversation layer in the hub (architecture.md § Conversation): it follows every live Code Mode session's transcript, and its screen while it
 * works, keeps the conversation in the store, and serves each window the conversation of its own work item's current session only.
 */
export class ConversationService {
  readonly #readers = new Map<string, Reader>();
  readonly #inputs = new Map<string, SessionInput>();
  readonly #streams = new Map<string, Set<Send>>();
  #timer: NodeJS.Timeout | null = null;
  #polling = false;
  #seq = 0;
  readonly #ansiTheme: boolean;

  constructor(private readonly deps: ConversationServiceDeps) {
    this.#ansiTheme = ansiTheme(deps.claudeConfig);

    // A message the stopped hub was typing may or may not have gone; it is never typed again.
    for (const message of deps.store.settleOpenMessages(RESTARTED)) {
      deps.log(`session ${message.sessionId}: message ${message.id} left open by a stopped hub is uncertain`);
    }
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.poll(), CONVERSATION_POLL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** One read of every live Code Mode session; a read still running skips the next. */
  async poll(): Promise<void> {
    if (this.#polling) {
      return;
    }

    this.#polling = true;

    try {
      const live = this.deps.store.activeSessions().filter((session) => session.codeMode === true && session.nativeSessionId !== null && session.state !== 'starting');

      for (const session of live) {
        await this.#read(session);
      }

      for (const id of [...this.#readers.keys()].filter((id) => !live.some((session) => session.id === id))) {
        // The last lines a session wrote before it ended.
        const ended = this.deps.store.session(id);

        const reader = this.#readers.get(id)!;

        if (ended !== null) {
          this.#readTranscript(reader, ended);
        }

        reader.conversation.end();
        this.#readers.delete(id);
      }

      // A queue is kept while it holds a message, so a session's messages are never typed by two queues at once.
      for (const id of [...this.#inputs.keys()].filter((id) => !live.some((session) => session.id === id) && !this.#readers.has(id) && this.#inputs.get(id)!.pending === 0)) {
        this.#inputs.delete(id);
      }
    } catch (error) {
      this.deps.log(`conversation read failed: ${String(error)}`);
    } finally {
      this.#polling = false;
    }
  }

  #reader(session: Session): Reader {
    let reader = this.#readers.get(session.id);

    if (reader === undefined) {
      reader = {
        conversation: new SessionConversation(session.id, session.workItemId, () => this.deps.store.session(session.id)?.rulesVersion === CONVERSATION_RULES_VERSION, {
          store: this.deps.store,
          now: this.deps.now,
          newId: this.deps.newId,
          onChange: (change) => this.#changed(session.id, change),
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

  /** Sends a change to the windows showing its session, and to `also`, a window that must hear it wherever its scope moved. */
  #changed(sessionId: string, change: ConversationChange, also?: string): void {
    const item = change.type === 'message' ? itemView({ type: 'message', ...change.message }) : itemView({ type: 'reply', ...change.reply });
    const keys = new Set(this.deps.windows.showing(sessionId));

    if (also !== undefined) {
      keys.add(also);
    }

    for (const key of keys) {
      this.#send(key, change.type, change.type === 'message' ? { message: item } : { reply: item });
    }
  }

  #send(key: string, type: string, payload: Record<string, unknown>): void {
    for (const send of this.#streams.get(key) ?? []) {
      send(type, payload);
    }
  }

  /** The SSE frame of an event, with its sequence number and time. */
  frame(type: string, payload: Record<string, unknown>): string {
    const seq = ++this.#seq;

    return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ v: CONVERSATION_PROTOCOL, seq, type, at: this.deps.now(), ...payload })}\n\n`;
  }

  /** Opens a window's conversation stream with its `hello`; null for a key no connected window holds. */
  open(key: string, write: (frame: string) => void): { close(): void } | null {
    if (!this.deps.windows.has(key)) {
      return null;
    }

    const send: Send = (type, payload) => write(this.frame(type, payload));
    const hello = this.hello(key);
    const streams = this.#streams.get(key) ?? new Set<Send>();

    streams.add(send);
    this.#streams.set(key, streams);
    send('hello', hello);

    return {
      close: () => {
        streams.delete(send);

        if (streams.size === 0) {
          this.#streams.delete(key);
        }
      },
    };
  }

  /** The window's scope, its work item's sessions, and its current session's newest items. */
  hello(key: string): Record<string, unknown> {
    const scope = this.deps.windows.scope(key);

    if (scope === null) {
      return { protocol: CONVERSATION_PROTOCOL, scope: null, sessions: [], items: [], more: false };
    }

    const current = scope.sessionId === null ? null : this.deps.store.session(scope.sessionId);

    if (current !== null && current.codeMode === true && current.state === 'ended' && !this.#readers.has(current.id)) {
      // An ended session the hub did not follow to its end, such as one that ended while the hub was down.
      const reader = this.#reader(current);

      this.#readTranscript(reader, current);
      reader.conversation.end();
      this.#readers.delete(current.id);
    }

    const page = scope.sessionId === null ? { items: [], more: false } : this.deps.store.conversation(scope.sessionId, null, PAGE_ITEMS, false);

    return {
      protocol: CONVERSATION_PROTOCOL,
      scope,
      sessions: current === null ? [] : [sessionView(current, true, this.deps.hooks())],
      items: page.items.filter((item) => !item.withdrawn).map(itemView),
      more: page.more,
    };
  }

  /** Tells each window whose work item or current session changed, which then starts from empty with a fresh `hello`. */
  scopesChanged(keys: string[]): void {
    for (const key of keys) {
      this.#send(key, 'scope', { scope: this.deps.windows.scope(key) });
      this.#send(key, 'hello', this.hello(key));
    }
  }

  #shown = new Map<string, string>();
  /** Why recent messages were not sent, by session and `opId`, so a repeated `send` gets the refusal rather than type it again. */
  readonly #unsent = new Map<string, string>();
  /** The window each open typed message came from, which hears that it was not sent even after its scope moved to another session. */
  readonly #senders = new Map<string, string>();

  /** Sends each window its current session again when its state changed, which the header's icon shows. */
  sessionsChanged(): void {
    for (const key of this.#streams.keys()) {
      const scope = this.deps.windows.scope(key);
      const session = scope?.sessionId == null ? null : this.deps.store.session(scope.sessionId);

      if (session === null) {
        continue;
      }

      const view = sessionView(session, true, this.deps.hooks());
      const text = JSON.stringify(view);

      if (this.#shown.get(key) !== text) {
        this.#shown.set(key, text);
        this.#send(key, 'session', { session: view });
      }
    }
  }

  /**
   * `send` (architecture.md § Typing a message): a message typed in the window's composer to its current session. Refused with 403 outside the
   * window's scope, 409 for a stale `scopeGen`, a session that cannot take it or one resumed under another launch, and 400 for an empty or long
   * text. The message is stored `open` and answered at once; its typing runs in the session's queue, and its delivery arrives as `message`
   * events. A repeated `opId` returns the message it added and types nothing again.
   */
  send(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, scopeGen, opId, sessionId, launch, text } = body;

    if (typeof window !== 'string' || typeof scopeGen !== 'number' || typeof opId !== 'string' || opId === '' || opId.length > 200 || typeof sessionId !== 'string' || !(launch === null || typeof launch === 'string') || typeof text !== 'string') {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, launch, text}.' } };
    }

    const scope = this.deps.windows.scope(window);

    if (scope === null) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    const refused = refusal(scope, scopeGen, sessionId);

    if (refused !== null) {
      return refused;
    }

    const unsent = this.#unsent.get(`${sessionId} ${opId}`);

    if (unsent !== undefined) {
      return { status: 409, body: { error: unsent } };
    }

    const earlier = this.deps.store.messageByOpId(sessionId, opId);

    if (earlier !== null) {
      return { status: 200, body: { message: itemView({ type: 'message', ...earlier }) } };
    }

    if (text.trim() === '') {
      return { status: 400, body: { error: 'The message is empty.' } };
    }

    if (text.length > MAX_MESSAGE_CHARS) {
      return { status: 400, body: { error: `The message is longer than ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters.` } };
    }

    const session = this.deps.store.session(sessionId);

    if (session === null) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    const view = sessionView(session, true, this.deps.hooks());

    if (view.conversation !== 'full') {
      return { status: 409, body: { error: view.reason ?? SESSION_ENDED } };
    }

    if ((session.launchId ?? null) !== launch) {
      return { status: 409, body: { error: SESSION_RELAUNCHED } };
    }

    const cannotType = this.deps.input.cannotType();

    if (cannotType !== null) {
      return { status: 409, body: { error: cannotType } };
    }

    // Not in the transcript until Claude receives it, so it waits after the items that are (`inTranscript`).
    const added: Omit<ConversationMessage, 'ord'> = { id: `m-${this.deps.newId()}`, sessionId, workItemId: session.workItemId, at: this.deps.now(), origin: 'typed', text, transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId, pastedAt: null };

    this.deps.store.addMessage(added);
    this.#senders.set(added.id, window);

    const message = this.deps.store.message(added.id)!;

    this.#changed(sessionId, { type: 'message', message });
    void this.#input(session).send(text, (outcome) => this.#delivered(message.id, outcome), {
      check: () => this.#check(sessionId, launch),
      reserve: () => this.deps.input.reserve(sessionId, launch),
      pasting: (at) => this.deps.store.updateMessage(message.id, { pastedAt: at }),
    });

    return { status: 200, body: { message: itemView({ type: 'message', ...message }) } };
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

  /** Why a message for this session and launch can no longer be typed; null while it can. */
  #check(sessionId: string, launch: string | null): string | null {
    const session = this.deps.store.session(sessionId);

    if (session === null || session.state === 'ended') {
      return SESSION_ENDED;
    }

    if ((session.launchId ?? null) !== launch) {
      return SESSION_RELAUNCHED;
    }

    return this.deps.store.sessionsFor(session.workItemId).at(-1)?.id === sessionId ? null : NEWER_SESSION;
  }

  /** A typed message's outcome; a message its transcript entry already confirmed stays sent. */
  #delivered(id: string, outcome: InputOutcome): void {
    const message = this.deps.store.message(id);

    const sender = this.#senders.get(id);

    this.#senders.delete(id);

    if (message === null || message.delivery === 'sent') {
      return;
    }

    if (outcome.delivery !== 'sent') {
      this.deps.log(`session ${message.sessionId}: message ${id} ${outcome.delivery}: ${outcome.error}`);
    }

    // Nothing was typed, so the message leaves the conversation; its last event tells the windows to drop it, and the one that sent it puts its
    // text back in the composer with why.
    if (outcome.delivery === 'not-sent') {
      this.deps.store.deleteMessage(id);
      this.#unsent.set(`${message.sessionId} ${message.opId}`, outcome.error);

      for (const key of [...this.#unsent.keys()].slice(0, -UNSENT_KEPT)) {
        this.#unsent.delete(key);
      }

      this.#changed(message.sessionId, { type: 'message', message: { ...message, delivery: 'not-sent', error: outcome.error, provisional: false } }, sender);
      return;
    }

    // An uncertain message keeps its place; a sent one waits for the line where Claude received it.
    this.deps.store.updateMessage(id, outcome.delivery === 'sent' ? { delivery: 'sent', error: null } : { delivery: outcome.delivery, error: outcome.error, provisional: false });
    this.#changed(message.sessionId, { type: 'message', message: this.deps.store.message(id)! });
  }

  /**
   * Older items of the window's current session: refused with 403 for a key no window holds or a session that is not the window's current one,
   * and with 409 when the window's work item changed since `scopeGen`.
   */
  history(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, scopeGen, sessionId, before, limit } = body;

    if (typeof window !== 'string' || typeof scopeGen !== 'number' || typeof sessionId !== 'string' || !(before === null || typeof before === 'string') || !(limit === undefined || (Number.isInteger(limit) && (limit as number) > 0))) {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, before, limit?}.' } };
    }

    const scope = this.deps.windows.scope(window);
    const refused = refusal(scope, scopeGen, sessionId);

    if (refused !== null) {
      return refused;
    }

    const page = this.deps.store.conversation(sessionId, before, Math.min((limit as number | undefined) ?? PAGE_ITEMS, PAGE_ITEMS), false);

    return { status: 200, body: { items: page.items.filter((item) => !item.withdrawn).map(itemView), more: page.more } };
  }
}

/** How many not-sent `opId`s the service remembers, for a `send` repeated after its message left the conversation. */
const UNSENT_KEPT = 100;

/** How long a typed message waits for the holder to answer a screen read or a write. */
export const HOLDER_ANSWER_MS = 5_000;

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

/** Why a command is refused: a session outside the window's scope, or a scope generation that is no longer the window's. */
export function refusal(scope: WindowScope | null, scopeGen: number, sessionId: string | null): { status: number; body: { error: string } } | null {
  if (scope === null || (sessionId !== null && scope.sessionId !== sessionId)) {
    return { status: 403, body: { error: 'Not in this window.' } };
  }

  return scope.scopeGen === scopeGen ? null : { status: 409, body: { error: "The window's work item changed." } };
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
