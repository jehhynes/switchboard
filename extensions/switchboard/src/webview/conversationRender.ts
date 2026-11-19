import MarkdownIt from 'markdown-it';
import type { ReplyView } from '@switchboard/hub';
import { awaitingReply, stateIcon, timeline } from '../conversationModel.js';
import type { ConversationState } from '../conversationModel.js';

/** What the page posts to the extension. */
export type ConversationMessage = { type: 'ready' } | { type: 'earlier' } | { type: 'open'; href: string } | { type: 'terminal' };

/** Raw HTML off, so a reply's text can never inject markup; tables, code spans and fences as GitHub draws them. */
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A reply's Markdown as HTML; links keep their target in `data-href`, which the page posts, so the webview itself never navigates. */
export function renderMarkdown(text: string): string {
  return markdown.render(text).replace(/<a href="([^"]*)"/g, (_match, href: string) => `<a href="#" data-href="${href}"`);
}

function reply(item: ReplyView, earlier: ReplyView | null, open: ReadonlySet<string>): string {
  if (item.kind === 'note') {
    return `<li class="note" data-id="${escape(item.id)}" tabindex="-1">${escape(item.opening)}</li>`;
  }

  const rewritten =
    earlier === null
      ? ''
      : `<details class="fold earlier" data-fold="earlier:${escape(item.id)}"${open.has(`earlier:${item.id}`) ? ' open' : ''}><summary>Rewritten</summary><div class="was">${renderMarkdown(earlier.opening)}</div></details>`;

  return `<li class="reply ${item.kind}" data-id="${escape(item.id)}" tabindex="-1"><span class="dot"></span><div class="body">${renderMarkdown(item.opening)}${rewritten}</div></li>`;
}

/** The view's HTML: the header with the session's state, a note when the view cannot talk to the session, and the timeline. */
export function renderConversation(state: ConversationState, open: ReadonlySet<string> = new Set()): string {
  if (state.scope === null) {
    return `<p class="empty">${state.connected ? 'This window has no Switchboard session.' : 'Connecting to Switchboard…'}</p>`;
  }

  const { icon, text } = stateIcon(state.session);
  const [name, modifier] = icon.split('~');
  const header = `<header class="header"><span class="codicon codicon-${name}${modifier === undefined ? '' : ` codicon-modifier-${modifier}`}" title="${escape(text)}" aria-label="${escape(text)}"></span><span class="title" title="${escape(state.scope.title)}">${escape(state.scope.title)}</span>${state.session?.conversation === 'none' ? '' : '<button class="icon" data-action="terminal" title="Open in terminal" aria-label="Open in terminal"><span class="codicon codicon-terminal"></span></button>'}</header>`;
  const notes = [
    ...(state.session?.reason == null ? [] : [state.session.reason]),
    ...(state.session !== null && state.session.conversation !== 'none' && state.session.rules !== 'current' ? ['This session started without the current conversation rules, so its replies show whole.'] : []),
  ];
  const shown = timeline(state.items);
  const waiting = awaitingReply(state.items, shown, state.session);
  // While the session works on a reply, a spinner under the operator's latest message; it has no data-id, so the keys skip it.
  // While the session waits on a question or a permission, it stands still.
  const spin = state.session?.state === 'waiting' ? '' : ' codicon-modifier-spin';
  const spinner = `<li class="working" title="Working on a reply"><span role="status">Working on a reply</span><span class="codicon codicon-loading${spin}" aria-hidden="true"></span></li>`;
  const entries = shown.map(
    (entry, index) =>
      (entry.type === 'message'
        ? `<li class="message${entry.item.provisional ? ' provisional' : ''}" data-id="${escape(entry.item.id)}" tabindex="-1"${entry.item.provisional ? ' title="Sent; Claude has not read it yet"' : ''}><div class="box">${escape(entry.item.text)}</div></li>`
        : reply(entry.item, entry.earlier, open)) + (index === waiting ? spinner : ''),
  );
  const earlier = state.more ? '<button class="earlier-items" data-action="earlier">Show earlier messages</button>' : '';
  const body = state.session === null ? '<p class="empty">No session has started yet.</p>' : entries.length === 0 ? '<p class="empty">No messages yet.</p>' : `<ol class="timeline" tabindex="0" aria-label="Conversation">${entries.join('')}</ol>`;

  return `${header}${notes.map((note) => `<p class="notice">${escape(note)}</p>`).join('')}<div class="scroll">${earlier}${body}</div>`;
}
