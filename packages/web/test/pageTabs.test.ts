import { afterEach, onTestFinished, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkTarget } from '../src/localLinks.js';
import { renderList, sourceIcons } from '../src/list.js';
import { html } from './html.js';
import { CHAT_MAX, CHAT_MIN, loadMermaid, SIDE_MAX, SIDE_MIN, startPage } from '../src/main.js';
import { drawAtOnce } from './frame.js';
import { message, reply, session, scope, listRow, listGroup, artifact, FakeSource } from './pageFixtures.js';

describe('the page in use', () => {
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let root: HTMLElement;
  let answers: Record<string, { status: number; body: unknown; text?: string; wait?: Promise<void> }>;
  let installed: boolean;

  beforeEach(() => {
    posts = [];
    answers = {};
    installed = false;
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    history.replaceState(null, '', '#');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const start = (loadDiagrams: () => Promise<boolean> = async () => false) => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const name = Object.keys(answers).find((one) => url.includes(one));
      const answer = name === undefined ? { status: 200, body: {} } : answers[name]!;

      await answer.wait;

      return { status: answer.status, ok: answer.status === 200, json: async () => answer.body, text: async () => answer.text ?? '' } as unknown as Response;
    });
    const mermaid = vi.fn(loadDiagrams);
    const opened: string[] = [];
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, loadMermaid: mermaid, openUrl: (url) => opened.push(url), standalone: () => installed });

    return { page, source: FakeSource.last!, mermaid, opened };
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const click = (selector: string) => root.querySelector<HTMLElement>(selector)!.click();
  /** The panel's text as read: a folded reply's fade is only a glimpse, hidden from screen readers. */
  const shownText = () => {
    const panel = root.querySelector('#panel')!.cloneNode(true) as Element;

    panel.querySelectorAll('.reply-fade-text').forEach((glimpse) => glimpse.remove());
    return panel.textContent;
  };
  const hello = (source: FakeSource, patch: Record<string, unknown> = {}) =>
    source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1, { title: 'Fix it' }), listRow(2, { title: 'Side', host: 'w' })])], scope: { ...scope, conversations: [...scope.conversations, { ...scope.conversations[0]!, workItemId: 2, title: 'Side', primary: false }] }, sessions: [session()], items: [message('m1', 1), reply('r1', 2, { unread: true, opening: '1. Port?\n   - A) 1\n   - B) 2', answers: 'm1' })], more: true, state: { id: 'st-r1', sessionId: 's', at: 5_000, headline: 'Working on it', body: '```mermaid\ngraph TD; A-->B;\n```', stale: null, unread: true }, artifacts: [artifact('chat/plan.md', 'markdown', 'md'), artifact('chat/p.html', 'html', 'html')], unread: 1, voice: { enabled: true, here: false, speaking: null, speakReplies: true, error: null }, ...patch });

  it("draws Mermaid diagrams in the system scheme's theme, and draws the ones shown again from their sources when the scheme changes", async () => {
    const changes: Array<() => void> = [];
    // As a browser's, the listener goes when its signal aborts.
    const scheme = {
      matches: false,
      addEventListener: (_type: string, listener: () => void, options?: { signal?: AbortSignal }) => {
        changes.push(listener);
        options?.signal?.addEventListener('abort', () => changes.splice(changes.indexOf(listener), 1));
      },
    };
    const drawn: string[] = [];
    const mermaid = {
      initialize: vi.fn(),
      run: vi.fn(async ({ nodes }: { nodes: ArrayLike<HTMLElement> }) => {
        // As Mermaid does, a block already drawn is skipped.
        for (const node of Array.from(nodes).filter((one) => !one.hasAttribute('data-processed'))) {
          drawn.push(node.textContent ?? '');
          node.setAttribute('data-processed', 'true');
          node.textContent = 'svg';
        }
      }),
    };

    vi.stubGlobal('matchMedia', vi.fn((query: string) => (query === '(prefers-color-scheme: light)' ? scheme : { matches: false, addEventListener: () => {} })));
    vi.stubGlobal('mermaid', mermaid);

    // The page's own loader initializes Mermaid in the scheme's theme once its script loads.
    const loaded = loadMermaid();
    const script = document.head.querySelector<HTMLScriptElement>('script[src="/page/mermaid.min.js"]')!;

    script.dispatchEvent(new Event('load'));
    expect(await loaded).toBe(true);
    expect(mermaid.initialize).toHaveBeenLastCalledWith({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
    script.remove();

    const { page, source } = start(async () => true);

    hello(source);
    click('[data-tab="history"]');
    await flush();
    expect(drawn).toEqual(['graph TD; A-->B;\n']);
    expect(root.querySelector('pre.mermaid')!.textContent).toBe('svg');

    scheme.matches = true;
    changes.forEach((change) => change());
    await flush();
    expect(mermaid.initialize).toHaveBeenLastCalledWith({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
    expect(drawn).toEqual(['graph TD; A-->B;\n', 'graph TD; A-->B;\n']);
    page.close();

    // A closed page stops listening.
    expect(changes).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('draws a diagram again when its source changes, never leaving the old drawing over the new source', async () => {
    const drawn: string[] = [];
    const mermaid = {
      initialize: vi.fn(),
      run: vi.fn(async ({ nodes }: { nodes: ArrayLike<HTMLElement> }) => {
        // As Mermaid does, a block already drawn is skipped.
        for (const node of Array.from(nodes).filter((one) => !one.hasAttribute('data-processed'))) {
          drawn.push(node.textContent ?? '');
          node.setAttribute('data-processed', 'true');
          node.textContent = `svg of ${node.textContent ?? ''}`;
        }
      }),
    };

    vi.stubGlobal('mermaid', mermaid);

    const { page, source } = start(async () => true);
    const workState = (body: string) => ({ id: 'st-r1', sessionId: 's', at: 5_000, headline: 'Working on it', body, stale: null, unread: false });

    hello(source);
    click('[data-tab="history"]');
    await flush();
    expect(drawn).toEqual(['graph TD; A-->B;\n']);
    source.emit('state', { state: workState('```mermaid\ngraph TD; A-->C;\n```') });
    await flush();
    expect(drawn).toEqual(['graph TD; A-->B;\n', 'graph TD; A-->C;\n']);
    expect([...root.querySelectorAll('pre.mermaid')].map((node) => node.textContent)).toEqual(['svg of graph TD; A-->C;\n']);
    // The same source again keeps its drawing.
    source.emit('state', { state: { ...workState('```mermaid\ngraph TD; A-->C;\n```'), at: 6_000 } });
    await flush();
    expect(drawn).toHaveLength(2);
    expect(root.querySelector('pre.mermaid')!.textContent).toBe('svg of graph TD; A-->C;\n');
    page.close();
    vi.unstubAllGlobals();
  });

  it('marks the artifacts this device has not shown at their version with the unread dot, on their tabs and in the More menu, until shown here or on another of its pages', () => {
    window.innerWidth = 1920;
    // Kept before the page loaded, by an earlier page that kept paths alone: work item 1 seen with chat/a5.md opened; another work item's
    // opened path does not count.
    localStorage.setItem('switchboard.artifactsSeen', JSON.stringify({ '1': ['chat/plan.md', 'chat/p.html', 'chat/a5.md'], '2': ['chat/a6.md'] }));
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const { page, source } = start();

    hello(source);

    for (let index = 4; index < 8; index++) {
      source.emit('artifact', { artifact: { path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 10_000 + index } });
    }

    vi.spyOn(root.querySelector('#detail .tabs')!, 'getBoundingClientRect').mockReturnValue({ width: 1 } as DOMRect);
    // Too narrow for any tab but Console, chosen: every artifact is in More.
    click('#detail [data-side="console"]');

    const dotted = () => [...root.querySelectorAll<HTMLElement>('#detail .tab-menu .menu-row[data-path]')].filter((row) => row.querySelector('.title > .unread-dot') !== null).map((row) => row.dataset['path']);

    // More carries the dot while a row in it is unread.
    expect(root.querySelector('#detail .tab-more-button .tab-badge > .unread-dot')).not.toBeNull();
    click('#detail [data-action="tab-menu"]');
    expect(dotted()).toEqual(['chat/a7.md', 'chat/a6.md', 'chat/a4.md']);
    expect(root.querySelector('#detail .tab-menu [data-path="chat/a4.md"]')!.getAttribute('aria-label')).toBe('Note 4, unread, Markdown document, just now');
    expect(root.querySelector('#detail .tab-menu [data-path="chat/a5.md"]')!.getAttribute('aria-label')).toBe('Note 5, Markdown document, just now');
    expect(root.querySelector('#detail .tab-menu [data-path="chat/a4.md"] .unread-dot')!.getAttribute('aria-label')).toBe('Unread');
    // No row says whether its tab is closed.
    expect(root.querySelector('#detail .tab-menu')!.textContent).not.toContain('Closed');

    // The work item's hello kept the versions it had of the paths kept alone; a path it did not have stays shown at whatever version comes.
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)).toEqual({ '1': { 'chat/plan.md': 1_500, 'chat/p.html': 1_500, 'chat/a5.md': -1 }, '2': { 'chat/a6.md': -1 } });

    // Opening one clears its dot and keeps its version for this device, merged with what another page kept meanwhile.
    localStorage.setItem('switchboard.artifactsSeen', JSON.stringify({ '1': { 'chat/plan.md': 1_500, 'chat/p.html': 1_500, 'chat/a5.md': -1, 'chat/a6.md': 10_006 }, '2': { 'chat/a6.md': -1 } }));
    click('#detail .tab-menu [data-path="chat/a4.md"]');
    click('#detail [data-action="tab-menu"]');
    expect(dotted()).toEqual(['chat/a7.md']);
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)).toEqual({ '1': { 'chat/plan.md': 1_500, 'chat/p.html': 1_500, 'chat/a5.md': -1, 'chat/a6.md': 10_006, 'chat/a4.md': 10_004 }, '2': { 'chat/a6.md': -1 } });

    // Another of this device's pages showing one clears it here too.
    const kept = JSON.stringify({ '1': { 'chat/plan.md': 1_500, 'chat/p.html': 1_500, 'chat/a5.md': -1, 'chat/a6.md': 10_006, 'chat/a4.md': 10_004, 'chat/a7.md': 10_007 } });

    localStorage.setItem('switchboard.artifactsSeen', kept);
    window.dispatchEvent(new StorageEvent('storage', { key: 'switchboard.artifactsSeen', newValue: kept }));
    expect(dotted()).toEqual([]);

    // A changed artifact is unread again, with the dot on its own tab where the strip has room for it, until its tab shows it.
    vi.restoreAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    click('#detail [data-side="history"]');
    source.emit('artifact', { artifact: { path: 'chat/a4.md', owner: 'chat', kind: 'note', title: 'Note 4', ext: 'md', type: 'markdown', updatedAt: 20_000 } });
    const tabDot = (path: string) => root.querySelector(`#detail .artifact-tab[data-path="${path}"] .tab-open > .tab-label + .unread-dot`);

    expect(tabDot('chat/a4.md')).not.toBeNull();
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/a4.md"] .tab-open')!.getAttribute('aria-label')).toBe('Note 4, unread');
    expect(tabDot('chat/a7.md')).toBeNull();
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/a7.md"] .tab-open')!.getAttribute('aria-label')).toBe('Note 7');
    // An artifact kept without a version does not turn unread when it changes, until it has a version kept.
    source.emit('artifact', { artifact: { path: 'chat/a5.md', owner: 'chat', kind: 'note', title: 'Note 5', ext: 'md', type: 'markdown', updatedAt: 20_000 } });
    expect(tabDot('chat/a5.md')).toBeNull();
    click('#detail .artifact-tab[data-path="chat/a4.md"] .tab-open');
    expect(tabDot('chat/a4.md')).toBeNull();
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)['1']['chat/a4.md']).toBe(20_000);
    // A new version that comes while its tab shows it is shown at once.
    source.emit('artifact', { artifact: { path: 'chat/a4.md', owner: 'chat', kind: 'note', title: 'Note 4', ext: 'md', type: 'markdown', updatedAt: 30_000 } });
    expect(tabDot('chat/a4.md')).toBeNull();
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)['1']['chat/a4.md']).toBe(30_000);
    page.close();
  });

  it('opens again an artifact closed on every device when a newer version comes, unread', () => {
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const { page, source } = start();

    hello(source, { tabs: { tab: null, closed: [{ path: 'chat/plan.md', updatedAt: 1_500 }] } });
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/plan.md"]')).toBeNull();
    // The same version again leaves it closed.
    source.emit('artifact', { artifact: artifact('chat/plan.md', 'markdown', 'md') });
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/plan.md"]')).toBeNull();
    source.emit('artifact', { artifact: { ...artifact('chat/plan.md', 'markdown', 'md'), updatedAt: 2_000 } });
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/plan.md"] .tab-open > .tab-label + .unread-dot')).not.toBeNull();
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/p.html"] .unread-dot')).toBeNull();
    page.close();
  });

  it('counts the artifacts a work item has when this device first sees it as opened, and marks only later ones', () => {
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const { page, source } = start();

    hello(source);
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)).toEqual({ '1': { 'chat/p.html': 1_500, 'chat/plan.md': 1_500 } });
    source.emit('artifact', { artifact: { path: 'chat/new.md', owner: 'chat', kind: 'note', title: 'New', ext: 'md', type: 'markdown', updatedAt: 1 } });
    vi.spyOn(root.querySelector('#detail .tabs')!, 'getBoundingClientRect').mockReturnValue({ width: 1 } as DOMRect);
    // Too narrow for any tab but Console, chosen: every artifact is in More.
    click('#detail [data-side="console"]');
    click('#detail [data-action="tab-menu"]');
    // By the hub's file times alone: an artifact with an older time than the page's clock is still new.
    expect(root.querySelector('#detail .tab-menu [data-path="chat/new.md"] .unread-dot')).not.toBeNull();
    expect(root.querySelector('#detail .tab-menu [data-path="chat/plan.md"] .unread-dot')).toBeNull();
    page.close();

    // A later page whose copy is stale, as when another page kept the work item first without this one hearing of it, adds nothing at its hello.
    localStorage.setItem('switchboard.artifactsSeen', JSON.stringify({ '2': {} }));

    const again = start();
    const fresh = JSON.stringify({ '1': { 'chat/p.html': 1_500, 'chat/plan.md': 1_500 }, '2': {} });

    localStorage.setItem('switchboard.artifactsSeen', fresh);
    hello(again.source, { artifacts: [artifact('chat/plan.md', 'markdown', 'md'), artifact('chat/p.html', 'html', 'html'), { path: 'chat/new.md', owner: 'chat', kind: 'note', title: 'New', ext: 'md', type: 'markdown', updatedAt: 1 }] });
    expect(localStorage.getItem('switchboard.artifactsSeen')).toBe(fresh);
    again.page.close();
  });

  it("shows History as a tab of the column after Changes only once the Actions menu opens it, with Console last, and an artifact's tab replaces it", () => {
    window.innerWidth = 1920;
    history.replaceState(null, '', '#w=1');
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const { page, source } = start();
    const tabs = () => [...root.querySelectorAll('#detail .side-switch > .tab:not(.artifact-tab):not(.panel-max)')].map((one) => one.textContent);

    // History is in the strip whether or not the row offers the ticket's History.
    hello(source, { artifacts: [], groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])] });
    expect(tabs()).toEqual(['Changes', 'History', 'Console']);
    hello(source, { artifacts: [], groups: [listGroup('progress', [listRow(1, { title: 'Fix it', history: { ticketId: 1, key: 'gh 1' } })])] });
    source.emit('artifact', { artifact: { path: 'chat/new.md', owner: 'chat', kind: 'note', title: 'New', ext: 'md', type: 'markdown', updatedAt: 1 } });
    // Console comes last, before the maximize button.
    expect(tabs()).toEqual(['Changes', 'History', 'Console']);
    expect(root.querySelector('#detail .side-switch > :last-child')?.classList.contains('panel-max')).toBe(true);
    expect(root.querySelector('#detail .artifact-tab[data-path="chat/new.md"]')).not.toBeNull();
    click('[data-action="actions"]');
    click('.actions-menu [data-action="row-history"]');
    expect(tabs()).toEqual(['Changes', 'History', 'Console']);
    expect(root.querySelector('.actions-menu')).toBeNull();
    expect(root.querySelector('#detail [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(root.querySelector('#detail [data-side="history"]'));
    expect(root.querySelector('#detail .detail-body .history-view')).not.toBeNull();
    // History lies in its tab, not over the conversation: the conversation and its column stay.
    expect(root.classList.contains('history')).toBe(false);
    expect(root.querySelector('#panel .history-view')).toBeNull();
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)).toEqual({ '1': {} });
    click('#detail .artifact-tab[data-path="chat/new.md"] .tab-open');
    expect(root.querySelector('#detail .tab.selected')!.getAttribute('data-path')).toBe('chat/new.md');
    expect(root.querySelector('.history-view')).toBeNull();
    expect(JSON.parse(localStorage.getItem('switchboard.artifactsSeen')!)).toEqual({ '1': { 'chat/new.md': 1 } });

    // A row that stops offering History keeps the tab, which then shows the head and the state alone.
    click('#detail [data-side="history"]');
    hello(source, { artifacts: [], groups: [listGroup('progress', [listRow(1, { title: 'Fix it' })])] });
    expect(tabs()).toContain('History');
    expect(root.querySelector('#detail [data-side="history"]')?.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('#detail .history-view .hist-toolbar')).toBeNull();
    expect(root.querySelector('#detail .history-view .hist-now')).not.toBeNull();
    page.close();
  });

  it('fits the tabs to the strip, keeping the chosen one, Changes and History, and lists the rest in More, every tab reachable through it', async () => {
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    const { page, source } = start();

    hello(source);

    for (let index = 0; index < 8; index++) {
      source.emit('artifact', { artifact: { path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 10_000 + index } });
    }

    const paths = () => [...root.querySelectorAll<HTMLElement>('#detail .artifact-tab')].map((tab) => tab.dataset['path']);
    const selected = () => root.querySelector<HTMLElement>('#detail .tabs > .tab.selected');
    const menuRows = () => [...root.querySelectorAll<HTMLElement>('#detail .tab-menu .menu-row')];

    // Unmeasured, the strip shows every tab and no More.
    expect(paths()).toHaveLength(10);
    expect(root.querySelector('#detail .tab-more')).toBeNull();

    // A 400 px strip. jsdom draws every tab 0 wide, so each measures as its 44 px least label alone, and More as page.css's 71 px: 329 px keep
    // seven tabs, Console chosen, Changes, History, then the four newest artifacts.
    const narrow = vi.spyOn(root.querySelector('#detail .tabs')!, 'getBoundingClientRect').mockReturnValue({ width: 400 } as DOMRect);

    click('#detail [data-side="console"]');
    expect(paths()).toEqual(['chat/a7.md', 'chat/a6.md', 'chat/a5.md', 'chat/a4.md']);
    expect(root.querySelector('#detail .side-switch > .changes-tab')).not.toBeNull();
    expect(root.querySelector('#detail .side-switch > [data-side="history"]')).not.toBeNull();
    expect(root.querySelector('#detail .tab-more-button .tab-badge')!.textContent).toBe('6');

    // More lists the rest in strip order, the older artifacts; picking one chooses it, closes the menu, and gives it a tab in place of Console,
    // which More now holds.
    click('#detail [data-action="tab-menu"]');
    expect(menuRows().slice(0, 4).map((row) => row.dataset['path'])).toEqual(['chat/a3.md', 'chat/a2.md', 'chat/a1.md', 'chat/a0.md']);
    expect(root.querySelector('#detail .tab-menu [data-action="diff-tab"]')).toBeNull();
    expect(menuRows()).toHaveLength(6);
    click('#detail .tab-menu [data-path="chat/a1.md"]');
    expect(root.querySelector('#detail .tab-menu')).toBeNull();
    expect(paths()).toEqual(['chat/a7.md', 'chat/a6.md', 'chat/a5.md', 'chat/a4.md', 'chat/a1.md']);
    expect(selected()!.dataset['path']).toBe('chat/a1.md');
    expect(root.querySelector('#detail .side-switch > [data-side="console"]')).toBeNull();

    // Console is reached through More too, and so is Changes in a strip with room for the chosen tab alone.
    click('#detail [data-action="tab-menu"]');
    narrow.mockReturnValue({ width: 115 } as DOMRect);
    click('#detail .tab-menu [data-side="console"]');
    expect(selected()!.dataset['side']).toBe('console');
    expect(root.querySelector('#detail .tab-menu')).toBeNull();
    answers['/v1/conversation/changes'] = { status: 404, body: { error: 'No changes here.' } };
    click('#detail [data-action="tab-menu"]');
    click('#detail .tab-menu [data-action="diff-tab"]');
    expect(root.querySelector('#detail .changes-tab.selected')).not.toBeNull();
    expect(root.querySelector('#detail .tab-menu')).toBeNull();
    narrow.mockReturnValue({ width: 400 } as DOMRect);

    // Up and Down move through the menu's rows; Escape closes it and gives the focus back to More; so does a press elsewhere.
    click('#detail [data-action="tab-menu"]');
    const more = root.querySelector<HTMLElement>('#detail .tab-more-button')!;

    more.focus();
    more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(menuRows()[0]);
    menuRows()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(menuRows()[1]);
    menuRows()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(menuRows()[0]);
    menuRows()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('#detail .tab-menu')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('#detail .tab-more-button'));
    click('#detail [data-action="tab-menu"]');
    root.querySelector('#panel')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    root.querySelector('#panel')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    root.querySelector('#panel')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelector('#detail .tab-menu')).toBeNull();

    // A narrower strip keeps the chosen tab and Changes, the rest going into More.
    click('#detail [data-action="tab-menu"]');
    click('#detail .tab-menu [data-path="chat/a1.md"]');
    narrow.mockReturnValue({ width: 200 } as DOMRect);
    click('#detail .artifact-tab[data-path="chat/a1.md"] .tab-open');
    expect(paths()).toEqual(['chat/a1.md']);
    expect(selected()!.dataset['path']).toBe('chat/a1.md');
    expect([...root.querySelectorAll<HTMLElement>('#detail .side-switch > [data-id]')].map((tab) => tab.dataset['id'])).toEqual(['changes', 'artifact:chat/a1.md']);
    narrow.mockReturnValue({ width: 400 } as DOMRect);
    click('#detail .artifact-tab[data-path="chat/a1.md"] .tab-open');

    // Left, Right, Home and End move between the strip's tabs, the artifact tabs among them, in the strip's order (tabs.ts) as on screen.
    const strip = () => [...root.querySelectorAll<HTMLElement>('#detail .tabs [role="tab"]')];

    strip()[0]!.focus();
    strip()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(strip()[1]);
    strip()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect((document.activeElement as HTMLElement).closest<HTMLElement>('.artifact-tab')!.dataset['path']).toBe('chat/a1.md');
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect((document.activeElement as HTMLElement).closest<HTMLElement>('.artifact-tab')!.dataset['path']).toBe('chat/a4.md');
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(strip()[0]);
    // The open artifact's close button is its own, and shows the tab before it in the strip, from More.
    const kept = () => posts.filter((post) => post.url.endsWith('/page-tabs')).map((post) => post.body);
    const before = kept().length;

    root.querySelector<HTMLElement>('#detail .artifact-tab.selected .tab-close')!.click();
    expect(selected()!.dataset['path']).toBe('chat/a2.md');
    // Closed, its tab is gone for the work item, kept in the hub for every device; the tab shown in its place is no choice, so it is not kept.
    expect(paths()).not.toContain('chat/a1.md');
    expect(kept().slice(before)).toEqual([expect.objectContaining({ workItemId: 1, close: { path: 'chat/a1.md', updatedAt: 10_001 } })]);
    click('#detail [data-action="tab-menu"]');
    expect(root.querySelector('#detail .tab-menu .menu-separator + [data-path="chat/a1.md"]')).not.toBeNull();
    // Choosing it opens its tab again.
    click('#detail .tab-menu [data-path="chat/a1.md"]');
    expect(selected()!.getAttribute('data-path')).toBe('chat/a1.md');
    expect(posts.filter((post) => post.url.endsWith('/page-tabs')).at(-2)?.body).toMatchObject({ workItemId: 1, reopen: 'chat/a1.md' });
    // The hub sends this page's own changes back as `tabs`, each with its request's opId, its close after the reopen here: neither moves anything
    // or keeps anything. Nor does another device's older event in which the artifact was open, though it holds the reopen's state before the
    // reopen's own echo.
    const echoed = kept().length;
    const opOf = (key: string) => ([...kept()].reverse().find((body) => (body as Record<string, unknown>)[key] !== undefined) as { opId: string }).opId;
    const [closeOp, reopenOp] = [opOf('close'), opOf('reopen')];

    expect(closeOp).not.toBe(reopenOp);
    source.emit('tabs', { workItemId: 1, tabs: { tab: null, closed: [] } });
    expect(selected()!.getAttribute('data-path')).toBe('chat/a1.md');
    source.emit('tabs', { workItemId: 1, opId: closeOp, tabs: { tab: null, closed: [{ path: 'chat/a1.md', updatedAt: 10_001 }] } });
    expect(selected()!.getAttribute('data-path')).toBe('chat/a1.md');
    source.emit('tabs', { workItemId: 1, opId: reopenOp, tabs: { tab: 'artifact:chat/a1.md', closed: [] } });
    expect(selected()!.getAttribute('data-path')).toBe('chat/a1.md');
    expect(kept()).toHaveLength(echoed);
    // Another device closing the open artifact shows Status here, and keeps nothing.
    source.emit('tabs', { workItemId: 1, tabs: { tab: null, closed: [{ path: 'chat/a1.md', updatedAt: 10_001 }] } });
    expect(kept()).toHaveLength(echoed);
    expect(selected()!.getAttribute('data-side')).toBe('history');
    expect(paths()).not.toContain('chat/a1.md');
    narrow.mockRestore();
    click('#detail [data-side="history"]');
    // Another device closing a tab closes it here too, and a newer version opens it again.
    source.emit('tabs', { workItemId: 1, tabs: { tab: null, closed: [{ path: 'chat/a7.md', updatedAt: 10_007 }] } });
    expect(paths()).not.toContain('chat/a7.md');
    source.emit('artifact', { artifact: { path: 'chat/a7.md', owner: 'chat', kind: 'note', title: 'Note 7', ext: 'md', type: 'markdown', updatedAt: 20_000 } });
    expect(paths()).toContain('chat/a7.md');

    // An artifact that goes away leaves Status shown.
    click('#detail .artifact-tab[data-path="chat/a7.md"]');
    hello(source, { artifacts: [] });
    expect(root.querySelector('#detail .artifact-tab')).toBeNull();
    expect(root.querySelector('#detail .tab.selected')!.getAttribute('data-side')).toBe('history');
    vi.unstubAllGlobals();
    page.close();
  });

  it('measures hidden tabs again when the strip crosses the 480 px breakpoint, so a tab measured under the other padding neither overflows nor hides', () => {
    window.innerWidth = 1920;
    onTestFinished(() => {
      vi.restoreAllMocks();
    });

    const { page, source } = start();

    hello(source);

    for (let index = 0; index < 8; index++) {
      source.emit('artifact', { artifact: { path: `chat/a${index}.md`, owner: 'chat', kind: 'note', title: `Note ${index}`, ext: 'md', type: 'markdown', updatedAt: 10_000 + index } });
    }

    // page.css's sizing: --sb-tab-pad is 14 px, or 9 px in a strip of 480 px or less. Each tab is drawn at its least width under the padding in
    // force, its label 44 px: an artifact's pad + 99 px, Status 2 * pad + 67 px, Changes 2 * pad + 111 px, More 2 * pad + 43 px.
    let pad = 14;
    let strip = 600;

    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ display: 'block', maxWidth: '', getPropertyValue: (name: string) => (name === '--sb-tab-pad' ? `${pad}px` : '') }) as unknown as CSSStyleDeclaration);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const width = this.matches('#detail .tabs')
        ? strip
        : this.matches('#detail .tabs > .tab-more')
          ? 2 * pad + 43
          : this.matches('#detail .tabs > .changes-tab')
            ? 2 * pad + 111
            : this.matches('#detail .tabs > [data-id]')
              ? this.querySelector(':scope > .tab-close') === null ? 2 * pad + 67 : pad + 99
              : this.matches('#detail .tabs .tab-label')
                ? 44
                : 0;

      return { width } as DOMRect;
    });

    const shown = () => [...root.querySelectorAll<HTMLElement>('#detail .tabs > [data-id]')].map((tab) => tab.dataset['id']);
    const redraw = () => click('#detail [data-side="history"]');

    // 600 px at 14 px padding: Changes (139 px), History (95 px) and two artifacts (113 px each) beside More (71 px); the rest, hidden, were
    // measured at 113 px.
    redraw();
    expect(shown()).toEqual(['changes', 'history', 'artifact:chat/a7.md', 'artifact:chat/a6.md']);
    // 385 px takes 9 px padding: Changes 129 px, History 85 px and More 61 px leave 110 px, one artifact's room at 108 px. With a7 closed, a6
    // fits at 108 px, which a measure kept from 14 px padding would hide.
    strip = 385;
    pad = 9;
    redraw();
    expect(shown()).toEqual(['changes', 'history', 'artifact:chat/a7.md']);
    root.querySelector<HTMLElement>('#detail .artifact-tab[data-path="chat/a7.md"] .tab-close')!.click();
    expect(shown()).toEqual(['changes', 'history', 'artifact:chat/a6.md']);
    // Back to 14 px padding at 750 px: Changes, History and More leave 445 px, room for three artifacts at 113 px, not for a fourth that
    // measures kept from 9 px padding (Changes 129 px, History 85 px, a6 108 px) would let in.
    strip = 750;
    pad = 14;
    redraw();
    expect(shown()).toEqual(['changes', 'history', 'artifact:chat/a6.md', 'artifact:chat/a5.md', 'artifact:chat/a4.md']);
    page.close();
  });

  it('switches tabs, opens artifacts in the page, and draws a Markdown artifact with its pictures from its own folder', async () => {
    const { page, source, mermaid } = start();

    answers['/artifact/'] = { status: 200, body: {}, text: '---\ntitle: Plan\n---\n# Plan\n\n![pic](plan/pic.png) ![up](../x.png)' };
    hello(source);
    click('[data-tab="history"]');
    expect(root.querySelector('#panel')!.innerHTML).toContain('hist-now');
    expect(mermaid).toHaveBeenCalled();
    // Each artifact has its own tab, newest first, and no Artifacts tab lists them.
    expect(root.querySelector('[data-tab="artifacts"]')).toBeNull();
    expect([...root.querySelectorAll<HTMLElement>('#head .artifact-tab')].map((tab) => tab.dataset['path'])).toHaveLength(2);
    click('#head .artifact-tab[data-path="chat/plan.md"]');
    await flush();
    await flush();

    const doc = root.querySelector('.artifact-doc')!.innerHTML;

    expect(doc).toContain('<h1 data-anchor="plan">Plan</h1>');
    expect(doc).toContain('src="/v1/conversation/artifact/pk/chat/plan/pic.png"');
    // With no artifact folder known, a picture outside it has nothing to read from: a note names it in its place.
    expect(root.querySelector('.artifact-doc .picture.broken .picture-missing')!.textContent).toBe('Picture not shown: up');
    expect(root.querySelectorAll('.artifact-doc img')).toHaveLength(1);
    expect(root.querySelector('#head .tab.selected')!.getAttribute('data-path')).toBe('chat/plan.md');
    // Closing its tab shows the tab after it, with none before it, and the closed tab goes.
    click('#head .artifact-tab.selected .tab-close');
    expect(root.querySelector('#head .tab.selected')!.getAttribute('data-path')).toBe('chat/p.html');
    expect(root.querySelectorAll('#head .artifact-tab')).toHaveLength(1);
    click('#head .artifact-tab[data-path="chat/p.html"]');
    expect(root.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts');
    click('[data-tab="conversation"]');
    expect(root.querySelector('#composer')!.hasAttribute('hidden')).toBe(false);
    page.close();
  });

  it("draws a Markdown artifact's pictures from its folder by the artifact route and any other picture through the local file route, with a note for one that fails", async () => {
    const { page, source } = start();

    answers['/artifact/'] = {
      status: 200,
      body: {},
      text: '# Plan\n\n![a](plan/a.png) ![b](plan/sub/my%20shot%20%231.png) ![c](../../shots/c.png) ![d](D:\\w\\d.png) ![e](file:///D:/w/e%20f.png) ![g](<plan/g h.png>) ![web](https://example.com/w.png)\n\n<p align="center">\n  <img src="plan/h.png" alt="H" width="300">\n</p>',
    };
    hello(source, { artifactsDir: 'D:\\w\\.wip\\artifacts\\w1' });
    click('#head .artifact-tab[data-path="chat/plan.md"]');
    await flush();
    await flush();

    const doc = root.querySelector<HTMLElement>('.artifact-doc')!;
    const sources = [...doc.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    const local = (path: string): string => `/v1/conversation/local-file-raw?window=pk&path=${encodeURIComponent(path)}`;

    expect(sources).toEqual([
      '/v1/conversation/artifact/pk/chat/plan/a.png',
      '/v1/conversation/artifact/pk/chat/plan/sub/my%20shot%20%231.png',
      local('D:/w/.wip/artifacts/shots/c.png'),
      local('D:/w/d.png'),
      local('D:/w/e f.png'),
      '/v1/conversation/artifact/pk/chat/plan/g%20h.png',
      'https://example.com/w.png',
      '/v1/conversation/artifact/pk/chat/plan/h.png',
    ]);
    // The README form's wrapper is not shown as text, and its picture keeps its width.
    expect(doc.textContent).not.toContain('<p');
    expect(doc.querySelector('img[alt="H"]')!.getAttribute('width')).toBe('300');
    // A picture that fails shows its note, and the picture again once a later source loads.
    const web = doc.querySelector<HTMLImageElement>('img[alt="web"]')!;

    expect(web.parentElement!.classList.contains('broken')).toBe(false);
    web.dispatchEvent(new Event('error'));
    expect(web.parentElement!.classList.contains('broken')).toBe(true);
    expect(web.parentElement!.querySelector('.picture-missing')!.textContent).toBe('Picture not shown: web Open');
    expect(web.parentElement!.querySelector('.picture-missing a')!.getAttribute('href')).toBe('https://example.com/w.png');
    web.dispatchEvent(new Event('load'));
    expect(web.parentElement!.classList.contains('broken')).toBe(false);
    page.close();
  });

  it("reads an external artifact's pictures in its folder, as a review's screenshots/, by the artifact route, and one outside it as a local file, with a link to it in a file tab", async () => {
    const { page, source } = start();
    const review = { ...artifact('@7/review.md', 'markdown', 'md'), file: 'D:/wt/.wip/review-pr/round-1/review.md' };

    answers['/artifact/'] = { status: 200, body: {}, text: '# Review\n\n![own](review/a.png) ![shot](screenshots/uat-1.png) [shot](shots/my%20shot%20%231.png#L2) ![readme](../../../docs/images/x.png) ![uri](file:///D:/x/a%2520b.png)' };
    hello(source, { artifacts: [review], artifactsDir: 'D:/wt/.wip/artifacts/w1' });
    click('#head .artifact-tab[data-path="@7/review.md"]');
    await flush();
    await flush();

    const doc = root.querySelector<HTMLElement>('.artifact-doc')!;

    expect([...doc.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([
      '/v1/conversation/artifact/pk/%407/review/a.png',
      '/v1/conversation/artifact/pk/%407/screenshots/uat-1.png',
      `/v1/conversation/local-file-raw?window=pk&path=${encodeURIComponent('D:/wt/docs/images/x.png')}`,
      `/v1/conversation/local-file-raw?window=pk&path=${encodeURIComponent('D:/x/a%20b.png')}`,
    ]);
    // A link to a file beside it opens a file tab at its line, which reads the link as written: its name's # is not its fragment.
    const target = doc.querySelector<HTMLElement>('a.path-link')!.dataset['target']!;

    expect(linkTarget(target)).toEqual({ path: 'D:/wt/.wip/review-pr/round-1/shots/my shot #1.png', line: 2 });
    page.close();
  });

  it('shows text, data and code preformatted, JSON indented, a PDF in the browser viewer, and only an unknown file as a download', async () => {
    const { page, source } = start();
    const artifact = (path: string, ext: string, updatedAt: number) => ({ path, owner: 'chat', kind: 'report', title: path, ext, type: 'file', updatedAt });

    answers['/artifact/'] = { status: 200, body: {}, text: '{"a":1,"b":"<x>"}' };
    hello(source, { artifacts: [artifact('chat/data.json', 'json', 4), artifact('chat/notes.txt', 'txt', 3), artifact('chat/report.pdf', 'pdf', 2), artifact('chat/blob.bin', 'bin', 1)] });
    click('#head .artifact-tab[data-path="chat/data.json"]');
    await flush();
    await flush();
    const json = root.querySelector('.artifact-doc pre.artifact-text code')!;

    expect(json.textContent).toBe('{\n  "a": 1,\n  "b": "<x>"\n}');
    expect(json.innerHTML).toContain('&lt;x&gt;');
    expect(root.querySelector('.artifact-view a[download]')).toBeNull();
    expect(root.querySelector('.artifact-view [title="Open in new window"]')).not.toBeNull();

    answers['/artifact/'] = { status: 200, body: {}, text: 'plain <b>text</b>' };
    click('#head .artifact-tab[data-path="chat/notes.txt"]');
    await flush();
    await flush();
    expect(root.querySelector('.artifact-doc pre.artifact-text')!.textContent).toBe('plain <b>text</b>');
    expect(root.querySelector('.artifact-doc b')).toBeNull();

    click('#head .artifact-tab[data-path="chat/report.pdf"]');
    const pdf = root.querySelector('iframe.artifact-pdf')!;

    expect(pdf.getAttribute('src')).toContain('/v1/conversation/artifact/pk/chat/report.pdf');
    expect(pdf.hasAttribute('sandbox')).toBe(false);

    click('#head .artifact-tab[data-path="chat/blob.bin"]');
    expect(root.querySelector('.artifact-view .empty')!.textContent).toBe('This kind of file cannot be shown here. Open it in a new window.');
    expect(root.querySelector('.artifact-view a[download]')).toBeNull();
    page.close();
  });

  it("gives every pill on line 2 an icon to shrink to: a link the hub sends no glyph for the link icon, a key its source's logo in place of its label, and a source without a logo the plug (page.css, Line 2)", () => {
    const root = document.createElement('div');
    const links = Array.from({ length: 18 }, (_, i) => ({ label: `L${i}`, url: `https://x/${i}`, kind: 'url' as const, badge: `L${i}`, glyph: null, mentioned: false }));

    const dpaf = { viewBox: '0 0 20 16', path: 'M0 0h20v16H0z', color: '#d33', width: 20 };

    root.innerHTML = html(renderList([listGroup('progress', [listRow(1, { links, ticketNumber: '1' }), listRow(2, { sourceKind: 'forum', ticket: 'forum 4', ticketNumber: '4' }), listRow(3, { sourceKind: 'zoho', ticket: 'zoho 7', ticketNumber: '7' }), listRow(4, { sourceKind: 'dpaf', ticket: 'dpaf 311', ticketNumber: '311' }), listRow(5, { ticket: 'dash 63' })])], null, new Set(), false, null, new Map(), false, null, { dpaf }));

    expect([...root.querySelectorAll('[data-work-item="1"] .row-links > .pill .codicon')].map((icon) => icon.textContent)).toEqual(Array(18).fill('\u{eb15}'));
    // A key with its source's logo shows its number after it, its label hidden from view but read with it; the pill's tooltip has the whole key.
    const key = (id: number) => root.querySelector(`[data-work-item="${id}"] .pill.ticket`)!;
    const shown = (id: number) => [key(id).firstElementChild!.getAttribute('class'), key(id).querySelector('.key-label')?.textContent ?? null, key(id).querySelector('.pill-text')!.textContent, key(id).getAttribute('title')];

    expect(shown(1)).toEqual(['source-logo github', 'gh ', 'gh 1', 'gh 1']);
    expect(shown(3)).toEqual(['source-logo zoho', 'zoho ', 'zoho 7', 'zoho 7']);
    // A plugin's own logo, in its colour, for a source such as DPAF.
    expect(shown(4)).toEqual(['source-logo dpaf custom', 'dpaf ', 'dpaf 311', 'dpaf 311']);
    expect(key(4).querySelector('svg path')!.getAttribute('d')).toBe('M0 0h20v16H0z');
    // A source with no logo shows the plug and its whole key, and a key another repository's prefix starts, which the hub sends no number for, shows whole.
    expect(shown(2)).toEqual(['codicon codicon-plug source-logo', null, 'forum 4', 'forum 4']);
    expect(shown(5)).toEqual(['source-logo github', null, 'dash 63', 'dash 63']);
    // No unseen fit boxes: the list's width alone decides what shows.
    expect(root.querySelector('.row-links-box, .row-links-shown, .row-links-fit, .row-links-fit-text')).toBeNull();
  });

  it("takes the source plugins' own logos from the list header's source icons, by kind", () => {
    const icon = { viewBox: '0 0 16 16', path: 'M0 0h16v16H0z' };

    expect(sourceIcons(null)).toEqual({});
    expect(sourceIcons({ notes: [], sources: [{ kind: 'github', enabled: true, title: '', sources: [] }, { kind: 'dpaf', icon, enabled: false, title: '', sources: [] }], repoRoots: [], schedules: [] })).toEqual({ dpaf: icon });
    // The same header gives the same object, so the list's rows, which take it, are not drawn again; another header is read anew.
    const header = { notes: [], sources: [{ kind: 'dpaf', icon, enabled: true, title: '', sources: [] }], repoRoots: [], schedules: [] };
    expect(sourceIcons(header)).toBe(sourceIcons(header));
    expect(sourceIcons({ ...header, sources: [] })).toEqual({});
  });

  it("draws line 2's pills the same on every redraw, however narrow the row, without measuring them (page.css, Line 2)", async () => {
    const { page, source } = start();
    // Widths that would not fit: a 150 px line, 80 px pills and a 100 px playbook.
    const widths = vi.fn((element: HTMLElement): number => (element.classList.contains('row-line') ? 150 : element.classList.contains('pill') ? 80 : element.classList.contains('playbook') ? 100 : 0));

    for (const property of ['clientWidth', 'offsetWidth', 'scrollWidth'] as const) {
      vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (this: HTMLElement) {
        return widths(this);
      });
    }
    const groups = [listGroup('progress', [listRow(1, { links: [{ kind: 'pr', badge: '21510', label: 'PR #21510', url: 'https://x/21510', glyph: '\u{ea64}', mentioned: false }, { kind: 'url', badge: 'Design notes', label: 'Design notes', url: 'https://x/notes', glyph: '\u{eb15}', mentioned: false }], returned: 2 })])];

    hello(source, { groups });
    await flush();
    await new Promise((done) => setTimeout(done, 20));

    const line = (): string => root.querySelector('[data-work-item="1"] .row-line:not(.row-details)')!.outerHTML;
    const first = line();
    const changes: string[] = [];
    const watch = new MutationObserver((records) => records.forEach((record) => changes.push(`${record.type} ${(record.target as Element).className ?? ''} ${record.attributeName ?? ''}`)));

    watch.observe(root.querySelector('#list')!, { subtree: true, attributes: true, childList: true, characterData: true });
    // A busy hub resends the same list with every session event.
    for (let again = 0; again < 5; again++) {
      source.emit('list', { groups });
      await flush();
      await new Promise((done) => setTimeout(done, 20));
    }
    watch.disconnect();

    expect(changes).toEqual([]);
    expect(line()).toBe(first);
    // Every pill whole, its text shown: the key's number, the PR's number, the link's label and Returned's count.
    expect([...root.querySelectorAll('[data-work-item="1"] .row-line > .pill, [data-work-item="1"] .row-links > .pill')].map((pill) => [pill.className, pill.querySelector('.pill-text')!.textContent])).toEqual([
      ['pill ticket source-github', 'gh 1'],
      ['pill link pr', '21510'],
      ['pill link url', 'Design notes'],
      ['pill returned', '2'],
    ]);
    // The page reads no width of line 2: its CSS alone decides what shows.
    expect(widths.mock.calls.filter(([element]) => element.closest('.row-line') !== null)).toEqual([]);
    page.close();
  });

  it("opens the header's menus down and to the right of their buttons, and the other way only where the page has no room", () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(600);
    let gear = 770;
    const rect = (element: HTMLElement): DOMRect => {
      // A menu in its default place: under its anchor, left edges lined up.
      const anchor = element.classList.contains('menu') ? rect(element.parentElement!) : null;
      const left = anchor?.left ?? (element.classList.contains('view-options-anchor') ? gear : 40);
      const top = anchor === null ? 8 : anchor.bottom + 2;
      const [width, height] = anchor === null ? [24, 24] : [200, 120];

      return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
    };

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rect(this);
    });

    const { page, source } = start();

    hello(source);
    click('.header button.picker');
    expect(root.querySelector('.conversation-menu')!.className).toBe('glass menu conversation-menu');
    expect(root.querySelector<HTMLElement>('.conversation-menu')!.style.maxWidth).toBe('360px');
    click('.header button.view-options');
    expect(root.querySelector('.view-options-menu')!.className).toBe('glass menu view-options-menu flip-x');
    // A scroll that moves the button is followed; the menu's own scrolling is not.
    gear = 40;
    root.querySelector('.view-options-menu')!.dispatchEvent(new Event('scroll'));
    expect(root.querySelector('.view-options-menu')!.className).toBe('glass menu view-options-menu flip-x');
    root.querySelector('#panel')!.dispatchEvent(new Event('scroll'));
    expect(root.querySelector('.view-options-menu')!.className).toBe('glass menu view-options-menu');
    page.close();
  });

  it("keeps the conversation's text at fixed sizes: drops the old text size key, leaves Ctrl+=, Ctrl+- and Ctrl+0 to the browser, and offers no text size in View options", () => {
    localStorage.setItem('switchboard.textScale', '1.25');

    const { page, source } = start();

    expect(localStorage.getItem('switchboard.textScale')).toBeNull();
    expect(root.style.getPropertyValue('--chat-scale')).toBe('');
    hello(source);

    for (const key of ['=', '+', '-', '0']) {
      const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });

      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }

    expect(root.querySelector('.view-options-menu')).toBeNull();
    click('.header button.view-options');
    expect(root.querySelector('.header button.view-options')!.getAttribute('title')).toBe('View options');
    expect([...root.querySelectorAll('.view-options-menu .menu-row')].map((row) => row.textContent!.trim())).toEqual(['Show message times and notes', 'Fold reply details', 'Spoken repliesExperimental']);
    expect(root.querySelector('.view-options-menu .menu-separator')).toBeNull();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.view-options-menu')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('.header button.view-options'));

    // One header menu at a time: View options closes the dropdown, and the dropdown View options.
    click('.header button.picker');
    click('.header button.view-options');
    expect(root.querySelector('.header button.picker')!.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.view-options-menu')).not.toBeNull();
    click('.header button.picker');
    expect(root.querySelector('.view-options-menu')).toBeNull();
    click('.header button.picker');

    // Show message details, in the same menu, kept.
    click('.header button.view-options');
    expect(root.querySelector('[data-action="toggle-details"]')!.getAttribute('aria-checked')).toBe('false');
    click('[data-action="toggle-details"]');
    expect(localStorage.getItem('switchboard.messageDetails')).toBe('1');
    expect(root.querySelector('[data-action="toggle-details"]')!.getAttribute('aria-checked')).toBe('true');
    page.close();

    const again = start();

    hello(again.source);
    click('.header button.view-options');
    expect(root.querySelector('[data-action="toggle-details"]')!.getAttribute('aria-checked')).toBe('true');
    click('[data-action="toggle-details"]');
    expect(localStorage.getItem('switchboard.messageDetails')).toBeNull();
    again.page.close();
  });

  it("resizes the work items from their sash by dragging and the arrow keys, within limits, keeps the width, and resets it on a double-click", () => {
    localStorage.setItem('switchboard.sideWidth', '300');

    const { page } = start();
    const side = root.querySelector<HTMLElement>('.side')!;
    const sash = root.querySelector<HTMLElement>('.side-sash')!;
    const width = (): string => root.style.getPropertyValue('--side-width');

    // The kept width is set before the list is drawn, so the page does not jump.
    expect(width()).toBe('300px');
    expect(sash.getAttribute('role')).toBe('separator');
    expect(sash.getAttribute('aria-valuenow')).toBe('300');
    vi.spyOn(side, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, width: parseFloat(width()) || 300 }) as DOMRect);

    sash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 300, bubbles: true }));
    expect(root.classList.contains('resizing')).toBe(true);
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 420, bubbles: true }));
    expect(width()).toBe('420px');
    // Kept only when the drag ends.
    expect(localStorage.getItem('switchboard.sideWidth')).toBe('300');
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 5_000, bubbles: true }));
    expect(width()).toBe(`${SIDE_MAX}px`);
    // Dragged to the page's edge, the list stops at its least width and stays pinned: a drag never makes it a drawer.
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN}px`);
    sash.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(root.classList.contains('resizing')).toBe(false);
    expect(root.classList.contains('drawers')).toBe(false);
    expect(localStorage.getItem('switchboard.sideWidth')).toBe(String(SIDE_MIN));
    expect(localStorage.getItem('switchboard.listCollapsed')).toBeNull();
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN}px`);
    expect(root.classList.contains('drawers')).toBe(false);
    // A move after the drag ended changes nothing.
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 400, bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN}px`);

    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN + 16}px`);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN + 80}px`);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(width()).toBe(`${SIDE_MIN + 64}px`);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(localStorage.getItem('switchboard.sideWidth')).toBe(String(SIDE_MAX));
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(width()).toBe(`${SIDE_MAX}px`);

    // On a narrow page, which holds the list at half its width, the keys step from the width drawn, not the one set.
    Object.defineProperty(side, 'clientWidth', { configurable: true, get: () => Math.min(parseFloat(width()), 384) });
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(width()).toBe('368px');
    expect(sash.getAttribute('aria-valuenow')).toBe('368');
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(sash.getAttribute('aria-valuenow')).toBe('384');

    sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(width()).toBe('');
    expect(sash.hasAttribute('aria-valuenow')).toBe(false);
    expect(localStorage.getItem('switchboard.sideWidth')).toBeNull();
    page.close();
  });

  it("keeps the conversation's width set on its sash beside the Status and Artifacts column, and forgets it on a double-click", () => {
    localStorage.setItem('switchboard.chatWidth', '700');

    const { page } = start();
    const main = root.querySelector<HTMLElement>('.main')!;
    const sash = root.querySelector<HTMLElement>('.chat-sash')!;
    const width = (): string => root.style.getPropertyValue('--chat-width');

    expect(width()).toBe('700px');
    expect(root.style.getPropertyValue('--side-width')).toBe('');
    // The sash sits between the conversation and the column, and sets the conversation's width, not the column's.
    expect(sash.previousElementSibling).toBe(main);
    expect(sash.nextElementSibling!.id).toBe('detail');
    vi.spyOn(main, 'getBoundingClientRect').mockImplementation(() => ({ left: 300, width: parseFloat(width()) || 940 }) as DOMRect);
    sash.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 1_000, bubbles: true }));
    sash.dispatchEvent(new MouseEvent('pointermove', { clientX: 1_200, bubbles: true }));
    sash.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(width()).toBe('900px');
    expect(localStorage.getItem('switchboard.chatWidth')).toBe('900');
    expect(localStorage.getItem('switchboard.sideWidth')).toBeNull();
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(width()).toBe(`${CHAT_MIN}px`);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    expect(width()).toBe(`${CHAT_MIN + 64}px`);
    sash.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(localStorage.getItem('switchboard.chatWidth')).toBe(String(CHAT_MAX));
    sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(width()).toBe('');
    expect(localStorage.getItem('switchboard.chatWidth')).toBeNull();
    page.close();
  });

});
