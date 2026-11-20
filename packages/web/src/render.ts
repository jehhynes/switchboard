import { providerMark } from '@switchboard/conversation/providerIcons';
import { artifactIcon, awaitingReply, selectedEntry, stateIcon, timeline } from './model.js';
import type { PageState } from './model.js';
import { copyButton, escape, renderInline, renderMarkdown } from './markdown.js';
import { answersIn, answerText, complete, parseQuestions } from '@switchboard/conversation/questions';
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
}

export const newView = (): View => ({ tab: 'conversation', open: new Set(), picker: false, cards: new Map(), artifact: null, requestValues: new Map() });

const STAMP = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

function codicon({ icon, text }: { icon: string; text: string }): string {
  const [name, modifier] = icon.split('~');

  return `<span class="codicon codicon-${name}${modifier === undefined ? '' : ` codicon-modifier-${modifier}`}" title="${escape(text)}" role="img" aria-label="${escape(text)}"></span>`;
}

function stampTime(at: number): string {
  return `<time class="stamp" datetime="${new Date(at).toISOString()}" title="${escape(new Date(at).toLocaleString())}">${STAMP.format(at)}</time>`;
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
    return '<p class="empty">No work items yet.</p>';
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
      : `<button type="button" class="persona${persona.tonePending ? ' pending' : ''}" data-action="persona" title="${escape(`Persona: ${persona.name}${persona.pinned ? ', pinned' : ''}. Click to choose another.`)}"><span class="codicon codicon-${persona.pinned ? 'pinned' : 'person'}" aria-hidden="true"></span><span class="name">${escape(persona.name)}</span></button>`;
  const picker = `<button type="button" class="picker" data-action="picker" aria-haspopup="listbox" aria-expanded="${view.picker}" title="${escape(title)}">${codicon(stateIcon(state.session?.state, state.session?.waitingFor))}<span class="title">${escape(title)}</span><span class="codicon codicon-chevron-down" aria-hidden="true"></span></button>${view.picker ? `<ul class="conversation-list" role="listbox" aria-label="Conversations">${options}</ul>` : ''}`;

  return `<header class="header">${picker}${providerMark(state.session?.provider)}${personaButton}</header>`;
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

/** What became of a reply's speech, as a line under it. */
function spokenLine(item: ReplyView): string {
  const line = (icon: string, text: string): string => `<div class="spoken"><span class="codicon codicon-${icon}" aria-hidden="true"></span><span>${escape(text)}</span></div>`;
  const at = item.spoken.atMs === null ? '' : ` at ${Math.floor(item.spoken.atMs / 60_000)}:${String(Math.floor(item.spoken.atMs / 1000) % 60).padStart(2, '0')}`;

  switch (item.spoken.state) {
    case 'playing':
      return line('unmute', 'Speaking');
    case 'interrupted':
      return line('unmute', `interrupted${at}`);
    case 'stopped-moved':
      return line('mute', 'stopped: voice moved');
    case 'failed':
      return line('mute', 'not spoken: speech failed');
    default:
      return '';
  }
}

function reply(item: ReplyView, earlier: ReplyView | null, view: View, stamped: boolean, card: string, expandReplies: boolean): string {
  if (item.kind === 'note') {
    return `<li class="note" data-id="${escape(item.id)}">${escape(item.opening)}</li>`;
  }

  // Focused mode: a reply with a [speak] passage shows the passage first and the whole reply behind Show more.
  const passage = item.kind === 'reply' && item.speak !== null && item.speak.trim() !== '' && item.speak.trim() !== item.opening.trim() ? item.speak : null;
  const expanded = passage === null || expandReplies !== view.open.has(`more:${item.id}`);
  const body = renderMarkdown(expanded || passage === null ? item.opening : passage);
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

/** A question card: each question with its options as radio or checkbox rows, an Other field, and Submit; greyed with its picks once answered. */
export function questionCard(key: string, questions: readonly Question[], draft: CardDraft | undefined, answer: string | null, canAnswer: boolean): string {
  const answered = answer !== null;
  const choices = answered ? answersIn(answer, questions) : (draft?.choices ?? new Map<number, QuestionChoice>());
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
    ? '<span class="question-state">Answered</span>'
    : !canAnswer
      ? ''
      : `${draft?.error ? `<span class="question-error">${escape(draft.error)}</span>` : ''}${draft?.sent != null ? '<span class="question-state">Sending…</span>' : ''}<button type="button" class="question-submit" data-action="answer" data-card="${escape(key)}"${locked || !complete(questions, choices) ? ' disabled' : ''}>Submit</button>`;

  return `<div class="question-card" data-card-key="${escape(key)}">${blocks.join('')}<div class="question-footer">${footer}</div></div>`;
}

/** The card of a reply's or a status's questions, answered by the first message after it; empty without questions. */
function cardOf(key: string, markdown: string, answer: string | null, view: View, canAnswer: boolean): string {
  const questions = parseQuestions(markdown);

  return questions.length === 0 ? '' : questionCard(key, questions, view.cards.get(key), answer, canAnswer);
}

/** The text of the first message after a reply, which answers its card. */
function answerAfter(state: PageState, replyId: string): string | null {
  const from = state.items.findIndex((item) => item.id === replyId);
  const later = from === -1 ? undefined : state.items.slice(from + 1).find((item) => item.type === 'message' && !item.withdrawn);

  return later?.type === 'message' ? later.text : null;
}

/** The Conversation tab: why the page cannot talk to the session, earlier messages, and the timeline with its spinner. */
export function renderTimeline(state: PageState, view: View): string {
  if (state.session === null) {
    return '<p class="empty">No session has started yet.</p>';
  }

  const entries = timeline(state.items, state.artifacts);
  const canAnswer = state.connected && state.session.conversation === 'full';
  // After the newest item, so replies written mid-turn show above it.
  const spinner = !awaitingReply(state.items, state.session) ? '' : `<li class="working"><span class="codicon codicon-loading${state.session.state === 'waiting' ? '' : ' codicon-modifier-spin'}" aria-hidden="true"></span><span>Thinking…</span></li>`;
  let lastMinute: string | null = null;
  let lastDay: string | null = null;
  const rows = entries.map((entry) => {
    if (entry.type === 'artifact') {
      return artifactRow(entry.artifact);
    }

    const day = new Date(entry.item.at).toDateString();
    const divider = lastDay !== null && day !== lastDay && entry.type === 'message' ? `<li class="day" role="separator">${escape(DAY.format(entry.item.at))}</li>` : '';

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
  const notice = state.session.reason === null ? '' : `<p class="notice">${escape(state.session.reason)}</p>`;
  const requests = state.session.requests ?? [];
  const asking =
    requests.length > 0
      ? requests.map((request) => renderRequest(request, view.requestValues)).join('')
      : state.session.state === 'waiting' && state.session.waitingFor === 'question'
        ? `<p class="notice terminal-question"><span class="codicon codicon-question" aria-hidden="true"></span> ${state.session.provider === 'codex' ? 'Codex' : 'Claude'} is waiting for an answer in the terminal.</p>`
        : '';

  return `${notice}${earlier}${rows.length === 0 ? '<p class="empty">No messages yet.</p>' : `<ol class="timeline" aria-label="Conversation">${rows.join('')}${spinner}</ol>`}${asking}`;
}

const DECISIONS: Record<string, string> = { accept: 'Allow once', acceptForSession: 'Allow for session', decline: 'Decline', cancel: 'Cancel' };

/**
 * A Codex session's pending request: a permission with its decisions as buttons, or questions with their options and a field for a typed
 * answer, a secret one hidden; one the page cannot answer says to answer it in the terminal.
 */
export function renderRequest(request: NativeRequest, values: ReadonlyMap<string, string>): string {
  const head = `<div class="request-title"><span class="codicon codicon-${request.kind === 'permission' ? 'shield' : 'question'}" aria-hidden="true"></span> ${escape(request.title)}</div>`;

  if (request.kind === 'unsupported') {
    return `<div class="request">${head}<p class="empty">Answer it in the terminal.</p></div>`;
  }

  if (request.kind === 'permission') {
    return `<div class="request">${head}<div class="request-actions">${request.decisions.map((decision) => `<button type="button" class="request-button" data-action="request-decision" data-request="${escape(request.id)}" data-decision="${escape(decision)}">${escape(DECISIONS[decision] ?? decision)}</button>`).join('')}</div></div>`;
  }

  const fields = request.questions.map((question) => {
    const key = `${request.id}:${question.id}`;
    const value = values.get(key) ?? '';
    const options = question.options.map((option) => `<button type="button" class="question-option" role="radio" aria-checked="${value === option}" data-action="request-option" data-field="${escape(key)}" data-value="${escape(option)}"><span class="question-mark radio${value === option ? ' checked' : ''}" aria-hidden="true">${value === option ? '<span class="radio-dot"></span>' : ''}</span><span class="question-option-text">${escape(option)}</span></button>`).join('');

    return `<div class="question-block"><div class="question-text">${escape(question.question)}</div><div class="question-options">${options}<input class="question-other request-field" type="${question.secret === true ? 'password' : 'text'}" data-field="${escape(key)}" placeholder="${question.options.length === 0 ? 'Answer…' : 'Other…'}" value="${question.options.includes(value) ? '' : escape(value)}"></div></div>`;
  });

  return `<div class="request question-card">${head}${fields.join('')}<div class="question-footer"><button type="button" class="question-submit" data-action="request-answer" data-request="${escape(request.id)}">Submit</button></div></div>`;
}

/** The Status tab: the latest status as Markdown with its time and age and a New mark while unread, or the stage dimmed. */
export function renderStatus(state: PageState, view: View, now: number): string {
  const status: StatusView | null = state.status;

  if (status === null) {
    return '<p class="empty">The session has not reported a status yet.</p>';
  }

  const answer = (): string | null => {
    const from = state.items.findIndex((item) => item.type === 'reply' && `st-${item.id}` === status.id);
    const later = (from === -1 ? state.items.filter((item) => item.at > status.at) : state.items.slice(from + 1)).find((item) => item.type === 'message' && !item.withdrawn);

    return later?.type === 'message' ? later.text : null;
  };
  const card = status.fallback ? '' : cardOf(`status:${status.id}`, status.markdown, answer(), view, state.connected && state.session?.conversation === 'full');
  const label = status.fallback ? 'Stage' : 'Status';

  return `<div class="status-tab${status.fallback ? ' fallback' : ''}${status.unread ? ' unread' : ''}"${status.unread ? ` data-unread="${escape(status.id)}"` : ''}><div class="status-head"><span class="codicon codicon-pulse" aria-hidden="true"></span><span class="status-label">${label}</span><span class="status-age">${stampTime(status.at)} · ${ago(status.at, now)}</span>${status.unread ? '<span class="status-new">New</span>' : ''}</div><div class="status-body body">${renderMarkdown(status.markdown)}</div>${card}</div>`;
}

/** The Artifacts tab: the work item's artifacts newest first; a click opens one in the page. */
export function renderArtifacts(state: PageState, now: number): string {
  if (state.artifacts.length === 0) {
    return "<p class=\"empty\">The session's artifacts show here as it writes them: plans, reports, comparisons, diagrams, pages and media.</p>";
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

  const speak = `<button class="ghost" type="button" data-voice="speak-replies" aria-pressed="${voice.speakReplies}" title="Speak replies: ${voice.speakReplies ? 'on' : 'off'}"><span class="codicon codicon-${voice.speakReplies ? 'unmute' : 'mute'}" aria-hidden="true"></span><span>Speak replies</span></button>`;
  const stop = voice.here && voice.speaking !== null ? '<button class="ghost" type="button" data-voice="stop" title="Stop speaking (Escape)"><span class="codicon codicon-debug-stop" aria-hidden="true"></span><span>Stop</span></button>' : '';
  const where = voice.here ? '<span class="voice-state">Voice here</span>' : '<button class="ghost" type="button" data-voice="talk-here" title="Voice is not on this page. Click to talk here."><span class="codicon codicon-circle-slash" aria-hidden="true"></span><span>Voice is not on this page</span></button>';

  return `${speak}${stop}${where}`;
}

export { answerText, complete, parseQuestions };
