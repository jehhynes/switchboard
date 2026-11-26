import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareValid, emptyNote, fileAt, listBase, listNote, listRef, rowTitle, scopeKind, scopeLabel, tickScope } from '../src/changes.js';
import type { ChangesList } from '../src/changes.js';
import { diffLayout, diffNote } from '../src/changes.js';
import type { DiffModule } from '../src/diff/types.js';
import { startPage } from '../src/main.js';
import type { PageRow } from '@switchboard/protocol';
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
const FIRST = '1111111111111111111111111111111111111111';
const HEAD = 'fedcba9876543210fedcba9876543210fedcba98';
/** The commits since the base, newest first: HEAD, then the first, an hour and two hours ago. */
const COMMITS = [
  { sha: HEAD, parent: FIRST, subject: 'Second change', time: Math.floor(Date.now() / 1000) - 3600 },
  { sha: FIRST, parent: BASE, subject: 'First change', time: Math.floor(Date.now() / 1000) - 7200 },
];

const LIST: ChangesList = {
  scopeGen: 3,
  base: BASE,
  head: HEAD,
  from: 'base',
  to: 'worktree',
  commits: COMMITS,
  commitsMore: false,
  rows: [
    { path: 'docs/a.md', status: 'M', stages: ['committed', 'working'], additions: 3, deletions: 1, binary: false, hash: 'h-a', viewed: false },
    { path: 'src/new.ts', from: 'src/old.ts', status: 'R', stages: ['staged'], additions: 0, deletions: 0, binary: false, hash: 'h-new', viewed: true },
    { path: 'logo.png', status: 'U', stages: ['untracked'], additions: null, deletions: null, binary: true, hash: 'h-logo', viewed: false },
  ],
  stages: { committed: 1, staged: 1, working: 1, untracked: 1 },
  shown: 3,
  total: 3,
};

const listRow = (patch: Partial<PageRow> = {}): PageRow => ({ workItemId: 1, ticketId: null, title: 'Fix it', priority: null, time: null, ticket: 'gh 1', sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], band: null, voice: null, history: null, ...patch });
const session = { id: 's', title: 'Task', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null };
const scope = (scopeGen = 3, workItemId = 1) => ({ kind: 'page', key: 'pk', folder: 'D:/w', title: 'Fix it', scopeGen, conversations: [{ workItemId, title: 'Fix it', primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0 }], workItemId, cwd: 'D:/w', sessionId: 's' });

describe('the Changes list', () => {
  let root: HTMLElement;
  let answers: Array<{ status: number; body: unknown; wait?: Promise<void> }>;
  let gets: string[];
  /** The bodies of the viewed commands posted. */
  let ticks: Array<Record<string, unknown>>;
  /** Held while a test keeps the viewed commands' answers back. */
  let ticksGate: Promise<void> | undefined;
  let pages: Array<{ close(): void }>;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    answers = [];
    gets = [];
    ticks = [];
    ticksGate = undefined;
    pages = [];
  });

  afterEach(() => {
    pages.forEach((page) => page.close());
    vi.restoreAllMocks();
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const mounts: Array<{ path: string; layout: string; wrap: boolean; sets: string[]; disposed: boolean; onLine?: (side: 'old' | 'new', line: number) => void }> = [];
  const files: Array<{ path: string; side: string; line: number | null }> = [];
  const fileSets: string[] = [];
  let module: DiffModule | null;
  /** Held while a test keeps the diff viewer's module loading. */
  let moduleGate: Promise<void> | undefined;
  let diffAnswers: Record<string, { status: number; body: unknown }>;
  /** What each mountChanges was given and asked, and the rows the fake view says are on screen. */
  type FakeChanges = { header: (path: string) => void; meta: (path: string) => HTMLElement | null; rows: string[]; layout: string; wrap: boolean; layouts: string[]; scrolls: string[]; sets: Array<[string, string]>; collapsed: string[]; disposed: boolean; onLine?: (path: string, side: 'old' | 'new', line: number) => void; loadSides: (path: string) => Promise<unknown>; want: () => void };
  const changesMounts: FakeChanges[] = [];
  let visible: { first: number; last: number } | null;
  /** The row the fake view says has its header at the top. */
  let current: string | null;
  /** Each file's hunk starts as the fake view draws them. */
  let hunks: Record<string, number[]>;
  /** Each file's first line under the sticky header, as the fake view has it. */
  let topLines: Record<string, number>;
  let etags: Record<string, () => string>;
  let notModified: Set<string>;
  let ifNoneMatch: string[];

  beforeEach(() => {
    mounts.length = 0;
    changesMounts.length = 0;
    visible = { first: 0, last: 0 };
    current = null;
    hunks = {};
    topLines = {};
    etags = {};
    notModified = new Set();
    ifNoneMatch = [];
    files.length = 0;
    fileSets.length = 0;
    diffAnswers = {};
    moduleGate = undefined;
    module = {
      mountDiff: (host, data, _version, options) => {
        const mount = { path: data.path, layout: options.layout, wrap: options.wrap, sets: [] as string[], disposed: false, ...(options.onLine === undefined ? {} : { onLine: options.onLine }) };

        mounts.push(mount);
        host.textContent = `diff of ${data.path}`;
        return data.patch === 'unreadable' ? null : { set: (layout, wrap) => mount.sets.push(`${layout} ${wrap}`), dispose: () => (mount.disposed = true) };
      },
      mountFile: (host, data, _version, options) => {
        const shown = document.createElement('span');

        files.push({ path: data.path, side: data.side, line: options.line });
        shown.className = 'fake';
        shown.textContent = `file ${data.path} at ${String(options.line)}`;
        host.replaceChildren(...(options.prefix === undefined ? [] : [options.prefix]), shown, ...(options.suffix === undefined ? [] : [options.suffix]), ...(options.meta === undefined ? [] : [options.meta]));
        return { set: (layout, wrap) => fileSets.push(`${layout} ${wrap}`), update: () => {}, dispose: () => {} };
      },
      mountChanges: (host, rows, options) => {
        const listeners: Array<() => void> = [];
        const fake: FakeChanges = {
          meta: (path) => options.headerMeta?.(path) ?? null,
          header: (path) => options.onHeader?.(path),
          rows: rows.map((row) => row.path),
          layout: options.layout,
          wrap: options.wrap,
          layouts: [],
          scrolls: [],
          sets: [],
          collapsed: [],
          disposed: false,
          ...(options.onLine === undefined ? {} : { onLine: options.onLine }),
          loadSides: options.loadSides,
          want: () => listeners.forEach((listener) => listener()),
        };

        changesMounts.push(fake);
        // As the viewer puts each file's header element in its own header.
        host.replaceChildren(...rows.flatMap((row) => [options.headerPrefix?.(row.path), options.headerMeta?.(row.path)]).filter((one): one is HTMLElement => one != null));
        return {
          setRows: (next) => (fake.rows = next.map((row) => row.path)),
          setRow: (path, content) => fake.sets.push([path, content === null ? 'placeholder' : 'note' in content ? content.note : 'diff']),
          setCollapsed: (path, collapsed) => fake.collapsed.push(`${path} ${collapsed}`),
          scrollToFile: (path) => fake.scrolls.push(path),
          current: () => current,
          visible: () => visible,
          onWant: (listener) => listeners.push(listener),
          heightOf: () => 100,
          linesFor: () => 3,
          hunkStarts: (path) => (hunks[path] ?? []).map((line) => ({ line, side: 'additions' as const })),
          scrollToLine: (path, line) => fake.scrolls.push(`${path}:${line}`),
          topLine: (path) => topLines[path] ?? null,
          set: (layout, wrap) => fake.layouts.push(`${layout} ${wrap}`),
          dispose: () => (fake.disposed = true),
        };
      },
    };
  });

  /** The tree's reads (changesTree.tsx), kept apart from the list's: the stack, the worktree's files and the uncommitted changes. */
  let treeGets: string[] = [];
  let lastUrl = '';

  const start = () => {
    treeGets = [];
    const fetch = vi.fn(async (url: string, init?: unknown) => {
      // The tree reads its uncommitted list right after the worktree's files, in one go; it answers with no rows here.
      const forTree = url.startsWith('/v1/conversation/stack') || url.startsWith('/v1/conversation/tree') || (lastUrl.startsWith('/v1/conversation/tree') && url.endsWith('&from=HEAD&to=worktree'));

      lastUrl = url;

      if (forTree) {
        treeGets.push(url);
        return { status: 404, ok: false, headers: new Headers(), json: async () => ({ error: 'not found' }) } as unknown as Response;
      }

      if (url.startsWith('/v1/conversation/changes')) {
        gets.push(url);
      }

      if (url.startsWith('/v1/conversation/file')) {
        gets.push(url);

        const params = new URLSearchParams(url.slice(url.indexOf('?')));

        return { status: 200, ok: true, json: async () => ({ path: params.get('path'), side: params.get('side'), contents: 'x', binary: false, tooLarge: false }) } as unknown as Response;
      }

      if (url === '/v1/conversation/viewed') {
        const sent = JSON.parse(String((init as { body?: string } | undefined)?.body)) as Record<string, unknown>;

        ticks.push(sent);
        await ticksGate;
        gets.push(`VIEWED ${String(sent['path'])} ${String(sent['hash'])} ${String(sent['viewed'])} ${String(sent['scopeGen'])}`);
        return (sent['path'] === 'logo.png'
          ? { status: 409, ok: false, json: async () => ({ error: 'logo.png changed since it was shown; read it again.' }) }
          : { status: 200, ok: true, json: async () => ({ path: sent['path'], hash: sent['hash'], viewed: sent['viewed'] }) }) as unknown as Response;
      }

      if (url === '/v1/conversation/row-command') {
        gets.push(`POST ${String((init as { body?: string } | undefined)?.body)}`);
        return { status: 200, ok: true, json: async () => ({}) } as unknown as Response;
      }

      const diffPath = url.startsWith('/v1/conversation/diff') ? decodeURIComponent(/path=([^&]*)/.exec(url)![1]!) : null;
      const answer =
        diffPath !== null
          ? (diffAnswers[diffPath] ?? { status: 200, body: { path: diffPath, status: 'M', patch: 'diff --git a/x b/x', old: 'a', new: 'b', binary: false, tooLarge: null } })
          : url.startsWith('/v1/conversation/changes')
            ? (answers.shift() ?? { status: 200, body: structuredClone(LIST) })
            : { status: 200, body: {} };

      if (diffPath !== null) {
        gets.push(url);

        const sent = (init as { headers?: Record<string, string> } | undefined)?.headers?.['If-None-Match'];

        if (sent !== undefined) {
          ifNoneMatch.push(sent);
        }

        if (sent !== undefined && notModified.has(diffPath)) {
          return { status: 304, ok: false, headers: new Headers(), json: async () => ({}) } as unknown as Response;
        }
      }

      await (answer as { wait?: Promise<void> }).wait;

      const etag = diffPath === null ? undefined : etags[diffPath]?.();

      return { status: answer.status, ok: answer.status === 200, headers: new Headers(etag === undefined ? {} : { ETag: etag }), json: async () => answer.body } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, loadDiff: async () => (await moduleGate, module) });
    const source = FakeSource.last!;

    pages.push(page);

    source.emit('hello', { key: 'pk', groups: [], scope: scope(), sessions: [session], items: [], more: false, status: null, artifacts: [], unread: 0 });
    return { page, source };
  };
  const button = () => root.querySelector<HTMLElement>('.changes-tab')!;
  const filesButton = () => root.querySelector<HTMLElement>('.changes-files')!;
  const listGets = () => gets.filter((one) => one.startsWith('/v1/conversation/changes'));
  /** Opens the Changes tab and its Files menu. */
  const openList = async () => {
    button().click();
    await flush();
    filesButton().click();
    await flush();
  };

  it('ChangesTab_Chosen_ReadsTheListAndItsFilesMenuDrawsEachRowWithItsNameFolderCountsAndStatus', async () => {
    start();
    expect(root.querySelectorAll('.changes-tab')).toHaveLength(1);
    expect(button().querySelector('.tab-badge')).toBeNull();
    expect(gets).toEqual([]);

    button().click();
    filesButton().click();
    expect(root.querySelector('.changes-menu')!.textContent).toContain('Reading the changes');
    await flush();

    expect(listGets()).toEqual(['/v1/conversation/changes?window=pk']);
    // One Changes item in the strip, ever.
    expect(root.querySelectorAll('.changes-tab')).toHaveLength(1);
    expect(root.querySelector('.changes-button, .tab-close[data-action="diff-close"]')).toBeNull();

    const rows = [...root.querySelectorAll<HTMLElement>('.change-row')];

    expect(rows.map((row) => [row.querySelector('.change-name')!.textContent, row.querySelector('.change-dir')!.textContent, row.querySelector('.change-counts')!.textContent, row.querySelector('.change-status')!.textContent])).toEqual([
      ['a.md', 'docs', '+3−1', 'M'],
      ['new.ts', 'src', '+0', 'R'],
      ['logo.png', '', 'binary', 'U'],
    ]);
    expect(rows[1]!.title).toBe('src/old.ts → src/new.ts\nRenamed · staged');
    expect(root.querySelector('.changes-note')!.textContent).toBe('3 files · +3 −1');
    expect(root.querySelector<HTMLElement>('.changes-note')!.title).toBe('All changes since the base, 0123456');
    expect([...root.querySelectorAll<HTMLInputElement>('.change-viewed input')].map((box) => box.checked)).toEqual([false, true, false]);
    expect(button().querySelector('.tab-badge')!.textContent).toBe('1/3');
    expect(button().getAttribute('aria-label')).toBe('Changes, 1 of 3 files viewed');
  });

  it('reads it again on Refresh, and its Files menu closes on Escape or a press outside it', async () => {
    start();
    await openList();
    root.querySelector<HTMLElement>('[data-action="changes-refresh"]')!.click();
    await flush();
    expect(listGets()).toHaveLength(2);

    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.changes-menu')).toBeNull();
    expect(document.activeElement).toBe(filesButton());

    filesButton().click();
    await flush();
    expect(root.querySelector('.changes-menu')).not.toBeNull();
    root.querySelector<HTMLElement>('.change-row')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('.changes-menu')).not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('.changes-menu')).toBeNull();
  });

  /** What the bar says the diffs compare. */
  const scopeButton = () => root.querySelector<HTMLElement>('.changes-scope')!;
  /** Chooses a range from the tree: the uncommitted changes, every change (the bar's way back), or a commit by its subject. */
  const pick = async (text: string) => {
    if (text === 'All changes') {
      root.querySelector<HTMLElement>('[data-action="changes-back"]')!.click();
    } else if (text === 'Uncommitted changes') {
      root.querySelector<HTMLElement>('.changes-tree [data-action="tree-range"][data-from="HEAD"]')!.click();
    } else {
      [...root.querySelectorAll<HTMLElement>('.changes-tree .tree-item.commit')].find((one) => one.querySelector('.tree-label')!.textContent!.includes(text))!.querySelector<HTMLElement>('[data-action="tree-range"]')!.click();
    }

    await flush();
  };

  it('names the range the diffs compare in the bar, with a way back to every change since the base', async () => {
    answers.push({ status: 200, body: structuredClone(LIST) }, { status: 200, body: structuredClone({ ...LIST, from: FIRST, to: HEAD }) }, { status: 200, body: structuredClone(LIST) });
    start();
    await openList();
    expect(scopeButton().textContent).toBe('All changes');
    expect(scopeButton().title).toBe('Comparing: All changes since the base, 0123456');
    // The tree chooses the range; the bar has no menu of its own for it, and no way back while it shows every change.
    expect(root.querySelector('[data-action="changes-scope"], .changes-scope-menu, [data-action="changes-back"]')).toBeNull();

    await pick('Second change');
    expect(scopeButton().textContent).toBe('fedcba9 Second change');
    await pick('All changes');
    expect(listGets().at(-1)).toBe('/v1/conversation/changes?window=pk');
    expect(scopeButton().textContent).toBe('All changes');
  });

  it('ScopeMenu_UncommittedPicked_ReadsTheUncommittedListSaysSoAndIsNotKept', async () => {
    const only = structuredClone({ ...LIST, from: 'HEAD', rows: LIST.rows.slice(1), stages: { ...LIST.stages, committed: 0 }, shown: 2, total: 2 });

    answers.push({ status: 200, body: structuredClone(LIST) }, { status: 200, body: only }, { status: 200, body: { ...only, rows: [], shown: 0, total: 0 } });

    const { source } = start();

    await openList();
    expect(button().title).toBe("Every changed file's diff since the base");

    await pick('Uncommitted changes');
    expect(listGets().at(-1)).toBe('/v1/conversation/changes?window=pk&from=HEAD&to=worktree');
    expect(scopeButton().textContent).toBe('Uncommitted');
    expect(scopeButton().querySelector('.codicon-diff-modified')).not.toBeNull();
    filesButton().click();
    expect(root.querySelectorAll('.change-row')).toHaveLength(2);
    expect(root.querySelector<HTMLElement>('.changes-note')!.title).toBe('Uncommitted changes, against the last commit');
    expect(button().getAttribute('aria-label')).toBe('Changes, 1 of 2 uncommitted files viewed');
    expect(button().title).toBe("Every uncommitted file's diff");

    // A tick names the range it was shown in.
    root.querySelectorAll<HTMLElement>('.change-viewed input')[0]!.click();
    await flush();
    expect(ticks.at(-1)).toMatchObject({ path: 'src/new.ts', from: 'HEAD', to: 'worktree' });

    root.querySelector<HTMLElement>('[data-action="changes-refresh"]')!.click();
    await flush();
    expect(root.querySelector('.changes-empty')!.textContent).toBe('No uncommitted changes.');
    // Nothing of the scope is kept on the device.
    expect(Object.keys(localStorage).filter((name) => /changes|scope/i.test(name) || /HEAD|worktree/.test(localStorage.getItem(name) ?? ''))).toEqual([]);

    // Another conversation starts on every change since the base again.
    source.emit('scope', { scope: scope(4, 2) });
    source.emit('hello', { key: 'pk', groups: [], scope: scope(4, 2), sessions: [session], items: [], more: false, status: null, artifacts: [], unread: 0 });
    button().click();
    await flush();
    expect(listGets().at(-1)).toBe('/v1/conversation/changes?window=pk');
    expect(scopeButton().textContent).toBe('All changes');
  });

  it('ScopeMenu_CommitPicked_ReadsThatCommitAgainstItsParentAndNamesIt', async () => {
    const commit = structuredClone({ ...LIST, from: FIRST, to: HEAD, rows: LIST.rows.slice(0, 1), shown: 1, total: 1 });

    answers.push({ status: 200, body: structuredClone(LIST) }, { status: 200, body: commit }, { status: 200, body: { ...commit, rows: [], shown: 0, total: 0 } });
    start();
    await openList();
    await pick('Second change');

    expect(listGets().at(-1)).toBe(`/v1/conversation/changes?window=pk&from=${FIRST}&to=${HEAD}`);
    expect(scopeButton().textContent).toBe('fedcba9 Second change');
    expect(scopeButton().querySelector('.codicon-git-commit')).not.toBeNull();
    expect(root.querySelector<HTMLElement>('.changes-note')!.title).toBe('Commit fedcba9: Second change');
    expect(button().title).toBe("Every changed file's diff: Commit fedcba9: Second change");

    root.querySelector<HTMLElement>('[data-action="changes-refresh"]')!.click();
    await flush();
    filesButton().click();
    expect(root.querySelector('.changes-empty')!.textContent).toBe('This commit changes no files. Choose another range in the tree.');
  });

  it('ScopeMenu_CommitGoneAfterARebase_FallsBackToEveryChangeSinceTheBase', async () => {
    answers.push({ status: 200, body: structuredClone(LIST) }, { status: 409, body: { error: 'The chosen commit is no longer on this branch.', stale: true } });
    start();
    await openList();
    await pick('First change');
    await flush();

    expect(listGets().slice(-2)).toEqual([`/v1/conversation/changes?window=pk&from=${BASE}&to=${FIRST}`, '/v1/conversation/changes?window=pk']);
    expect(scopeButton().textContent).toBe('All changes');
    filesButton().click();
    expect(root.querySelectorAll('.change-row')).toHaveLength(3);
  });

  it('ChangesTab_DiffReadForACommitGone_FallsBackToEveryChangeSinceTheBase', async () => {
    answers.push({ status: 200, body: structuredClone(LIST) }, { status: 200, body: structuredClone({ ...LIST, from: FIRST, to: HEAD }) });
    start();
    await openRow(0);
    diffAnswers['docs/a.md'] = { status: 409, body: { error: 'The chosen commit is no longer on this branch.', stale: true } };
    await pick('Second change');
    await flush();
    await flush();

    expect(listGets().at(-1)).toBe('/v1/conversation/changes?window=pk');
    expect(scopeButton().textContent).toBe('All changes');
  });

  it("says why when the hub refuses, and says when the worktree matches its base", async () => {
    answers.push({ status: 409, body: { error: 'D:/w is not in a git repository.' } }, { status: 200, body: { ...LIST, rows: [], shown: 0, total: 0 } });
    start();
    await openList();
    expect(root.querySelector('.changes-empty.error')!.textContent).toBe('D:/w is not in a git repository.');
    expect(root.querySelector('.diff-host')!.textContent).toBe('D:/w is not in a git repository.');

    root.querySelector<HTMLElement>('[data-action="changes-refresh"]')!.click();
    await flush();
    expect(root.querySelector('.changes-empty')!.textContent).toBe('No changes since the merge base. They appear here when the session edits a file.');
  });

  it("drops the list when the page moves to another conversation, and an answer read for the one it left", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { source } = start();

    await openList();
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
    expect(listGets()).toHaveLength(2);
    expect(button().querySelector('.tab-badge')).toBeNull();
  });

  it("reads an opened Changes tab's list again when the session's turn ends", async () => {
    const { source } = start();

    button().click();
    await flush();
    source.emit('session', { session: { ...session, state: 'running' } });
    await flush();
    expect(listGets()).toHaveLength(1);
    source.emit('session', { session: { ...session, state: 'idle' } });
    await flush();
    expect(listGets()).toHaveLength(2);
  });

  const openRow = async (index: number) => {
    await openList();
    root.querySelectorAll<HTMLElement>('.change-row')[index]!.click();
    await flush();
    await flush();
    await flush();
  };
  const diffGets = () => gets.filter((one) => one.startsWith('/v1/conversation/diff'));

  it('ticks a file viewed at the hash it was shown with, follows another device, and takes back a refused tick', async () => {
    const { source } = start();

    await openList();
    root.querySelectorAll<HTMLElement>('.change-viewed input')[0]!.click();
    await flush();
    expect(gets.at(-1)).toBe('VIEWED docs/a.md h-a true 3');
    expect(root.querySelectorAll<HTMLInputElement>('.change-viewed input')[0]!.checked).toBe(true);

    // Another device clears it at that hash; one at another hash, or for another work item, changes nothing.
    source.emit('viewed', { workItemId: 1, path: 'docs/a.md', hash: 'other', viewed: false });
    source.emit('viewed', { workItemId: 2, path: 'docs/a.md', hash: 'h-a', viewed: false });
    expect(root.querySelectorAll<HTMLInputElement>('.change-viewed input')[0]!.checked).toBe(true);
    source.emit('viewed', { workItemId: 1, path: 'docs/a.md', hash: 'h-a', viewed: false });
    expect(root.querySelectorAll<HTMLInputElement>('.change-viewed input')[0]!.checked).toBe(false);

    // A file that changed since is not ticked: the list says so and reads again.
    const before = gets.length;

    root.querySelectorAll<HTMLElement>('.change-viewed input')[2]!.click();
    await flush();
    await flush();
    // logo.png is among the files read ahead, so its diff may be read too.
    expect(gets.slice(before).filter((one) => !one.startsWith('/v1/conversation/diff?'))).toEqual(['VIEWED logo.png h-logo true 3', '/v1/conversation/changes?window=pk']);
  });

  it('sends a file\'s ticks one at a time, ending on the last click', async () => {
    start();
    await openList();

    const box = () => root.querySelectorAll<HTMLElement>('.change-viewed input')[0]!;

    // Ticked and unticked before the first answer: the untick follows the tick, never beside it.
    box().click();
    box().click();
    for (let index = 0; index < 6; index++) {
      await flush();
    }

    expect(gets.filter((one) => one.startsWith('VIEWED'))).toEqual(['VIEWED docs/a.md h-a true 3', 'VIEWED docs/a.md h-a false 3']);
    expect((box() as HTMLInputElement).checked).toBe(false);

    // Ticked, unticked and ticked again: the page and the hub already agree once the first answers.
    box().click();
    box().click();
    box().click();
    for (let index = 0; index < 6; index++) {
      await flush();
    }

    expect(gets.filter((one) => one.startsWith('VIEWED'))).toHaveLength(3);
    expect((box() as HTMLInputElement).checked).toBe(true);
  });

  it('drops the Changes tab when the page moves to another conversation', async () => {
    const { source } = start();

    await openRow(0);
    source.emit('hello', { key: 'pk', groups: [], scope: scope(4, 2), sessions: [session], items: [], more: false, status: null, artifacts: [], unread: 0 });
    expect(root.querySelector('.changes-tab.selected')).toBeNull();
    expect(root.querySelector('.changes-tab .tab-badge')).toBeNull();
    expect(root.querySelector('.diff-view')).toBeNull();
    expect(changesMounts[0]!.disposed).toBe(true);
  });
});

describe('the Changes list text', () => {
  it('lays a diff out side by side from 900 px and stacked and wrapped under it, unless chosen', () => {
    expect(diffLayout('auto', 'auto', 1200)).toEqual({ layout: 'split', wrap: false });
    expect(diffLayout('auto', 'auto', 899)).toEqual({ layout: 'stacked', wrap: true });
    expect(diffLayout('auto', 'off', 375)).toEqual({ layout: 'stacked', wrap: false });
    expect(diffLayout('split', 'auto', 375)).toEqual({ layout: 'split', wrap: false });
    expect(diffLayout('stacked', 'auto', 375)).toEqual({ layout: 'stacked', wrap: false });
    expect(diffLayout('stacked', 'on', 1200)).toEqual({ layout: 'stacked', wrap: true });
  });

  it('says why a diff does not show', () => {
    const data = { path: 'a', status: 'M', patch: 'p', old: null, new: null, binary: false, tooLarge: null } as const;

    expect(diffNote(undefined)).toBe('Reading the diff…');
    expect(diffNote({ state: 'error', error: 'gone' })).toBe('gone');
    expect(diffNote({ state: 'ok', version: '1', data: { ...data, binary: true } })).toBe('Binary file not shown.');
    expect(diffNote({ state: 'ok', version: '1', data: { ...data, patch: null, tooLarge: 'patch' } })).toBe('This change is too large to show here. Open it in VS Code.');
    expect(diffNote({ state: 'ok', version: '1', data: { ...data, tooLarge: 'sides' } })).toBeNull();
  });

  it('says the file count, the lines changed and a cut list, leaving the viewed count to the tab, and the base in its tooltip', () => {
    expect(listNote(LIST)).toBe('3 files · +3 −1');
    expect(listNote({ ...LIST, shown: 400, total: 512 })).toBe('Showing 400 of 512 files · +3 −1');
    expect(listNote({ ...LIST, total: 1 })).toBe('1 file · +3 −1');
    expect(listNote({ ...LIST, from: 'HEAD' })).toBe('3 uncommitted files · +3 −1');
    expect(listNote({ ...LIST, from: 'HEAD', total: 1 })).toBe('1 uncommitted file · +3 −1');
    expect(listNote({ ...LIST, from: FIRST, to: HEAD })).toBe('3 files · +3 −1');
    expect(listBase(LIST)).toBe('All changes since the base, 0123456');
    expect(listBase({ ...LIST, base: null, commits: [] })).toBe('Uncommitted changes only, no merge base');
    expect(listBase({ ...LIST, from: 'HEAD' })).toBe('Uncommitted changes, against the last commit');
    expect(listBase({ ...LIST, from: BASE, to: FIRST })).toBe('Commit 1111111: First change');
    expect(listBase({ ...LIST, from: 'base', to: HEAD })).toBe('From Base to fedcba9');
    expect(emptyNote({ ...LIST, from: 'HEAD' })).toBe('No uncommitted changes.');
    expect(emptyNote({ ...LIST, from: BASE, to: HEAD })).toBe('No changes between these points. Choose another range in the tree.');
    expect(emptyNote({ ...LIST, base: null })).toBe('No uncommitted changes, and no merge base was found. Changes appear here when the session edits a file.');
    expect(emptyNote(LIST)).toBe('No changes since the merge base. They appear here when the session edits a file.');
    // A held diff against HEAD is read again after a commit.
    expect(listRef(LIST)).toBe(LIST.base);
    expect(listRef({ ...LIST, base: null })).toBe(`HEAD ${LIST.head}`);
    expect(listRef(null)).toBeNull();
    // From HEAD, a new commit changes the key; a range to a commit is keyed by both ends.
    expect(listRef({ ...LIST, from: 'HEAD' })).toBe(`HEAD ${HEAD}`);
    expect(listRef({ ...LIST, from: FIRST, to: HEAD })).toBe(`${FIRST}..${HEAD}`);
  });

  it('ScopeKind_EachRange_NamesItsChoiceLabelTickScopeAndFileSide', () => {
    expect(scopeKind({ from: 'base', to: 'worktree' }, COMMITS, BASE)).toBe('all');
    expect(scopeKind({ from: 'HEAD', to: 'worktree' }, COMMITS, BASE)).toBe('uncommitted');
    expect(scopeKind({ from: FIRST, to: 'worktree' }, COMMITS, BASE)).toBe('compare');
    expect(scopeKind({ from: FIRST, to: HEAD }, COMMITS, BASE)).toBe('commit');
    // The base by name is the first commit's parent too.
    expect(scopeKind({ from: 'base', to: FIRST }, COMMITS, BASE)).toBe('commit');
    expect(scopeKind({ from: BASE, to: HEAD }, COMMITS, BASE)).toBe('compare');
    expect(scopeLabel({ from: BASE, to: HEAD }, COMMITS, BASE)).toBe('Base → fedcba9');
    expect(scopeLabel({ from: FIRST, to: 'worktree' }, COMMITS, BASE)).toBe('1111111 → Working tree');
    expect(compareValid({ from: 'base', to: FIRST }, COMMITS, BASE)).toBe(true);
    expect(compareValid({ from: FIRST, to: FIRST }, COMMITS, BASE)).toBe(false);
    expect(compareValid({ from: HEAD, to: FIRST }, COMMITS, BASE)).toBe(false);
    expect(compareValid({ from: 'base', to: 'gone' }, COMMITS, BASE)).toBe(false);
    expect(tickScope(LIST)).toBe('');
    expect(tickScope({ ...LIST, from: 'base', to: HEAD })).toBe(`${BASE}..${HEAD}`);
    expect(tickScope({ ...LIST, from: FIRST, to: HEAD })).toBe(`${FIRST}..${HEAD}`);
    // To HEAD is kept at the commit HEAD names now.
    expect(tickScope({ ...LIST, from: 'base', to: 'HEAD' })).toBe(`${BASE}..${HEAD}`);
    expect(listRef({ ...LIST, from: 'base', to: 'HEAD' })).toBe(`${BASE}..${HEAD}`);
    expect(fileAt(LIST, 'base')).toBe(' at the base');
    expect(fileAt({ ...LIST, base: null }, 'base')).toBe(' at HEAD');
    expect(fileAt(LIST, 'disk')).toBeNull();
    expect(fileAt({ ...LIST, from: BASE, to: FIRST }, 'base')).toBe(' at the base');
    expect(fileAt({ ...LIST, from: BASE, to: FIRST }, 'disk')).toBe(' at 1111111');
  });

  it("names a row's stages in its tooltip", () => {
    expect(listNote({ ...LIST, rows: LIST.rows.map((row) => ({ ...row, viewed: false })) })).toBe('3 files · +3 −1');
    expect(rowTitle(LIST.rows[0]!)).toBe('docs/a.md\nModified · committed, unstaged');
    expect(rowTitle({ ...LIST.rows[0]!, stages: [] })).toBe('docs/a.md\nModified');
  });
});