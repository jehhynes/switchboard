import { describe, expect, it } from 'vitest';
import type { ComponentChild } from 'preact';
import { stampTime } from '@switchboard/conversation/messageMeta';
import { mount } from '../src/island.js';
import { EMPTY } from '../src/model.js';
import type { PageState } from '../src/model.js';
import { newView, renderMicButton, renderVoice } from '../src/render.js';
import { FileBody } from '../src/fileView.js';
import { renderHistory } from '../src/history.js';
import type { HistoryHead } from '../src/history.js';
import { renderTimeline } from '../src/timeline.js';
import { renderHeader } from '../src/header.js';
import { renderShared } from '../src/composer.js';
import { renderMarkdown } from '../src/markdown.js';
import type { MessageView, ReplyView, SessionView, StateView } from '@switchboard/protocol';

// The shared renderers (messageMeta, replyBody, voiceControls, providerIcons) and the page's Markdown return HTML, which a part must draw
// through `trusted`; given to JSX as a child, it shows as text such as "<time class=…".
const MARKUP = /<\/?[a-z][\w-]*[\s/>]/i;

/** The text nodes of a drawn tree that read as markup. */
function markupText(tree: ComponentChild): string[] {
  const host = document.createElement('div');

  mount(host, tree);
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const found: string[] = [];

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (MARKUP.test(node.nodeValue ?? '')) {
      found.push(node.nodeValue!);
    }
  }

  return found;
}

const AT = Date.UTC(2026, 10, 20, 19, 3, 41);
const message = (id: string, patch: Partial<MessageView> = {}): MessageView => ({ type: 'message', id, sessionId: 's', workItemId: 1, at: AT, ord: 1, provisional: false, withdrawn: false, origin: 'typed', text: `text ${id}`, delivery: 'sent', error: null, ...patch });
const reply = (id: string, patch: Partial<ReplyView> = {}): ReplyView => ({ type: 'reply', id, sessionId: 's', at: AT, ord: 2, provisional: false, kind: 'reply', answers: null, opening: `reply ${id}`, rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null }, ...patch });
const session = (patch: Partial<SessionView> = {}): SessionView => ({ id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, ...patch });
const scope = { kind: 'page' as const, key: 'k', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle' as const, conversation: 'full' as const, unread: 0, provider: 'codex' }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };
const workState = (patch: Partial<StateView> = {}): StateView => ({ id: 'st-1', sessionId: 's', at: AT, headline: 'Done', body: '\`\`\`\ncode\n\`\`\`\n\nPick:\n- A) x\n- B) y', stale: null, unread: true, ...patch });
const state = (patch: Partial<PageState> = {}): PageState => ({ ...EMPTY, connected: true, scope, session: session({ provider: 'codex' } as Partial<SessionView>), ...patch });

const HISTORY_HEAD: HistoryHead = { key: 'gh 1', title: 'Fix it', sourceKind: null, playbook: null, status: null, needsYou: null, workItemId: 1, sessionId: 's' };

describe('HTML from the shared renderers', () => {
  it('is found when a part draws it as text', () => {
    expect(markupText(<span>{stampTime(AT)}</span>)).toHaveLength(1);
    expect(markupText(<span>{'1 < 2 > 0'}</span>)).toEqual([]);
  });

  it('is drawn as nodes in History, with its time as a time element', () => {
    for (const one of [workState(), workState({ stale: 'turn', body: null, headline: 'Build' })]) {
      const host = document.createElement('div');

      const drawn = renderHistory(null, one, AT + 23 * 3_600_000, HISTORY_HEAD);

      expect(markupText(drawn)).toEqual([]);
      mount(host, drawn);
      expect(host.querySelector('.hist-now time')?.getAttribute('datetime')).toBe('2026-11-20T19:03:41.000Z');
      expect(host.querySelector('.hist-now-sub')!.textContent).toBe('State from the session · 23 h ago');
    }
  });

  it('is drawn as nodes in the conversation, with message details on and off', () => {
    const items = [
      message('m1', { origin: 'voice', pieces: [{ text: 'hi', score: 0.9, f0: 120, dropped: false }], interrupted: { replyId: 'r0', said: 'so', rest: 'on' } }),
      message('m2', { delivery: 'uncertain', error: 'No answer' }),
      reply('r1', { opening: 'Intro.\n\nSaid aloud.\n\n\`\`\`\ncode\n\`\`\`', speak: 'Said aloud.', tone: 'calm', spoken: { state: 'interrupted', atMs: 1, saidChars: 4 } }),
      reply('r2', { opening: 'Pick:\n- A) **x**\n- B) y', spoken: { state: 'failed', atMs: null, saidChars: null } }),
      reply('r3', { rewrittenBy: 'r4' }),
      reply('r4', { opening: 'New text with \`code\`' }),
    ];

    for (const details of [true, false]) {
      expect(markupText(renderTimeline({ ...state({ items }), messageTimes: details }, newView(), AT))).toEqual([]);
    }
  });

  it('is drawn as nodes in the header, the composer and an open Markdown artifact', () => {
    const view = { ...newView(), picker: true };
    const voice = { enabled: true, here: true, mic: 'hearing', speaking: 'r1', speakReplies: true, error: 'Mic busy', recognizer: null };

    expect(markupText(renderHeader(state(), view))).toEqual([]);
    expect(markupText(renderShared(renderVoice(voice)))).toEqual([]);
    expect(markupText(renderShared(renderVoice({ ...voice, here: false })))).toEqual([]);
    expect(markupText(renderShared(renderMicButton(voice)))).toEqual([]);
    expect(markupText(<FileBody kind="markdown" name="A" html={renderMarkdown('# A\n\n\`\`\`\ncode\n\`\`\`')} />)).toEqual([]);
  });
});
