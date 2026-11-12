import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_MS, applySnoozed, applySnoozedRows, issueKey, itemHref, viewKey, watchBoard } from '../src/board.js';
import type { BoardWatch } from '../src/board.js';

const COLUMN = readFileSync(join(import.meta.dirname, 'fixtures', 'column.html'), 'utf8');
const TABLE = readFileSync(join(import.meta.dirname, 'fixtures', 'table.html'), 'utf8');
const GROUPED = readFileSync(join(import.meta.dirname, 'fixtures', 'table-grouped.html'), 'utf8');

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

const rowFor = (number: number) => document.querySelector(`[role="rowheader"] a[href$="/issues/${number}"]`)!.closest('[role="row"]')!;
const hiddenRows = () => [...document.querySelectorAll('[role="row"][data-switchboard-snoozed]')].map((row) => itemHref(row)?.split('/').pop());
const tableToggles = () => [...document.querySelectorAll<HTMLButtonElement>('#project-items-region .switchboard-snoozed-toggle')];
/** The ungrouped table's body, which holds its chunks of five rows. */
const tableBody = () => rowFor(983).parentElement!.parentElement!;

describe('itemHref', () => {
  it('reads the title link of the card or table row that holds an element, and nothing outside one', () => {
    document.body.innerHTML = COLUMN + TABLE;

    expect(itemHref(document.querySelector('[data-board-card-id="88050488"] [id^="board-card-header-title-"]')!)).toBe('https://github.com/github/roadmap/issues/1035');
    expect(itemHref(rowFor(1040).querySelector('[role="gridcell"]:last-child')!)).toBe('https://github.com/github/roadmap/issues/1040');
    expect(itemHref(document.querySelector('[role="columnheader"]')!)).toBeUndefined();
    expect(itemHref(document.body)).toBeUndefined();
  });
});

describe('viewKey', () => {
  it('ignores the side panel\'s parameters and keeps those that change the view', () => {
    const key = (url: string) => viewKey(new URL(url, 'https://github.com'));

    expect(key('/orgs/o/projects/3/views/1?filterQuery=x&pane=issue&itemId=12&issue=o%7Cr%7C7')).toBe(key('/orgs/o/projects/3/views/1?filterQuery=x'));
    expect(key('/orgs/o/projects/3/views/1?filterQuery=x')).not.toBe(key('/orgs/o/projects/3/views/1?filterQuery=y'));
    expect(key('/orgs/o/projects/3/views/1')).not.toBe(key('/orgs/o/projects/3/views/2'));
  });
});

describe('applySnoozedRows', () => {
  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('marks the snoozed rows of an ungrouped table and puts the button after the Title column\'s name', () => {
    document.body.innerHTML = TABLE;
    applySnoozedRows(document, new Set(['github/roadmap#1025', 'github/roadmap#1193', 'github/roadmap#1']), new Set(), () => {}, new Map());

    const name = document.querySelector('[role="columnheader"] span')!;

    expect(hiddenRows()).toEqual(['1025', '1193']);
    expect(tableToggles().map((button) => button.textContent)).toEqual(['Show 2 snoozed rows']);
    expect([name.textContent, name.nextElementSibling]).toEqual(['Title', tableToggles()[0]]);
    // The rows the add-item bar moves up past; none once they show.
    expect(document.querySelector<HTMLElement>('#project-items-region')!.style.getPropertyValue('--switchboard-hidden-rows')).toBe('2');
    applySnoozedRows(document, new Set(['github/roadmap#1025', 'github/roadmap#1193']), new Set(['']), () => {}, new Map());
    expect(document.querySelector<HTMLElement>('#project-items-region')!.style.getPropertyValue('--switchboard-hidden-rows')).toBe('0');
    expect(tableBody().hasAttribute('data-switchboard-rows')).toBe(true);
  });

  it('keeps the button\'s clicks and presses from GitHub\'s header handlers', () => {
    const onToggle = vi.fn();
    const reachedGitHub = vi.fn();

    document.body.innerHTML = TABLE;
    applySnoozedRows(document, new Set(['github/roadmap#1025']), new Set(), onToggle, new Map());
    document.querySelector('[role="columnheader"]')!.addEventListener('click', reachedGitHub);
    document.querySelector('[role="columnheader"]')!.addEventListener('pointerdown', reachedGitHub);

    tableToggles()[0]!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    tableToggles()[0]!.click();

    expect(onToggle).toHaveBeenCalledExactlyOnceWith('');
    expect(reachedGitHub).not.toHaveBeenCalled();
  });

  it('names a group by its header, counts its rows, and toggles it by name', () => {
    const onToggle = vi.fn();

    document.body.innerHTML = GROUPED;
    applySnoozedRows(document, new Set(['github/roadmap#1193']), new Set(['Up Next']), onToggle, new Map());

    const [button] = tableToggles();
    const list = rowFor(1193).parentElement!.parentElement!;
    const header = list.querySelector(':scope > [role="row"] [data-component="Text"]')!.parentElement!;

    expect(hiddenRows()).toEqual(['1193']);
    expect(button?.textContent).toBe('Hide 1 snoozed row');
    // After the group's name and count, in its header row.
    expect(header.lastElementChild).toBe(button);
    expect(header.textContent).toContain('Up Next');
    expect(list.hasAttribute('data-switchboard-shown')).toBe(true);

    button!.click();
    expect(onToggle).toHaveBeenCalledExactlyOnceWith('Up Next');
  });

  it('keeps counting a snoozed row GitHub stopped rendering', () => {
    const seen = new Map<string, string>();
    const snoozed = new Set(['github/roadmap#1025', 'github/roadmap#1193']);

    document.body.innerHTML = TABLE;
    applySnoozedRows(document, snoozed, new Set(), () => {}, seen);

    // GitHub replaces the first chunk, which holds 1025, with a placeholder as it scrolls away.
    rowFor(983).parentElement!.replaceWith(document.createElement('div'));
    applySnoozedRows(document, snoozed, new Set(), () => {}, seen);

    expect(tableToggles().map((button) => button.textContent)).toEqual(['Show 2 snoozed rows']);
    expect(seen.get('github/roadmap#1025')).toBe('');
  });

  it('toggles a group by its current name after GitHub renames it in place', () => {
    const onToggle = vi.fn();
    const seen = new Map<string, string>();

    document.body.innerHTML = GROUPED;
    applySnoozedRows(document, new Set(['github/roadmap#1193']), new Set(), onToggle, seen);
    document.querySelector('[role="row"].sticky [data-component="Text"]')!.textContent = 'Soon';
    applySnoozedRows(document, new Set(['github/roadmap#1193']), new Set(), onToggle, seen);

    tableToggles()[0]!.click();
    expect(onToggle).toHaveBeenCalledExactlyOnceWith('Soon');
    expect(tableToggles()).toHaveLength(1);
  });

  it('keeps a group\'s button while it renders no rows, removes it when nothing is snoozed, and removes the Title header button when the table has no rows', () => {
    const seen = new Map<string, string>();

    document.body.innerHTML = GROUPED;
    applySnoozedRows(document, new Set(['github/roadmap#1193']), new Set(), () => {}, seen);

    // A collapsed group, or one scrolled past, keeps its header but renders no rows.
    for (const row of document.querySelectorAll('[role="rowheader"]')) {
      row.closest('[role="row"]')!.remove();
    }
    applySnoozedRows(document, new Set(['github/roadmap#1193']), new Set(), () => {}, seen);
    expect(tableToggles().map((button) => button.textContent)).toEqual(['Show 1 snoozed row']);

    applySnoozedRows(document, new Set(), new Set(), () => {}, seen);
    expect(document.querySelectorAll('[data-switchboard-snoozed], .switchboard-snoozed-toggle')).toHaveLength(0);

    // An ungrouped table keeps its Title header when a filter leaves it no rows.
    document.body.innerHTML = TABLE;
    applySnoozedRows(document, new Set(['github/roadmap#1025']), new Set(), () => {}, new Map());
    expect(tableToggles()).toHaveLength(1);
    tableBody().replaceChildren();
    applySnoozedRows(document, new Set(['github/roadmap#1025']), new Set(), () => {}, new Map());
    expect(tableToggles()).toHaveLength(0);
  });

  it('makes no mutation when applied again unchanged', async () => {
    const snoozed = new Set(['github/roadmap#1035']);
    const seen = new Map<string, string>();

    document.body.innerHTML = TABLE;
    applySnoozedRows(document, snoozed, new Set(), () => {}, seen);

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    applySnoozedRows(document, snoozed, new Set(), () => {}, seen);
    await Promise.resolve();
    observer.disconnect();

    expect(records).toEqual([]);
  });

  it('hides marked rows with content.css until their group is shown', () => {
    document.head.innerHTML = `<style>${readFileSync(join(import.meta.dirname, '..', 'src', 'content.css'), 'utf8')}</style>`;
    document.body.innerHTML = TABLE;

    const display = (number: number) => getComputedStyle(rowFor(number)).display;

    applySnoozedRows(document, new Set(['github/roadmap#1035']), new Set(), () => {}, new Map());
    expect(display(1035)).toBe('none');
    expect(display(1040)).not.toBe('none');

    applySnoozedRows(document, new Set(['github/roadmap#1035']), new Set(['']), () => {}, new Map());
    expect(display(1035)).not.toBe('none');
    // The cells' content is dimmed, not the row, whose background would let the table behind it show through.
    expect(getComputedStyle(rowFor(1035)).opacity).toBe('1');
    expect([...rowFor(1035).children].map((cell) => getComputedStyle(cell.firstElementChild!).opacity)).toEqual(['0.6', '0.6', '0.6']);
    expect(getComputedStyle(rowFor(1040).querySelector('[role="rowheader"]')!.firstElementChild!).opacity).toBe('1');
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

  it('reads for a project table, hides its snoozed rows and forgets the rows of a previous view', async () => {
    const read = vi.fn(async () => ['https://github.com/github/roadmap/issues/1025', 'https://github.com/github/roadmap/issues/1035']);

    history.replaceState(null, '', '/orgs/github/projects/4247/views/1');
    document.body.innerHTML = TABLE;
    watch = watchBoard(document, read, () => 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(read).toHaveBeenCalledTimes(1);
    expect(hiddenRows()).toEqual(['1025', '1035']);
    expect(tableToggles().map((button) => button.textContent)).toEqual(['Show 2 snoozed rows']);

    tableToggles()[0]!.click();
    expect(tableToggles().map((button) => button.textContent)).toEqual(['Hide 2 snoozed rows']);

    // Opening an item's side panel keeps the view, so 1035, no longer rendered, still counts.
    rowFor(1035).remove();
    history.pushState(null, '', '/orgs/github/projects/4247/views/1?pane=issue&itemId=5&issue=github%7Croadmap%7C983');
    watch.update();
    expect(tableToggles().map((button) => button.textContent)).toEqual(['Hide 2 snoozed rows']);

    // Another view, which GitHub renders without 1035.
    history.pushState(null, '', '/orgs/github/projects/4247/views/2');
    watch.update();
    expect(tableToggles().map((button) => button.textContent)).toEqual(['Hide 1 snoozed row']);

    // A filter that leaves the table no rows clears the button and the add-item bar's offset.
    tableToggles()[0]!.click();
    expect(document.querySelector<HTMLElement>('#project-items-region')!.style.getPropertyValue('--switchboard-hidden-rows')).toBe('1');
    tableBody().replaceChildren();
    watch.update();
    expect(tableToggles()).toHaveLength(0);
    expect(document.querySelector<HTMLElement>('#project-items-region')!.style.getPropertyValue('--switchboard-hidden-rows')).toBe('0');
    history.replaceState(null, '', '/');
  });

  it('moves only the add-item bar GitHub positions after the rows, not the one fixed to the bottom of the view', () => {
    const bars = new DOMParser().parseFromString(readFileSync(join(import.meta.dirname, 'fixtures', 'omnibar.html'), 'utf8'), 'text/html');
    const rule = /\n([^\n]*OmnibarContainer[^\n]*) \{\n  translate: ([^;]+);/.exec(readFileSync(join(import.meta.dirname, '..', 'src', 'content.css'), 'utf8'))!;

    document.body.innerHTML = TABLE;

    for (const id of ['static', 'fixed']) {
      document.querySelector('#project-items-region')!.append(bars.querySelector<HTMLTemplateElement>(`template#${id}`)!.content.cloneNode(true));
    }

    const [positioned, fixed] = [...document.querySelectorAll('[class*="OmnibarContainer"]')];

    expect(rule[2]).toBe('0 calc(var(--switchboard-hidden-rows, 0) * var(--table-cell-height, 37px) * -1)');
    expect([positioned!.matches(rule[1]!), fixed!.matches(rule[1]!)]).toEqual([true, false]);
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

  it('reads again on refresh, within the refresh interval, and hides a card snoozed since (PRD R66)', async () => {
    const read = vi.fn(async (): Promise<string[]> => []);

    board();
    watch = watchBoard(document, read, () => 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(hiddenIds('Paused')).toEqual([]);

    read.mockResolvedValueOnce(['https://github.com/github/roadmap/issues/1090']);
    watch.refresh();
    await vi.advanceTimersByTimeAsync(0);

    expect(read).toHaveBeenCalledTimes(2);
    expect(hiddenIds('Paused')).toEqual(['94970044']);
  });
});
