import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@switchboard/core';
import { describe, expect, it } from 'vitest';
import { DISMISSALS_KEPT, DISMISSED_PREF, INFO_SHOWN_MS, keptDismissals, noticeHash, Notices } from '../src/notices.js';
import type { InfoNotice, Notice } from '../src/notices.js';

const error: Notice = { id: 'settings', class: 'action', text: 'Settings: bad JSON', dismiss: null, action: { kind: 'settings', label: 'Open Settings' } };
const older: Notice = { id: 'holder-older:b1', class: 'action', text: 'The terminal holder is out of date.', dismiss: 'kept' };
const result: Notice = { id: 'holder-result:5', class: 'action', text: 'The terminal holder did not restart.', dismiss: 'memory' };
const restarting: Notice = { id: 'holder-restarting', class: 'transient', text: 'Restarting the terminal holder…', dismiss: null };

/** A hub's notices over a store's kept dismissals, with open pages by key and sign-in, and what each page was sent. */
function hub(kept: string[] = [], start = 1000) {
  let now = start;
  const pages = new Map<string, string | null>();
  const sent: Array<[string, InfoNotice]> = [];
  const saved: string[][] = [];
  const notices = new Notices({
    now: () => now,
    load: () => kept,
    save: (ids) => {
      kept = ids;
      saved.push(ids);
    },
    pages: () => [...pages.keys()],
    signIn: (key) => pages.get(key) ?? null,
    send: (key, notice) => sent.push([key, notice]),
  });

  return { notices, pages, sent, saved, kept: () => kept, at: (time: number) => void (now = time) };
}

describe('Notices header', () => {
  it('stamps each notice with when it first showed, keeps that time while it stays, and starts again when it comes back', () => {
    const { notices, at } = hub();

    expect(notices.header([error, restarting])).toEqual([
      { id: 'settings', class: 'action', text: 'Settings: bad JSON', at: 1000, dismissible: false, action: { kind: 'settings', label: 'Open Settings' } },
      { id: 'holder-restarting', class: 'transient', text: 'Restarting the terminal holder…', at: 1000, dismissible: false },
    ]);
    at(5000);
    expect(notices.header([error, older]).map((one) => [one.id, one.at, one.dismissible])).toEqual([
      ['settings', 1000, false],
      ['holder-older:b1', 5000, true],
    ]);
    at(9000);
    notices.header([older]);
    // Oldest first, whatever order the notices come in.
    expect(notices.header([error, older]).map((one) => [one.id, one.at])).toEqual([
      ['holder-older:b1', 5000],
      ['settings', 9000],
    ]);
  });
});

describe('Notices observe and order', () => {
  it('forgets a notice that cleared while no page was open, so it counts from its return, and lists the oldest first', () => {
    const { notices, at } = hub();

    notices.observe([older]);
    at(2000);
    notices.observe([older, error]);
    // The error clears and comes back with no page open: only observe sees it.
    at(3000);
    notices.observe([older]);
    at(4000);
    notices.observe([error, older]);
    expect(notices.header([error, older]).map((one) => [one.id, one.at])).toEqual([
      ['holder-older:b1', 1000],
      ['settings', 4000],
    ]);
  });
});

describe('Notices dismiss', () => {
  it('dismisses one notice for every page, keeping one whose cause outlives the hub in the store and another in memory', () => {
    const first = hub();

    expect(first.notices.dismiss([error, older, result], 'holder-older:b1')).toBeNull();
    expect(first.notices.dismiss([error, older, result], 'holder-result:5')).toBeNull();
    expect(first.notices.header([error, older, result]).map((one) => one.id)).toEqual(['settings']);
    expect(first.kept()).toEqual(['holder-older:b1']);

    // A new hub over the same store still hides the kept one; the one held in memory shows again, as its cause would be gone with the old hub.
    const second = hub(first.kept());

    expect(second.notices.header([error, older, result]).map((one) => one.id)).toEqual(['settings', 'holder-result:5']);
  });

  it('refuses an error, which clears only when fixed, a notice that is gone or already dismissed, and Dismiss all with nothing to dismiss', () => {
    const { notices, saved } = hub();

    expect(notices.dismiss([error, older], 'settings')).toBe('This notice clears once its cause is fixed, so it cannot be dismissed.');
    expect(notices.dismiss([error, older], 'holder-older:other')).toBe('That notice is gone.');
    expect(notices.dismiss([error, older], 'holder-older:b1')).toBeNull();
    expect(notices.dismiss([error, older], 'holder-older:b1')).toBe('That notice is gone.');
    expect(notices.dismiss([error, restarting, older], null)).toBe('No notice can be dismissed.');
    expect(notices.header([error, older]).map((one) => one.id)).toEqual(['settings']);
    expect(saved).toEqual([['holder-older:b1']]);
  });

  it('dismisses every dismissible notice with Dismiss all and leaves the errors and transient ones', () => {
    const { notices, kept } = hub();

    expect(notices.dismiss([error, older, result, restarting], null)).toBeNull();
    expect(notices.header([error, older, result, restarting]).map((one) => one.id)).toEqual(['settings', 'holder-restarting']);
    expect(kept()).toEqual(['holder-older:b1']);
  });

  it('keeps the newest kept dismissals only, and ignores what is not an ID in the store', () => {
    const { notices, kept } = hub(['a', 'b'].concat(Array.from({ length: DISMISSALS_KEPT - 2 }, (_, index) => `old:${index}`)));
    const fresh: Notice = { ...older, id: 'holder-older:new' };

    expect(notices.dismiss([fresh], 'holder-older:new')).toBeNull();
    expect(kept()).toHaveLength(DISMISSALS_KEPT);
    expect(kept()[0]).toBe('b');
    expect(kept().at(-1)).toBe('holder-older:new');
    expect(new Notices({ now: () => 0, load: () => [7 as unknown as string, 'x'], save: () => {}, pages: () => [], signIn: () => null, send: () => {} }).header([{ ...older, id: 'x' }])).toEqual([]);
  });
});

describe('keptDismissals', () => {
  it('keeps a dismissal in the store, so a hub that opens it again hides the notice, and reads anything else there as none', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'switchboard-notices-')), 'switchboard.db');
    const deps = (store: Store) => ({ now: () => 0, ...keptDismissals(store), pages: () => [], signIn: () => null, send: () => {} });
    const first = Store.open(path);

    expect(new Notices(deps(first)).dismiss([older], 'holder-older:b1')).toBeNull();
    first.close();

    const second = Store.open(path);

    expect(new Notices(deps(second)).header([older, error]).map((one) => one.id)).toEqual(['settings']);
    second.setPagePref(DISMISSED_PREF, '{not json');
    expect(keptDismissals(second).load()).toEqual([]);
    second.setPagePref(DISMISSED_PREF, '{"id": "holder-older:b1"}');
    expect(new Notices(deps(second)).header([older]).map((one) => one.id)).toEqual(['holder-older:b1']);
    second.close();
  });
});

describe('Notices one-time notices', () => {
  const restarted: InfoNotice = { id: 'holder-restarted:1000', text: 'The terminal holder restarted and 2 sessions resumed.', at: 1000 };

  it('sends a one-time notice once to each open page, and again to none when it is announced again', () => {
    const { notices, pages, sent } = hub();

    pages.set('p1', 'computer').set('p2', 'phone');
    notices.announce([restarted]);
    notices.announce([restarted]);
    expect(sent).toEqual([
      ['p1', restarted],
      ['p2', restarted],
    ]);
  });

  it('sends it to every page open when it is announced, two tabs of one sign-in included, and to neither again', () => {
    const { notices, pages, sent } = hub();

    pages.set('p1', 'computer').set('p2', 'computer');
    notices.announce([restarted]);
    notices.pageOpened('p1');
    pages.set('p3', 'computer');
    notices.pageOpened('p3');
    expect(sent.map(([key]) => key)).toEqual(['p1', 'p2']);
  });

  it('sends it to a page opened within INFO_SHOWN_MS by a device that has not had it, never to a reload, and to none after', () => {
    const { notices, pages, sent, at } = hub();

    pages.set('p1', 'computer');
    notices.announce([restarted]);
    // The computer's page reloads: a new key, the same sign-in.
    pages.delete('p1');
    pages.set('p3', 'computer');
    notices.pageOpened('p3');
    // The phone opens its page within two minutes.
    at(1000 + INFO_SHOWN_MS - 1);
    pages.set('p4', 'phone');
    notices.pageOpened('p4');
    notices.pageOpened('p4');
    // A third device after two minutes gets nothing.
    at(1000 + INFO_SHOWN_MS);
    pages.set('p5', 'tablet');
    notices.pageOpened('p5');
    expect(sent.map(([key]) => key)).toEqual(['p1', 'p4']);
  });

  it('sends nothing for a notice older than INFO_SHOWN_MS when first announced, as after a page opens long after a restart', () => {
    const { notices, pages, sent, at } = hub();

    pages.set('p1', 'computer');
    at(1000 + INFO_SHOWN_MS);
    notices.announce([restarted]);
    notices.pageOpened('p1');
    expect(sent).toEqual([]);
  });

  it('counts a page without a known sign-in by its own key', () => {
    const { notices, pages, sent } = hub();

    pages.set('p1', null).set('p2', null);
    notices.announce([restarted]);
    notices.pageOpened('p1');
    expect(sent.map(([key]) => key)).toEqual(['p1', 'p2']);
  });
});

describe('noticeHash', () => {
  it('is stable for one text and differs for another', () => {
    expect(noticeHash('o1 o2')).toBe(noticeHash('o1 o2'));
    expect(noticeHash('o1 o2')).not.toBe(noticeHash('o1 o3'));
  });
});
