import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPage } from '../src/main.js';
import { renderListHeader } from '../src/listHeader.js';
import type { PageGroup, PageHeader, PageRow, SourceGroup } from '../src/types.js';

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

const listRow = (workItemId: number, patch: Partial<PageRow> = {}): PageRow => ({ workItemId, title: `Item ${workItemId}`, priority: null, time: null, ticket: `gh ${workItemId}`, sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, ...patch });
const listGroup = (key: string, rows: PageRow[], patch: Partial<PageGroup> = {}): PageGroup => ({ key, title: key, glyph: '\u{ea70}', empty: null, rows, ...patch });
const github: SourceGroup = { kind: 'github', enabled: true, title: 'gh: polled\nClick to stop polling gh', sources: [{ name: 'gh', enabled: true }] };
const zoho: SourceGroup = { kind: 'zoho', enabled: true, title: 'desk: polled\nhelp: not polled\nClick to choose', sources: [{ name: 'desk', enabled: true }, { name: 'help', enabled: false }] };
const header = (patch: Partial<PageHeader> = {}): PageHeader => ({ sources: [github, zoho], ...patch });

describe('the list header (architecture.md § Web page)', () => {
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let answers: Record<string, { status: number; body: unknown }>;
  let root: HTMLElement;

  beforeEach(() => {
    posts = [];
    answers = {};
    root = document.createElement('div');
    document.body.replaceChildren(root);
    localStorage.clear();
    history.replaceState(null, '', '#');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const start = () => {
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });

      const name = Object.keys(answers).find((one) => url.endsWith(one));
      const answer = name === undefined ? { status: 200, body: {} } : answers[name]!;

      return { status: answer.status, ok: answer.status === 200, json: async () => answer.body, text: async () => '' } as unknown as Response;
    });
    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000 });

    return { page, source: FakeSource.last! };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const click = (selector: string) => root.querySelector<HTMLElement>(selector)!.click();
  const hello = (source: FakeSource, patch: Record<string, unknown> = {}) => source.emit('hello', { key: 'pk', groups: [listGroup('progress', [listRow(1)])], header: header(), scope: null, ...patch });

  it("draws each source kind's logo as the dock does, grey while off, with the hub's tooltip, and a tag for a kind without a logo", () => {
    const host = document.createElement('div');

    host.innerHTML = renderListHeader(header({ sources: [github, { ...zoho, enabled: false }, { kind: 'jira', enabled: true, title: 'jira: polled', sources: [{ name: 'jira', enabled: true }] }] }), { menu: null, notice: null });

    const buttons = [...host.querySelectorAll<HTMLElement>('.source-toggle')];

    expect(host.querySelector('.list-title')?.textContent).toBe('Switchboard');
    expect(buttons.map((one) => one.getAttribute('aria-label'))).toEqual(['gh', 'zoho', 'jira']);
    expect(buttons[0]!.title).toBe('gh: polled\nClick to stop polling gh');
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1]!.getAttribute('aria-haspopup')).toBe('menu');
    expect(buttons[0]!.querySelector('svg.source-logo.github:not(.off)')).not.toBeNull();
    expect(buttons[1]!.querySelector('svg.source-logo.zoho.off')).not.toBeNull();
    expect(buttons[2]!.querySelector('.codicon-tag.source-logo')).not.toBeNull();
    // No sources, no icons.
    host.innerHTML = renderListHeader({ sources: [] }, { menu: null, notice: null });
    expect(host.querySelector('.header-sources')).toBeNull();
  });

  it("turns a kind's one source on or off with a click, opens a check menu for several that stays open, and shows a refusal under the header", async () => {
    const { page, source } = start();

    hello(source);
    click('.source-toggle[data-kind="github"]');
    await flush();
    expect(posts.at(-1)).toMatchObject({ url: '/v1/conversation/page-source', body: { window: 'pk', name: 'gh', enabled: false } });
    expect(root.querySelector('.source-menu')).toBeNull();

    click('.source-toggle[data-kind="zoho"]');
    expect([...root.querySelectorAll('.source-menu .menu-row')].map((row) => [row.textContent, row.getAttribute('aria-checked')])).toEqual([['desk', 'true'], ['help', 'false']]);
    click('.source-menu [data-source="help"]');
    await flush();
    expect(posts.at(-1)?.body).toMatchObject({ name: 'help', enabled: true });
    // The menu stays open, and its check follows the hub's next list.
    source.emit('list', { groups: [listGroup('progress', [listRow(1)])], header: header({ sources: [github, { ...zoho, sources: [{ name: 'desk', enabled: true }, { name: 'help', enabled: true }] }] }) });
    expect(root.querySelector('.source-menu [data-source="help"]')?.getAttribute('aria-checked')).toBe('true');

    answers['/page-source'] = { status: 409, body: { error: 'No source is named help.' } };
    click('.source-menu [data-source="help"]');
    await flush();
    await flush();
    expect(root.querySelector('.list-notice')?.textContent).toBe('No source is named help.');
    click('[data-action="list-dismiss"]');
    expect(root.querySelector('.list-notice')).toBeNull();

    // Escape closes the menu and gives the focus back to its icon; a press outside closes it too.
    root.querySelector<HTMLElement>('.source-menu .menu-row')!.focus();
    root.querySelector('.source-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.source-menu')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('.source-toggle[data-kind="zoho"]'));
    click('.source-toggle[data-kind="zoho"]');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root.querySelector('.source-menu')).toBeNull();
    page.close();
  });
});
