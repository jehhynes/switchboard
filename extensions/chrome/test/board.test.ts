import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_MS, applySnoozed, issueKey, watchBoard } from '../src/board.js';
import type { BoardWatch } from '../src/board.js';

const COLUMN = readFileSync(join(import.meta.dirname, 'fixtures', 'column.html'), 'utf8');

/** Two columns from the recorded fixture: Paused and a copy named Later. */
function board(): void {
  document.body.innerHTML = COLUMN + COLUMN.replace('data-board-column="Paused"', 'data-board-column="Later"');
}

const column = (name: string) => document.querySelector<HTMLElement>(`[data-board-column="${name}"]`)!;
const hiddenIds = (name: string) => [...column(name).querySelectorAll('[data-switchboard-snoozed]')].map((card) => card.getAttribute('data-board-card-id'));
const list = (name: string) => column(name).querySelector('[data-dnd-drop-type="card"]')!;
const toggle = (name: string) => list(name).querySelector<HTMLButtonElement>(':scope > .switchboard-snoozed-toggle');

describe('issueKey', () => {
  it('reads a GitHub issue URL in lower case and refuses other URLs', () => {
    expect(issueKey('https://github.com/Acme/widgets/issues/15619')).toBe('acme/widgets#15619');
    expect(issueKey('https://github.com/o/r/issues/7/?x=1#c')).toBe('o/r#7');
    expect(issueKey('https://github.com/o/r/pull/7')).toBeNull();
    expect(issueKey('https://github.com/o/r/issues/7/files')).toBeNull();
    expect(issueKey('https://gitlab.com/o/r/issues/7')).toBeNull();
    expect(issueKey('https://desk.example.test/tickets/7')).toBeNull();
    expect(issueKey('not a url')).toBeNull();
  });
});

describe('applySnoozed', () => {
  beforeEach(board);

  it('marks only the snoozed cards and adds a Show button after the last card of their column', () => {
    applySnoozed(document, new Set(['github/roadmap#1035', 'github/roadmap#1153']), new Set(), () => {});

    expect(hiddenIds('Paused')).toEqual(['88050488', '126571572']);
    expect(hiddenIds('Later')).toEqual(['88050488', '126571572']);
    expect(column('Paused').hasAttribute('data-switchboard-shown')).toBe(false);
    expect(toggle('Paused')?.textContent).toBe('Show 2 snoozed cards');
    expect(list('Paused').lastElementChild).toBe(toggle('Paused'));
    expect(column('Paused').querySelectorAll('.switchboard-snoozed-toggle')).toHaveLength(1);
  });

  it('uses the singular for one card, Hide for a shown column, and removes the button and marks when nothing is snoozed', () => {
    const onToggle = vi.fn();

    applySnoozed(document, new Set(['github/roadmap#1090']), new Set(['Later']), onToggle);
    expect(toggle('Paused')?.textContent).toBe('Show 1 snoozed card');
    expect(toggle('Later')?.textContent).toBe('Hide 1 snoozed card');
    expect(column('Later').hasAttribute('data-switchboard-shown')).toBe(true);

    toggle('Later')!.click();
    expect(onToggle).toHaveBeenCalledExactlyOnceWith('Later');

    applySnoozed(document, new Set(), new Set(), onToggle);
    expect(document.querySelectorAll('[data-switchboard-snoozed], .switchboard-snoozed-toggle, [data-switchboard-shown]')).toHaveLength(0);
  });

  it('matches the title link, not an issue linked in the card fields', () => {
    const card = column('Paused').querySelector('[data-board-card-id="94970044"]')!;

    card.querySelector('ul[aria-label="Fields"]')!.insertAdjacentHTML('beforeend', '<li><a href="https://github.com/github/roadmap/issues/1035">Parent</a></li>');
    applySnoozed(document, new Set(['github/roadmap#1035']), new Set(), () => {});

    expect(hiddenIds('Paused')).toEqual(['88050488']);
  });

  it('keeps a card marked after GitHub empties it out of view, and leaves an unseen empty card shown', () => {
    document.body.innerHTML = COLUMN;

    const keys = new Map<string, string | null>();
    const snoozed = new Set(['github/roadmap#1035', 'github/roadmap#1090']);
    const empty = (id: string) => column('Paused').querySelector(`[data-board-card-id="${id}"]`)!.replaceChildren();

    empty('94970044');
    applySnoozed(document, snoozed, new Set(), () => {}, keys);
    expect(hiddenIds('Paused')).toEqual(['88050488']);

    empty('88050488');
    applySnoozed(document, snoozed, new Set(), () => {}, keys);
    expect(hiddenIds('Paused')).toEqual(['88050488']);
    expect(toggle('Paused')?.textContent).toBe('Show 1 snoozed card');
  });

  it('makes no mutation when applied again unchanged', async () => {
    const snoozed = new Set(['github/roadmap#1035']);

    applySnoozed(document, snoozed, new Set(), () => {});

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    applySnoozed(document, snoozed, new Set(), () => {});
    await Promise.resolve();
    observer.disconnect();

    expect(records).toEqual([]);
  });

  it('hides marked cards with content.css until their column is shown', () => {
    document.head.innerHTML = `<style>${readFileSync(join(import.meta.dirname, '..', 'src', 'content.css'), 'utf8')}</style>`;
    applySnoozed(document, new Set(['github/roadmap#1035']), new Set(['Later']), () => {});

    const display = (name: string, id: string) => getComputedStyle(column(name).querySelector(`[data-board-card-id="${id}"]`)!).display;

    expect(display('Paused', '88050488')).toBe('none');
    expect(display('Paused', '94970044')).not.toBe('none');
    expect(display('Later', '88050488')).not.toBe('none');
    document.head.innerHTML = '';
  });
});

describe('watchBoard', () => {
  let watch: BoardWatch | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    watch?.stop();
    watch = null;
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('reads nothing while no board is on the page, then reads and applies when one renders', async () => {
    let time = 0;
    const read = vi.fn(async () => ['https://github.com/GitHub/Roadmap/issues/1035', 'https://desk.example.test/1']);

    document.body.innerHTML = '<main>repository page</main>';
    watch = watchBoard(document, read, () => time);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(read).not.toHaveBeenCalled();

    board();
    await vi.advanceTimersByTimeAsync(60);
    expect(read).toHaveBeenCalledTimes(1);
    expect(hiddenIds('Paused')).toEqual(['88050488']);

    // Cards GitHub loads later are marked as they render.
    const rendered = column('Paused').querySelector('[data-board-card-id="88050488"]')!;
    const fresh = rendered.cloneNode(true) as Element;

    fresh.removeAttribute('data-switchboard-snoozed');
    rendered.remove();
    column('Paused').querySelector('[data-dnd-drop-type="card"]')!.append(fresh);
    await vi.advanceTimersByTimeAsync(60);
    expect(hiddenIds('Paused')).toEqual(['88050488']);
    expect(read).toHaveBeenCalledTimes(1);

    time = REFRESH_MS;
    read.mockResolvedValueOnce([]);
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(read).toHaveBeenCalledTimes(2);
    expect(hiddenIds('Paused')).toEqual([]);
  });

  it('shows and hides a column\'s snoozed cards from its button', async () => {
    board();
    watch = watchBoard(document, async () => ['https://github.com/github/roadmap/issues/1090']);
    await vi.advanceTimersByTimeAsync(0);

    toggle('Paused')!.click();
    expect(column('Paused').hasAttribute('data-switchboard-shown')).toBe(true);
    expect(toggle('Paused')?.textContent).toBe('Hide 1 snoozed card');
    expect(column('Later').hasAttribute('data-switchboard-shown')).toBe(false);

    toggle('Paused')!.click();
    expect(toggle('Paused')?.textContent).toBe('Show 1 snoozed card');
  });

  it('shows every card when the hub does not answer', async () => {
    board();
    watch = watchBoard(document, async () => null);
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelectorAll('[data-switchboard-snoozed], .switchboard-snoozed-toggle')).toHaveLength(0);
  });

  it('ignores a read that a later read overtook', async () => {
    const replies: ((urls: string[]) => void)[] = [];

    board();
    watch = watchBoard(document, () => new Promise((resolve) => replies.push(resolve)), () => 0);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(replies).toHaveLength(2);

    replies[1]!([]);
    await vi.advanceTimersByTimeAsync(0);
    replies[0]!(['https://github.com/github/roadmap/issues/1090']);
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelectorAll('[data-switchboard-snoozed]')).toHaveLength(0);
  });

  it('reads again when the tab becomes visible', async () => {
    const read = vi.fn(async () => []);

    board();
    watch = watchBoard(document, read, () => 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event('visibilitychange'));
    expect(read).toHaveBeenCalledTimes(2);
  });
});
