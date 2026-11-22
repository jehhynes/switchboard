import { describe, expect, it } from 'vitest';
import { evictions, rowKey, wantedIndexes } from '../src/changesWindow.js';

describe("the Changes tab's reads", () => {
  it('WantedIndexes_ForTheView_ListsOnScreenThenTwoAheadThenOneBehind', () => {
    expect(wantedIndexes({ first: 4, last: 6 }, 20)).toEqual([4, 5, 6, 7, 8, 3]);
    expect(wantedIndexes({ first: 0, last: 0 }, 20)).toEqual([0, 1, 2]);
    expect(wantedIndexes({ first: 18, last: 19 }, 20)).toEqual([18, 19, 17]);
    expect(wantedIndexes({ first: 0, last: 30 }, 3)).toEqual([0, 1, 2]);
    expect(wantedIndexes(null, 20)).toEqual([]);
    expect(wantedIndexes({ first: 0, last: 0 }, 0)).toEqual([]);
  });

  it('RowKey_ForAMovedBaseOrADeletedFile_Differs', () => {
    const row = { path: 'a.ts', status: 'D', hash: 'deleted' };

    expect(rowKey('b1', row)).not.toBe(rowKey('b2', row));
    expect(rowKey('b1', row)).not.toBe(rowKey('b1', { ...row, status: 'M' }));
    expect(rowKey('b1', { ...row, from: 'old.ts' })).not.toBe(rowKey('b1', row));
    expect(rowKey('b1', row)).toBe(rowKey('b1', { ...row }));
  });
});

describe("the Changes tab's budget", () => {
  const held = (path: string, index: number, chars: number, hydrated = false) => ({ path, index, chars, hydrated });

  it('Evictions_UnderBudget_GiveUpNothing', () => {
    expect(evictions([held('a', 0, 10)], new Set(), { first: 0, last: 0 }, 100)).toEqual([]);
  });

  it('Evictions_OverBudget_GiveUpHydratedThenFurthestNeverWanted', () => {
    const all = [held('near', 4, 40), held('far', 30, 40), held('wanted', 5, 40), held('sides', 6, 40, true), held('gone', -1, 40), held('behind', 0, 40)];

    expect(evictions(all, new Set(['wanted']), { first: 5, last: 5 }, 239)).toEqual(['sides']);
    expect(evictions(all, new Set(['wanted']), { first: 5, last: 5 }, 120)).toEqual(['sides', 'gone', 'far']);
    expect(evictions(all, new Set(['wanted']), { first: 5, last: 5 }, 0)).toEqual(['sides', 'gone', 'far', 'behind', 'near']);
  });
});