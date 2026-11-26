import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactTarget, joinPath, linkTarget, localFileUrl, localMarkdown } from '../src/localLinks.js';
import type { LocalFileData } from '../src/localLinks.js';
import { renderMarkdown } from '../src/markdown.js';
import type { DiffModule } from '../src/diff/types.js';
import { LINK_ANSWER_MS, startPage } from '../src/main.js';
import { drawAtOnce } from './frame.js';

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

describe("an artifact's picture and link targets", () => {
  const plan = { path: 'chat/plan.md' };
  const review = { path: '@7/review.md', file: 'D:/wt/.wip/review-pr/review.md' };

  it('keeps a target in the artifact folder on the artifact route and reads any other by its absolute path', () => {
    expect(artifactTarget(plan, 'D:\\w\\a', 'plan/a.png')).toEqual({ name: 'chat/plan/a.png' });
    expect(artifactTarget(plan, 'D:\\w\\a', './plan/x/../b c #1.png')).toEqual({ name: 'chat/plan/b c #1.png' });
    expect(artifactTarget(plan, 'D:\\w\\a', 'plan\\a.png')).toEqual({ name: 'chat/plan/a.png' });
    expect(artifactTarget(plan, 'D:\\w\\a', '../other/a.png')).toEqual({ name: 'other/a.png' });
    expect(artifactTarget(plan, 'D:\\w\\a', '../../shots/a.png')).toEqual({ path: 'D:/w/shots/a.png' });
    expect(artifactTarget(plan, 'D:/w/a', 'D:\\x\\a.png')).toEqual({ path: 'D:/x/a.png' });
    // A file: URI comes decoded, as the page decodes every target once: a name that holds %20 keeps it.
    expect(artifactTarget(plan, 'D:/w/a', 'file:///D:/x/a b%20c.png')).toEqual({ path: 'D:/x/a b%20c.png' });
    expect(artifactTarget(plan, 'D:/w/a', '/home/a.png')).toEqual({ path: '/home/a.png' });
    // A name the artifact route refuses is read as a local file: a dot segment, a stream, a trailing dot or a Windows device.
    expect(artifactTarget(plan, 'D:/w/a', 'plan/.hidden.png')).toEqual({ path: 'D:/w/a/chat/plan/.hidden.png' });
    expect(artifactTarget(plan, 'D:/w/a', 'plan/a.png:x')).toEqual({ path: 'D:/w/a/chat/plan/a.png:x' });
    expect(artifactTarget(plan, 'D:/w/a', 'plan/a.')).toEqual({ path: 'D:/w/a/chat/plan/a.' });
    expect(artifactTarget(plan, 'D:/w/a', 'plan/NUL.png')).toEqual({ path: 'D:/w/a/chat/plan/NUL.png' });
    // With no folder known, only the artifact route can be used; another scheme is never a file.
    expect(artifactTarget(plan, null, '../../a.png')).toBeNull();
    expect(artifactTarget(plan, 'D:/w/a', 'mailto:a@b.c')).toBeNull();
  });

  it("serves an external artifact's folder by the route, and reads a file outside it by path", () => {
    expect(artifactTarget(review, null, 'review/a.png')).toEqual({ name: '@7/review/a.png' });
    expect(artifactTarget(review, null, 'review.md')).toEqual({ name: '@7/review.md' });
    expect(artifactTarget(review, null, 'screenshots/a b.png')).toEqual({ name: '@7/screenshots/a b.png' });
    expect(artifactTarget(review, null, 'screenshots/NUL.png')).toEqual({ path: 'D:/wt/.wip/review-pr/screenshots/NUL.png' });
    expect(artifactTarget(review, null, '../../docs/a.png')).toEqual({ path: 'D:/wt/docs/a.png' });
    expect(artifactTarget(review, null, 'review/../../x.png')).toEqual({ path: 'D:/wt/.wip/x.png' });
    expect(artifactTarget({ path: '@7/review.md' }, null, '../a.png')).toBeNull();
    // A link goes to a file tab, but for one to the artifact itself.
    expect(artifactTarget(review, null, 'notes.md', true)).toEqual({ path: 'D:/wt/.wip/review-pr/notes.md' });
    expect(artifactTarget(review, null, 'review.md', true)).toEqual({ name: '@7/review.md' });
  });
});

describe('local file link targets', () => {
  it('reads the line a link names, by #L or after the name, and decodes what markdown-it encoded', () => {
    expect(linkTarget('src/a.ts#L42')).toEqual({ path: 'src/a.ts', line: 42 });
    expect(linkTarget('src/a.ts#L42-L50')).toEqual({ path: 'src/a.ts', line: 42 });
    expect(linkTarget('src/a.ts:7')).toEqual({ path: 'src/a.ts', line: 7 });
    expect(linkTarget('src/a.ts:7:3')).toEqual({ path: 'src/a.ts', line: 7 });
    expect(linkTarget('D:/git/my%20file.md')).toEqual({ path: 'D:/git/my file.md', line: null });
    expect(linkTarget('file:///D:/git/a%20b.ts#L3')).toEqual({ path: 'D:/git/a b.ts', line: 3 });
    expect(linkTarget('.wip/shots/')).toEqual({ path: '.wip/shots/', line: null });
    // A drive alone is no line; a link to a place in the same text names no file.
    expect(linkTarget('C:5')).toEqual({ path: 'C:5', line: null });
    expect(linkTarget('#usage')).toBeNull();
    expect(linkTarget('a%zz.md')).toEqual({ path: 'a%zz.md', line: null });
  });

  it('reads a file: URI as the path it names, with its line or range, a drive, a rooted path, localhost or a UNC share', () => {
    expect(linkTarget('file:///D:/git/switchboard/packages/hub/src/changes.ts#L280')).toEqual({ path: 'D:/git/switchboard/packages/hub/src/changes.ts', line: 280 });
    expect(linkTarget('file:///D:/git/a.ts#L10-L20')).toEqual({ path: 'D:/git/a.ts', line: 10 });
    expect(linkTarget('FILE:///d%3A/My%20Docs/%E2%9C%93.md')).toEqual({ path: 'd:/My Docs/✓.md', line: null });
    expect(linkTarget('file:/D:/a.ts')).toEqual({ path: 'D:/a.ts', line: null });
    expect(linkTarget('file://localhost/D:/a.ts#L2')).toEqual({ path: 'D:/a.ts', line: 2 });
    expect(linkTarget('file:///home/alex/notes.md')).toEqual({ path: '/home/alex/notes.md', line: null });
    expect(linkTarget('file://server/share/a.txt')).toEqual({ path: '//server/share/a.txt', line: null });
    // An encoded # is part of the name, not a fragment.
    expect(linkTarget('file:///D:/a%23b.ts#L4')).toEqual({ path: 'D:/a#b.ts', line: 4 });
    expect(linkTarget('file:///D:/a%zz.ts')).toEqual({ path: 'D:/a%zz.ts', line: null });
  });

  it('makes a file: URI in a reply a local file link, as markdown-it would otherwise drop it to text', () => {
    const host = document.createElement('div');

    host.innerHTML = renderMarkdown('[changes.ts:280](file:///D:/git/switchboard/packages/hub/src/changes.ts#L280) and [notes](file:///D:/My%20Docs/n.md)');

    expect([...host.querySelectorAll<HTMLElement>('a.path-link')].map((one) => [one.textContent, one.dataset['action'], one.dataset['target']])).toEqual([
      ['changes.ts:280', 'local-file', 'file:///D:/git/switchboard/packages/hub/src/changes.ts#L280'],
      ['notes', 'local-file', 'file:///D:/My%20Docs/n.md'],
    ]);
    expect(host.querySelector('a[href]')).toBeNull();
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
    expect([...host.querySelectorAll<HTMLElement>('a.path-link')].map((one) => one.dataset['target'])).toEqual(['D:/w/src/a.ts#L3', 'D:/w/b.md', 'D:/w/.wip/x&y.md']);
    // A link to a place in the file goes to its heading's anchor.
    expect(host.querySelector<HTMLElement>('a.anchor-link')!.dataset['target']).toBe('review');
    expect(host.querySelector('h1')!.getAttribute('data-anchor')).toBe('review');
  });
});

describe('web links with the browser pane', () => {
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

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const start = (options: { installed: boolean; paneOpen?: number; width?: number; local?: boolean; error?: string; toExtension?: (id: string, message: Record<string, unknown>) => Promise<unknown> }) => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const opened: string[] = [];
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const status = url.endsWith('/pane-open') ? (options.paneOpen ?? 200) : 200;

      return { status, ok: status === 200, json: async () => (status === 200 ? {} : { error: 'The Chrome pane is not connected.' }) } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, standalone: () => options.installed, local: options.local ?? true, openUrl: (url) => opened.push(url), toExtension: options.toExtension ?? (async () => ({ ok: true })) });
    const source = FakeSource.last!;
    const scope = { kind: 'page', key: 'pk', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };
    const session = { id: 's', title: 'Task', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null };
    const reply = { type: 'reply', id: 'r1', sessionId: 's', at: 1_000, ord: 1, provisional: false, kind: 'reply', answers: null, opening: 'See [the docs](https://example.com/docs).', rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null } };
    // A work item with no links of its own, so only the opened link gives the Browser tab something to show.
    const row = { workItemId: 1, ticketId: null, title: 'Fix it', priority: null, time: null, ticket: 'gh 1', sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], band: null, voice: null, history: null };

    pages.push(page);
    vi.spyOn(root.querySelector('#detail .detail-body')!, 'getBoundingClientRect').mockReturnValue({ left: 1000, top: 40, width: options.width ?? 600, height: 800 } as DOMRect);
    window.innerWidth = 1600;
    window.dispatchEvent(new Event('resize'));
    source.emit('hello', { key: 'pk', groups: [{ key: 'progress', title: 'In progress', glyph: '', empty: null, rows: [row] }], scope, sessions: [session], items: [reply], more: false, status: null, artifacts: [], unread: 0 });
    source.emit('pane', { pane: { enabled: true, extension: 'paired', extensionId: 'ext', marker: null, shown: false, error: options.error ?? null } });
    return { posts, opened };
  };
  const clickLink = (): MouseEvent => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });

    root.querySelector<HTMLElement>('.body a[href="https://example.com/docs"]')!.dispatchEvent(event);
    return event;
  };



  it('opens the link in a new browser tab at once when the Browser area is too narrow for the pane', async () => {
    const { posts, opened } = start({ installed: true, width: 400 });

    await flush();
    expect(clickLink().defaultPrevented).toBe(false);
    expect(posts.filter((post) => post.url.endsWith('/pane-open'))).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("leaves a web link to the device's browser on an installed page on another device, whose pane is the computer's", async () => {
    const remote = start({ installed: true, local: false });

    await flush();
    expect(clickLink().defaultPrevented).toBe(false);
    expect(remote.posts.filter((post) => post.url.endsWith('/pane-open'))).toEqual([]);
    expect(root.querySelector('[data-side="browser"]')).toBeNull();
  });

  /** An extension that keeps the page's links in its tab group, answering each open with `opened`, or the given answer. */
  const groupingExtension = (answer: unknown = { opened: true }) => {
    const sent: Array<[string, Record<string, unknown>]> = [];

    return { sent, toExtension: async (id: string, message: Record<string, unknown>) => (sent.push([id, message]), message['type'] === 'links' ? { links: true } : message['type'] === 'open' ? answer : { ok: true }) };
  };

  it("opens a web link in the extension's tab group on a page on another device, when the extension answers", async () => {
    const extension = groupingExtension();
    const remote = start({ installed: true, local: false, toExtension: extension.toExtension });

    await flush();
    expect(clickLink().defaultPrevented).toBe(true);
    await flush();
    expect(extension.sent).toEqual([
      ['hlbibnhgkgnjkbfledhgjblacloneije', { type: 'links' }],
      ['hlbibnhgkgnjkbfledhgjblacloneije', { type: 'open', url: 'https://example.com/docs', until: 10_000 + LINK_ANSWER_MS - 500 }],
    ]);
    expect(remote.opened).toEqual([]);
    expect(remote.posts.filter((post) => post.url.endsWith('/pane-open'))).toEqual([]);
  });

  it('opens the link in a new browser tab when the extension does not open it', async () => {
    const extension = groupingExtension({ error: 'No window with id: 5.' });
    const remote = start({ installed: false, local: false, toExtension: extension.toExtension });

    await flush();
    clickLink();
    await flush();
    expect(remote.opened).toEqual(['https://example.com/docs']);
  });


  it("opens a link in the extension's tab group on this computer while the pane has stopped", async () => {
    const extension = groupingExtension();
    const stopped = start({ installed: true, error: 'The pane would not fit the column.', toExtension: extension.toExtension });

    await flush();
    expect(clickLink().defaultPrevented).toBe(true);
    await flush();
    expect(extension.sent.at(-1)).toEqual(['hlbibnhgkgnjkbfledhgjblacloneije', { type: 'open', url: 'https://example.com/docs', until: 10_000 + LINK_ANSWER_MS - 500 }]);
    expect(stopped.opened).toEqual([]);
  });

  it('leaves a web link to the browser while the pane has stopped', async () => {
    const stopped = start({ installed: true, error: 'The pane would not fit the column.' });

    await flush();
    expect(clickLink().defaultPrevented).toBe(false);
    expect(stopped.posts.filter((post) => post.url.endsWith('/pane-open'))).toEqual([]);
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
  /** Each local-file read's If-None-Match, in order. */
  let validators: Array<string | null>;
  /** A read of this path waits until `release` is called. */
  let held: { path: string; release: () => void } | null;
  let pages: Array<{ close(): void }>;
  const files: Array<{ path: string; contents: string | null; line: number | null }> = [];
  const updates: string[] = [];
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
      return { set: () => {}, update: (contents) => updates.push(contents), dispose: () => {} };
    },
  };

  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    gets = [];
    validators = [];
    held = null;
    pages = [];
    files.length = 0;
    updates.length = 0;
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

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const text = 'See [Review](.wip/review.md) · [9 screenshots](D:/w/.wip/shots/), [code](src/a.ts#L42), [pdf](doc.pdf), [log](big.log), [out](../secret.txt), [uri](file:///D:/w/src/a%20b.ts#L7-L9), [far](file:///E:/other/x.ts#L5) and [site](https://example.com/a).';
  const start = (local = true, filePollMs = 1_000_000) => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      gets.push(url);

      const path = new URLSearchParams(url.slice(url.indexOf('?'))).get('path') ?? '';
      const answer = url.startsWith('/v1/conversation/local-file?') ? (answers[path] ?? { status: 404, body: { error: 'none' } }) : { status: 200, body: {} };
      if (url.startsWith('/v1/conversation/local-file?')) {
        validators.push((init?.headers as Record<string, string> | undefined)?.['If-None-Match'] ?? null);
      }

      if (held?.path === path) {
        await new Promise<void>((resolve) => (held!.release = resolve));
      }

      // The hub's ETag is a hash of the view; the view itself stands for it here.
      const etag = answer.status === 200 ? JSON.stringify(answer.body) : null;
      const status = etag !== null && (init?.headers as Record<string, string> | undefined)?.['If-None-Match'] === etag ? 304 : answer.status;

      return { status, ok: status === 200, headers: { get: (name: string) => (name === 'ETag' ? etag : null) }, json: async () => answer.body } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, loadDiff: async () => module, local, filePollMs });
    const source = FakeSource.last!;
    const scope = (scopeGen = 3) => ({ kind: 'page', key: 'pk', folder: 'D:/w', title: 'Fix it', scopeGen, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' });
    const session = { id: 's', title: 'Task', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null };
    const reply = { type: 'reply', id: 'r1', sessionId: 's', at: 1_000, ord: 1, provisional: false, kind: 'reply', answers: null, opening: text, rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null } };

    pages.push(page);
    // Wide, so the file tabs show in the column beside the conversation.
    window.innerWidth = 1600;
    window.dispatchEvent(new Event('resize'));
    source.emit('hello', { key: 'pk', groups: [], scope: scope(), sessions: [session], items: [reply], more: false, status: null, artifacts: [], unread: 0 });
    return { page, source, scope, session, reply };
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

    // The same link shows the same tab, read again with its ETag, which an unchanged file answers with 304.
    link('Review').click();
    await flush();
    expect(localGets()).toEqual([localFileUrl('pk', '.wip/review.md'), localFileUrl('pk', '.wip/review.md')]);
    expect(tabs()).toEqual([['review.md', true]]);
    expect(root.querySelector('.local-view .artifact-doc h1')!.textContent).toBe('Review');

    root.querySelector<HTMLElement>('.local-view a.path-link')!.click();
    await flush();
    expect(localGets()[2]).toBe(localFileUrl('pk', 'D:/w/.wip/shots/a.png'));
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

  it('opens a file: URI link in a file tab at its line, asking the hub for the decoded path', async () => {
    answers['D:/w/src/a b.ts'] = { status: 200, body: file({ path: 'D:/w/src/a b.ts', name: 'a b.ts', contents: 'const b = 2;' }) };
    start();
    link('uri').click();
    await flush();
    await flush();
    expect(localGets()).toEqual([localFileUrl('pk', 'D:/w/src/a b.ts')]);
    expect(files).toEqual([{ path: 'D:/w/src/a b.ts', contents: 'const b = 2;', line: 7 }]);
    expect(tabs()).toEqual([['a b.ts', true]]);
  });

  it('opens a focused link with Enter, leaves web links to the browser, and closes the tabs only when the work item changes', async () => {
    const { source, scope } = start();

    expect(root.querySelector('a[href="https://example.com/a"]')!.getAttribute('target')).toBe('_blank');
    link('Review').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(tabs()).toEqual([['review.md', true]]);

    // A reconnect's new scope generation, or a new session of the work item as Approve starts, keeps them; another work item closes them.
    source.emit('scope', { scope: scope(4) });
    await flush();
    expect(tabs()).toHaveLength(1);
    source.emit('scope', { scope: { ...scope(5), sessionId: 's2' } });
    await flush();
    expect(tabs()).toHaveLength(1);
    source.emit('scope', { scope: { ...scope(6), workItemId: 2, sessionId: 's3' } });
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

  it("opens a link on a paired device's page too, and shows why the hub refuses a folder or a file outside the working folder", async () => {
    const refusal = { status: 404, body: { error: 'On a paired device, only files in the session’s working folder and its work item’s worktree and repository open, not folders or files elsewhere.' } };

    answers['D:/w/.wip/shots/'] = refusal;
    answers['../secret.txt'] = refusal;
    start(false);
    link('Review').click();
    await flush();
    expect(localGets()).toEqual([localFileUrl('pk', '.wip/review.md')]);
    expect(root.querySelector('.local-view .artifact-doc h1')!.textContent).toBe('Review');
    expect(root.querySelector('.local-view a.path-link')).not.toBeNull();

    link('9 screenshots').click();
    await flush();
    expect(root.querySelector('.local-entries')).toBeNull();
    expect(root.querySelector('.local-view .empty')!.textContent).toBe(refusal.body.error);

    link('out').click();
    await flush();
    expect(root.querySelector('.local-view .empty')!.textContent).toBe(refusal.body.error);

    // A file: URI outside what the device may read is still a link, and its tab says why.
    answers['E:/other/x.ts'] = refusal;
    link('far').click();
    await flush();
    expect(root.querySelector('.local-view .empty')!.textContent).toBe(refusal.body.error);
    expect(tabs()).toEqual([['review.md', false], ['shots', false], ['secret.txt', false], ['x.ts', true]]);
  });

  describe('reading an open file again', () => {
    const setVisibility = (state: 'visible' | 'hidden') => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    /** The next periodic read, and its answer drawn. */
    const tick = async () => {
      vi.advanceTimersByTime(10);
      await flush();
      await flush();
    };
    const review = (contents: string) => ({ status: 200, body: file({ path: 'D:/w/.wip/review.md', name: 'review.md', kind: 'markdown', contents }) });
    const heading = () => root.querySelector('.local-view .artifact-doc h1')?.textContent;

    beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
    afterEach(() => {
      vi.useRealTimers();
      setVisibility('visible');
    });

    it('shows a Markdown file changed on disk while its tab is in view, asking with the ETag it holds', async () => {
      start(true, 10);
      link('Review').click();
      await flush();
      const first = JSON.stringify(answers['.wip/review.md']!.body);

      await tick();
      // Unchanged, the read sends the ETag it holds and is answered 304, so the view stays.
      expect(validators).toEqual([null, first]);
      expect(heading()).toBe('Review');

      answers['.wip/review.md'] = review('# Review, revised');
      await tick();
      expect(heading()).toBe('Review, revised');
      expect(validators).toEqual([null, first, first]);

      // The next read sends the new version's ETag.
      await tick();
      expect(validators.at(-1)).toBe(JSON.stringify(answers['.wip/review.md']!.body));
    });

    it('replaces the text of code in the view it is in, keeping its place, rather than drawing a new view', async () => {
      start(true, 10);
      link('code').click();
      await flush();
      await flush();
      expect(files).toHaveLength(1);

      answers['src/a.ts'] = { status: 200, body: file({ path: 'D:/w/src/a.ts', name: 'a.ts', kind: 'text', contents: 'const a = 2;' }) };
      await tick();
      expect(updates).toEqual(['const a = 2;']);
      expect(files).toHaveLength(1);
    });

    it('keeps what it shows while the hub does not answer or refuses, says when the file is gone, and shows it once it is back', async () => {
      start(true, 10);
      link('Review').click();
      await flush();
      answers['.wip/review.md'] = { status: 500, body: { error: 'restarting' } };
      await tick();
      expect(heading()).toBe('Review');

      answers['.wip/review.md'] = { status: 404, body: { error: 'No such file in this conversation’s folders.' } };
      await tick();
      expect(root.querySelector('.local-view .empty')!.textContent).toBe('No such file in this conversation’s folders.');

      answers['.wip/review.md'] = review('# Back');
      await tick();
      expect(heading()).toBe('Back');
    });

    it('drops an answer read for what the page showed before, as before a change of session', async () => {
      const { source, scope } = start(true, 10);

      link('Review').click();
      await flush();
      answers['.wip/review.md'] = review('# From the earlier session');
      held = { path: '.wip/review.md', release: () => {} };
      await tick();
      source.emit('scope', { scope: { ...scope(4), sessionId: 's2' } });
      await flush();
      held.release();
      await flush();
      await flush();
      expect(heading()).toBe('Review');
    });

    it('reads a file again when its first read answered for what the page showed before, rather than staying loading', async () => {
      const { source, scope } = start(true, 10);

      held = { path: '.wip/review.md', release: () => {} };
      link('Review').click();
      await flush();
      expect(root.querySelector('.local-view .empty')!.textContent).toBe('Reading the file…');
      source.emit('scope', { scope: { ...scope(4), sessionId: 's2' } });
      await flush();
      const release = held.release;

      held = null;
      release();
      await flush();
      await flush();
      expect(localGets()).toHaveLength(2);
      expect(validators).toEqual([null, null]);
      expect(heading()).toBe('Review');
    });

    it('keeps the answer of a slow read through the polls made while it is on its way', async () => {
      start(true, 10);
      link('Review').click();
      await flush();
      answers['.wip/review.md'] = review('# Slow');
      held = { path: '.wip/review.md', release: () => {} };
      await tick();
      const asked = localGets().length;

      // A poll leaves the read on its way to answer rather than asking for a newer one.
      await tick();
      await tick();
      expect(localGets()).toHaveLength(asked);

      const release = held.release;

      held = null;
      release();
      await flush();
      await flush();
      expect(heading()).toBe('Slow');
      expect(localGets()).toHaveLength(asked);
    });

    it('reads nothing while the page is hidden, and reads at once when it shows again', async () => {
      start(true, 10);
      link('Review').click();
      await flush();
      setVisibility('hidden');
      const before = localGets().length;

      answers['.wip/review.md'] = review('# Seen later');
      await tick();
      await tick();
      expect(localGets()).toHaveLength(before);
      expect(heading()).toBe('Review');

      // Shown again, it reads without waiting for the next periodic read.
      setVisibility('visible');
      await flush();
      expect(localGets()).toHaveLength(before + 1);
      expect(heading()).toBe('Seen later');
    });

    it('reads nothing while another tab shows in its place', async () => {
      start(true, 10);
      link('Review').click();
      await flush();
      root.querySelector<HTMLElement>('[data-side="history"]')!.click();
      await flush();
      const shownStatus = localGets().length;

      await tick();
      await tick();
      expect(localGets()).toHaveLength(shownStatus);
    });

    it("reads nothing while a phone shows the list over the conversation", async () => {
      const { source, scope, session, reply } = start(true, 10);
      const row = { workItemId: 1, ticketId: null, title: 'Fix it', priority: null, time: null, ticket: 'gh 1', sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], band: null, voice: null, history: null };
      const hello = () => source.emit('hello', { key: 'pk', groups: [{ key: 'progress', title: 'In progress', glyph: '', empty: null, rows: [row] }], scope: scope(), sessions: [session], items: [reply], more: false, status: null, artifacts: [], unread: 0 });

      window.innerWidth = 390;
      window.dispatchEvent(new Event('resize'));
      hello();
      root.querySelector<HTMLElement>('#list [data-action="select"][data-work-item="1"]')!.click();
      hello();
      await flush();
      expect(root.classList.contains('listing')).toBe(false);
      link('Review').click();
      await flush();
      await tick();
      const shown = localGets().length;

      // Read on opening and again while in view.
      expect(shown).toBe(2);
      root.querySelector<HTMLElement>('[data-action="back"]')!.click();
      await flush();
      expect(root.classList.contains('listing')).toBe(true);
      await tick();
      await tick();
      expect(localGets()).toHaveLength(shown);
    });

    it('loads a picture again when its time changes', async () => {
      answers['D:/w/.wip/shots/a.png'] = { status: 200, body: file({ path: 'D:/w/.wip/shots/a.png', name: 'a.png', kind: 'image', modified: 1 }) };
      start(true, 10);
      link('9 screenshots').click();
      await flush();
      root.querySelector<HTMLElement>('.local-entry[title="a.png"]')!.click();
      await flush();
      expect(root.querySelector('.local-view img.media')!.getAttribute('src')).toBe(`${localFileUrl('pk', 'D:/w/.wip/shots/a.png', true)}&v=1`);

      answers['D:/w/.wip/shots/a.png'] = { status: 200, body: file({ path: 'D:/w/.wip/shots/a.png', name: 'a.png', kind: 'image', modified: 2 }) };
      await tick();
      expect(root.querySelector('.local-view img.media')!.getAttribute('src')).toBe(`${localFileUrl('pk', 'D:/w/.wip/shots/a.png', true)}&v=2`);
    });
  });
});
