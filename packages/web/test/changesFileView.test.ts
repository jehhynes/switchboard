import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileKind, worktreeTarget } from '../src/changes.js';
import type { ChangesList } from '../src/changes.js';
import type { DiffModule } from '../src/diff/types.js';
import { startPage } from '../src/main.js';
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

const BASE = '0123456789abcdef0123456789abcdef01234567';
const HEAD = 'fedcba9876543210fedcba9876543210fedcba98';
const LIST: ChangesList = {
  scopeGen: 3,
  base: BASE,
  head: HEAD,
  from: 'base',
  to: 'worktree',
  commits: [{ sha: HEAD, parent: BASE, subject: 'Change', time: 1 }],
  commitsMore: false,
  rows: [
    { path: 'docs/a.md', status: 'M', stages: ['working'], additions: 1, deletions: 0, binary: false, hash: 'h-a', viewed: false },
    { path: 'src/new.ts', from: 'src/old.ts', status: 'R', stages: ['staged'], additions: 0, deletions: 0, binary: false, hash: 'h-n', viewed: false },
  ],
  stages: { committed: 0, staged: 1, working: 1, untracked: 0 },
  shown: 2,
  total: 2,
};
const session = { id: 's', title: 'Task', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null };
const scope = (scopeGen = 3) => ({ kind: 'page', key: 'pk', folder: 'D:/w', title: 'Fix it', scopeGen, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' });

describe('worktreeTarget and fileKind', () => {
  it("resolves a link against the file's folder, and refuses one outside the worktree, an absolute path and a file: URI", () => {
    expect(worktreeTarget('docs/a.md', 'b.md')).toEqual({ path: 'docs/b.md', line: null });
    expect(worktreeTarget('docs/a.md', '../src/x.ts#L4')).toEqual({ path: 'src/x.ts', line: 4 });
    expect(worktreeTarget('docs/a.md', '../../out.md')).toBeNull();
    expect(worktreeTarget('a.md', '/etc/passwd')).toBeNull();
    expect(worktreeTarget('a.md', 'C:/x.ts')).toBeNull();
    expect(worktreeTarget('a.md', 'file:///D:/w/a.md')).toBeNull();
  });

  it('tells code, Markdown, a picture and a PDF apart', () => {
    const file = (path: string, patch = {}) => ({ path, side: 'disk' as const, contents: 'x', binary: false, tooLarge: false, ...patch });

    expect(fileKind(file('a.ts'))).toBe('code');
    expect(fileKind(file('a.md'))).toBe('markdown');
    expect(fileKind(file('a.png', { media: 'image/png', contents: null, binary: true }))).toBe('image');
    expect(fileKind(file('a.svg', { media: 'image/svg+xml', contents: '<svg/>' }))).toBe('code');
    expect(fileKind(file('a.pdf', { media: 'application/pdf', contents: null, binary: true }))).toBe('pdf');
  });
});

describe('the Changes file view', () => {
  let root: HTMLElement;
  let gets: string[];
  let validators: Array<string | null>;
  let fileAnswers: Record<string, { status: number; body: unknown; etag?: string }>;
  let held: { path: string; release: () => void } | null;
  let pages: Array<{ close(): void }>;
  const codes: Array<{ path: string; side: string; line: number | null }> = [];
  const updates: string[] = [];
  const headers: Array<boolean | undefined> = [];
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  let lineClick: ((path: string, side: 'old' | 'new', line: number) => void) | undefined;

  const module: DiffModule = {
    mountDiff: () => null,
    mountFile: (host, data, _version, options) => {
      codes.push({ path: data.path, side: data.side, line: options.line });
      headers.push(options.header);
      host.replaceChildren(...[options.prefix, options.suffix, options.meta].filter((one): one is HTMLElement => one !== undefined));
      return { set: () => {}, update: (contents) => updates.push(contents), dispose: () => {} };
    },
    mountChanges: (host, _rows, options) => {
      lineClick = options.onLine;
      host.textContent = 'diffs';
      return { setRows: () => {}, setRow: () => {}, setCollapsed: () => {}, scrollToFile: () => {}, current: () => null, visible: () => null, onWant: () => {}, heightOf: () => 0, linesFor: () => 1, hunkStarts: () => [], scrollToLine: () => {}, topLine: () => null, set: () => {}, dispose: () => {} };
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
    codes.length = 0;
    updates.length = 0;
    fileAnswers = {
      'docs/a.md': { status: 200, body: { path: 'docs/a.md', side: 'disk', contents: '# A\n\n[b](b.md) [far](../../x.md) [abs](/etc/passwd) [uri](file:///D:/w/a.md)\n\n![pic](shot.png)', binary: false, tooLarge: false, bytes: 40, media: null }, etag: 'e1' },
      'docs/b.md': { status: 200, body: { path: 'docs/b.md', side: 'disk', contents: '# B', binary: false, tooLarge: false, bytes: 3, media: null }, etag: 'eb' },
      'src/new.ts': { status: 200, body: { path: 'src/new.ts', side: 'disk', contents: 'const a = 1;', binary: false, tooLarge: false, bytes: 12, media: null }, etag: 'n1' },
      'src/old.ts': { status: 200, body: { path: 'src/old.ts', side: 'base', contents: 'const a = 0;', binary: false, tooLarge: false, bytes: 12, media: null }, etag: 'o1' },
      'logo.png': { status: 200, body: { path: 'logo.png', side: 'disk', contents: null, binary: true, tooLarge: false, bytes: 90, media: 'image/png' }, etag: 'p1' },
    };
  });

  afterEach(() => {
    pages.forEach((page) => page.close());
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const start = (filePollMs = 1_000_000) => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      gets.push(url);

      if (url.startsWith('/v1/conversation/changes')) {
        return { status: 200, ok: true, headers: new Headers(), json: async () => structuredClone(LIST) } as unknown as Response;
      }

      if (url.startsWith('/v1/conversation/file?')) {
        const path = new URLSearchParams(url.slice(url.indexOf('?'))).get('path') ?? '';
        const sent = (init?.headers as Record<string, string> | undefined)?.['If-None-Match'] ?? null;
        const answer = fileAnswers[path] ?? { status: 404, body: { error: `${path} is not a file of this worktree.` } };

        validators.push(sent);

        if (held?.path === path) {
          await new Promise<void>((resolve) => (held!.release = resolve));
        }

        const status = sent !== null && sent === answer.etag ? 304 : answer.status;

        return { status, ok: status === 200, headers: new Headers(answer.etag === undefined ? {} : { ETag: answer.etag }), json: async () => answer.body } as unknown as Response;
      }

      return { status: 200, ok: true, headers: new Headers(), json: async () => ({}) } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, loadDiff: async () => module, filePollMs });
    const source = FakeSource.last!;

    pages.push(page);
    window.innerWidth = 1600;
    window.dispatchEvent(new Event('resize'));
    source.emit('hello', { key: 'pk', groups: [], scope: scope(), sessions: [session], items: [], more: false, status: null, artifacts: [], unread: 0 });
    return { source };
  };
  const openTab = async () => {
    root.querySelector<HTMLElement>('.changes-tab')!.click();
    await flush();
    await flush();
  };
  const fileGets = () => gets.filter((url) => url.startsWith('/v1/conversation/file?'));
  const overlay = () => root.querySelector<HTMLElement>('.file-overlay');
  const bar = () => root.querySelector<HTMLElement>('.changes-bar');
  const openLine = async (path: string, side: 'old' | 'new', line: number) => {
    lineClick!(path, side, line);
    await flush();
    await flush();
  };

  it("shows a Markdown file's source at a diff's line, and its preview with Source, its links resolved in the worktree", async () => {
    start();
    await openTab();
    await openLine('docs/a.md', 'new', 1);
    expect(codes.at(-1)).toEqual({ path: 'docs/a.md', side: 'disk', line: 1 });
    // The bar names the file and holds Source just before Wrap; the code view draws no header of its own.
    expect(headers.at(-1)).toBe(false);
    expect(bar()!.querySelector('.changes-file-title bdi')!.textContent).toBe('docs/a.md');
    expect([...bar()!.querySelectorAll<HTMLElement>('[data-action]')].map((one) => one.dataset['action']).slice(-2)).toEqual(['file-source', 'changes-wrap']);
    expect(bar()!.querySelector('[data-action="file-source"]')!.getAttribute('aria-pressed')).toBe('true');

    bar()!.querySelector<HTMLElement>('[data-action="file-source"]')!.click();
    await flush();
    expect(overlay()!.querySelector('.artifact-doc h1')!.textContent).toBe('A');
    expect(overlay()!.querySelector('[data-action="file-source"]')).toBeNull();
    expect(bar()!.querySelector('[data-action="file-source"]')!.getAttribute('aria-pressed')).toBe('false');

    const links = [...overlay()!.querySelectorAll<HTMLElement>('.artifact-doc a')];

    expect(links.map((one) => [one.textContent, one.dataset['action'] ?? null, one.classList.contains('denied')])).toEqual([
      ['b', 'changes-file', false],
      ['far', null, true],
      ['abs', null, true],
      ['uri', null, true],
    ]);
    // A picture is read at the file's revision through the Changes routes, never a local file route.
    expect(overlay()!.querySelector('.picture img, img')!.getAttribute('src')).toBe('/v1/conversation/file-raw?window=pk&path=docs%2Fshot.png&side=disk');

    // A refused link opens nothing, and no local file route is ever asked.
    links[1]!.click();
    links[3]!.click();
    await flush();
    expect(gets.some((url) => url.includes('local-file'))).toBe(false);

    // A link in the worktree opens that file on disk, as the uncommitted range reads it, in its preview.
    links[0]!.click();
    await flush();
    await flush();
    expect(fileGets().at(-1)).toBe('/v1/conversation/file?window=pk&path=docs%2Fb.md&side=disk&from=HEAD&to=worktree');
    expect(overlay()!.querySelector('.artifact-doc h1')!.textContent).toBe('B');
    expect(gets.some((url) => url.includes('local-file'))).toBe(false);
  });

  it('shows a picture from file-raw at its version', async () => {
    start();
    await openTab();
    LIST.rows.push({ path: 'logo.png', status: 'U', stages: ['untracked'], additions: null, deletions: null, binary: true, hash: 'h-l', viewed: false });

    try {
      await openLine('logo.png', 'new', 1);
    } finally {
      LIST.rows.pop();
    }

    expect(overlay()!.querySelector('img.media')!.getAttribute('src')).toBe('/v1/conversation/file-raw?window=pk&path=logo.png&side=disk&v=p1');
  });

  it("offers Diff for a file that is a side of a shown row, and names a renamed file's old side by its old path", async () => {
    start();
    await openTab();
    await openLine('src/new.ts', 'old', 3);
    expect(codes.at(-1)).toEqual({ path: 'src/old.ts', side: 'base', line: 3 });
    expect(overlay()!.querySelector('[data-action="file-diff"]')).toBeNull();
    expect(bar()!.querySelector('.changes-file-title bdi')!.textContent).toBe('src/old.ts');

    bar()!.querySelector<HTMLElement>('[data-action="file-diff"]')!.click();
    await flush();
    expect(overlay()).toBeNull();
  });

  it('says why a file does not show, with the way back', async () => {
    fileAnswers['src/new.ts'] = { status: 403, body: { error: 'This page now shows another work item or session, so that was not done.' } };
    start();
    await openTab();
    await openLine('src/new.ts', 'new', 1);
    expect(overlay()!.querySelector('.empty')!.textContent).toBe('This page now shows another work item or session, so that was not done.');
    expect(root.querySelector('.changes-bar [data-action="changes-back"]')).not.toBeNull();
    // The diffs' controls leave the bar while a file shows; Diff and Wrap stay, as they still apply to the file.
    expect([...root.querySelectorAll<HTMLElement>('.changes-bar [data-action]')].map((one) => one.dataset['action'])).toEqual(['changes-back', 'file-diff', 'changes-wrap']);

    root.querySelector<HTMLElement>('.changes-bar [data-action="changes-back"]')!.click();
    await flush();
    expect(overlay()).toBeNull();
    expect(root.querySelector('.changes-bar [data-action="changes-menu"]')).not.toBeNull();
    expect(root.querySelector('.changes-bar [data-action="changes-more"]')).not.toBeNull();
  });

  describe('reading the file again', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));

    const tick = async () => {
      vi.advanceTimersByTime(10);
      await flush();
      await flush();
    };

    it('reads a file on disk again on the page timer with its ETag, replacing its text in place', async () => {
      start(10);
      await openTab();
      await openLine('src/new.ts', 'new', 1);
      expect(validators).toEqual([null]);

      await tick();
      expect(validators).toEqual([null, 'n1']);
      expect(updates).toEqual([]);

      fileAnswers['src/new.ts'] = { ...fileAnswers['src/new.ts']!, body: { ...(fileAnswers['src/new.ts']!.body as object), contents: 'const a = 2;' }, etag: 'n2' };
      await tick();
      expect(updates).toEqual(['const a = 2;']);
      expect(codes).toHaveLength(1);
    });

    it('never reads a file at the base again', async () => {
      start(10);
      await openTab();
      await openLine('src/new.ts', 'old', 1);
      await tick();
      await tick();
      expect(fileGets()).toHaveLength(1);
    });

    it("keeps a slow read's answer through the polls, and a turn's end drops it for a newer read", async () => {
      const { source } = start(10);

      await openTab();
      await openLine('src/new.ts', 'new', 1);
      fileAnswers['src/new.ts'] = { ...fileAnswers['src/new.ts']!, body: { ...(fileAnswers['src/new.ts']!.body as object), contents: 'slow' }, etag: 'n2' };
      held = { path: 'src/new.ts', release: () => {} };
      await tick();

      const asked = fileGets().length;

      await tick();
      await tick();
      expect(fileGets()).toHaveLength(asked);

      // A turn's end asks for a newer read: the slow answer is dropped for it.
      source.emit('scope', { scope: scope() });
      source.emit('session', { session: { ...session, state: 'running' } });
      source.emit('session', { session: { ...session, state: 'idle' } });
      fileAnswers['src/new.ts'] = { ...fileAnswers['src/new.ts']!, body: { ...(fileAnswers['src/new.ts']!.body as object), contents: 'newer' }, etag: 'n3' };

      const release = held.release;

      held = null;
      release();
      await flush();
      await flush();
      await flush();
      expect(updates.at(-1)).toBe('newer');
      expect(updates).not.toContain('slow');
    });

    it('reads nothing while the page is hidden', async () => {
      start(10);
      await openTab();
      await openLine('src/new.ts', 'new', 1);
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });

      try {
        await tick();
        await tick();
        expect(fileGets()).toHaveLength(1);
      } finally {
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      }
    });
  });
});
