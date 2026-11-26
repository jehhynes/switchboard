import { DEFAULT_SETTINGS, Store } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DoneSearch, monthBand, SEARCH_LIMIT, searchWords } from '../src/dockSearch.js';
import { doneSince } from '../src/rows.js';
import { buildSnapshot } from '../src/snapshot.js';
import type { SnapshotInputs } from '../src/snapshot.js';

const T0 = new Date(2026, 10, 20, 12).getTime();
const DAY = 86_400_000;
let store: Store;

beforeEach(() => {
  store = Store.open(':memory:');
});

afterEach(() => {
  store.close();
});

const inputs = (now = T0): SnapshotInputs => ({
  settings: DEFAULT_SETTINGS,
  playbooks: [],
  settingsError: null,
  playbookErrors: [],
  enabled: [],
  sources: [],
  held: [],
  holder: null,
  guarded: [],
  nodeError: null,
  hookErrors: { claude: null, codex: null },
  sourceErrors: {},
  sourceNotes: {},
  pullRequests: {},
  kinds: {},
  now,
  configDir: 'C:/cfg',
});

/** A GitHub ticket with one work item, done at `doneAt` or open when null. */
function ticket(key: string, title: string, doneAt: number | null, extra: { snoozed?: boolean; playbook?: string } = {}): number {
  const made = store.insertTicket({ source: 'github', sourceKey: key, ref: `#${key}`, sourceId: null, title, url: `https://github.com/o/r/issues/${key}`, assigned: false, pool: false, snoozed: extra.snoozed ?? false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' } as never);
  const item = store.insertWorkItem({ ticketId: made.id, playbook: extra.playbook ?? 'dev:develop', status: doneAt === null ? 'unstarted' : 'done', createdAt: (doneAt ?? T0) - DAY } as never);

  if (doneAt !== null) {
    store.updateWorkItem(item.id, { doneAt, doneReason: 'operator' });
  }

  return made.id;
}

describe('searchWords and monthBand', () => {
  it('splits on any whitespace in lower case, and names a month', () => {
    expect(searchWords('  Quote  EXPIRY\tmail ')).toEqual(['quote', 'expiry', 'mail']);
    expect(searchWords('   ')).toEqual([]);
    expect(monthBand(new Date(2026, 9, 31, 23).getTime())).toBe('October 2026');
  });
});

describe('DoneSearch (PRD R63)', () => {
  it('finds only Done rows before the Done list and from the time asked, newest first, in month bands', () => {
    const start = doneSince(T0);

    ticket('101', 'Quote expiry email', start + DAY);
    ticket('102', 'Quote expiry banner', start - DAY);
    ticket('103', 'Quote expiry rounding', start - 60 * DAY);
    ticket('104', 'Quote expiry open', null);
    ticket('105', 'Quote expiry snoozed', start - 2 * DAY, { snoozed: true });
    const snapshot = buildSnapshot(store, inputs());
    const search = new DoneSearch();

    const all = search.search(store, snapshot, inputs(), 'quote EXPIRY', 0, 'C:/w');

    expect(all.rows.map((row) => row.title)).toEqual(['Quote expiry banner', 'Quote expiry rounding']);
    expect(all.rows.map((row) => row.band)).toEqual([monthBand(start - DAY), monthBand(start - 60 * DAY)]);
    expect(all.rows[0]).toMatchObject({ key: expect.stringMatching(/^item:\d+$/), ticket: 'gh 102', search: expect.stringContaining('Done') });
    expect(all.more).toBe(false);
    expect(search.search(store, snapshot, inputs(), 'quote', start - 30 * DAY, 'C:/w').rows.map((row) => row.title)).toEqual(['Quote expiry banner']);
    expect(search.search(store, snapshot, inputs(), 'quote', start, 'C:/w').rows).toEqual([]);
    expect(search.search(store, snapshot, inputs(), '  ', 0, 'C:/w').rows).toEqual([]);
  });

  it('matches every word in the key, linked pull requests, playbook and branch', () => {
    const old = doneSince(T0) - DAY;
    const id = ticket('18941', 'Inbox badge', old, { playbook: 'dev:review-pr' });

    store.addLink({ ticketId: id, label: 'PR', target: 'https://github.com/o/r/pull/19002', reportedAt: old, mentioned: false });
    store.linkWorktree({ ticketId: id, path: 'D:/wt/18941', branch: '18941-inbox-badge', linkedBy: 'report' } as never);
    ticket('200', 'Other work', old);
    const snapshot = buildSnapshot(store, inputs());
    const titles = (text: string) => new DoneSearch().search(store, snapshot, inputs(), text, 0, 'C:/w').rows.map((row) => row.title);

    expect(titles('gh 18941')).toEqual(['Inbox badge']);
    expect(titles('pr #19002')).toEqual(['Inbox badge']);
    expect(titles('review-pr inbox-badge')).toEqual(['Inbox badge']);
    expect(titles('inbox other')).toEqual([]);
  });

  it('answers at most SEARCH_LIMIT rows and says there are more', () => {
    for (let index = 0; index <= SEARCH_LIMIT; index++) {
      ticket(String(1000 + index), `Bulk ${index}`, doneSince(T0) - DAY - index);
    }

    const found = new DoneSearch().search(store, buildSnapshot(store, inputs()), inputs(), 'bulk', 0, 'C:/w');

    expect(found.rows).toHaveLength(SEARCH_LIMIT);
    expect(found.rows[0]!.title).toBe('Bulk 0');
    expect(found.more).toBe(true);
  });

  it('reads the range again for a new snapshot, and not for the same one', () => {
    const old = doneSince(T0) - DAY;

    ticket('1', 'Alpha work', old);
    const search = new DoneSearch();
    const first = buildSnapshot(store, inputs());

    expect(search.search(store, first, inputs(), 'work', 0, 'C:/w').rows).toHaveLength(1);
    ticket('2', 'Beta work', old - 1);
    // The same snapshot keeps the texts it read; the store's change builds a new snapshot, which reads them again.
    expect(search.search(store, first, inputs(), 'work', 0, 'C:/w').rows.map((row) => row.title)).toEqual(['Alpha work']);
    expect(search.search(store, buildSnapshot(store, inputs()), inputs(), 'work', 0, 'C:/w').rows.map((row) => row.title)).toEqual(['Alpha work', 'Beta work']);
  });
});
