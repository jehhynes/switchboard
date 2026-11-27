import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchLines, quoteText, treePinned } from '../src/changes.js';
import type { ChangesList } from '../src/changes.js';
import { folderEntries, ignoredSet, isIgnored, linkInfo, newTree } from '../src/changesTree.js';
import type { DiffModule } from '../src/diff/types.js';
import { startPage } from '../src/main.js';
import type { StackData, StackLink } from '@switchboard/protocol';
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

const sha = (char: string) => char.repeat(40);
const BASE = sha('0');
const [C1, C2, C3, FORK] = [sha('1'), sha('2'), sha('3'), sha('f')];
const NOW = Math.floor(Date.now() / 1000);
const COMMITS = [
  { sha: C3, parent: C2, subject: 'query the match pool by exact distance', time: NOW - 3 * 3600 },
  { sha: C2, parent: C1, subject: 'drop HNSW rebuild job', time: NOW - 4 * 3600 },
  { sha: C1, parent: BASE, subject: 'add match table', time: NOW - 5 * 3600 },
];
const LIST: ChangesList = {
  scopeGen: 3,
  base: BASE,
  head: C3,
  from: 'base',
  to: 'worktree',
  commits: COMMITS,
  commitsMore: false,
  rows: [{ path: 'src/match/pool.ts', status: 'M', stages: ['committed', 'working'], additions: 4, deletions: 1, binary: false, hash: 'h-pool', viewed: false }],
  stages: { committed: 1, staged: 0, working: 1, untracked: 0 },
  shown: 1,
  total: 1,
};
const UNCOMMITTED: ChangesList = { ...LIST, from: 'HEAD', rows: [{ path: 'src/match/pool.ts', status: 'M', stages: ['working'], additions: 1, deletions: 0, binary: false, hash: 'h-pool', viewed: false }, { path: 'README.md', status: 'U', stages: ['untracked'], additions: 2, deletions: 0, binary: false, hash: 'h-readme', viewed: false }] };
const link = (patch: Partial<StackLink>): StackLink => ({ name: 'base', relation: 'below', source: 'reflog', tip: C1, tipSource: 'local', forkPoint: C1, behind: 3, upstreamMissing: false, branchDeleted: false, notInClone: false, localDiffers: false, commitIds: [C1], more: false, actions: { expand: true, diffSince: true }, ...patch });
const STACK: StackData = {
  scopeGen: 3,
  repo: 'jessy',
  root: '/wt/jessy-201',
  branch: '201-exact-scan',
  head: C3,
  commitIds: [C3, C2],
  infos: [
    { ...COMMITS[0]!, files: ['src/match/pool.ts'] },
    { ...COMMITS[1]!, files: ['src/match/hnsw.ts'] },
    { ...COMMITS[2]!, files: ['db/migrations/0042_match_table.sql'] },
  ],
  more: false,
  incomplete: false,
  github: { state: 'fresh', observedAt: 1 },
  links: [link({ name: '200-match-table', source: 'github-stack', pr: { number: 200, state: 'open', url: 'https://github.com/o/r/pull/200' } }), link({ name: '202-ui', relation: 'above', tip: sha('9'), forkPoint: null, behind: null, lacks: 1, commitIds: [], actions: { expand: false, diffSince: false }, source: 'github-stack', pr: { number: 202, state: 'open', url: 'https://github.com/o/r/pull/202' } })],
  main: { ref: 'origin/main', behind: 15, fetchedAt: NOW * 1000 - 2 * 3600_000 },
};
const session = { id: 's', title: 'Task', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null };
const scope = () => ({ kind: 'page', key: 'pk', folder: '/wt', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0 }], workItemId: 1, cwd: '/wt', sessionId: 's' });

describe('tree helpers', () => {
  it('lists a folder’s folders and files, each sorted', () => {
    expect(folderEntries(['b.ts', 'src/a.ts', 'src/z/y.ts', 'a.md', 'docs/x.md'], '')).toEqual({ dirs: ['docs', 'src'], files: ['a.md', 'b.ts'] });
    expect(folderEntries(['src/a.ts', 'src/z/y.ts'], 'src')).toEqual({ dirs: ['src/z'], files: ['src/a.ts'] });
  });

  it('reads a path ending in / as a folder, never as an entry of itself', () => {
    expect(folderEntries(['out/', 'out/reports/', 'out/reports/r.md', 'a.log'], '')).toEqual({ dirs: ['out'], files: ['a.log'] });
    expect(folderEntries(['out/', 'out/reports/', 'out/reports/r.md'], 'out')).toEqual({ dirs: ['out/reports'], files: [] });
  });

  it('marks an ignored file, an ignored folder and everything under one as ignored, and nothing else', () => {
    const state = { ...newTree(), tree: { scopeGen: 1, paths: ['src/a.ts'], ignored: ['out/', 'src/a.log'], more: false } };

    state.ignored.set('out', ['out/deep/']);

    const known = ignoredSet(state);

    expect(['out', 'out/deep', 'out/deep/x.md', 'src/a.log'].every((path) => isIgnored(known, path))).toBe(true);
    expect(['src', 'src/a.ts', 'outer/x', 'src/a.logs'].some((path) => isIgnored(known, path))).toBe(false);
  });

  it("says a base's commits, behind count, pull request and why it is not measured", () => {
    expect(linkInfo(link({ pr: { number: 200, state: 'merged', url: '' }, upstreamMissing: true }))).toBe('1 commit · behind 3 · #200 merged · upstream missing · from local history');
    expect(linkInfo(link({ relation: 'above', lacks: 2, source: 'github-stack', notInClone: true }))).toBe("lacks 2 of this branch's commits · not in this clone");
  });

  it('pins the tree from 1,100 px, never under 720 px, and as the device chose between', () => {
    expect(treePinned(1200, null)).toBe(true);
    expect(treePinned(900, null)).toBe(false);
    expect(treePinned(900, '1')).toBe(true);
    expect(treePinned(1400, '0')).toBe(false);
    expect(treePinned(600, '1')).toBe(false);
    // A phone in landscape is wider than the flyout's limit, yet never pins.
    expect(treePinned(1200, '1', true)).toBe(false);
  });

  it('quotes lines with their file, side and revision, from a whole side or the patch', () => {
    expect(quoteText('a.ts', 2, 3, 'new', 'on disk', ['b', 'c'])).toBe('`a.ts:2-3` (new side, on disk):\n```\nb\nc\n```\n');
    expect(quoteText('a.ts', 4, 4, null, null, ['```'])).toBe('`a.ts:4`:\n````\n```\n````\n');

    const patch = { path: 'a.ts', status: 'M', patch: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +10,3 @@\n keep\n-old\n+new\n tail\n', old: null, new: null, binary: false, tooLarge: null };

    expect(patchLines(patch, 'new', 11, 12)).toEqual(['new', 'tail']);
    expect(patchLines(patch, 'old', 11, 11)).toEqual(['old']);
    expect(patchLines({ ...patch, new: 'one\ntwo\nthree' }, 'new', 2, 3)).toEqual(['two', 'three']);
  });
});

describe('the Changes tree', () => {
  let root: HTMLElement;
  let gets: string[];
  /** What the tree route says git ignores at the top, and each ignored folder's answer, by its path. */
  let ignoredTop: string[];
  let folderAnswers: Map<string, { status: number; body: unknown }>;
  /** Each ignored folder's reads wait on these, in turn, after taking the answer set when they were asked. */
  let folderGates: Map<string, Array<Promise<void>>>;
  /** Holds the file route's answers while set. */
  let fileGate: Promise<void> | null = null;
  let posts: Array<Record<string, unknown>>;
  let stackAnswers: StackData[];
  let pages: Array<{ close(): void }>;
  let viewer: Parameters<DiffModule['mountChanges']>[2] | null = null;
  let stackGates: Array<Promise<void> | undefined> = [];
  const layouts: string[] = [];
  const collapses: Array<[string, boolean]> = [];
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const module: DiffModule = {
    mountDiff: () => null,
    mountFile: (host) => {
      host.textContent = 'file';
      return { set: () => {}, update: () => {}, dispose: () => {} };
    },
    mountChanges: (host, rows, options) => {
      viewer = options;
      host.replaceChildren(...rows.map((one) => options.headerMeta?.(one.path)).filter((one): one is HTMLElement => one != null));
      return { setRows: () => {}, setRow: () => {}, setCollapsed: (path, collapsed) => collapses.push([path, collapsed]), scrollToFile: () => {}, current: () => null, visible: () => ({ first: 0, last: 0 }), onWant: () => {}, heightOf: () => 0, linesFor: () => 1, hunkStarts: () => [], scrollToLine: () => {}, topLine: () => null, set: (layout) => layouts.push(layout), dispose: () => {} };
    },
  };

  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    gets = [];
    ignoredTop = [];
    folderAnswers = new Map();
    folderGates = new Map();
    fileGate = null;
    posts = [];
    stackAnswers = [];
    stackGates = [];
    pages = [];
  });

  afterEach(() => {
    pages.forEach((page) => page.close());
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const start = (width = 1400) => {
    const json = (body: unknown, status = 200) => ({ status, ok: status === 200, headers: new Headers(), json: async () => structuredClone(body) }) as unknown as Response;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      gets.push(url);

      if (url.startsWith('/v1/conversation/stack')) {
        const answer = stackAnswers.shift() ?? STACK;
        const gate = stackGates.shift();

        await gate;
        return json(answer);
      }

      if (url.startsWith('/v1/conversation/tree')) {
        const dir = new URLSearchParams(url.slice(url.indexOf('?'))).get('dir');
        const folder = dir === null ? undefined : folderAnswers.get(dir);

        if (dir !== null) {
          await folderGates.get(dir)?.shift();
          return json(folder?.body ?? { error: 'not shown' }, folder?.status ?? 404);
        }

        return json({ scopeGen: 3, paths: ['README.md', 'src/match/hnsw.ts', 'src/match/pool.ts', 'src/match/pool.bench.ts'], ignored: ignoredTop, more: false });
      }

      if (url.startsWith('/v1/conversation/search')) {
        const params = new URLSearchParams(url.slice(url.indexOf('?')));

        return json({ scopeGen: 3, gen: Number(params.get('gen')), files: [{ path: 'src/match/pool.ts', matches: [{ line: 7, text: 'const pool = exact();' }] }], more: false });
      }

      if (url.startsWith('/v1/conversation/changes')) {
        const params = new URLSearchParams(url.slice(url.indexOf('?')));
        const from = params.get('from') ?? 'base';
        const to = params.get('to') ?? 'worktree';

        return json(from === 'HEAD' ? UNCOMMITTED : { ...LIST, from, to, rows: from === 'base' ? LIST.rows : [{ path: `${to.slice(0, 1)}.ts`, status: 'A', stages: ['committed'], additions: 1, deletions: 0, binary: false, hash: 'x', viewed: false }, ...(to === C3 ? [{ path: 'src/match/pool.ts', status: 'M' as const, stages: ['committed' as const], additions: 1, deletions: 0, binary: false, hash: 'y', viewed: false }] : [])] });
      }

      if (url === '/v1/conversation/viewed') {
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({});
      }

      if (url.startsWith('/v1/conversation/diff')) {
        return json({ path: 'src/match/pool.ts', status: 'M', patch: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n keep();\n', old: null, new: null, binary: false, tooLarge: null, partial: true });
      }

      if (url.startsWith('/v1/conversation/local-file?')) {
        const path = new URLSearchParams(url.slice(url.indexOf('?'))).get('path') ?? '';

        return path.endsWith('/') ? json({ path: `/wt/${path.replace(/\/$/, '')}`, name: 'x', kind: 'dir', contents: null, tooLarge: false, size: null, entries: [], more: false }) : json({ error: 'No such file.' }, 404);
      }

      if (url.startsWith('/v1/conversation/file?')) {
        await fileGate;
        return json({ path: new URLSearchParams(url.slice(url.indexOf('?'))).get('path'), side: 'disk', contents: 'x', binary: false, tooLarge: false });
      }

      return json({});
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, frame: drawAtOnce, now: () => 10_000, loadDiff: async () => module });
    const source = FakeSource.last!;

    pages.push(page);
    window.innerWidth = width;
    window.dispatchEvent(new Event('resize'));
    source.emit('hello', { key: 'pk', groups: [], scope: scope(), sessions: [session], items: [], more: false, status: null, artifacts: [], unread: 0 });
    return { source };
  };
  const openTab = async () => {
    root.querySelector<HTMLElement>('.changes-tab')!.click();
    await flush();
    await flush();
    await flush();
  };
  /** The Files tab, opened from its tab in the column. */
  const openFilesTab = async () => {
    root.querySelector<HTMLElement>('[data-side="files"], [data-tab="files"]')!.click();
    await flush();
    await flush();
    await flush();
  };
  const tree = () => root.querySelector<HTMLElement>('.changes-tree')!;
  const rows = () => [...tree().querySelectorAll<HTMLElement>('.tree-item')].map((one) => [one.querySelector('.tree-label')?.textContent ?? '', one.querySelector('.tree-sub')?.textContent ?? '']);
  const row = (label: string) => [...tree().querySelectorAll<HTMLElement>('.tree-item')].find((one) => one.querySelector('.tree-label')?.textContent === label)!;
  const listGets = () => gets.filter((url) => url.startsWith('/v1/conversation/changes'));

  it('shows the repository, the uncommitted files, this branch’s commits, its base collapsed, a branch above it and main', async () => {
    start();
    await openTab();

    expect(root.querySelector('.diff-view')!.classList.contains('tree-pinned')).toBe(true);
    expect(tree().querySelector('.tree-repo-name')!.textContent).toBe('jessy');
    expect(tree().querySelector('.tree-worktree')!.textContent).toBe('jessy-201worktree · /wt/jessy-201');
    expect(rows()).toEqual([
      ['CHANGES', '2'],
      ['pool.ts', 'src/match'],
      ['README.md', ''],
      ['COMMITS', ''],
      ['202-ui', "lacks 1 of this branch's commits · #202"],
      ['201-exact-scan', 'this branch · 2 commits'],
      ['query the match pool by exact distance', '3 h ago'],
      ['drop HNSW rebuild job', '4 h ago'],
      ['200-match-table', '1 commit · behind 3 · #200'],
      ['main', 'behind 15 · last fetch here 2 h ago'],
    ]);
    expect(row('202-ui').querySelector('[data-action="tree-range"]')).toBeNull();
    // The Changes tab's tree shows the changed files alone: the whole worktree is the Files tab's.
    expect(tree().querySelector('[data-action="tree-files"]')).toBeNull();
    // Reads kept apart from the list: the stack, the files and the uncommitted changes.
    expect(gets).toContain('/v1/conversation/stack?window=pk');
    expect(gets).toContain('/v1/conversation/tree?window=pk');
    expect(listGets()).toContain('/v1/conversation/changes?window=pk&from=HEAD&to=worktree');
  });

  it('opens a base to its commits and a commit to its files, without changing what the diffs compare', async () => {
    start();
    await openTab();

    const before = listGets().length;

    row('200-match-table').querySelector<HTMLElement>('.tree-row')!.click();
    expect(rows().map(([label]) => label)).toContain('add match table');

    row('query the match pool by exact distance').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();
    await flush();
    expect(listGets().slice(before)).toEqual([`/v1/conversation/changes?window=pk&from=${C2}&to=${C3}`]);
    expect(rows().map(([label]) => label)).toContain('3.ts');
    expect(root.querySelector('.changes-scope-label')!.textContent).toBe('All changes');
  });

  it('sets what the diffs compare from a hash, a base’s diff since, FILES’ diff and main’s, keeping the tree', async () => {
    start();
    await openTab();

    row('query the match pool by exact distance').querySelector<HTMLElement>('[data-action="tree-range"]')!.click();
    await flush();
    await flush();
    expect(listGets().at(-1)).toBe(`/v1/conversation/changes?window=pk&from=${C2}&to=${C3}`);
    expect(row('201-exact-scan')).toBeDefined();

    row('200-match-table').querySelector<HTMLElement>('[data-action="tree-range"]')!.click();
    await flush();
    await flush();
    expect(listGets().at(-1)).toBe(`/v1/conversation/changes?window=pk&from=${C1}&to=worktree`);

    row('CHANGES').querySelector<HTMLElement>('[data-action="tree-range"]')!.click();
    await flush();
    expect(root.querySelector('.changes-scope-label')!.textContent).toBe('Uncommitted');

    row('main').querySelector<HTMLElement>('[data-action="tree-range"]')!.click();
    await flush();
    expect(root.querySelector('.changes-scope-label')!.textContent).toBe('All changes');
  });

  it('shows the whole worktree in the Files tab, folders opened one at a time, and opens a file on disk there', async () => {
    start();
    await openTab();
    await openFilesTab();
    expect(rows().slice(1, 3)).toEqual([
      ['src', ''],
      ['README.md', ''],
    ]);
    expect(row('README.md').querySelector('.tree-status')!.textContent).toBe('U');

    row('src').querySelector<HTMLElement>('.tree-row')!.click();
    row('match').querySelector<HTMLElement>('.tree-row')!.click();
    row('hnsw.ts').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();
    await flush();
    expect(gets.at(-1)).toBe('/v1/conversation/file?window=pk&path=src%2Fmatch%2Fhnsw.ts&side=disk&from=HEAD&to=worktree');
    expect(root.querySelector('.file-overlay')).not.toBeNull();
  });

  it('ticks an uncommitted file viewed from the tree for the uncommitted range, and the list to disk follows', async () => {
    start();
    await openTab();
    expect(root.querySelector('.changes-tab .unread-dot')).not.toBeNull();
    row('pool.ts').querySelector<HTMLInputElement>('[data-action="tree-viewed"]')!.click();
    await flush();
    expect(posts).toEqual([expect.objectContaining({ path: 'src/match/pool.ts', hash: 'h-pool', viewed: true, from: 'HEAD', to: 'worktree' })]);
    expect(row('pool.ts').classList.contains('viewed')).toBe(true);
    expect(root.querySelector('.changes-tab .unread-dot')).toBeNull();
  });

  it("ticks a file from the tree as its diff's tick does while the diffs show the uncommitted changes, collapsing it, and keeps the last choice", async () => {
    start();
    await openTab();
    row('CHANGES').querySelector<HTMLElement>('[data-action="tree-range"]')!.click();
    await flush();
    await flush();
    collapses.length = 0;

    const tick = () => row('pool.ts').querySelector<HTMLInputElement>('[data-action="tree-viewed"]')!.click();

    tick();
    tick();
    await flush();
    await flush();
    expect(collapses).toEqual([
      ['src/match/pool.ts', true],
      ['src/match/pool.ts', false],
    ]);
    // Two clicks before the first post answered: one post, then the last choice, in order.
    expect(posts.map((one) => [one['viewed'], one['from'], one['to']])).toEqual([
      [true, 'HEAD', 'worktree'],
      [false, 'HEAD', 'worktree'],
    ]);
    expect(row('pool.ts').classList.contains('viewed')).toBe(false);
  });

  it('filters loaded names and subjects as typed, and searches the text with the options chosen', async () => {
    start();
    await openTab();

    const box = tree().querySelector<HTMLInputElement>('input[data-tree-search]')!;

    box.value = 'hnsw';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rows().map(([label]) => label)).toEqual(['CHANGES', 'COMMITS', '202-ui', '201-exact-scan', 'drop HNSW rebuild job', '200-match-table', 'main']);

    // Text search is the Files tab's, with its own box.
    tree().querySelector<HTMLElement>('[data-action="tree-options"]')!.click();
    expect(tree().querySelector('[data-option="text"]')).toBeNull();
    await openFilesTab();

    const files = tree().querySelector<HTMLInputElement>('input[data-tree-search]')!;

    expect(files.value).toBe('');
    files.value = 'hnsw';
    files.dispatchEvent(new Event('input', { bubbles: true }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    tree().querySelector<HTMLElement>('[data-action="tree-options"]')!.click();
    tree().querySelector<HTMLElement>('[data-option="matchCase"]')!.click();
    tree().querySelector<HTMLElement>('[data-option="text"]')!.click();
    vi.useRealTimers();
    await flush();
    await flush();
    expect(gets.filter((url) => url.startsWith('/v1/conversation/search')).at(-1)).toMatch(/^\/v1\/conversation\/search\?window=pk&gen=\d+&q=hnsw&case=1&word=0&regex=0$/);
    expect(rows()).toEqual([
      ['pool.ts', 'src/match'],
      ['const pool = exact();', '7'],
    ]);

    row('const pool = exact();').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();
    expect(gets.filter((url) => url.startsWith('/v1/conversation/file?')).at(-1)).toBe('/v1/conversation/file?window=pk&path=src%2Fmatch%2Fpool.ts&side=disk&from=HEAD&to=worktree');
  });

  it('keeps the search options in one menu from a button at the box\'s right end, open while choosing, until Escape or a press outside', async () => {
    start();
    await openFilesTab();

    const search = () => tree().querySelector<HTMLElement>('.tree-search')!;
    const button = () => search().querySelector<HTMLButtonElement>('[data-action="tree-options"]')!;
    const menu = () => search().querySelector<HTMLElement>('.tree-options-menu');
    const checked = () => [...menu()!.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].map((item) => [item.dataset['option'], item.getAttribute('aria-checked')]);

    // The box holds the field and the one button, last; no option shows until the menu opens.
    expect([...search().children].map((one) => one.tagName.toLowerCase() + (one.className ? '.' + one.className.split(' ').join('.') : ''))).toEqual(['span.codicon.codicon-search', 'input', 'div.menu-anchor.tree-options']);
    expect(search().querySelector('[data-option]')).toBeNull();
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(button().getAttribute('aria-label')).toBe('Search options');
    expect(button().querySelector('.tree-options-count')).toBeNull();

    button().click();
    await flush();
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect(menu()!.getAttribute('role')).toBe('menu');
    expect([...menu()!.querySelectorAll('.title')].map((one) => one.textContent)).toEqual(['Match case', 'Whole word', 'Regular expression', 'Search the text of every file']);
    expect(checked()).toEqual([
      ['matchCase', 'false'],
      ['word', 'false'],
      ['regex', 'false'],
      ['text', 'false'],
    ]);

    // Choosing an option keeps the menu open, ticks it, and the button counts it without growing.
    menu()!.querySelector<HTMLElement>('[data-option="word"]')!.click();
    await flush();
    menu()!.querySelector<HTMLElement>('[data-option="regex"]')!.click();
    await flush();
    expect(menu()).not.toBeNull();
    expect(checked()).toEqual([
      ['matchCase', 'false'],
      ['word', 'true'],
      ['regex', 'true'],
      ['text', 'false'],
    ]);
    expect(button().classList.contains('active')).toBe(true);
    expect(button().getAttribute('aria-label')).toBe('Search options, 2 on');
    expect(button().querySelector('.tree-options-count')?.textContent).toBe('2');

    // A press inside the menu keeps it; Escape closes it and gives the focus back to the button.
    menu()!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flush();
    expect(menu()).not.toBeNull();
    menu()!.querySelector<HTMLElement>('[data-option="word"]')!.focus();
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button());

    // A press outside closes it too, keeping the options chosen.
    button().click();
    await flush();
    expect(menu()).not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flush();
    expect(menu()).toBeNull();
    expect(button().getAttribute('aria-label')).toBe('Search options, 2 on');

    // Up and Down move along the open menu's rows, from its button too.
    const key = (name: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

    button().click();
    await flush();
    button().focus();
    key('ArrowDown');
    expect((document.activeElement as HTMLElement).dataset['option']).toBe('matchCase');
    key('ArrowDown');
    key('ArrowDown');
    expect((document.activeElement as HTMLElement).dataset['option']).toBe('regex');
    key('ArrowUp');
    expect((document.activeElement as HTMLElement).dataset['option']).toBe('word');

    // In the unpinned tree, as on a phone, Escape closes the menu and leaves the tree open; a second closes the tree.
    key('Escape');
    await flush();
    document.querySelector<HTMLElement>('[data-action="tree-pin"]')!.click();
    await flush();
    document.querySelector<HTMLElement>('[data-action="tree-flyout"]')!.click();
    await flush();
    button().click();
    await flush();
    menu()!.querySelector<HTMLElement>('[data-option="text"]')!.focus();
    key('Escape');
    await flush();
    expect(menu()).toBeNull();
    expect(document.querySelector('.diff-view')!.classList.contains('tree-open')).toBe(true);
    expect(document.activeElement).toBe(button());
    key('Escape');
    await flush();
    expect(document.querySelector('.diff-view')!.classList.contains('tree-open')).toBe(false);

    // The menu left open when the tree closes does not come back with the tree.
    document.querySelector<HTMLElement>('[data-action="tree-flyout"]')!.click();
    await flush();
    button().click();
    await flush();
    document.querySelector<HTMLElement>('[data-action="tree-flyout"]')!.click();
    await flush();
    document.querySelector<HTMLElement>('[data-action="tree-flyout"]')!.click();
    await flush();
    expect(menu()).toBeNull();
  });

  it("lists only an open commit's matching files when the commit is found by a path, and all of them when found by its subject", async () => {
    start();
    await openTab();
    row('query the match pool by exact distance').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();
    await flush();
    expect(rows().map(([label]) => label)).toEqual(expect.arrayContaining(['3.ts', 'pool.ts']));

    const box = tree().querySelector<HTMLInputElement>('input[data-tree-search]')!;
    const commitFiles = () => [...tree().querySelectorAll<HTMLElement>('.tree-row[data-action="tree-file-diff"] .tree-label')].map((one) => one.textContent);

    box.value = 'pool.ts';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(commitFiles()).toEqual(['pool.ts']);

    box.value = 'exact distance';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(commitFiles()).toEqual(['3.ts', 'pool.ts']);
  });

  it("compares a point with one chosen in the picker under the bar, in either order, and Escape closes the picker", async () => {
    start();
    await openTab();

    const menu = (label: string) => row(label).querySelector<HTMLElement>('[data-action="tree-menu"]')!;
    const picker = () => root.querySelector<HTMLElement>('.changes-bar .compare-menu');
    const options = () => [...picker()!.querySelectorAll<HTMLButtonElement>('[data-action="tree-compare-pick"]')].map((one) => [one.querySelector('.scope-text')!.textContent, one.disabled]);

    // From the newer commit: the picker lists every other commit and base, newest first, and the default branch; a base's commit that is its
    // fork point shows once, by the base's name.
    menu('query the match pool by exact distance').click();
    tree().querySelector<HTMLElement>('.tree-menu [data-action="tree-compare"]')!.click();
    expect(picker()!.querySelector('.compare-head')!.textContent).toBe('Compare query the match pool by exact distance with');
    expect(document.activeElement).toBe(picker()!.querySelector('input[data-compare-filter]'));
    expect(options()).toEqual([
      ['drop HNSW rebuild job', false],
      ['200-match-table', false],
      ['main', false],
    ]);

    const filter = picker()!.querySelector<HTMLInputElement>('input[data-compare-filter]')!;

    filter.value = 'hnsw';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    expect(options()).toEqual([['drop HNSW rebuild job', false]]);

    // The older point picked second is the start all the same.
    picker()!.querySelector<HTMLElement>('[data-action="tree-compare-pick"]')!.click();
    await flush();
    await flush();
    expect(listGets().at(-1)).toBe(`/v1/conversation/changes?window=pk&from=${C2}&to=${C3}`);
    expect(picker()).toBeNull();

    menu('drop HNSW rebuild job').click();
    tree().querySelector<HTMLElement>('.tree-menu [data-action="tree-compare"]')!.click();
    expect(picker()).not.toBeNull();
    picker()!.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(picker()).toBeNull();
  });

  it('shows nothing for no base, and says when the stack is incomplete and when GitHub could not be read', async () => {
    stackAnswers.push({ ...STACK, links: [], incomplete: false, github: { state: 'none', observedAt: null } });
    start();
    await openTab();
    // With no base, the tree says nothing of it: no branch name, no default branch, the commits straight under COMMITS.
    expect(tree().textContent).not.toContain('No stacked base');
    expect(tree().querySelectorAll('.tree-item.branch')).toHaveLength(0);
    expect(rows().slice(3).map(([label]) => label)).toEqual(['COMMITS', 'query the match pool by exact distance', 'drop HNSW rebuild job']);
    expect(Number(row('drop HNSW rebuild job').style.getPropertyValue('--depth'))).toBe(1);

    stackAnswers.push({ ...STACK, incomplete: true, github: { state: 'unavailable', observedAt: null, reason: 'The GitHub CLI is not signed in. Run gh auth login.' } });
    root.querySelector<HTMLElement>('[data-action="changes-refresh"]')!.click();
    await flush();
    await flush();
    expect(gets).toContain('/v1/conversation/stack?window=pk&refresh=1');
    expect(tree().textContent).toContain('The stack is incomplete');
    expect(tree().textContent).toContain('GitHub could not be read: The GitHub CLI is not signed in. Run gh auth login..');
  });

  it('asks for the stack once more after GitHub was pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    stackAnswers.push({ ...STACK, github: { state: 'pending', observedAt: null } });
    start();
    root.querySelector<HTMLElement>('.changes-tab')!.click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(gets.filter((url) => url.startsWith('/v1/conversation/stack'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(gets.filter((url) => url.startsWith('/v1/conversation/stack'))).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gets.filter((url) => url.startsWith('/v1/conversation/stack'))).toHaveLength(2);
  });

  it('unpins with the pin and Ctrl+B, kept on the device, and is a flyout under 720 px', async () => {
    start();
    await openTab();

    const view = () => root.querySelector<HTMLElement>('.diff-view')!;

    tree().querySelector<HTMLElement>('[data-action="tree-pin"]')!.click();
    expect(view().classList.contains('tree-pinned')).toBe(false);
    expect(localStorage.getItem('switchboard.changesTreePinned')).toBe('0');
    root.querySelector<HTMLElement>('[data-action="tree-flyout"]')!.click();
    expect(view().classList.contains('tree-open')).toBe(true);

    view().dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
    expect(view().classList.contains('tree-pinned')).toBe(true);
    expect(localStorage.getItem('switchboard.changesTreePinned')).toBe('1');
  });

  it('never pins on a phone, and Escape in the flyout gives the focus to the tree button', async () => {
    localStorage.setItem('switchboard.changesTreePinned', '1');
    // A phone in landscape: a wide window on a screen whose short side is a phone's.
    vi.spyOn(window.screen, 'width', 'get').mockReturnValue(1400);
    vi.spyOn(window.screen, 'height', 'get').mockReturnValue(400);

    try {
      start();
      await openTab();
      expect(root.querySelector('.diff-view')!.classList.contains('tree-pinned')).toBe(false);
      expect(tree().querySelector('[data-action="tree-pin"]')).toBeNull();
      root.querySelector<HTMLElement>('[data-action="tree-flyout"]')!.click();

      const box = tree().querySelector<HTMLInputElement>('input[data-tree-search]')!;

      box.focus();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(root.querySelector('.diff-view')!.classList.contains('tree-open')).toBe(false);
      expect(document.activeElement).toBe(root.querySelector('.changes-bar .changes-tree-button'));
      expect(document.documentElement.classList.contains('phone')).toBe(true);
    } finally {
      document.documentElement.classList.remove('phone');
    }
  });

  it('is a flyout on a narrow tab, whatever the device chose', async () => {
    localStorage.setItem('switchboard.changesTreePinned', '1');
    start(600);
    await openTab();
    expect(root.querySelector('.diff-view')!.classList.contains('tree-pinned')).toBe(false);
    expect(tree().querySelector('[data-action="tree-pin"]')).toBeNull();
    root.querySelector<HTMLElement>('[data-action="tree-flyout"]')!.click();
    expect(root.querySelector('.diff-view')!.classList.contains('tree-open')).toBe(true);
    // A row chosen in the flyout closes it.
    row('pool.ts').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();
    expect(root.querySelector('.diff-view')!.classList.contains('tree-open')).toBe(false);
  });

  it('moves between rows with Up and Down, and opens and closes one with Right and Left', async () => {
    start();
    await openTab();

    const buttons = () => [...tree().querySelectorAll<HTMLElement>('.tree-row')];
    const press = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

    buttons()[0]!.focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(buttons()[1]);
    press('ArrowUp');
    expect(document.activeElement).toBe(buttons()[0]);
    press('ArrowLeft');
    expect(rows().map(([label]) => label)).not.toContain('pool.ts');
    press('ArrowRight');
    expect(rows().map(([label]) => label)).toContain('pool.ts');
  });

  it('keeps Ignore whitespace and the layout in the ⋯ menu, reading the diffs again for whitespace', async () => {
    start();
    await openTab();
    root.querySelector<HTMLElement>('[data-action="changes-more"]')!.click();
    expect([...root.querySelectorAll('.changes-more-menu .scope-text')].map((one) => one.textContent)).toEqual(['Auto', 'Split', 'Stacked', 'Ignore whitespace', 'Hide viewed files', 'Collapse all', 'Expand all', 'Wrap long lines', 'Refresh']);

    root.querySelector<HTMLElement>('[data-action="changes-layout"][data-layout="stacked"]')!.click();
    expect(localStorage.getItem('switchboard.diffLayoutChoice')).toBe('stacked');
    root.querySelector<HTMLElement>('[data-action="changes-whitespace"]')!.click();
    expect(root.querySelector('.changes-more-menu')).toBeNull();
    root.querySelector<HTMLElement>('[data-action="changes-more"]')!.click();
    expect(root.querySelector('[data-action="changes-whitespace"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('reads the diffs again ignoring whitespace, as a held diff of the other mode is not this one', async () => {
    start();
    await openTab();
    await flush();

    const diffs = () => gets.filter((url) => url.startsWith('/v1/conversation/diff'));

    expect(diffs()).toEqual(['/v1/conversation/diff?window=pk&path=src%2Fmatch%2Fpool.ts&sides=0']);
    root.querySelector<HTMLElement>('[data-action="changes-more"]')!.click();
    root.querySelector<HTMLElement>('[data-action="changes-whitespace"]')!.click();
    await flush();
    expect(diffs().at(-1)).toBe('/v1/conversation/diff?window=pk&path=src%2Fmatch%2Fpool.ts&sides=0&ws=ignore');
  });

  it('quotes the lines selected in a diff into the message, with the path, lines, side and revision', async () => {
    start();
    await openTab();
    await flush();
    expect(root.querySelector('[data-action="diff-quote"]')).toBeNull();

    viewer!.onSelect!('src/match/pool.ts', { start: 1, end: 2, side: 'additions' });
    root.querySelector<HTMLElement>('[data-action="diff-quote"]')!.click();
    expect(root.querySelector<HTMLTextAreaElement>('#composer textarea')!.value).toBe('`src/match/pool.ts:1-2` (new side, on disk):\n```\nconst a = 2;\nkeep();\n```\n');

    viewer!.onSelect!(null, null);
    expect(root.querySelector('[data-action="diff-quote"]')).toBeNull();
    // A selection from removed lines into added ones is no one revision's text, so it offers no Quote.
    viewer!.onSelect!('src/match/pool.ts', { start: 1, end: 2, side: 'deletions', endSide: 'additions' });
    expect(root.querySelector('[data-action="diff-quote"]')).toBeNull();
  });

  it("keeps a newer tree read's answer when an older one answers after it", async () => {
    let release: () => void = () => {};

    const { source } = start();

    await openTab();
    stackAnswers.push({ ...STACK, repo: 'older' }, { ...STACK, repo: 'newer' });
    stackGates.push(new Promise<void>((resolve) => (release = resolve)), undefined);
    root.querySelector<HTMLElement>('[data-action="changes-refresh"]')!.click();
    // A turn's end reads again while Refresh's read is on its way.
    source.emit('session', { session: { ...session, state: 'running' } });
    source.emit('session', { session: { ...session, state: 'idle' } });
    await flush();
    await flush();
    expect(tree().querySelector('.tree-repo-name')!.textContent).toBe('newer');
    release();
    await flush();
    await flush();
    expect(tree().querySelector('.tree-repo-name')!.textContent).toBe('newer');
  });

  it("lays the diffs out by their own width beside a pinned tree", async () => {
    start();
    await openTab();

    const pane = root.querySelector<HTMLElement>('.diff-pane')!;
    const host = root.querySelector<HTMLElement>('.diff-view > .diff-host')!;

    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 1300 });
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 880 });
    root.querySelector<HTMLElement>('[data-action="changes-more"]')!.click();
    expect(root.querySelector('.diff-view')!.classList.contains('tree-pinned')).toBe(true);
    expect(layouts.at(-1)).toBe('stacked');
  });

  it('shows the ignored entries the hub lists muted, reads an ignored folder only when it opens, and says why one cannot be read', async () => {
    ignoredTop = ['.wip/', 'out/', 'src/match/pool.log'];
    folderAnswers.set('.wip', { status: 200, body: { scopeGen: 3, dir: '.wip', paths: [], ignored: ['.wip/artifacts/', '.wip/notes.md'], more: false } });
    folderAnswers.set('.wip/artifacts', { status: 200, body: { scopeGen: 3, dir: '.wip/artifacts', paths: [], ignored: [], more: false } });
    folderAnswers.set('out', { status: 404, body: { error: 'out is not an ignored folder Explore shows in this worktree.' } });
    start();
    await openTab();
    await openFilesTab();

    const folderReads = () => gets.filter((url) => url.includes('&dir='));
    const muted = () => [...tree().querySelectorAll<HTMLElement>('.tree-item.ignored')].map((one) => one.querySelector('.tree-label')!.textContent);

    expect(rows().slice(1, 5).map(([label]) => label)).toEqual(['.wip', 'out', 'src', 'README.md']);
    expect(muted()).toEqual(['.wip', 'out']);
    expect(row('src').classList.contains('ignored')).toBe(false);
    expect(folderReads()).toEqual([]);

    row('.wip').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();
    await flush();
    expect(folderReads()).toEqual(['/v1/conversation/tree?window=pk&dir=.wip']);
    expect(muted()).toEqual(['.wip', 'artifacts', 'notes.md', 'out']);
    expect(row('notes.md').querySelector('.tree-row')!.getAttribute('data-action')).toBe('tree-disk');

    // Closing and opening again reads nothing more; an empty folder says so.
    row('.wip').querySelector<HTMLElement>('.tree-row')!.click();
    row('.wip').querySelector<HTMLElement>('.tree-row')!.click();
    row('artifacts').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();
    await flush();
    expect(folderReads()).toEqual(['/v1/conversation/tree?window=pk&dir=.wip', '/v1/conversation/tree?window=pk&dir=.wip%2Fartifacts']);
    expect(tree().textContent).toContain('Empty folder.');

    row('out').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();
    await flush();
    expect(tree().querySelector('.tree-note.error')!.textContent).toBe('out is not an ignored folder Explore shows in this worktree.');

    // An ignored file in a listed folder is muted too; the name filter leaves out what git ignores, as VS Code's file search does.
    row('src').querySelector<HTMLElement>('.tree-row')!.click();
    row('match').querySelector<HTMLElement>('.tree-row')!.click();
    expect(row('pool.log').classList.contains('ignored')).toBe(true);
    expect(row('pool.ts').classList.contains('ignored')).toBe(false);

    const box = tree().querySelector<HTMLInputElement>('input[data-tree-search]')!;

    box.value = 'pool';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rows().slice(1).map(([label]) => label)).toEqual(['pool.ts', 'pool.bench.ts']);
  });

  it("keeps Refresh's read of an open ignored folder when an older read of it answers first", async () => {
    const releases: Array<() => void> = [];
    const gate = () => new Promise<void>((done) => releases.push(done));

    ignoredTop = ['.wip/'];
    folderAnswers.set('.wip', { status: 200, body: { scopeGen: 3, dir: '.wip', paths: [], ignored: ['.wip/old.md'], more: false } });
    folderGates.set('.wip', [gate(), gate()]);
    start();
    await openTab();
    await openFilesTab();
    row('.wip').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();

    folderAnswers.set('.wip', { status: 200, body: { scopeGen: 3, dir: '.wip', paths: [], ignored: ['.wip/new.md'], more: false } });
    root.querySelector<HTMLElement>('[data-action="changes-refresh"]')!.click();
    for (let i = 0; i < 6; i++) await flush();
    expect(gets.filter((url) => url.includes('&dir=.wip'))).toHaveLength(2);

    // The first read answers first and is dropped; the folder waits for Refresh's.
    releases[0]!();
    for (let i = 0; i < 4; i++) await flush();
    expect(row('old.md')).toBeUndefined();

    releases[1]!();
    for (let i = 0; i < 4; i++) await flush();
    expect(row('new.md')).toBeDefined();
    expect(row('old.md')).toBeUndefined();
  });

  it('indents each nested row past its parent, with a branch row’s chevron before its icon', async () => {
    start();
    await openTab();
    row('200-match-table').querySelector<HTMLElement>('.tree-row')!.click();
    row('add match table').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();
    await flush();

    const depth = (label: string) => Number(row(label).style.getPropertyValue('--depth'));

    expect(['COMMITS', '201-exact-scan', 'drop HNSW rebuild job'].map(depth)).toEqual([0, 1, 2]);
    expect(['200-match-table', 'add match table', '1.ts'].map(depth)).toEqual([1, 2, 3]);

    const branch = row('201-exact-scan').querySelector('.tree-row')!;

    expect([...branch.children].map((one) => one.className).slice(0, 2)).toEqual(['tree-twisty codicon codicon-chevron-down', 'codicon codicon-git-branch tree-branch-icon']);

    await openFilesTab();
    row('src').querySelector<HTMLElement>('.tree-row')!.click();
    row('match').querySelector<HTMLElement>('.tree-row')!.click();
    expect(['FILES', 'src', 'match', 'pool.ts'].map(depth)).toEqual([0, 1, 2, 3]);

    // A file's icon sits in the twisty's room, so its name starts where a sibling folder's does, not one icon further in.
    expect(row('README.md').firstElementChild!.matches('.tree-twisty')).toBe(true);
    expect(row('README.md').querySelector(':scope > .tree-twisty > .codicon, :scope > .tree-twisty > [class]')).not.toBeNull();
    expect(row('README.md').querySelector(':scope > .tree-row > .tree-label')!.previousElementSibling).toBeNull();
  });


  it('keeps the bar and its tree button in reach while a file shows, so one click opens the tree again', async () => {
    start(900);
    await openTab();
    root.querySelector<HTMLElement>('[data-action="tree-flyout"]')!.click();
    await openFilesTab();
    row('README.md').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();
    await flush();

    const overlay = root.querySelector<HTMLElement>('.file-overlay')!;
    const bar = root.querySelector<HTMLElement>('.changes-bar')!;

    expect(root.querySelector('.diff-view')!.classList.contains('tree-open')).toBe(false);
    expect(overlay.style.top).toBe(`${bar.offsetHeight}px`);
    expect(overlay.contains(bar)).toBe(false);
    bar.querySelector<HTMLElement>('[data-action="tree-flyout"]')!.click();
    expect(root.querySelector('.diff-view')!.classList.contains('tree-open')).toBe(true);
  });

  it('filters commits by the paths they change too, opening a base to show its matching commit', async () => {
    start();
    await openTab();

    const box = tree().querySelector<HTMLInputElement>('input[data-tree-search]')!;

    box.value = '0042_match';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rows().map(([label]) => label)).toEqual(['CHANGES', 'COMMITS', '202-ui', '201-exact-scan', '200-match-table', 'add match table', 'main']);

    box.value = 'pool.ts';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rows().map(([label]) => label)).toEqual(['CHANGES', 'pool.ts', 'COMMITS', '202-ui', '201-exact-scan', 'query the match pool by exact distance', '200-match-table', 'main']);
  });

  it('goes back from a file to the diffs first, then from a range to every change, with the one back in the bar', async () => {
    start();
    await openTab();
    row('query the match pool by exact distance').querySelector<HTMLElement>('[data-action="tree-range"]')!.click();
    await flush();
    await flush();
    // A file of the commit's old side is a revision, which the Changes tab shows over its diffs.
    viewer!.onLine!('src/match/pool.ts', 'old', 1);
    await flush();

    const back = () => root.querySelector<HTMLElement>('.changes-bar [data-action="changes-back"]');

    expect(back()!.getAttribute('aria-label')).toBe('Back to the diffs');
    // Back starts the bar for a file and for a range alike, after only the tree's button while the tree is not pinned.
    const actions = () => [...root.querySelectorAll<HTMLElement>('.changes-bar [data-action]')].map((one) => one.dataset['action']);

    expect(actions()[0]).toBe('changes-back');
    tree().querySelector<HTMLElement>('[data-action="tree-pin"]')!.click();
    expect(actions().slice(0, 2)).toEqual(['tree-flyout', 'changes-back']);
    back()!.click();
    expect(actions().slice(0, 3)).toEqual(['tree-flyout', 'changes-back', 'changes-menu']);
    expect(root.querySelector('.file-overlay')).toBeNull();
    expect(root.querySelector('.changes-scope-label')!.textContent).toBe('3333333 query the match pool by exact distance');
    expect(back()!.getAttribute('aria-label')).toBe('Back to every change since the base');
    back()!.click();
    await flush();
    expect(root.querySelector('.changes-scope-label')!.textContent).toBe('All changes');
    expect(back()).toBeNull();
  });

  it('FilesTab_DiskReadPendingWhileTheChangesRangeChanges_StillShowsTheFile', async () => {
    let release: () => void = () => {};

    start();
    await openTab();
    await openFilesTab();
    fileGate = new Promise<void>((done) => (release = done));
    row('README.md').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();
    await openTab();
    row('query the match pool by exact distance').querySelector<HTMLElement>('[data-action="tree-range"]')!.click();
    await flush();
    release();
    for (let i = 0; i < 4; i++) await flush();
    await openFilesTab();
    expect(root.querySelector('.files-view .file-overlay')).not.toBeNull();
    expect(root.querySelector('.files-view .file-overlay')!.textContent).not.toContain('Reading the file');
  });

  it('FilesTab_TextSearchAnsweredAfterTheChangesTabShows_FillsTheFilesTree', async () => {
    start();
    await openFilesTab();
    tree().querySelector<HTMLElement>('[data-action="tree-options"]')!.click();
    tree().querySelector<HTMLElement>('[data-option="text"]')!.click();
    await flush();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const box = tree().querySelector<HTMLInputElement>('input[data-tree-search]')!;

    box.value = 'pool';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLElement>('.changes-tab')!.click();
    vi.advanceTimersByTime(300);
    vi.useRealTimers();
    for (let i = 0; i < 4; i++) await flush();
    // The Changes tree took none of it.
    expect(rows().map(([label]) => label)).not.toContain('const pool = exact();');
    await openFilesTab();
    expect(rows().map(([label]) => label)).toContain('const pool = exact();');
  });

  it('FilesTab_DiffOfAFileTheShownRangeLacks_ShowsItInTheUncommittedChanges', async () => {
    start();
    await openTab();
    row('query the match pool by exact distance').querySelector<HTMLElement>('[data-action="tree-range"]')!.click();
    await flush();
    await flush();
    await openFilesTab();
    row('README.md').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();
    root.querySelector<HTMLElement>('.changes-bar [data-action="file-diff"]')!.click();
    await flush();
    await flush();
    expect(root.querySelector('.changes-scope-label')!.textContent).toBe('Uncommitted');
    // A file no list changes offers no Diff.
    await openFilesTab();
    row('src').querySelector<HTMLElement>('.tree-row')!.click();
    row('match').querySelector<HTMLElement>('.tree-row')!.click();
    row('hnsw.ts').querySelector<HTMLElement>('.tree-row')!.click();
    await flush();
    expect(root.querySelector('.changes-bar [data-action="file-diff"]')).toBeNull();
  });

  it('FolderLink_IntoAnIgnoredFolder_ReadsEachFolderOnTheWayAndFocusesIt', async () => {
    ignoredTop = ['.wip/'];
    folderAnswers.set('.wip', { status: 200, body: { scopeGen: 3, dir: '.wip', paths: [], ignored: ['.wip/artifacts/', '.wip/notes.md'], more: false } });
    folderAnswers.set('.wip/artifacts', { status: 200, body: { scopeGen: 3, dir: '.wip/artifacts', paths: [], ignored: ['.wip/artifacts/plan.md'], more: false } });
    start();
    root.querySelector('#panel')!.insertAdjacentHTML('beforeend', '<a class="path-link" data-action="local-file" data-target=".wip/artifacts/">artifacts</a>');
    root.querySelector<HTMLElement>('#panel a.path-link[data-target=".wip/artifacts/"]')!.click();
    for (let i = 0; i < 8; i++) await flush();
    expect(gets.filter((url) => url.includes('&dir='))).toEqual(['/v1/conversation/tree?window=pk&dir=.wip', '/v1/conversation/tree?window=pk&dir=.wip%2Fartifacts']);
    expect((document.activeElement as HTMLElement | null)?.dataset['key']).toBe('dir:.wip/artifacts');
    expect(row('plan.md')).toBeDefined();
  });
});
