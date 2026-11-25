import { SESSION_ICONS, SESSION_TONES, sessionIcon } from '@switchboard/core/group';
import type { IconTone, SessionIcon } from '@switchboard/core/group';
import type { ArtifactView, ConversationEntry, ItemView, PageGroup, PageHeader, PageRow, QuestionsView, ReplyView, ScopeView, SessionView, StateView, VoiceView } from '@switchboard/protocol';

/** What the page shows, kept from its conversation stream (architecture.md § Web page). */
export interface PageState {
  /** The page key the hub gave in `hello`, which every command names. */
  key: string | null;
  connected: boolean;
  groups: PageGroup[];
  /** What the list's header shows: the sources of the hub's dock header; null before the hub sent it. */
  header: PageHeader | null;
  /** The selected work item's group, its current session and what it shows; null before the page selected one. */
  scope: ScopeView | null;
  session: SessionView | null;
  items: ItemView[];
  more: boolean;
  /** The state History shows at its top (architecture.md § States). */
  state: StateView | null;
  artifacts: ArtifactView[];
  unread: number;
  voice: VoiceView | null;
  /** The session's questions as the hub keeps them (PRD R103): the open count, the oldest open card and the card drafts; null before the hub sent them. */
  questions: QuestionsView | null;
  briefReplies: boolean;
  iframeBrowser?: boolean;
  /** The diff viewer's settings (`web.diffLayout`, `web.diffWrap`), from the `hello` and each `settings` event. */
  diffLayout: 'auto' | 'split' | 'stacked';
  diffWrap: 'auto' | 'on' | 'off';
}

export const EMPTY: PageState = { key: null, connected: false, groups: [], header: null, scope: null, session: null, items: [], more: false, state: null, artifacts: [], unread: 0, voice: null, questions: null, briefReplies: false, diffLayout: 'auto', diffWrap: 'auto' };

/** The diff viewer's settings an event carries, each kept as it was when the event lacks it or names a value the page does not know. */
function diffSettings(settings: Record<string, unknown> | undefined, state: PageState): Pick<PageState, 'diffLayout' | 'diffWrap'> {
  const layout = settings?.['diffLayout'];
  const wrap = settings?.['diffWrap'];

  return {
    diffLayout: layout === 'auto' || layout === 'split' || layout === 'stacked' ? layout : state.diffLayout,
    diffWrap: wrap === 'auto' || wrap === 'on' || wrap === 'off' ? wrap : state.diffWrap,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Event = { type: string } & Record<string, any>;

/** In the transcript first, in its line order; then what is not in it yet, in the order first seen. */
function place(item: ItemView): [number, number] {
  return [item.provisional ? 1 : 0, item.ord];
}

function upsert(items: ItemView[], item: ItemView): ItemView[] {
  const rest = items.filter((other) => other.id !== item.id);
  const [group, ord] = place(item);
  const at = rest.findIndex((other) => {
    const [otherGroup, otherOrd] = place(other);

    return otherGroup > group || (otherGroup === group && otherOrd > ord);
  });

  return at === -1 ? [...rest, item] : [...rest.slice(0, at), item, ...rest.slice(at)];
}

const notSent = (item: ItemView): boolean => item.type === 'message' && item.delivery === 'not-sent';

const newestFirst = (artifacts: ArtifactView[]): ArtifactView[] => [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));

/** The state after one event of the stream; `hello` starts the conversation from empty. */
export function applyEvent(state: PageState, event: Event): PageState {
  switch (event.type) {
    case 'hello':
      return {
        ...state,
        key: event['key'] ?? state.key,
        connected: true,
        groups: event['groups'] ?? state.groups,
        header: event['header'] ?? state.header,
        scope: event['scope'] ?? null,
        session: (event['sessions'] as SessionView[] | undefined)?.find((one) => one.current) ?? null,
        items: ((event['items'] as ItemView[] | undefined) ?? []).filter((item) => !notSent(item)),
        more: event['more'] === true,
        state: event['state'] ?? null,
        artifacts: newestFirst(event['artifacts'] ?? []),
        unread: event['unread'] ?? 0,
        voice: event['voice'] ?? null,
        questions: event['questions'] ?? null,
        briefReplies: event['settings']?.briefReplies ?? state.briefReplies,
        iframeBrowser: event['settings']?.iframeBrowser === true,
        ...diffSettings(event['settings'], state),
      };
    case 'list':
      return { ...state, groups: event['groups'], header: event['header'] ?? state.header };
    case 'scope':
      return { ...state, scope: event['scope'] ?? null };
    case 'conversations':
      return state.scope === null ? state : { ...state, scope: { ...state.scope, conversations: event['conversations'] as ConversationEntry[] } };
    case 'session':
      return event['session'].id === state.scope?.sessionId ? { ...state, session: event['session'] } : state;
    case 'message':
      return { ...state, items: notSent(event['message']) ? state.items.filter((item) => item.id !== event['message'].id) : upsert(state.items, event['message']) };
    case 'reply':
      return { ...state, items: upsert(state.items, event['reply']) };
    case 'state':
      // The hub sends each window the state of its own scope, and a new scope with a new `hello`.
      return { ...state, state: event['state'] as StateView | null };
    case 'artifact': {
      const rest = state.artifacts.filter((one) => one.path !== event['artifact'].path);

      return { ...state, artifacts: event['removed'] === true ? rest : newestFirst([...rest, event['artifact']]) };
    }
    case 'unread': {
      const scope = state.scope === null ? null : { ...state.scope, conversations: state.scope.conversations.map((entry) => (entry.workItemId === event['workItemId'] ? { ...entry, unread: event['count'] } : entry)) };

      // The count is the current session's, so it does not change the shown count of an earlier session.
      return { ...state, scope, unread: event['workItemId'] === state.scope?.workItemId && state.scope?.earlier !== true ? event['count'] : state.unread };
    }
    case 'voice':
      return { ...state, voice: event['voice'] };
    case 'questions':
      return event['questions']?.sessionId === state.scope?.sessionId ? { ...state, questions: event['questions'] } : state;
    case 'settings':
      return { ...state, briefReplies: event['settings']?.briefReplies === true, iframeBrowser: event['settings']?.iframeBrowser === true, ...diffSettings(event['settings'], state) };
    case 'progress':
      return { ...state, items: state.items.map((item) => (item.id === event['replyId'] && item.type === 'reply' ? { ...item, spoken: { state: 'playing', atMs: event['atMs'], saidChars: event['chars'] } } : item)) };
    default:
      return state;
  }
}

/** The page's title: "(2) Switchboard" while the Blocked on you group holds two work items, else "Switchboard". */
export function pageTitle(groups: readonly PageGroup[]): string {
  const needs = groups.find((group) => group.key === 'blocked')?.rows.length ?? 0;

  return needs === 0 ? 'Switchboard' : `(${needs}) Switchboard`;
}

/** The list's row of the selected work item, which carries its actions; null before a select or while the list lacks it. */
export function selectedRow(state: PageState): PageRow | null {
  const id = state.scope?.workItemId ?? null;

  return id === null ? null : (state.groups.flatMap((group) => group.rows).find((row) => row.workItemId === id) ?? null);
}

/** A link as the page opens it: an http or https URL, normalised by the URL parser; null for any other URL, so a row's link never runs a script or opens a file. */
export function tabUrl(url: string): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  return parsed.href;
}

/** The URL of a row's ticket (`ticket`) or of its link by index, or null when the row has no such link. */
export function rowLink(row: PageRow, which: string): string | null {
  if (which === 'ticket') {
    return row.url === '' ? null : row.url;
  }

  return /^\d+$/.test(which) ? (row.links[Number(which)]?.url ?? null) : null;
}

/** Older items a `history` page brought, before those shown. */
export function withEarlier(state: PageState, items: ItemView[], more: boolean): PageState {
  const known = new Set(state.items.map((item) => item.id));

  return { ...state, items: [...items.filter((item) => !known.has(item.id) && !notSent(item)), ...state.items], more };
}

/**
 * When the shown session's part of the work item ends: for an earlier session, when the next session of the work item started; Infinity for the
 * current one, or when the hub sends no start.
 */
export function sessionEnd(state: PageState): number {
  const scope = state.scope;
  const entry = scope?.earlier === true ? selectedEntry(state) : null;
  const shown = entry?.sessions?.find((one) => one.sessionId === scope?.sessionId);

  if (entry == null || shown === undefined) {
    return Infinity;
  }

  const starts = [...(entry.sessions ?? []).map((one) => one.startedAt), ...(entry.sessionStartedAt === undefined ? [] : [entry.sessionStartedAt])];

  return Math.min(Infinity, ...starts.filter((at) => at > shown.startedAt));
}

/** A row of the timeline: a message, a reply with the reply it rewrote, or an artifact where it was last written. */
export type Entry = { type: 'message'; item: Extract<ItemView, { type: 'message' }> } | { type: 'reply'; item: ReplyView; earlier: ReplyView | null } | { type: 'artifact'; artifact: ArtifactView };

/**
 * The timeline: withdrawn items and replies that are only a state left out, a rewrite in the place of the reply it rewrote, and each artifact
 * written since the oldest item shown, and before `until`, after the last item from no later than its write. An earlier session's timeline ends
 * where the next session starts (`sessionEnd`), so an artifact last written in a later session shows only there.
 */
export function timeline(items: ItemView[], artifacts: readonly ArtifactView[], until = Infinity): Entry[] {
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

    if (item.withdrawn || placed.has(item.id) || (item.kind === 'reply' && item.opening.trim() === '' && item.rewrittenBy === null)) {
      continue;
    }

    let shown = item;
    let earlier: ReplyView | null = null;

    for (let next = replies.get(shown.rewrittenBy ?? ''); next !== undefined && !placed.has(next.id); next = replies.get(shown.rewrittenBy ?? '')) {
      earlier = shown;
      shown = next;
      placed.add(next.id);
    }

    entries.push({ type: 'reply', item: shown, earlier });
  }

  const atOf = (entry: Entry): number => (entry.type === 'artifact' ? entry.artifact.updatedAt : entry.item.at);
  const oldest = entries[0] === undefined ? null : atOf(entries[0]);

  if (oldest !== null) {
    for (const artifact of [...artifacts].filter((one) => one.updatedAt >= oldest && one.updatedAt < until).sort((a, b) => a.updatedAt - b.updatedAt)) {
      let at = entries.length;

      while (at > 0 && atOf(entries[at - 1]!) > artifact.updatedAt) {
        at--;
      }

      entries.splice(at, 0, { type: 'artifact', artifact });
    }
  }

  return entries;
}

/**
 * Whether the session is in a turn: starting, or running other than with only background tasks left. The turn row shows all through it, also
 * after a reply mid-turn and in a turn a task notification started, which answers no message.
 */
export function inTurn(session: SessionView | null): boolean {
  // `background` absent: an older hub, so only awaitingReply shows the row.
  return session?.state === 'starting' || (session?.state === 'running' && session.background !== undefined && !session.background);
}

/** Whether the session is in a turn and no reply answers the operator's latest message or a later one, so the turn row shows even before a hook says the turn started. */
export function awaitingReply(items: readonly ItemView[], session: SessionView | null): boolean {
  if (session === null || (session.state !== 'starting' && session.state !== 'running' && session.state !== 'waiting')) {
    return false;
  }

  const lastIndex = <T,>(list: readonly T[], test: (one: T) => boolean): number => list.reduce((found, one, index) => (test(one) ? index : found), -1);
  const latest = lastIndex(items, (item) => item.type === 'message' && !item.withdrawn);
  const at = new Map(items.map((item, index) => [item.id, index]));
  const replied = items.some((item, index) => item.type === 'reply' && item.kind === 'reply' && !item.withdrawn && (item.answers === null ? index > latest : (at.get(item.answers) ?? -1) >= latest));

  return latest !== -1 && !replied;
}

/** The session state's codicon and its words. */
export function stateIcon(state: SessionView['state'] | null | undefined, waitingFor: SessionView['waitingFor'] = null, limit: SessionView['limit'] = null): { icon: string; text: string; tone: IconTone } {
  // A session waiting for a usage limit to reset (architecture.md § Rate limits).
  if (limit != null) {
    const at = new Date(limit.until);
    const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const when = at.toDateString() === new Date().toDateString() ? time : `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;

    return { icon: SESSION_ICONS.limited, text: `Rate limited · ${limit.retry ? 'retries' : 'resumes'} ${when}`, tone: SESSION_TONES.limited };
  }

  const kind = sessionIcon(state, waitingFor);

  return { icon: SESSION_ICONS[kind], text: SESSION_WORDS[kind], tone: SESSION_TONES[kind] };
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

/** An artifact type's codicon. */
export function artifactIcon(type: ArtifactView['type']): string {
  return { markdown: 'markdown', html: 'globe', image: 'file-media', audio: 'unmute', video: 'device-camera-video', file: 'file' }[type];
}

/** The selected conversation's dropdown entry, or null. */
export function selectedEntry(state: PageState): ConversationEntry | null {
  return state.scope?.conversations.find((entry) => entry.workItemId === state.scope?.workItemId) ?? null;
}

/** The typed messages of the session, oldest first, which Up and Down walk. */
export function sentTexts(items: readonly ItemView[]): string[] {
  return items.flatMap((item) => (item.type === 'message' && !item.withdrawn && item.origin !== 'terminal' ? [item.text] : []));
}

/** The mention of a path as Claude Code writes it: `@path`, or `@"path"` for one with a space or a colon or an odd end; null for one with a quote. */
export function mentionOf(path: string): string | null {
  if (path === '' || /["\r\n]/.test(path)) {
    return null;
  }

  return !/[\s:]/.test(path) && /\w$/.test(path.replace(/\/+$/, '')) ? `@${path}` : `@"${path}"`;
}

/** The `@` query that ends the text before the caret, with where it starts; null for none. */
export function mentionQuery(before: string): { start: number; query: string } | null {
  const match = /(^|\s)@("[^"\n]*|[^\s"]*)$/.exec(before);

  return match === null ? null : { start: match.index + match[1]!.length, query: match[2]!.replace(/^"/, '') };
}

/** The command query when the text before the caret is a slash and one word; null otherwise. */
export function commandQuery(before: string): string | null {
  return /^\/([^\s/]*)$/.exec(before)?.[1] ?? null;
}
