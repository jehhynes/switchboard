import { countsUnread, inTranscript } from '@switchboard/core';
import type { ConversationMessage, ConversationReply, ConversationStatus, Interruption, Piece, Provider, Session, SpokenState, Store } from '@switchboard/core';
import { artifactsDir, hostKey, PERMISSION_PROMPT, personaById, sessionTone, START_PROMPT, toneVersion, waitsOnLimit } from '@switchboard/core';
import type { PersonaSettings } from '@switchboard/core';
import { ArtifactFolder, MAX_MESSAGE_CHARS, NotWritten, interruptNote, messageTags, pasteText } from '@switchboard/conversation';
import { promptKeyData, readPrompt, screenRows, stepsText, TYPING_PAUSE_MS } from '@switchboard/conversation';
import type { Artifact, ConversationChange, HeardTag, InputOutcome, InputSteps, PromptKey, ScreenPrompt, SlashCommand } from '@switchboard/conversation';
import { SESSION_ENDED, SESSION_RELAUNCHED } from './runtime.js';
import { canonicalFolder } from './windows.js';
import { artifactFile, findFiles, knownFolder } from './page.js';
import { writeUpload } from './uploads.js';
import type { PageFile, PageHeader, PageListGroup, PageRow } from './page.js';
import type { ConversationRef, WindowScope, WindowScopes } from './windows.js';
import type { VoiceView } from './voice.js';
import { ClaudeConversationAdapter } from './claudeConversation.js';
import type { ConversationAdapter, ConversationChanged, DeliveryOutcome, NativeRequest } from './conversationAdapter.js';
export { ansiTheme, claudePaths } from './claudeConversation.js';

/** Conversation API version (architecture.md § Conversation API). */
export const CONVERSATION_PROTOCOL = 1;
/** How often the hub polls provider adapters for conversation changes. */
export const CONVERSATION_POLL_MS = 300;

/** Items a window's `hello` and each `history` page carry. */
export const PAGE_ITEMS = 100;
/** Statuses each `statuses` page carries. */
export const PAGE_STATUSES = 50;

/** How a session shows in a window's Conversation view. */
export interface SessionView {
  provider?: 'claude' | 'codex';
  id: string;
  kind: 'setup' | 'task';
  title: string;
  state: 'starting' | 'running' | 'waiting' | 'idle' | 'ended';
  waitingFor: 'question' | 'permission' | 'start-prompt' | null;
  launch: string | null;
  current: boolean;
  /** `full`: a live conversation; `read-only`: ended or unobserved; `none`: no adapter. */
  conversation: 'full' | 'read-only' | 'none';
  reason: string | null;
  requests?: NativeRequest[];
  /**
   * The session's persona while `voice.enabled` is on (architecture.md § Personas), else null. `pinned`: the operator pinned it; `tonePending`:
   * the live session's prompt has another tone section until its next resume or compaction.
   */
  persona: { id: string; name: string; pinned: boolean; tonePending: boolean } | null;
  /**
   * The operator can pin a persona to the session from the header, with or without one now: `voice.enabled` is on, the roster is not empty, and
   * it is a Code Mode or app-server session. Absent from an older hub.
   */
  canPin?: boolean;
  /**
   * While the session waits for a usage or rate limit to reset (architecture.md § Rate limits): when it resumes, and `retry` when that is the hub's
   * next attempt rather than the reset. Absent from an older hub.
   */
  limit?: { until: number; retry: boolean } | null;
}

/** The voice settings a session's persona is read from. */
export type PersonaView = PersonaSettings & { enabled: boolean };

/** A message names its work item, so a window that hears one was not sent puts it back in that conversation's draft only. */
export type MessageView = { type: 'message' } & Omit<ConversationMessage, 'transcriptUuid' | 'opId' | 'pastedAt' | 'launch'>;
/**
 * `provisional`: not in the transcript yet, so placed by when it was first seen (`inTranscript`); `unread`: it counts as unread and the operator
 * has not seen it (architecture.md § Unread).
 */
export type ReplyView = { type: 'reply'; provisional: boolean; unread: boolean; speak: string | null; tone: string | null; spoken: SpokenView } & Omit<
  ConversationReply,
  'workItemId' | 'transcriptUuid' | 'seenAt' | 'speak' | 'tone' | 'spokenState' | 'spokenAtMs' | 'saidChars'
>;

/** What became of a reply's speech (architecture.md § Voice): its state, and where playback stopped or stands. */
export interface SpokenView {
  state: SpokenState;
  atMs: number | null;
  saidChars: number | null;
}
export type ItemView = MessageView | ReplyView;

/**
 * The Status tab's status (architecture.md § Statuses): the session's latest `[status]`, or, before its first, the work item's stage as a
 * `fallback`, whose ID names the work item and whose `at` is when the stage was reported.
 */
export interface StatusView {
  id: string;
  sessionId: string | null;
  at: number;
  markdown: string;
  fallback: boolean;
  /** A status the operator has not seen (architecture.md § Unread); never the stage. */
  unread: boolean;
}

/** An artifact of the window's work item (architecture.md § Artifacts); `path` is `<owner>/<file>` in the window's `artifactsDir`. */
export type ArtifactView = Artifact;

export function statusView(status: ConversationStatus): StatusView {
  return { id: status.id, sessionId: status.sessionId, at: status.at, markdown: status.markdown, fallback: false, unread: status.seenAt === null };
}

export function sessionView(session: Session, current: boolean, hooks: boolean, personas: PersonaView | null = null): SessionView {
  const state = session.state === 'failed' ? 'idle' : session.state;
  const waitingFor = session.state !== 'waiting' ? null : session.stateDetail === PERMISSION_PROMPT ? 'permission' : session.stateDetail === START_PROMPT ? 'start-prompt' : 'question';
  // A message to an ended app-server session resumes its thread first (PRD R107); an ended Code Mode session resumes through its attach terminal.
  const resumable = session.execution === 'app-server' && session.nativeSessionId !== null;
  const conversation = session.codeMode !== true && session.execution !== 'app-server' ? 'none' : (session.state === 'ended' && !resumable) || (session.codeMode === true && !hooks) ? 'read-only' : 'full';
  const reason =
    conversation === 'none'
      ? `This session runs in the background; open it in ${session.provider === 'codex' ? 'Codex' : 'Claude'} to talk to it.`
      : session.state === 'ended' && !resumable
        ? 'The session has ended. Open it in the terminal to resume it.'
        : conversation === 'read-only'
          ? 'Switchboard cannot follow this session while sessions.installHooks is off.'
          : null;

  return {
    provider: session.provider,
    id: session.id,
    kind: session.kind,
    title: `${session.kind === 'setup' ? 'Setup' : 'Task'} session ${session.shortId ?? session.id}`,
    state,
    waitingFor,
    launch: session.launchId ?? null,
    current,
    conversation,
    reason,
    persona: personaOf(session, personas),
    canPin: personas !== null && personas.enabled && personas.personas.length > 0 && (session.codeMode === true || session.execution === 'app-server'),
    limit: limitOf(session),
  };
}

/** When a held session waiting on its limit resumes: Claude Code's own reset when it waits itself, else the hub's next attempt. */
function limitOf(session: Session): { until: number; retry: boolean } | null {
  const limit = session.rateLimit;

  if (limit == null || !waitsOnLimit(session) || (session.codeMode !== true && session.execution !== 'app-server')) {
    return null;
  }

  return limit.cli && limit.resetsAt !== null && limit.attempts === 0 ? { until: limit.resetsAt, retry: false } : { until: limit.nextAt, retry: limit.resetsAt === null || limit.attempts > 0 };
}

/** A session's persona as its view shows it, or null with voice off, an empty roster or a persona no longer in it. */
function personaOf(session: Session, settings: PersonaView | null): SessionView['persona'] {
  const persona = settings === null || !settings.enabled ? null : personaById(settings, session.personaId);

  if (persona === null || settings === null) {
    return null;
  }

  const tonePending = session.state !== 'ended' && toneVersion(sessionTone(settings, session)) !== (session.personaVersion ?? null);

  return { id: persona.id, name: persona.name, pinned: session.personaPinned === true, tonePending };
}

export function itemView(item: ({ type: 'message' } & ConversationMessage) | ({ type: 'reply' } & ConversationReply)): ItemView {
  const { transcriptUuid: _transcriptUuid, ...view } = item;

  if (view.type === 'message') {
    delete (view as { opId?: unknown }).opId;
    delete (view as { pastedAt?: unknown }).pastedAt;
    delete (view as { launch?: unknown }).launch;

    return { ...view, provisional: !inTranscript(item) } as ItemView;
  }

  const { seenAt, workItemId: _workItemId, speak, tone, spokenState, spokenAtMs, saidChars, ...reply } = view;

  return { ...reply, speak: speak ?? null, tone: tone ?? null, spoken: { state: spokenState ?? 'none', atMs: spokenAtMs ?? null, saidChars: saidChars ?? null }, provisional: !inTranscript(item), unread: seenAt === null && countsUnread(reply) };
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

/** One entry of the view's dropdown (architecture.md § Window scope): a conversation of the window, by its current session. */
export interface ConversationEntry {
  workItemId: number;
  title: string;
  primary: boolean;
  sessionId: string | null;
  state: SessionView['state'] | null;
  conversation: SessionView['conversation'] | null;
  unread: number;
  /** The current session's provider; left out with no session or from an older session record. */
  provider?: 'claude' | 'codex';
}

/** The scope a window is sent: its conversations as dropdown entries. */
export type ScopeView = Omit<WindowScope, 'conversations'> & { conversations: ConversationEntry[] };

/** Why a message waiting to be typed is no longer typed into its session. */
export const NEWER_SESSION = 'A newer session of this work item started; the message was not sent.';
const RESTARTED = 'Switchboard restarted while the message was being typed and could not read its input box: check the terminal before sending it again.';
const RESTARTED_UNTYPED = 'Switchboard restarted before typing the message. Send it again.';

export interface ConversationServiceDeps {
  adapters?(changed: ConversationChanged): ConversationAdapter[];
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
  /** A session's unread count changed, which the dock's rows show; the hub builds its views again. */
  unreadChanged?(): void;
  /**
   * Makes a hosted conversation (architecture.md § Hosted conversations) for the window binding `hostWindow` in `folder` and starts its session;
   * its work item, or why it was refused.
   */
  newConversation?(hostWindow: string, folder: string, provider?: Provider): { workItemId: number } | { refused: string };
  /** A message was added to a work item's conversation, whose first titles a hosted conversation. */
  messageAdded?(workItemId: number, text: string): void;
  /** Resumes an ended Codex app-server session before a message typed to it is sent (PRD R107); why not, or null. */
  resume?(sessionId: string): Promise<string | null>;
  /** Speech out (architecture.md § Voice); without it no window has voice. */
  voice?: ConversationVoice;
  /** The voice settings personas are read from (architecture.md § Personas); without them no session has a persona. */
  personas?(): PersonaView;
  /** Pins a persona to a session, or clears its pin with null; why not, or null. */
  pinPersona?(sessionId: string, personaId: string | null): string | null;
  /** The web page's list, in the dock's groups (architecture.md § Web page); without it a page lists nothing. */
  pageList?(): PageListGroup[];
  /** The web page's list header: the dock header's sources (architecture.md § Web page). */
  pageHeader?(): PageHeader;
  /** Turns one source on or off, as the dock's source icons do: why not, or null. */
  setSource?(name: string, enabled: boolean): string | null;
  /** Polls each source that is on now, as the dock's Refresh sources does: why not, or null. */
  pollSources?(): string | null;
  /** Runs an operator event the page's New ad-hoc session sends, `adhoc` or `run-schedule`, as the dock's `/action` does: why not, or null. */
  operatorEvent?(event: Record<string, unknown>): string | null;
  /** The Done rows from `since` up to the Done list whose search text holds every word of `text`, as the dock's search further back (PRD R63). */
  searchDone?(text: string, since: number): { rows: PageRow[]; more: boolean };
  /** A page's focus changed: a focused, visible page counts as a focused window for the voice. */
  pageFocused?(key: string, focused: boolean): void;
  /**
   * Runs one of the page's row actions (`PAGE_ACTIONS`) on a work item, after checking that its dock row still offers it: why not, or null
   * (architecture.md § Web page).
   */
  rowAction?(workItemId: number, action: string, snooze: { until: number | null; comment: string | null }): string | null;
  /**
   * Resumes an ended session without a terminal, as the attach terminal's resume does for a Code Mode session and a message does for a Codex
   * app-server session (architecture.md § Web page): why not, or null.
   */
  resumeSession?(sessionId: string): Promise<string | null>;
  /** A drafted text of a work item's row that Copy offers, by its label; null when the row offers none by that label. */
  rowPaste?(workItemId: number, label: string): Promise<string | null>;
  /** The folder the files a page attaches are written to; `UPLOAD_DIR` by default. */
  uploads?: string;
  /** Opens a work item row's ticket URL or link in the default browser, after checking that its dock row holds it now: why not, or null. */
  rowOpen?(workItemId: number, url: string): string | null;
  log(line: string): void;
}

/** What the conversation layer asks of the hub's voice (`VoiceControl`). */
export interface ConversationVoice {
  /** A window's voice state for its `hello`; later changes come as `voice` events. */
  shown(key: string): VoiceView;
  /** The one setting the view reads. */
  settings(): { expandReplies: boolean };
  spokenFor(sessionId: string, command: boolean): { spoken: boolean; expressive: boolean };
  replyChanged(reply: ConversationReply): void;
  talkHere(key: string): string | null;
  stopSpeaking(key: string): string | null;
  setSpeakReplies(on: boolean): void;
  replay(key: string, replyId: string): string | null;
  /** A window's selection or a session changed, which can change the voice's targets. */
  update(): void;
  /** The window selected another conversation: while it has the focus, the voice moves there at once (voice-design § 2.3). */
  selected(key: string): void;
  /** Whether `[expressive]` goes with `[spoken]` (`voice.expressive`). */
  expressive(): boolean;
  /** The pieces of the dictation the window's draft holds, taken as it is sent, or null for a draft with none (architecture.md § Dictation). */
  dictated?(key: string, sessionId: string): Piece[] | null;
  /** The reply the window's dictation spoke over, taken as its draft is sent, or null (architecture.md § Voice check and barge-in). */
  interruption?(key: string, sessionId: string): Interruption | null;
  /** A reply's heard tags, for the glossary. */
  heard?(tags: HeardTag[]): void;
  /** A dictated message settled, for the fragments log. */
  delivered?(message: ConversationMessage): void;
  /** The voice's steps of a dictated message, for its timing line, taken once; null for a message turn detection did not end. */
  timing?(messageId: string): string | null;
  /** The mic command: why it was refused, or null. */
  mic?(key: string, on: boolean): string | null;
  /** The composer command: the window's composer gained or lost the focus, or its draft changed. */
  composer?(key: string, focused: boolean, draft: string): void;
}

/** The most IDs one `seen` command marks. */
export const SEEN_MAX_IDS = 200;

type Send = (type: string, payload: Record<string, unknown>) => void;

/**
 * The conversation layer in the hub (architecture.md § Conversation): it follows every live Code Mode session's transcript, and its screen while it
 * works, keeps the conversation in the store, and serves each window the conversation of its own work item's current session only.
 */
export class ConversationService {
  readonly #adapters: ConversationAdapter[];
  readonly #streams = new Map<string, Set<Send>>();
  /** The artifact folder each shown work item's windows follow, by work item. */
  readonly #artifacts = new Map<number, ArtifactFolder>();
  #timer: NodeJS.Timeout | null = null;
  readonly #polling = new Set<ConversationAdapter>();
  #seq = 0;
  #closed = false;

  constructor(private readonly deps: ConversationServiceDeps) {
    this.#adapters = [new ClaudeConversationAdapter(deps, (id, change) => this.#changed(id, change)), ...(deps.adapters?.((id, change) => this.#changed(id, change)) ?? [])];

    for (const message of deps.store.openMessages()) {
      this.#leftOpen.set(message.sessionId, [...(this.#leftOpen.get(message.sessionId) ?? []), message]);
    }
  }

  /**
   * Typed messages a stopped hub left being typed, by session, settled once a window showing the session opens its stream, so a message that
   * was not sent reaches a composer.
   */
  readonly #leftOpen = new Map<string, ConversationMessage[]>();
  /** Messages a stopped hub left that were settled not sent while no window showed their session, by session, given back when one does. */
  readonly #toGiveBack = new Map<string, ConversationMessage[]>();

  start(): void {
    this.#timer ??= setInterval(() => void this.poll(), CONVERSATION_POLL_MS);
    this.#timer.unref();
  }

  /**
   * A message the stopped hub was typing is never typed again: one never pasted is not sent; a pasted one is sent when the transcript has it or
   * the input box no longer holds it, and not sent when the box still holds it, which is cleared, only in the launch it was typed into
   * (architecture.md § Typing a message). One not sent goes back to the composer of the windows showing the session, since this hub does not
   * know which window sent it.
   */
  #settleLeftOpen(message: ConversationMessage): void {
    const session = this.deps.store.session(message.sessionId);
    const giveBack = (outcome: DeliveryOutcome): void => this.#delivered(message.id, outcome, true);

    this.deps.log(`session ${message.sessionId}: message ${message.id} left open by a stopped hub is settled from the transcript and the screen`);

    if (session === null) { giveBack({delivery:'not-sent',error:RESTARTED_UNTYPED}); return; }
    // The input box holds the message as it was typed, with its tags.
    const typed = typedText(message, this.deps.voice?.expressive() ?? false, session.codeMode === true);
    this.#adapter(session)?.resolve(message, typed, giveBack, {
      check: () => this.#check(message.sessionId, message.launch ?? null),
      reserve: () => this.deps.input.reserve(message.sessionId, message.launch ?? null),
    });
  }

  stop(): void {
    this.#closed = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    for (const folder of this.#artifacts.values()) {
      folder.close();
    }

    this.#artifacts.clear();
    for (const adapter of this.#adapters) adapter.close();
  }

  /** Polls each provider independently; an unfinished poll skips its next tick. */
  async poll(): Promise<void> {
    await Promise.all(this.#adapters.map(async adapter => {
      if (this.#polling.has(adapter)) return;
      this.#polling.add(adapter);
      try { await adapter.poll(this.deps.store.activeSessions()); }
      catch (error) { this.deps.log(`conversation read failed: ${String(error)}`); }
      finally { this.#polling.delete(adapter); }
    }));
  }

  /** Reads the conversations of these sessions at once, between polls, so a turn's last reply is in the store when its end is decided (PRD R103). */
  readNow(sessionIds: readonly string[]): void {
    if (this.#closed) return;
    for (const id of sessionIds) {
      const session = this.deps.store.session(id);
      if (session !== null) this.#adapter(session)?.readNow?.(session);
    }
  }

  /**
   * Reads the conversation of a session whose replies may be held back and only read asynchronously, as a Codex thread's before its history is
   * imported; null when nothing is held back, so its turn's end can be decided now (PRD R103).
   */
  catchUp(sessionId: string): Promise<void> | null {
    const session = this.#closed ? null : this.deps.store.session(sessionId);
    const adapter = session === null ? undefined : this.#adapter(session);
    return session === null || adapter?.pending?.(session) !== true || adapter.catchUp === undefined ? null : adapter.catchUp(session);
  }

  #adapter(session: Session): ConversationAdapter | undefined { return this.#adapters.find(adapter => adapter.supports(session)); }

  #view(session: Session, current: boolean, hooks: boolean, personas: PersonaView | null = null): SessionView {
    const view = sessionView(session, current, hooks, personas);
    if (session.execution !== 'app-server') return view;
    const adapter = this.#adapter(session);
    return { ...view, provider: 'codex', requests: adapter?.requests?.(session) ?? [], reason: adapter?.cannotSend(session) ?? view.reason };
  }

  async answer(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const { window, scopeGen, sessionId, requestId, answer } = body;
    if (typeof window !== 'string' || typeof scopeGen !== 'number' || typeof sessionId !== 'string' || typeof requestId !== 'string') return { status: 400, body: { error: 'Expected {window, scopeGen, sessionId, requestId, answer}.' } };
    const refused = refusal(this.deps.windows.scope(window), scopeGen, sessionId);
    if (refused !== null) return refused;
    const session = this.deps.store.session(sessionId);
    const adapter = session === null ? undefined : this.#adapter(session);
    if (session === null || session.state === 'ended' || adapter?.answer === undefined) return { status: 409, body: { error: 'This session has no pending request.' } };
    try {
      await adapter.answer(session, requestId, answer);
      this.sessionsChanged();
      return { status: 200, body: { answered: true } };
    } catch (error) { return { status: 409, body: { error: String(error) } }; }
  }

  /** Sends a change to the windows showing its session, and to `also`, a window that must hear it wherever its scope moved, with `extra` fields. */
  #changed(sessionId: string, change: ConversationChange, also?: string, extra: Record<string, unknown> = {}): void {
    if (this.#closed) return;
    if (change.type === 'status') {
      this.#statusChanged(this.deps.windows.showing(sessionId));
      this.#unreadChanged(sessionId);
      return;
    }

    if (change.type === 'heard') {
      this.deps.voice?.heard?.(change.heard);
      return;
    }

    const item = change.type === 'message' ? itemView({ type: 'message', ...change.message }) : itemView({ type: 'reply', ...change.reply });
    const keys = new Set(this.deps.windows.showing(sessionId));

    if (change.type === 'message' && change.message.delivery !== 'not-sent' && !change.message.withdrawn && change.message.workItemId !== null) {
      this.deps.messageAdded?.(change.message.workItemId, change.message.text);
    }

    if (also !== undefined) {
      keys.add(also);
    }

    for (const key of keys) {
      this.#send(key, change.type, change.type === 'message' ? { message: item, ...extra } : { reply: item, ...extra });
    }

    if (change.type === 'reply') {
      this.deps.voice?.replyChanged(change.reply);
    }

    // A new message can push an unread reply past the retention limit, so every change counts again.
    this.#unreadChanged(sessionId);
  }

  /** Each session's unread count when it last changed, so the dock hears of a change once. */
  readonly #unread = new Map<string, number>();
  /** The unread count each window was last sent, by window key and work item. */
  readonly #unreadShown = new Map<string, number>();

  /**
   * Sends each window that lists the session's work item, while it is that work item's current session, its unread count when it changed, and
   * tells the hub when the session's count changed.
   */
  #unreadChanged(sessionId: string): void {
    const count = this.deps.store.unreadCount(sessionId);
    const session = this.deps.store.session(sessionId);

    if (session !== null && this.deps.store.sessionsFor(session.workItemId).at(-1)?.id === sessionId) {
      for (const key of this.deps.windows.listing(session.workItemId)) {
        const shown = `${key} ${session.workItemId}`;

        if (this.#streams.has(key) && this.#unreadShown.get(shown) !== count) {
          this.#unreadShown.set(shown, count);
          this.#send(key, 'unread', { workItemId: session.workItemId, count });
        }
      }
    }

    if (this.#unread.get(sessionId) !== count) {
      this.#unread.set(sessionId, count);
      this.deps.unreadChanged?.();
    }
  }

  /** The dropdown's entries of a window's conversations: each one's title, current session's state and provider, and unread count. */
  entries(refs: ConversationRef[]): ConversationEntry[] {
    return refs.flatMap((ref) => {
      const item = this.deps.store.workItem(ref.workItemId);
      const ticket = item === null ? null : this.deps.store.ticket(item.ticketId);

      if (item === null || ticket === null) {
        return [];
      }

      const session = this.deps.store.sessionsFor(item.id).at(-1) ?? null;
      const view = session === null ? null : this.#view(session, true, this.deps.hooks(), this.deps.personas?.() ?? null);

      return [{ workItemId: item.id, title: ticket.title, primary: ref.primary, sessionId: session?.id ?? null, state: view?.state ?? null, conversation: view?.conversation ?? null, unread: session === null ? 0 : this.deps.store.unreadCount(session.id), ...(view?.provider === undefined ? {} : { provider: view.provider }) }];
    });
  }

  /** The scope as the window is sent it, with its conversations as dropdown entries. */
  scopeView(scope: WindowScope | null): ScopeView | null {
    return scope === null ? null : { ...scope, conversations: this.entries(scope.conversations) };
  }

  /** The dropdown each window was last sent. */
  readonly #conversationsShown = new Map<string, string>();
  /** The list each page was last sent. */
  readonly #listShown = new Map<string, string>();

  /** The web page's list (architecture.md § Web page): the dock's groups and rows, as `pageList` in `page.ts` gives them. */
  pageList(): PageListGroup[] {
    return this.deps.pageList?.() ?? [];
  }

  /** The page's list and its header, as `list` and `hello` carry them; no header without `pageHeader`. */
  #pageListEvent(): { groups: PageListGroup[]; header?: PageHeader } {
    const header = this.deps.pageHeader?.();

    return { groups: this.pageList(), ...(header === undefined ? {} : { header }) };
  }

  /** Sends each page its list when it or its header changed. */
  #listChanged(): void {
    const pages = [...this.#streams.keys()].filter((key) => this.deps.windows.isPage(key));

    if (pages.length === 0) {
      return;
    }

    const event = this.#pageListEvent();
    const text = JSON.stringify(event);

    for (const key of pages) {
      if (this.#listShown.get(key) !== text) {
        this.#listShown.set(key, text);
        this.#send(key, 'list', event);
      }
    }
  }

  /**
   * `page-source {window, name, enabled}` (architecture.md § Web page): turns one source on or off, as the dock's source icons do. 403 for a key
   * that is not a page's, 409 with the hub's refusal.
   */
  pageSource(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, name, enabled } = body;

    if (typeof window !== 'string' || typeof name !== 'string' || name === '' || typeof enabled !== 'boolean') {
      return { status: 400, body: { error: 'Expected {window, name, enabled}.' } };
    }

    if (!this.deps.windows.isPage(window)) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    const why = this.deps.setSource === undefined ? 'This hub cannot turn sources on or off from the page.' : this.deps.setSource(name, enabled);

    return why === null ? { status: 200, body: { done: true } } : { status: 409, body: { error: why } };
  }

  /** Each `row-action`'s answer, by page key and `opId`, so a retried one runs once; the last 100. */
  readonly #rowActions = new Map<string, { status: number; body: unknown }>();

  /**
   * `row-action {window, scopeGen, opId, workItemId, action, until?, comment?}` (architecture.md § Web page): one of the dock's controls on the
   * page's selected work item, rechecked against its row when it runs. 403 for a key that is not a page's or another work item, 409 for a stale
   * `scopeGen` and with the refusal, such as a control the row no longer offers.
   */
  rowAction(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, scopeGen, opId, workItemId, action, until, comment } = body;

    if (
      typeof window !== 'string' ||
      typeof scopeGen !== 'number' ||
      typeof opId !== 'string' ||
      opId === '' ||
      !Number.isInteger(workItemId) ||
      typeof action !== 'string' ||
      !(until === undefined || until === null || (typeof until === 'number' && Number.isFinite(until))) ||
      !(comment === undefined || comment === null || (typeof comment === 'string' && comment.length <= MAX_MESSAGE_CHARS))
    ) {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId, workItemId, action, until?, comment?}.' } };
    }

    const scope = this.deps.windows.isPage(window) ? this.deps.windows.scope(window) : null;

    if (scope === null || scope.workItemId !== workItemId) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    const refused = refusal(scope, scopeGen, null);

    if (refused !== null) {
      return refused;
    }

    const done = this.#rowActions.get(`${window} ${opId}`);

    if (done !== undefined) {
      return done;
    }

    const why = this.deps.rowAction === undefined ? 'This hub runs no actions from the page.' : this.deps.rowAction(workItemId as number, action, { until: (until as number | null | undefined) ?? null, comment: typeof comment === 'string' && comment.trim() !== '' ? comment.trim() : null });
    const answer = why === null ? { status: 200, body: { done: true } } : { status: 409, body: { error: why } };

    this.#rowActions.set(`${window} ${opId}`, answer);

    for (const old of [...this.#rowActions.keys()].slice(0, -100)) {
      this.#rowActions.delete(old);
    }

    return answer;
  }

  /**
   * `row-open {window, opId, workItemId, url}` (architecture.md § Web page): the installed page's link, opened by the hub in the default browser,
   * for any work item the page lists, since its list already holds every row's links; 403 for a key that is not a page's, 409 with why not, such
   * as a URL the row no longer holds. A repeated `opId` answers the first result.
   */
  rowOpen(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, opId, workItemId, url } = body;

    if (typeof window !== 'string' || typeof opId !== 'string' || opId === '' || !Number.isInteger(workItemId) || typeof url !== 'string') {
      return { status: 400, body: { error: 'Expected {window, opId, workItemId, url}.' } };
    }

    if (!this.deps.windows.isPage(window)) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    const done = this.#rowActions.get(`${window} ${opId}`);

    if (done !== undefined) {
      return done;
    }

    const why = this.deps.rowOpen === undefined ? 'This hub opens no links for the page.' : this.deps.rowOpen(workItemId as number, url);
    const answer = why === null ? { status: 200, body: { opened: true } } : { status: 409, body: { error: why } };

    this.#rowActions.set(`${window} ${opId}`, answer);

    for (const old of [...this.#rowActions.keys()].slice(0, -100)) {
      this.#rowActions.delete(old);
    }

    return answer;
  }

  /**
   * `resume {window, scopeGen, opId, sessionId}` (architecture.md § Web page): resumes the page's selected conversation's current session when it
   * has ended; 403 outside the scope or for a window key, 409 for a stale `scopeGen`, a session that has not ended, and with the resume's refusal.
   */
  async resume(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const { window, scopeGen, opId, sessionId } = body;

    if (typeof window !== 'string' || typeof scopeGen !== 'number' || typeof opId !== 'string' || typeof sessionId !== 'string') {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId}.' } };
    }

    const refused = refusal(this.deps.windows.isPage(window) ? this.deps.windows.scope(window) : null, scopeGen, sessionId);

    if (refused !== null) {
      return refused;
    }

    const session = this.deps.store.session(sessionId);

    if (session === null) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    if (session.state !== 'ended') {
      return { status: 409, body: { error: 'The session has not ended.' } };
    }

    const why = this.deps.resumeSession === undefined ? 'This hub cannot resume a session from the page.' : await this.deps.resumeSession(sessionId);

    if (why !== null) {
      return { status: 409, body: { error: why } };
    }

    this.sessionsChanged();
    return { status: 200, body: { resumed: true } };
  }

  /**
   * The prompt the page's session waits on in its terminal (architecture.md § Web page): the session, if it is the page's current Code Mode
   * session waiting on a question or a permission prompt, and the prompt its screen shows, or why not.
   */
  async #promptOf(window: string, scopeGen: number, sessionId: string): Promise<{ refused: { status: number; body: { error: string } } } | { session: Session; prompt: ScreenPrompt | null; keyAt: number | null }> {
    const refused = refusal(this.deps.windows.isPage(window) ? this.deps.windows.scope(window) : null, scopeGen, sessionId);

    if (refused !== null) {
      return { refused };
    }

    const session = this.deps.store.session(sessionId);

    if (session === null || session.codeMode !== true) {
      return { refused: { status: 409, body: { error: 'Only a Code Mode session shows its prompts on the page.' } } };
    }

    const view = sessionView(session, true, this.deps.hooks());

    if (view.state !== 'waiting' || (view.waitingFor !== 'question' && view.waitingFor !== 'permission')) {
      return { refused: { status: 409, body: { error: 'The session is not waiting on a prompt.' } } };
    }

    const snapshot = await this.deps.screen(session.id, 0).catch(() => null);

    if (snapshot === null) {
      return { refused: { status: 409, body: { error: 'The terminal holder did not show the screen. Answer in the terminal.' } } };
    }

    return { session, prompt: readPrompt(await screenRows(snapshot)), keyAt: snapshot.keyAt ?? null };
  }

  /**
   * `prompt {window, scopeGen, opId, sessionId}`: `{prompt}`, the permission prompt or question form the page's current Code Mode session waits on
   * as its screen shows it, or null when the screen shows none; refused as `history` is, and with 409 for a session not waiting on one.
   */
  async prompt(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const { window, scopeGen, sessionId } = body;

    if (typeof window !== 'string' || typeof scopeGen !== 'number' || typeof sessionId !== 'string') {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId}.' } };
    }

    const found = await this.#promptOf(window, scopeGen, sessionId);

    return 'refused' in found ? found.refused : { status: 200, body: { prompt: found.prompt } };
  }

  /** Each `prompt-key`'s answer, kept from when it starts, by page key and `opId`, so a retried key is never pressed twice. */
  readonly #promptKeys = new Map<string, Promise<{ status: number; body: unknown }>>();
  /** Each session's prompt keys, one at a time, so a second key is checked against the screen the first one left. */
  readonly #promptQueues = new Map<string, Promise<unknown>>();

  /**
   * `prompt-key {window, scopeGen, opId, sessionId, launch, prompt, key}` presses one key on the prompt the page showed: an option's digit,
   * `escape` or `next` (→ on a question form). It takes the session's input reservation, reads the screen again, and refuses with 409 when
   * the screen no longer shows that prompt (`prompt` is its id), the key is not one of its own, or a key was typed in a terminal in the last
   * 1.5 s; a repeated `opId` answers the first result.
   */
  async promptKey(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const { window, scopeGen, opId, sessionId, launch, prompt, key } = body;

    if (typeof window !== 'string' || typeof scopeGen !== 'number' || typeof opId !== 'string' || opId === '' || typeof sessionId !== 'string' || !(launch === null || typeof launch === 'string') || typeof prompt !== 'string' || typeof key !== 'string' || !/^([1-9]|escape|next)$/.test(key)) {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, launch, prompt, key} with key a digit, escape or next.' } };
    }

    const done = this.#promptKeys.get(`${window} ${opId}`);

    if (done !== undefined) {
      return done;
    }

    const queued = this.#promptQueues.get(sessionId) ?? Promise.resolve();
    const answer = queued.then(() => this.#pressPromptKey(window, scopeGen, sessionId, launch, prompt, key as PromptKey));
    const settled = answer.then(() => undefined, () => undefined);

    this.#promptQueues.set(sessionId, settled);
    void settled.then(() => {
      if (this.#promptQueues.get(sessionId) === settled) {
        this.#promptQueues.delete(sessionId);
      }
    });
    this.#promptKeys.set(`${window} ${opId}`, answer);

    for (const old of [...this.#promptKeys.keys()].slice(0, -100)) {
      this.#promptKeys.delete(old);
    }

    return answer;
  }

  async #pressPromptKey(window: string, scopeGen: number, sessionId: string, launch: string | null, id: string, key: PromptKey): Promise<{ status: number; body: unknown }> {
    if ((this.deps.store.session(sessionId)?.launchId ?? null) !== launch) {
      return { status: 409, body: { error: SESSION_RELAUNCHED } };
    }

    const reservation = await this.deps.input.reserve(sessionId, launch);

    if ('refused' in reservation) {
      return { status: 409, body: { error: reservation.refused } };
    }

    try {
      const found = await this.#promptOf(window, scopeGen, sessionId);

      if ('refused' in found) {
        return found.refused;
      }

      if (found.prompt === null || found.prompt.id !== id) {
        return { status: 409, body: { error: 'The terminal shows something else now. Answer there, or try again here.' } };
      }

      const allowed = key === 'escape' || (key === 'next' ? found.prompt.next : found.prompt.options.some((option) => option.key === key));

      if (!allowed) {
        return { status: 409, body: { error: 'The prompt has no such choice.' } };
      }

      if (found.keyAt !== null && this.deps.now() - found.keyAt < TYPING_PAUSE_MS) {
        return { status: 409, body: { error: 'A key was just typed in the terminal. Try again in a moment.' } };
      }

      await this.deps.input.write(sessionId, promptKeyData(key));
      this.deps.log(`session ${sessionId}: the page answered its prompt with ${key}`);
      return { status: 200, body: { done: true } };
    } catch (error) {
      return { status: 409, body: { error: `The key was not sent: ${(error as Error).message}` } };
    } finally {
      reservation.release();
    }
  }

  /** `row-paste {window, scopeGen, opId, workItemId, label}`: the drafted text Copy offers on the page's selected work item, as `{text}`; it only reads. */
  async rowPaste(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const { window, scopeGen, workItemId, label } = body;

    if (typeof window !== 'string' || typeof scopeGen !== 'number' || !Number.isInteger(workItemId) || typeof label !== 'string') {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId, workItemId, label}.' } };
    }

    const scope = this.deps.windows.isPage(window) ? this.deps.windows.scope(window) : null;

    if (scope === null || scope.workItemId !== workItemId) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    const refused = refusal(scope, scopeGen, null);

    if (refused !== null) {
      return refused;
    }

    try {
      const text = (await this.deps.rowPaste?.(workItemId as number, label)) ?? null;

      return text === null ? { status: 409, body: { error: `The work item has no draft named ${label}.` } } : { status: 200, body: { text } };
    } catch (error) {
      return { status: 409, body: { error: `${label} could not be read: ${(error as Error).message}` } };
    }
  }

  /** `page-focus {window, focused}`: a page's focus and visibility, for the voice (architecture.md § Web page); 403 for a key that is not a page's. */
  pageFocus(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, focused } = body;

    if (typeof window !== 'string' || typeof focused !== 'boolean') {
      return { status: 400, body: { error: 'Expected {window, focused}.' } };
    }

    if (!this.deps.windows.isPage(window)) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    this.deps.pageFocused?.(window, focused);
    return { status: 200, body: { focused } };
  }

  /**
   * An artifact's file, or a file an artifact uses, of the page's selected conversation (architecture.md § Web page), resolved by real path
   * inside its artifact folder; null outside it or with no selection.
   */
  artifactFile(key: string, name: string): ReturnType<typeof artifactFile> {
    const scope = this.deps.windows.scope(key);

    return scope?.cwd == null || scope.workItemId === null ? null : artifactFile(artifactsDir(scope.cwd, scope.workItemId), name);
  }

  /** The `@` picker's files under the selected conversation's folder (architecture.md § Web page); null with no selection. */
  async files(key: string, query: string): Promise<PageFile[] | null> {
    const scope = this.deps.windows.scope(key);

    return scope?.cwd == null ? null : findFiles(scope.cwd, query);
  }

  /**
   * A file the page's composer attaches (architecture.md § Web page), written for a mention in its next message: only for a page key whose
   * selected conversation's current session can take a message, at the `scopeGen` the page showed. `{path, image}`, or why not.
   */
  pageUpload(key: string, scopeGen: number, name: string, bytes: Uint8Array): { status: number; body: unknown } {
    const scope = this.deps.windows.isPage(key) ? this.deps.windows.scope(key) : null;
    const refused = refusal(scope, scopeGen, null);

    if (refused !== null) {
      return refused;
    }

    const session = scope!.sessionId === null ? null : this.deps.store.session(scope!.sessionId);

    if (session === null) {
      return { status: 409, body: { error: 'No session has started yet.' } };
    }

    const view = this.#view(session, true, this.deps.hooks(), this.deps.personas?.() ?? null);

    if (view.conversation !== 'full') {
      return { status: 409, body: { error: view.reason ?? SESSION_ENDED } };
    }

    try {
      const written = writeUpload(name, bytes, this.deps.now(), this.deps.uploads);

      return 'error' in written ? { status: 400, body: written } : { status: 200, body: written };
    } catch (error) {
      return { status: 500, body: { error: `${name === '' ? 'The file' : name} was not saved: ${(error as Error).message}` } };
    }
  }

  /** Sends each window its dropdown when an entry changed while its selection did not: a conversation added or done, a title, state or count. */
  conversationsChanged(): void {
    for (const key of this.#streams.keys()) {
      const scope = this.deps.windows.scope(key);

      if (scope === null) {
        continue;
      }

      const conversations = this.entries(scope.conversations);
      const text = JSON.stringify(conversations);

      if (this.#conversationsShown.get(key) !== text) {
        this.#conversationsShown.set(key, text);
        this.#send(key, 'conversations', { conversations });
      }
    }

    this.#listChanged();
  }

  /** Sends an event to a window's conversation streams, as the voice's `voice`, `progress` and `settings`. */
  notify(key: string, type: string, payload: Record<string, unknown>): void {
    this.#send(key, type, payload);
  }

  /** Sends the windows showing a reply's session the reply again, as after its speech changed. */
  replyUpdated(replyId: string): void {
    const reply = this.deps.store.reply(replyId);

    if (reply !== null) {
      const item = itemView({ type: 'reply', ...reply });

      for (const key of this.deps.windows.showing(reply.sessionId)) {
        this.#send(key, 'reply', { reply: item });
      }

      this.#unreadChanged(reply.sessionId);
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

    const showing = this.deps.windows.scope(key)?.sessionId ?? null;
    const left = showing === null ? undefined : this.#leftOpen.get(showing);
    const owed = showing === null ? undefined : this.#toGiveBack.get(showing);

    if (showing !== null && owed !== undefined) {
      this.#toGiveBack.delete(showing);

      for (const message of owed) {
        send('message', { message: itemView({ type: 'message', ...message }), giveBack: true });
      }
    }

    if (showing !== null && left !== undefined) {
      this.#leftOpen.delete(showing);

      for (const message of left) {
        this.#settleLeftOpen(message);
      }
    }

    return {
      close: () => {
        streams.delete(send);

        if (streams.size === 0) {
          this.#streams.delete(key);
          this.#statusShown.delete(key);
          this.#conversationsShown.delete(key);
          this.#listShown.delete(key);

          for (const shown of [...this.#unreadShown.keys()].filter((one) => one.startsWith(`${key} `))) {
            this.#unreadShown.delete(shown);
          }

          this.#followArtifacts();
        }
      },
    };
  }

  /** The window's scope, its work item's sessions, and its current session's newest items. */
  hello(key: string): Record<string, unknown> {
    const scope = this.deps.windows.scope(key);
    // A page learns its key, which its commands name, and its list from its own stream (architecture.md § Web page).
    const pageHello = this.deps.windows.isPage(key) ? this.#pageHello(key) : {};

    if (scope === null) {
      this.#statusShown.delete(key);
      this.#conversationsShown.delete(key);
      return { protocol: CONVERSATION_PROTOCOL, scope: null, sessions: [], items: [], more: false, status: null, unread: 0, artifactsDir: null, artifacts: [], ...this.#voiceHello(key), ...pageHello };
    }

    const current = scope.sessionId === null ? null : this.deps.store.session(scope.sessionId);

    if (current !== null) this.#adapter(current)?.readEnded(current);

    const page = scope.sessionId === null ? { items: [], more: false } : this.deps.store.conversation(scope.sessionId, null, PAGE_ITEMS, false);
    const status = this.status(scope);

    this.#statusShown.set(key, JSON.stringify(status));

    const unread = scope.sessionId === null ? 0 : this.deps.store.unreadCount(scope.sessionId);
    const view = this.scopeView(scope)!;

    this.#conversationsShown.set(key, JSON.stringify(view.conversations));

    for (const entry of view.conversations) {
      this.#unreadShown.set(`${key} ${entry.workItemId}`, entry.unread);
    }

    const folder = this.#artifactFolder(scope, key);

    return {
      protocol: CONVERSATION_PROTOCOL,
      scope: view,
      sessions: current === null ? [] : [this.#view(current, true, this.deps.hooks(), this.deps.personas?.() ?? null)],
      items: page.items.filter((item) => !item.withdrawn).map(itemView),
      more: page.more,
      status,
      unread,
      artifactsDir: folder?.dir ?? null,
      artifacts: folder?.list() ?? [],
      ...this.#voiceHello(key),
      ...pageHello,
    };
  }

  /**
   * `page-search {window, text, since}` (architecture.md § Web page): the list's search further back, the Done rows from `since`, in epoch
   * milliseconds, up to the Done list, whose search text holds every word of `text`, answered as `{rows, more}` as the dock's `/dock/search`
   * answers it. 403 for a key that is not a page's.
   */
  pageSearch(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, text, since } = body;

    if (typeof window !== 'string' || typeof text !== 'string' || text.length > MAX_MESSAGE_CHARS || typeof since !== 'number' || !Number.isFinite(since)) {
      return { status: 400, body: { error: 'Expected {window, text, since}, the search text and the epoch milliseconds to search from.' } };
    }

    if (!this.deps.windows.isPage(window)) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    return { status: 200, body: this.deps.searchDone?.(text, since) ?? { rows: [], more: false } };
  }

  /**
   * `page-poll {window}` (architecture.md § Web page): More Actions' Refresh sources, which polls each source that is on now, as the dock's
   * `/poll` does. 403 for a key that is not a page's, 409 with the hub's refusal.
   */
  pagePoll(body: Record<string, unknown>): { status: number; body: unknown } {
    if (typeof body['window'] !== 'string') {
      return { status: 400, body: { error: 'Expected {window}.' } };
    }

    if (!this.deps.windows.isPage(body['window'])) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    const why = this.deps.pollSources === undefined ? 'This hub cannot poll from the page.' : this.deps.pollSources();

    return why === null ? { status: 200, body: { done: true } } : { status: 409, body: { error: why } };
  }

  /** Each `page-adhoc` that created, by page key and `opId`, so a retried one creates once; the last 100. A refusal is not kept, so a retry after it runs again. */
  readonly #pageAdhocs = new Map<string, { status: number; body: unknown }>();

  /**
   * `page-adhoc {window, opId, prompt, repoRoot, start, provider}` or `{window, opId, schedule}` (architecture.md § Web page): More Actions' New
   * ad-hoc session, which creates an ad-hoc work item (PRD R6), started when `start` is true, or runs a schedule now (PRD R82), as the dock's
   * window does. Only a folder and a schedule the list header offers are taken (400 otherwise); 403 for a key that is not a page's, 409 with the
   * flow's refusal. A repeated `opId` answers the first success; one after a refusal runs again.
   */
  pageAdhoc(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, opId, prompt, repoRoot, start, provider, schedule } = body;
    const scheduled = schedule !== undefined;

    if (
      typeof window !== 'string' ||
      typeof opId !== 'string' ||
      opId === '' ||
      opId.length > 200 ||
      (scheduled
        ? typeof schedule !== 'string'
        : typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MAX_MESSAGE_CHARS || typeof repoRoot !== 'string' || typeof start !== 'boolean' || (provider !== 'claude' && provider !== 'codex'))
    ) {
      return { status: 400, body: { error: 'Expected {window, opId, prompt, repoRoot, start, provider} or {window, opId, schedule}.' } };
    }

    if (!this.deps.windows.isPage(window)) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    const done = this.#pageAdhocs.get(`${window} ${opId}`);

    if (done !== undefined) {
      return done;
    }

    const header = this.deps.pageHeader?.();
    const folder = scheduled ? null : knownFolder(header?.folders ?? [], repoRoot as string);

    if (scheduled ? !(header?.schedules ?? []).some((one) => one.name === schedule) : folder === null) {
      return { status: 400, body: { error: scheduled ? `No schedule is named ${String(schedule)}.` : `${String(repoRoot)} is not a folder the page offers.` } };
    }

    const event = scheduled ? { type: 'run-schedule', name: schedule } : { type: 'adhoc', prompt, repoRoot: folder, start, provider };
    const why = this.deps.operatorEvent === undefined ? 'This hub creates no work items from the page.' : this.deps.operatorEvent(event);
    if (why !== null) {
      return { status: 409, body: { error: why } };
    }

    const answer = { status: 200, body: { done: true } };

    this.#pageAdhocs.set(`${window} ${opId}`, answer);

    for (const old of [...this.#pageAdhocs.keys()].slice(0, -100)) {
      this.#pageAdhocs.delete(old);
    }

    return answer;
  }

  /**
   * `page-folder-conversation {window, opId, folder, provider?}` (architecture.md § Web page): More Actions' New conversation in a folder, which
   * makes a folder-hosted conversation as the dock's does (`dockConversation`), in a folder the list header offers (400 for any other); answers
   * `{workItemId, folder}`. 403 for a key that is not a page's.
   */
  pageFolderConversation(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, opId, folder, provider } = body;

    if (typeof window !== 'string' || typeof folder !== 'string') {
      return { status: 400, body: { error: 'Expected {window, opId, folder, provider?}.' } };
    }

    if (!this.deps.windows.isPage(window)) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    const known = knownFolder(this.deps.pageHeader?.().folders ?? [], folder);

    if (known === null) {
      return { status: 400, body: { error: `${folder} is not a folder the page offers.` } };
    }

    return this.dockConversation({ folder: known, opId, ...(provider === undefined ? {} : { provider }) });
  }

  #pageHello(key: string): Record<string, unknown> {
    const event = this.#pageListEvent();

    this.#listShown.set(key, JSON.stringify(event));
    return { key, ...event };
  }

  /** The voice state and the setting the view reads, which a `hello` carries with voice (architecture.md § Voice). */
  #voiceHello(key: string): Record<string, unknown> {
    const voice = this.deps.voice;

    return voice === undefined ? {} : { voice: voice.shown(key), settings: voice.settings() };
  }

  /**
   * The artifact folder of a window's work item (architecture.md § Artifacts), in the folder of its current session, or of its worktree before
   * the first: watched while a window that shows the work item has a stream, `key` included, which may be opening.
   */
  #artifactFolder(scope: WindowScope, key?: string): ArtifactFolder | null {
    this.#followArtifacts(key);

    return scope.workItemId === null ? null : (this.#artifacts.get(scope.workItemId) ?? null);
  }

  /** Watches the artifact folder of each work item a window with a stream shows, and stops watching the others. */
  #followArtifacts(opening?: string): void {
    const wanted = new Map<number, string>();

    for (const key of new Set([...this.#streams.keys(), ...(opening === undefined ? [] : [opening])])) {
      const scope = this.deps.windows.scope(key);

      if (scope?.cwd != null && scope.workItemId !== null) {
        wanted.set(scope.workItemId, artifactsDir(scope.cwd, scope.workItemId));
      }
    }

    for (const [workItemId, folder] of this.#artifacts) {
      if (wanted.get(workItemId) !== folder.dir) {
        folder.close();
        this.#artifacts.delete(workItemId);
      }
    }

    for (const [workItemId, dir] of wanted) {
      if (!this.#artifacts.has(workItemId)) {
        this.#artifacts.set(
          workItemId,
          new ArtifactFolder(dir, {
            onChange: (change) => this.#artifactChanged(workItemId, dir, change),
            now: this.deps.now,
            log: (line) => this.deps.log(`work item ${workItemId}: ${line}`),
          }),
        );
      }
    }
  }

  /** Sends an artifact's change to the windows that show its work item and follow that folder. */
  #artifactChanged(workItemId: number, dir: string, change: { artifact: Artifact } | { path: string; removed: true }): void {
    if (this.#artifacts.get(workItemId)?.dir !== dir) {
      return;
    }

    for (const key of this.#streams.keys()) {
      const scope = this.deps.windows.scope(key);

      if (scope?.workItemId === workItemId && scope.cwd !== null && artifactsDir(scope.cwd, workItemId) === dir) {
        this.#send(key, 'artifact', 'artifact' in change ? { artifact: change.artifact } : { artifact: { path: change.path }, removed: true });
      }
    }
  }

  /**
   * The status of a window's scope: its current session's latest status, else its work item's stage as a fallback, else null. Only a work
   * item has a stage.
   */
  status(scope: WindowScope): StatusView | null {
    const latest = scope.sessionId === null ? null : this.deps.store.latestStatus(scope.sessionId);

    if (latest !== null) {
      return statusView(latest);
    }

    const item = scope.workItemId === null ? null : this.deps.store.workItem(scope.workItemId);

    if (item?.stage == null || item.stage.trim() === '') {
      return null;
    }

    return { id: `stage-${scope.workItemId}`, sessionId: scope.sessionId, at: item.stageAt ?? item.statusAt ?? this.deps.now(), markdown: item.stage, fallback: true, unread: false };
  }

  /** The status each window was last sent, so a `status` event goes only when its row changes. */
  readonly #statusShown = new Map<string, string>();

  /** Sends each of the windows its status again when it changed: a new or updated status, or the stage that stands in before the first. */
  #statusChanged(keys: Iterable<string>): void {
    for (const key of keys) {
      const scope = this.deps.windows.scope(key);

      if (scope === null || !this.#streams.has(key)) {
        continue;
      }

      const status = this.status(scope);
      const text = JSON.stringify(status);

      if (this.#statusShown.get(key) !== text) {
        this.#statusShown.set(key, text);
        this.#send(key, 'status', { status });
      }
    }
  }

  /** A window's key closed with its `/events` stream: a conversation stream still open under it no longer counts for watching artifacts. */
  windowClosed(): void {
    this.#followArtifacts();
  }

  /** The work items whose artifact folders are watched, for tests. */
  watching(): number[] {
    return [...this.#artifacts.keys()];
  }

  /** Tells each window whose work item or current session changed, which then starts from empty with a fresh `hello`. */
  scopesChanged(keys: string[]): void {
    for (const key of keys) {
      this.#send(key, 'scope', { scope: this.scopeView(this.deps.windows.scope(key)) });
      this.#send(key, 'hello', this.hello(key));
    }

    if (keys.length > 0) {
      this.#followArtifacts();
      this.deps.voice?.update();
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

      const view = this.#view(session, true, this.deps.hooks(), this.deps.personas?.() ?? null);
      const text = JSON.stringify(view);

      if (this.#shown.get(key) !== text) {
        this.#shown.set(key, text);
        this.#send(key, 'session', { session: view });
      }
    }

    // A stage reported before the session's first status.
    this.#statusChanged(this.#streams.keys());
    this.conversationsChanged();
    this.deps.voice?.update();
  }

  /**
   * `send` (architecture.md § Typing a message): a message typed in the window's composer to its current session. Refused with 403 outside the
   * window's scope, 409 for a stale `scopeGen`, a session that cannot take it or one resumed under another launch, and 400 for an empty or long
   * text. The message is stored `open` and answered at once; its typing runs in the session's queue, and its delivery arrives as `message`
   * events. A repeated `opId` returns the message it added and types nothing again. `command` types a slash command chosen from the composer's
   * list without the escape that keeps every other message a message; it must be one line that starts with `/name`.
   */
  send(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, scopeGen, opId, sessionId, launch, text, command } = body;

    if (typeof window !== 'string' || typeof scopeGen !== 'number' || typeof opId !== 'string' || opId === '' || opId.length > 200 || typeof sessionId !== 'string' || !(launch === null || typeof launch === 'string') || typeof text !== 'string' || !(command === undefined || typeof command === 'boolean')) {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, launch, text, command?}.' } };
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

    if (command === true && !SLASH_COMMAND.test(text.trim())) {
      return { status: 400, body: { error: 'A slash command is one line that starts with /name.' } };
    }

    const session = this.deps.store.session(sessionId);

    if (session === null) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    const view = this.#view(session, true, this.deps.hooks(), this.deps.personas?.() ?? null);

    if (view.conversation !== 'full') {
      return { status: 409, body: { error: view.reason ?? SESSION_ENDED } };
    }

    if ((session.launchId ?? null) !== launch) {
      return { status: 409, body: { error: SESSION_RELAUNCHED } };
    }

    // A resume follows an ended app-server thread again, which clears an error left from before it ended.
    const cannotType = session.state === 'ended' ? null : (this.#adapter(session)?.cannotSend(session) ?? null);

    if (cannotType !== null) {
      return { status: 409, body: { error: cannotType } };
    }

    // A draft that holds dictation goes as a [voice] message with its pieces, however it was sent (architecture.md § Dictation); a command never.
    const pieces = command === true ? null : (this.deps.voice?.dictated?.(window, session.id) ?? null);
    const interrupted = pieces === null ? null : (this.deps.voice?.interruption?.(window, session.id) ?? null);
    const message = this.#type(session, window, launch, text, { opId, command: command === true, pieces, partial: false, interrupted });

    return { status: 200, body: { message: itemView({ type: 'message', ...message }) } };
  }

  /**
   * Types the hub's continue text into a session waiting on its usage limit (architecture.md § Rate limits), as a typed message no window sent:
   * through the same guarded input, so it waits for an empty input box and is never typed twice. Why not, for a session that cannot take it.
   */
  continueAfterLimit(sessionId: string, text: string, guard: () => string | null = () => null): string | null {
    const session = this.deps.store.session(sessionId);

    if (session === null) {
      return SESSION_ENDED;
    }

    const view = this.#view(session, true, this.deps.hooks(), this.deps.personas?.() ?? null);

    if (view.conversation !== 'full') {
      return view.reason ?? SESSION_ENDED;
    }

    const cannotType = session.state === 'ended' ? null : (this.#adapter(session)?.cannotSend(session) ?? null);

    if (cannotType !== null) {
      return cannotType;
    }

    // `guard` is checked again just before the typing, as the session's queue may hold it until the limit no longer applies.
    this.#type(session, null, session.launchId ?? null, text, { opId: `limit-${this.deps.newId()}`, command: false, pieces: null, partial: false, guard });

    return null;
  }

  /**
   * Stores a message `open` and queues its typing in the session's input: `[spoken]` when its reply will be heard (architecture.md § Voice), never
   * for a slash command or a `[partial]` part, and `[voice]` or `[voice] [partial]` with dictation (architecture.md § Dictation), followed by the
   * interruption note of a reply it spoke over (architecture.md § Voice check and barge-in).
   */
  #type(
    session: Session,
    window: string | null,
    launch: string | null,
    text: string,
    options: { opId: string; command: boolean; pieces: Piece[] | null; partial: boolean; auto?: boolean; olderToo?: boolean; interrupted?: Interruption | null; guard?: () => string | null },
  ): ConversationMessage {
    const sessionId = session.id;
    const { spoken, expressive } = this.deps.voice?.spokenFor(sessionId, options.command || options.partial) ?? { spoken: false, expressive: false };
    const dictated = options.pieces === null ? null : options.partial ? 'partial' : 'voice';
    const added: Omit<ConversationMessage, 'ord'> = {
      id: `m-${this.deps.newId()}`,
      sessionId,
      workItemId: session.workItemId,
      at: this.deps.now(),
      origin: dictated === null ? 'typed' : 'voice',
      text,
      // Not in the transcript until Claude receives it, so it waits after the items that are (`inTranscript`).
      transcriptUuid: null,
      provisional: true,
      withdrawn: false,
      delivery: 'open',
      error: null,
      opId: options.opId,
      pastedAt: null,
      launch,
      spokenRequested: spoken,
      ...(options.pieces === null ? {} : { pieces: options.pieces }),
      ...(options.partial ? { partial: true } : {}),
      ...(dictated !== 'voice' || options.interrupted == null ? {} : { interrupted: options.interrupted }),
    };
    const note = dictated !== 'voice' || options.interrupted == null ? null : interruptNote(options.interrupted);
    const typed = spoken || dictated !== null ? `${messageTags(spoken, expressive, dictated, note)}${session.codeMode === true ? pasteText(text) : text}` : text;

    this.deps.store.addMessage(added);
    // A message dictated into a terminal has no window waiting on it.
    if (window !== null) {
      this.#senders.set(added.id, window);
    }

    if (options.auto === true) {
      this.#spoken.add(added.id);
    }


    const message = this.deps.store.message(added.id)!;

    this.#changed(sessionId, { type: 'message', message });
    const deliver = (to: Session, toLaunch: string | null): void => this.#adapter(to)?.send(to, message, typed, (outcome) => this.#delivered(message.id, outcome), {
      check: () => this.#check(sessionId, toLaunch, options.olderToo === true) ?? options.guard?.() ?? null,
      reserve: () => this.deps.input.reserve(sessionId, toLaunch),
      pasting: (at) => this.deps.store.updateMessage(message.id, { pastedAt: at }),
      command: options.command,
      steps: (steps) => this.#steps.set(message.id, steps),
    });

    if (session.state !== 'ended') {
      deliver(session, launch);
    } else {
      // An ended app-server session resumes under a new launch, which the message is then sent to (PRD R107).
      void (this.deps.resume?.(sessionId) ?? Promise.resolve(SESSION_ENDED)).then((refused) => {
        const resumed = this.deps.store.session(sessionId);

        if (refused !== null || resumed === null || resumed.state === 'ended') {
          this.#delivered(message.id, { delivery: 'not-sent', error: refused ?? SESSION_ENDED });
          return;
        }

        deliver(resumed, resumed.launchId ?? null);
      }, (error: unknown) => this.#delivered(message.id, { delivery: 'not-sent', error: String(error) }));
    }

    return message;
  }

  /**
   * Dictated text the voice sends into the window's selected conversation's current session, or with a null key into the session whose terminal
   * window it came from, which no window scope names (architecture.md § Dictation): a spoken turn's end as a `[voice]` message, or a
   * `[partial]` part of one still being spoken. Refused, before anything is stored, for a session the window no longer shows, one that cannot
   * take a message or a holder that cannot type; the window then gets a `message` event with delivery `refused` and why, and its draft keeps
   * the text.
   */
  dictate(key: string | null, sessionId: string, text: string, pieces: Piece[], partial: boolean, interrupted: Interruption | null = null): { message: ConversationMessage } | { refused: string } {
    const scope = key === null ? null : this.deps.windows.scope(key);
    const session = this.deps.store.session(sessionId);
    const view = session === null ? null : this.#view(session, true, this.deps.hooks(), this.deps.personas?.() ?? null);
    const refused =
      (key !== null && (scope === null || scope.sessionId !== sessionId)) || session === null || view === null
        ? key === null
          ? SESSION_ENDED
          : "The voice's session is no longer this window's."
        : view.conversation !== 'full'
          ? (view.reason ?? SESSION_ENDED)
          : text.length > MAX_MESSAGE_CHARS
            ? `The message is longer than ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters.`
            : session!.state === 'ended'
              ? null
              : (this.#adapter(session!)?.cannotSend(session!) ?? null);

    if (refused !== null || session === null) {
      const why = refused ?? SESSION_ENDED;
      const at = this.deps.now();

      if (key === null) {
        return { refused: why };
      }

      this.#send(key, 'message', {
        message: { type: 'message', id: `refused-${this.deps.newId()}`, sessionId, workItemId: session?.workItemId ?? null, at, ord: 0, origin: 'voice', text, provisional: false, withdrawn: false, delivery: 'refused', error: why, spokenRequested: false, pieces, ...(partial ? { partial: true } : {}) },
      });
      return { refused: why };
    }

    return { message: this.#type(session, key, session.launchId ?? null, text, { opId: `voice-${this.deps.newId()}`, command: false, pieces, partial, auto: true, olderToo: key === null, interrupted }) };
  }

  /**
   * Why a message for this session and launch can no longer be typed; null while it can. Only dictation into a session's own terminal window may
   * go to a session older than its work item's newest (voice-design decision 9).
   */
  #check(sessionId: string, launch: string | null, olderToo = false): string | null {
    const session = this.deps.store.session(sessionId);

    if (session === null || session.state === 'ended') {
      return SESSION_ENDED;
    }

    if ((session.launchId ?? null) !== launch) {
      return SESSION_RELAUNCHED;
    }

    return olderToo || this.deps.store.sessionsFor(session.workItemId).at(-1)?.id === sessionId ? null : NEWER_SESSION;
  }

  /**
   * A typed message's outcome; a message its transcript entry already confirmed stays sent. `giveBack` asks every window showing the session to
   * put a message that was not sent back in its composer, for one whose sender this hub does not know.
   */
  /** The messages the voice sent itself, which no composer is waiting on. */
  readonly #spoken = new Set<string>();

  #delivered(id: string, outcome: DeliveryOutcome, giveBack = false): void {
    if (this.#closed) return;
    const message = this.deps.store.message(id);

    const sender = this.#senders.get(id);

    this.#senders.delete(id);
    // A message the voice sent itself has no composer waiting on it, so one not sent returns its text to the draft of every window showing it.
    giveBack ||= this.#spoken.delete(id);
    this.#logTiming(id, message, outcome);

    if (message === null) {
      return;
    }

    // The transcript confirmed it before its typing ended; the fragments log still gets its delivery.
    if (message.delivery === 'sent') {
      this.deps.voice?.delivered?.(message);
      return;
    }

    if (outcome.delivery !== 'sent') {
      this.deps.log(`session ${message.sessionId}: message ${id} ${outcome.delivery}: ${outcome.error}`);
    }

    // Nothing was typed, or Claude Code did not take it, so the message leaves the conversation; its last event tells the windows to drop it,
    // and the one that sent it puts its text back in the composer with why.
    if (outcome.delivery === 'not-sent') {
      this.deps.store.deleteMessage(id);
      this.#unsent.set(`${message.sessionId} ${message.opId}`, outcome.error);

      for (const key of [...this.#unsent.keys()].slice(0, -UNSENT_KEPT)) {
        this.#unsent.delete(key);
      }

      const gone = { ...message, delivery: 'not-sent' as const, error: outcome.error, provisional: false };

      // A window that closed while the message was settled gets it when a window shows the session again.
      if (giveBack && this.deps.windows.showing(message.sessionId).every((key) => !this.#streams.has(key))) {
        this.#toGiveBack.set(message.sessionId, [...(this.#toGiveBack.get(message.sessionId) ?? []), gone]);
      }

      this.#changed(message.sessionId, { type: 'message', message: gone }, sender, giveBack ? { giveBack: true } : {});
      this.deps.voice?.delivered?.(gone);
      return;
    }

    if (outcome.delivery === 'uncertain') {
      this.deps.store.updateMessage(id, { delivery: 'uncertain', error: outcome.error });
      this.#changed(message.sessionId, { type: 'message', message: this.deps.store.message(id)! });
      return;
    }

    // A sent message waits for its provider confirmation.
    this.deps.store.updateMessage(id, { delivery: 'sent', error: null });
    this.#changed(message.sessionId, { type: 'message', message: this.deps.store.message(id)! });
    this.deps.voice?.delivered?.(this.deps.store.message(id)!);
  }

  /** Each typed message's input steps, from its typing's end until its outcome is logged. */
  readonly #steps = new Map<string, InputSteps>();

  /**
   * One hub log line per typed message with the duration of each step (architecture.md § Typing a message): the voice's, for a dictated message,
   * then the input transaction's.
   */
  #logTiming(id: string, message: ConversationMessage | null, outcome: DeliveryOutcome): void {
    const steps = this.#steps.get(id);
    const voice = this.deps.voice?.timing?.(id) ?? null;

    this.#steps.delete(id);

    if (steps === undefined || message === null) {
      return;
    }

    this.deps.log(`session ${message.sessionId}: message ${id} ${message.delivery === 'sent' ? 'sent' : outcome.delivery}: ${voice === null ? '' : `${voice}, `}${stepsText(steps, this.deps.now())}`);
  }

  /**
   * `seen` (architecture.md § Unread): replies and statuses of the window's current session that its view showed in a focused window for a
   * second, each marked seen on its own. Refused with 403 outside the window's scope, for a forged session or for an ID that is not a reply or
   * status of that session, marking none, and 409 for a stale `scopeGen`. The windows showing the session get each marked reply and status again
   * and the new unread count. Marking again changes nothing, so a repeated `opId` is safe.
   */
  seen(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, scopeGen, opId, sessionId, ids } = body;

    if (
      typeof window !== 'string' ||
      typeof scopeGen !== 'number' ||
      typeof opId !== 'string' ||
      typeof sessionId !== 'string' ||
      !Array.isArray(ids) ||
      ids.length > SEEN_MAX_IDS ||
      !ids.every((id) => typeof id === 'string')
    ) {
      return { status: 400, body: { error: `Expected {window, scopeGen, opId, sessionId, ids}, with at most ${SEEN_MAX_IDS} IDs.` } };
    }

    const refused = refusal(this.deps.windows.scope(window), scopeGen, sessionId);

    if (refused !== null) {
      return refused;
    }

    const marked = this.deps.store.markSeen(sessionId, ids as string[], this.deps.now());

    if (marked === null) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    for (const id of marked.replies) {
      this.#changed(sessionId, { type: 'reply', reply: this.deps.store.reply(id)! });
    }

    if (marked.statuses.length > 0) {
      this.#statusChanged(this.deps.windows.showing(sessionId));
    }

    this.#unreadChanged(sessionId);

    return { status: 200, body: { unread: this.deps.store.unreadCount(sessionId) } };
  }

  /**
   * The voice commands (architecture.md § Voice): `talk-here` moves the voice to the window's selected conversation's session, `stop-speaking`
   * and `replay {replyId}` work only while the voice is here, `speak-replies {on}` turns Speak replies on or off. Refused with 403 outside the
   * window's scope, 409 for a stale `scopeGen` and with the voice's refusal, and 404 while voice is not part of this hub.
   */
  voiceCommand(name: 'talk-here' | 'stop-speaking' | 'speak-replies' | 'replay' | 'mic' | 'composer', body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, scopeGen, opId, on, replyId, focused, draft } = body;

    if (
      typeof window !== 'string' ||
      typeof scopeGen !== 'number' ||
      typeof opId !== 'string' ||
      ((name === 'speak-replies' || name === 'mic') && typeof on !== 'boolean') ||
      (name === 'replay' && typeof replyId !== 'string') ||
      (name === 'composer' && (typeof focused !== 'boolean' || typeof draft !== 'string' || draft.length > MAX_MESSAGE_CHARS))
    ) {
      const fields = name === 'speak-replies' || name === 'mic' ? ', on' : name === 'replay' ? ', replyId' : name === 'composer' ? ', focused, draft' : '';

      return { status: 400, body: { error: `Expected {window, scopeGen, opId${fields}}.` } };
    }

    const refused = refusal(this.deps.windows.scope(window), scopeGen, null);

    if (refused !== null) {
      return refused;
    }

    const voice = this.deps.voice;

    if (voice === undefined) {
      return { status: 404, body: { error: 'This hub has no voice.' } };
    }

    if (name === 'speak-replies') {
      voice.setSpeakReplies(on as boolean);
      return { status: 200, body: { on } };
    }

    if (name === 'composer') {
      voice.composer?.(window, focused as boolean, draft as string);
      return { status: 200, body: { done: true } };
    }

    if (name === 'mic') {
      const why = voice.mic === undefined ? 'This hub has no voice.' : voice.mic(window, on as boolean);

      return why === null ? { status: 200, body: { on } } : { status: 409, body: { error: why } };
    }

    const why = name === 'talk-here' ? voice.talkHere(window) : name === 'stop-speaking' ? voice.stopSpeaking(window) : voice.replay(window, replyId as string);

    return why === null ? { status: 200, body: { done: true } } : { status: why === 'Not in this window.' ? 403 : 409, body: { error: why } };
  }

  /**
   * `personas` (architecture.md § Personas): the roster the header offers, `[{id, name}]`, empty while `voice.enabled` is off. `persona
   * {sessionId, personaId | null}` pins a persona to the window's selected conversation's current session, or clears its pin; refused with 403
   * outside the scope, 409 for a stale `scopeGen`, while voice is off and with the flow's refusal.
   */
  /** Each `persona` command's answer, by window key and `opId`. */
  readonly #pinned = new Map<string, { status: number; body: unknown }>();

  personaCommand(name: 'personas' | 'persona', body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, scopeGen, opId, sessionId, personaId } = body;

    if (typeof window !== 'string' || typeof scopeGen !== 'number' || typeof opId !== 'string' || (name === 'persona' && (typeof sessionId !== 'string' || !(personaId === null || typeof personaId === 'string')))) {
      return { status: 400, body: { error: name === 'persona' ? 'Expected {window, scopeGen, opId, sessionId, personaId}.' : 'Expected {window, scopeGen, opId}.' } };
    }

    const refused = refusal(this.deps.windows.scope(window), scopeGen, name === 'persona' ? (sessionId as string) : null);

    if (refused !== null) {
      return refused;
    }

    const settings = this.deps.personas?.() ?? null;

    if (name === 'personas') {
      return { status: 200, body: { personas: settings === null || !settings.enabled ? [] : settings.personas.map((persona) => ({ id: persona.id, name: persona.name })) } };
    }

    if (settings === null || !settings.enabled || this.deps.pinPersona === undefined) {
      return { status: 409, body: { error: 'Voice is off (voice.enabled).' } };
    }

    // A repeated opId answers the first result and pins nothing again, so a retried Clear pin cannot resolve another persona.
    const done = `${window} ${opId}`;
    const first = this.#pinned.get(done);

    if (first !== undefined) {
      return first;
    }

    const why = this.deps.pinPersona(sessionId as string, personaId as string | null);
    let answer: { status: number; body: unknown };

    if (why !== null) {
      answer = { status: 409, body: { error: why } };
    } else {
      // The header shows the pin at once, before the next snapshot.
      this.sessionsChanged();
      answer = { status: 200, body: { persona: this.#view(this.deps.store.session(sessionId as string)!, true, this.deps.hooks(), settings).persona } };
    }

    this.#pinned.set(done, answer);

    // Kept for the newest commands only.
    if (this.#pinned.size > 200) {
      this.#pinned.delete(this.#pinned.keys().next().value!);
    }

    return answer;
  }

  /** The conversations made by `new-conversation`, by window file and `opId`, so a repeated command answers the first work item. */
  readonly #created = new Map<string, number>();

  /**
   * `select` (architecture.md § Window scope): selects one of the window's conversations, raising its `scopeGen`; the window gets `scope` and a
   * fresh `hello`. 403 for a work item that is not one of them. Not refused for a stale `scopeGen`, since it names its whole target.
   */
  select(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, opId, workItemId } = body;

    if (typeof window !== 'string' || typeof opId !== 'string' || !Number.isInteger(workItemId)) {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId, workItemId}.' } };
    }

    if (!this.deps.windows.select(window, workItemId as number)) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    this.scopesChanged([window]);
    this.deps.voice?.selected(window);

    return { status: 200, body: { scopeGen: this.deps.windows.scope(window)?.scopeGen ?? null } };
  }

  /**
   * `new-conversation` (architecture.md § Hosted conversations): makes an ad hoc work item hosted by the window in its folder, starts its Code
   * Mode session at an empty prompt, selects it and answers `{workItemId}`; 409 with the refusal, such as while Code Mode is off. A repeated
   * `opId` answers the first work item and makes none.
   */
  newConversation(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, opId, provider } = body;

    if (typeof window !== 'string' || typeof opId !== 'string' || opId === '' || opId.length > 200) {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId}.' } };
    }
    if (provider !== undefined && provider !== 'claude' && provider !== 'codex') return { status: 400, body: { error: 'Choose Claude or Codex.' } };

    // The window's binding hosts it: an item window's workspace file, or a folder window's canonical folder.
    const file = this.deps.windows.hostOf(window);
    const scope = this.deps.windows.scope(window);

    if (file === null || scope === null || this.deps.newConversation === undefined) {
      return { status: 403, body: { error: 'Not in this window.' } };
    }

    const done = `${hostKey(file)} ${opId}`;
    const earlier = this.#created.get(done);

    if (earlier !== undefined) {
      return { status: 200, body: { workItemId: earlier } };
    }

    const made = provider === undefined ? this.deps.newConversation(file, scope.folder ?? '') : this.deps.newConversation(file, scope.folder ?? '', provider);

    if ('refused' in made) {
      return { status: 409, body: { error: made.refused } };
    }

    this.#remember(done, made.workItemId);

    // Every window of the binding lists it; the one that made it selects it.
    this.deps.windows.select(window, made.workItemId);
    this.scopesChanged([window]);
    this.conversationsChanged();

    return { status: 200, body: { workItemId: made.workItemId } };
  }

  /**
   * `POST /dock/new-conversation` (architecture.md § Hosted conversations): makes a conversation hosted by the folder's canonical folder and run
   * in it, with or without a window on it, stores it as that folder binding's selection, and answers `{workItemId, folder}`, the canonical folder
   * the dock opens. A repeated `opId` answers the first work item and makes none. 400 for a path that is not a folder, 409 with the refusal.
   */
  dockConversation(body: Record<string, unknown>): { status: number; body: unknown } {
    const { folder, opId, provider } = body;

    if (typeof folder !== 'string' || folder === '' || typeof opId !== 'string' || opId === '' || opId.length > 200) {
      return { status: 400, body: { error: 'Expected {folder, opId}.' } };
    }
    if (provider !== undefined && provider !== 'claude' && provider !== 'codex') return { status: 400, body: { error: 'Choose Claude or Codex.' } };

    const host = canonicalFolder(folder);

    if (host === null) {
      return { status: 400, body: { error: `${folder} is not a folder a session can run in.` } };
    }

    if (this.deps.newConversation === undefined) {
      return { status: 409, body: { error: 'The conversation was not made.' } };
    }

    // Keyed as a folder window's command is, by the canonical folder, so a retry by another spelling still answers the first.
    const done = `${hostKey(host)} ${opId}`;
    const earlier = this.#created.get(done);

    if (earlier !== undefined) {
      return { status: 200, body: { workItemId: earlier, folder: host } };
    }

    const made = provider === undefined ? this.deps.newConversation(host, host) : this.deps.newConversation(host, host, provider);

    if ('refused' in made) {
      return { status: 409, body: { error: made.refused } };
    }

    this.#remember(done, made.workItemId);
    this.scopesChanged(this.deps.windows.selectMade(host, made.workItemId));
    this.conversationsChanged();

    return { status: 200, body: { workItemId: made.workItemId, folder: host } };
  }

  /**
   * `page-conversation {window, scopeGen, opId, provider?}` (architecture.md § Web page): the dropdown's New conversation… on the page, which
   * makes a folder-hosted conversation as the dock's New conversation in a folder does, in the folder of the conversation the page shows, never
   * one the page names; answers `{workItemId, folder}`. 403 for a key that is not a page's or a page with no selection, 409 for a stale
   * `scopeGen` and with the flow's refusal.
   */
  pageConversation(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, scopeGen, opId, provider } = body;

    if (typeof window !== 'string' || typeof scopeGen !== 'number' || typeof opId !== 'string') {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId, provider?}.' } };
    }

    const scope = this.deps.windows.isPage(window) ? this.deps.windows.scope(window) : null;
    const refused = refusal(scope?.workItemId == null ? null : scope, scopeGen, null);

    if (refused !== null) {
      return refused;
    }

    if (scope!.folder == null) {
      return { status: 409, body: { error: 'This conversation has no folder to start another in.' } };
    }

    return this.dockConversation({ folder: scope!.folder, opId, ...(provider === undefined ? {} : { provider }) });
  }

  /** Remembers the work item a `new-conversation` made, keeping the last `UNSENT_KEPT`. */
  #remember(done: string, workItemId: number): void {
    this.#created.set(done, workItemId);

    for (const key of [...this.#created.keys()].slice(0, -UNSENT_KEPT)) {
      this.#created.delete(key);
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

  /**
   * `statuses` (architecture.md § Statuses): the statuses of the window's current session, newest first, before the status `before` names, or
   * from the latest with null, for the Markdown preview. Refused as `history` is: 403 outside the scope, 409 for a stale `scopeGen`.
   */
  statuses(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, scopeGen, sessionId, before, limit } = body;

    if (typeof window !== 'string' || typeof scopeGen !== 'number' || typeof sessionId !== 'string' || !(before === null || typeof before === 'string') || !(limit === undefined || (Number.isInteger(limit) && (limit as number) > 0))) {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId, before, limit?}.' } };
    }

    const refused = refusal(this.deps.windows.scope(window), scopeGen, sessionId);

    if (refused !== null) {
      return refused;
    }

    const page = this.deps.store.statuses(sessionId, before, Math.min((limit as number | undefined) ?? PAGE_STATUSES, PAGE_STATUSES));

    return { status: 200, body: { statuses: page.statuses.map(statusView), more: page.more } };
  }

  /**
   * `commands` (architecture.md § Slash commands): the slash commands the window's current session offers, for the composer's list: the built-ins,
   * then the skills its transcript lists. Refused as `history` is: 403 outside the scope, 409 for a stale `scopeGen`. It only reads.
   */
  commands(body: Record<string, unknown>): { status: number; body: unknown } {
    const { window, scopeGen, sessionId } = body;

    if (typeof window !== 'string' || typeof scopeGen !== 'number' || typeof sessionId !== 'string') {
      return { status: 400, body: { error: 'Expected {window, scopeGen, opId, sessionId}.' } };
    }

    const refused = refusal(this.deps.windows.scope(window), scopeGen, sessionId);

    if (refused !== null) {
      return refused;
    }

    const session = this.deps.store.session(sessionId);
    const list = session === null ? [] : this.#adapter(session)?.commands(session) ?? [];

    return { status: 200, body: { commands: list } };
  }
}

/** The text a message was typed as, with the tags Switchboard put before it (architecture.md § Voice, § Dictation). */
export function typedText(message: ConversationMessage, expressive: boolean, codeMode: boolean): string {
  const dictated = message.origin !== 'voice' ? null : message.partial === true ? 'partial' : 'voice';
  const spoken = message.spokenRequested === true;
  const note = dictated === null || message.interrupted === undefined ? null : interruptNote(message.interrupted);

  return spoken || dictated !== null ? `${messageTags(spoken, spoken && expressive, dictated, note)}${codeMode ? pasteText(message.text) : message.text}` : message.text;
}

/** Why a command for a conversation the window no longer shows is refused. */
export const CONVERSATION_CHANGED = "The window's conversation changed.";

/** How many not-sent `opId`s the service remembers, for a `send` repeated after its message left the conversation. */
const UNSENT_KEPT = 100;

/** A slash command as `send` types it unescaped: `/name`, then arguments on the same line. */
const SLASH_COMMAND = /^\/[\w:.-]+(?: [^\n]*)?$/;

/** How long a typed message waits for the holder to answer a screen read or a write. */
export const HOLDER_ANSWER_MS = 5_000;

/** Why a command is refused: a session outside the window's scope, or a scope generation that is no longer the window's. */
export function refusal(scope: WindowScope | null, scopeGen: number, sessionId: string | null): { status: number; body: { error: string } } | null {
  if (scope === null || (sessionId !== null && scope.sessionId !== sessionId)) {
    return { status: 403, body: { error: 'Not in this window.' } };
  }

  return scope.scopeGen === scopeGen ? null : { status: 409, body: { error: CONVERSATION_CHANGED } };
}
