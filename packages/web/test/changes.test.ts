import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listNote, rowTitle } from '../src/changes.js';
import type { ChangesList } from '../src/changes.js';
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
  const start = () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('/v1/conversation/changes')) {
        gets.push(url);
      }

      const answer = url.startsWith('/v1/conversation/changes') ? (answers.shift() ?? { status: 200, body: LIST }) : { status: 200, body: {} };

      await answer.wait;

      return { status: answer.status, ok: answer.status === 200, json: async () => answer.body } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });
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
});

describe('the Changes list text', () => {
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
