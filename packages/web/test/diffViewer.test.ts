import { describe, expect, it, vi } from 'vitest';
import { diffItem, mountDiff, mountFile } from '../src/diff/viewer.js';

// Pierre's CodeView, recorded: the options each view is made and set with.
const views = vi.hoisted(() => [] as Array<{ options: Record<string, unknown>[] }>);

vi.mock('@pierre/diffs', async (actual) => ({
  ...(await actual<typeof import('@pierre/diffs')>()),
  CodeView: class {
    readonly options: Record<string, unknown>[];

    constructor(options: Record<string, unknown>) {
      this.options = [options];
      views.push(this);
    }

    setup(): void {}
    setItems(): void {}
    scrollTo(): void {}
    setSelectedLines(): void {}
    setOptions(options: Record<string, unknown>): void {
      this.options.push(options);
    }
    cleanUp(): void {}
  },
}));
vi.mock('@pierre/diffs/worker', () => ({ getOrCreateWorkerPoolSingleton: () => ({}) }));

const patch = ['diff --git a/a.ts b/a.ts', 'index 1111111..2222222 100644', '--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three', ''].join('\n');

describe("the diff viewer's item", () => {
  it("reads git's patch with both whole sides, taking out carriage returns the patch does not have", () => {
    const item = diffItem({ path: 'a.ts', status: 'M', patch, old: 'one\r\ntwo\r\nthree\r\n', new: 'one\nTWO\nthree\n', binary: false, tooLarge: null }, 'v1');

    expect(item).toMatchObject({ id: 'a.ts', type: 'diff' });
    expect(JSON.stringify(item)).not.toContain('\\r');
  });

  it('reads the patch alone when the hub left the sides out, and nothing for no patch or one that does not parse', () => {
    expect(diffItem({ path: 'a.ts', status: 'M', patch, old: null, new: null, binary: false, tooLarge: 'sides' }, 'v1')).toMatchObject({ type: 'diff' });
    expect(diffItem({ path: 'a.ts', status: 'M', patch: null, old: null, new: null, binary: true, tooLarge: null }, 'v1')).toBeNull();
    expect(diffItem({ path: 'a.ts', status: 'M', patch: 'not a patch', old: 'a', new: 'b', binary: false, tooLarge: null }, 'v1')).toBeNull();
  });
});

describe("the diff viewer's file header", () => {
  const header = (options: Record<string, unknown>, name: string): unknown => (options[name] as () => unknown)();

  it("puts the page's element after a diff's counts, and keeps it when the layout changes", () => {
    const meta = document.createElement('span');
    const mount = mountDiff(document.createElement('div'), { path: 'a.ts', status: 'M', patch, old: null, new: null, binary: false, tooLarge: null }, 'v1', { layout: 'split', wrap: false, meta })!;

    mount.set('stacked', true);

    const view = views.at(-1)!;

    expect(view.options.map((options) => header(options, 'renderHeaderMetadata'))).toEqual([meta, meta]);
    expect(view.options.map((options) => options['diffStyle'])).toEqual(['split', 'unified']);
  });

  it("puts the file view's Back before the name and its line after it, and keeps them when the wrapping changes", () => {
    const prefix = document.createElement('span');
    const suffix = document.createElement('span');
    const mount = mountFile(document.createElement('div'), { path: 'a.ts', side: 'disk', contents: 'x', binary: false, tooLarge: false }, 'v1', { wrap: false, line: null, prefix, suffix });

    mount.set('stacked', true);

    const view = views.at(-1)!;

    expect(view.options.map((options) => [header(options, 'renderHeaderPrefix'), header(options, 'renderHeaderFilenameSuffix')])).toEqual([
      [prefix, suffix],
      [prefix, suffix],
    ]);
  });
});
