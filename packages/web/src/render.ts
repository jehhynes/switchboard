import { renderMicButton, renderVoiceControls } from '@switchboard/conversation/voiceControls';
import { fullTime, metaLine, stamped, stampTime, toneMark, voiceMark } from '@switchboard/conversation/messageMeta';
import { hasUnspokenText, spokenBody } from '@switchboard/conversation/spokenBubble';
import { artifactIcon, awaitingReply, selectedEntry, selectedRow, stateIcon, timeline } from './model.js';
import type { PageState } from './model.js';
import { copyButton, escape, renderInline, renderMarkdown } from './markdown.js';
import { answers, answersIn, answerText, cardOutcome, complete, parseQuestions, questionSegments } from '@switchboard/conversation/questions';
import type { Question, QuestionChoice } from '@switchboard/conversation/questions';
import type { ArtifactView, MessageView, NativeRequest, PageAction, PageGroup, PageRow, ReplyView, ScreenPrompt, StatusView, VoiceView } from './types.js';
import type { SnoozeChoice } from '@switchboard/core/snooze';

export type Tab = 'conversation' | 'status' | 'artifacts' | 'console';
export const TABS: Array<{ tab: Tab; label: string }> = [
  { tab: 'conversation', label: 'Conversation' },
  { tab: 'status', label: 'Status' },
  { tab: 'artifacts', label: 'Artifacts' },
  { tab: 'console', label: 'Console' },
];

/** What the column right of the conversation shows on a wide screen. */
export type SideTab = 'status' | 'artifacts' | 'console';
export const SIDE_TABS: readonly SideTab[] = ['status', 'artifacts', 'console'];

/**
 * Why the Console tab shows no console for the session (architecture.md § Web page), or null when the terminal holder may hold it: a Codex
 * session runs in Codex's app-server, and a session the page cannot talk to runs outside the holder.
 */
export function consoleNote(session: PageState['session']): string | null {
  if (session === null) {
    return 'No session has started yet.';
  }

  if (session.provider === 'codex') {
    return "This Codex session runs in Codex's app-server, not in Switchboard's terminal holder, so it has no console here. Open it in a terminal from VS Code or the dock.";
  }

  return session.conversation === 'none' ? "This session does not run in Switchboard's terminal holder, so it has no console here." : null;
}

/** A question card's choices and the answer on its way, kept by the page until the answer shows in the conversation. */
export interface CardDraft {
  choices: Map<number, QuestionChoice>;
  sent: string | null;
  /** The message the answer became, once the hub took it. */
  sentId?: string | null;
  sending: boolean;
  error: string | null;
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
  /** The header's persona menu while open: the roster, null while it loads, or why it could not. */
  personas: { items: Array<{ id: string; name: string }> | null; error: string | null } | null;
  /** The list's collapsed groups, by key. */
  collapsed: Set<string>;
  /** The Done bands the operator opened or closed, by `<group>:<band>`; the rest follow `OPEN_BANDS`. Kept until the page reloads, as the dock keeps them until it exits. */
  bands: Map<string, boolean>;
  /** Whether a narrow screen shows the list rather than the conversation: after Back, or before a work item is opened. */
  list: boolean;
  /** The work items' drawer, from tablet width until the list column fits: shown by its button or a key ('open'), by a pointer resting on its sliver ('hover'), or hidden (null). Never kept. */
  drawer: 'open' | 'hover' | null;
  /** Whether the header's actions menu is open, and in it the Open link submenu. */
  actions: boolean;
  linkMenu: boolean;
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
  /** New conversation…'s provider menu under the dropdown: the providers, null while they load, or why not. */
  providers: { items: Array<{ provider: string; name: string; default: boolean }> | null; error: string | null } | null;
  /** The prompt the session waits on in its terminal, as last read, for the session it was read for; a key being sent waits. */
  prompt: { sessionId: string; prompt: ScreenPrompt | null; sending: boolean } | null;
  /** The Chrome pane as the hub last described it (architecture.md § Pane state), and the outcome of a pairing from this page. */
  pane: PaneView | null;
  paneNote: string | null;
}

/** The hub's `pane` event (architecture.md § Pane state). */
export interface PaneView {
  enabled: boolean;
  extension: 'none' | 'unpaired' | 'paired';
  extensionId?: string;
  marker: string | null;
  shown: boolean;
  error: string | null;
}

/** What the view options menu says of the Chrome pane, or null while it is off. */
export function paneStatus(pane: PaneView | null): string | null {
  if (pane === null || !pane.enabled) {
    return null;
  }

  if (pane.error !== null) {
    return `Chrome pane stopped: ${pane.error}`;
  }

  return pane.extension === 'none' ? 'Chrome pane: the Switchboard Chrome extension is not connected.' : pane.extension === 'unpaired' ? 'Chrome pane: the Chrome extension is not paired.' : pane.shown ? 'Chrome pane: showing.' : 'Chrome pane: paired.';
}

/** A sheet: Delete's or Stop's question, Snooze…'s choices, a control's text (and choice) as the dock's input dialog asks for it, or a drafted text the clipboard refused. */
export type Sheet =
  | { kind: 'input'; row: string; label: string; input: NonNullable<PageAction['input']>; text: string; picked: string }
  | { kind: 'confirm'; row: string; action: PageAction }
  | { kind: 'snooze'; row: string; label: string; title: string; choices: SnoozeChoice[]; picked: string; date: string; comment: string }
  | { kind: 'text'; title: string; text: string };

export const newView = (): View => ({ tab: 'conversation', open: new Set(), picker: false, cards: new Map(), artifact: null, requestValues: new Map(), personas: null, collapsed: new Set(COLLAPSED_GROUPS), bands: new Map(), list: false, drawer: null, actions: false, linkMenu: false, rowMenu: null, sheet: null, acting: false, prompt: null, providers: null, side: 'status', viewMenu: false, details: false, pane: null, paneNote: null });

/** The longest menu label for a link, as the dock's `LinkLabelMax`; a longer one is cut with an ellipsis and shown whole in its tooltip. */
export const LINK_LABEL_MAX = 48;

/** A row's key in the list: `item:<work item ID>`, or a pool ticket's `ticket:<ticket ID>`, as the dock keys its rows. */
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

/** Whether an input sheet can go ahead: with a text, or with a choice changed from the one chosen at first, as the dock's dialog. */
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

/** The groups the list shows collapsed until the operator opens them, as the dock does. */
export const COLLAPSED_GROUPS: readonly string[] = ['done', 'snoozed'];
/** Where the page keeps the operator's open or closed choice per group, as the dock keeps `groups` in `dock.json`. */
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

/** The Done bands open until the operator closes them, as the dock's: Today and Yesterday; the older bands start closed. */
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
export function withoutQuestions(markdown: string, key: string, open: ReadonlySet<string>, ends = true): string {
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

/** The mark of a reply whose speech failed, for its meta line; empty otherwise, since routine speech states show nothing. */
export function spokenMark(item: ReplyView): string {
  return item.spoken.state === 'failed'
    ? '<span class="spoken failed" title="Speaking this reply failed; see the voice log."><span class="codicon codicon-mute" aria-hidden="true"></span><span>Not spoken</span></span>'
    : '';
}

/** How the shared `spokenBody` draws a reply's text around its bubbles: `markdown` for the text, the page's own escaping for a passage heard in part. */
export function spokenRender(markdown: (text: string, last: boolean) => string): { markdown: (text: string, last: boolean) => string; escape: (text: string) => string } {
  return { markdown, escape };
}

/** The URL of an artifact's file for the page key, which the sandboxed frame's own relative files also resolve against. */
export function artifactUrl(key: string, path: string): string {
  return `/v1/conversation/artifact/${encodeURIComponent(key)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Whether an artifact opens in the sandboxed frame: a page or an SVG, whose scripts must reach neither the page nor the network. */
export function framed(artifact: ArtifactView): boolean {
  return artifact.type === 'html' || artifact.ext.toLowerCase() === 'svg' || artifact.ext.toLowerCase() === '.svg';
}

/** Front matter dropped from an artifact's Markdown, as the VS Code preview does not show it either. */
export function markdownBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** The composer footer's voice controls and mic, drawn by the Conversation view's renderer, for the page (architecture.md § Web page). */
export function renderVoice(voice: VoiceView | null, live = true): string {
  return renderVoiceControls(voice, live, 'page');
}

export { renderMicButton };

export { answerText, complete, parseQuestions };
