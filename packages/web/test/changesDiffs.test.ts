import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangesList } from '../src/changes.js';
import { diffLayout } from '../src/changes.js';
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
  { sha: HEAD, parent: FIRST, subject: 'Second change', authored: Math.floor(Date.now() / 1000) - 3600, committed: Math.floor(Date.now() / 1000) - 3600 },
  { sha: FIRST, parent: BASE, subject: 'First change', authored: Math.floor(Date.now() / 1000) - 7200, committed: Math.floor(Date.now() / 1000) - 7200 },
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

  const start = (deps: Partial<Parameters<typeof startPage>[1]> = {}) => {
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
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, loadDiff: async () => (await moduleGate, module), ...deps });
    const source = FakeSource.last!;

    pages.push(page);

    source.emit('hello', { key: 'pk', groups: [], scope: scope(), sessions: [session], items: [], more: false, status: null, artifacts: [], unread: 0 });
    return { page, source };
  };
  const button = () => root.querySelector<HTMLElement>('.changes-tab')!;
  const goToButton = () => root.querySelector<HTMLElement>('.changes-goto')!;
  const listGets = () => gets.filter((one) => one.startsWith('/v1/conversation/changes'));
  /** Opens the Changes tab and its Go to menu. */
  const openList = async () => {
    button().click();
    await flush();
    goToButton().click();
    await flush();
  };

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
  const openRow = async (index: number) => {
    await openList();
    root.querySelectorAll<HTMLElement>('.change-row')[index]!.click();
    await flush();
    await flush();
    await flush();
  };
  const diffGets = () => gets.filter((one) => one.startsWith('/v1/conversation/diff'));

  it('ChangesTab_PickingAFile_ScrollsTheOneTabToItUnderItsBar', async () => {
    start();
    await openRow(1);

    expect(root.querySelector('.changes-menu')).toBeNull();
    expect([...root.querySelectorAll('.changes-tab .tab-label')].map((one) => one.textContent)).toEqual(['Changes']);
    expect(root.querySelector('.changes-tab .codicon + .unread-dot + .tab-label')).not.toBeNull();
    expect(root.querySelector('.changes-tab')!.getAttribute('aria-label')).toBe('Changes, 1 of 3 files viewed');
    expect(root.querySelector('.changes-tab')!.classList.contains('selected')).toBe(true);
    expect(changesMounts).toHaveLength(1);
    expect(changesMounts[0]!.rows).toEqual(['docs/a.md', 'src/new.ts', 'logo.png']);
    expect(changesMounts[0]!.scrolls).toEqual(['src/new.ts']);
    // A phone's width (test/setup.ts): stacked and wrapped.
    expect(changesMounts[0]).toMatchObject({ layout: 'stacked', wrap: true });
    // The tree, its splitter, the bar, then the diffs; each file's own header carries only its Viewed tick from the page. At a phone's width
    // the tree is a flyout the bar's first button opens.
    expect([...root.querySelector('.diff-view')!.children].map((one) => one.className)).toEqual(['changes-tree', 'tree-splitter', 'changes-bar', 'diff-host']);
    expect(root.querySelector('.diff-view')!.classList.contains('tree-pinned')).toBe(false);
    expect(root.querySelector('.changes-bar .changes-note')!.textContent).toBe('3 files · +3 −1');
    expect([...root.querySelectorAll<HTMLElement>('.changes-bar [data-action]')].map((one) => one.dataset['action'])).toEqual(['tree-flyout', 'changes-menu', 'changes-hide-viewed', 'changes-collapse-all', 'changes-expand-all', 'changes-wrap', 'changes-refresh', 'changes-more']);
    expect(root.querySelector('.diff-head')).toBeNull();
    expect([...root.querySelectorAll<HTMLInputElement>('.diff-host .diff-viewed input')].map((box) => [box.dataset['path'], box.checked])).toEqual([
      ['docs/a.md', false],
      ['src/new.ts', true],
      ['logo.png', false],
    ]);

    // Ticking in a header ticks the list's row too.
    root.querySelectorAll<HTMLElement>('.diff-host .diff-viewed input')[0]!.click();
    await flush();
    expect(gets.at(-1)).toBe('VIEWED docs/a.md h-a true 3');
    expect(root.querySelector('.changes-tab')!.getAttribute('aria-label')).toBe('Changes, 2 of 3 files viewed');
    expect(root.querySelector('.changes-tab .unread-dot')).not.toBeNull();
    expect(root.querySelectorAll<HTMLInputElement>('.diff-host .diff-viewed input')[0]!.checked).toBe(true);

    // Picking another row scrolls the same tab.
    await openRow(0);
    expect(changesMounts).toHaveLength(1);
    expect(changesMounts[0]!.scrolls).toEqual(['src/new.ts', 'docs/a.md']);

    // Another tab ends the viewer; choosing Changes again shows the same one tab, its list not read again.
    const reads = listGets().length;

    root.querySelector<HTMLElement>('[data-tab="conversation"]')!.click();
    await flush();
    expect(root.querySelector('.diff-view')).toBeNull();
    expect(changesMounts[0]!.disposed).toBe(true);
    expect(root.querySelectorAll('.changes-tab')).toHaveLength(1);
    button().click();
    await flush();
    await flush();
    expect(root.querySelectorAll('.changes-tab')).toHaveLength(1);
    expect(root.querySelector('.changes-tab')!.classList.contains('selected')).toBe(true);
    expect(changesMounts).toHaveLength(2);
    expect(listGets()).toHaveLength(reads);
  });

  it('ChangesTab_TooLargeOnPairedDevice_SaysSoWithoutVsCode', async () => {
    diffAnswers['src/new.ts'] = { status: 200, body: { path: 'src/new.ts', status: 'M', patch: null, old: null, new: null, binary: false, tooLarge: 'patch' } };
    const unread = () => ({ ...LIST, rows: LIST.rows.map((row) => ({ ...row, viewed: false, binary: false, additions: row.additions ?? 1, deletions: row.deletions ?? 0 })) });

    answers.push({ status: 200, body: unread() }, { status: 200, body: unread() });
    start({ local: false });
    visible = { first: 0, last: 1 };
    await openRow(0);
    await flush();

    expect(changesMounts[0]!.sets).toContainEqual(['src/new.ts', 'This change is too large to show here.']);
  });

  it('ChangesTab_ForTheFilesInView_ReadsEachPatchAloneAndDrawsItOrWhyNot', async () => {
    diffAnswers['src/new.ts'] = { status: 404, body: { error: 'src/new.ts is not one of the changes now.' } };
    diffAnswers['logo.png'] = { status: 200, body: { path: 'logo.png', status: 'U', patch: null, old: null, new: null, binary: true, tooLarge: null, partial: true } };
    // None viewed, so none starts collapsed and unread.
    // The list does not know logo.png is binary, so it is read; its answer says so.
    const unread = () => ({ ...LIST, rows: LIST.rows.map((row) => ({ ...row, viewed: false, binary: false, additions: row.additions ?? 1, deletions: row.deletions ?? 0 })) });

    answers.push({ status: 200, body: unread() }, { status: 200, body: unread() });
    start();
    visible = { first: 0, last: 1 };
    await openRow(0);
    await flush();

    // The two rows on screen and the next one.
    expect(diffGets()).toEqual(['/v1/conversation/diff?window=pk&path=docs%2Fa.md&sides=0', '/v1/conversation/diff?window=pk&path=src%2Fnew.ts&sides=0', '/v1/conversation/diff?window=pk&path=logo.png&sides=0']);
    expect(changesMounts[0]!.sets).toEqual([
      ['docs/a.md', 'diff'],
      ['src/new.ts', 'src/new.ts is not one of the changes now.'],
      ['logo.png', 'Binary file not shown.'],
    ]);

    // Expanding a folded region reads both sides of that file.
    await expect(changesMounts[0]!.loadSides('docs/a.md')).resolves.toMatchObject({ path: 'docs/a.md', old: 'a' });
    expect(diffGets().at(-1)).toBe('/v1/conversation/diff?window=pk&path=docs%2Fa.md');
  });

  it('ChangesTab_WhileScrolling_ReadsAtMostThreeAtOnceAndOnlyWhatTheViewWants', async () => {
    const many: ChangesList = { ...LIST, rows: Array.from({ length: 12 }, (_, index) => ({ ...LIST.rows[0]!, path: `f${index}.ts`, hash: `h${index}` })), shown: 12, total: 12 };
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));

    answers.push({ status: 200, body: many }, { status: 200, body: many });
    for (let index = 0; index < 12; index++) {
      diffAnswers[`f${index}.ts`] = { status: 200, body: { path: `f${index}.ts`, status: 'M', patch: 'diff --git a/x b/x', old: null, new: null, binary: false, tooLarge: null, partial: true }, wait: held } as never;
    }

    start();
    visible = { first: 0, last: 2 };
    await openRow(0);
    await flush();
    // On screen 0 to 2 and the next three: six wanted, three read at once.
    expect(diffGets()).toHaveLength(3);

    // Scrolled far down before they answer: the rows wanted then are read next, never the ones left behind.
    visible = { first: 9, last: 9 };
    changesMounts[0]!.want();
    release();
    for (let index = 0; index < 8; index++) {
      await flush();
    }

    expect(diffGets().map((one) => /path=([^&]*)/.exec(one)![1])).toEqual(['f0.ts', 'f1.ts', 'f2.ts', 'f9.ts', 'f10.ts', 'f11.ts']);
  });

  it('ChangesTab_With142Files_ReadsNothingUpFrontAndOnlyTheViewAndTheNext', async () => {
    const many: ChangesList = { ...LIST, rows: Array.from({ length: 142 }, (_, index) => ({ ...LIST.rows[0]!, path: `f${index}.ts`, hash: `h${index}` })), shown: 142, total: 142 };

    answers.push({ status: 200, body: many }, { status: 200, body: many });
    start();
    // The tab is not laid out yet: no height, so nothing is on screen.
    visible = null;
    await openRow(0);
    for (let index = 0; index < 6; index++) {
      await flush();
    }

    expect(changesMounts[0]!.rows).toHaveLength(142);
    expect(diffGets()).toEqual([]);

    // Laid out with two files on screen: those and the next three, nothing more however long it waits.
    visible = { first: 0, last: 1 };
    changesMounts[0]!.want();
    for (let index = 0; index < 10; index++) {
      await flush();
    }

    expect(diffGets().map((one) => /path=([^&]*)/.exec(one)![1])).toEqual(['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts']);

    // A jump from the list far down reads only there.
    visible = { first: 100, last: 100 };
    changesMounts[0]!.want();
    for (let index = 0; index < 10; index++) {
      await flush();
    }

    expect(diffGets().map((one) => /path=([^&]*)/.exec(one)![1]).slice(5)).toEqual(['f100.ts', 'f101.ts', 'f102.ts', 'f103.ts']);
  });

  it('ChangesTab_WhenAFileChanges_ReadsItAgainWithItsETagAndKeepsItOn304', async () => {
    let etag = '"e1"';
    const { source } = start();

    etags['docs/a.md'] = () => etag;
    await openRow(0);
    await flush();
    expect(changesMounts[0]!.sets.filter(([path]) => path === 'docs/a.md')).toHaveLength(1);

    // The turn's end reads the list again: an unchanged row is not read again.
    source.emit('session', { session: { ...session, state: 'running' } });
    source.emit('session', { session: { ...session, state: 'idle' } });
    await flush();
    await flush();
    expect(diffGets().filter((one) => one.includes('docs%2Fa.md'))).toHaveLength(1);

    // Its hash changed: read again with its ETag; a 304 keeps what is drawn.
    answers.push({ status: 200, body: { ...LIST, rows: LIST.rows.map((row) => (row.path === 'docs/a.md' ? { ...row, hash: 'h-a2' } : row)) } });
    notModified.add('docs/a.md');
    source.emit('session', { session: { ...session, state: 'running' } });
    source.emit('session', { session: { ...session, state: 'idle' } });
    for (let index = 0; index < 6; index++) {
      await flush();
    }

    expect(diffGets().filter((one) => one.includes('docs%2Fa.md'))).toHaveLength(2);
    expect(ifNoneMatch.at(-1)).toBe('"e1"');
    expect(changesMounts[0]!.sets.filter(([path]) => path === 'docs/a.md')).toHaveLength(1);
    etag = '"e2"';
  });

  it('ChangesTab_AnswerForARowThatChangedMeanwhile_IsDroppedAndReadAgain', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { source } = start();

    diffAnswers['docs/a.md'] = { status: 200, body: { path: 'docs/a.md', status: 'M', patch: 'diff --git a/x b/x', old: null, new: null, binary: false, tooLarge: null, partial: true }, wait: held } as never;
    await openRow(0);
    // The list is read again while the first read is on its way, and the file's content changed.
    answers.push({ status: 200, body: { ...LIST, rows: LIST.rows.map((row) => (row.path === 'docs/a.md' ? { ...row, hash: 'h-a2', status: 'R' as const, from: 'docs/old.md' } : row)) } });
    source.emit('session', { session: { ...session, state: 'running' } });
    source.emit('session', { session: { ...session, state: 'idle' } });
    await flush();
    await flush();
    // Its header data changed, so its placeholder is drawn again from the new row.
    expect(changesMounts[0]!.sets).toContainEqual(['docs/a.md', 'placeholder']);
    delete diffAnswers['docs/a.md'];
    release();
    for (let index = 0; index < 8; index++) {
      await flush();
    }

    // The old answer drew nothing; the row was read again and that answer drawn.
    expect(diffGets().filter((one) => one.includes('docs%2Fa.md'))).toHaveLength(2);
    expect(changesMounts[0]!.sets.filter(([path, what]) => path === 'docs/a.md' && what === 'diff')).toHaveLength(1);
  });

  it('LoadSides_ForAFileChangedSinceItsPatch_GivesNothingAndReadsItAgain', async () => {
    start();
    await openRow(0);
    await flush();
    diffAnswers['docs/a.md'] = { status: 200, body: { path: 'docs/a.md', status: 'M', patch: 'diff --git a/y b/y', old: 'a', new: 'b', binary: false, tooLarge: null } };
    await expect(changesMounts[0]!.loadSides('docs/a.md')).resolves.toBeNull();
    await flush();
    await flush();
    expect(diffGets().filter((one) => one.includes('docs%2Fa.md') && one.endsWith('sides=0'))).toHaveLength(2);
  });

  it('Chevron_InAFilesHeader_CollapsesAndExpandsThatFile', async () => {
    start();
    await openRow(0);

    const chevron = (path: string) => root.querySelector<HTMLElement>(`.diff-host .diff-chevron[data-path="${path}"]`)!;

    expect([...root.querySelectorAll<HTMLElement>('.diff-host .diff-chevron')].map((one) => one.dataset['path'])).toEqual(['docs/a.md', 'src/new.ts', 'logo.png']);
    expect(chevron('docs/a.md').getAttribute('aria-expanded')).toBe('true');
    chevron('docs/a.md').click();
    // The viewed file started collapsed.
    // The viewed file and the binary one started collapsed.
    expect(changesMounts[0]!.collapsed).toEqual(['src/new.ts true', 'logo.png true', 'docs/a.md true']);
    expect(chevron('docs/a.md').getAttribute('aria-expanded')).toBe('false');
    expect(chevron('docs/a.md').querySelector('.codicon-chevron-right')).not.toBeNull();
    chevron('docs/a.md').click();
    expect(changesMounts[0]!.collapsed).toEqual(['src/new.ts true', 'logo.png true', 'docs/a.md true', 'docs/a.md false']);
    expect(chevron('docs/a.md').getAttribute('aria-expanded')).toBe('true');
  });

  it('CollapsedHeader_AfterCollapseAll_ExpandsThatFileAlone', async () => {
    start();
    await openRow(0);
    button().click();
    await flush();
    root.querySelector<HTMLElement>('[data-action="changes-collapse-all"]')!.click();
    expect(root.querySelectorAll('.diff-host .diff-chevron[aria-expanded="false"]')).toHaveLength(3);

    changesMounts[0]!.header('src/new.ts');
    expect(changesMounts[0]!.collapsed.at(-1)).toBe('src/new.ts false');
    expect([...root.querySelectorAll<HTMLElement>('.diff-host .diff-chevron')].map((one) => one.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'false']);

    // A header click on a file that shows changes nothing.
    const before = changesMounts[0]!.collapsed.length;

    changesMounts[0]!.header('src/new.ts');
    expect(changesMounts[0]!.collapsed).toHaveLength(before);

    // Collapse all and Expand all still apply to every file.
    root.querySelector<HTMLElement>('[data-action="changes-expand-all"]')!.click();
    expect(root.querySelectorAll('.diff-host .diff-chevron[aria-expanded="true"]')).toHaveLength(3);
  });

  it('ChangesTab_CollapsedFiles_AreNotReadUntilExpanded', async () => {
    const many: ChangesList = { ...LIST, rows: Array.from({ length: 142 }, (_, index) => ({ ...LIST.rows[0]!, path: `f${index}.ts`, hash: `h${index}` })), shown: 142, total: 142 };

    answers.push({ status: 200, body: many }, { status: 200, body: many }, { status: 200, body: many });
    start();
    visible = null;
    await openRow(0);
    await flush();
    button().click();
    await flush();
    root.querySelector<HTMLElement>('[data-action="changes-collapse-all"]')!.click();
    // Collapsed, many headers fit the view: none of their diffs is read.
    visible = { first: 0, last: 20 };
    changesMounts[0]!.want();
    for (let index = 0; index < 6; index++) {
      await flush();
    }

    expect(diffGets()).toEqual([]);

    // Expanding one reads it alone.
    changesMounts[0]!.header('f3.ts');
    for (let index = 0; index < 6; index++) {
      await flush();
    }

    expect(diffGets().map((one) => /path=([^&]*)/.exec(one)![1])).toEqual(['f3.ts']);
  });

  it('ViewedTick_InAHeader_CollapsesTheFileAndUntickingExpandsIt', async () => {
    start();
    await openRow(0);

    const box = (index: number) => root.querySelectorAll<HTMLElement>('.diff-host .diff-viewed input')[index]!;

    // A viewed file starts collapsed when the tab opens, as a binary one does.
    expect(changesMounts[0]!.collapsed).toEqual(['src/new.ts true', 'logo.png true']);
    box(0).click();
    await flush();
    expect(changesMounts[0]!.collapsed.at(-1)).toBe('docs/a.md true');
    // Not at the top, so the view stays where it is.
    expect(changesMounts[0]!.scrolls).toEqual(['docs/a.md']);
    box(0).click();
    await flush();
    expect(changesMounts[0]!.collapsed.at(-1)).toBe('docs/a.md false');
  });

  it('ViewedTick_OnTheFileAtTheTop_BringsTheNextFileUp', async () => {
    start();
    await openRow(0);
    current = 'docs/a.md';
    root.querySelectorAll<HTMLElement>('.diff-host .diff-viewed input')[0]!.click();
    await flush();
    expect(changesMounts[0]!.collapsed.at(-1)).toBe('docs/a.md true');
    expect(changesMounts[0]!.scrolls.at(-1)).toBe('src/new.ts');
  });

  it('ViewedTick_Refused_ExpandsTheFileAgain', async () => {
    start();
    await openRow(2);
    root.querySelectorAll<HTMLElement>('.diff-host .diff-viewed input')[2]!.click();
    for (let index = 0; index < 4; index++) {
      await flush();
    }

    expect(changesMounts[0]!.collapsed.slice(-2)).toEqual(['logo.png true', 'logo.png false']);
  });

  it('ViewedEvent_FromAnotherDevice_CollapsesOnlyAFileOffScreen', async () => {
    const { source } = start();

    await openRow(0);
    visible = { first: 0, last: 0 };
    source.emit('viewed', { workItemId: 1, path: 'docs/a.md', hash: 'h-a', viewed: true });
    expect(changesMounts[0]!.collapsed).not.toContain('docs/a.md true');
    source.emit('viewed', { workItemId: 1, path: 'logo.png', hash: 'h-logo', viewed: true });
    expect(changesMounts[0]!.collapsed.at(-1)).toBe('logo.png true');
    // Every file viewed: the tab's dot goes.
    expect(root.querySelector('.changes-tab .unread-dot')).toBeNull();
    expect(root.querySelector('.changes-tab')!.getAttribute('aria-label')).toBe('Changes, 3 of 3 files viewed');

    // Cleared there again: the file collapsed for its tick opens.
    source.emit('viewed', { workItemId: 1, path: 'logo.png', hash: 'h-logo', viewed: false });
    expect(changesMounts[0]!.collapsed.at(-1)).toBe('logo.png false');
  });

  it('ViewedTick_AtTheTopWithViewedHidden_BringsTheNextShownFileUp', async () => {
    // A file before the ticked one, so a jump back to the tab's first file would show.
    const four = { ...LIST, rows: [{ ...LIST.rows[0]!, path: 'a-first.md', hash: 'h-0' }, ...LIST.rows], shown: 4, total: 4 };

    answers.push(...[0, 1, 2].map(() => ({ status: 200, body: structuredClone(four) })));
    start();
    await openRow(1);
    button().click();
    await flush();
    root.querySelector<HTMLElement>('[data-action="changes-hide-viewed"]')!.click();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    current = 'docs/a.md';
    root.querySelector<HTMLElement>('.diff-host .diff-viewed input[data-path="docs/a.md"]')!.click();
    await flush();
    // src/new.ts is viewed and hidden, so logo.png comes up, never a file before it.
    expect(changesMounts[0]!.scrolls.at(-1)).toBe('logo.png');
  });

  it('ViewedCollapse_WhenTheTickGoesWithAChange_ExpandsButAnExpandedFileStaysOpen', async () => {
    const { source } = start();

    await openRow(0);
    // Expanded by the operator: a list read again keeps it so.
    changesMounts[0]!.header('src/new.ts');
    expect(changesMounts[0]!.collapsed.at(-1)).toBe('src/new.ts false');
    source.emit('session', { session: { ...session, state: 'running' } });
    source.emit('session', { session: { ...session, state: 'idle' } });
    await flush();
    await flush();
    expect(changesMounts[0]!.collapsed.at(-1)).toBe('src/new.ts false');

    // Collapsed by its tick (unticked and ticked again), then the file changed and the hub dropped the tick: it expands.
    root.querySelectorAll<HTMLElement>('.diff-host .diff-viewed input')[1]!.click();
    for (let index = 0; index < 4; index++) {
      await flush();
    }

    root.querySelectorAll<HTMLElement>('.diff-host .diff-viewed input')[1]!.click();
    for (let index = 0; index < 4; index++) {
      await flush();
    }

    expect(changesMounts[0]!.collapsed.at(-1)).toBe('src/new.ts true');
    answers.push({ status: 200, body: { ...LIST, rows: LIST.rows.map((row) => (row.path === 'src/new.ts' ? { ...row, hash: 'h-new2', viewed: false } : row)) } });
    source.emit('session', { session: { ...session, state: 'running' } });
    source.emit('session', { session: { ...session, state: 'idle' } });
    for (let index = 0; index < 4; index++) {
      await flush();
    }

    expect(changesMounts[0]!.collapsed).toContain('src/new.ts false');
    expect(changesMounts[0]!.collapsed.lastIndexOf('src/new.ts false')).toBeGreaterThan(changesMounts[0]!.collapsed.lastIndexOf('src/new.ts true'));
  });

  it('LargeFiles_BinaryGeneratedOrPast1500Lines_StartCollapsedAndAreReadOnlyWhenExpanded', async () => {
    const rows = [
      { ...LIST.rows[0]!, path: 'small.ts', hash: 'h-1', viewed: false },
      { ...LIST.rows[0]!, path: 'package-lock.json', hash: 'h-2', viewed: false },
      { ...LIST.rows[0]!, path: 'big.ts', additions: 1400, deletions: 200, hash: 'h-3', viewed: false },
      { ...LIST.rows[2]!, path: 'logo.png', hash: 'h-4', viewed: false },
    ];
    const list = { ...LIST, rows, shown: 4, total: 4 };

    answers.push(...[0, 1, 2].map(() => ({ status: 200, body: structuredClone(list) })));
    start();
    visible = { first: 0, last: 3 };
    await openRow(0);
    for (let index = 0; index < 6; index++) {
      await flush();
    }

    expect(changesMounts[0]!.collapsed).toEqual(['package-lock.json true', 'big.ts true', 'logo.png true']);
    expect(diffGets().map((one) => /path=([^&]*)/.exec(one)![1])).toEqual(['small.ts']);

    // Expanding one reads it; it is not collapsed again when the list is read again.
    changesMounts[0]!.header('big.ts');
    for (let index = 0; index < 6; index++) {
      await flush();
    }

    expect(diffGets().map((one) => /path=([^&]*)/.exec(one)![1])).toEqual(['small.ts', 'big.ts']);
    root.querySelector<HTMLElement>('[data-action="changes-refresh"]')!.click();
    await flush();
    await flush();
    expect(changesMounts[0]!.collapsed.filter((one) => one === 'big.ts true')).toHaveLength(1);
  });

  it('Keys_InTheChangesTab_MoveBetweenFilesAndChangesTickAndCollapse', async () => {
    start();
    await openRow(0);

    const view = root.querySelector<HTMLElement>('.diff-view')!;
    const press = (key: string, target: Element = view, extra: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));

    expect(view.tabIndex).toBe(0);
    current = 'docs/a.md';
    changesMounts[0]!.scrolls.length = 0;
    press('j');
    press('k');
    expect(changesMounts[0]!.scrolls).toEqual(['src/new.ts']);
    current = 'src/new.ts';
    press('k');
    expect(changesMounts[0]!.scrolls.at(-1)).toBe('docs/a.md');

    // ] skips the viewed file to the next one not viewed; [ goes back.
    current = 'docs/a.md';
    press(']');
    expect(changesMounts[0]!.scrolls.at(-1)).toBe('logo.png');
    current = 'logo.png';
    press('[');
    expect(changesMounts[0]!.scrolls.at(-1)).toBe('docs/a.md');

    // n and p walk the changes of the file at the top, then on to the next file.
    hunks = { 'docs/a.md': [3, 40] };
    current = 'docs/a.md';
    press('n');
    press('n');
    press('p');
    expect(changesMounts[0]!.scrolls.slice(-3)).toEqual(['docs/a.md:3', 'docs/a.md:40', 'docs/a.md:3']);
    press('n');
    press('n');
    // src/new.ts is collapsed (viewed), so the walk goes to it whole.
    expect(changesMounts[0]!.scrolls.at(-1)).toBe('src/new.ts');

    // x collapses and expands the file at the top; v ticks it.
    press('x');
    expect(changesMounts[0]!.collapsed.at(-1)).toBe('docs/a.md true');
    press('x');
    expect(changesMounts[0]!.collapsed.at(-1)).toBe('docs/a.md false');
    press('v');
    await flush();
    expect(gets.at(-1)).toBe('VIEWED docs/a.md h-a true 3');

    // Not with a modifier, and not outside the tab.
    const before = changesMounts[0]!.scrolls.length;

    press('j', view, { ctrlKey: true });
    press('j', document.body);
    expect(changesMounts[0]!.scrolls).toHaveLength(before);
  });

  it('HunkKeys_AfterAScroll_GoOnFromTheLineAtTheTop', async () => {
    start();
    await openRow(0);

    const view = root.querySelector<HTMLElement>('.diff-view')!;
    const press = (key: string) => view.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

    hunks = { 'docs/a.md': [3, 40, 90] };
    current = 'docs/a.md';
    // Scrolled by hand to line 50: n goes on to 90, never back to 3.
    topLines = { 'docs/a.md': 50 };
    press('n');
    expect(changesMounts[0]!.scrolls.at(-1)).toBe('docs/a.md:90');

    // Choosing the tab again forgets where n went; from line 20, p goes back to 3.
    root.querySelector<HTMLElement>('[data-tab="conversation"]')!.click();
    await openRow(0);
    topLines = { 'docs/a.md': 20 };
    root.querySelector<HTMLElement>('.diff-view')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true }));
    expect(changesMounts[1]!.scrolls.at(-1)).toBe('docs/a.md:3');
  });

  it('ViewedTick_InAHeader_KeepsItsNameForScreenReadersWhenOnlyTheBoxShows', async () => {
    start();
    await openRow(0);

    const box = root.querySelector<HTMLInputElement>('.diff-host .diff-viewed input')!;

    // A narrow pane hides the word (changes.css), so the box carries its own name.
    expect(box.getAttribute('aria-label')).toBe('Viewed docs/a.md');
    expect(box.parentElement!.querySelector('.diff-viewed-label')!.textContent).toBe('Viewed');
  });

  it('Escape_InAFileView_GoesBackToTheDiffs', async () => {
    start();
    await openRow(1);
    changesMounts[0]!.onLine!('src/new.ts', 'old', 12);
    await flush();
    await flush();
    // From inside the file view, which leaves the page: the focus goes back to the Changes view, so its keys keep working.
    root.querySelector('.file-overlay .fake')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.file-overlay')).toBeNull();
    expect(changesMounts[0]!.disposed).toBe(false);
    expect(document.activeElement).toBe(root.querySelector('.diff-view'));
  });

  it('ChangesMenu_Buttons_HideViewedCollapseAndExpandEveryFile', async () => {
    start();
    await openRow(0);
    goToButton().click();
    await flush();
    root.querySelector<HTMLElement>('[data-action="changes-hide-viewed"]')!.click();
    expect(changesMounts[0]!.rows).toEqual(['docs/a.md', 'logo.png']);
    expect(root.querySelector('[data-action="changes-hide-viewed"]')!.getAttribute('aria-pressed')).toBe('true');
    root.querySelector<HTMLElement>('[data-action="changes-collapse-all"]')!.click();
    // The viewed file started collapsed; it is hidden now, so only the others collapse.
    expect(changesMounts[0]!.collapsed).toEqual(['src/new.ts true', 'logo.png true', 'docs/a.md true', 'logo.png true']);
    root.querySelector<HTMLElement>('[data-action="changes-expand-all"]')!.click();
    expect(changesMounts[0]!.collapsed.slice(4)).toEqual(['docs/a.md false', 'logo.png false']);

    // Picking a hidden viewed file shows the viewed files again.
    root.querySelectorAll<HTMLElement>('.change-row')[1]!.click();
    await flush();
    expect(changesMounts[0]!.rows).toEqual(['docs/a.md', 'src/new.ts', 'logo.png']);
  });

  it('ChangesTab_ScopeChanged_DropsTheDiffsAndReadsThemAndTheFilesForTheNewScope', async () => {
    const commit = structuredClone({ ...LIST, from: FIRST, to: HEAD });
    const range = `&from=${FIRST}&to=${HEAD}`;

    // The tab's read, then the commit's list.
    answers.push({ status: 200, body: structuredClone(LIST) }, { status: 200, body: commit });
    start();
    await openRow(0);
    expect(diffGets()[0]).toBe('/v1/conversation/diff?window=pk&path=docs%2Fa.md&sides=0');

    await pick('Second change');
    await flush();
    await flush();

    // The viewer for the list since the base ends, and a new one reads the same file again, in the commit.
    expect(changesMounts).toHaveLength(2);
    expect(changesMounts[0]!.disposed).toBe(true);
    expect(diffGets().at(-1)).toBe(`/v1/conversation/diff?window=pk&path=docs%2Fa.md&sides=0${range}`);
    await expect(changesMounts[1]!.loadSides('docs/a.md')).resolves.toMatchObject({ path: 'docs/a.md' });
    expect(diffGets().at(-1)).toBe(`/v1/conversation/diff?window=pk&path=docs%2Fa.md${range}`);

    // A line's file on the old side is the file in the commit's parent, and on the new side the file in the commit.
    changesMounts[1]!.onLine!('docs/a.md', 'old', 2);
    await flush();
    await flush();
    expect(gets.at(-1)).toBe(`/v1/conversation/file?window=pk&path=docs%2Fa.md&side=base${range}`);
    expect(root.querySelector('.changes-bar .diff-at')!.textContent).toBe(':2 at 1111111');
    root.querySelector<HTMLElement>('[data-action="changes-back"]')!.click();
    changesMounts[1]!.onLine!('docs/a.md', 'new', 3);
    await flush();
    await flush();
    expect(gets.at(-1)).toBe(`/v1/conversation/file?window=pk&path=docs%2Fa.md&side=disk${range}`);
    expect(root.querySelector('.changes-bar .diff-at')!.textContent).toBe(':3 at fedcba9');
  });

  it('ViewedEvent_InAnotherScope_LeavesTheListShownAlone', async () => {
    const commit = structuredClone({ ...LIST, from: FIRST, to: HEAD });

    answers.push({ status: 200, body: structuredClone(LIST) }, { status: 200, body: commit });

    const { source } = start();

    await openList();
    await pick('Second change');
    goToButton().click();

    const boxes = () => [...root.querySelectorAll<HTMLInputElement>('.change-viewed input')].map((box) => box.checked);

    expect(boxes()).toEqual([false, true, false]);
    // A tick in the changes to disk is not one in the commit.
    source.emit('viewed', { workItemId: 1, path: 'docs/a.md', hash: 'h-a', viewed: true, scope: '' });
    expect(boxes()).toEqual([false, true, false]);
    source.emit('viewed', { workItemId: 1, path: 'docs/a.md', hash: 'h-a', viewed: true, scope: `${FIRST}..${HEAD}` });
    expect(boxes()).toEqual([true, true, false]);
  });

  it('ChangesTab_UncommittedPickedWhileTheViewerLoads_SaysThereAreNoUncommittedChanges', async () => {
    let release: () => void = () => {};

    moduleGate = new Promise<void>((resolve) => (release = resolve));
    answers.push({ status: 200, body: structuredClone(LIST) }, { status: 200, body: { ...LIST, rows: [], shown: 0, total: 0, from: 'HEAD' } });
    start();
    await openRow(0);
    expect(root.querySelector('.diff-host')!.textContent).toBe('Loading the diff viewer…');

    await pick('Uncommitted changes');
    release();
    await flush();
    await flush();

    expect(changesMounts).toHaveLength(0);
    expect(root.querySelector('.diff-host')!.textContent).toBe('No uncommitted changes.');
  });

  it('ViewedTick_QueuedBeforeAnotherScopeIsPicked_PostsForTheListItWasShownIn', async () => {
    let answer: () => void = () => {};
    const held = new Promise<void>((resolve) => (answer = resolve));

    start();
    await openList();

    const box = () => root.querySelectorAll<HTMLElement>('.change-viewed input')[0]!;

    // The first post waits for its answer while a second click and the toggle come.
    ticksGate = held;
    box().click();
    box().click();
    root.querySelector<HTMLElement>('.changes-tree [data-action="tree-range"][data-from="HEAD"]')!.click();
    answer();
    await flush();
    await flush();
    await flush();

    expect(ticks.map((one) => `${String(one['from'])} ${String(one['to'])}`)).toEqual(['base worktree', 'base worktree']);
  });

  it("ChangesTab_LineNumberClicked_ShowsTheFileOnDiskInFilesAndARevisionOverTheDiffs", async () => {
    start();
    await openRow(1);
    // The new side of the changes to disk is the file on disk, which the Files tab shows at the line, beside its tree.
    changesMounts[0]!.onLine!('src/new.ts', 'new', 12);
    await flush();
    await flush();
    expect(gets.at(-1)).toBe('/v1/conversation/file?window=pk&path=src%2Fnew.ts&side=disk&from=HEAD&to=worktree');
    expect(files.at(-1)).toEqual({ path: 'src/new.ts', side: 'disk', line: 12 });
    expect(root.querySelector('.diff-view.files-view .file-overlay .fake')!.textContent).toBe('file src/new.ts at 12');
    expect(root.querySelector('.changes-bar .file-path bdi')!.textContent).toBe('src/new.ts');
    expect(root.querySelector('.changes-bar .diff-at')!.textContent).toBe(':12');
    expect(root.querySelector('[data-side="files"], [data-tab="files"]')!.getAttribute('aria-selected')).toBe('true');

    // Its Diff goes back to the file's diff in Changes; the Files tab keeps the file.
    root.querySelector<HTMLElement>('.changes-bar [data-action="file-diff"]')!.click();
    await flush();
    await flush();
    expect(root.querySelector('.changes-tab')!.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('.diff-view.files-view')).toBeNull();
    root.querySelector<HTMLElement>('[data-side="files"], [data-tab="files"]')!.click();
    await flush();
    expect(root.querySelector('.diff-view.files-view .file-overlay .fake')!.textContent).toBe('file src/new.ts at 12');
    root.querySelector<HTMLElement>('.changes-tab')!.click();
    await flush();
    await flush();

    // The old side's line opens the file at the base, by its old name, over the diffs, the bar's back closing it first.
    changesMounts.at(-1)!.onLine!('src/new.ts', 'old', 3);
    await flush();
    await flush();
    expect(files.at(-1)).toEqual({ path: 'src/old.ts', side: 'base', line: 3 });
    expect(root.querySelector('.changes-bar .diff-at')!.textContent).toBe(':3 at the base');
    expect(root.querySelector('.file-overlay .diff-head')).toBeNull();
    expect(root.querySelector('.file-overlay [data-action="changes-back"], .file-overlay .diff-back')).toBeNull();
    root.querySelector<HTMLElement>('.changes-bar [data-action="changes-back"]')!.click();
    await flush();
    expect(root.querySelector('.file-overlay')).toBeNull();
    expect(changesMounts.at(-1)!.disposed).toBe(false);
  });

  it('DiffHeader_File_ShowsTheFileOnDiskInFiles', async () => {
    start();
    await openRow(1);
    root.querySelector<HTMLElement>('.diff-host [data-action="diff-file"][data-path="src/new.ts"]')!.click();
    await flush();
    await flush();
    expect(files.at(-1)).toEqual({ path: 'src/new.ts', side: 'disk', line: null });
    expect(root.querySelector('[data-side="files"], [data-tab="files"]')!.getAttribute('aria-selected')).toBe('true');
  });

  it('offers the way back from a file view before the viewer draws its header', async () => {
    start();
    await openRow(1);
    changesMounts[0]!.onLine!('src/new.ts', 'old', 12);
    expect(root.querySelector('.file-overlay .empty')!.textContent).toBe('Reading the file…');
    expect(root.querySelector('.changes-bar [data-action="changes-back"]')).not.toBeNull();
  });

  it('lays the diffs out as the settings say, and again when they change', async () => {
    const { source } = start();

    source.emit('settings', { settings: { briefReplies: false, diffLayout: 'split', diffWrap: 'on' } });
    await openRow(0);
    expect(root.querySelector('[data-action="diff-layout"], [data-action="diff-wrap"]')).toBeNull();
    expect(changesMounts[0]).toMatchObject({ layout: 'split', wrap: true });

    source.emit('settings', { settings: { briefReplies: false, diffLayout: 'stacked', diffWrap: 'off' } });
    expect(changesMounts[0]!.layouts.at(-1)).toBe('stacked false');
  });

  it("ChangesMenu_WhileTheRowOffersOpenInVsCode_HasNoOpenInVsCode", async () => {
    const { source } = start();

    source.emit('list', { groups: [{ key: 'progress', title: 'progress', glyph: '', empty: null, rows: [listRow({ opens: [{ label: 'Open in VS Code', icon: 'vscode' }] })] }] });
    await openList();
    // It stays in the work item's Actions menu only.
    expect(root.querySelector('.changes-menu')).not.toBeNull();
    expect(root.querySelector('.changes-menu [data-label="Open in VS Code"], .changes-open')).toBeNull();
  });

  it('says so when the diff viewer cannot load', async () => {
    module = null;
    start();
    await openRow(0);
    expect(root.querySelector('.diff-host')!.textContent).toBe('The diff viewer could not be loaded. Reload the page to try again.');
  });

  it('gives the diffs the layout their pane calls for when the pane is resized', async () => {
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

    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 1200 });
    observers.forEach((callback) => callback([{ target: pane }]));
    expect(changesMounts[0]!.layouts.at(-1)).toBe('split false');
    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 500 });
    observers.forEach((callback) => callback([{ target: pane }]));
    expect(changesMounts[0]!.layouts.at(-1)).toBe('stacked true');

    // A file view wraps as its pane narrows, and stays stacked.
    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 1200 });
    changesMounts[0]!.onLine!('docs/a.md', 'new', 2);
    await flush();
    await flush();
    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 500 });
    observers.forEach((callback) => callback([{ target: pane }]));
    expect(fileSets.at(-1)).toBe('stacked true');
    vi.unstubAllGlobals();
  });

  const wrapButton = () => root.querySelector<HTMLElement>('[data-action="changes-wrap"]')!;

  it("WrapToggle_NoStoredChoice_ShowsTheSettingsEffectiveWrapAndFollowsAutoOnResize", async () => {
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
    // A phone's width under auto: wrapped, so Wrap shows pressed.
    expect(wrapButton().getAttribute('aria-pressed')).toBe('true');
    expect(wrapButton().title).toBe('Do not wrap long lines');
    expect(wrapButton().querySelector('.codicon-word-wrap')).not.toBeNull();

    const pane = root.querySelector<HTMLElement>('.diff-pane')!;

    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 1200 });
    observers.forEach((callback) => callback([{ target: pane }]));
    expect(changesMounts[0]!.layouts.at(-1)).toBe('split false');
    expect(wrapButton().getAttribute('aria-pressed')).toBe('false');
    expect(wrapButton().title).toBe('Wrap long lines');
    expect(localStorage.getItem('switchboard.diffWrap')).toBeNull();
    vi.unstubAllGlobals();
  });

  it("WrapToggle_Clicked_AppliesAtOnceAndKeepsTheChoiceOnTheDevice", async () => {
    const { source } = start();

    await openRow(0);
    wrapButton().click();
    expect(changesMounts[0]!.layouts.at(-1)).toBe('stacked false');
    expect(wrapButton().getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem('switchboard.diffWrap')).toBe('off');

    // The device's choice outlasts a change to web.diffWrap.
    source.emit('settings', { settings: { briefReplies: false, diffLayout: 'auto', diffWrap: 'on' } });
    expect(changesMounts[0]!.layouts.at(-1)).toBe('stacked false');

    wrapButton().click();
    expect(changesMounts[0]!.layouts.at(-1)).toBe('stacked true');
    expect(wrapButton().getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('switchboard.diffWrap')).toBe('on');
  });

  it("WrapToggle_StoredChoice_StartsTheNextPageWithIt", async () => {
    localStorage.setItem('switchboard.diffWrap', 'off');
    start();
    await openRow(0);
    // Auto would wrap at a phone's width; the stored choice does not.
    expect(changesMounts[0]).toMatchObject({ layout: 'stacked', wrap: false });
    expect(wrapButton().getAttribute('aria-pressed')).toBe('false');
  });

  it("WrapToggle_StoredChoiceUnknown_FollowsTheSetting", async () => {
    localStorage.setItem('switchboard.diffWrap', 'sometimes');
    const { source } = start();

    source.emit('settings', { settings: { briefReplies: false, diffLayout: 'stacked', diffWrap: 'off' } });
    await openRow(0);
    expect(changesMounts[0]).toMatchObject({ layout: 'stacked', wrap: false });
  });

  it("WrapToggle_ClickedInAFileView_WrapsTheFile", async () => {
    start();
    await openRow(1);
    changesMounts[0]!.onLine!('src/new.ts', 'new', 12);
    await flush();
    await flush();
    // The file view lies under the bar, whose Wrap wraps the file too; the file's header has no Wrap of its own.
    const fileWrap = () => root.querySelector<HTMLElement>('.changes-bar [data-action="changes-wrap"]')!;

    expect(root.querySelector('.file-overlay [data-action="changes-wrap"]')).toBeNull();

    expect(fileWrap().getAttribute('aria-pressed')).toBe('true');
    fileWrap().click();
    expect(fileSets.at(-1)).toBe('stacked false');
    expect(fileWrap().getAttribute('aria-pressed')).toBe('false');
    expect(fileWrap().title).toBe('Wrap long lines');
    expect(localStorage.getItem('switchboard.diffWrap')).toBe('off');
    fileWrap().click();
    expect(fileSets.at(-1)).toBe('stacked true');
    expect(fileWrap().getAttribute('aria-pressed')).toBe('true');
  });

  it("WrapToggle_EmptyList_IsDisabled", async () => {
    answers.push({ status: 200, body: { ...structuredClone(LIST), rows: [], shown: 0, total: 0 } });
    start();
    button().click();
    await flush();
    expect(wrapButton().hasAttribute('disabled')).toBe(true);
  });

});
