import { DEVICE_OFF_TIP, PAUSED_BY_VOICE_TIP, ROOM_HOLD_TIP } from '@switchboard/conversation/voiceControls';
import { SESSION_ICONS, SESSION_TONES, sessionIcon } from '@switchboard/core/group';
import type { IconTone } from '@switchboard/core/group';
import type { SessionIcon } from '@switchboard/core/group';
import type { ArtifactView, ConversationEntry, ItemView, QuestionsView, ReplyView, ScopeView, SessionView, StatusView, VoiceView } from '@switchboard/hub';

/** What a window's Conversation view shows, kept from its conversation stream (architecture.md § Conversation view). */
export interface ConversationState {
  /** The window's conversations, and of the selected one its work item and current session; null for a window with none. */
  scope: ScopeView | null;
  session: SessionView | null;
  /** Messages and replies, oldest first. */
  items: ItemView[];
  /** Whether older items can be loaded. */
  more: boolean;
  /** Whether the stream is open. */
  connected: boolean;
  /** The Status tab's status: the current session's latest, or the work item's stage before it; null for neither. */
  status: StatusView | null;
  /** The work item's artifact folder, which the artifacts' paths are relative to; null when the window has none. */
  artifactsDir: string | null;
  /** The work item's artifacts, newest first (architecture.md § Artifacts). */
  artifacts: ArtifactView[];
  /** How many replies and statuses of the selected conversation's current session the operator has not seen (architecture.md § Unread). */
  unread: number;
  /** This window's voice state (architecture.md § Voice); null from a hub without voice. */
  voice: VoiceView | null;
  /** The one setting the view reads: whether a reply with details after its primary response starts expanded. */
  settings: { expandReplies: boolean };
  /** The session's questions as the hub keeps them (PRD R103): the open count, the oldest open card and the card drafts; null from an older hub. */
  questions?: QuestionsView | null;
}

export const EMPTY_CONVERSATION: ConversationState = { scope: null, session: null, items: [], more: false, connected: false, status: null, artifactsDir: null, artifacts: [], unread: 0, voice: null, settings: { expandReplies: false }, questions: null };

/** An event of the conversation stream, as parsed from its data line. */
export type ConversationEvent =
  | { type: 'hello'; scope: ScopeView | null; sessions: SessionView[]; items: ItemView[]; more: boolean; status: StatusView | null; artifactsDir: string | null; artifacts: ArtifactView[]; unread?: number; voice?: VoiceView; settings?: { expandReplies: boolean }; questions?: QuestionsView | null }
  | { type: 'voice'; voice: VoiceView }
  | { type: 'questions'; questions: QuestionsView }
  | { type: 'settings'; settings: { expandReplies: boolean } }
  | { type: 'progress'; replyId: string; chars: number; atMs: number }
  | { type: 'scope'; scope: ScopeView | null }
  | { type: 'conversations'; conversations: ConversationEntry[] }
  | { type: 'session'; session: SessionView }
  | { type: 'message'; message: ItemView }
  | { type: 'reply'; reply: ItemView }
  | { type: 'status'; status: StatusView | null }
  | { type: 'artifact'; artifact: ArtifactView | { path: string }; removed?: true }
  | { type: 'unread'; workItemId: number; count: number }
  | { type: string };

/**
 * An item's place in the conversation (architecture.md § Conversation): items in the transcript in its line order, then a sent message or a
 * reply's screen copy, not in it yet, in the order first seen. The hub gives each item a new `ord` when its transcript line is read.
 */
function place(item: ItemView): [number, number] {
  return [item.provisional ? 1 : 0, item.ord];
}

/** A typed message that was not sent, which the conversation never keeps (architecture.md § Typing a message). */
function notSent(item: ItemView): boolean {
  return item.type === 'message' && item.delivery === 'not-sent';
}

/** Inserts or replaces an item by ID, keeping the items in their places. */
function upsert(items: ItemView[], item: ItemView): ItemView[] {
  const rest = items.filter((other) => other.id !== item.id);
  const [group, ord] = place(item);
  const at = rest.findIndex((other) => {
    const [otherGroup, otherOrd] = place(other);

    return otherGroup > group || (otherGroup === group && otherOrd > ord);
  });

  return at === -1 ? [...rest, item] : [...rest.slice(0, at), item, ...rest.slice(at)];
}

/** The state after one event. A `hello` starts from empty, as after a reconnect or when the window's work item or session changed. */
export function applyEvent(state: ConversationState, event: ConversationEvent): ConversationState {
  switch (event.type) {
    case 'hello': {
      const hello = event as Extract<ConversationEvent, { type: 'hello' }>;

      return {
        scope: hello.scope,
        session: hello.sessions.find((session) => session.current) ?? null,
        items: hello.items.filter((item) => !notSent(item)),
        more: hello.more,
        connected: true,
        status: hello.status ?? null,
        artifactsDir: hello.artifactsDir,
        artifacts: newestFirst(hello.artifacts),
        // A hub from before unread counts sends none.
        unread: hello.unread ?? 0,
        voice: hello.voice ?? null,
        settings: hello.settings ?? state.settings,
        questions: hello.questions ?? null,
      };
    }
    case 'questions': {
      const questions = (event as Extract<ConversationEvent, { type: 'questions' }>).questions;

      return questions?.sessionId === state.scope?.sessionId ? { ...state, questions } : state;
    }
    case 'voice':
      return { ...state, voice: (event as Extract<ConversationEvent, { type: 'voice' }>).voice };
    case 'settings':
      return { ...state, settings: (event as Extract<ConversationEvent, { type: 'settings' }>).settings };
    case 'progress': {
      // Where a playing reply stands, until its next `reply` event; nothing is stored.
      const { replyId, chars, atMs } = event as Extract<ConversationEvent, { type: 'progress' }>;

      return { ...state, items: state.items.map((item) => (item.id === replyId && item.type === 'reply' ? { ...item, spoken: { state: 'playing', atMs, saidChars: chars } } : item)) };
    }
    case 'scope': {
      const { scope } = event as Extract<ConversationEvent, { type: 'scope' }>;
      const moved = scope?.workItemId !== state.scope?.workItemId || scope?.sessionId !== state.scope?.sessionId;

      // The status of a work item or session the window no longer shows goes, and the artifacts of a work item it no longer shows; the next hello
      // brings the new ones.
      const left = scope?.workItemId !== state.scope?.workItemId;

      return { ...state, scope, status: moved ? null : state.status, unread: moved ? 0 : state.unread, artifacts: left ? [] : state.artifacts, artifactsDir: left ? null : state.artifactsDir };
    }
    case 'session': {
      const { session } = event as Extract<ConversationEvent, { type: 'session' }>;

      return session.id === state.scope?.sessionId ? { ...state, session } : state;
    }
    case 'message': {
      const { message } = event as { message: ItemView };

      // A typed message that was not sent leaves the conversation.
      return { ...state, items: notSent(message) ? state.items.filter((item) => item.id !== message.id) : upsert(state.items, message) };
    }
    case 'reply':
      return { ...state, items: upsert(state.items, (event as { reply: ItemView }).reply) };
    case 'status': {
      const { status } = event as Extract<ConversationEvent, { type: 'status' }>;

      // A status of a session the window no longer shows, sent before its scope moved, is dropped.
      return status === null || status.sessionId === state.scope?.sessionId || (status.fallback && status.id === `stage-${state.scope?.workItemId}`) ? { ...state, status } : state;
    }
    case 'conversations': {
      const { conversations } = event as Extract<ConversationEvent, { type: 'conversations' }>;

      return state.scope === null ? state : { ...state, scope: { ...state.scope, conversations } };
    }
    case 'unread': {
      const { workItemId, count } = event as Extract<ConversationEvent, { type: 'unread' }>;
      const scope = state.scope === null ? null : { ...state.scope, conversations: state.scope.conversations.map((entry) => (entry.workItemId === workItemId ? { ...entry, unread: count } : entry)) };

      return { ...state, scope, unread: workItemId === state.scope?.workItemId ? count : state.unread };
    }
    case 'artifact': {
      const { artifact, removed } = event as Extract<ConversationEvent, { type: 'artifact' }>;
      const rest = state.artifacts.filter((one) => one.path !== artifact.path);

      return { ...state, artifacts: removed === true || !('updatedAt' in artifact) ? rest : newestFirst([...rest, artifact]) };
    }
    default:
      return state;
  }
}

function newestFirst(artifacts: ArtifactView[]): ArtifactView[] {
  return [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
}

/** Older items a `history` page brought, before the ones the view shows. */
export function withEarlier(state: ConversationState, items: ItemView[], more: boolean): ConversationState {
  const known = new Set(state.items.map((item) => item.id));

  return { ...state, items: [...items.filter((item) => !known.has(item.id) && !notSent(item)), ...state.items], more };
}

/** One row of the timeline: a message, a reply with the earlier reply it rewrote, or an artifact where it was last written. */
export type Entry = { type: 'message'; item: Extract<ItemView, { type: 'message' }> } | { type: 'reply'; item: ReplyView; earlier: ReplyView | null } | { type: 'artifact'; artifact: ArtifactView };

/**
 * The timeline the view draws: withdrawn screen copies and sent messages are left out, and a rewrite takes the place of the reply it rewrote,
 * which stays one click away. Each artifact last written since the oldest item shown sits after the last item from before it was written
 * (`placeArtifacts`).
 */
export function timeline(items: ItemView[], artifacts: readonly ArtifactView[] = []): Entry[] {
  return placeArtifacts(conversationEntries(items), artifacts);
}

/**
 * Artifacts on the timeline (architecture.md § Conversation view): the folder is the record, so an artifact has no place in the transcript and is
 * placed by time, after the last entry from no later than its last write; one written before the oldest item shown is only in the Artifacts view.
 */
export function placeArtifacts(entries: Entry[], artifacts: readonly ArtifactView[]): Entry[] {
  const atOf = (entry: Entry): number => (entry.type === 'artifact' ? entry.artifact.updatedAt : entry.item.at);
  const oldest = entries[0] === undefined ? null : atOf(entries[0]);
  const placed = [...entries];

  if (oldest === null) {
    return placed;
  }

  for (const artifact of [...artifacts].filter((one) => one.updatedAt >= oldest).sort((a, b) => a.updatedAt - b.updatedAt || a.path.localeCompare(b.path))) {
    let at = placed.length;

    while (at > 0 && atOf(placed[at - 1]!) > artifact.updatedAt) {
      at--;
    }

    placed.splice(at, 0, { type: 'artifact', artifact });
  }

  return placed;
}

function conversationEntries(items: ItemView[]): Entry[] {
  const replies = new Map(items.filter((item): item is ReplyView => item.type === 'reply' && !item.withdrawn).map((reply) => [reply.id, reply]));
  const placed = new Set<string>();
  const entries: Entry[] = [];

  for (const item of items) {
    if (item.type === 'message') {
      if (!item.withdrawn) {
        entries.push({ type: 'message', item });
      }

      continue;
    }

    // A reply that is only a status shows on the Status tab, not in the timeline, and one with no text at all shows nothing.
    if (item.withdrawn || placed.has(item.id) || (item.kind === 'reply' && item.opening.trim() === '' && item.rewrittenBy === null)) {
      continue;
    }

    // A reply rewritten more than once shows its last rewrite, with the version before it behind the fold.
    let shown: ReplyView = item;
    let earlier: ReplyView | null = null;

    for (let next = replies.get(shown.rewrittenBy ?? ''); next !== undefined && !placed.has(next.id); next = replies.get(shown.rewrittenBy ?? '')) {
      earlier = shown;
      shown = next;
      placed.add(next.id);
    }

    entries.push({ type: 'reply', item: shown, earlier });
  }

  return entries;
}

/** A status's first line, without Markdown's heading, list and emphasis marks, for a one-line label. */
export function statusLine(markdown: string): string {
  const line = markdown.split('\n').find((one) => one.trim() !== '') ?? '';

  return line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)*/, '').replace(/[*_`]/g, '').trim();
}

/** An artifact's codicon by its type, in the timeline and the Artifacts tab. */
export function artifactIcon(type: ArtifactView['type']): string {
  switch (type) {
    case 'markdown':
      return 'markdown';
    case 'html':
      return 'globe';
    case 'image':
      return 'file-media';
    case 'audio':
      return 'unmute';
    case 'video':
      return 'device-camera-video';
    default:
      return 'file';
  }
}

/** The view's badge count: every conversation's unread replies and statuses (architecture.md § Unread). */
export function totalUnread(state: ConversationState): number {
  const entries = state.scope?.conversations ?? [];

  return entries.length === 0 ? state.unread : entries.reduce((sum, entry) => sum + (entry.workItemId === state.scope?.workItemId ? state.unread : entry.unread), 0);
}

/** The selected conversation's dropdown entry, or null. */
export function selectedEntry(state: ConversationState): ConversationEntry | null {
  return state.scope?.conversations.find((entry) => entry.workItemId === state.scope?.workItemId) ?? null;
}

/** Whether the session is working, which the header's spinning codicon and the timeline's spinner show. */
/** `Rate limited · resumes 1:20 PM`, or `retries` when the time is the hub's next attempt; another day adds the weekday. */
export function limitText(limit: { until: number; retry: boolean }, now = Date.now()): string {
  const at = new Date(limit.until);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const when = at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;

  return `Rate limited · ${limit.retry ? 'retries' : 'resumes'} ${when}`;
}

export function isWorking(session: SessionView | null): boolean {
  return session?.state === 'starting' || session?.state === 'running';
}

/**
 * Whether the session is in a turn: starting, or running other than with only background tasks left. The turn row shows all through it, also
 * after a reply mid-turn and in a turn a task notification started, which answers no message.
 */
export function inTurn(session: SessionView | null): boolean {
  // `background` absent: an older hub, so only awaitingReply shows the row.
  return session?.state === 'starting' || (session?.state === 'running' && session.background !== undefined && !session.background);
}

/**
 * Whether the session is in a turn and no reply answers the operator's latest message or a later one, so the view shows its turn row at the
 * end of the timeline even before a hook says the turn started. A reply's `answers` follows the transcript's links, so a rewrite, which the
 * timeline shows in the place of the earlier reply it rewrote, can end the wait; asides and notes do not. A reply that names no message ends it
 * when it comes later.
 */
export function awaitingReply(items: readonly ItemView[], session: SessionView | null): boolean {
  // It stands still while the session waits on a question or a permission, and goes when the turn or the session ends.
  if (!isWorking(session) && session?.state !== 'waiting') {
    return false;
  }

  const lastIndex = <T,>(list: readonly T[], test: (one: T) => boolean): number => list.reduce((found, one, index) => (test(one) ? index : found), -1);
  const latest = lastIndex(items, (item) => item.type === 'message' && !item.withdrawn);
  const at = new Map(items.map((item, index) => [item.id, index]));
  const replied = items.some(
    (item, index) => item.type === 'reply' && item.kind === 'reply' && !item.withdrawn && (item.answers === null ? index > latest : (at.get(item.answers) ?? -1) >= latest),
  );

  return latest !== -1 && !replied;
}

/** The newest reply the view shows that has a passage to speak, which Replay Last Reply speaks again; null for none. */
export function lastSpokenReply(state: ConversationState): ReplyView | null {
  return [...state.items].reverse().find((item): item is ReplyView => item.type === 'reply' && !item.withdrawn && item.rewrittenBy === null && item.speak !== null) ?? null;
}

/**
 * The voice's status bar item (architecture.md § Voice): only this window's state, so a window that is not here cannot tell whether the voice is
 * in another window or in none; null hides it.
 */
export function voiceStatus(voice: VoiceView | null): { text: string; tooltip: string; command: string | null; warning: boolean } | null {
  if (voice === null || !voice.enabled) {
    return null;
  }

  if (!voice.here) {
    return { text: '$(circle-slash) Voice not here', tooltip: 'Click to use voice for this session.', command: 'switchboard.talkHere', warning: false };
  }

  // After the phone left, no device has the voice: nothing plays or listens until it is taken back (PRD R119).
  if (voice.deviceOff === true) {
    return { text: '$(circle-slash) Voice off', tooltip: DEVICE_OFF_TIP, command: 'switchboard.talkHere', warning: true };
  }

  if (voice.error !== null) {
    return { text: '$(warning) Voice', tooltip: `Voice: ${voice.error} Click to show the voice log.`, command: 'switchboard.showVoiceLog', warning: true };
  }

  // Half-duplex capture (architecture.md § Dictation) does not listen while the voice speaks; full duplex with no echo cancellation says why it does.
  const halfDuplex = voice.halfDuplex !== undefined ? ` Listening pauses while a reply plays (${voice.halfDuplex}), so talking over it does not stop it.` : voice.fullDuplex !== undefined ? ` Full duplex (${voice.fullDuplex}): talking over a reply stops it.` : '';
  // The room hold (architecture.md § Voice check and barge-in).
  const sends = voice.roomHold === true ? ROOM_HOLD_TIP : 'Dictation sends when you stop talking.';

  if (voice.speaking !== null) {
    return { text: '$(unmute) Speaking', tooltip: `${halfDuplex.trim()} Click to stop speaking.`.trim(), command: 'switchboard.stopSpeaking', warning: false };
  }

  // The mic (architecture.md § Dictation).
  switch (voice.mic) {
    case 'listening':
    case 'hearing':
      return { text: voice.roomHold === true ? '$(mic-filled) Dictation waiting' : '$(mic-filled) Listening', tooltip: `${sends}${halfDuplex} Click to turn the mic off.`, command: 'switchboard.toggleMicrophone', warning: false };
    case 'typing':
      return { text: '$(mic-filled) Typing', tooltip: 'Dictation pauses while the composer has the focus. Click to turn the mic off.', command: 'switchboard.toggleMicrophone', warning: false };
    case 'starting':
      return { text: '$(mic-filled) Mic starting', tooltip: 'The mic is starting. Click to turn it off.', command: 'switchboard.toggleMicrophone', warning: false };
    case 'paused-other-app':
      return { text: '$(mic) Mic paused', tooltip: 'Paused: another app is using the microphone. Click to show the voice log.', command: 'switchboard.showVoiceLog', warning: false };
    case 'paused-by-voice':
      return { text: '$(mic) Mic paused', tooltip: PAUSED_BY_VOICE_TIP, command: 'switchboard.toggleMicrophone', warning: false };
    default:
      return { text: '$(mic) Mic off', tooltip: voice.mic === 'idle-off' ? 'Mic turned off after inactivity. Click to turn it on.' : 'Click to turn the mic on.', command: 'switchboard.toggleMicrophone', warning: false };
  }
}

// The mic's tooltips while "stop listening" paused it and during a room hold, shared with the web page's mic button.
export { PAUSED_BY_VOICE_TIP, ROOM_HOLD_TIP };

/**
 * Whether the mic is on in this window, so Toggle Microphone turns it off; an idle stop counts as off, so the toggle starts it again, and so does
 * a mic that cannot run, so the toggle tries again, and one "stop listening" paused, so the toggle listens again.
 */
export function micOn(voice: VoiceView | null): boolean {
  return voice?.here === true && voice.mic !== 'off' && voice.mic !== 'idle-off' && voice.mic !== 'unavailable' && voice.mic !== 'paused-by-voice';
}

/** The header's codicon for the session's state (architecture.md § Conversation view). */
export function stateIcon(session: SessionView | null): { icon: string; text: string; tone: IconTone } {
  const kind = sessionIcon(session?.state, session?.waitingFor ?? null, session?.limit != null);

  // A session waiting for a usage limit to reset (architecture.md § Rate limits).
  return { icon: SESSION_ICONS[kind], text: kind === 'limited' ? limitText(session!.limit!) : SESSION_WORDS[kind], tone: SESSION_TONES[kind] };
}

/** Each session icon in words. */
const SESSION_WORDS: Record<SessionIcon, string> = {
  question: 'Waiting for your answer',
  limited: 'Rate limited',
  permission: 'Waiting for permission',
  running: 'Working',
  idle: 'Idle',
  failed: 'Failed',
  starting: 'Starting',
  ended: 'Ended',
  none: 'No session',
};
