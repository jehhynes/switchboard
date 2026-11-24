import { renderMicButton, renderVoiceControls } from '@switchboard/conversation/voiceControls';
import { fullTime, metaLine, stamped, stampTime, toneMark, voiceMark } from '@switchboard/conversation/messageMeta';
import { artifactIcon, awaitingReply, selectedEntry, selectedRow, stateIcon, timeline } from './model.js';
import type { PageState } from './model.js';
import { copyButton, escape, renderInline, renderMarkdown } from './markdown.js';
import { questionSegments, stripQuestionMarkup } from '@switchboard/conversation/questions';
import type { CardDraft as SharedDraft } from '@switchboard/conversation/questions';
import type { ArtifactView, MessageView, NativeRequest, PageAction, PageGroup, PageRow, ReplyView, ScreenPrompt, StatusView, VoiceView } from '@switchboard/protocol';
import type { SnoozeChoice } from '@switchboard/core/snooze';
import type { DotView } from './connectionView.js';

/** `diff` shows the open file's diff tab (`changes.tsx`), which has no fixed tab of its own. */
export type Tab = 'conversation' | 'status' | 'artifacts' | 'console' | 'browser' | 'history' | 'diff' | 'file';
export const TABS: Array<{ tab: Tab; label: string; icon: string }> = [
  { tab: 'conversation', label: 'Conversation', icon: 'comment-discussion' },
  { tab: 'status', label: 'Status', icon: 'pulse' },
  { tab: 'artifacts', label: 'Artifacts', icon: 'files' },
  { tab: 'console', label: 'Console', icon: 'terminal' },
  { tab: 'browser', label: 'Browser', icon: 'globe' },
  { tab: 'history', label: 'History', icon: 'history' },
];

/** A fixed tab's codicon, by its tab. */
export function tabIcon(tab: Tab | SideTab): string {
  return TABS.find((one) => one.tab === tab)?.icon ?? 'file';
}

/** What the column right of the conversation shows on a wide screen. */
export type SideTab = 'status' | 'artifacts' | 'console' | 'browser' | 'history' | 'diff' | 'file';
export const SIDE_TABS: readonly SideTab[] = ['status', 'artifacts', 'console', 'browser', 'history'];

/** The most artifact tabs a strip shows, whatever its width (PRD R109): the rest are in the Artifacts menu at its end. */
export const ARTIFACT_TABS_MAX = 5;
/**
 * The most width an artifact tab takes, as page.css draws it with its sides' padding `pad` (`--sb-tab-pad`): with its label, its 16 px icon, the
 * label at `labelMax` (`--sb-tab-label-max`) and its close mark, each 6 px apart, the mark 6 px from its end, and its 1 px border; as an icon
 * alone, its icon in its padding and its border.
 */
export function artifactTabWidth(pad: number, labelMax: number, icons: boolean): number {
  return icons ? 2 * pad + 17 : pad + 55 + labelMax;
}

/** An artifact tab's most width with its label at page.css's padding and label cap, and the room the Artifacts menu's button takes. */
export const ARTIFACT_TAB_WIDTH = artifactTabWidth(14, 100, false);
export const ARTIFACT_MENU_WIDTH = 132;

/**
 * How many artifact tabs fit a strip `stripWidth` pixels wide whose other tabs take `fixedWidth`: all of them when they fit without the menu,
 * else as many as fit beside the menu, `menuWidth` wide as drawn, none when even one does not, and at most {@link ARTIFACT_TABS_MAX}. An
 * unmeasured strip, 0 wide, shows the most.
 */
export function artifactTabsFit(stripWidth: number, fixedWidth: number, count: number, menuWidth = ARTIFACT_MENU_WIDTH, tabWidth = ARTIFACT_TAB_WIDTH): number {
  if (stripWidth <= 0) {
    return Math.min(count, ARTIFACT_TABS_MAX);
  }

  if (count <= ARTIFACT_TABS_MAX && fixedWidth + count * tabWidth <= stripWidth) {
    return count;
  }

  return Math.max(0, Math.min(ARTIFACT_TABS_MAX, count, Math.floor((stripWidth - fixedWidth - menuWidth) / tabWidth)));
}

/**
 * The artifacts whose tabs are closed (architecture.md § Web page): each closed at its version, until a newer version opens its tab again.
 */
export function closedArtifacts(artifacts: readonly ArtifactView[], closed: ReadonlyArray<{ path: string; updatedAt: number }>): Set<string> {
  const at = new Map(closed.map((one) => [one.path, one.updatedAt]));

  return new Set(artifacts.filter((artifact) => at.has(artifact.path) && artifact.updatedAt <= at.get(artifact.path)!).map((artifact) => artifact.path));
}

/**
 * Which artifacts this device has opened, kept in local storage under {@link ARTIFACTS_SEEN} (architecture.md § Web page): the paths opened, by
 * work item. A work item's artifacts the device first saw count as opened, so the dot marks only artifacts written since, by the hub's own file
 * times, whatever the device's clock says.
 */
export type ArtifactsSeen = Record<string, string[]>;

export const ARTIFACTS_SEEN = 'switchboard.artifactsSeen';

/** The kept {@link ArtifactsSeen}, its readable entries, or none when nothing readable was kept. */
export function parseArtifactsSeen(text: string | null): ArtifactsSeen {
  try {
    const read: unknown = JSON.parse(text ?? 'null');

    if (typeof read === 'object' && read !== null && !Array.isArray(read)) {
      return Object.fromEntries(Object.entries(read).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((path) => typeof path === 'string')));
    }
  } catch {
    // None below.
  }

  return {};
}

/** The work item's artifacts this device has not opened; none for a work item it has not seen yet. */
export function unreadArtifacts(artifacts: readonly ArtifactView[], workItemId: number | null, seen: ArtifactsSeen): Set<string> {
  const opened = workItemId === null ? undefined : seen[String(workItemId)];

  return opened === undefined ? new Set() : new Set(artifacts.filter((artifact) => !opened.includes(artifact.path)).map((artifact) => artifact.path));
}

/** `seen` with the paths opened for the work item, an empty list recording it as seen, or null when nothing changes. */
export function openArtifactsSeen(seen: ArtifactsSeen, workItemId: number, paths: readonly string[]): ArtifactsSeen | null {
  const opened = seen[String(workItemId)];
  const added = paths.filter((path) => !(opened ?? []).includes(path));

  return opened !== undefined && added.length === 0 ? null : { ...seen, [String(workItemId)]: [...(opened ?? []), ...added] };
}

/**
 * The artifacts newest first, and those with a tab: those not closed, the first `fit`, with the open one in place of the last of them when it is not among them, so
 * the open artifact always has its tab.
 */
export function artifactBar(artifacts: readonly ArtifactView[], open: string | null, fit: number, closed: ReadonlySet<string> = new Set()): { ordered: ArtifactView[]; tabs: ArtifactView[] } {
  const ordered = [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt);
  const tabs = ordered.filter((artifact) => !closed.has(artifact.path)).slice(0, fit);
  const shown = open === null ? undefined : ordered.find((artifact) => artifact.path === open);

  if (shown !== undefined && !tabs.includes(shown) && tabs.length > 0) {
    tabs[tabs.length - 1] = shown;
  }

  return { ordered, tabs };
}

/**
 * Why the Console tab shows no console for the session (architecture.md § Web page), or null when the terminal holder may hold it: a session the
 * page cannot talk to runs outside the holder. A Code Mode session and a Codex app-server session have one; the hub says why when it cannot open.
 */
/** Whether the Console tab has a console to show: an active session, not ended, that the terminal holder may hold. */
export function hasConsole(session: PageState['session']): boolean {
  return session !== null && session.state !== 'ended' && consoleNote(session) === null;
}

export function consoleNote(session: PageState['session']): string | null {
  if (session === null) {
    return 'No session has started yet.';
  }

  return session.conversation === 'none' ? "This session does not run in Switchboard's terminal holder, so it has no console here." : null;
}

/**
 * What the page keeps of a question card beside the hub's draft (PRD R103): a draft it changed whose `card-draft` the hub has not echoed yet, a
 * Send under way, why the last was refused, and whether its header menu is open.
 */
export interface CardDraft {
  /** The draft as this page changed it, shown until the hub's `questions` event follows; null once it has. */
  local: SharedDraft | null;
  /** `card-draft` posts not yet answered. */
  pending: number;
  /** Other text typed that no `card-draft` has carried yet, so a `questions` event leaves `local` alone until one does. */
  unsent?: boolean;
  /** The draft this page sent last, as `sameDraft` writes it, until a `questions` event carries it. */
  awaiting?: string | undefined;
  /** How many drafts this page has sent, so only the newest one's answer counts. */
  gen?: number;
  sending: boolean;
  /** The message the answer became, once the hub took it. */
  sentId?: string | null;
  error: string | null;
  menuOpen: boolean;
}

/** What the page keeps beside the hub's state: the tab shown, open folds, the open dropdown, the cards and the open artifact. */
export interface View {
  tab: Tab;
  open: Set<string>;
  picker: boolean;
  cards: Map<string, CardDraft>;
  artifact: string | null;
  /** What the operator picked or typed for a Codex request's questions, by `<request ID>:<question ID>`. */
  requestValues: Map<string, string>;
  /** The persona dialog while open: the roster, null while it loads, or why it could not. */
  personas: { items: Array<{ id: string; name: string; voice?: string; style?: string; personality?: string }> | null; error: string | null } | null;
  /** The list's collapsed groups, by key. */
  collapsed: Set<string>;
  /** The Done bands the operator opened or closed, by `<group>:<band>`; the rest follow `OPEN_BANDS`. Kept until the page reloads. */
  bands: Map<string, boolean>;
  /** Whether a narrow screen shows the list rather than the conversation: after Back, or before a work item is opened. */
  list: boolean;
  /** The work items' drawer, outside the phone's layout until the list column fits: shown by its button or a key ('open'), by a pointer resting on its sliver ('hover'), or hidden (null). Never kept. */
  drawer: 'open' | 'hover' | null;
  /** Whether the header's actions menu is open, and in it the Open link submenu. */
  actions: boolean;
  linkMenu: boolean;
  /** Whether the actions menu's Copy submenu, for a row with several drafts, is open. */
  copyMenu: boolean;
  /** The pool ticket row whose menu is open in the list, by its key, or null. */
  rowMenu: string | null;
  /** The sheet over the page that asks before an action, picks a snooze, or shows a draft to copy by hand. */
  sheet: Sheet | null;
  /** A row action is running, so its controls wait. */
  acting: boolean;
  /** What the Status and Artifacts column shows on a wide screen. */
  side: SideTab;
  /** Whether the view options menu is open. */
  viewMenu: boolean;
  /** Whether each message's line shows its time and its optional marks (dictated, tone), kept in local storage. */
  details: boolean;
  /**
   * A paired device's own Collapse details, kept in its local storage, since only this computer's page may change settings.json; null follows
   * `voice.briefReplies`, as this computer's page always does.
   */
  briefReplies: boolean | null;
  /**
   * New conversation…'s draft in the shown work item (architecture.md § Web page), which starts nothing until its first message is sent; null
   * while the page shows a session.
   */
  newDraft: NewDraft | null;
  /** The prompt the session waits on in its terminal, as last read, for the session it was read for; a key being sent waits. */
  prompt: { sessionId: string; prompt: ScreenPrompt | null; sending: boolean } | null;
  /** How many artifact tabs the shown strip fits, measured after each draw, and whether its Artifacts menu is open. */
  artifactFit: number;
  artifactMenu: boolean;
  /** The connection's dot in the conversation's head (connectionView.tsx); none before the page first connected. */
  connection?: DotView | null;
}

/**
 * New conversation…'s draft: the work item its session will start in, the provider chosen, the providers installed (null while they load), the
 * opId its send keeps across retries so the hub starts one session, and whether that send waits for its answer.
 */
export interface NewDraft {
  workItemId: number;
  provider: string;
  installed: string[] | null;
  opId: string;
  sending: boolean;
}

/** A sheet: Delete's or Stop session's question, Snooze…'s choices, a control's text (and choice) as an input dialog asks for it, or a drafted text the clipboard refused. */
export type Sheet =
  | { kind: 'input'; row: string; label: string; input: NonNullable<PageAction['input']>; text: string; picked: string }
  | { kind: 'confirm'; row: string; action: PageAction }
  | { kind: 'snooze'; row: string; label: string; title: string; choices: SnoozeChoice[]; picked: string; date: string; comment: string }
  | { kind: 'text'; title: string; text: string };

export const newView = (): View => ({ tab: 'conversation', open: new Set(), picker: false, cards: new Map(), artifact: null, requestValues: new Map(), personas: null, collapsed: new Set(COLLAPSED_GROUPS), bands: new Map(), list: false, drawer: null, actions: false, linkMenu: false, copyMenu: false, rowMenu: null, sheet: null, acting: false, prompt: null, newDraft: null, side: 'status', viewMenu: false, details: false, briefReplies: null, artifactFit: ARTIFACT_TABS_MAX, artifactMenu: false });

/** The longest menu label for a link, carried over from the retired dock; a longer one is cut with an ellipsis and shown whole in its tooltip. */
export const LINK_LABEL_MAX = 48;

/** A row's key in the list: `item:<work item ID>`, or a pool ticket's `ticket:<ticket ID>`. */
export function rowKey(row: Pick<PageRow, 'workItemId' | 'ticketId'>): string {
  return row.workItemId !== null ? `item:${row.workItemId}` : `ticket:${row.ticketId ?? ''}`;
}

/** The first day a snooze date can wake on: the day of the earliest timed choice, as `yyyy-mm-dd`; null with none. */
export function firstSnoozeDay(choices: readonly SnoozeChoice[]): string | null {
  const times = choices.flatMap((choice) => (choice.until === null ? [] : [choice.until]));

  if (times.length === 0) {
    return null;
  }

  const day = new Date(Math.min(...times));

  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

/** A snooze date's wake time: that day at the time of day the timed choices wake at, which is when a day starts (PRD R49). */
export function snoozeDateUntil(date: string, choices: readonly SnoozeChoice[]): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timed = choices.find((choice) => choice.until !== null);

  if (match === null || timed === undefined) {
    return null;
  }

  const wake = new Date(timed.until!);

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), wake.getHours(), wake.getMinutes()).getTime();
}

/** Whether an input sheet can go ahead: with a text, or with a choice changed from the one chosen at first. */
export function inputReady(sheet: Extract<Sheet, { kind: 'input' }>): boolean {
  return sheet.text.trim() !== '' || (sheet.input.choice !== null && sheet.picked !== sheet.input.choice.value);
}


const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const DAY_WITH_YEAR = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** A day as its divider names it: "Today", "Yesterday", the weekday and date this year, or the full date with the year. */
export function dayLabel(at: number, now: number): string {
  const midnight = (time: number): number => new Date(new Date(time).getFullYear(), new Date(time).getMonth(), new Date(time).getDate()).getTime();
  // Rounded, since a day with a daylight saving change is 23 or 25 hours long.
  const days = Math.round((midnight(now) - midnight(at)) / 86_400_000);

  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : (new Date(at).getFullYear() === new Date(now).getFullYear() ? DAY : DAY_WITH_YEAR).format(at);
}

/** How long ago, in the largest whole unit: "just now", "4 min ago", "2 h ago", "3 d ago". */
export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);

  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
}

/** The groups the list shows collapsed until the operator opens them. */
export const COLLAPSED_GROUPS: readonly string[] = ['done', 'snoozed'];
/** Where the page keeps the operator's open or closed choice per group. */
export const GROUPS_KEY = 'switchboard.groups';

/** The collapsed groups: `COLLAPSED_GROUPS`, then each choice kept under `GROUPS_KEY`, `{<group>: open}`; a kept value that does not read is ignored. */
export function collapsedGroups(kept: string | null): Set<string> {
  const collapsed = new Set(COLLAPSED_GROUPS);
  let choices: unknown = null;

  try {
    choices = JSON.parse(kept ?? 'null');
  } catch {
    choices = null;
  }

  if (choices !== null && typeof choices === 'object' && !Array.isArray(choices)) {
    for (const [group, open] of Object.entries(choices)) {
      if (open === true) {
        collapsed.delete(group);
      } else if (open === false) {
        collapsed.add(group);
      }
    }
  }

  return collapsed;
}

/** The Done bands open until the operator closes them: Today and Yesterday; the older bands start closed. */
export const OPEN_BANDS: readonly string[] = ['done:Today', 'done:Yesterday'];

/** Whether a band shows its rows: the operator's choice this page load, else `OPEN_BANDS`. */
export function bandOpen(key: string, bands: ReadonlyMap<string, boolean>): boolean {
  return bands.get(key) ?? OPEN_BANDS.includes(key);
}

/**
 * A reply's or a status's Markdown when its card draws its questions: questions that end it are left out; questions with text after them stay
 * in place, folded into one line, "2 questions — answer below", that opens them. `ends` is false for text a spoken passage follows, whose questions
 * all fold.
 */
export function withoutQuestions(source: string, key: string, open: ReadonlySet<string>, ends = true): string {
  const markdown = stripQuestionMarkup(source);
  const segments = questionSegments(markdown);

  if (segments === null) {
    return renderMarkdown(markdown);
  }

  // The last run of questions, when only blank lines follow it, ends the message as the rules ask, and the card alone shows it.
  const last = segments.reduce((found, segment, index) => (segment.questions > 0 ? index : found), -1);
  const ending = ends && segments.slice(last + 1).every((segment) => segment.text.trim() === '');

  return segments
    .map((segment, index) => {
      if (segment.questions === 0) {
        return segment.text.trim() === '' ? '' : renderMarkdown(segment.text);
      }

      if (ending && index === last) {
        return '';
      }

      const fold = `questions:${key}:${index}`;

      return `<details class="fold questions-fold" data-fold="${escape(fold)}"${open.has(fold) ? ' open' : ''}><summary>${segment.questions} question${segment.questions === 1 ? '' : 's'} — answer below</summary><div class="was">${renderMarkdown(segment.text)}</div></details>`;
    })
    .join('');
}

/** A message's mark for an uncertain delivery, for its meta line (`metaLine` takes HTML); empty otherwise. */
export function deliveryMark(item: MessageView): string {
  return item.delivery === 'uncertain' ? `<span class="delivery uncertain" title="${escape(item.error ?? '')}">uncertain</span>` : '';
}

/** How the shared `replyBody` draws a reply's text: `markdown` for the text, the page's own escaping for a passage heard in part. */
export function replyRender(markdown: (text: string, last: boolean) => string): { markdown: (text: string, last: boolean) => string; escape: (text: string) => string } {
  return { markdown, escape };
}

/** The URL of an artifact's file for the page key, which the sandboxed frame's own relative files also resolve against. */
export function artifactUrl(key: string, path: string): string {
  return `/v1/conversation/artifact/${encodeURIComponent(key)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Whether an artifact opens in the sandboxed frame: a page or an SVG, whose scripts must reach neither the page nor the network. */
/** File extensions of text an artifact's tab shows as it is, preformatted: plain text, data and code. */
export const TEXT_ARTIFACTS: ReadonlySet<string> = new Set(['txt', 'text', 'log', 'json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'xml', 'diff', 'patch', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'py', 'cs', 'sh', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'go', 'rs', 'java', 'rb', 'php', 'c', 'h', 'cpp', 'hpp']);
/** An artifact's file extension, lower case, without its dot. */
const extOf = (artifact: ArtifactView): string => (artifact.ext || artifact.path.slice(artifact.path.lastIndexOf('.') + 1)).toLowerCase().replace(/^\./, '');
/**
 * How an artifact's tab shows it (architecture.md § Web page): an HTML page or an SVG framed, Markdown drawn, text, data and code preformatted, a
 * PDF in the browser's viewer, pictures, audio and video played; only another kind of file is a download.
 */
export function artifactShow(artifact: ArtifactView): 'frame' | 'markdown' | 'text' | 'pdf' | 'image' | 'audio' | 'video' | 'download' {
  const ext = extOf(artifact);

  if (framed(artifact)) {
    return 'frame';
  }

  if (artifact.type !== 'file') {
    return artifact.type === 'html' ? 'frame' : artifact.type;
  }

  return ext === 'pdf' ? 'pdf' : TEXT_ARTIFACTS.has(ext) ? 'text' : 'download';
}

/** A text artifact as the tab shows it: escaped and preformatted, JSON indented when it parses, cut at `TEXT_ARTIFACT_MAX` characters with a note. */
export const TEXT_ARTIFACT_MAX = 2_000_000;
export function textArtifactHtml(text: string, ext: string): string {
  let shown = text;

  if (ext === 'json') {
    try {
      shown = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not JSON after all: shown as it is.
    }
  }

  const cut = shown.length > TEXT_ARTIFACT_MAX;
  const esc = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<pre class="artifact-text"><code>${esc(cut ? shown.slice(0, TEXT_ARTIFACT_MAX) : shown)}</code></pre>${cut ? '<p class="empty">Cut here: open it in a new window to see the rest.</p>' : ''}`;
}

export function framed(artifact: ArtifactView): boolean {
  return artifact.type === 'html' || artifact.ext.toLowerCase() === 'svg' || artifact.ext.toLowerCase() === '.svg';
}

/** Front matter dropped from an artifact's Markdown, as the VS Code preview does not show it either. */
export function markdownBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** The composer footer's voice controls and mic, drawn by the renderer in packages/conversation, for the page (architecture.md § Web page). */
export function renderVoice(voice: VoiceView | null, live = true): string {
  return renderVoiceControls(voice, live, 'page');
}

export { renderMicButton };

