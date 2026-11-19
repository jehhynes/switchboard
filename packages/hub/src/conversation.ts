import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inTranscript } from '@switchboard/core';
import type { ConversationMessage, ConversationReply, Session, Store } from '@switchboard/core';
import { CONVERSATION_RULES_VERSION, PERMISSION_PROMPT, START_PROMPT } from '@switchboard/core';
import { findTranscript } from '@switchboard/claude';
import { SNAPSHOT_SCROLLBACK, SessionConversation, readSnapshot } from '@switchboard/conversation';
import type { ConversationChange } from '@switchboard/conversation';
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

export type MessageView = { type: 'message' } & Omit<ConversationMessage, 'workItemId' | 'transcriptUuid'>;
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

  return { ...view, provisional: !inTranscript(item) } as ItemView;
}

/** A screen read of a held session from the holder; null when the holder is not connected or does not serve snapshots. */
export type ReadHeldScreen = (session: string, scrollback: number) => Promise<{ data: string; cols: number; rows: number; rev: number } | null>;

export interface ConversationServiceDeps {
  store: Store;
  windows: WindowScopes;
  /** Claude's `projects` folder, under `CLAUDE_CONFIG_DIR` or `~/.claude`. */
  projectsDir: string;
  /** Claude's global config, whose theme says whether inline code is palette blue. */
  claudeConfig: string;
  screen: ReadHeldScreen;
  hooks(): boolean;
  now(): number;
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
  readonly #streams = new Map<string, Set<Send>>();
  #timer: NodeJS.Timeout | null = null;
  #polling = false;
  #seq = 0;
  readonly #ansiTheme: boolean;

  constructor(private readonly deps: ConversationServiceDeps) {
    this.#ansiTheme = ansiTheme(deps.claudeConfig);
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

  #changed(sessionId: string, change: ConversationChange): void {
    const item = change.type === 'message' ? itemView({ type: 'message', ...change.message }) : itemView({ type: 'reply', ...change.reply });

    for (const key of this.deps.windows.showing(sessionId)) {
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
