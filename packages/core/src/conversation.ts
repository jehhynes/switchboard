/**
 * The version of the conversation rules a Code Mode session's prompt carries (architecture.md § Conversation). Raised whenever the rules change,
 * so the view can tell a session that started with older rules, or none, and show its replies whole.
 */
export const CONVERSATION_RULES_VERSION = 2;

/**
 * What became of a message typed from the view (architecture.md § Typing a message): `open` while it waits or is being typed, `sent` once the
 * transcript has it, `uncertain` when it was typed but the transcript does not show it, and `not-sent` when nothing was typed.
 */
export type MessageDelivery = 'open' | 'sent' | 'not-sent' | 'uncertain';

/** A message to a session: typed in its terminal and read from the transcript, or typed from the view (architecture.md § Conversation). */
export interface ConversationMessage {
  id: string;
  sessionId: string;
  /** Null only for a session with no work item. */
  workItemId: number | null;
  at: number;
  /** `terminal`: typed into the session's terminal and read from its transcript; `typed`: sent from the view's composer. */
  origin: 'terminal' | 'typed';
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
  /** Why a typed message was not sent or is uncertain. */
  error: string | null;
  /** The `send` command's `opId`, so a repeated command returns this message and types nothing again. */
  opId: string | null;
  /** When a typed message's paste was written; only a transcript entry near it confirms the message. */
  pastedAt: number | null;
}

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
export interface WindowBinding {
  file: string;
  workItemId: number | null;
  since: number;
  scopeGen: number;
}

/** Messages and replies kept per session; older ones are deleted. */
export const CONVERSATION_RETENTION = 500;
