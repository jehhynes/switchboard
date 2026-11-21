import { providerMark } from '@switchboard/conversation/providerIcons';
import { artifactIcon, awaitingReply, selectedEntry, stateIcon, timeline } from './model.js';
import type { PageState } from './model.js';
import { copyButton, escape, renderInline, renderMarkdown } from './markdown.js';
import { answers, answersIn, answerText, cardOutcome, complete, parseQuestions, questionSegments } from '@switchboard/conversation/questions';
import type { Question, QuestionChoice } from '@switchboard/conversation/questions';
import type { ArtifactView, MessageView, NativeRequest, PageGroup, ReplyView, StatusView, VoiceView } from './types.js';

export type Tab = 'conversation' | 'status' | 'artifacts';
export const TABS: Array<{ tab: Tab; label: string }> = [
  { tab: 'conversation', label: 'Conversation' },
  { tab: 'status', label: 'Status' },
  { tab: 'artifacts', label: 'Artifacts' },
];

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
}

export const newView = (): View => ({ tab: 'conversation', open: new Set(), picker: false, cards: new Map(), artifact: null, requestValues: new Map(), personas: null });

const STAMP = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
/** A time's tooltip, as the VS Code view's: "2026-11-19 13:46:05 EST". */
const STAMP_FULL = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const DAY_WITH_YEAR = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** A day as its divider names it: "Today", "Yesterday", the weekday and date this year, or the full date with the year. */
export function dayLabel(at: number, now: number): string {
  const midnight = (time: number): number => new Date(new Date(time).getFullYear(), new Date(time).getMonth(), new Date(time).getDate()).getTime();
  // Rounded, since a day with a daylight saving change is 23 or 25 hours long.
  const days = Math.round((midnight(now) - midnight(at)) / 86_400_000);

  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : (new Date(at).getFullYear() === new Date(now).getFullYear() ? DAY : DAY_WITH_YEAR).format(at);
}

function codicon({ icon, text }: { icon: string; text: string }): string {
  const [name, modifier] = icon.split('~');

  return `<span class="codicon codicon-${name}${modifier === undefined ? '' : ` codicon-modifier-${modifier}`}" title="${escape(text)}" role="img" aria-label="${escape(text)}"></span>`;
}

function stampTime(at: number): string {
  const parts = Object.fromEntries(STAMP_FULL.formatToParts(at).map((part) => [part.type, part.value]));
  const full = `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}:${parts['second']} ${parts['timeZoneName']}`;

  return `<time class="stamp" datetime="${new Date(at).toISOString()}" title="${escape(full)}">${STAMP.format(at)}</time>`;
}

/** How long ago, in the largest whole unit: "just now", "4 min ago", "2 h ago", "3 d ago". */
export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);

  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
}

/**
 * The page's list (architecture.md § Web page): each group's work items, a hosted conversation under its host, each with its session's state
 * and unread count; a folder's or window's group under its name.
 */
export function renderList(groups: readonly PageGroup[], selected: number | null): string {
  if (groups.length === 0) {
    return '<p class="empty">No work items yet. They appear here when Switchboard starts one.</p>';
  }

  const row = (entry: PageGroup['conversations'][number], hosted: boolean): string => {
    const unread = entry.unread > 0 ? `<span class="count" title="${entry.unread} unread">${entry.unread}</span>` : '';

    return `<li><button type="button" class="list-item${hosted ? ' hosted' : ''}${entry.workItemId === selected ? ' selected' : ''}" data-action="select" data-work-item="${entry.workItemId}" aria-current="${entry.workItemId === selected}">${codicon(stateIcon(entry.state))}<span class="title" title="${escape(entry.title)}">${escape(entry.title)}</span>${unread}</button></li>`;
  };
  const html = groups.map((group) => {
    const rows = group.conversations.map((entry, index) => row(entry, group.kind !== 'item' || index > 0)).join('');
    const label = group.kind === 'item' ? '' : `<div class="group-title"><span class="codicon codicon-${group.kind === 'folder' ? 'folder' : 'window'}" aria-hidden="true"></span>${escape(group.title)}</div>`;

    return `<li class="group">${label}<ul>${rows}</ul></li>`;
  });

  return `<ul class="work-list" aria-label="Work items">${html.join('')}</ul>`;
}

/** The header: the dropdown of the selected work item's conversations, showing the session's state as its options do, its provider, and its persona. */
export function renderHeader(state: PageState, view: View): string {
  const scope = state.scope!;
  const title = selectedEntry(state)?.title ?? scope.title;
  const options = scope.conversations
    .map((entry) => {
      const selected = entry.workItemId === scope.workItemId;
      const unread = entry.unread > 0 ? `<span class="count">${entry.unread}</span>` : '';

      return `<li role="option" aria-selected="${selected}"><button type="button" data-action="select" data-work-item="${entry.workItemId}"${selected ? ' class="selected"' : ''}>${codicon(stateIcon(entry.state))}<span class="title">${escape(entry.title)}</span>${providerMark(entry.provider)}${unread}</button></li>`;
    })
    .join('');
  const persona = state.session?.persona;
  const personaButton =
    persona == null
      ? ''
      : `<button type="button" class="persona${persona.tonePending ? ' pending' : ''}" data-action="persona" aria-haspopup="menu" aria-expanded="${view.personas !== null}" title="${escape(`Persona: ${persona.name}${persona.pinned ? ', pinned' : ''}. Click to choose another.`)}"><span class="codicon codicon-${persona.pinned ? 'pinned' : 'person'}" aria-hidden="true"></span><span class="name">${escape(persona.name)}</span></button>`;
  const picker = `<button type="button" class="picker" data-action="picker" aria-haspopup="listbox" aria-expanded="${view.picker}" title="${escape(title)}">${codicon(stateIcon(state.session?.state, state.session?.waitingFor, state.session?.limit))}<span class="title">${escape(title)}</span><span class="codicon codicon-chevron-down" aria-hidden="true"></span></button>${view.picker ? `<ul class="conversation-list" role="listbox" aria-label="Conversations">${options}</ul>` : ''}`;

  const menu = view.personas;
  const rows =
    menu === null
      ? ''
      : menu.error !== null
        ? `<li class="menu-note">${escape(menu.error)}</li>`
        : menu.items === null
          ? '<li class="menu-note">Loading…</li>'
          : [...menu.items.map((one) => `<li><button type="button" role="menuitem" data-action="persona-pick" data-persona="${escape(one.id)}"${persona?.id === one.id ? ' class="selected"' : ''}>${escape(one.name)}</button></li>`), persona?.pinned === true ? '<li><button type="button" role="menuitem" data-action="persona-pick" data-persona="">Clear pin</button></li>' : ''].join('');
  const personaMenu = menu === null ? '' : `<ul class="conversation-list persona-list" role="menu" aria-label="Persona">${rows}</ul>`;

  return `<header class="header">${picker}${providerMark(state.session?.provider)}${personaButton}${personaMenu}</header>`;
}

export function renderTabs(view: View, state: PageState): string {
  const fresh = state.status?.unread === true;
  const badges: Record<Tab, string> = { conversation: state.unread > 0 && !fresh ? String(state.unread) : '', status: fresh ? 'New' : '', artifacts: '' };

  return `<nav class="tabs" role="tablist">${TABS.map(({ tab, label }) => `<button class="tab${tab === view.tab ? ' selected' : ''}" type="button" role="tab" data-tab="${tab}" aria-selected="${tab === view.tab}" tabindex="${tab === view.tab ? 0 : -1}">${label}${badges[tab] === '' ? '' : `<span class="tab-badge">${badges[tab]}</span>`}</button>`).join('')}</nav>`;
}

function message(item: MessageView, stamped: boolean): string {
  const failed = item.delivery === 'uncertain' ? `<span class="delivery uncertain" title="${escape(item.error ?? '')}">uncertain</span>` : '';
  const line = stamped || failed !== '' ? `<div class="stamp-line">${failed}${stamped ? stampTime(item.at) : ''}</div>` : '';

  return `<li class="message${item.provisional ? ' provisional' : ''}" data-id="${escape(item.id)}">${line}<div class="box${/^\/[\w:.-]+(\s|$)/.test(item.text) ? ' command' : ''}">${escape(item.text)}</div></li>`;
}

/** A note under a reply whose speech failed; empty otherwise, since routine speech states show nothing. */
function spokenLine(item: ReplyView): string {
  return item.spoken.state === 'failed'
    ? '<div class="spoken failed" title="Speaking this reply failed; see the voice log."><span class="codicon codicon-mute" aria-hidden="true"></span><span>Not spoken</span></div>'
    : '';
}

/** The passage read aloud; after the operator spoke over it, the part not heard is dimmed, as plain text. */
function passageHtml(item: ReplyView, passage: string): string {
  const said = item.spoken.saidChars;

  if (item.spoken.state !== 'interrupted' || said === null) {
    return renderMarkdown(passage);
  }

  return `<p class="passage">${escape(passage.slice(0, said))}<span class="unheard">${escape(passage.slice(said))}</span></p>`;
}

function reply(item: ReplyView, earlier: ReplyView | null, view: View, stamped: boolean, card: string, expandReplies: boolean): string {
  if (item.kind === 'note') {
    return `<li class="note" data-id="${escape(item.id)}">${escape(item.opening)}</li>`;
  }

  // Focused mode: a reply with a [speak] passage shows the passage first and the whole reply behind Show more.
  const passage = item.kind === 'reply' && item.speak !== null && item.speak.trim() !== '' && item.speak.trim() !== item.opening.trim() ? item.speak : null;
  const expanded = passage === null || expandReplies !== view.open.has(`more:${item.id}`);
  const body = !expanded && passage !== null ? passageHtml(item, passage) : card === '' ? renderMarkdown(item.opening) : withoutQuestions(item.opening, `reply:${item.id}`, view.open);
  const more = passage === null ? '' : `<button class="show-more" type="button" data-action="more" data-reply="${escape(item.id)}" aria-expanded="${expanded}">${expanded ? 'Show less' : 'Show more'}</button>`;
  const tone = item.tone === null ? '' : `<div class="tone">${escape(item.tone)}</div>`;
  const rewritten = earlier === null ? '' : `<details class="fold" data-fold="earlier:${escape(item.id)}"${view.open.has(`earlier:${item.id}`) ? ' open' : ''}><summary>Rewritten</summary><div class="was">${renderMarkdown(earlier.opening)}</div></details>`;
  const actions = item.provisional ? '' : `<div class="actions">${copyButton('copy-reply', 'Copy response')}</div>`;
  const unread = item.unread ? ` unread" data-unread="${escape(item.id)}` : '';

  return `<li class="reply ${item.kind}${unread}" data-id="${escape(item.id)}"${item.speak === null ? '' : ' data-speak="1"'}>${stamped ? `<div class="stamp-line">${stampTime(item.at)}</div>` : ''}<span class="dot"${item.unread ? ' title="Unread"' : ''}></span>${tone}<div class="body">${body}${more}${rewritten}</div>${spokenLine(item)}${card}${actions}</li>`;
}

function artifactRow(artifact: ArtifactView): string {
  return `<li class="artifact"><button class="artifact-open" type="button" data-action="artifact" data-path="${escape(artifact.path)}" title="${escape(artifact.path)}"><span class="codicon codicon-${artifactIcon(artifact.type)}" aria-hidden="true"></span><span class="artifact-title">${escape(artifact.title)}</span><span class="artifact-kind">${escape(artifact.kind)}</span></button></li>`;
}

/**
 * A reply's or a status's Markdown when its card draws its questions: questions that end it are left out; questions with text after them stay
 * in place, folded into one line, "2 questions — answer below", that opens them.
 */
export function withoutQuestions(markdown: string, key: string, open: ReadonlySet<string>): string {
  const segments = questionSegments(markdown);

  if (segments === null) {
    return renderMarkdown(markdown);
  }

  // The last run of questions, when only blank lines follow it, ends the message as the rules ask, and the card alone shows it.
  const last = segments.reduce((found, segment, index) => (segment.questions > 0 ? index : found), -1);
  const ending = segments.slice(last + 1).every((segment) => segment.text.trim() === '');

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

/** A question card: each question with its options as radio or checkbox rows, an Other field, and Submit; greyed with its picks once answered. */
export function questionCard(key: string, questions: readonly Question[], draft: CardDraft | undefined, answer: string | null, canAnswer: boolean): string {
  // A later message answers the card only when it answers its questions; one that ignores them sets it aside, Skipped, with no picks.
  const outcome = cardOutcome(answer, questions);
  const answered = outcome !== null;
  const choices = outcome === 'answered' ? answersIn(answer!, questions) : answered ? new Map<number, QuestionChoice>() : (draft?.choices ?? new Map<number, QuestionChoice>());
  const locked = answered || !canAnswer || draft?.sending === true || draft?.sent != null;
  const blocks = questions.map((question, index) => {
    const choice = choices.get(index);
    const options = question.options
      .map((option) => {
        const checked = choice?.letters.includes(option.letter) ?? false;
        const mark = question.multi
          ? `<span class="question-mark checkbox${checked ? ' checked' : ''}" aria-hidden="true">${checked ? '<span class="codicon codicon-check"></span>' : ''}</span>`
          : `<span class="question-mark radio${checked ? ' checked' : ''}" aria-hidden="true">${checked ? '<span class="radio-dot"></span>' : ''}</span>`;

        return `<button type="button" class="question-option${answered && !checked ? ' dimmed' : ''}" role="${question.multi ? 'checkbox' : 'radio'}" aria-checked="${checked}" data-action="pick" data-card="${escape(key)}" data-question="${index}" data-letter="${option.letter}"${locked ? ' disabled' : ''}>${mark}<span class="question-option-text"><span class="question-letter">${option.letter}</span> ${renderInline(option.text)}</span></button>`;
      })
      .join('');
    const other = answered || !canAnswer ? (choice?.other ? `<div class="question-answer-other">Other: ${escape(choice.other)}</div>` : '') : `<input class="question-other" type="text" data-card="${escape(key)}" data-question="${index}" placeholder="Other…" value="${escape(choice?.other ?? '')}"${locked ? ' disabled' : ''}>`;

    return `<div class="question-block"><div class="question-text">${question.number === null ? '' : `${question.number}. `}${renderInline(question.text)}</div><div class="question-options">${options}${other}</div></div>`;
  });
  const footer = answered
    ? `<span class="question-state">${outcome === 'answered' ? 'Answered' : 'Skipped: your next message did not answer these questions'}</span>`
    : !canAnswer
      ? ''
      : `${draft?.error ? `<span class="question-error">${escape(draft.error)}</span>` : ''}${draft?.sent != null ? '<span class="question-state">Sending…</span>' : ''}<button type="button" class="question-submit" data-action="answer" data-card="${escape(key)}"${locked || !complete(questions, choices) ? ' disabled' : ''}>Submit</button>`;

  return `<div class="question-card${answered ? ` ${outcome}` : ''}" data-card-key="${escape(key)}">${blocks.join('')}<div class="question-footer">${footer}</div></div>`;
}

/** The card of a reply's or a status's questions, answered by the first message after it; empty without questions. */
function cardOf(key: string, markdown: string, answer: string | null, view: View, canAnswer: boolean): string {
  const questions = parseQuestions(markdown);

  return questions.length === 0 ? '' : questionCard(key, questions, view.cards.get(key), answer, canAnswer);
}

/** The text of the first message after a reply, which answers its card. */
function answerAfter(state: PageState, replyId: string): string | null {
  const from = state.items.findIndex((item) => item.id === replyId);
  const later = from === -1 ? undefined : state.items.slice(from + 1).find((item) => item.type === 'message' && answers(item));

  return later?.type === 'message' ? later.text : null;
}

/** The Conversation tab: why the page cannot talk to the session, earlier messages, and the timeline with its spinner. */
export function renderTimeline(state: PageState, view: View, now: number = Date.now()): string {
  if (state.session === null) {
    return '<p class="empty">No session yet. Messages appear here once the work item\'s session starts.</p>';
  }

  const entries = timeline(state.items, state.artifacts);
  const canAnswer = state.connected && state.session.conversation === 'full';
  // After the newest item, so replies written mid-turn show above it.
  const spinner = turnRow(state.session, awaitingReply(state.items, state.session));
  let lastMinute: string | null = null;
  let lastDay: string | null = null;
  const rows = entries.map((entry) => {
    if (entry.type === 'artifact') {
      return artifactRow(entry.artifact);
    }

    // The first item shown, and each turn that starts on another day than the turn before it, has a divider.
    const day = new Date(entry.item.at).toDateString();
    const divider = day !== lastDay && (lastDay === null || entry.type === 'message') ? `<li class="day" role="separator">${escape(dayLabel(entry.item.at, now))}</li>` : '';

    lastDay = entry.type === 'message' || lastDay === null ? day : lastDay;

    const timed = entry.type === 'message' || entry.item.kind !== 'note';
    const minute = `${day} ${STAMP.format(entry.item.at)}`;
    const stamped = timed && (minute !== lastMinute || divider !== '');

    if (timed) {
      lastMinute = minute;
    }

    const html =
      entry.type === 'message'
        ? message(entry.item, stamped)
        : reply(entry.item, entry.earlier, view, stamped, entry.item.kind === 'reply' ? cardOf(`reply:${entry.item.id}`, entry.item.opening, answerAfter(state, entry.item.id), view, canAnswer) : '', state.expandReplies);

    return divider + html;
  });
  const earlier = state.more ? '<button class="earlier-items" type="button" data-action="earlier">Show earlier messages</button>' : '';
  // An ended session's reason shows above the composer instead.
  const notice = state.session.reason === null || state.session.state === 'ended' ? '' : `<p class="notice">${escape(state.session.reason)}</p>`;
  const requests = state.session.requests ?? [];
  const asking =
    requests.length > 0
      ? requests.map((request) => renderRequest(request, view.requestValues)).join('')
      : '';

  return `${notice}${earlier}${rows.length === 0 && spinner === '' ? '<p class="empty">No messages yet. They appear here when you or the session write one.</p>' : `<ol class="timeline" aria-label="Conversation">${rows.join('')}${spinner}</ol>`}${asking}`;
}

/**
 * The row at the end of the timeline while the session is in a turn: "Starting…" or "Thinking…" with the spinner while it works on a reply;
 * while it waits on the operator in the terminal, "Waiting for your answer", "Waiting for permission" or "Waiting in the terminal" with a still
 * icon in the warning colour, since the page has no terminal to open. A Codex request the page answers draws its own card instead.
 */
export function turnRow(session: PageState['session'], awaiting: boolean): string {
  if (session?.state === 'waiting' && session.waitingFor !== null && (session.requests ?? []).length === 0) {
    const label = session.waitingFor === 'question' ? 'Waiting for your answer' : session.waitingFor === 'permission' ? 'Waiting for permission' : 'Waiting in the terminal';
    const icon = session.waitingFor === 'permission' ? 'shield' : session.waitingFor === 'question' ? 'question' : 'terminal';
    const who = session.provider === 'codex' ? 'Codex' : 'Claude';

    return `<li class="working waiting" role="status"><span class="codicon codicon-${icon}" aria-hidden="true"></span><span class="working-label">${label}</span><span class="working-detail">${who} asks in its terminal; answer it there.</span></li>`;
  }

  if (!awaiting || session === null) {
    return '';
  }

  return `<li class="working"><span class="codicon codicon-loading${session.state === 'waiting' ? '' : ' codicon-modifier-spin'}" aria-hidden="true"></span><span>${session.state === 'starting' ? 'Starting' : 'Thinking'}…</span></li>`;
}

const DECISIONS: Record<string, string> = { accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Decline', cancel: 'Cancel' };

/**
 * A Codex session's pending request: a permission with its decisions as buttons, or questions with their options and a field for a typed
 * answer, a secret one hidden; one the page cannot answer says to answer it in the terminal.
 */
export function renderRequest(request: NativeRequest, values: ReadonlyMap<string, string>): string {
  const head = `<div class="request-title"><span class="codicon codicon-${request.kind === 'permission' ? 'shield' : 'question'}" aria-hidden="true"></span> ${escape(request.title)}</div>`;

  if (request.kind === 'unsupported') {
    return `<div class="request" data-key="request-${escape(request.id)}">${head}<p class="empty">Answer it in the terminal.</p></div>`;
  }

  if (request.kind === 'permission') {
    return `<div class="request" data-key="request-${escape(request.id)}">${head}<div class="request-actions">${request.decisions.map((decision) => `<button type="button" class="request-button" data-action="request-decision" data-request="${escape(request.id)}" data-decision="${escape(decision)}">${escape(DECISIONS[decision] ?? decision)}</button>`).join('')}</div></div>`;
  }

  const fields = request.questions.map((question) => {
    const key = `${request.id}:${question.id}`;
    const value = values.get(key) ?? '';
    const options = question.options.map((option) => `<button type="button" class="question-option" role="radio" aria-checked="${value === option}" data-action="request-option" data-field="${escape(key)}" data-value="${escape(option)}"><span class="question-mark radio${value === option ? ' checked' : ''}" aria-hidden="true">${value === option ? '<span class="radio-dot"></span>' : ''}</span><span class="question-option-text">${escape(option)}</span></button>`).join('');

    return `<div class="question-block" data-key="${escape(key)}"><div class="question-text">${escape(question.question)}</div><div class="question-options">${options}<input class="question-other request-field" type="${question.secret === true ? 'password' : 'text'}" data-field="${escape(key)}" placeholder="${question.options.length === 0 ? 'Answer…' : 'Other…'}" value="${question.options.includes(value) ? '' : escape(value)}"></div></div>`;
  });

  return `<div class="request question-card" data-key="request-${escape(request.id)}">${head}${fields.join('')}<div class="question-footer"><button type="button" class="question-submit" data-action="request-answer" data-request="${escape(request.id)}">Submit</button></div></div>`;
}

/** The Status tab: the latest status as Markdown with its time and age and a New mark while unread, or the stage dimmed. */
export function renderStatus(state: PageState, view: View, now: number): string {
  const status: StatusView | null = state.status;

  if (status === null) {
    return '<p class="empty">No status yet. It appears here when the session reports one.</p>';
  }

  const answer = (): string | null => {
    const from = state.items.findIndex((item) => item.type === 'reply' && `st-${item.id}` === status.id);
    const later = (from === -1 ? state.items.filter((item) => item.at > status.at) : state.items.slice(from + 1)).find((item) => item.type === 'message' && answers(item));

    return later?.type === 'message' ? later.text : null;
  };
  const card = status.fallback ? '' : cardOf(`status:${status.id}`, status.markdown, answer(), view, state.connected && state.session?.conversation === 'full');
  const label = status.fallback ? 'Stage' : 'Status';

  return `<div class="status-tab${status.fallback ? ' fallback' : ''}${status.unread ? ' unread' : ''}"${status.unread ? ` data-unread="${escape(status.id)}"` : ''}><div class="status-head"><span class="codicon codicon-pulse" aria-hidden="true"></span><span class="status-label">${label}</span><span class="status-age">${stampTime(status.at)} · ${ago(status.at, now)}</span>${status.unread ? '<span class="status-new">New</span>' : ''}</div><div class="status-body body">${card === '' ? renderMarkdown(status.markdown) : withoutQuestions(status.markdown, `status:${status.id}`, view.open)}</div>${card}</div>`;
}

/** The Artifacts tab: the work item's artifacts newest first; a click opens one in the page. */
export function renderArtifacts(state: PageState, now: number): string {
  if (state.artifacts.length === 0) {
    return '<p class="empty">No artifacts yet. They appear here when the session writes one.</p>';
  }

  return `<ul class="artifact-list">${state.artifacts.map((artifact) => `<li><button class="artifact-open" type="button" data-action="artifact" data-path="${escape(artifact.path)}" title="${escape(artifact.path)}"><span class="codicon codicon-${artifactIcon(artifact.type)}" aria-hidden="true"></span><span class="artifact-title">${escape(artifact.title)}</span><span class="artifact-kind">${escape(artifact.kind)} · ${ago(artifact.updatedAt, now)}</span></button></li>`).join('')}</ul>`;
}

/** The URL of an artifact's file for the page key, which the sandboxed frame's own relative files also resolve against. */
export function artifactUrl(key: string, path: string): string {
  return `/v1/conversation/artifact/${encodeURIComponent(key)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Whether an artifact opens in the sandboxed frame: a page or an SVG, whose scripts must reach neither the page nor the network. */
export function framed(artifact: ArtifactView): boolean {
  return artifact.type === 'html' || artifact.ext.toLowerCase() === 'svg' || artifact.ext.toLowerCase() === '.svg';
}

/**
 * An open artifact (architecture.md § Web page): a page or an SVG in a sandboxed frame with an opaque origin, pictures, audio and video in the
 * page, Markdown drawn by the page into `.artifact-doc`, and anything else as a download.
 */
export function renderArtifactView(key: string, artifact: ArtifactView): string {
  const url = artifactUrl(key, artifact.path);
  const head = `<div class="artifact-head"><button class="icon" type="button" data-action="close-artifact" title="Back to the list" aria-label="Back"><span class="codicon codicon-arrow-left"></span></button><span class="codicon codicon-${artifactIcon(artifact.type)}" aria-hidden="true"></span><span class="artifact-title">${escape(artifact.title)}</span><span class="artifact-kind">${escape(artifact.kind)}</span><a class="icon" href="${escape(url)}" download title="Download"><span class="codicon codicon-desktop-download"></span></a></div>`;
  let body: string;

  if (framed(artifact)) {
    body = `<iframe class="artifact-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${escape(url)}" title="${escape(artifact.title)}"></iframe>`;
  } else if (artifact.type === 'image') {
    body = `<img class="media" alt="${escape(artifact.title)}" src="${escape(url)}">`;
  } else if (artifact.type === 'audio') {
    body = `<audio class="media" controls preload="metadata" src="${escape(url)}"></audio>`;
  } else if (artifact.type === 'video') {
    body = `<video class="media" controls preload="metadata" src="${escape(url)}"></video>`;
  } else if (artifact.type === 'markdown') {
    body = '<div class="artifact-doc body"><p class="empty">Loading…</p></div>';
  } else {
    body = `<p class="empty"><a href="${escape(url)}" download>Download ${escape(artifact.path.split('/').pop() ?? artifact.path)}</a></p>`;
  }

  return `<div class="artifact-view" data-artifact="${escape(artifact.path)}">${head}${body}</div>`;
}

/** Front matter dropped from an artifact's Markdown, as the VS Code preview does not show it either. */
export function markdownBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/**
 * The composer footer's voice controls: Speak replies, Stop while the page's session speaks, and whether the voice is here, with Talk here when
 * it is not; nothing while voice is off. The page shows only its own voice state.
 */
export function renderVoice(voice: VoiceView | null): string {
  if (voice === null || !voice.enabled) {
    return '';
  }

  const speak = `<button class="ghost" type="button" data-key="speak-replies" data-voice="speak-replies" aria-pressed="${voice.speakReplies}" title="Speak replies: ${voice.speakReplies ? 'on' : 'off'}"><span class="codicon codicon-${voice.speakReplies ? 'unmute' : 'mute'}" aria-hidden="true"></span><span>Speak replies</span></button>`;
  const stop = voice.here && voice.speaking !== null ? '<button class="ghost" type="button" data-key="stop" data-voice="stop" title="Stop speaking (Escape)"><span class="codicon codicon-debug-stop" aria-hidden="true"></span><span>Stop</span></button>' : '';
  const where = voice.here ? '<span class="voice-state" data-key="here">Voice here</span>' : '<button class="ghost" type="button" data-key="talk-here" data-voice="talk-here" title="Voice is not on this page. Click to talk here."><span class="codicon codicon-circle-slash" aria-hidden="true"></span><span>Voice is not on this page</span></button>';

  return `${speak}${stop}${where}`;
}

export { answerText, complete, parseQuestions };
