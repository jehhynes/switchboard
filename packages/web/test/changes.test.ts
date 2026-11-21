import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listNote, rowTitle } from '../src/changes.js';
import type { ChangesList } from '../src/changes.js';
import { diffLayout, diffNote } from '../src/changes.js';
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

const LIST: ChangesList = {
  scopeGen: 3,
  base: '0123456789abcdef0123456789abcdef01234567',
  head: 'fedcba9876543210fedcba9876543210fedcba98',
  rows: [
    { path: 'docs/a.md', status: 'M', stages: ['committed', 'working'], additions: 3, deletions: 1, binary: false },
    { path: 'src/new.ts', from: 'src/old.ts', status: 'R', stages: ['staged'], additions: 0, deletions: 0, binary: false },
    { path: 'logo.png', status: 'U', stages: ['untracked'], additions: null, deletions: null, binary: true },
  ],
  stages: { committed: 1, staged: 1, working: 1, untracked: 1 },
  shown: 3,
  total: 3,
};

const session = { id: 's', title: 'Task', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null };
const scope = (scopeGen = 3, workItemId = 1) => ({ kind: 'page', key: 'pk', folder: 'D:/w', title: 'Fix it', scopeGen, conversations: [{ workItemId, title: 'Fix it', primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0 }], workItemId, cwd: 'D:/w', sessionId: 's' });

describe('the Changes list', () => {
  let root: HTMLElement;
  let answers: Array<{ status: number; body: unknown; wait?: Promise<void> }>;
  let gets: string[];
  let pages: Array<{ close(): void }>;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    answers = [];
    gets = [];
    pages = [];
  });

  afterEach(() => {
    pages.forEach((page) => page.close());
    vi.restoreAllMocks();
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const mounts: Array<{ path: string; layout: string; wrap: boolean; sets: string[]; disposed: boolean; onLine?: (side: 'old' | 'new', line: number) => void }> = [];
  const files: Array<{ path: string; side: string; line: number | null }> = [];
  const fileSets: string[] = [];
  let module: DiffModule | null;
  let diffAnswers: Record<string, { status: number; body: unknown }>;

  beforeEach(() => {
    mounts.length = 0;
    files.length = 0;
    fileSets.length = 0;
    diffAnswers = {};
    module = {
      mountDiff: (host, data, _version, options) => {
        const mount = { path: data.path, layout: options.layout, wrap: options.wrap, sets: [] as string[], disposed: false, ...(options.onLine === undefined ? {} : { onLine: options.onLine }) };

        mounts.push(mount);
        host.textContent = `diff of ${data.path}`;
        return data.patch === 'unreadable' ? null : { set: (layout, wrap) => mount.sets.push(`${layout} ${wrap}`), dispose: () => (mount.disposed = true) };
      },
      mountFile: (host, data, _version, options) => {
        files.push({ path: data.path, side: data.side, line: options.line });
        host.textContent = `file ${data.path} at ${String(options.line)}`;
        return { set: (layout, wrap) => fileSets.push(`${layout} ${wrap}`), dispose: () => {} };
      },
    };
  });

  const start = () => {
    const fetch = vi.fn(async (url: string, init?: unknown) => {
      if (url.startsWith('/v1/conversation/changes')) {
        gets.push(url);
      }

      if (url.startsWith('/v1/conversation/file')) {
        gets.push(url);

        const params = new URLSearchParams(url.slice(url.indexOf('?')));

        return { status: 200, ok: true, json: async () => ({ path: params.get('path'), side: params.get('side'), contents: 'x', binary: false, tooLarge: false }) } as unknown as Response;
      }

      if (url === '/v1/conversation/open-file') {
        gets.push(`POST ${String((init as { body?: string } | undefined)?.body)}`);
        return { status: 409, ok: false, json: async () => ({ error: 'The work item no longer offers this.' }) } as unknown as Response;
      }

      const diffPath = url.startsWith('/v1/conversation/diff') ? decodeURIComponent(/path=([^&]*)/.exec(url)![1]!) : null;
      const answer =
        diffPath !== null
          ? (diffAnswers[diffPath] ?? { status: 200, body: { path: diffPath, status: 'M', patch: 'diff --git a/x b/x', old: 'a', new: 'b', binary: false, tooLarge: null } })
          : url.startsWith('/v1/conversation/changes')
            ? (answers.shift() ?? { status: 200, body: LIST })
            : { status: 200, body: {} };

      if (diffPath !== null) {
        gets.push(url);
      }

      await (answer as { wait?: Promise<void> }).wait;

      return { status: answer.status, ok: answer.status === 200, json: async () => answer.body } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, loadDiff: async () => module });
    const source = FakeSource.last!;

    pages.push(page);

    source.emit('hello', { key: 'pk', groups: [], scope: scope(), sessions: [session], items: [], more: false, status: null, artifacts: [], unread: 0 });
    return { page, source };
  };
  const button = () => root.querySelector<HTMLElement>('.changes-button')!;

  it('reads the list when its menu opens and draws each row with its name, folder, counts and status', async () => {
    start();
    expect(root.querySelector('.changes-menu')).toBeNull();
    expect(gets).toEqual([]);

    button().click();
    expect(root.querySelector('.changes-menu')!.textContent).toContain('Reading the changes');
    await flush();

    expect(gets).toEqual(['/v1/conversation/changes?window=pk']);

    const rows = [...root.querySelectorAll<HTMLElement>('.change-row')];

    expect(rows.map((row) => [row.querySelector('.change-name')!.textContent, row.querySelector('.change-dir')!.textContent, row.querySelector('.change-counts')!.textContent, row.querySelector('.change-status')!.textContent])).toEqual([
      ['a.md', 'docs', '+3−1', 'M'],
      ['new.ts', 'src', '+0', 'R'],
      ['logo.png', '', 'binary', 'U'],
    ]);
    expect(rows[1]!.title).toBe('src/old.ts → src/new.ts\nRenamed · staged');
    expect(root.querySelector('.changes-note')!.textContent).toBe('Since 0123456 · 3 files');
    expect(button().querySelector('.tab-badge')!.textContent).toBe('3');
  });

  it('reads it again on Refresh and closes on Escape or a press outside it', async () => {
    start();
    button().click();
    await flush();
    root.querySelector<HTMLElement>('[data-action="changes-refresh"]')!.click();
    await flush();
    expect(gets).toHaveLength(2);

    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.changes-menu')).toBeNull();

    button().click();
    await flush();
    expect(root.querySelector('.changes-menu')).not.toBeNull();
    root.querySelector<HTMLElement>('.change-row')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('.changes-menu')).not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('.changes-menu')).toBeNull();
  });

  it("says why when the hub refuses, and says when the worktree matches its base", async () => {
    answers.push({ status: 409, body: { error: 'D:/w is not in a git repository.' } }, { status: 200, body: { ...LIST, rows: [], shown: 0, total: 0 } });
    start();
    button().click();
    await flush();
    expect(root.querySelector('.changes-empty.error')!.textContent).toBe('D:/w is not in a git repository.');

    root.querySelector<HTMLElement>('[data-action="changes-refresh"]')!.click();
    await flush();
    expect(root.querySelector('.changes-empty')!.textContent).toBe('No changes since the merge base.');
  });

  it("drops the list when the page moves to another conversation, and an answer read for the one it left", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { source } = start();

    button().click();
    await flush();
    expect(root.querySelectorAll('.change-row')).toHaveLength(3);

    source.emit('scope', { scope: scope(4, 2) });
    source.emit('hello', { key: 'pk', groups: [], scope: scope(4, 2), sessions: [session], items: [], more: false, status: null, artifacts: [], unread: 0 });
    expect(root.querySelector('.changes-menu')).toBeNull();
    expect(button().querySelector('.tab-badge')).toBeNull();

    // A read that answers after the page left its conversation is dropped.
    answers.push({ status: 200, body: LIST, wait: held });
    button().click();
    source.emit('hello', { key: 'pk', groups: [], scope: scope(5, 3), sessions: [session], items: [], more: false, status: null, artifacts: [], unread: 0 });
    release();
    await flush();
    await flush();
    expect(gets).toHaveLength(2);
    expect(button().querySelector('.tab-badge')).toBeNull();
  });

  it("reads an open menu's list again when the session's turn ends", async () => {
    const { source } = start();

    button().click();
    await flush();
    source.emit('session', { session: { ...session, state: 'running' } });
    await flush();
    expect(gets).toHaveLength(1);
    source.emit('session', { session: { ...session, state: 'idle' } });
    await flush();
    expect(gets).toHaveLength(2);
  });

  const openRow = async (index: number) => {
    button().click();
    await flush();
    root.querySelectorAll<HTMLElement>('.change-row')[index]!.click();
    await flush();
    await flush();
  };

  it('opens a file from the list in a closable tab of its own, read and drawn by the diff viewer loaded on first use', async () => {
    start();
    await openRow(0);

    expect(root.querySelector('.changes-menu')).toBeNull();
    expect(gets).toContain('/v1/conversation/diff?window=pk&path=docs%2Fa.md');
    expect([...root.querySelectorAll('.diff-tab .tab-label')].map((one) => one.textContent)).toEqual(['a.md']);
    expect(root.querySelector('.diff-tab')!.classList.contains('selected')).toBe(true);
    expect(root.querySelector('.diff-title')!.textContent).toBe('docs/a.md');
    expect(root.querySelector('.diff-host')!.textContent).toBe('diff of docs/a.md');
    expect(mounts).toMatchObject([{ path: 'docs/a.md', layout: 'split', wrap: false }]);

    // A second file opens its own tab; the first keeps its tab.
    await openRow(1);
    expect([...root.querySelectorAll('.diff-tab .tab-label')].map((one) => one.textContent)).toEqual(['a.md', 'new.ts']);
    expect(root.querySelector('.diff-title')!.textContent).toBe('src/old.ts → src/new.ts');

    // Closing the one shown shows its neighbour; closing the last goes back to the conversation.
    root.querySelector<HTMLElement>('.diff-tab.selected .tab-close')!.click();
    await flush();
    expect(root.querySelector('.diff-title')!.textContent).toBe('docs/a.md');
    root.querySelector<HTMLElement>('.diff-tab .tab-close')!.click();
    await flush();
    expect(root.querySelector('.diff-tab')).toBeNull();
    expect(root.querySelector('.diff-view')).toBeNull();
    expect(mounts.every((mount) => mount.disposed)).toBe(true);
  });

  it("shows the file at a clicked line number, the base's for the old side, and asks for it in VS Code", async () => {
    start();
    await openRow(1);
    mounts[0]!.onLine!('new', 12);
    await flush();
    await flush();
    expect(gets.at(-1)).toBe('/v1/conversation/file?window=pk&path=src%2Fnew.ts&side=disk');
    expect(files.at(-1)).toEqual({ path: 'src/new.ts', side: 'disk', line: 12 });
    expect(root.querySelector('.diff-title')!.textContent).toBe('src/new.ts:12');

    root.querySelector<HTMLElement>('[data-action="diff-open-vscode"]')!.click();
    await flush();
    expect(JSON.parse(gets.at(-1)!.slice('POST '.length))).toMatchObject({ window: 'pk', scopeGen: 3, path: 'src/new.ts', line: 12 });
    expect(root.querySelector('.diff-note')!.textContent).toBe('The work item no longer offers this.');

    root.querySelector<HTMLElement>('[data-action="diff-back"]')!.click();
    await flush();
    await flush();
    expect(root.querySelector('.diff-title')!.textContent).toBe('src/old.ts → src/new.ts');

    // The old side's line opens the file at the base, by its old name, with nothing to open in VS Code.
    mounts.at(-1)!.onLine!('old', 3);
    await flush();
    await flush();
    expect(files.at(-1)).toEqual({ path: 'src/old.ts', side: 'base', line: 3 });
    expect(root.querySelector('.diff-title')!.textContent).toBe('src/old.ts:3 at the base');
    expect(root.querySelector('[data-action="diff-open-vscode"]')).toBeNull();
  });

  it('changes the layout and wrapping on the open diff and keeps the choice', async () => {
    start();
    await openRow(0);
    root.querySelector<HTMLElement>('[data-action="diff-layout"][data-layout="stacked"]')!.click();
    expect(mounts[0]!.sets.at(-1)).toBe('stacked false');
    root.querySelector<HTMLElement>('[data-action="diff-wrap"]')!.click();
    expect(mounts[0]!.sets.at(-1)).toBe('stacked true');
    expect(localStorage.getItem('switchboard.diffLayout')).toBe('stacked');
    expect(localStorage.getItem('switchboard.diffWrap')).toBe('1');
  });

  it("says why a diff does not show: binary, refused, a patch the viewer cannot read, or no viewer", async () => {
    diffAnswers['docs/a.md'] = { status: 200, body: { path: 'docs/a.md', status: 'M', patch: null, old: null, new: null, binary: true, tooLarge: null } };
    diffAnswers['src/new.ts'] = { status: 404, body: { error: 'src/new.ts is not one of the changes now.' } };
    diffAnswers['logo.png'] = { status: 200, body: { path: 'logo.png', status: 'U', patch: 'unreadable', old: null, new: 'x', binary: false, tooLarge: null } };
    start();
    await openRow(0);
    expect(root.querySelector('.diff-host')!.textContent).toBe('Binary file not shown.');
    await openRow(1);
    expect(root.querySelector('.diff-host')!.textContent).toBe('src/new.ts is not one of the changes now.');
    await openRow(2);
    expect(root.querySelector('.diff-host')!.textContent).toBe("git's patch for this file could not be read.");
  });

  it('says so when the diff viewer cannot load', async () => {
    module = null;
    start();
    await openRow(0);
    expect(root.querySelector('.diff-host')!.textContent).toBe('The diff viewer could not be loaded. Reload the page to try again.');
  });

  it("keeps the newest of two reads of a file's diff when the older answers last", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));

    const { source } = start();

    await openRow(0);

    // The first refresh is held and answers an old version after the second refresh has answered.
    diffAnswers['docs/a.md'] = { status: 200, body: { path: 'docs/a.md', status: 'M', patch: 'old', old: 'a', new: 'b', binary: false, tooLarge: 'patch' }, wait: held } as never;
    root.querySelector<HTMLElement>('[data-action="diff-refresh"]')!.click();
    await flush();
    diffAnswers['docs/a.md'] = { status: 200, body: { path: 'docs/a.md', status: 'M', patch: 'diff --git a/x b/x', old: 'a', new: 'c', binary: false, tooLarge: null } };
    // The turn's end reads it again while the refresh is on its way (Refresh itself waits while one is).
    source.emit('session', { session: { ...session, state: 'running' } });
    source.emit('session', { session: { ...session, state: 'idle' } });
    await flush();
    await flush();
    release();
    await flush();
    await flush();
    expect(root.querySelector('.diff-host')!.textContent).toBe('diff of docs/a.md');
  });

  it('gives the open diff the layout its pane calls for when the pane is resized', async () => {
    const observers: Array<(entries: Array<{ target: Element }>) => void> = [];

    vi.stubGlobal('ResizeObserver', class {
      constructor(readonly callback: (entries: Array<{ target: Element }>) => void) {
        observers.push(callback);
      }

      observe(): void {}
      disconnect(): void {}
    });
    start();
    await openRow(0);

    const pane = root.querySelector<HTMLElement>('.diff-pane')!;

    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 500 });
    observers.forEach((callback) => callback([{ target: pane }]));
    expect(mounts[0]!.sets.at(-1)).toBe('stacked true');
    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 1200 });
    observers.forEach((callback) => callback([{ target: pane }]));
    expect(mounts[0]!.sets.at(-1)).toBe('split false');

    // A file view wraps as its pane narrows, and stays stacked.
    mounts[0]!.onLine!('new', 2);
    await flush();
    await flush();
    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 500 });
    observers.forEach((callback) => callback([{ target: pane }]));
    expect(fileSets.at(-1)).toBe('stacked true');
    vi.unstubAllGlobals();
  });

  it('drops the diff tabs when the page moves to another conversation', async () => {
    const { source } = start();

    await openRow(0);
    source.emit('hello', { key: 'pk', groups: [], scope: scope(4, 2), sessions: [session], items: [], more: false, status: null, artifacts: [], unread: 0 });
    expect(root.querySelector('.diff-tab')).toBeNull();
    expect(root.querySelector('.diff-view')).toBeNull();
  });
});

describe('the Changes list text', () => {
  it('lays a diff out side by side from 900 px and stacked and wrapped under it, unless chosen', () => {
    expect(diffLayout('auto', null, 1200)).toEqual({ layout: 'split', wrap: false });
    expect(diffLayout('auto', null, 899)).toEqual({ layout: 'stacked', wrap: true });
    expect(diffLayout('auto', false, 375)).toEqual({ layout: 'stacked', wrap: false });
    expect(diffLayout('split', null, 375)).toEqual({ layout: 'split', wrap: false });
    expect(diffLayout('stacked', true, 1200)).toEqual({ layout: 'stacked', wrap: true });
  });

  it('says why a diff does not show', () => {
    const data = { path: 'a', status: 'M', patch: 'p', old: null, new: null, binary: false, tooLarge: null } as const;

    expect(diffNote(undefined)).toBe('Reading the diff…');
    expect(diffNote({ state: 'error', error: 'gone' })).toBe('gone');
    expect(diffNote({ state: 'ok', version: '1', data: { ...data, binary: true } })).toBe('Binary file not shown.');
    expect(diffNote({ state: 'ok', version: '1', data: { ...data, patch: null, tooLarge: 'patch' } })).toBe('This change is too large to show here. Open it in VS Code.');
    expect(diffNote({ state: 'ok', version: '1', data: { ...data, tooLarge: 'sides' } })).toBeNull();
  });

  it('says the base, the file count and a cut list', () => {
    expect(listNote({ ...LIST, base: null })).toBe('Uncommitted changes only, no merge base · 3 files');
    expect(listNote({ ...LIST, shown: 400, total: 512 })).toBe('Since 0123456 · first 400 of 512 files');
    expect(listNote({ ...LIST, total: 1 })).toBe('Since 0123456 · 1 file');
  });

  it("names a row's stages in its tooltip", () => {
    expect(rowTitle(LIST.rows[0]!)).toBe('docs/a.md\nModified · committed, unstaged');
    expect(rowTitle({ ...LIST.rows[0]!, stages: [] })).toBe('docs/a.md\nModified');
  });
});
