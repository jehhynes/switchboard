/**
 * The conversation API's types as the page reads them (architecture.md § Conversation API). The page shares only the protocol with the VS Code
 * view, so it declares the fields it reads here rather than importing the hub.
 */

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
  /** `codex` for a Codex app-server session, whose native questions and approvals come as `requests`. */
  provider?: string;
  requests?: NativeRequest[];
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

export interface VoiceView {
  enabled: boolean;
  here: boolean;
  speaking: string | null;
  speakReplies: boolean;
  error: string | null;
}

/** One group of the page's list: a work item with the conversations its window hosts, or the conversations a folder or a window hosts. */
export interface PageGroup {
  kind: 'item' | 'folder' | 'window';
  title: string;
  conversations: Array<{ workItemId: number; title: string; state: SessionState | null; unread: number }>;
}
