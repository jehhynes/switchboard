import { describe, expect, it } from 'vitest';
import { parseRoute, parseScrolls, parseTabSets, routeHash, SCROLLS_KEPT, startRoute, TAB_SETS_KEPT, withScroll, withTabSet } from '../src/route.js';
import type { TabSet } from '../src/route.js';

describe('the route', () => {
  it('reads and writes the work item, its tab, what the tab shows and History in the hash, and nothing for anything else', () => {
    expect(parseRoute('#w=12')).toMatchObject({ w: 12, t: null, h: null });
    expect(parseRoute('#w=12&t=artifact%3Achat%2Freport.md')).toMatchObject({ w: 12, t: 'artifact:chat/report.md' });
    expect(routeHash({ w: 12, t: 'artifact:chat/report.md' })).toBe('#w=12&t=artifact%3Achat%2Freport.md');
    expect(routeHash({ w: 12, t: null })).toBe('#w=12');
    expect(routeHash({ w: null, t: 'status' })).toBe('#');

    const changes = routeHash({ w: 3, t: 'changes', f: 'src/a b.ts' });

    expect(changes).toBe('#w=3&t=changes&f=src%2Fa%20b.ts');
    expect(parseRoute(changes)).toMatchObject({ w: 3, t: 'changes', f: 'src/a b.ts', p: null });

    const local = routeHash({ w: 3, t: 'file', p: 'D:/w/README.md', l: 40, h: { ticketId: 9, key: 'gh 9' } });

    expect(local).toBe('#w=3&t=file&p=D%3A%2Fw%2FREADME.md&l=40&h=9&hk=gh%209');
    expect(parseRoute(local)).toEqual({ w: 3, t: 'file', f: null, p: 'D:/w/README.md', l: 40, u: null, h: { ticketId: 9, key: 'gh 9' } });
    // What a tab shows belongs to that tab only.
    expect(routeHash({ w: 3, t: 'status', f: 'x', p: 'y', l: 2 })).toBe('#w=3&t=status');
    // History over the list, with no work item open.
    expect(parseRoute('#h=9&hk=gh%209')).toMatchObject({ w: null, h: { ticketId: 9, key: 'gh 9' } });

    for (const hash of ['', '#', '#w=', '#w=0', '#w=-3', '#w=1.5', '#w=abc', '#t=status']) {
      expect(parseRoute(hash)).toMatchObject({ w: null, t: null, h: null });
    }
  });

  it("reads #list as the phone's list, kept over the device's route, and a link tab's URL, with an older address's t=browser read as a link tab", () => {
    expect(parseRoute('#list')).toMatchObject({ w: null, t: null, list: true });
    expect(routeHash({ w: 3, t: 'status', list: true })).toBe('#list');
    expect(startRoute('#list', '#w=9&t=status')).toMatchObject({ w: null, list: true });
    // Only the whole hash is the list.
    expect(parseRoute('#w=3&list').list).toBeUndefined();
    expect(parseRoute('#list=1').list).toBeUndefined();

    const link = routeHash({ w: 3, t: 'link', u: 'https://github.com/o/r/pull/5?x=1#y' });

    expect(link).toBe('#w=3&t=link&u=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F5%3Fx%3D1%23y');
    expect(parseRoute(link)).toMatchObject({ w: 3, t: 'link', u: 'https://github.com/o/r/pull/5?x=1#y' });
    expect(parseRoute('#w=3&t=browser')).toMatchObject({ w: 3, t: 'link', u: null });
    // The URL belongs to the link tab only.
    expect(routeHash({ w: 3, t: 'history', u: 'https://example.com/' })).toBe('#w=3&t=history');
    expect(parseRoute('#w=3&t=history&u=https%3A%2F%2Fexample.com%2F').u).toBeNull();
    // An address from before History took the Status tab's place opens History.
    expect(parseRoute('#w=3&t=status')).toMatchObject({ w: 3, t: 'history' });
  });

  it("starts on the address's route, or with none in it on the one this device kept, as an installed app started again at its start URL", () => {
    expect(startRoute('#w=3', '#w=9&t=status')).toMatchObject({ w: 3, t: null });
    expect(startRoute('', '#w=9&t=status')).toMatchObject({ w: 9, t: 'history' });
    expect(startRoute('#h=4&hk=k', '#w=9')).toMatchObject({ w: null, h: { ticketId: 4, key: 'k' } });
    expect(startRoute('', null)).toMatchObject({ w: null, t: null });
    expect(startRoute('', '#')).toMatchObject({ w: null, t: null });
  });

  it('keeps a scroll place per work item and tab, the latest few, and nothing from a malformed value', () => {
    const one = { id: 'r1', offset: -12, pinned: false, top: 0 };

    expect(parseScrolls(JSON.stringify({ '3 conversation': one, '3 status': { id: null, offset: 0, pinned: false, top: 240 }, bad: { id: 1 } }))).toEqual({ '3 conversation': one, '3 status': { id: null, offset: 0, pinned: false, top: 240 } });

    for (const raw of [null, '', '{', '[]', 'null']) {
      expect(parseScrolls(raw)).toEqual({});
    }

    let places = {};

    for (let at = 0; at < SCROLLS_KEPT + 5; at++) {
      places = withScroll(places, `${at} status`, { ...one, top: at });
    }

    places = withScroll(places, '10 status', { ...one, top: 99 });
    expect(Object.keys(places)).toHaveLength(SCROLLS_KEPT);
    expect(Object.keys(places).at(-1)).toBe('10 status');
    expect(Object.keys(places)[0]).toBe('5 status');
  });

  it('keeps each work item\'s tabs, the latest last and at most TAB_SETS_KEPT, and drops a malformed set', () => {
    const set: TabSet = { side: 'diff', tab: 'conversation', artifact: null, changes: true, changesFile: 'src/a.ts', files: [{ target: 'src/a.ts', line: 3 }, { target: 'src/b.ts', line: null }], file: 1 };
    let sets: Record<string, TabSet> = {};

    for (let at = 1; at <= TAB_SETS_KEPT + 5; at++) {
      sets = withTabSet(sets, at, { ...set, file: at % 2 });
    }

    // A work item opened again is the latest, not in its number's place.
    sets = withTabSet(sets, 10, set);
    expect(Object.keys(sets)).toHaveLength(TAB_SETS_KEPT);
    expect(Object.keys(sets).at(-1)).toBe('w10');
    expect(Object.keys(sets)[0]).toBe('w6');
    expect(parseTabSets(JSON.stringify(sets))).toEqual(sets);
    expect(parseTabSets(JSON.stringify({ w1: set, w2: { ...set, file: 2 }, w3: { ...set, files: [{ target: 1, line: null }] }, w4: { ...set, changes: 'yes' }, '5': set, w6: null }))).toEqual({ w1: set });
    // A set kept while History could close drops whether it was open, and one that named Status names History, which a set naming History keeps.
    expect(parseTabSets(JSON.stringify({ w1: { ...set, history: true }, w2: { ...set, history: 'yes' }, w3: { ...set, side: 'status', tab: 'status' }, w4: { ...set, side: 'history', tab: 'history' } }))).toEqual({
      w1: set,
      w2: set,
      w3: { ...set, side: 'history', tab: 'history' },
      w4: { ...set, side: 'history', tab: 'history' },
    });
    // The link tabs: those open with their names, the closed ones and the one selected.
    const links = { open: [{ url: 'https://github.com/o/r/pull/7', name: 'PR #7' }], closed: ['https://github.com/o/r/issues/1'], selected: 'https://github.com/o/r/pull/7' };

    expect(
      parseTabSets(JSON.stringify({ w1: { ...set, links }, w2: { ...set, links: { ...links, open: [{ url: 1, name: 'x' }] } }, w3: { ...set, links: { ...links, closed: 'x' } }, w4: { ...set, links: { ...links, selected: null } }, w5: { ...set, links: null } })),
    ).toEqual({ w1: { ...set, links } });
    expect(parseTabSets('not json')).toEqual({});
    expect(parseTabSets('[]')).toEqual({});
    expect(parseTabSets(null)).toEqual({});
  });
});
