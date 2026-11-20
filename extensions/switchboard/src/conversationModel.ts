import type { ArtifactView, ItemView, ReplyView, SessionView, StatusView, WindowScope } from '@switchboard/hub';

/** What a window's Conversation view shows, kept from its conversation stream (architecture.md § Conversation view). */
export interface ConversationState {
  /** The window's work item and current session; null for a window with none. */
  scope: WindowScope | null;
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
  /** How many replies and statuses of the current session the operator has not seen, which the view's badge shows (architecture.md § Unread). */
  unread: number;
}

export const EMPTY_CONVERSATION: ConversationState = { scope: null, session: null, items: [], more: false, connected: false, status: null, artifactsDir: null, artifacts: [], unread: 0 };

/** An event of the conversation stream, as parsed from its data line. */
export type ConversationEvent =
  | { type: 'hello'; scope: WindowScope | null; sessions: SessionView[]; items: ItemView[]; more: boolean; status: StatusView | null; artifactsDir: string | null; artifacts: ArtifactView[]; unread?: number }
  | { type: 'scope'; scope: WindowScope | null }
  | { type: 'session'; session: SessionView }
  | { type: 'message'; message: ItemView }
  | { type: 'reply'; reply: ItemView }
  | { type: 'status'; status: StatusView | null }
  | { type: 'artifact'; artifact: ArtifactView | { path: string }; removed?: true }
  | { type: 'unread'; count: number }
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
      };
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
    case 'unread':
      return { ...state, unread: (event as Extract<ConversationEvent, { type: 'unread' }>).count };
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

    // A reply that is only a status shows on the Status tab, not in the timeline.
    if (item.withdrawn || placed.has(item.id) || (item.kind === 'reply' && item.opening === '' && item.rewrittenBy === null)) {
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

/** Whether the session is working, which the header's spinning codicon and the timeline's spinner show. */
export function isWorking(session: SessionView | null): boolean {
  return session?.state === 'starting' || session?.state === 'running';
}

/**
 * The index of the operator's latest message in `entries` while the session is in a turn and no reply answers it or a later message, under which
 * the view shows its spinner; -1 otherwise. A reply's `answers` follows the transcript's links, so a rewrite, which the timeline shows in the
 * place of the earlier reply it rewrote, can end the wait; asides and notes do not. A reply that names no message ends it when it comes later.
 */
export function awaitingReply(items: readonly ItemView[], entries: readonly Entry[], session: SessionView | null): number {
  // It stands still while the session waits on a question or a permission, and goes when the turn or the session ends.
  if (!isWorking(session) && session?.state !== 'waiting') {
    return -1;
  }

  const lastIndex = <T,>(list: readonly T[], test: (one: T) => boolean): number => list.reduce((found, one, index) => (test(one) ? index : found), -1);
  const latest = lastIndex(items, (item) => item.type === 'message' && !item.withdrawn);
  const at = new Map(items.map((item, index) => [item.id, index]));
  const replied = items.some(
    (item, index) => item.type === 'reply' && item.kind === 'reply' && !item.withdrawn && (item.answers === null ? index > latest : (at.get(item.answers) ?? -1) >= latest),
  );

  return latest === -1 || replied ? -1 : lastIndex(entries, (entry) => entry.type === 'message');
}

/** The header's codicon for the session's state (architecture.md § Conversation view). */
export function stateIcon(session: SessionView | null): { icon: string; text: string } {
  switch (session?.state) {
    case undefined:
      return { icon: 'circle-slash', text: 'No session' };
    case 'starting':
      return { icon: 'sync~spin', text: 'Starting' };
    case 'running':
      return { icon: 'sync~spin', text: 'Working' };
    case 'waiting':
      return session.waitingFor === 'permission' ? { icon: 'shield', text: 'Waiting for permission' } : { icon: 'question', text: 'Waiting for your answer' };
    case 'idle':
      return { icon: 'check', text: 'Idle' };
    case 'ended':
      return { icon: 'circle-slash', text: 'Ended' };
  }
}
