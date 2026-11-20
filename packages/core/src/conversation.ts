/**
 * What became of a message typed from the view (architecture.md § Typing a message): `open` while it waits or is being typed, `sent` once the
 * transcript has it or Claude Code's input box no longer holds it, and `not-sent` when nothing was typed or Claude Code did not take it.
 */
export type MessageDelivery = 'open' | 'sent' | 'not-sent' | 'uncertain';

/** A message to a session: typed in its terminal and read from the transcript, or typed from the view (architecture.md § Conversation). */
export interface ConversationMessage {
  id: string;
  sessionId: string;
  /** Null only for a session with no work item. */
  workItemId: number | null;
  at: number;
  /**
   * `terminal`: typed into the session's terminal and read from its transcript; `typed`: sent from the view's composer; `voice`: holds dictated text,
   * however it was sent (architecture.md § Dictation).
   */
  origin: 'terminal' | 'typed' | 'voice';
  text: string;
  /** The transcript entry it came from, so a hub restart never imports it twice. */
  transcriptUuid: string | null;
  /** Sent while the session was busy and not yet received: the transcript's queue line has it, the line where Claude received it not yet. */
  provisional: boolean;
  /** A sent message that Claude received as something other than a message from the operator, or never received. */
  withdrawn: boolean;
  /** Its place in the conversation, which the store sets (`inTranscript`). */
  ord: number;
  /** A typed message's delivery; null for a terminal one. */
  delivery: MessageDelivery | null;
  /** Why a typed message was not sent. */
  error: string | null;
  /** The `send` command's `opId`, so a repeated command returns this message and types nothing again. */
  opId: string | null;
  /** When a typed message's paste was written; only a transcript entry near it confirms the message. */
  pastedAt: number | null;
  /** The launch of the session a typed message was sent to, so a message a stopped hub left being typed is settled only in that launch. */
  launch?: string | null;
  /** It was typed with `[spoken]`, so its reply may be spoken (architecture.md § Voice); false when left out. */
  spokenRequested?: boolean;
  /** A part of a dictated message still being spoken, typed with `[partial]` (architecture.md § Dictation); false when left out. */
  partial?: boolean;
  /** The recognised pieces of a dictated message, in order; empty when left out. */
  pieces?: Piece[];
}

/** One recognised segment of a dictated message, with its voice check results; the check comes in a later slice, so both are null for now. */
export interface Piece {
  text: string;
  score: number | null;
  f0: number | null;
  dropped: boolean;
}

/** What became of a reply's speech (architecture.md § Voice): `none` until it is offered, then queued, playing and how it ended. */
export const SPOKEN_STATES = ['none', 'queued', 'playing', 'played', 'interrupted', 'skipped', 'stopped-moved', 'failed'] as const;

export type SpokenState = (typeof SPOKEN_STATES)[number];

/** A reply of a session: its text, and how a later copy or a rewrite changed it. */
export interface ConversationReply {
  id: string;
  sessionId: string;
  workItemId: number | null;
  at: number;
  /** `note`: a line Switchboard adds, such as that the conversation continued from another session. */
  kind: 'reply' | 'aside' | 'note';
  /** The latest message before it. */
  answers: string | null;
  /** The reply's text, without its tags. */
  opening: string;
  /** The screen copy, until the transcript copy replaces it in place. */
  source: 'transcript' | 'screen';
  /** The reply this one rewrites (`[rewrite]`). */
  replaces: string | null;
  /** The reply that rewrote this one. */
  rewrittenBy: string | null;
  /** A screen copy that got no transcript copy, so it was never a reply. */
  withdrawn: boolean;
  transcriptUuid: string | null;
  /** Its place in the conversation, which the store sets. */
  ord: number;
  /** When the operator saw it in the Conversation view (architecture.md § Unread); null while unread. */
  seenAt: number | null;
  /** The text of its `[speak]` passage, the part read aloud, whose markers `opening` leaves out; null without one. */
  speak?: string | null;
  /** Its tone line, how the reply sounds when spoken, never spoken itself; null without one. */
  tone?: string | null;
  /** What became of its speech; `none` when left out. */
  spokenState?: SpokenState;
  /** The playback position, while it plays or where it stopped, in milliseconds. */
  spokenAtMs?: number | null;
  /** How many characters of the passage were played. */
  saidChars?: number | null;
}

/**
 * Whether a reply counts as unread until it is seen (architecture.md § Unread): one the timeline shows on its own, so not a withdrawn screen copy,
 * a reply a rewrite replaced, a reply that is only a status or a note Switchboard added.
 */
export function countsUnread(reply: Pick<ConversationReply, 'kind' | 'opening' | 'withdrawn' | 'rewrittenBy'>): boolean {
  return !reply.withdrawn && reply.rewrittenBy === null && reply.kind !== 'note' && reply.opening !== '';
}

/**
 * The order of a session's conversation (architecture.md § Conversation): items in the transcript in its line order, then those not in it yet,
 * a sent message or a reply's screen copy, in the order they were first seen. The store gives each item the next `ord` when it is added and
 * again when its transcript line is read, so the transcript's order is the order its lines were read in. A withdrawn item, which no view shows,
 * counts as in the transcript, so it never holds back the items after it.
 */
export function inTranscript(item: ({ type: 'message'; provisional: boolean } | { type: 'reply'; source: 'transcript' | 'screen' }) & { withdrawn: boolean }): boolean {
  return item.withdrawn || (item.type === 'message' ? !item.provisional : item.source === 'transcript');
}

/**
 * A status a session posted (architecture.md § Statuses): the part of a reply after its `[status]` line, read from the transcript only. One per
 * reply, so a later line of the same reply updates it in place; the newest is the session's status.
 */
export interface ConversationStatus {
  id: string;
  sessionId: string;
  workItemId: number | null;
  /** The reply it was written in. */
  replyId: string;
  at: number;
  markdown: string;
  /** When the operator saw it on the Conversation view's Status tab (architecture.md § Unread); null while unread. Only the latest status counts as unread. */
  seenAt: number | null;
}

/** Where the transcript reader of a session stopped, so a hub restart resumes there. */
export interface TranscriptCheckpoint {
  sessionId: string;
  transcript: string;
  offset: number;
  lastUuid: string | null;
  /** When the last entry read was written, epoch milliseconds; a new transcript with entries older than it holds copied history. */
  lastAt: number | null;
}

/** A window's work item (architecture.md § Window scope), kept by its workspace file so a reload keeps its scope generation. */
/**
 * A window's binding (architecture.md § Window scope), kept by its workspace file: its primary work item, the ticket and title it showed, so they
 * outlive a deleted primary, its selected conversation and that conversation's current session, and the generation every command echoes.
 */
export interface WindowBinding {
  file: string;
  workItemId: number | null;
  since: number;
  scopeGen: number;
  selectedWorkItemId?: number | null;
  selectedSessionId?: string | null;
  ticketId?: number | null;
  title?: string | null;
}

/**
 * Whether a host link or a window binding names a folder window's canonical folder rather than an item window's workspace file
 * (architecture.md § Window scope): item windows' files always end in `.code-workspace`.
 */
export function isFolderHost(host: string): boolean {
  return !/\.code-workspace$/i.test(host.replace(/[\\/]+$/, ''));
}

/**
 * How a window binding or a host link is compared: `windowFileKey`, except that a folder host keeps its case where the file system does, off
 * Windows and macOS, so two Linux folders that differ only in case stay two hosts (architecture.md § Window scope).
 */
export function hostKey(host: string): string {
  const platform = (globalThis as { process?: { platform?: string } }).process?.platform;

  // A POSIX folder name may hold a backslash, so only a trailing separator is dropped there.
  return isFolderHost(host) && platform !== 'win32' && platform !== 'darwin' ? host.replace(/(.)\/+$/, '$1') : windowFileKey(host);
}

/** How a workspace file is kept as a window binding and a host link: forward slashes, no trailing slash, lower case, so spellings of one file match. */
export function windowFileKey(file: string): string {
  return file.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

/** Messages and replies kept per session, and statuses, counted apart; older ones are deleted. */
export const CONVERSATION_RETENTION = 500;
