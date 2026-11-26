// Drawing cost: what a stream event draws again (architecture.md § Web page, Drawing; mechanics M167).
import MarkdownIt from 'markdown-it';
import { afterEach, onTestFinished, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_DOCS_KEPT, startPage } from '../src/main.js';
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
  const flush = () => new Promise((resolve) => setImmediate(resolve));

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

  it('Draw_ProgressOfAPlayingReplyAndLiveWords_AskForNoDraw', () => {
    const frames: Array<() => void> = [];
    const fetch = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => '' }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: (run) => void frames.push(run), now: () => 10_000 });
    const source = FakeSource.last!;
    const heard = reply('r1', 1, { opening: 'Fixed it. More after.', speak: 'Fixed it.', spoken: { state: 'interrupted', atMs: 900, saidChars: 3 } });
    const drawn = (): number => {
      const ran = frames.length;

      frames.splice(0).forEach((run) => run());
      return ran;
    };

    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])], scope, sessions: [session()], items: [heard, reply('r2', 2)], more: false, state: null, artifacts: [] });
    drawn();
    expect(root.querySelector('#panel li.reply[data-id="r1"] .unheard')).not.toBeNull();

    // The reply heard in part plays again: its first progress draws it whole.
    source.emit('progress', { replyId: 'r1', atMs: 0, chars: 0 });
    expect(drawn()).toBe(1);
    expect(root.querySelector('#panel li.reply[data-id="r1"] .unheard')).toBeNull();

    // While it plays, its progress, and progress for a reply the page does not hold, draw nothing; the state still follows.
    source.emit('progress', { replyId: 'r1', atMs: 150, chars: 4 });
    source.emit('progress', { replyId: 'gone', atMs: 300, chars: 8 });
    expect(drawn()).toBe(0);
    expect(page.state().items.find((one) => one.id === 'r1')).toMatchObject({ spoken: { state: 'playing', atMs: 150, saidChars: 4 } });

    // Live words show at once, with no draw.
    source.emit('words', { messageId: 'u1', text: 'fix the' });
    expect(drawn()).toBe(0);
    expect(root.querySelector<HTMLElement>('.live-words')!.textContent).toBe('fix the');

    // Interrupted again, by a `reply`, it draws.
    source.emit('reply', { reply: { ...heard, spoken: { state: 'interrupted', atMs: 400, saidChars: 5 } } });
    expect(drawn()).toBe(1);
    expect(root.querySelector('#panel li.reply[data-id="r1"] .unheard')).not.toBeNull();
    page.close();
  });

  it('ArtifactDocs_WorkItemsSwitchedWithAnArtifactOpen_KeepsOnlyTheCurrentScopes', async () => {
    const set = vi.spyOn(Map.prototype, 'set');
    const fetch = vi.fn(async (url: string) => ({ status: 200, ok: true, json: async () => ({}), text: async () => (url.startsWith('/v1/conversation/artifact/') ? `# Plan of ${url.split('/').pop()}` : '') }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const groups = [listGroup('progress', [1, 2, 3].map((w) => listRow(w)))];
    const scopeOf = (w: number, gen: number) => ({ ...scope, title: `Item ${w}`, scopeGen: gen, workItemId: w, sessionId: `s${w}`, conversations: [{ ...scope.conversations[0]!, workItemId: w, sessionId: `s${w}` }] });
    let gen = 3;

    for (let round = 0; round < 12; round++) {
      const w = (round % 3) + 1;

      root.querySelector<HTMLElement>(`.row[data-row="item:${w}"]`)?.click();
      await flush();
      gen++;
      FakeSource.last!.emit('scope', { scope: scopeOf(w, gen) });
      FakeSource.last!.emit('hello', { key: 'pk', groups, scope: scopeOf(w, gen), sessions: [session({ id: `s${w}` })], items: [reply(`w${w}g${gen}`, 1, { sessionId: `s${w}` })], more: false, state: null, artifacts: [{ ...artifact(`chat/plan-${w}.md`, 'markdown', 'md'), updatedAt: 1_000 + gen }] });
      root.querySelector<HTMLElement>(`[data-action="artifact"][data-path="chat/plan-${w}.md"]`)!.click();
      await flush();
    }

    const docs = set.mock.contexts.find((map, at) => typeof set.mock.calls[at]![0] === 'string' && /^pk \d+ \d+ chat\/plan-\d\.md$/.test(set.mock.calls[at]![0] as string)) as Map<string, unknown> | undefined;

    // Twelve opens, each in a new scope: only the last one's document is held, and it still shows.
    expect(set.mock.calls.filter(([key]) => typeof key === 'string' && /^pk \d+ \d+ chat\/plan-\d\.md$/.test(key)).length).toBeGreaterThanOrEqual(12);
    expect([...docs!.keys()]).toEqual([`pk 3 ${gen} chat/plan-3.md`]);
    expect(root.querySelector('.artifact-doc h1')?.textContent).toBe('Plan of plan-3.md');
    page.close();
  });

  it('ArtifactDocs_ManyArtifactsOpenedInOneScope_KeepsTheNewestUpToTheCap', async () => {
    const set = vi.spyOn(Map.prototype, 'set');
    const fetch = vi.fn(async (url: string) => ({ status: 200, ok: true, json: async () => ({}), text: async () => (url.startsWith('/v1/conversation/artifact/') ? `# ${url.split('/').pop()}` : '') }) as unknown as Response);
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000 });
    const count = ARTIFACT_DOCS_KEPT + 3;
    const artifacts = Array.from({ length: count }, (_, i) => artifact(`chat/doc-${i}.md`, 'markdown', 'md'));

    FakeSource.last!.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], scope, sessions: [session()], items: [reply('r1', 1)], more: false, state: null, artifacts });

    for (let i = 0; i < count; i++) {
      root.querySelector<HTMLElement>(`[data-action="artifact"][data-path="chat/doc-${i}.md"]`)!.click();
      await flush();
    }

    const docs = set.mock.contexts.find((map, at) => typeof set.mock.calls[at]![0] === 'string' && /^pk 1 3 chat\/doc-\d+\.md$/.test(set.mock.calls[at]![0] as string)) as Map<string, unknown>;

    expect([...docs.keys()]).toEqual(Array.from({ length: ARTIFACT_DOCS_KEPT }, (_, i) => `pk 1 3 chat/doc-${i + 3}.md`));
    page.close();
  });
});
