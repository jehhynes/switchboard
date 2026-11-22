import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listBase, listNote, rowTitle } from '../src/changes.js';
import type { ChangesList } from '../src/changes.js';
import { diffLayout, diffNote } from '../src/changes.js';
import type { DiffModule } from '../src/diff/types.js';
import { startPage } from '../src/main.js';
import type { PageRow } from '@switchboard/protocol';

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
    { path: 'docs/a.md', status: 'M', stages: ['committed', 'working'], additions: 3, deletions: 1, binary: false, hash: 'h-a', viewed: false },
    { path: 'src/new.ts', from: 'src/old.ts', status: 'R', stages: ['staged'], additions: 0, deletions: 0, binary: false, hash: 'h-new', viewed: true },
    { path: 'logo.png', status: 'U', stages: ['untracked'], additions: null, deletions: null, binary: true, hash: 'h-logo', viewed: false },
  ],
  stages: { committed: 1, staged: 1, working: 1, untracked: 1 },
  shown: 3,
  total: 3,
};

const listRow = (patch: Partial<PageRow> = {}): PageRow => ({ workItemId: 1, ticketId: null, title: 'Fix it', priority: null, time: null, ticket: 'gh 1', sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], terminal: false, band: null, voice: null, history: null, ...patch });
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
  /** What each mountChanges was given and asked, and the rows the fake view says are on screen. */
  type FakeChanges = { header: (path: string) => void; meta: (path: string) => HTMLElement | null; rows: string[]; layout: string; wrap: boolean; layouts: string[]; scrolls: string[]; sets: Array<[string, string]>; collapsed: string[]; disposed: boolean; onLine?: (path: string, side: 'old' | 'new', line: number) => void; loadSides: (path: string) => Promise<unknown>; want: () => void };
  const changesMounts: FakeChanges[] = [];
  let visible: { first: number; last: number } | null;
  let etags: Record<string, () => string>;
  let notModified: Set<string>;
  let ifNoneMatch: string[];

  beforeEach(() => {
    mounts.length = 0;
    changesMounts.length = 0;
    visible = { first: 0, last: 0 };
    etags = {};
    notModified = new Set();
    ifNoneMatch = [];
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
        const shown = document.createElement('span');

        files.push({ path: data.path, side: data.side, line: options.line });
        shown.className = 'fake';
        shown.textContent = `file ${data.path} at ${String(options.line)}`;
        host.replaceChildren(...(options.prefix === undefined ? [] : [options.prefix]), shown, ...(options.suffix === undefined ? [] : [options.suffix]));
        return { set: (layout, wrap) => fileSets.push(`${layout} ${wrap}`), dispose: () => {} };
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
          current: () => null,
          visible: () => visible,
          onWant: (listener) => listeners.push(listener),
          heightOf: () => 100,
          linesFor: () => 3,
          set: (layout, wrap) => fake.layouts.push(`${layout} ${wrap}`),
          dispose: () => (fake.disposed = true),
        };
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

      if (url === '/v1/conversation/viewed') {
        const sent = JSON.parse(String((init as { body?: string } | undefined)?.body)) as Record<string, unknown>;

        gets.push(`VIEWED ${String(sent['path'])} ${String(sent['hash'])} ${String(sent['viewed'])} ${String(sent['scopeGen'])}`);
        return (sent['path'] === 'logo.png'
          ? { status: 409, ok: false, json: async () => ({ error: 'logo.png changed since it was shown; read it again.' }) }
          : { status: 200, ok: true, json: async () => ({ path: sent['path'], hash: sent['hash'], viewed: sent['viewed'] }) }) as unknown as Response;
      }

      if (url === '/v1/conversation/row-command') {
        gets.push(`POST ${String((init as { body?: string } | undefined)?.body)}`);
        return { status: 200, ok: true, json: async () => ({}) } as unknown as Response;
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
    expect(root.querySelector('.changes-note')!.textContent).toBe('3 files · +3 −1 · 1 viewed');
    expect(root.querySelector<HTMLElement>('.changes-note')!.title).toBe('Since 0123456');
    expect([...root.querySelectorAll<HTMLInputElement>('.change-viewed input')].map((box) => box.checked)).toEqual([false, true, false]);
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
    await flush();
  };
  const diffGets = () => gets.filter((one) => one.startsWith('/v1/conversation/diff'));

  it('ChangesTab_PickingARow_OpensOneTabScrolledToThatFileWithNothingAboveTheDiffs', async () => {
    start();
    await openRow(1);

    expect(root.querySelector('.changes-menu')).toBeNull();
    expect([...root.querySelectorAll('.diff-tab .tab-label')].map((one) => one.textContent)).toEqual(['Changes']);
    expect(root.querySelector('.diff-tab .tab-badge')!.textContent).toBe('1/3');
    expect(root.querySelector('.diff-tab')!.classList.contains('selected')).toBe(true);
    expect(changesMounts).toHaveLength(1);
    expect(changesMounts[0]!.rows).toEqual(['docs/a.md', 'src/new.ts', 'logo.png']);
    expect(changesMounts[0]!.scrolls).toEqual(['src/new.ts']);
    // A phone's width (test/setup.ts): stacked and wrapped.
    expect(changesMounts[0]).toMatchObject({ layout: 'stacked', wrap: true });
    // Nothing above the diffs: the view holds the viewer's host alone, and each file's own header carries only its Viewed tick from the page.
    expect([...root.querySelector('.diff-view')!.children].map((one) => one.className)).toEqual(['diff-host']);
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
    expect(root.querySelector('.diff-tab .tab-badge')!.textContent).toBe('2/3');
    expect(root.querySelectorAll<HTMLInputElement>('.diff-host .diff-viewed input')[0]!.checked).toBe(true);

    // Picking another row scrolls the same tab.
    await openRow(0);
    expect(changesMounts).toHaveLength(1);
    expect(changesMounts[0]!.scrolls).toEqual(['src/new.ts', 'docs/a.md']);

    // Closing the tab ends the viewer and goes back to the conversation.
    root.querySelector<HTMLElement>('.diff-tab .tab-close')!.click();
    await flush();
    expect(root.querySelector('.diff-tab')).toBeNull();
    expect(root.querySelector('.diff-view')).toBeNull();
    expect(changesMounts[0]!.disposed).toBe(true);
  });

  it('ChangesTab_ForTheFilesInView_ReadsEachPatchAloneAndDrawsItOrWhyNot', async () => {
    diffAnswers['src/new.ts'] = { status: 404, body: { error: 'src/new.ts is not one of the changes now.' } };
    diffAnswers['logo.png'] = { status: 200, body: { path: 'logo.png', status: 'U', patch: null, old: null, new: null, binary: true, tooLarge: null, partial: true } };
    start();
    await openRow(0);
    await flush();

    // The first row on screen and two ahead.
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
    // On screen 0 to 2, two ahead: five wanted, three read at once.
    expect(diffGets()).toHaveLength(3);

    // Scrolled far down before they answer: the rows wanted then are read next, never the ones left behind.
    visible = { first: 9, last: 9 };
    changesMounts[0]!.want();
    release();
    for (let index = 0; index < 8; index++) {
      await flush();
    }

    expect(diffGets().map((one) => /path=([^&]*)/.exec(one)![1])).toEqual(['f0.ts', 'f1.ts', 'f2.ts', 'f9.ts', 'f10.ts', 'f11.ts', 'f8.ts']);
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
    expect(changesMounts[0]!.collapsed).toEqual(['docs/a.md true']);
    expect(chevron('docs/a.md').getAttribute('aria-expanded')).toBe('false');
    expect(chevron('docs/a.md').querySelector('.codicon-chevron-right')).not.toBeNull();
    chevron('docs/a.md').click();
    expect(changesMounts[0]!.collapsed).toEqual(['docs/a.md true', 'docs/a.md false']);
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

  it('ChangesMenu_Buttons_HideViewedCollapseAndExpandEveryFile', async () => {
    start();
    await openRow(0);
    button().click();
    await flush();
    root.querySelector<HTMLElement>('[data-action="changes-hide-viewed"]')!.click();
    expect(changesMounts[0]!.rows).toEqual(['docs/a.md', 'logo.png']);
    expect(root.querySelector('[data-action="changes-hide-viewed"]')!.getAttribute('aria-pressed')).toBe('true');
    root.querySelector<HTMLElement>('[data-action="changes-collapse-all"]')!.click();
    expect(changesMounts[0]!.collapsed).toEqual(['docs/a.md true', 'logo.png true']);
    root.querySelector<HTMLElement>('[data-action="changes-expand-all"]')!.click();
    expect(changesMounts[0]!.collapsed.slice(2)).toEqual(['docs/a.md false', 'logo.png false']);

    // Picking a hidden viewed file shows the viewed files again.
    root.querySelectorAll<HTMLElement>('.change-row')[1]!.click();
    await flush();
    expect(changesMounts[0]!.rows).toEqual(['docs/a.md', 'src/new.ts', 'logo.png']);
  });

  it("ChangesTab_LineNumberClicked_ShowsTheFileOverTheDiffsAndBackKeepsThem", async () => {
    start();
    await openRow(1);
    changesMounts[0]!.onLine!('src/new.ts', 'new', 12);
    await flush();
    await flush();
    expect(gets.at(-1)).toBe('/v1/conversation/file?window=pk&path=src%2Fnew.ts&side=disk');
    expect(files.at(-1)).toEqual({ path: 'src/new.ts', side: 'disk', line: 12 });
    // The file's own header has the way back before its name and the line after it; nothing sits above it.
    expect(root.querySelector('.file-overlay .fake')!.textContent).toBe('file src/new.ts at 12');
    expect(root.querySelector('.file-overlay .diff-at')!.textContent).toBe(':12');
    expect(root.querySelector('.file-overlay .diff-head')).toBeNull();
    expect(root.querySelector('[data-action="diff-open-vscode"]')).toBeNull();

    root.querySelector<HTMLElement>('.file-overlay [data-action="diff-back"]')!.click();
    await flush();
    expect(root.querySelector('.file-overlay')).toBeNull();
    expect(changesMounts).toHaveLength(1);
    expect(changesMounts[0]!.disposed).toBe(false);

    // The old side's line opens the file at the base, by its old name.
    changesMounts[0]!.onLine!('src/new.ts', 'old', 3);
    await flush();
    await flush();
    expect(files.at(-1)).toEqual({ path: 'src/old.ts', side: 'base', line: 3 });
    expect(root.querySelector('.file-overlay .diff-at')!.textContent).toBe(':3 at the base');
  });

  it('offers the way back from a file view before the viewer draws its header', async () => {
    start();
    await openRow(1);
    changesMounts[0]!.onLine!('src/new.ts', 'new', 12);
    expect(root.querySelector('.file-overlay .empty')!.textContent).toBe('Reading the file…');
    expect(root.querySelector('.file-overlay .empty [data-action="diff-back"]')).not.toBeNull();
  });

  it('lays the diffs out as the settings say, and again when they change', async () => {
    const { source } = start();

    source.emit('settings', { settings: { expandReplies: false, diffLayout: 'split', diffWrap: 'on' } });
    await openRow(0);
    expect(root.querySelector('[data-action="diff-layout"], [data-action="diff-wrap"]')).toBeNull();
    expect(changesMounts[0]).toMatchObject({ layout: 'split', wrap: true });

    source.emit('settings', { settings: { expandReplies: false, diffLayout: 'stacked', diffWrap: 'off' } });
    expect(changesMounts[0]!.layouts.at(-1)).toBe('stacked false');
  });

  it("offers the work item's Open in VS Code in the menu's head while its row does, which the header's control runs", async () => {
    const { source } = start();

    button().click();
    await flush();
    expect(root.querySelector('.changes-open')).toBeNull();

    source.emit('list', { groups: [{ key: 'progress', title: 'progress', glyph: '', empty: null, rows: [listRow({ opens: [{ label: 'Open in VS Code', icon: 'vscode' }] })] }] });
    const open = root.querySelector<HTMLElement>('.changes-menu .changes-open')!;

    expect(open.dataset['action']).toBe('row-command');
    expect(open.dataset['label']).toBe('Open in VS Code');
    open.click();
    await flush();
    expect(JSON.parse(gets.at(-1)!.slice('POST '.length))).toMatchObject({ window: 'pk', scopeGen: 3, workItemId: 1, label: 'Open in VS Code' });
    expect(root.querySelector('.changes-menu')).toBeNull();
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

  it('ticks a file viewed at the hash it was shown with, follows another device, and takes back a refused tick', async () => {
    const { source } = start();

    button().click();
    await flush();
    root.querySelectorAll<HTMLElement>('.change-viewed input')[0]!.click();
    await flush();
    expect(gets.at(-1)).toBe('VIEWED docs/a.md h-a true 3');
    expect(root.querySelectorAll<HTMLInputElement>('.change-viewed input')[0]!.checked).toBe(true);
    // Ticking does not open the Changes tab.
    expect(root.querySelector('.diff-tab')).toBeNull();

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
    expect(gets.slice(before)).toEqual(['VIEWED logo.png h-logo true 3', '/v1/conversation/changes?window=pk']);
  });

  it('sends a file\'s ticks one at a time, ending on the last click', async () => {
    start();
    button().click();
    await flush();

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
    expect(root.querySelector('.diff-tab')).toBeNull();
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

  it('says the file count, the lines changed, the viewed count and a cut list, and the base in its tooltip', () => {
    expect(listNote(LIST)).toBe('3 files · +3 −1 · 1 viewed');
    expect(listNote({ ...LIST, shown: 400, total: 512 })).toBe('first 400 of 512 files · +3 −1 · 1 viewed');
    expect(listNote({ ...LIST, total: 1 })).toBe('1 file · +3 −1 · 1 viewed');
    expect(listBase(LIST)).toBe('Since 0123456');
    expect(listBase({ ...LIST, base: null })).toBe('Uncommitted changes only, no merge base');
  });

  it("names a row's stages in its tooltip", () => {
    expect(listNote({ ...LIST, rows: LIST.rows.map((row) => ({ ...row, viewed: false })) })).toBe('3 files · +3 −1');
    expect(rowTitle(LIST.rows[0]!)).toBe('docs/a.md\nModified · committed, unstaged');
    expect(rowTitle({ ...LIST.rows[0]!, stages: [] })).toBe('docs/a.md\nModified');
  });
});