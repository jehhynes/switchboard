/**
 * The wire types of the conversation API and the page's list (architecture.md § Conversation API, § Web page): the fields the web page reads. The
 * page imports them, since it cannot import the hub, which bundles the page; the hub checks that its own views still carry them
 * (`packages/hub/src/protocol.ts`), so a change on either side that breaks the other fails the build.
 */

import type { BackgroundCounts, Mark } from '@switchboard/core/group';
import type { ContextView } from '@switchboard/conversation/contextMeter';

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
  /** The session's context size, null while the hub cannot read it (architecture.md § Context meter). */
  context?: ContextView | null;
  /**
   * While the session is `running` with its turn ended and background tasks it started still run, so it is in no turn: how many of each kind
   * (architecture.md § Conversation view); null otherwise. Absent from an older hub.
   */
  background?: BackgroundCounts | null;
}

/** A Codex app-server session's pending question or approval, answered with the `answer` command. */
export interface NativeRequest {
  id: string;
  title: string;
  kind: 'question' | 'permission' | 'unsupported';
  questions: Array<{ id: string; question: string; options: string[]; secret?: boolean }>;
  decisions: string[];
}

/** An earlier session of a conversation, as the web page's dropdown lists it. */
export interface SessionEntry {
  sessionId: string;
  title: string;
  state: SessionState;
  startedAt: number;
  provider?: string;
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
  /** On the web page, the work item's earlier sessions, newest first; left out with none. */
  sessions?: SessionEntry[];
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
  /** The page shows `sessionId`, an earlier session of its work item, read-only; left out for the current session. */
  earlier?: true;
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
  delivery: 'open' | 'sent' | 'uncertain' | 'not-sent' | 'refused' | null;
  error: string | null;
  /** A dictated message's pieces with their voice checks, a part sent while still being spoken, and the reply it spoke over (architecture.md § Dictation). */
  pieces?: Array<{ text: string; score: number | null; f0: number | null; dropped: boolean }>;
  partial?: boolean;
  interrupted?: { replyId: string; said: string; rest: string };
  /** The questions it answered or dismissed, as the hub stored them (PRD R103); null or left out for one read by its text. */
  answers?: Array<{ replyId: string; slug: string; letters: string[]; other: string; via: 'card' | 'typed' | 'voice'; dismissed?: boolean }> | null;
}

/** A card's draft, which the hub keeps for every window, page and the voice (PRD R103): its current question by slug, and the picks so far. */
export interface CardDraftView {
  step: string | null;
  picks: Record<string, { letters: string[]; other: string | null }>;
}

/** A session's questions as the hub sends them (`questions` event, `hello.questions`). */
export interface QuestionsView {
  sessionId: string;
  /** The cutover: replies before it keep the rules from before question ids. */
  since: number;
  /** How many questions are open across the conversation. */
  open: number;
  /** The card of the oldest open question, which the chip goes to; null with none. */
  oldest: string | null;
  /** Each card's draft by card key. */
  drafts: Record<string, CardDraftView>;
  /** The questions the operator dismissed, by key, with when and the newest conversation item then. */
  dismissed: Array<{ key: string; at: number; after: string | null }>;
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
  mic: string;
  speaking: string | null;
  speakReplies: boolean;
  error: string | null;
  recognizer: 'gpu' | 'cpu' | null;
  halfDuplex?: string;
  fullDuplex?: string;
  roomHold?: boolean;
  deviceOff?: boolean;
}

/** A row of the page's list: the dock row's three lines, mark and stripe (`PageRow` in the hub's `page.ts`). */
export interface PageRow {
  /** The work item's ID, or null on a pool ticket's row, which has no conversation and carries its ticket's ID instead. */
  workItemId: number | null;
  ticketId: number | null;
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
  /** The dock's controls the page offers, in the dock's menu order. */
  actions: PageAction[];
  /** The control the dock shows as the row's button, when the page offers it. */
  main: string | null;
  /** The labels of the drafted texts Copy offers. */
  pastes: string[];
  /** What the list's search matches: the title, key, linked pull requests and issues, playbook, group and branch. */
  search: string;
  /** What the row opens in VS Code through the hub, run with `row-command`: Open in VS Code and Open report, each with its codicon's name. */
  opens: Array<{ label: string; icon: string }>;
  /** A Done row's date band, such as `Today`, or an older Done row's month, such as `October 2026`; null in the other groups. */
  band: string | null;
  /** Line 1's mic mark before the time on the voice target's row: its codicon glyph and tooltip; null on the others. */
  voice: { glyph: string; title: string } | null;
  /** The ticket whose History the row's menu opens: its ID and key; null when the dock offers none. */
  history: { ticketId: number; key: string } | null;
}

/** A History filter chip's category (`CATEGORIES` in the hub's `history.ts`). */
export interface HistoryCategory {
  key: string;
  label: string;
  icon: string;
}

/** Something a History entry names: `open` is what the VS Code History tab runs, of which the page opens only an http or https `openUrl`. */
export interface HistoryLink {
  label: string;
  icon: string;
  title: string;
  open: { type: string; [key: string]: unknown };
}

/** One History entry (`Entry` in the hub's `history.ts`). */
export interface HistoryEntry {
  key: string;
  at: number;
  category: string;
  icon: string;
  text: string;
  lines: string[];
  detail: string | null;
  shortId: string | null;
  links: HistoryLink[];
  tone: 'error' | 'warning' | 'success' | 'accent' | null;
  reconstructed: boolean;
  refused: string | null;
  stateChange: boolean;
}

/** One History section: a work item's, or the ticket's (`Section` in the hub's `history.ts`). */
export interface HistorySection {
  key: string;
  workItemId: number | null;
  title: string;
  status: string;
  tone: HistoryEntry['tone'];
  facts: string[];
  prompt: string | null;
  entries: HistoryEntry[];
}

/** A ticket's History as the hub builds it (`HistoryView` in the hub's `history.ts`). */
export interface HistoryView {
  key: string;
  title: string;
  url: string;
  facts: Array<{ label: string; value: string }>;
  links: HistoryLink[];
  reconstructed: boolean;
  recordedSince: number | null;
  sections: HistorySection[];
}

/** One header icon: the configured sources of one kind (`DockSourceGroup` in the hub's `dock.ts`). */
export interface SourceGroup {
  kind: string;
  /** Whether any source of the kind is polled. */
  enabled: boolean;
  /** The icon's tooltip: each source and whether it is polled, then what a click does. */
  title: string;
  sources: Array<{ name: string; enabled: boolean }>;
}

/** What the list's header shows besides the list (`PageHeader` in the hub's `page.ts`). */
export interface PageHeader {
  /** The dock's notes above its groups: settings, playbook, hook, source and voice errors, then what an unconfigured home lacks. */
  notes: string[];
  /** "N held sessions without a work item", while a held session has none. */
  heldNote?: string;
  /** The neutral note while no device has the voice because the phone was lost; absent otherwise. */
  voiceNote?: string;
  sources: SourceGroup[];
  /** The repos an ad-hoc prompt can run in, the first being the default. */
  repoRoots: string[];
  /** The schedules the New session form can run now. */
  schedules: Array<{ name: string; playbook: string }>;
  /** The notice while the terminal holder is from an older build or restarting, and what Restart and resume asks; `confirm` is null while it runs. */
  holderNotice?: { text: string; confirm: { question: string; detail: string; action: string } | null };
  /** The last holder restart's result, which the page hides once dismissed, by `at`. */
  holderResult?: { at: number; text: string; failed: boolean };
  /** Where the voice is while it is not on this computer: a paired phone, or none after the phone left; absent otherwise. */
  voiceDevice?: 'phone' | 'none';
}

/** A prompt the session waits on in its terminal, as the hub read it from the screen (`ScreenPrompt` in the conversation package). */
export interface ScreenPrompt {
  id: string;
  lines: string[];
  options: Array<{ key: string; label: string; selected: boolean }>;
  next: boolean;
}

/** One of the dock's controls on the page (`PageAction` in the hub's `page.ts`), run with `row-action` by its label. */
export interface PageAction {
  label: string;
  action: string;
  /** Its codicon's name. */
  icon: string;
  /** Its group in the dock's row menu, which draws a separator between groups. */
  group: 'main' | 'work' | 'state' | 'notes' | 'order' | 'asking';
  confirm: { question: string; detail: string; action: string } | null;
  /** The text it asks for first, as the dock's input dialog: the box's first text and a choice beside it, such as the playbook; null for none. */
  input: { question: string; detail: string; action: string; text: string | null; choice: { label: string; value: string; values: string[] } | null } | null;
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

/** A change row's status letter, as VS Code's Source Control shows it: added, modified, deleted, renamed, untracked, or a conflict (PRD R118). */
export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'U' | 'C';
export type ChangeStage = 'committed' | 'staged' | 'working' | 'untracked';

/** A row of the `changes` answer (architecture.md § Web page, Changes). */
export interface ChangeRow {
  path: string;
  from?: string;
  status: ChangeStatus;
  stages: ChangeStage[];
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** The content hash a viewed tick is kept at, and whether the file is ticked viewed at it. */
  hash: string;
  viewed?: boolean;
}

/** A commit since the merge base, for the Changes tab's scope menu: its first parent, subject and commit time in seconds. */
export interface CommitInfo {
  sha: string;
  parent: string | null;
  subject: string;
  time: number;
}

/** The `changes` answer. */
export interface ChangesList {
  scopeGen: number;
  /** The merge base, or null when there is none and `base` means HEAD. */
  base: string | null;
  head: string;
  /** The range the rows compare, as asked for with `from` and `to`: `base`, `HEAD` or a commit's ID, to `worktree`, `HEAD` or a commit's ID. */
  from: string;
  to: string;
  /** The commits since the base, newest first, the first 200; `commitsMore` when there are more. */
  commits: CommitInfo[];
  commitsMore: boolean;
  rows: ChangeRow[];
  stages: Record<ChangeStage, number>;
  shown: number;
  total: number;
}

/** The `diff` answer: git's patch from the base to disk and both whole sides, null where the file has none or the hub left it out. */
export interface DiffData {
  path: string;
  from?: string;
  status: string;
  patch: string | null;
  old: string | null;
  new: string | null;
  binary: boolean;
  /** Why the sides or the patch were left out: `sides` when only the patch came, `patch` when nothing did. */
  tooLarge: 'sides' | 'patch' | null;
  /** True for the patch alone, asked for with `sides=0`: the sides are read with a full `diff` when an unchanged region is expanded. */
  partial?: true;
}

/** The `file` answer: a file read whole, on disk or at the base. */
export interface FileData {
  path: string;
  side: 'disk' | 'base';
  contents: string | null;
  binary: boolean;
  tooLarge: boolean;
}
