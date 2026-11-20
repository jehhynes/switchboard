import MarkdownIt from 'markdown-it';
import type { ArtifactView, MessageView, ReplyView, StatusView } from '@switchboard/hub';
import { artifactIcon, awaitingReply, stateIcon, statusLine, timeline } from '../conversationModel.js';
import type { ConversationState } from '../conversationModel.js';

/** What the page posts to the extension. */
export type ConversationMessage =
  | { type: 'ready' }
  | { type: 'earlier' }
  | { type: 'open'; href: string }
  | { type: 'terminal' }
  | { type: 'send'; id: number; text: string; target: SendTarget }
  | { type: 'copy'; id: number; text: string }
  | { type: 'status-open' }
  | { type: 'statuses' }
  | { type: 'artifact'; path: string };

/** The session the page showed when Enter was pressed; the message goes there or is refused. */
export interface SendTarget {
  scopeGen: number;
  sessionId: string;
  launch: string | null;
}

/** What a typed message's line under its box says (architecture.md § Conversation view). */
const DELIVERY = { open: 'sending', sent: 'sent', 'not-sent': 'not sent', uncertain: 'uncertain' } as const;

/** A stamp's time, as Claude Code's panel shows it: "1:46 PM". */
const STAMP = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
/** A stamp's tooltip: "2026-11-19 13:46:05 EST". */
const STAMP_FULL = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const DAY_WITH_YEAR = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** The small time over a message or a reply. */
function stamp(at: number): string {
  const parts = Object.fromEntries(STAMP_FULL.formatToParts(at).map((part) => [part.type, part.value]));
  const full = `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}:${parts['second']} ${parts['timeZoneName']}`;

  return `<div class="stamp-line"><time class="stamp" datetime="${new Date(at).toISOString()}" title="${escape(full)}">${STAMP.format(at)}</time></div>`;
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

/** One of our messages: its box, and for one typed in the composer, whether it went and why not. */
function message(item: MessageView): string {
  const delivery =
    item.origin !== 'typed' || item.delivery === null
      ? ''
      : `<div class="delivery ${item.delivery}">${DELIVERY[item.delivery]}${item.error === null || item.delivery === 'sent' ? '' : ` · ${escape(item.error)}`}</div>`;

  // A message sent in the terminal while the session was busy waits, dimmed, until Claude reads it; a typed message's line says where it is.
  const queued = item.provisional && item.origin === 'terminal';

  return `<li class="message${item.provisional ? ' provisional' : ''}" data-id="${escape(item.id)}" tabindex="-1"${queued ? ' title="Sent; Claude has not read it yet"' : ''}>${stamp(item.at)}<div class="box${COMMAND.test(item.text) ? ' command' : ''}">${escape(item.text)}</div>${delivery}</li>`;
}

function reply(item: ReplyView, earlier: ReplyView | null, open: ReadonlySet<string>): string {
  if (item.kind === 'note') {
    return `<li class="note" data-id="${escape(item.id)}" tabindex="-1">${escape(item.opening)}</li>`;
  }

  const rewritten =
    earlier === null
      ? ''
      : `<details class="fold earlier" data-fold="earlier:${escape(item.id)}"${open.has(`earlier:${item.id}`) ? ' open' : ''}><summary>Rewritten</summary><div class="was">${renderMarkdown(earlier.opening)}</div></details>`;

  // A reply read off the screen has no copy button until its transcript copy replaces it, as Claude Code's has none while it streams.
  const actions = item.provisional ? '' : `<div class="actions">${copyButton('copy-reply', 'Copy response')}</div>`;

  return `<li class="reply ${item.kind}" data-id="${escape(item.id)}" tabindex="-1">${stamp(item.at)}<span class="dot"></span><div class="body">${renderMarkdown(item.opening)}${rewritten}</div>${actions}</li>`;
}

/** An artifact as a one-line row where it was written: it opens, it does not expand (architecture.md § Conversation view). */
function artifactRow(artifact: ArtifactView): string {
  return (
    `<li class="artifact" data-id="artifact:${escape(artifact.path)}" data-path="${escape(artifact.path)}" tabindex="-1">` +
    `<button class="artifact-open" type="button" data-action="artifact" data-path="${escape(artifact.path)}" title="${escape(`Open ${artifact.path}`)}" aria-label="${escape(`Open artifact: ${artifact.title}`)}">` +
    `<span class="codicon codicon-${artifactIcon(artifact.type)}" aria-hidden="true"></span><span class="artifact-title">${escape(artifact.title)}</span><span class="artifact-kind">${escape(artifact.kind)}</span></button></li>`
  );
}

/** How long ago a status was posted, as the status row says it: "just now", "4 min ago", "2 h ago", "3 d ago". */
export function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);

  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 24 * 60 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / (24 * 60))} d ago`;
}

/**
 * The status row (architecture.md § Statuses), pinned under the header and folded like a fold row: "Status · 4 min ago" and the first line;
 * open, the whole status as Markdown. A status that replaced the one before shows a New mark while `fresh`. The work item's stage stands in
 * before the session's first status, dimmed, with nothing to open.
 */
export function renderStatus(status: StatusView | null, open: ReadonlySet<string>, fresh: boolean, now: number): string {
  if (status === null) {
    return '';
  }

  const title = status.fallback ? "The work item's stage; the session has posted no status yet" : 'Status';
  const age = `<time class="status-age" data-at="${status.at}" datetime="${new Date(status.at).toISOString()}">${ago(status.at, now)}</time>`;
  const mark = fresh ? '<span class="status-new">New</span>' : '';
  const actions = status.fallback
    ? ''
    : '<span class="status-actions"><button class="icon" type="button" data-action="status-open" title="Open in the Markdown preview" aria-label="Open the status in the Markdown preview"><span class="codicon codicon-open-preview" aria-hidden="true"></span></button>' +
      '<button class="icon" type="button" data-action="statuses" title="Earlier statuses" aria-label="Earlier statuses"><span class="codicon codicon-history" aria-hidden="true"></span></button></span>';
  const summary = `<summary title="${escape(title)}"><span class="codicon codicon-chevron-right status-chevron" aria-hidden="true"></span><span class="codicon codicon-pulse" aria-hidden="true"></span><span class="status-label">Status</span><span class="status-dot" aria-hidden="true">·</span>${age}${mark}<span class="status-first">${escape(statusLine(status.markdown))}</span></summary>`;

  return `<details class="status-row${status.fallback ? ' fallback' : ''}${fresh ? ' fresh' : ''}" data-fold="status" aria-label="Status"${open.has('status') ? ' open' : ''}>${summary}<div class="status-body body">${renderMarkdown(status.markdown)}</div></details>${actions === '' ? '' : `<div class="status-tools">${actions}</div>`}`;
}

/** The view's HTML: the header with the session's state, the status row, a note when the view cannot talk to the session, and the timeline. */
export function renderConversation(state: ConversationState, open: ReadonlySet<string> = new Set(), now: number = Date.now(), fresh = false): string {
  if (state.scope === null) {
    return `<p class="empty">${state.connected ? 'This window has no Switchboard session.' : 'Connecting to Switchboard…'}</p>`;
  }

  const { icon, text } = stateIcon(state.session);
  const [name, modifier] = icon.split('~');
  const header = `<header class="header"><span class="codicon codicon-${name}${modifier === undefined ? '' : ` codicon-modifier-${modifier}`}" title="${escape(text)}" aria-label="${escape(text)}"></span><span class="title" title="${escape(state.scope.title)}">${escape(state.scope.title)}</span>${state.session?.conversation === 'none' ? '' : '<button class="icon" data-action="terminal" title="Open in terminal" aria-label="Open in terminal"><span class="codicon codicon-terminal"></span></button>'}</header>`;
  const notes = [
    ...(state.session?.reason == null ? [] : [state.session.reason]),
    ...(state.session === null || state.session.conversation === 'none' || state.session.rules === 'current'
      ? []
      : [state.session.rules === 'none' ? 'This session started without the conversation rules, so its replies show whole.' : 'This session started with older conversation rules, so the view reads only the tags they explained. Resume it to give it the current ones.']),
  ];
  const shown = timeline(state.items, state.artifacts);
  const waiting = awaitingReply(state.items, shown, state.session);
  // While the session works on a reply, a spinner under the operator's latest message; it has no data-id, so the keys skip it.
  // While the session waits on a question or a permission, it stands still.
  const spin = state.session?.state === 'waiting' ? '' : ' codicon-modifier-spin';
  const spinner = `<li class="working" title="Working on a reply"><span role="status">Working on a reply</span><span class="codicon codicon-loading${spin}" aria-hidden="true"></span></li>`;
  // A turn starts at each message; one that starts on another day than the turn before it has a divider, as in Claude Code's panel.
  let turnDay: string | null = null;
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

    return divider + (entry.type === 'message' ? message(entry.item) : reply(entry.item, entry.earlier, open)) + (index === waiting ? spinner : '');
  });
  const earlier = state.more ? '<button class="earlier-items" data-action="earlier">Show earlier messages</button>' : '';
  const body = state.session === null ? '<p class="empty">No session has started yet.</p>' : entries.length === 0 ? '<p class="empty">No messages yet.</p>' : `<ol class="timeline" tabindex="0" aria-label="Conversation">${entries.join('')}</ol>`;

  const status = renderStatus(state.status, open, fresh, now);

  return `${header}${status === '' ? '' : `<div class="status">${status}</div>`}${notes.map((note) => `<p class="notice">${escape(note)}</p>`).join('')}<div class="scroll">${earlier}${body}</div>`;
}
