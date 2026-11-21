/**
 * The conversation API's types as the page reads them (architecture.md § Conversation API). The page shares only the protocol with the VS Code
 * view, so it declares the fields it reads here rather than importing the hub.
 */

import type { Mark } from '@switchboard/core/group';

export type SessionState = 'starting' | 'running' | 'waiting' | 'idle' | 'ended';

export interface SessionView {
  id: string;
  title: string;
  state: SessionState;
  waitingFor: 'question' | 'permission' | 'start-prompt' | null;
  launch: string | null;
  current: boolean;
  conversation: 'full' | 'read-only' | 'none';
  reason: string | null;
  persona: { id: string; name: string; pinned: boolean; tonePending: boolean } | null;
  /** The operator can pin a persona to the session, so the header shows a plain persona button while it has none. */
  canPin?: boolean;
  /** `codex` for a Codex app-server session, whose native questions and approvals come as `requests`. */
  provider?: string;
  requests?: NativeRequest[];
  /** While the session waits for a usage or rate limit to reset: when it resumes, and `retry` for the hub's next attempt. */
  limit?: { until: number; retry: boolean } | null;
}

/** A Codex app-server session's pending question or approval, answered with the `answer` command. */
export interface NativeRequest {
  id: string;
  title: string;
  kind: 'question' | 'permission' | 'unsupported';
  questions: Array<{ id: string; question: string; options: string[]; secret?: boolean }>;
  decisions: string[];
}

export interface ConversationEntry {
  workItemId: number;
  title: string;
  primary: boolean;
  sessionId: string | null;
  state: SessionState | null;
  conversation: SessionView['conversation'] | null;
  unread: number;
  provider?: string;
}

export interface ScopeView {
  kind: 'item' | 'folder' | 'page';
  key: string;
  folder: string | null;
  title: string;
  scopeGen: number;
  conversations: ConversationEntry[];
  workItemId: number | null;
  cwd: string | null;
  sessionId: string | null;
}

export interface MessageView {
  type: 'message';
  id: string;
  sessionId: string;
  workItemId: number | null;
  at: number;
  ord: number;
  provisional: boolean;
  withdrawn: boolean;
  origin: 'terminal' | 'typed' | 'voice';
  text: string;
  delivery: 'open' | 'sent' | 'uncertain' | 'not-sent' | null;
  error: string | null;
  /** A dictated message's pieces with their voice checks, a part sent while still being spoken, and the reply it spoke over (architecture.md § Dictation). */
  pieces?: Array<{ text: string; score: number | null; f0: number | null; dropped: boolean }>;
  partial?: boolean;
  interrupted?: { replyId: string; said: string; rest: string };
}

export interface ReplyView {
  type: 'reply';
  id: string;
  sessionId: string;
  at: number;
  ord: number;
  provisional: boolean;
  kind: 'reply' | 'aside' | 'note';
  answers: string | null;
  opening: string;
  rewrittenBy: string | null;
  withdrawn: boolean;
  unread: boolean;
  speak: string | null;
  tone: string | null;
  spoken: { state: string; atMs: number | null; saidChars: number | null };
}

export type ItemView = MessageView | ReplyView;

export interface StatusView {
  id: string;
  sessionId: string | null;
  at: number;
  markdown: string;
  fallback: boolean;
  unread: boolean;
}

export interface ArtifactView {
  path: string;
  owner: string;
  kind: string;
  title: string;
  ext: string;
  type: 'markdown' | 'html' | 'image' | 'audio' | 'video' | 'file';
  updatedAt: number;
}

/** The page's voice state, as a window's (`VoiceView` in the hub), which the shared voice controls draw. */
export interface VoiceView {
  enabled: boolean;
  here: boolean;
  mic?: string;
  speaking: string | null;
  speakReplies: boolean;
  error: string | null;
  recognizer?: 'gpu' | 'cpu' | null;
  halfDuplex?: string;
  fullDuplex?: string;
  roomHold?: boolean;
}

/** A row of the page's list: the dock row's three lines, mark and stripe (`PageRow` in the hub's `page.ts`). */
export interface PageRow {
  workItemId: number;
  title: string;
  /** Line 1: the priority dot's tooltip, or null, and the time at its end. */
  priority: string | null;
  time: { text: string; title: string } | null;
  ticket: string;
  sourceKind: string;
  /** The ticket's URL, for its pill's tooltip; empty for an ad-hoc ticket. */
  url: string;
  playbook: string;
  /** Line 2: the ticket's link pills, each with its codicon glyph or none, the Returned count, and the comment icon. */
  links: Array<{ label: string; url: string; kind: 'pr' | 'issue' | 'url'; badge: string; glyph: string | null; mentioned: boolean }>;
  returned: number;
  comment: { glyph: string; title: string } | null;
  /** Line 3: the mark, then the details, each coloured by its tone. */
  mark: { kind: Mark; glyph: string; title: string } | null;
  details: Array<{ text: string; title: string | null; tone: 'warning' | 'error' | null }>;
  stripe: 'error' | 'warning' | 'turn' | null;
  dim: boolean;
  /** A hosted conversation's host's name; null for other work items. */
  host: string | null;
  /** The dock's controls the page offers, in the dock's menu order; older hubs send none. */
  actions?: PageAction[];
  /** The control the dock shows as the row's button, when the page offers it. */
  main?: string | null;
  /** The labels of the drafted texts Copy offers. */
  pastes?: string[];
}

/** A prompt the session waits on in its terminal, as the hub read it from the screen (`ScreenPrompt` in the conversation package). */
export interface ScreenPrompt {
  id: string;
  lines: string[];
  options: Array<{ key: string; label: string; selected: boolean }>;
  next: boolean;
}

/** One of the dock's controls on the page (`PageAction` in the hub's `page.ts`), run with `row-action`. */
export interface PageAction {
  label: string;
  action: string;
  confirm: { question: string; detail: string; action: string } | null;
}

/** One group of the page's list: a dock group, in the dock's order, or `conversations`, the hosted conversations, last. */
export interface PageGroup {
  key: string;
  title: string;
  /** The group's codicon glyph, as the dock draws it. */
  glyph: string;
  empty: string | null;
  rows: PageRow[];
}
