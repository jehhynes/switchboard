// Drawing cost: what a stream event draws again (architecture.md § Web page, Drawing; mechanics M167).
import MarkdownIt from 'markdown-it';
import { afterEach, onTestFinished, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPage } from '../src/main.js';
import type { MessageView, ReplyView } from '@switchboard/protocol';
import { drawAtOnce } from './frame.js';
import { message, reply, session, scope, listRow, listGroup, artifact, FakeSource } from './pageFixtures.js';

describe('drawing the page', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    history.replaceState(null, '', '#w=1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const start = () => {
    const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });

    return { page, source: FakeSource.last! };
  };

  it('Draw_EventThatChangesNoItem_RendersNoMarkdownAndKeepsEachItemsNodes', () => {
    const { page, source } = start();
    const items = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? message(`m${i}`, i) : reply(`r${i}`, i, { opening: `## Step ${i}\n\n- one **${i}**\n- two` })));

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope, sessions: [session({ state: 'running' })], items, more: false, state: null, artifacts: [] });
    const body = root.querySelector('#panel li.reply[data-id="r1"] .body h2')!;
    const render = vi.spyOn(MarkdownIt.prototype, 'render');

    // The session's state, the list and an unread count change nothing an item draws.
    source.emit('session', { session: session({ state: 'waiting' }) });
    source.emit('list', { groups: [listGroup('progress', [listRow(1, { title: 'Fix it now' })])] });
    source.emit('unread', { workItemId: 1, count: 2 });
    expect(render).not.toHaveBeenCalled();
    expect(root.querySelector('#panel li.reply[data-id="r1"] .body h2')).toBe(body);

    // A changed reply renders its own text alone; the reply it replaced as the newest draws from the HTML kept for its text.
    source.emit('reply', { reply: reply('r1', 1, { opening: '## Step 1, changed' }) });
    source.emit('reply', { reply: reply('r41', 41, { opening: 'The newest.' }) });
    expect(render.mock.calls.map((call) => call[0])).toEqual(['## Step 1, changed', 'The newest.']);
    expect(root.querySelector('#panel li.reply[data-id="r1"] .body h2')!.textContent).toBe('Step 1, changed');
    page.close();
  });

  it('Draw_ItemsChangedEventByEvent_DrawsTheTimelineAFreshDrawDraws', () => {
    const final = [message('m1', 1, { delivery: 'uncertain', error: 'Check.' }), reply('r1', 2, { opening: 'Fixed it. More after.', speak: 'Fixed it.', unread: true, spoken: { state: 'interrupted', atMs: 900, saidChars: 3 } }), message('m2', 3, { text: 'port B' }), reply('r2', 4, { opening: 'Before I go on:\n\n1. Port? {#port}\n   - A) 1\n   - B) 2', unread: true }), reply('r3', 5, { opening: 'Last **one**.' })];
    const hello = (items: ReplyView[] | Array<ReplyView | MessageView>) => ({ key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope, sessions: [session()], items, more: false, state: null, artifacts: [] });
    // Attributes sorted: a patched node keeps them in the order they were set.
    const canonical = (node: Node): string => (node instanceof Element ? `<${node.localName}${[...node.attributes].map((one) => ` ${one.name}=${one.value}`).sort().join('')}>${[...node.childNodes].map(canonical).join('')}</${node.localName}>` : (node.textContent ?? ''));
    const timelineHtml = (): string => canonical(root.querySelector('#panel ol.timeline')!);
    const { page, source } = start();

    source.emit('hello', hello([message('m1', 1), reply('r1', 2, { opening: 'Fixed it.' })]));
    source.emit('message', { message: final[0] });
    source.emit('reply', { reply: { ...final[1], spoken: { state: 'playing', atMs: 100, saidChars: 1 } } });
    source.emit('progress', { replyId: 'r1', atMs: 500, chars: 2 });
    source.emit('reply', { reply: final[1] });
    source.emit('message', { message: final[2] });
    source.emit('reply', { reply: final[3] });
    source.emit('session', { session: session({ state: 'running' }) });
    source.emit('reply', { reply: final[4] });
    source.emit('session', { session: session() });
    const streamed = timelineHtml();

    page.close();
    root.replaceChildren();
    const fresh = start();

    fresh.source.emit('hello', hello(final));
    expect(streamed).toBe(timelineHtml());
    fresh.page.close();
  });

  it('Draw_ListEventWithACardShown_LeavesTheTimelineAsDrawn', () => {
    const { page, source } = start();
    const asked = reply('r1', 1, { opening: 'Before I go on:\n\n1. Port? {#port}\n   - A) *one*\n   - B) two' });

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope, sessions: [session()], items: [asked], more: false, state: null, artifacts: [] });
    expect(root.querySelector('#panel .question-card')).not.toBeNull();
    const render = vi.spyOn(MarkdownIt.prototype, 'render');
    const inline = vi.spyOn(MarkdownIt.prototype, 'renderInline');

    // The card is drawn from its HTML on each timeline draw, which renders its options' Markdown; a list change draws no timeline.
    source.emit('list', { groups: [listGroup('progress', [listRow(1, { title: 'Fix it now' })])] });
    expect(root.querySelector('.row-title')!.textContent).toBe('Fix it now');
    expect(render.mock.calls.length + inline.mock.calls.length).toBe(0);

    // A session change is one of its inputs.
    source.emit('session', { session: session({ reason: 'Paused by the hub.' }) });
    expect(render.mock.calls.length + inline.mock.calls.length).toBeGreaterThan(0);
    expect(root.querySelector('#panel p.notice')!.textContent).toBe('Paused by the hub.');
    page.close();
  });

  it('Draw_DayPassesWithNoItemChanged_DrawsTheDividerAgain', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => void vi.useRealTimers());
    vi.setSystemTime(new Date(2026, 10, 25, 23, 0));
    const { page, source } = start();

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope, sessions: [session()], items: [message('m1', 1, { at: new Date(2026, 10, 25, 22, 0).getTime() })], more: false, state: null, artifacts: [] });
    expect(root.querySelector('#panel li.day')!.textContent).toBe('Today');
    vi.setSystemTime(new Date(2026, 10, 26, 0, 30));
    source.emit('list', { groups: [listGroup('progress', [listRow(1, { title: 'Fix it now' })])] });
    expect(root.querySelector('#panel li.day')!.textContent).toBe('Yesterday');
    page.close();
  });
});
