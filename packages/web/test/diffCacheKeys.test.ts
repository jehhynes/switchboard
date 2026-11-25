import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeViewDiffItem } from '@pierre/diffs';

/** Every CodeView the viewer makes, with the items it was given. */
const views: FakeView[] = [];

class FakeView {
  drawn: CodeViewDiffItem<undefined>[] = [];

  constructor() {
    views.push(this);
  }

  setup(): void {}
  setItems(items: CodeViewDiffItem<undefined>[]): void {
    this.drawn.push(...items);
  }
  updateItem(item: CodeViewDiffItem<undefined>): boolean {
    this.drawn.push(item);
    return true;
  }
  subscribeToScroll(): () => void {
    return () => {};
  }
  cleanUp(): void {}
}

vi.mock('@pierre/diffs', async (original) => ({ ...(await original<typeof import('@pierre/diffs')>()), CodeView: FakeView }));
vi.mock('@pierre/diffs/worker', async (original) => ({ ...(await original<typeof import('@pierre/diffs/worker')>()), getOrCreateWorkerPoolSingleton: () => ({}) }));

const { kinds, mountChanges } = await import('../src/diff/viewer.js');
const { DiffHunksRenderer, getSharedHighlighter, renderDiffWithHighlighter } = await import('@pierre/diffs');
const { WorkerPoolManager } = await import('@pierre/diffs/worker');

// A ten-line file whose last line has no newline: an earlier view of it changed its second line, a later one also its last line, adding the newline.
const head = ['diff --git a/src/Model.cs b/src/Model.cs', 'index 1111111..2222222 100644', '--- a/src/Model.cs', '+++ b/src/Model.cs'];
const first = ['@@ -1,4 +1,4 @@', ' line 1', '-line 2', '+LINE 2', ' line 3', ' line 4'];
const earlier = [...head, ...first, ''].join('\n');
const later = [...head, ...first, '@@ -7,4 +7,4 @@', ' line 7', ' line 8', ' line 9', '-line 10', '\\ No newline at end of file', '+line 10', ''].join('\n');
const row = { path: 'src/Model.cs', status: 'M', additions: 2, deletions: 2, binary: false };
const data = (patch: string) => ({ path: row.path, status: 'M', patch, old: null, new: null, binary: false, tooLarge: null, partial: true as const });
const mounted = () => mountChanges(document.createElement('div'), [row], { layout: 'split', wrap: false, loadSides: async () => null });
/** A worker that never answers, so the pool waits for it and none runs. */
const inertWorker = (): Worker => ({ postMessage() {}, addEventListener() {}, removeEventListener() {}, terminate() {} }) as unknown as Worker;
const diffs = (view: FakeView) => view.drawn.filter((item) => kinds.get(item.fileDiff)?.kind === 'diff');

beforeEach(() => {
  views.length = 0;
});

describe("the Changes tab's highlight cache keys", () => {
  it('MountChanges_SamePathInALaterViewOrShownAgain_GivesEachDiffItsOwnCacheKey', () => {
    // The tab mounted for one scope, then again for another (a commit), then the row dropped and shown again.
    const one = mounted();

    one.setRow(row.path, { data: data(earlier) });
    one.dispose();

    const two = mounted();

    two.setRow(row.path, { data: data(later) });
    two.setRows([]);
    two.setRows([row]);
    two.setRow(row.path, { data: data(later) });

    const keys = views.flatMap((view) => view.drawn.map((item) => item.fileDiff.cacheKey));

    expect(diffs(views[0]!).length + diffs(views[1]!).length).toBe(3);
    expect(keys.every((key) => key !== undefined)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('MountChanges_SameReadShownInALaterView_KeepsItsCacheKeyWithANewVersion', () => {
    // The tab chosen again mounts a new view and gives it the diffs the page holds; a diff read again is a new object.
    const read = data(later);
    const one = mounted();

    one.setRow(row.path, { data: read });
    one.dispose();

    const two = mounted();

    two.setRow(row.path, { data: read });
    two.setCollapsed(row.path, true);
    two.setRow(row.path, { data: read });
    two.setRow(row.path, { data: data(later) });

    const [shown] = diffs(views[0]!);
    const [again, collapsed, afterCollapse, readAgain] = views[1]!.drawn.slice(1);

    expect(again!.fileDiff.cacheKey).toBe(shown!.fileDiff.cacheKey);
    expect(afterCollapse!.fileDiff.cacheKey).toBe(shown!.fileDiff.cacheKey);
    expect(readAgain!.fileDiff.cacheKey).not.toBe(shown!.fileDiff.cacheKey);
    // Each update has a version of its own, so Pierre never skips one, and the collapse holds.
    expect(new Set([shown, again, collapsed, afterCollapse, readAgain].map((item) => item!.version)).size).toBe(5);
    expect(afterCollapse!.collapsed).toBe(true);
  });

  it("MountChanges_PoolHoldsAnEarlierViewsHighlight_DrawsTheLaterDiffWithoutMissingLines", async () => {
    const one = mounted();

    one.setRow(row.path, { data: data(earlier) });
    one.dispose();

    const two = mounted();

    two.setRow(row.path, { data: data(later) });

    const [before] = diffs(views.at(-2)!);
    const [after] = diffs(views.at(-1)!);
    // Pierre's pool, one for the page, holding the earlier diff's highlighted lines under its key, as its worker leaves them.
    const pool = new WorkerPoolManager({ workerFactory: () => inertWorker(), poolSize: 1 }, { theme: 'github-dark', langs: [] });

    vi.spyOn(pool, 'isWorkingPool').mockReturnValue(true);
    vi.spyOn(pool, 'shouldHighlightOnMainThread').mockReturnValue(false);
    // A diff the pool does not hold goes to a worker to be highlighted; none runs here.
    const dispatched = vi.spyOn(pool, 'highlightDiffAST').mockImplementation(() => {});

    const options = pool.getDiffRenderOptions();
    const highlighter = await getSharedHighlighter({ themes: ['github-dark'], langs: ['csharp'] });

    expect(pool.setDiffResultCache(before!.fileDiff.cacheKey, { result: renderDiffWithHighlighter(before!.fileDiff, highlighter, options), options })).toBe(true);

    const renderer = new DiffHunksRenderer({ theme: 'github-dark', diffStyle: 'split' }, undefined, undefined, pool);

    expect(() => renderer.renderDiff(after!.fileDiff)).not.toThrow();
    expect(dispatched).toHaveBeenCalledWith(renderer, after!.fileDiff);
  });
});
