import MarkdownIt from 'markdown-it';
import type { ArtifactView, ItemView, MessageView, ReplyView, SessionView, StatusView, VoiceView } from '@switchboard/hub';
import { artifactIcon, awaitingReply, selectedEntry, stateIcon, statusLine, timeline } from '../conversationModel.js';
import type { ConversationState } from '../conversationModel.js';
import { answersIn, answerText, parseQuestions } from '../questionModel.js';
import type { Question, QuestionChoice } from '../questionModel.js';

/** What the page posts to the extension. */
export type ConversationMessage =
  | { type: 'ready' }
  | { type: 'earlier' }
  | { type: 'open'; href: string }
  | { type: 'terminal' }
  | { type: 'answer-request'; requestId: string; target: SeenTarget }
  | { type: 'select'; workItemId: number }
  | { type: 'talk-here' }
  | { type: 'stop-speaking' }
  | { type: 'speak-replies'; on: boolean }
  | { type: 'replay'; replyId: string }
  | { type: 'new' }
  | { type: 'persona' }
  | { type: 'send'; id: number; text: string; target: SendTarget; command?: true }
  | { type: 'files'; id: number; query: string }
  | { type: 'commands'; id: number }
  | { type: 'attach' }
  | { type: 'image'; id: number; mime: string; data: string }
  | { type: 'copy'; id: number; text: string }
  | { type: 'status-open' }
  | { type: 'statuses' }
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

/** The text of the first message after the reply a status came from, or after the status's time when that reply is not loaded; null for none. */
function statusAnswer(items: readonly ItemView[], status: StatusView): string | null {
  const from = items.findIndex((item) => item.type === 'reply' && `st-${item.id}` === status.id);
  const later = (from === -1 ? items.filter((item) => item.at > status.at) : items.slice(from + 1)).find((item) => item.type === 'message' && !item.withdrawn);

  return later?.type === 'message' ? later.text : null;
}

/** What a typed message's line under its box says (architecture.md § Conversation view). */
const DELIVERY = { open: 'sending', sent: 'sent', 'not-sent': 'not sent', uncertain: 'delivery unknown; check before resending' } as const;

/** A stamp's time, as Claude Code's panel shows it: "1:46 PM". */
const STAMP = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
/** A stamp's tooltip: "2026-11-19 13:46:05 EST". */
const STAMP_FULL = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const DAY_WITH_YEAR = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** The small time over a message or a reply. */
function stamp(at: number): string {
  return `<div class="stamp-line">${stampTime(at)}</div>`;
}

function stampTime(at: number): string {
  const parts = Object.fromEntries(STAMP_FULL.formatToParts(at).map((part) => [part.type, part.value]));
  const full = `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}:${parts['second']} ${parts['timeZoneName']}`;

  return `<time class="stamp" datetime="${new Date(at).toISOString()}" title="${escape(full)}">${STAMP.format(at)}</time>`;
}

/** The local calendar day of a time, to tell when a turn starts on another day. */
function dayOf(at: number): string {
  const date = new Date(at);

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** The divider before a turn that starts on another day than the turn before it, with the year only when it is not this year's. */
function dayDivider(at: number, now: number): string {
  const label = (new Date(at).getFullYear() === new Date(now).getFullYear() ? DAY : DAY_WITH_YEAR).format(at);

  return `<li class="day" role="separator">${escape(label)}</li>`;
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
 * One of our messages: its bubble under a line with its time, where the minute changes. Only an error state shows, before the time, with why in the
 * tooltip: a message sent or still sending shows only its time, and today none stays in error, since one not sent leaves the conversation.
 */
function message(item: MessageView, stamped: boolean): string {
  // Only an error state shows: a message sent or still sending shows only its time; one not sent has left the conversation.
  const state = item.origin === 'typed' && (item.delivery === 'not-sent' || item.delivery === 'uncertain') ? item.delivery : null;
  const why = item.error === null ? '' : ` · ${item.error}`;
  const delivery =
    state === null ? '' : `<span class="delivery ${state}" title="${escape(`${DELIVERY[state]}${why}`)}">${DELIVERY[state]}</span>`;
  // The state comes before the time, so every time stays flush right in one column.
  const line = stamped || delivery !== '' ? `<div class="stamp-line">${delivery}${stamped && delivery !== '' ? '<span class="stamp-dot" aria-hidden="true">•</span>' : ''}${stamped ? stampTime(item.at) : ''}</div>` : '';

  // A message sent in the terminal while the session was busy waits, dimmed, until Claude reads it.
  const queued = item.provisional && item.origin === 'terminal';

  return `<li class="message${item.provisional ? ' provisional' : ''}" data-id="${escape(item.id)}" tabindex="-1"${queued ? ' title="Sent; Claude has not read it yet"' : ''}>${line}<div class="box${COMMAND.test(item.text) ? ' command' : ''}">${escape(item.text)}</div></li>`;
}

/** A playback position as the view shows it: "0:07". */
function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** What became of a reply's speech, as a small line under it (architecture.md § Voice); empty when there is nothing to say. */
export function spokenLine(item: ReplyView): string {
  const line = (icon: string, text: string, kind: string): string => `<div class="spoken ${kind}"><span class="codicon codicon-${icon}" aria-hidden="true"></span><span>${escape(text)}</span></div>`;

  switch (item.spoken.state) {
    case 'playing':
      return line('unmute', 'Speaking', 'playing');
    case 'interrupted':
      return line('unmute', item.spoken.atMs === null ? 'interrupted' : `interrupted at ${clock(item.spoken.atMs)}`, 'interrupted');
    case 'stopped-moved':
      return line('mute', 'stopped: voice moved', 'stopped');
    case 'failed':
      return line('mute', 'not spoken: speech failed', 'failed');
    default:
      return '';
  }
}

/** The passage read aloud; while it plays or after it was cut short, the part not heard yet is dimmed, as plain text. */
function passageHtml(item: ReplyView, passage: string): string {
  const said = item.spoken.saidChars;

  if ((item.spoken.state !== 'playing' && item.spoken.state !== 'interrupted') || said === null) {
    return renderMarkdown(passage);
  }

  return `<p class="passage">${escape(passage.slice(0, said))}<span class="unheard">${escape(passage.slice(said))}</span></p>`;
}

/**
 * The composer footer's voice controls (architecture.md § Voice): Speak replies, Stop while this window's session speaks, and the voice's state,
 * which in a window that is not here offers Talk here; nothing while voice is off.
 */
export function renderVoiceControls(voice: VoiceView | null): string {
  if (voice === null || !voice.enabled) {
    return '';
  }

  const speakReplies = `<button class="ghost" type="button" data-voice="speak-replies" aria-pressed="${voice.speakReplies}" title="Speak replies: ${voice.speakReplies ? 'on' : 'off'}"><span class="codicon codicon-${voice.speakReplies ? 'unmute' : 'mute'}" aria-hidden="true"></span><span>Speak replies</span></button>`;
  const stop = voice.here && voice.speaking !== null ? '<button class="ghost" type="button" data-voice="stop" title="Stop speaking (Escape)"><span class="codicon codicon-debug-stop" aria-hidden="true"></span><span>Stop</span></button>' : '';
  const where = voice.here
    ? `<span class="voice-state">${voice.error === null ? 'Voice here' : escape(`Voice: ${voice.error}`)}</span>`
    : '<button class="ghost voice-elsewhere" type="button" data-voice="talk-here" title="Voice is not in this window. Click to talk here."><span class="codicon codicon-circle-slash" aria-hidden="true"></span><span>Voice is not in this window</span></button>';

  return `${speakReplies}${stop}${where}`;
}

/** The fold key of a reply's Show more, which flips its start, collapsed in focused mode or expanded with `voice.expandReplies`. */
export const moreKey = (id: string): string => `more:${id}`;

function reply(item: ReplyView, earlier: ReplyView | null, open: ReadonlySet<string>, stamped: boolean, card = '', expandReplies = false): string {
  if (item.kind === 'note') {
    return `<li class="note" data-id="${escape(item.id)}" tabindex="-1">${escape(item.opening)}</li>`;
  }

  // Focused mode (voice-design decision 21): a reply with a [speak] passage shows the passage first, the whole reply behind Show more.
  const passage = item.kind === 'reply' && item.speak !== null && item.speak.trim() !== '' ? item.speak : null;
  const folded = passage !== null && passage.trim() !== item.opening.trim();
  const expanded = !folded || expandReplies !== open.has(moreKey(item.id));
  const shown = passage !== null && !expanded ? passageHtml(item, passage) : renderMarkdown(item.opening);
  const more = folded
    ? `<button class="show-more" type="button" data-action="more" data-reply="${escape(item.id)}" aria-expanded="${expanded}">${expanded ? 'Show less' : 'Show more'}</button>`
    : '';
  const tone = item.tone === null ? '' : `<div class="tone" title="How the reply sounds when spoken">${escape(item.tone)}</div>`;

  const rewritten =
    earlier === null
      ? ''
      : `<details class="fold earlier" data-fold="earlier:${escape(item.id)}"${open.has(`earlier:${item.id}`) ? ' open' : ''}><summary>Rewritten</summary><div class="was">${renderMarkdown(earlier.opening)}</div></details>`;

  // A reply read off the screen has no copy button until its transcript copy replaces it, as Claude Code's has none while it streams.
  const actions = item.provisional ? '' : `<div class="actions">${copyButton('copy-reply', 'Copy response')}</div>`;

  // An unread reply's dot takes the badge colour until the view has shown it in a focused window for a second (architecture.md § Unread).
  const unread = item.unread ? ` unread" data-unread="${escape(item.id)}` : '';
  const dot = item.unread ? '<span class="dot" title="Unread"><span class="unread-label">Unread</span></span>' : '<span class="dot"></span>';

  return `<li class="reply ${item.kind}${unread}" data-id="${escape(item.id)}"${passage === null ? '' : ' data-speak="1"'} tabindex="-1">${stamped ? stamp(item.at) : ''}${dot}${tone}<div class="body">${shown}${more}${rewritten}</div>${spokenLine(item)}${card}${actions}</li>`;
}

/** What the page keeps of a question card the operator has not answered yet: the choices made, and the answer being sent or refused. */
export interface CardDraft {
  choices: Map<number, QuestionChoice>;
  /** The text sent with Submit, until the message shows in the conversation or comes back not sent. */
  sent: string | null;
  /** The work item whose conversation the answer was sent in. */
  workItemId: number | null;
  sending: boolean;
  error: string | null;
}

/** A card's key: the reply or the status that asks its questions. */
export function cardKey(kind: 'reply' | 'status', id: string): string {
  return `${kind}:${id}`;
}

/** Whether every question has a pick or Other text, as Claude Code's form asks before Submit, since any later message answers the whole card. */
export function complete(questions: readonly Question[], choices: ReadonlyMap<number, QuestionChoice>): boolean {
  return questions.every((_question, index) => (choices.get(index)?.letters.length ?? 0) > 0 || (choices.get(index)?.other.trim() ?? '') !== '');
}

/** Inline Markdown, as a reply's, for a question or an option. */
function inlineMarkdown(text: string): string {
  return markdown.renderInline(text).replace(/<a href="([^"]*)"/g, (_match, href: string) => `<a href="#" data-href="${href}"`);
}

/**
 * A question card (architecture.md § Conversation view), in the style of Claude Code's question form: each question in the foreground, its options
 * as rows with a radio mark, or a checkbox where it takes several, the letter dimmed before the text, an Other field, and Submit. Answered, by
 * Submit or by any later message, it greys out and shows the choices that message gave. It takes no answer while the composer could not send.
 */
export function questionCard(key: string, questions: readonly Question[], draft: CardDraft | undefined, answer: string | null, canAnswer: boolean): string {
  const answered = answer !== null;
  const choices = answered ? answersIn(answer, questions) : (draft?.choices ?? new Map<number, QuestionChoice>());
  const locked = answered || !canAnswer || draft?.sending === true || draft?.sent != null;
  const blocks = questions.map((question, index) => {
    const choice = choices.get(index);
    const multi = question.multi;
    const label = question.number === null ? '' : `<span class="question-number">${question.number}.</span> `;
    const options = question.options
      .map((option) => {
        const checked = choice?.letters.includes(option.letter) ?? false;
        const mark = multi ? `<span class="question-mark checkbox${checked ? ' checked' : ''}" aria-hidden="true">${checked ? '<span class="codicon codicon-check"></span>' : ''}</span>` : `<span class="question-mark radio${checked ? ' checked' : ''}" aria-hidden="true">${checked ? '<span class="radio-dot"></span>' : ''}</span>`;
        const name = `${question.number === null ? '' : question.number}${option.letter}`;

        return (
          `<button type="button" class="question-option${checked ? ' checked' : ''}${answered && !checked ? ' dimmed' : ''}" role="${multi ? 'checkbox' : 'radio'}" aria-checked="${checked}" data-action="pick" data-card="${escape(key)}" data-question="${index}" data-letter="${option.letter}"${locked ? ' disabled' : ''} title="${escape(`Answer ${name}`)}">` +
          `${mark}<span class="question-option-text"><span class="question-letter">${option.letter}</span> ${inlineMarkdown(option.text)}</span></button>`
        );
      })
      .join('');
    const given = answered && choice !== undefined && choice.other !== '' ? `<div class="question-answer-other"><span class="question-letter">Other:</span> ${escape(choice.other)}</div>` : '';
    const other = answered || !canAnswer ? given : `<input class="question-other" type="text" data-card="${escape(key)}" data-question="${index}" placeholder="Other…" aria-label="${escape(`Other answer${question.number === null ? '' : ` to question ${question.number}`}`)}" value="${escape(choice?.other ?? '')}"${locked ? ' disabled' : ''}>`;

    return `<div class="question-block"><div class="question-text">${label}${inlineMarkdown(question.text)}</div><div class="question-options" role="${multi ? 'group' : 'radiogroup'}">${options}${other}</div></div>`;
  });
  const text = complete(questions, choices) ? answerText(questions, choices) : '';
  const footer = answered
    ? '<div class="question-footer"><span class="question-state">Answered</span></div>'
    : !canAnswer
      ? ''
      : `<div class="question-footer">${draft?.error == null ? '' : `<span class="question-error" role="alert">${escape(draft.error)}</span>`}<button type="button" class="question-submit" data-action="answer" data-card="${escape(key)}"${locked || text === '' ? ' disabled' : ''} title="${escape(text === '' ? 'Answer every question first' : `Send "${text}"`)}">${draft?.sending === true || draft?.sent != null ? 'Sending…' : 'Submit'}</button></div>`;

  return `<div class="question-card${answered ? ' answered' : ''}" data-card="${escape(key)}" role="group" aria-label="${answered ? 'Questions, answered' : 'Questions'}">${blocks.join('')}${footer}</div>`;
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
}

const CONVERSATION_TAB: PageView = { tab: 'conversation', unopened: new Set() };

/** A status's time on the Status tab: "Thu, Nov 19, 1:46 PM". */
const STATUS_TIME = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** An age that the page redraws every 30 seconds. */
function age(at: number, now: number, className: string): string {
  return `<time class="${className} age" data-at="${at}" datetime="${new Date(at).toISOString()}">${ago(at, now)}</time>`;
}

/** Whether the Status tab's badge shows: the latest status is New, or unread (architecture.md § Unread); never the stage. */
export function statusBadge(status: StatusView | null, fresh: boolean): boolean {
  return status !== null && !status.fallback && (fresh || status.unread);
}

/**
 * The Status tab (architecture.md § Statuses): the session's latest status as Markdown under a line with its time, how long ago, a New mark while
 * `fresh`, and the buttons that open it and the earlier statuses in the Markdown preview. Before the first status, the work item's stage, dimmed;
 * with neither, a line that says so.
 */
export function renderStatus(status: StatusView | null, fresh: boolean, now: number, card = ''): string {
  if (status === null) {
    return '<p class="empty">The session has posted no status yet. Ask it for one, and its latest shows here.</p>';
  }

  if (status.fallback) {
    return (
      '<div class="status-tab fallback"><p class="empty">The session has posted no status yet. Until it does, the work item\'s stage:</p>' +
      `<div class="status-head"><span class="codicon codicon-pulse" aria-hidden="true"></span><span class="status-label">Stage</span><span class="status-dot" aria-hidden="true">·</span>${age(status.at, now, 'status-age')}</div>` +
      `<div class="status-body body">${renderMarkdown(status.markdown)}</div></div>`
    );
  }

  const mark = fresh ? '<span class="status-new">New</span>' : '';
  const actions =
    '<span class="status-actions"><button class="icon" type="button" data-action="status-open" title="Open in the Markdown preview" aria-label="Open the status in the Markdown preview"><span class="codicon codicon-open-preview" aria-hidden="true"></span></button>' +
    '<button class="icon" type="button" data-action="statuses" title="Earlier statuses" aria-label="Earlier statuses"><span class="codicon codicon-history" aria-hidden="true"></span></button></span>';
  const time = `<span class="status-time" title="${escape(new Date(status.at).toString())}">${escape(STATUS_TIME.format(status.at))}</span>`;
  const unread = status.unread ? ` unread" data-unread="${escape(status.id)}` : '';

  return (
    `<div class="status-tab${fresh ? ' fresh' : ''}${unread}" role="region" aria-label="${unread === '' ? 'Status' : 'Status, unread'}">` +
    `<div class="status-head"><span class="codicon codicon-pulse" aria-hidden="true"></span>${time}<span class="status-dot" aria-hidden="true">·</span>${age(status.at, now, 'status-age')}${mark}${actions}</div>` +
    `<div class="status-body body">${renderMarkdown(status.markdown)}</div>${card}</div>`
  );
}

/**
 * The Artifacts tab (architecture.md § Artifacts): the work item's artifacts newest first, each a row with its type's codicon, title, kind and age,
 * marked while new or changed since last opened in the workspace; a click opens it natively.
 */
export function renderArtifacts(artifacts: readonly ArtifactView[], unopened: ReadonlySet<string>, now: number): string {
  if (artifacts.length === 0) {
    return "<p class=\"empty\">The session's artifacts show here as it writes them: plans, reports, comparisons, diagrams, pages and media.</p>";
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

/** The tab strip, as VS Code's panel tabs: the selected tab underlined; Status with a New badge, Artifacts with the count of new or changed ones. */
function renderTabs(selected: Tab, badges: Record<Tab, string>): string {
  const tabs = TABS.map(({ tab, label }) => {
    const badge = badges[tab] === '' ? '' : `<span class="tab-badge">${escape(badges[tab])}</span>`;
    const name = badges[tab] === '' ? label : `${label}, ${tab === 'status' ? 'new status' : `${badges[tab]} new or changed`}`;

    return `<button class="tab${tab === selected ? ' selected' : ''}" type="button" role="tab" id="tab-${tab}" data-tab="${tab}" aria-selected="${tab === selected}" aria-controls="panel" aria-label="${escape(name)}" tabindex="${tab === selected ? 0 : -1}"><span class="tab-label">${label}</span>${badge}</button>`;
  });

  return `<nav class="tabs" role="tablist" aria-label="Switchboard">${tabs.join('')}</nav>`;
}

/** The fold key of the header's conversation list, which the page opens and closes. */
export const PICKER = 'conversations';

/** A state's codicon with its text for a screen reader. */
function codicon({ icon, text }: { icon: string; text: string }): string {
  const [name, modifier] = icon.split('~');

  return `<span class="codicon codicon-${name}${modifier === undefined ? '' : ` codicon-modifier-${modifier}`}" title="${escape(text)}" aria-label="${escape(text)}"></span>`;
}

/**
 * The header's conversation dropdown (architecture.md § Conversation view): the selected conversation's title, which opens the list of the
 * window's conversations, the primary work item first, each with its session's state and its unread count.
 */
function picker(state: ConversationState, open: boolean): string {
  const scope = state.scope!;
  const title = selectedEntry(state)?.title ?? scope.title;
  const options = scope.conversations
    .map((entry) => {
      const selected = entry.workItemId === scope.workItemId;
      const unread = entry.unread > 0 ? `<span class="count" title="${entry.unread} unread">${entry.unread}</span>` : '';
      const icon = codicon(stateIcon(entry.state === null ? null : ({ state: entry.state, waitingFor: null } as never)));

      return `<li role="option" aria-selected="${selected}"><button type="button" data-action="select" data-work-item="${entry.workItemId}"${selected ? ' class="selected"' : ''}>${icon}<span class="title">${escape(entry.title)}</span>${unread}</button></li>`;
    })
    .join('');

  return `<button type="button" class="picker" data-action="picker" aria-haspopup="listbox" aria-expanded="${open}" title="${escape(title)}"><span class="title">${escape(title)}</span><span class="codicon codicon-chevron-down" aria-hidden="true"></span></button>${open ? `<ul class="conversation-list" role="listbox" aria-label="Conversations">${options}</ul>` : ''}`;
}

/**
 * The header's persona button (architecture.md § Personas): the session's persona's name, which opens the list to pin another; nothing for a
 * session with none.
 */
export function personaButton(persona: SessionView['persona'] | undefined): string {
  if (persona == null) {
    return '';
  }

  const title = [`Persona: ${persona.name}${persona.pinned ? ', pinned to this session' : ''}.`, persona.tonePending ? 'Its tone changes when the session next resumes or compacts.' : '', 'Click to choose another.'].filter((part) => part !== '').join(' ');

  return `<button type="button" class="persona${persona.tonePending ? ' pending' : ''}" data-action="persona" title="${escape(title)}" aria-label="${escape(title)}"><span class="codicon codicon-${persona.pinned ? 'pinned' : 'person'}" aria-hidden="true"></span><span class="name">${escape(persona.name)}</span></button>`;
}

/**
 * The view's HTML: the header with the session's state, the tab strip, and the selected tab: the conversation, with a note when the view cannot
 * talk to the session, and the timeline; the status; or the artifacts.
 */
export function renderConversation(state: ConversationState, open: ReadonlySet<string> = new Set(), now: number = Date.now(), fresh = false, page: PageView = CONVERSATION_TAB): string {
  if (state.scope === null) {
    return `<p class="empty">${state.connected ? 'This window has no Switchboard session.' : 'Connecting to Switchboard…'}</p>`;
  }

  const plus = '<button class="icon" data-action="new" title="New session" aria-label="New session"><span class="codicon codicon-add"></span></button>';

  // A folder window with no conversation yet: the folder's name and the plus, which starts one (architecture.md § Conversation view).
  if (state.scope.workItemId === null) {
    return `<header class="header"><span class="title" title="${escape(state.scope.title)}">${escape(state.scope.title)}</span>${plus}</header><p class="empty">No Switchboard session in this folder yet.</p>`;
  }

  const header = `<header class="header">${codicon(stateIcon(state.session))}${picker(state, open.has(PICKER))}${personaButton(state.session?.persona)}${plus}${state.session?.conversation === 'none' ? '' : '<button class="icon" data-action="terminal" title="Open in terminal" aria-label="Open in terminal"><span class="codicon codicon-terminal"></span></button>'}</header>`;
  const notes = state.session?.reason == null ? [] : [state.session.reason];
  const shown = timeline(state.items, state.artifacts);
  // A card's answer is the first message after the reply or status that asks it, sent with Submit or typed (voice-design § 5).
  const canAnswer = state.connected && state.session?.conversation === 'full';
  // Found in conversation order, not the timeline's, where a rewrite takes the place of the reply it rewrote.
  const answerAfter = (replyId: string): string | null => {
    const later = state.items.slice(state.items.findIndex((item) => item.id === replyId) + 1).find((item) => item.type === 'message' && !item.withdrawn);

    return later?.type === 'message' ? later.text : null;
  };
  const cardOf = (key: string, markdown: string, answer: string | null): string => {
    const questions = parseQuestions(markdown);

    return questions.length === 0 ? '' : questionCard(key, questions, page.cards?.get(key), answer, canAnswer);
  };
  const waiting = awaitingReply(state.items, shown, state.session);
  // While the session works on a reply, a spinner under the operator's latest message; it has no data-id, so the keys skip it.
  // While the session waits on a question or a permission, it stands still.
  const spin = state.session?.state === 'waiting' ? '' : ' codicon-modifier-spin';
  // As Claude Code's panel draws it: the spinner and "Thinking…" beside it; a screen reader hears "Thinking".
  const spinner = `<li class="working"><span class="working-icon codicon codicon-loading${spin}" aria-hidden="true"></span><span class="working-label" aria-hidden="true">Thinking…</span><span role="status">Thinking</span></li>`;
  // A turn starts at each message; one that starts on another day than the turn before it has a divider, as in Claude Code's panel.
  let turnDay: string | null = null;
  // A time shows only where the minute changes from the item before, so a message and the reply to it in the same minute read as one exchange.
  let lastMinute: string | null = null;
  const entries = shown.map((entry, index) => {
    if (entry.type === 'artifact') {
      return artifactRow(entry.artifact) + (index === waiting ? spinner : '');
    }

    let divider = '';

    if (index === 0 || entry.type === 'message') {
      const day = dayOf(entry.item.at);

      divider = turnDay !== null && day !== turnDay ? dayDivider(entry.item.at, now) : '';
      turnDay = day;
    }

    // A note has no time, and does not count as the item before.
    const timed = entry.type === 'message' || entry.item.kind !== 'note';
    const minute = `${dayOf(entry.item.at)} ${STAMP.format(entry.item.at)}`;
    const stamped = timed && (minute !== lastMinute || divider !== '');

    if (timed) {
      lastMinute = minute;
    }

    const card = entry.type === 'reply' && entry.item.kind === 'reply' ? cardOf(cardKey('reply', entry.item.id), entry.item.opening, answerAfter(entry.item.id)) : '';

    return divider + (entry.type === 'message' ? message(entry.item, stamped) : reply(entry.item, entry.earlier, open, stamped, card, state.settings.expandReplies)) + (index === waiting ? spinner : '');
  });
  const earlier = state.more ? '<button class="earlier-items" data-action="earlier">Show earlier messages</button>' : '';
  const body = state.session === null ? '<p class="empty">No session has started yet.</p>' : entries.length === 0 ? '<p class="empty">No messages yet.</p>' : `<ol class="timeline" tabindex="0" aria-label="Conversation">${entries.join('')}</ol>`;

  const unopened = state.artifacts.filter((artifact) => page.unopened.has(artifact.path)).length;
  const tabs = renderTabs(page.tab, { conversation: '', status: statusBadge(state.status, fresh) ? 'New' : '', artifacts: unopened === 0 ? '' : String(unopened) });
  const status = state.status;
  const statusCard = status === null || status.fallback ? '' : cardOf(cardKey('status', status.id), status.markdown, statusAnswer(state.items, status));
  // While an AskUserQuestion menu holds the session, the view says so: the menu is answered in the terminal (voice-design § 5).
  const requests = state.session?.requests ?? [];
  const asking = requests.length > 0
    ? requests.map(request => `<div class="terminal-question" role="status"><span class="terminal-question-text">${escape(request.title)}</span><button type="button" data-action="answer-request" data-request="${escape(request.id)}">${request.kind === 'unsupported' ? 'Open in terminal' : request.kind === 'permission' ? 'Review permission' : 'Answer'}</button></div>`).join('')
    : state.session?.state === 'waiting' && state.session.waitingFor === 'question'
      ? `<div class="terminal-question" role="status"><span class="codicon codicon-question" aria-hidden="true"></span><span class="terminal-question-text">${state.session.provider === 'codex' ? 'Codex' : 'Claude'} is waiting for an answer in the terminal</span><button type="button" class="terminal-question-open" data-action="terminal">Open in terminal</button></div>`
      : '';
  const panel =
    page.tab === 'status'
      ? `<div class="panel" id="panel" role="tabpanel" aria-labelledby="tab-status">${renderStatus(status, fresh, now, statusCard)}</div>`
      : page.tab === 'artifacts'
        ? `<div class="panel" id="panel" role="tabpanel" aria-labelledby="tab-artifacts">${renderArtifacts(state.artifacts, page.unopened, now)}</div>`
        : `${notes.map((note) => `<p class="notice">${escape(note)}</p>`).join('')}<div class="scroll" id="panel" role="tabpanel" aria-labelledby="tab-conversation">${earlier}${body}</div>${asking}`;

  return `${header}${tabs}${panel}`;
}
