import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeViewDiffItem } from '@pierre/diffs';

/** Every CodeView the viewer makes, with what it was given. */
const views: FakeView[] = [];

class FakeView {
  items: CodeViewDiffItem<undefined>[] = [];
  updates: CodeViewDiffItem<undefined>[] = [];
  scrolls: unknown[] = [];
  options: Record<string, unknown>;
  tops = new Map<string, number>();
  scrollTop = 0;
  scrollListener: (() => void) | null = null;
  cleaned = false;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    views.push(this);
  }

  setup(): void {}
  setItems(items: CodeViewDiffItem<undefined>[]): void {
    this.items = [...items];
  }
  updateItem(item: CodeViewDiffItem<undefined>): boolean {
    this.updates.push(item);
    this.items = this.items.map((one) => (one.id === item.id ? item : one));
    return true;
  }
  setOptions(options: Record<string, unknown>): void {
    this.options = options;
  }
  scrollTo(target: unknown): void {
    this.scrolls.push(target);
  }
  subscribeToScroll(listener: () => void): () => void {
    this.scrollListener = listener;
    return () => (this.scrollListener = null);
  }
  getTopForItem(id: string): number | undefined {
    return this.tops.get(id);
  }
  getScrollTop(): number {
    return this.scrollTop;
  }
  getScrollHeight(): number {
    return 3000;
  }
  rendered: Array<{ id: string; element: HTMLElement }> = [];
  getRenderedItems(): Array<{ id: string; element: HTMLElement }> {
    return this.rendered;
  }
  cleanUp(): void {
    this.cleaned = true;
  }
}

vi.mock('@pierre/diffs', async (original) => ({ ...(await original<typeof import('@pierre/diffs')>()), CodeView: FakeView }));
vi.mock('@pierre/diffs/worker', () => ({ getOrCreateWorkerPoolSingleton: () => ({}) }));

const { kinds, mountChanges, placeholderLines, placeholderPatch, syntheticItem, visibleRange, PLACEHOLDER_MAX_LINES } = await import('../src/diff/viewer.js');
const { processFile } = await import('@pierre/diffs');

const patch = ['diff --git a/b.ts b/b.ts', 'index 1111111..2222222 100644', '--- a/b.ts', '+++ b/b.ts', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three', ''].join('\n');
const row = (path: string, status = 'M', additions: number | null = 3, deletions: number | null = 1) => ({ path, status, additions, deletions, binary: additions === null });

beforeEach(() => {
  views.length = 0;
});

describe("the Changes tab's placeholders", () => {
  it('PlaceholderLines_FromCounts_AddsContextPerHunkAndCapsAt400', () => {
    expect(placeholderLines({ additions: 3, deletions: 1 })).toBe(4 + 6);
    expect(placeholderLines({ additions: 100, deletions: 0 })).toBe(100 + 6 * 3);
    expect(placeholderLines({ additions: null, deletions: null })).toBe(6);
    expect(placeholderLines({ additions: 5000, deletions: 5000 })).toBe(PLACEHOLDER_MAX_LINES);
  });

  it('PlaceholderPatch_ForEachStatus_ParsesAsThatKindWithTheGivenLines', () => {
    const parse = (status: string, from?: string) => processFile(placeholderPatch({ path: 'dir/a b.ts', status, ...(from === undefined ? {} : { from }) }, 7), { isGitDiff: true })!;
    // A path git would quote parses too, since the patch does not carry it.
    const odd = syntheticItem({ ...row('a\tb\nc.ts', 'R'), from: 'x\ny.ts' }, 'placeholder', '', 3, 1)!;

    expect(odd.fileDiff).toMatchObject({ name: 'a\tb\nc.ts', prevName: 'x\ny.ts', type: 'rename-changed', unifiedLineCount: 3 });

    expect(parse('A')).toMatchObject({ type: 'new', unifiedLineCount: 7 });
    expect(parse('U')).toMatchObject({ type: 'new' });
    expect(parse('D')).toMatchObject({ type: 'deleted', unifiedLineCount: 7 });
    expect(parse('M')).toMatchObject({ type: 'change', unifiedLineCount: 7, splitLineCount: 7 });
    expect(parse('R', 'old/a.ts')).toMatchObject({ type: 'rename-changed' });
  });

  it('SyntheticItem_ForAPlaceholderOrANote_IsWholeNamedByTheRowAndMarked', () => {
    const shown = syntheticItem({ ...row('x.ts', 'R'), from: 'y.ts' }, 'placeholder', '', 12, 4)!;

    expect(shown).toMatchObject({ id: 'x.ts', type: 'diff', version: 4, fileDiff: { name: 'x.ts', prevName: 'y.ts', isPartial: false } });
    expect(kinds.get(shown.fileDiff)).toMatchObject({ kind: 'placeholder' });

    const note = syntheticItem(row('x.ts'), 'note', 'Binary file not shown.', 1, 5)!;

    expect(note.fileDiff.additionLines.join('')).toContain('Binary file not shown.');
    expect(kinds.get(note.fileDiff)).toMatchObject({ kind: 'note' });
  });
});

describe('visibleRange', () => {
  const tops = [0, 100, 300, 600];
  const top = (index: number) => tops[index]!;

  it('VisibleRange_ForAScrolledView_NamesTheRowsItMeets', () => {
    expect(visibleRange(4, top, 0, 50, 1000)).toEqual({ first: 0, last: 0 });
    expect(visibleRange(4, top, 150, 200, 1000)).toEqual({ first: 1, last: 2 });
    expect(visibleRange(4, top, 650, 200, 1000)).toEqual({ first: 3, last: 3 });
    expect(visibleRange(4, top, 99, 2, 1000)).toEqual({ first: 0, last: 1 });
  });

  it('VisibleRange_WithNoRows_IsNull', () => {
    expect(visibleRange(0, top, 0, 100, 0)).toBeNull();
  });
});

describe('mountChanges', () => {
  const mounted = (rows = [row('a.ts'), row('b.ts'), row('c.png', 'M', null, null)], host = document.createElement('div')) => {
    const onHeader = vi.fn();
    const headerPrefix = (path: string) => Object.assign(document.createElement('span'), { textContent: `prefix ${path}` });
    const loadSides = vi.fn(async (path: string) => ({ path, status: 'M', patch, old: 'one\ntwo\nthree\n', new: 'one\nTWO\nthree\n', binary: false, tooLarge: null }));
    const onLine = vi.fn();
    const mount = mountChanges(host, rows, { layout: 'split', wrap: false, loadSides, onLine, onHeader, headerPrefix });

    return { mount, view: views.at(-1)!, loadSides, onLine, onHeader, host };
  };

  it('MountChanges_WithRows_DrawsEachAsAPlaceholderInOrder', () => {
    const { view } = mounted();

    expect(view.items.map((item) => item.id)).toEqual(['a.ts', 'b.ts', 'c.png']);
    expect(view.items.every((item) => kinds.get(item.fileDiff)?.kind === 'placeholder')).toBe(true);
    expect(view.items[0]!.fileDiff.unifiedLineCount).toBe(placeholderLines({ additions: 3, deletions: 1 }));
  });

  it('SetRow_WithADiffANoteOrNull_BumpsTheVersionEachTime', () => {
    const { mount, view } = mounted();
    const first = view.items[1]!.version!;

    mount.setRow('b.ts', { data: { path: 'b.ts', status: 'M', patch, old: null, new: null, binary: false, tooLarge: null, partial: true } });
    mount.setRow('b.ts', { note: 'Binary file not shown.' });
    mount.setRow('b.ts', null, 30);
    mount.setRow('gone.ts', null);

    expect(view.updates.map((item) => [item.id, item.version, kinds.get(item.fileDiff)?.kind])).toEqual([
      ['b.ts', first + 1, 'diff'],
      ['b.ts', first + 2, 'note'],
      ['b.ts', first + 3, 'placeholder'],
    ]);
    expect(view.updates[0]!.fileDiff.isPartial).toBe(true);
    expect(view.updates[2]!.fileDiff.unifiedLineCount).toBe(30);
  });

  it('SetRow_WithAPatchThatDoesNotParse_ShowsWhyInItsPlace', () => {
    const { mount, view } = mounted();

    mount.setRow('a.ts', { data: { path: 'a.ts', status: 'M', patch: 'not a patch', old: null, new: null, binary: false, tooLarge: null } });
    expect(kinds.get(view.updates[0]!.fileDiff)?.kind).toBe('note');
    expect(view.updates[0]!.fileDiff.additionLines.join('')).toContain("git's patch for this file could not be read.");
  });

  it('SetCollapsed_OnARow_KeepsItCollapsedAcrossLaterContent', () => {
    const { mount, view } = mounted();

    mount.setCollapsed('a.ts', true);
    mount.setCollapsed('a.ts', true);
    expect(view.updates).toHaveLength(1);
    expect(view.updates[0]).toMatchObject({ id: 'a.ts', collapsed: true });

    mount.setRow('a.ts', { note: 'x' });
    expect(view.updates[1]).toMatchObject({ id: 'a.ts', collapsed: true });

    mount.setCollapsed('a.ts', false);
    expect(view.updates[2]).toMatchObject({ id: 'a.ts', collapsed: false });
  });

  it('SetRows_WithANewList_KeepsKnownRowsAndAddsPlaceholders', () => {
    const { mount, view } = mounted();

    mount.setRow('a.ts', { note: 'kept' });

    const kept = view.items[0];

    mount.setRows([row('z.ts'), row('a.ts')]);
    expect(view.items.map((item) => item.id)).toEqual(['z.ts', 'a.ts']);
    expect(view.items[1]).toBe(kept);
  });

  it('LoadDiffFiles_ForAPartialDiff_ReadsBothSidesOfThatRow', async () => {
    const { mount, view, loadSides } = mounted();

    mount.setRow('b.ts', { data: { path: 'b.ts', status: 'M', patch, old: null, new: null, binary: false, tooLarge: null, partial: true } });

    const load = view.options['loadDiffFiles'] as (fileDiff: unknown) => Promise<unknown>;

    await expect(load(view.updates[0]!.fileDiff)).resolves.toEqual({ oldFile: { name: 'b.ts', contents: 'one\ntwo\nthree\n' }, newFile: { name: 'b.ts', contents: 'one\nTWO\nthree\n' } });
    expect(loadSides).toHaveBeenCalledWith('b.ts');

    // A pure rename's loader gives its new side alone, which Pierre's hydration takes.
    const { hydratePartialDiff } = await import('@pierre/diffs');
    const pure = processFile(['diff --git a/old.ts b/b.ts', 'similarity index 100%', 'rename from old.ts', 'rename to b.ts', ''].join('\n'), { isGitDiff: true })!;
    const loaded = (await load(pure)) as never;

    expect(loaded).toEqual({ oldFile: null, newFile: { name: 'b.ts', contents: 'one\nTWO\nthree\n' } });
    expect(() => hydratePartialDiff('merge', pure, loaded)).not.toThrow();

    loadSides.mockResolvedValueOnce(null as never);
    await expect(load(view.updates[0]!.fileDiff)).rejects.toThrow('could not be read');
  });

  it('Callbacks_FromPierre_NameTheRowAndMarkItsKind', () => {
    const { mount, view, onLine } = mounted();
    const node = document.createElement('div');
    const placeholder = view.items[0]!.fileDiff;

    (view.options['onPostRender'] as (node: HTMLElement, instance: unknown) => void)(node, { fileDiff: placeholder });
    expect(node.getAttribute('data-sb-item')).toBe('placeholder');
    expect((view.options['renderHeaderFilenameSuffix'] as (diff: unknown) => Element)(placeholder).textContent).toBe('+3 · −1 · Loading…');
    expect((view.options['renderHeaderFilenameSuffix'] as (diff: unknown) => Element | null)(view.items[2]!.fileDiff)!.textContent).toBe('binary · Loading…');
    // A collapsed file is not read, so it does not say it is loading.
    mount.setCollapsed('a.ts', true);
    expect((view.options['renderHeaderFilenameSuffix'] as (diff: unknown) => Element)(view.updates.at(-1)!.fileDiff).textContent).toBe('+3 · −1');
    mount.setCollapsed('a.ts', false);

    mount.setRow('a.ts', { note: 'x' });
    expect((view.options['renderHeaderFilenameSuffix'] as (diff: unknown) => Element | null)(view.updates.at(-1)!.fileDiff)).toBeNull();

    (view.options['onLineNumberClick'] as (props: unknown, context: unknown) => void)({ lineNumber: 4, annotationSide: 'deletions' }, { item: { id: 'b.ts' } });
    expect(onLine).toHaveBeenCalledWith('b.ts', 'old', 4);
  });

  it('Navigation_OverTheRows_FollowsPierresTops', () => {
    const { mount, view } = mounted();

    view.tops = new Map([['a.ts', 0], ['b.ts', 500], ['c.png', 900]]);
    view.scrollTop = 600;
    expect(mount.current()).toBe('b.ts');
    expect(mount.heightOf('b.ts')).toBe(400);
    expect(mount.heightOf('c.png')).toBe(2100);
    expect(mount.heightOf('nope')).toBeUndefined();

    mount.scrollToFile('c.png');
    mount.scrollToFile('nope');
    expect(view.scrolls).toEqual([{ type: 'item', id: 'c.png', align: 'start', behavior: 'instant' }]);
    expect(mount.linesFor(52 + 19 * 10)).toBe(10);

    mount.set('stacked', true);
    expect(view.options).toMatchObject({ diffStyle: 'unified', overflow: 'wrap' });
    mount.dispose();
    expect(view.cleaned).toBe(true);
  });

  it('HeaderClick_AwayFromThePagesControls_NamesTheFile', () => {
    const { view, onHeader, host, mount } = mounted();
    const element = document.createElement('div');
    const header = document.createElement('div');
    const button = document.createElement('button');
    const body = document.createElement('div');

    header.setAttribute('data-diffs-header', 'default');
    header.append(button);
    element.append(header, body);
    host.append(element);
    view.rendered = [{ id: 'b.ts', element }];

    header.click();
    button.click();
    body.click();
    expect(onHeader.mock.calls).toEqual([['b.ts']]);
    expect((view.options['renderHeaderPrefix'] as (diff: unknown) => Element | null)(view.items[1]!.fileDiff)!.textContent).toBe('prefix b.ts');

    mount.dispose();
    header.click();
    expect(onHeader).toHaveBeenCalledTimes(1);
  });

  it('Visible_WithNoHeightOrTallerThanTheWindow_IsNullOrCut', () => {
    const host = document.createElement('div');
    const { mount, view } = mounted(undefined, host);

    view.tops = new Map([['a.ts', 0], ['b.ts', 500], ['c.png', 900]]);
    // Not laid out yet: nothing is on screen, so nothing is read.
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 0 });
    expect(mount.visible()).toBeNull();
    // A host as tall as its content counts only what the window shows.
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 3000 });
    vi.stubGlobal('innerHeight', 400);
    expect(mount.visible()).toEqual({ first: 0, last: 0 });
    vi.unstubAllGlobals();
  });

  it('Tints_OfChangedLines_AreVsCodesLineBackgroundsAtFullStrength', () => {
    const { view } = mounted();
    const css = String(view.options['unsafeCSS']);

    // Pierre mixes 12 to 20 percent of a solid colour into a line; 20 percent of VS Code's colours is its 0x33 alpha over the editor.
    expect(css).toContain('--mix-light: 80%; --mix-dark: 80%;');
    expect(css).toContain('[data-line-type="change-addition"] { --diffs-diff-line-mix-target: #9bb955; }');
    expect(css).toContain('[data-line-type="change-deletion"] { --diffs-diff-line-mix-target: #ff0000; }');
    expect(css).toContain('--diffs-dark-bg: var(--vscode-editor-background)');
  });

  it('HeaderSuffix_ForACollapsedLargeFile_SaysWhyAndHowToRead', () => {
    const { mount, view } = mounted([row('a.ts'), row('package-lock.json', 'M', 5, 5), row('c.png', 'M', null, null)]);
    const suffix = (index: number) => (view.options['renderHeaderFilenameSuffix'] as (diff: unknown) => Element)(view.updates.at(index)!.fileDiff).textContent;

    mount.setCollapsed('package-lock.json', true);
    expect(suffix(-1)).toBe('+5 · −5 · generated');
    expect((view.options['renderHeaderFilenameSuffix'] as (diff: unknown) => HTMLElement)(view.updates.at(-1)!.fileDiff).title).toBe('A generated file: expand it to read its diff.');
    mount.setCollapsed('c.png', true);
    expect(suffix(-1)).toBe('binary');
    mount.setCollapsed('a.ts', true);
    expect(suffix(-1)).toBe('+3 · −1');
  });
});
