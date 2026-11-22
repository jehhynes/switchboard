import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinPath, linkTarget, localFileUrl, localMarkdown } from '../src/localLinks.js';
import type { LocalFileData } from '../src/localLinks.js';
import { renderMarkdown } from '../src/markdown.js';
import type { DiffModule } from '../src/diff/types.js';
import { startPage } from '../src/main.js';

class FakeSource {
  static last: FakeSource | null = null;
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  constructor(readonly url: string) {
    FakeSource.last = this;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify({ type, ...(data as object) }) });
    }
  }

  close(): void {}
}

const file = (patch: Partial<LocalFileData>): LocalFileData => ({ path: 'D:/w/x', name: 'x', kind: 'text', contents: null, tooLarge: false, size: 1, entries: null, more: false, ...patch });

describe('local file link targets', () => {
  it('reads the line a link names, by #L or after the name, and decodes what markdown-it encoded', () => {
    expect(linkTarget('src/a.ts#L42')).toEqual({ path: 'src/a.ts', line: 42 });
    expect(linkTarget('src/a.ts#L42-L50')).toEqual({ path: 'src/a.ts', line: 42 });
    expect(linkTarget('src/a.ts:7')).toEqual({ path: 'src/a.ts', line: 7 });
    expect(linkTarget('src/a.ts:7:3')).toEqual({ path: 'src/a.ts', line: 7 });
    expect(linkTarget('D:/git/my%20file.md')).toEqual({ path: 'D:/git/my file.md', line: null });
    expect(linkTarget('file:///D:/git/a%20b.ts#L3')).toEqual({ path: 'file:///D:/git/a%20b.ts', line: 3 });
    expect(linkTarget('.wip/shots/')).toEqual({ path: '.wip/shots/', line: null });
    // A drive alone is no line; a link to a place in the same text names no file.
    expect(linkTarget('C:5')).toEqual({ path: 'C:5', line: null });
    expect(linkTarget('#usage')).toBeNull();
    expect(linkTarget('a%zz.md')).toEqual({ path: 'a%zz.md', line: null });
  });

  it('joins a relative link to its file\'s folder', () => {
    expect(joinPath('D:/w/.wip', 'shots/a.png')).toBe('D:/w/.wip/shots/a.png');
    expect(joinPath('D:/w/.wip', '../src/./a.ts')).toBe('D:/w/src/a.ts');
    expect(joinPath('D:', '../../a.ts')).toBe('D:/a.ts');
  });

  it('makes a path in a reply a focusable local file link and keeps a web link a new tab', () => {
    const html = renderMarkdown('[Review](.wip/review.md) [x](https://example.com/a) [bad](javascript:alert(1))');
    const host = document.createElement('div');

    host.innerHTML = html;

    const local = host.querySelector<HTMLElement>('a.path-link')!;

    expect(local.dataset['action']).toBe('local-file');
    expect(local.dataset['target']).toBe('.wip/review.md');
    expect(local.getAttribute('tabindex')).toBe('0');
    expect(local.hasAttribute('href')).toBe(false);
    expect(host.querySelector('a[href="https://example.com/a"]')!.getAttribute('target')).toBe('_blank');
    expect(host.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it("draws a local Markdown file with its relative pictures and links against its own folder", () => {
    const host = document.createElement('div');

    host.innerHTML = localMarkdown('pk', file({ path: 'D:/w/.wip/review.md', kind: 'markdown', contents: '# Review\n\n![shot](shots/a%20b.png) [code](../src/a.ts#L3) [abs](D:/w/b.md) [top](#review) [&](x&y.md)' }));

    expect(host.querySelector('h1')!.textContent).toBe('Review');
    expect(host.querySelector('img')!.getAttribute('src')).toBe(localFileUrl('pk', 'D:/w/.wip/shots/a b.png', true));
    expect([...host.querySelectorAll<HTMLElement>('a.path-link')].map((one) => one.dataset['target'])).toEqual(['D:/w/src/a.ts#L3', 'D:/w/b.md', '#review', 'D:/w/.wip/x&y.md']);
  });
});

describe('web links with the Chrome pane', () => {
  let root: HTMLElement;
  let pages: Array<{ close(): void }>;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    pages = [];
  });

  afterEach(() => {
    pages.forEach((page) => page.close());
    vi.restoreAllMocks();
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const start = (options: { installed: boolean; paneOpen?: number; width?: number }) => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const opened: string[] = [];
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const status = url.endsWith('/pane-open') ? (options.paneOpen ?? 200) : 200;

      return { status, ok: status === 200, json: async () => (status === 200 ? {} : { error: 'The Chrome pane is not connected.' }) } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, standalone: () => options.installed, openUrl: (url) => opened.push(url), toExtension: async () => ({ ok: true }) });
    const source = FakeSource.last!;
    const scope = { kind: 'page', key: 'pk', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };
    const session = { id: 's', title: 'Task', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null };
    const reply = { type: 'reply', id: 'r1', sessionId: 's', at: 1_000, ord: 1, provisional: false, kind: 'reply', answers: null, opening: 'See [the docs](https://example.com/docs).', rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null } };
    // A work item with no links of its own, so only the opened link gives the Browser tab something to show.
    const row = { workItemId: 1, ticketId: null, title: 'Fix it', priority: null, time: null, ticket: 'gh 1', sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], terminal: false, band: null, voice: null, history: null };

    pages.push(page);
    vi.spyOn(root.querySelector('#detail .detail-body')!, 'getBoundingClientRect').mockReturnValue({ left: 1000, top: 40, width: options.width ?? 600, height: 800 } as DOMRect);
    window.innerWidth = 1600;
    window.dispatchEvent(new Event('resize'));
    source.emit('hello', { key: 'pk', groups: [{ key: 'progress', title: 'In progress', glyph: '', empty: null, rows: [row] }], scope, sessions: [session], items: [reply], more: false, status: null, artifacts: [], unread: 0 });
    source.emit('pane', { pane: { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: null } });
    return { posts, opened };
  };
  const clickLink = (): MouseEvent => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });

    root.querySelector<HTMLElement>('.body a[href="https://example.com/docs"]')!.dispatchEvent(event);
    return event;
  };

  it("opens a reply's web link in the pane's window and shows the Browser tab, instead of a new tab in the last focused browser window", async () => {
    const { posts, opened } = start({ installed: true });

    await flush();
    expect(root.querySelector('[data-side="browser"]')).toBeNull();

    const event = clickLink();

    expect(event.defaultPrevented).toBe(true);
    await flush();
    expect(posts.filter((post) => post.url.endsWith('/pane-open')).map((post) => post.body['url'])).toEqual(['https://example.com/docs']);
    expect(root.querySelector('#detail .side-switch [aria-selected="true"]')!.textContent).toBe('Browser');
    expect(opened).toEqual([]);
  });

  it('opens the link in a new browser tab when the hub refuses it', async () => {
    const refused = start({ installed: true, paneOpen: 409 });

    await flush();
    clickLink();
    await flush();
    await flush();
    expect(refused.opened).toEqual(['https://example.com/docs']);
    expect(root.querySelector('[data-side="browser"]')).toBeNull();
  });

  it('opens the link in a new browser tab at once when the Browser area is too narrow for the pane', async () => {
    const { posts, opened } = start({ installed: true, width: 400 });

    await flush();
    expect(clickLink().defaultPrevented).toBe(false);
    expect(posts.filter((post) => post.url.endsWith('/pane-open'))).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('leaves a web link to the browser on a page that is not the installed app', async () => {
    const plain = start({ installed: false });

    await flush();
    expect(clickLink().defaultPrevented).toBe(false);
    expect(plain.posts.filter((post) => post.url.endsWith('/pane-open'))).toEqual([]);
  });
});

describe('local file tabs', () => {
  let root: HTMLElement;
  let gets: string[];
  let answers: Record<string, { status: number; body: unknown }>;
  let pages: Array<{ close(): void }>;
  const files: Array<{ path: string; contents: string | null; line: number | null }> = [];
  const module: DiffModule = {
    mountDiff: () => null,
    mountChanges: () => {
      throw new Error('no Changes view in these tests');
    },
    mountFile: (host, data, _version, options) => {
      const shown = document.createElement('span');

      files.push({ path: data.path, contents: data.contents, line: options.line });
      shown.className = 'fake';
      shown.textContent = `file ${data.path} at ${String(options.line)}`;
      host.replaceChildren(shown, ...(options.suffix === undefined ? [] : [options.suffix]));
      return { set: () => {}, dispose: () => {} };
    },
  };

  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    gets = [];
    pages = [];
    files.length = 0;
    answers = {
      '.wip/review.md': { status: 200, body: file({ path: 'D:/w/.wip/review.md', name: 'review.md', kind: 'markdown', contents: '# Review\n\n[shot](shots/a.png)' }) },
      'D:/w/.wip/shots/': { status: 200, body: file({ path: 'D:/w/.wip/shots', name: 'shots', kind: 'dir', entries: [{ name: 'old', dir: true }, { name: 'a.png', dir: false }] }) },
      'D:/w/.wip/shots/a.png': { status: 200, body: file({ path: 'D:/w/.wip/shots/a.png', name: 'a.png', kind: 'image' }) },
      'src/a.ts': { status: 200, body: file({ path: 'D:/w/src/a.ts', name: 'a.ts', kind: 'text', contents: 'const a = 1;' }) },
      'doc.pdf': { status: 200, body: file({ path: 'D:/w/doc.pdf', name: 'doc.pdf', kind: 'pdf' }) },
      'big.log': { status: 200, body: file({ path: 'D:/w/big.log', name: 'big.log', tooLarge: true }) },
      '../secret.txt': { status: 404, body: { error: 'No such file in this conversation’s folders.' } },
    };
  });

  afterEach(() => {
    pages.forEach((page) => page.close());
    vi.restoreAllMocks();
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const text = 'See [Review](.wip/review.md) · [9 screenshots](D:/w/.wip/shots/), [code](src/a.ts#L42), [pdf](doc.pdf), [log](big.log), [out](../secret.txt) and [site](https://example.com/a).';
  const start = (local = true) => {
    const fetch = vi.fn(async (url: string) => {
      gets.push(url);

      const path = new URLSearchParams(url.slice(url.indexOf('?'))).get('path') ?? '';
      const answer = url.startsWith('/v1/conversation/local-file?') ? (answers[path] ?? { status: 404, body: { error: 'none' } }) : { status: 200, body: {} };

      return { status: answer.status, ok: answer.status === 200, json: async () => answer.body } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, loadDiff: async () => module, local });
    const source = FakeSource.last!;
    const scope = (scopeGen = 3) => ({ kind: 'page', key: 'pk', folder: 'D:/w', title: 'Fix it', scopeGen, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' });
    const session = { id: 's', title: 'Task', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null };
    const reply = { type: 'reply', id: 'r1', sessionId: 's', at: 1_000, ord: 1, provisional: false, kind: 'reply', answers: null, opening: text, rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null } };

    pages.push(page);
    // Wide, so the file tabs show in the column beside the conversation.
    window.innerWidth = 1600;
    window.dispatchEvent(new Event('resize'));
    source.emit('hello', { key: 'pk', groups: [], scope: scope(), sessions: [session], items: [reply], more: false, status: null, artifacts: [], unread: 0 });
    return { page, source, scope };
  };
  const link = (label: string) => [...root.querySelectorAll<HTMLElement>('a.path-link')].find((one) => one.textContent === label)!;
  const tabs = () => [...root.querySelectorAll<HTMLElement>('.local-tab')].map((tab) => [tab.querySelector('.tab-label')!.textContent, tab.classList.contains('selected')]);
  const localGets = () => gets.filter((url) => url.startsWith('/v1/conversation/local-file'));

  it('opens a Markdown file a reply links to in a closable tab, its pictures from the hub and its links in tabs of their own', async () => {
    start();
    link('Review').click();
    await flush();

    expect(localGets()).toEqual([localFileUrl('pk', '.wip/review.md')]);
    expect(tabs()).toEqual([['review.md', true]]);
    expect(root.querySelector('.local-view .artifact-title')!.textContent).toBe('D:/w/.wip/review.md');
    expect(root.querySelector('.local-view .artifact-doc h1')!.textContent).toBe('Review');

    // The same link shows the same tab, read once.
    link('Review').click();
    await flush();
    expect(localGets()).toHaveLength(1);

    root.querySelector<HTMLElement>('.local-view a.path-link')!.click();
    await flush();
    expect(localGets()[1]).toBe(localFileUrl('pk', 'D:/w/.wip/shots/a.png'));
    expect(tabs()).toEqual([['review.md', false], ['a.png', true]]);
    expect(root.querySelector('.local-view img.media')!.getAttribute('src')).toBe(localFileUrl('pk', 'D:/w/.wip/shots/a.png', true));

    // Closing the tab shown shows its neighbour, and closing the last leaves the file tabs.
    root.querySelector<HTMLElement>('.local-tab.selected [data-action="local-close"]')!.click();
    expect(tabs()).toEqual([['review.md', true]]);
    root.querySelector<HTMLElement>('.local-tab.selected [data-action="local-close"]')!.click();
    expect(tabs()).toEqual([]);
    expect(root.querySelector('.local-view')).toBeNull();
  });

  it('shows code at the line the link names in the file view, a folder as its entries, a PDF in a frame, and why a file does not show', async () => {
    start();
    link('code').click();
    await flush();
    await flush();
    expect(files).toEqual([{ path: 'D:/w/src/a.ts', contents: 'const a = 1;', line: 42 }]);
    expect(root.querySelector('.diff-host.file-view .diff-at')!.textContent).toBe(':42');
    expect(root.querySelector('.local-tab.selected .tab-open')!.getAttribute('title')).toBe('D:/w/src/a.ts:42');

    link('9 screenshots').click();
    await flush();
    expect([...root.querySelectorAll('.local-entry')].map((one) => one.textContent)).toEqual(['old', 'a.png']);
    expect(root.querySelector('.local-view .artifact-badge')!.textContent).toBe('folder');
    root.querySelector<HTMLElement>('.local-entry[title="a.png"]')!.click();
    await flush();
    expect(localGets().at(-1)).toBe(localFileUrl('pk', 'D:/w/.wip/shots/a.png'));

    link('pdf').click();
    await flush();
    expect(root.querySelector('.local-view iframe.artifact-pdf')!.getAttribute('src')).toBe(localFileUrl('pk', 'D:/w/doc.pdf', true));
    expect(root.querySelector('.local-view iframe')!.hasAttribute('sandbox')).toBe(false);

    link('log').click();
    await flush();
    expect(root.querySelector('.local-view .empty')!.textContent).toBe('This file is too large to show here.');

    link('out').click();
    await flush();
    expect(root.querySelector('.local-view .empty')!.textContent).toBe('No such file in this conversation’s folders.');
  });

  it('opens a focused link with Enter, leaves web links to the browser, and closes the tabs when the conversation changes', async () => {
    const { source, scope } = start();

    expect(root.querySelector('a[href="https://example.com/a"]')!.getAttribute('target')).toBe('_blank');
    link('Review').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(tabs()).toEqual([['review.md', true]]);

    source.emit('scope', { scope: scope(4) });
    await flush();
    expect(tabs()).toEqual([]);
  });

  it('shows the file tab in place of the conversation on a narrow page, and the conversation again once its last tab closes', async () => {
    start();
    window.innerWidth = 700;
    window.dispatchEvent(new Event('resize'));
    await flush();
    link('Review').click();
    await flush();
    expect(root.querySelector('#head .local-tab.selected')).not.toBeNull();
    expect(root.querySelector('.timeline')).toBeNull();
    root.querySelector<HTMLElement>('.local-tab.selected [data-action="local-close"]')!.click();
    expect(root.querySelector('.timeline')).not.toBeNull();
  });

  it('opens nothing on a page from another device, as local files stay on this computer', async () => {
    start(false);
    link('Review').click();
    await flush();
    expect(localGets()).toEqual([]);
    expect(tabs()).toEqual([]);
  });
});
