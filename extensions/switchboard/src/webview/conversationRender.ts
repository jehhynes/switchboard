import MarkdownIt from 'markdown-it';
import type { ArtifactView, ConversationEntry, ItemView, MessageView, ReplyView, SessionView, StatusView, VoiceView } from '@switchboard/hub';

/** A Codex session's pending question or approval, as the hub sends it. */
type NativeRequest = NonNullable<SessionView['requests']>[number];
import { providerMark } from '@switchboard/conversation/providerIcons';
import { backgroundLabel } from '@switchboard/core/group';
import { fullTime, metaLine, spokenMark, stamped, toneMark, voiceMark } from '@switchboard/conversation/messageMeta';
import { hasUnspokenText, replyBody } from '@switchboard/conversation/replyBody';
import { artifactIcon, awaitingReply, inTurn, selectedEntry, stateIcon, statusLine, timeline } from '../conversationModel.js';
import type { ConversationState } from '../conversationModel.js';
import { answerSummary, plain, questionLedger, questionSegments, stripQuestionMarkup, withoutEndingQuestions } from '@switchboard/conversation/questions';
import type { CardDraft as SharedDraft, LedgerItem, LedgerQuestion, QuestionLedger } from '@switchboard/conversation/questions';
import { isAnswerMessage, questionsWaiting, renderAnswersBubble, renderQuestionCard } from '@switchboard/conversation/questionCard';

/** What the page posts to the extension. */
export type ConversationMessage =
  | { type: 'ready' }
  | { type: 'earlier' }
  | { type: 'open'; href: string }
  | { type: 'terminal' }
  | { type: 'answer-request'; id: number; requestId: string; answer: unknown; target: SeenTarget }
  | { type: 'select'; workItemId: number }
  | { type: 'talk-here' }
  | { type: 'stop-speaking' }
  | { type: 'speak-replies'; on: boolean }
  | { type: 'mic'; on: boolean }
  | { type: 'composer'; focused: boolean; draft: string }
  | { type: 'replay'; replyId: string }
  | { type: 'new'; provider: 'claude' | 'codex' }
  | { type: 'providers'; id: number }
  | { type: 'personas'; id: number }
  | { type: 'persona'; personaId: string | null; target: SeenTarget }
  | { type: 'send'; id: number; text?: string; target: SendTarget; command?: true; answers?: Array<{ card: string; slug: string; letters: string[]; other: string }> }
  | { type: 'card-draft'; id: number; card: string; draft: SharedDraft; target: SendTarget }
  | { type: 'card-dismiss'; id: number; card: string; slug: string; target: SendTarget }
  | { type: 'files'; id: number; query: string }
  | { type: 'commands'; id: number }
  | { type: 'attach' }
  | { type: 'image'; id: number; mime: string; data: string }
  | { type: 'copy'; id: number; text: string }
  | { type: 'status-open'; statusId: string | null }
  | { type: 'statuses'; id: number; before: string | null }
  | { type: 'artifact'; path: string }
  | { type: 'seen'; ids: string[]; target: SeenTarget };

/** The scope generation and session the page showed the items in; the hub marks them only there. */
export type SeenTarget = Omit<SendTarget, 'launch'>;

/** The session the page showed when Enter was pressed; the message goes there or is refused. */
export interface SendTarget {
  scopeGen: number;
  sessionId: string;
  launch: string | null;
}

/** What a typed message's line under its box says (architecture.md § Conversation view). */
const DELIVERY = { open: 'sending', sent: 'sent', 'not-sent': 'not sent', uncertain: 'delivery unknown; check before resending' } as const;

const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const DAY_WITH_YEAR = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });


/** The local midnight starting the day of a time, to tell when a turn starts on a later day. */
function dayOf(at: number): number {
  const date = new Date(at);

  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** A day as its divider names it: "Today", "Yesterday", the weekday and date this year, or the full date with the year. */
export function dayLabel(at: number, now: number): string {
  const midnight = (time: number): number => new Date(new Date(time).getFullYear(), new Date(time).getMonth(), new Date(time).getDate()).getTime();
  // Rounded, since a day with a daylight saving change is 23 or 25 hours long.
  const days = Math.round((midnight(now) - midnight(at)) / 86_400_000);

  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : (new Date(at).getFullYear() === new Date(now).getFullYear() ? DAY : DAY_WITH_YEAR).format(at);
}

/** The divider before the first turn shown on each day. */
function dayDivider(at: number, now: number): string {
  return `<li class="day" role="separator">${escape(dayLabel(at, now))}</li>`;
}

/** A message that is a slash command, which shows in the editor font. */
const COMMAND = /^\/[\w:.-]+(\s|$)/;

/** Raw HTML off, so a reply's text can never inject markup; tables, code spans and fences as GitHub draws them. */
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

/**
 * Which link targets render as links: a web page, a `file:` URL, and a path with no scheme (relative, rooted or a drive letter), which the extension
 * opens; any other scheme, such as `javascript:`, `data:` or `vbscript:`, shows as text. markdown-it's own check rejects `file:`.
 */
export function linkAllowed(url: string): boolean {
  const target = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1]?.toLowerCase();

  return scheme === undefined || /^[a-z]$/.test(scheme) || ['http', 'https', 'file'].includes(scheme);
}

markdown.validateLink = linkAllowed;

/** A copy button: in a code block's corner, or under a reply; it shows a check for a moment once the extension wrote the clipboard. */
function copyButton(action: 'copy-code' | 'copy-reply', label: string): string {
  return `<button class="copy" type="button" data-action="${action}" title="${label}" aria-label="${label} to clipboard"><span class="codicon codicon-copy" aria-hidden="true"></span></button>`;
}

// Each code block sits in a frame with its copy button, as in Claude Code's panel.
for (const rule of ['fence', 'code_block'] as const) {
  const draw = markdown.renderer.rules[rule]!;

  markdown.renderer.rules[rule] = (...args) => `<div class="code-block">${copyButton('copy-code', 'Copy code')}${draw(...args)}</div>`;
}

/** What a reply's copy button copies: its Markdown as the session wrote it, without its tags. */
export function replyText(item: ReplyView): string {
  return item.opening;
}

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A reply's Markdown as HTML; links keep their target in `data-href`, which the page posts, so the webview itself never navigates. */
export function renderMarkdown(text: string): string {
  return markdown.render(text).replace(/<a href="([^"]*)"/g, (_match, href: string) => `<a href="#" data-href="${href}"`);
}

/**
 * One of our messages: its bubble over its meta line (`metaLine`, shared with the web page). Only an error state shows always, with why in the
 * tooltip; with message details on, a dictated message's mark too. A message with no meta line has its time as the bubble's tooltip.
 */
/** Above a message that answered questions: a quoted line per question, which goes to its card. */
function answerReference(key: string, answered: readonly LedgerQuestion[]): string {
  const lines = answered.map((one) => ({ question: plain(one.question.text), answer: one.answer === null ? '' : answerSummary(one.question, one.answer.letters, one.answer.other, one.state === 'dismissed') }));
  const shown = lines.map((line) => `<span class="answer-ref-line"><span class="answer-ref-mark" aria-hidden="true">↳</span><span class="answer-ref-question">${escape(line.question)}</span><span class="answer-ref-answer">→ ${escape(line.answer)}</span></span>`).join('');

  return `<button type="button" class="answer-ref" data-action="goto-card" data-target-card="${escape(key)}" title="Show the questions">${shown}</button>`;
}

function message(item: MessageView, stamped: boolean, details: boolean, answered: readonly LedgerQuestion[] = []): string {
  // Only an error state shows: a message sent or still sending shows only its time; one not sent has left the conversation.
  const state = item.origin === 'typed' && (item.delivery === 'not-sent' || item.delivery === 'uncertain') ? item.delivery : null;
  const why = item.error === null ? '' : ` · ${item.error}`;
  const delivery =
    state === null ? '' : `<span class="delivery ${state}" title="${escape(`${DELIVERY[state]}${why}`)}">${DELIVERY[state]}</span>`;

  // An answer message shows as the Answers bubble; any other message that answered questions quotes them above it.
  const bubble = isAnswerMessage(item.text);
  // A message sent in the terminal while the session was busy waits, dimmed, until Claude reads it.
  const queued = item.provisional && item.origin === 'terminal';
  // The marks sit at the bubble's left edge and the time at its right, so every time stays flush right in one column.
  const meta = metaLine([voiceMark(item, details), delivery], item.at, stamped);

  return `<li class="message${item.provisional ? ' provisional' : ''}" data-id="${escape(item.id)}" tabindex="-1"${queued ? ' title="Sent; Claude has not read it yet"' : ''}><div class="bubble"${meta === '' && !queued ? ` title="${escape(fullTime(item.at))}"` : ''}>${bubble || answered.length === 0 ? '' : answerReference(answered[0]!.card, answered)}${bubble ? `<div class="box answers">${renderAnswersBubble(item.text, answered)}</div>` : `<div class="box${COMMAND.test(item.text) ? ' command' : ''}">${escape(item.text)}</div>`}${meta}</div></li>`;
}

// The voice controls are drawn by one renderer with the web page's (architecture.md § Voice).
export { renderMicButton, renderVoiceControls } from '@switchboard/conversation/voiceControls';

/** The fold key of a reply that Show more opened; a reply starts folded only with `voice.briefReplies`, and once open stays open. */
export const moreKey = (id: string): string => `more:${id}`;

function reply(item: ReplyView, earlier: ReplyView | null, open: ReadonlySet<string>, stamped: boolean, card = '', briefReplies = false, details = false): string {
  if (item.kind === 'note') {
    return `<li class="note" data-id="${escape(item.id)}" tabindex="-1">${escape(item.opening)}</li>`;
  }

  // Focused mode (voice-design decision 21), with Brief replies on: a reply shows its primary response first, spoken or not, its details behind Show more. The
  // primary response keeps its place when the whole reply shows; after the operator spoke over it, the part not heard is dimmed.
  const passage = item.kind === 'reply' && item.speak !== null && item.speak.trim() !== '' ? item.speak : null;
  // Question ids and withdraw lines are for the view and the session, not the operator.
  const opening = stripQuestionMarkup(item.opening);
  // The questions that end a reply show in its card, so they alone give Show more nothing to show.
  const folded = passage !== null && hasUnspokenText(card === '' ? opening : withoutEndingQuestions(opening), passage);
  // Show more opens a reply for good: an open reply has nothing to fold it again.
  const expanded = !folded || !briefReplies || open.has(moreKey(item.id));
  // Only the text that ends the reply can end in the card's questions, which it leaves out; questions before a passage fold into one line.
  const markdownPart = (text: string, last: boolean): string => (card === '' ? renderMarkdown(text) : withoutQuestions(text, last ? `reply:${item.id}` : `reply:${item.id}:before`, open, last));
  const said = item.spoken.state === 'interrupted' ? item.spoken.saidChars : null;
  const shown = passage === null ? markdownPart(opening, true) : replyBody(opening, passage, said, !expanded, { markdown: markdownPart, escape });
  const more = expanded ? '' : `<button class="show-more" type="button" data-action="more" data-reply="${escape(item.id)}" aria-expanded="false">Show more</button>`;
  const tone = toneMark(item.tone, details);

  const rewritten =
    earlier === null
      ? ''
      : `<details class="fold earlier" data-fold="earlier:${escape(item.id)}"${open.has(`earlier:${item.id}`) ? ' open' : ''}><summary>Rewritten</summary><div class="was">${renderMarkdown(earlier.opening)}</div></details>`;

  // A reply read off the screen has no copy button until its transcript copy replaces it, as Claude Code's has none while it streams. The copy
  // button comes first on the line under the reply, then the tone and a speech failure, and the time at the right.
  const meta = metaLine([item.provisional ? '' : copyButton('copy-reply', 'Copy response'), tone, spokenMark(item.spoken.state, details)], item.at, stamped);

  // An unread reply's dot takes the badge colour until the view has shown it in a focused window for a second (architecture.md § Unread).
  const unread = item.unread ? ` unread" data-unread="${escape(item.id)}` : '';
  const dot = item.unread ? '<span class="dot" title="Unread"><span class="unread-label">Unread</span></span>' : '<span class="dot"></span>';

  return `<li class="reply ${item.kind}${unread}" data-id="${escape(item.id)}"${passage === null ? '' : ' data-speak="1"'} tabindex="-1">${dot}<div class="body">${shown}${more}${rewritten}</div>${meta}${card}</li>`;
}

/**
 * A reply's or a status's Markdown when its card draws its questions (architecture.md § Conversation view): questions that end it, as the rules
 * ask, are left out, so the text does not repeat them cut up; questions with text after them, against the rules, stay in place folded into one
 * line, "2 questions — answer below", that opens them. `ends` is false for text a spoken passage follows, whose questions all fold.
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

/** What the view keeps of a question card beside the hub's draft (PRD R103): its own change on its way, a Send under way, an error, its menu. */
export interface CardDraft {
  /** The draft as this view changed it, shown until the hub's `questions` event follows; null once it has. */
  local: SharedDraft | null;
  /** `card-draft` posts not yet answered. */
  pending: number;
  sending: boolean;
  error: string | null;
  menuOpen: boolean;
}

/** A card's key: the reply that asks its questions. */
export function cardKey(kind: 'reply' | 'status', id: string): string {
  return `${kind}:${id}`;
}

/** Inline Markdown, as a reply's, for a question or an option. */
function inlineMarkdown(text: string): string {
  return markdown.renderInline(text).replace(/<a href="([^"]*)"/g, (_match, href: string) => `<a href="#" data-href="${href}"`);
}

export { questionsWaiting };

let ledgerOf: { items: ConversationState['items']; since: number | null; dismissed: string; ledger: QuestionLedger } | null = null;

/** The question ledger of the view's conversation (PRD R103), worked out again only when its items or the hub's questions change. */
export function viewLedger(state: ConversationState): QuestionLedger {
  const since = state.questions?.since ?? null;
  const dismissed = (state.questions?.dismissed ?? []).map((one) => `${one.key}@${one.at}`).join(' ');

  if (ledgerOf === null || ledgerOf.items !== state.items || ledgerOf.since !== since || ledgerOf.dismissed !== dismissed) {
    // Until the hub says where the cutover is, every card follows the rules from before it, so no old card shows open.
    ledgerOf = { items: state.items, since, dismissed, ledger: questionLedger(state.items as unknown as LedgerItem[], { since: since ?? Number.POSITIVE_INFINITY, dismissed: state.questions?.dismissed ?? [] }) };
  }

  return ledgerOf.ledger;
}

/** A question card, drawn by the renderer the web page shares (`renderQuestionCard`). */
export function questionCard(key: string, ledger: QuestionLedger, state: ConversationState, ui: CardDraft | undefined, canAnswer: boolean): string {
  const card = ledger.cards.get(key);

  if (card === undefined) {
    return '';
  }

  const ended = state.session?.state === 'ended' || state.session?.conversation !== 'full';

  return renderQuestionCard(card, ui?.local ?? state.questions?.drafts[key], {
    canAnswer,
    note: ended && card.questions.some((one) => one.state === 'open') ? 'Session ended — open in terminal to continue.' : null,
    sending: ui?.sending === true,
    error: ui?.error ?? null,
    menuOpen: ui?.menuOpen === true,
    inline: inlineMarkdown,
  });
}

/** An artifact as a one-line row where it was written: it opens, it does not expand (architecture.md § Conversation view). */
function artifactRow(artifact: ArtifactView): string {
  return (
    `<li class="artifact" data-id="artifact:${escape(artifact.path)}" data-path="${escape(artifact.path)}" tabindex="-1">` +
    `<button class="artifact-open" type="button" data-action="artifact" data-path="${escape(artifact.path)}" title="${escape(`Open ${artifact.path}`)}" aria-label="${escape(`Open artifact: ${artifact.title}`)}">` +
    `<span class="codicon codicon-${artifactIcon(artifact.type)}" aria-hidden="true"></span><span class="artifact-title">${escape(artifact.title)}</span><span class="artifact-kind">${escape(artifact.kind)}</span></button></li>`
  );
}

/** How long ago a status or an artifact was written, as the Status and Artifacts tabs say it: "just now", "4 min ago", "2 h ago", "3 d ago". */
export function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);

  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 24 * 60 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / (24 * 60))} d ago`;
}

/** The view's tabs (architecture.md § Conversation view): the conversation, the status and the artifacts, each taking the view's full height. */
export type Tab = 'conversation' | 'status' | 'artifacts';
export const TABS: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: 'conversation', label: 'Conversation' },
  { tab: 'status', label: 'Status' },
  { tab: 'artifacts', label: 'Artifacts' },
];

/**
 * What the page adds to the state to draw it: the tab shown, the artifacts new or changed since they were last opened in the workspace, and the
 * question cards' choices by card key.
 */
export interface PageView {
  tab: Tab;
  unopened: ReadonlySet<string>;
  cards?: ReadonlyMap<string, CardDraft>;
  /** Whether the New messages pill shows: new items came below a conversation scrolled up. */
  pill?: boolean;
  /** The header menu open, if any. */
  menu?: HeaderMenu | null;
  /** The earlier statuses listed on the Status tab, while their list is open. */
  earlier?: EarlierStatuses | null;
  /** The Codex requests' answers and refusals. */
  requests?: RequestDrafts;
  /** Show message details: every item's time and the optional marks (`messageMeta`), the user's choice kept by the extension. */
  details?: boolean;
}

/** The Status tab's list of the session's earlier statuses, newest first, while it is open; `more` while older ones can be loaded. */
export interface EarlierStatuses {
  statuses: StatusView[];
  more: boolean;
  loading: boolean;
  error: string | null;
}

const NO_REQUESTS: RequestDrafts = { values: new Map(), errors: new Map(), sending: new Set() };

const CONVERSATION_TAB: PageView = { tab: 'conversation', unopened: new Set() };

/** A status's time on the Status tab: "Thu, Nov 19, 1:46 PM". */
const STATUS_TIME = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** An age that the page redraws every 30 seconds. */
function age(at: number, now: number, className: string): string {
  return `<time class="${className} age" data-at="${at}" datetime="${new Date(at).toISOString()}">${ago(at, now)}</time>`;
}

/** The Status tab's dot, named for a screen reader: Unread while the latest status is unread (architecture.md § Unread), else Updated while it is `fresh`; never for the stage. */
export function statusDot(status: StatusView | null, fresh: boolean): 'Unread' | 'Updated' | null {
  return status === null || status.fallback ? null : status.unread ? 'Unread' : fresh ? 'Updated' : null;
}

/** The unread mark's dot (architecture.md § Unread), named for a screen reader and on hover. */
function unreadDot(label: string): string {
  return `<span class="unread-dot" role="img" title="${escape(label)}" aria-label="${escape(label)}"></span>`;
}

/**
 * The Status tab (architecture.md § Statuses): the session's latest status as Markdown under a line with its time, how long ago, the unread dot
 * while `fresh`, and the buttons that open it and the earlier statuses in the Markdown preview. Before the first status, the work item's stage, dimmed;
 * with neither, a line that says so.
 */
export function renderStatus(status: StatusView | null, fresh: boolean, now: number, earlier: EarlierStatuses | null = null): string {
  if (status === null) {
    return '<p class="empty">No status yet. It appears here when the session reports one.</p>';
  }

  if (status.fallback) {
    return (
      '<div class="status-tab fallback"><p class="empty">No status yet. Until the session reports one, the work item\'s stage:</p>' +
      `<div class="status-head"><span class="codicon codicon-pulse" aria-hidden="true"></span><span class="status-label">Stage</span><span class="status-dot" aria-hidden="true">·</span>${age(status.at, now, 'status-age')}</div>` +
      `<div class="status-body body">${renderMarkdown(stripQuestionMarkup(status.markdown))}</div></div>`
    );
  }

  const mark = fresh ? unreadDot(status.unread ? 'Unread' : 'Updated') : '';
  const actions =
    '<span class="status-actions"><button class="icon" type="button" data-action="status-open" title="Open in the Markdown preview" aria-label="Open the status in the Markdown preview"><span class="codicon codicon-open-preview" aria-hidden="true"></span></button>' +
    `<span class="menu-anchor"><button class="icon${earlier === null ? '' : ' pressed'}" type="button" data-action="statuses" title="Earlier statuses" aria-label="Earlier statuses" aria-haspopup="menu" aria-expanded="${earlier !== null}"><span class="codicon codicon-history" aria-hidden="true"></span></button>${earlierStatuses(earlier)}</span></span>`;
  const time = `<span class="status-time" title="${escape(fullTime(status.at))}">${escape(STATUS_TIME.format(status.at))}</span>`;
  const unread = status.unread ? ` unread" data-unread="${escape(status.id)}` : '';

  return (
    `<div class="status-tab${fresh ? ' fresh' : ''}${unread}" role="region" aria-label="${unread === '' ? 'Status' : 'Status, unread'}">` +
    `<div class="status-head"><span class="codicon codicon-pulse" aria-hidden="true"></span>${time}<span class="status-dot" aria-hidden="true">·</span>${age(status.at, now, 'status-age')}${mark}${actions}</div>` +
    `<div class="status-body body">${renderMarkdown(stripQuestionMarkup(status.markdown))}</div></div>`
  );
}

/** A status's time in the earlier statuses list: "Thu, Nov 19, 1:46 PM". */
const EARLIER_TIME = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * The Status tab's earlier statuses (architecture.md § Statuses), a menu right-aligned under its history button: each status's first line with
 * its time as the row's note, newest first, a click opening it in the Markdown preview, and Older statuses after a separator while there are more.
 */
function earlierStatuses(earlier: EarlierStatuses | null): string {
  if (earlier === null) {
    return '';
  }

  const rows = earlier.statuses
    .map((status) => `<li role="none"><button type="button" class="menu-row earlier-status" role="menuitem" data-action="status-earlier" data-status="${escape(status.id)}" title="Open in the Markdown preview">${gutter(null)}<span class="title">${escape(statusLine(status.markdown) || 'Status')}</span><span class="menu-note">${escape(EARLIER_TIME.format(status.at))}</span></button></li>`)
    .join('');
  const message = (text: string, alert = false): string => `<li class="menu-message"${alert ? ' role="alert"' : ' role="none"'}>${escape(text)}</li>`;
  const foot =
    earlier.error !== null
      ? message(earlier.error, true)
      : earlier.loading
        ? message('Loading…')
        : earlier.statuses.length === 0
          ? message('No earlier statuses yet. A status moves here when the session reports a newer one.')
          : earlier.more
            ? `${SEPARATOR}<li role="none"><button type="button" class="menu-row" role="menuitem" data-action="statuses-more">${gutter(null)}<span class="title">Older statuses</span></button></li>`
            : '';

  return `<ul class="glass menu earlier-menu" id="earlier-statuses" data-key="menu-earlier" role="menu" aria-label="Earlier statuses">${rows}${foot}</ul>`;
}

/**
 * The Artifacts tab (architecture.md § Artifacts): the work item's artifacts newest first, each a row with its type's codicon, title, kind and age,
 * marked while new or changed since last opened in the workspace; a click opens it natively.
 */
export function renderArtifacts(artifacts: readonly ArtifactView[], unopened: ReadonlySet<string>, now: number): string {
  if (artifacts.length === 0) {
    return '<p class="empty">No artifacts yet. They appear here when the session writes one.</p>';
  }

  const rows = artifacts.map((artifact) => {
    const fresh = unopened.has(artifact.path);
    const label = `Open artifact: ${artifact.title}, ${artifact.kind}${fresh ? ', new or changed' : ''}`;

    return (
      `<li class="artifact-item${fresh ? ' unopened' : ''}"><button class="artifact-open" type="button" data-action="artifact" data-path="${escape(artifact.path)}" title="${escape(`${artifact.path}\nUpdated ${new Date(artifact.updatedAt).toLocaleString()}`)}" aria-label="${escape(label)}">` +
      `<span class="codicon codicon-${artifactIcon(artifact.type)}" aria-hidden="true"></span><span class="artifact-title">${escape(artifact.title)}</span>` +
      `<span class="artifact-kind">${escape(artifact.kind)} · ${age(artifact.updatedAt, now, 'artifact-age')}</span>${fresh ? '<span class="artifact-new" aria-hidden="true"></span>' : ''}</button></li>`
    );
  });

  return `<ul class="artifact-list" aria-label="Artifacts">${rows.join('')}</ul>`;
}

/** The tab strip, as VS Code's panel tabs: the selected tab underlined; Status with the unread dot named `dot`, Artifacts with the count of new or changed ones. */
function renderTabs(selected: Tab, dot: string | null, unopened: number): string {
  const tabs = TABS.map(({ tab, label }) => {
    const badge = tab === 'status' && dot !== null ? unreadDot(dot) : tab === 'artifacts' && unopened > 0 ? `<span class="tab-badge">${unopened}</span>` : '';
    const name = tab === 'status' && dot !== null ? `${label}, ${dot.toLowerCase()}` : tab === 'artifacts' && unopened > 0 ? `${label}, ${unopened} new or changed` : label;

    return `<button class="tab${tab === selected ? ' selected' : ''}" type="button" role="tab" id="tab-${tab}" data-tab="${tab}" aria-selected="${tab === selected}" aria-controls="panel" aria-label="${escape(name)}" tabindex="${tab === selected ? 0 : -1}"><span class="tab-label">${label}</span>${badge}</button>`;
  });

  return `<nav class="tabs" role="tablist" aria-label="Switchboard">${tabs.join('')}</nav>`;
}

/** The fold key of the header's conversation list, which the page opens and closes. */
export const PICKER = 'conversations';

/** A state's codicon with its text for a screen reader. */
/** A codicon with its words as tooltip and name; a session state's, with its tone, is drawn small and muted unless it needs attention. */
function codicon({ icon, text, tone }: { icon: string; text: string; tone?: string }): string {
  const [name, modifier] = icon.split('~');

  return `<span class="codicon codicon-${name}${modifier === undefined ? '' : ` codicon-modifier-${modifier}`}${tone === undefined ? '' : ` state-icon tone-${tone}`}" title="${escape(text)}" aria-label="${escape(text)}"></span>`;
}

/** A menu row's left gutter: a check mark for the chosen row, or another codicon, or nothing, so every row's text starts in one column. */
function gutter(icon: string | null): string {
  return `<span class="menu-gutter" aria-hidden="true">${icon === null ? '' : `<span class="codicon codicon-${icon}"></span>`}</span>`;
}

/** A thin line between groups of a menu's rows. */
const SEPARATOR = '<li class="menu-separator" role="separator"></li>';

/**
 * A conversation as the dropdown's button and each of its rows draw it, from this one renderer so they never differ (architecture.md §
 * Conversation view): its session's state codicon, its title, the unread dot when `unread`, and its provider's mark.
 */
export function conversationLabel(entry: ConversationEntry, state: ConversationState, unread = false): string {
  const selected = entry.workItemId === state.scope?.workItemId;
  // The selected conversation's state and provider come from its current session, which the view follows more closely than the entry.
  const icon = selected ? stateIcon(state.session) : stateIcon(entry.state === null ? null : ({ state: entry.state, waitingFor: null } as never));

  return `${codicon(icon)}<span class="title">${escape(entry.title)}</span>${unread ? UNREAD_DOT : ''}${providerMark(selected ? (state.session?.provider ?? entry.provider) : entry.provider)}`;
}

/** The unread mark's dot on a conversation of the dropdown with unseen replies or status (architecture.md § Unread). */
const UNREAD_DOT = '<span class="unread-dot" role="img" title="Unread replies or status" aria-label="Unread replies or status"></span>';

/**
 * The header's conversation dropdown (architecture.md § Conversation view): a button that shows the selected conversation as its rows do, then
 * a chevron, and opens the menu of the window's conversations, the primary work item first, the selected one highlighted rather than checked, since
 * an idle session's state codicon is already a check, then New conversation…,
 * which opens the providers' menu under the same button. A folder window with no conversation yet shows its folder's name.
 */
function picker(state: ConversationState, open: boolean, menu: HeaderMenu | null): string {
  const scope = state.scope!;
  const selected = selectedEntry(state);
  const title = selected?.title ?? scope.title;
  const rows = scope.conversations.map((entry) => {
    const chosen = entry.workItemId === scope.workItemId;

    return `<li role="none"><button type="button" class="menu-row conversation-row" role="menuitemradio" aria-checked="${chosen}" data-action="select" data-work-item="${entry.workItemId}">${conversationLabel(entry, state, !chosen && entry.unread > 0)}</button></li>`;
  });
  // The button carries the dot while a conversation the operator is not looking at has unseen items.
  const othersUnread = scope.conversations.some((entry) => entry.workItemId !== scope.workItemId && entry.unread > 0);
  const create = `<li role="none"><button type="button" class="menu-row" role="menuitem" data-action="new" aria-haspopup="menu">${gutter('add')}<span class="title">New conversation…</span></button></li>`;
  const list = open ? `<ul class="glass menu conversation-menu" data-key="menu-conversations" role="menu" aria-label="Conversations">${rows.join('')}${rows.length > 0 ? SEPARATOR : ''}${create}</ul>` : '';
  const label = selected === null ? `<span class="codicon codicon-folder" aria-hidden="true"></span><span class="title">${escape(title)}</span>` : conversationLabel(selected, state, othersUnread);
  const button = `<button type="button" class="picker" data-action="picker" aria-haspopup="menu" aria-expanded="${open}" title="${escape(title)}">${label}<span class="codicon codicon-chevron-down" aria-hidden="true"></span></button>`;

  return `<div class="menu-anchor picker-anchor">${button}${list}${menu?.kind === 'provider' ? headerMenu(menu) : ''}</div>`;
}

/**
 * The header's persona button (architecture.md § Personas): an icon, `pinned` or `person`, with the persona's name in its tooltip and accessible
 * name, which opens the list to pin another; a plain `person` for a session with none that can take a pin; nothing otherwise.
 */
export function personaButton(persona: SessionView['persona'] | undefined, expanded = false, canPin = false): string {
  if (persona == null) {
    const none = 'No persona. Click to choose one.';

    return canPin ? `<button type="button" class="persona" data-action="persona" aria-haspopup="menu" aria-expanded="${expanded}" title="${none}" aria-label="${none}"><span class="codicon codicon-person" aria-hidden="true"></span></button>` : '';
  }

  const title = [`Persona: ${persona.name}${persona.pinned ? ', pinned to this session' : ''}.`, persona.tonePending ? 'Its tone changes when the session next resumes or compacts.' : '', 'Click to choose another.'].filter((part) => part !== '').join(' ');

  return `<button type="button" class="persona${persona.tonePending ? ' pending' : ''}" data-action="persona" aria-haspopup="menu" aria-expanded="${expanded}" title="${escape(title)}" aria-label="${escape(title)}"><span class="codicon codicon-${persona.pinned ? 'pinned' : 'person'}" aria-hidden="true"></span></button>`;
}

/** A menu the header opens (architecture.md § Conversation view): the persona roster to pin from, or the providers a new conversation can use. */
export interface HeaderMenu {
  kind: 'persona' | 'provider';
  /** Null while the extension fetches them. */
  items: Array<{ value: string; label: string; note: string; current: boolean }> | null;
  error: string | null;
}

/**
 * A header menu under its button, drawn as the conversation dropdown is: one row per choice, the current one checked, a choice's note muted at
 * the right; Clear pin after a separator, with what it does in its tooltip.
 */
function headerMenu(menu: HeaderMenu): string {
  const note = (text: string): string => `<li class="menu-message" role="none">${escape(text)}</li>`;
  const rows =
    menu.error !== null
      ? note(menu.error)
      : menu.items === null
        ? note('Loading…')
        : menu.items.length === 0
          ? note(menu.kind === 'persona' ? 'No personas. Add them to voice.personas in settings.json, with voice.enabled on.' : 'No providers.')
          : menu.items
              .map((item) => {
                // Clearing a pin is no persona: it follows the roster after a separator, and says what it does in its tooltip.
                const clear = menu.kind === 'persona' && item.value === '';
                const aside = item.note === '' ? '' : clear ? ` title="${escape(item.note)}"` : '';
                const shown = item.note === '' || clear ? '' : `<span class="menu-note">${escape(item.note)}</span>`;

                return (
                  `${clear ? SEPARATOR : ''}<li role="none"><button type="button" class="menu-row" role="${clear ? 'menuitem' : 'menuitemradio'}"${clear ? '' : ` aria-checked="${item.current}"`} data-action="menu-pick" data-menu="${menu.kind}" data-value="${escape(item.value)}"${aside}>` +
                  `${gutter(item.current ? 'check' : null)}<span class="title">${escape(item.label)}</span>${shown}</button></li>`
                );
              })
              .join('');

  return `<ul class="glass menu header-menu" data-key="menu-${menu.kind}" role="menu" aria-label="${menu.kind === 'persona' ? 'Persona' : 'New conversation'}">${rows}</ul>`;
}

const DECISIONS: Record<string, string> = { accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Decline', cancel: 'Cancel' };

/** What the page keeps of the Codex requests it shows: the answers picked or typed by `<request ID>:<question ID>`, and why one was refused. */
export interface RequestDrafts {
  values: ReadonlyMap<string, string>;
  errors: ReadonlyMap<string, string>;
  sending: ReadonlySet<string>;
}

/**
 * A Codex session's pending request as a card at the end of the conversation (architecture.md § Conversation view), in the question card's
 * style: a permission with its decisions as buttons; questions with their options and a field for a typed answer, a secret one hidden, and
 * Submit; one the view cannot answer, with Open in terminal.
 */
export function requestCard(request: NativeRequest, drafts: RequestDrafts): string {
  const icon = request.kind === 'permission' ? 'shield' : request.kind === 'question' ? 'question' : 'terminal';
  const head = `<div class="request-title"><span class="codicon codicon-${icon}" aria-hidden="true"></span><span class="request-text">${escape(request.title)}</span></div>`;
  const busy = drafts.sending.has(request.id);
  const error = drafts.errors.get(request.id);
  const why = error === undefined ? '' : `<span class="question-error" role="alert">${escape(error)}</span>`;
  const card = (body: string): string => `<li class="request-item" data-key="request-${escape(request.id)}"><div class="question-card request" data-request-card="${escape(request.id)}" role="group" aria-label="${request.kind === 'permission' ? 'Permission request' : 'Question from Codex'}">${body}</div></li>`;

  if (request.kind === 'unsupported') {
    return card(`${head}<div class="question-footer"><span class="question-state">Answer it in the terminal.</span><button type="button" class="terminal-question-open" data-action="terminal">Open in terminal</button></div>`);
  }

  if (request.kind === 'permission') {
    const buttons = request.decisions.map((decision) => `<button type="button" class="request-button${decision === 'accept' ? ' primary' : ''}" data-action="request-decision" data-request="${escape(request.id)}" data-decision="${escape(decision)}"${busy ? ' disabled' : ''}>${escape(DECISIONS[decision] ?? decision)}</button>`).join('');

    return card(`${head}<div class="question-footer">${why}${buttons}</div>`);
  }

  const fields = request.questions.map((question) => {
    const key = `${request.id}:${question.id}`;
    const value = drafts.values.get(key) ?? '';
    const options = question.options
      .map((option) => `<button type="button" class="question-option" role="radio" aria-checked="${value === option}" data-action="request-option" data-field="${escape(key)}" data-value="${escape(option)}"${busy ? ' disabled' : ''}><span class="question-mark radio${value === option ? ' checked' : ''}" aria-hidden="true">${value === option ? '<span class="radio-dot"></span>' : ''}</span><span class="question-option-text">${escape(option)}</span></button>`)
      .join('');

    return `<div class="question-block" data-key="${escape(key)}"><div class="question-text">${escape(question.question)}</div><div class="question-options" role="radiogroup" aria-label="${escape(question.question)}">${options}<input class="question-other request-field" type="${question.secret === true ? 'password' : 'text'}" data-field="${escape(key)}" placeholder="${question.options.length === 0 ? 'Answer…' : 'Other…'}" aria-label="${escape(question.question)}" value="${question.options.includes(value) ? '' : escape(value)}"${busy ? ' disabled' : ''}></div></div>`;
  });
  const ready = request.questions.every((question) => (drafts.values.get(`${request.id}:${question.id}`) ?? '').trim() !== '');

  return card(`${head}${fields.join('')}<div class="question-footer">${why}<button type="button" class="question-submit" data-action="request-answer" data-request="${escape(request.id)}"${busy || !ready ? ' disabled' : ''}>${busy ? 'Sending…' : 'Submit'}</button></div>`);
}

/**
 * The row at the end of the timeline while the session is in a turn (architecture.md § Conversation view): drawn as Claude Code's spinner row,
 * "Starting…" or "Thinking…" while it works on a reply; while it waits on the operator, whether or not a reply is due, "Waiting for your answer",
 * "Waiting for permission" or "Waiting in the terminal" with a still icon in the warning colour and Open in terminal, where the operator answers.
 * Empty otherwise; a Codex request the view answers itself draws its own card instead.
 */
export function turnRow(session: SessionView | null, awaiting: boolean): string {
  const waiting = session?.state === 'waiting' && session.waitingFor !== null && (session.requests ?? []).length === 0;

  if (waiting) {
    const label = session.waitingFor === 'question' ? 'Waiting for your answer' : session.waitingFor === 'permission' ? 'Waiting for permission' : 'Waiting in the terminal';
    const icon = session.waitingFor === 'permission' ? 'shield' : session.waitingFor === 'question' ? 'question' : 'terminal';
    const who = session.provider === 'codex' ? 'Codex' : 'Claude';
    const why = session.waitingFor === 'question' ? `${who} asks you a question in the terminal.` : session.waitingFor === 'permission' ? `${who} asks for permission in the terminal.` : `${who} is waiting for you in the terminal.`;

    return (
      `<li class="working waiting" title="${escape(why)}"><span class="working-icon codicon codicon-${icon}" aria-hidden="true"></span><span class="working-label">${label}</span>` +
      `<span role="status">${escape(`${label}. ${why}`)}</span><button type="button" class="terminal-question-open" data-action="terminal">Open in terminal</button></li>`
    );
  }

  if (!awaiting || session === null || (session.requests ?? []).length > 0) {
    return '';
  }

  const label = session.state === 'starting' ? 'Starting' : 'Thinking';

  // As Claude Code's panel draws it: the spinner and "Thinking…" beside it; a screen reader hears "Thinking". A turn that waits with nothing for
  // the operator to answer here stands still.
  return `<li class="working"><span class="working-icon codicon codicon-loading${session.state === 'waiting' ? '' : ' codicon-modifier-spin'}" aria-hidden="true"></span><span class="working-label" aria-hidden="true">${label}…</span><span role="status">${label}</span></li>`;
}

/**
 * The row at the end of the timeline while the session's turn has ended and its background agents or shell commands run, such as "3 agents
 * running", with the spinner, until they finish. A turn row, as for a message sent meanwhile, comes first. Empty otherwise.
 */
export function backgroundRow(session: SessionView | null): string {
  const background = session?.background ?? null;

  if (background === null) {
    return '';
  }

  const label = escape(backgroundLabel(background));

  return `<li class="working background"><span class="working-icon codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span><span class="working-label" aria-hidden="true">${label}</span><span role="status">${label}</span></li>`;
}

/**
 * The view's HTML: the header with the session's state, the tab strip, and the selected tab: the conversation, with a note when the view cannot
 * talk to the session, and the timeline; the status; or the artifacts.
 */
export function renderConversation(state: ConversationState, open: ReadonlySet<string> = new Set(), now: number = Date.now(), fresh = false, page: PageView = CONVERSATION_TAB): string {
  if (state.scope === null) {
    return `<p class="empty">${state.connected ? 'No Switchboard conversation in this window. Open a work item from the dock to work on it here.' : 'Connecting to Switchboard…'}</p>`;
  }

  const menu = page.menu ?? null;

  // A folder window with no conversation yet: the dropdown with the folder's name, whose New conversation… starts one (architecture.md § Conversation view).
  if (state.scope.workItemId === null) {
    return `<header class="header">${picker(state, open.has(PICKER), menu)}</header><p class="empty">No conversation in this folder yet. Start one with New conversation… in the menu above.</p>`;
  }

  // The header: the dropdown, the persona as an icon, and Open in terminal (voice-design report IA-1).
  const personaIcon = personaButton(state.session?.persona, menu?.kind === 'persona', state.session?.canPin === true);
  const persona = personaIcon === '' ? '' : `<div class="menu-anchor persona-anchor">${personaIcon}${menu?.kind === 'persona' ? headerMenu(menu) : ''}</div>`;
  const header = `<header class="header">${picker(state, open.has(PICKER), menu)}${persona}${state.session?.conversation === 'none' ? '' : '<button class="icon" data-action="terminal" title="Open in terminal" aria-label="Open in terminal"><span class="codicon codicon-terminal"></span></button>'}</header>`;
  // An ended session's reason sits just above the composer it disables, on every tab, with Resume; any other reason heads the conversation.
  // A Codex session that ended has no reason, since a message resumes it, but gets the note and Resume too.
  const ended = state.session?.state === 'ended';
  const notes = state.session?.reason == null || ended ? [] : [state.session.reason];
  const endedNote = !ended
    ? ''
    : `<div class="session-note" role="status"><span class="codicon codicon-stop-circle state-icon tone-muted" aria-hidden="true"></span><span class="session-note-text">${escape(state.session!.reason ?? 'The session has ended. A message or Resume continues it.')}</span>${state.session!.conversation === 'none' ? '' : '<button type="button" class="terminal-question-open" data-action="terminal" title="Resume the session in its terminal">Resume</button>'}</div>`;
  const shown = timeline(state.items, state.artifacts);
  // A card's answer is the first message after the reply or status that asks it, sent with Submit or typed (voice-design § 5), found in
  // conversation order, not the timeline's, where a rewrite takes the place of the reply it rewrote.
  const canAnswer = state.connected && state.session?.conversation === 'full';
  const links = viewLedger(state);
  const cardOf = (key: string): string => questionCard(key, links, state, page.cards?.get(key), canAnswer);
  // The turn's row after the newest item, so replies written mid-turn show above it; it has no data-id, so the keys skip it.
  const spinner = turnRow(state.session, inTurn(state.session) || awaitingReply(state.items, state.session)) || backgroundRow(state.session);
  // A turn starts at each message; the first item shown, and each turn that starts on another day than the turn before it, has a divider.
  // In conversation order, not by time, so an item dated before the ones above it, such as one still queued from days ago, starts no divider.
  let turnDay: number | null = null;
  const entries = shown.map((entry) => {
    if (entry.type === 'artifact') {
      return artifactRow(entry.artifact);
    }

    let divider = '';

    if (turnDay === null || entry.type === 'message') {
      const day = dayOf(entry.item.at);

      divider = turnDay === null || day > turnDay ? dayDivider(entry.item.at, now) : '';
      turnDay = turnDay === null ? day : Math.max(turnDay, day);
    }

    // A note has no time; the first item after a day's divider shows its time, and with message details on every item does (`stamped`).
    const timed = entry.type === 'message' || entry.item.kind !== 'note';
    const shownTime = stamped(timed, page.details === true, divider !== '');

    const card = entry.type === 'reply' && entry.item.kind === 'reply' ? cardOf(cardKey('reply', entry.item.id)) : '';

    return divider + (entry.type === 'message' ? message(entry.item, shownTime, page.details === true, links.answers.get(entry.item.id)) : reply(entry.item, entry.earlier, open, shownTime, card, state.settings.briefReplies, page.details === true));
  });
  // A Codex session's pending questions and approvals, answered in cards at the end of the conversation.
  const requests = (state.session?.requests ?? []).map((request) => requestCard(request, page.requests ?? NO_REQUESTS)).join('');
  const earlier = state.more ? '<button class="earlier-items" data-action="earlier">Show earlier messages</button>' : '';
  const body = state.session === null ? '<p class="empty">No session yet. Messages appear here once the work item\'s session starts.</p>' : entries.length === 0 && spinner === '' && requests === '' ? '<p class="empty">No messages yet. They appear here when you or the session write one.</p>' : `<ol class="timeline" tabindex="0" aria-label="Conversation">${entries.join('')}${requests}${spinner}</ol>`;

  const unopened = state.artifacts.filter((artifact) => page.unopened.has(artifact.path)).length;
  const tabs = renderTabs(page.tab, statusDot(state.status, fresh), unopened);
  const status = state.status;
  // Each tab's panel, and each conversation's, is its own node, so a redraw keeps its scroll position and another tab or conversation starts afresh.
  const shownKey = `${state.scope.scopeGen}-${state.session?.id ?? ''}`;
  // The New messages pill sits at the bottom of the conversation's own area, just above the composer, never behind it.
  const pill = `<button class="glass pill" type="button" data-action="pill"${page.pill === true ? '' : ' hidden'}><span class="pill-dot" aria-hidden="true"></span>New messages</button>`;
  const panel =
    page.tab === 'status'
      ? `<div class="panel" id="panel" data-key="status-${shownKey}" role="tabpanel" aria-labelledby="tab-status">${renderStatus(status, fresh, now, page.earlier ?? null)}</div>`
      : page.tab === 'artifacts'
        ? `<div class="panel" id="panel" data-key="artifacts-${shownKey}" role="tabpanel" aria-labelledby="tab-artifacts">${renderArtifacts(state.artifacts, page.unopened, now)}</div>`
        : `${notes.map((note) => `<p class="notice">${escape(note)}</p>`).join('')}<div class="scroll-area" data-key="conversation-${shownKey}"><div class="scroll" id="panel" role="tabpanel" aria-labelledby="tab-conversation">${earlier}${body}</div>${pill}</div>`;

  return `${header}${tabs}${panel}${endedNote}`;
}
