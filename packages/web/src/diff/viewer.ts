// The diff viewer (PRD R118, architecture.md § Web page), built as its own ES modules (build.mjs) that the page imports the first time a diff
// or a file shows, so nothing of it slows the page's first load: @pierre/diffs' CodeView over git's patch with both whole sides, so folded
// unchanged regions expand, highlighted by Shiki in a pool of workers with VS Code's Dark Modern and Light Modern colours.
import { CodeView, processFile, registerCustomTheme } from '@pierre/diffs';
import type { CodeViewDiffItem, CodeViewItem, CodeViewOptions, FileDiffMetadata } from '@pierre/diffs';
import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
import { largeReason } from '../changesWindow.js';
import type { ChangesMount, ChangesMountOptions, ChangesRowInput, DiffData, DiffMount, DiffMountOptions, FileData, FileMountOptions, RowContent } from './types.js';

registerCustomTheme('sb-dark-modern', () => import('./themes/sb-dark-modern.json').then((module) => module.default as never));
registerCustomTheme('sb-light-modern', () => import('./themes/sb-light-modern.json').then((module) => module.default as never));

const THEME = { dark: 'sb-dark-modern', light: 'sb-light-modern' } as const;
/**
 * The page's editor background under the code, its gutters and the file's header in both schemes, in place of the theme's own, so the viewer
 * matches the page around it; Pierre's `unsafe` layer comes after the theme's.
 */
const BACKGROUND_CSS =
  ':host { --diffs-light-bg: var(--vscode-editor-background); --diffs-dark-bg: var(--vscode-editor-background); }' +
  // VS Code's diff editor tints a changed line and its line number with diffEditor.insertedLineBackground (#9bb95533) or
  // removedLineBackground (#ff000033) over the editor, in Dark Modern and Light Modern alike. Pierre mixes a solid colour into the line's
  // background, 12 to 20 percent of it, so the same tint is the solid colour at 20 percent in both schemes.
  ' :is([data-line], [data-no-newline], [data-column-number], [data-gutter-buffer]):is([data-line-type="change-addition"], [data-line-type="change-deletion"]) { --mix-light: 80%; --mix-dark: 80%; }' +
  ' :is([data-line], [data-no-newline], [data-column-number], [data-gutter-buffer])[data-line-type="change-addition"] { --diffs-diff-line-mix-target: #9bb955; }' +
  ' :is([data-line], [data-no-newline], [data-column-number], [data-gutter-buffer])[data-line-type="change-deletion"] { --diffs-diff-line-mix-target: #ff0000; }';
/** Files longer than this many lines show uncoloured (`tokenizeMaxLength` counts lines), so a lock file never ties up the workers. */
export const TOKENIZE_MAX_LINES = 10_000;

let pool: WorkerPoolManager | undefined;

/** The highlighting workers, started once and shared by every view: without them a 3,000-line file holds the page for seconds. */
function workers(): WorkerPoolManager {
  pool ??= getOrCreateWorkerPoolSingleton({
    poolOptions: {
      workerFactory: () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
      poolSize: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)),
    },
    highlighterOptions: { theme: THEME, langs: [] },
  });
  return pool;
}

/** Shows text with no change marks when a side's text contains no carriage return, the patch git printed having none either. */
function lf(text: string, patch: string): string {
  return patch.includes('\r') ? text : text.replaceAll('\r\n', '\n');
}

/** The view's item for a file's diff: git's patch with both whole sides, or the patch alone when the hub left the sides out; null when it does not parse. */
export function diffItem(data: DiffData, version: string): CodeViewItem<undefined> | null {
  // git's patch for one file starts with its `diff --git` line; anything else is not one.
  if (data.patch === null || !data.patch.startsWith('diff --git ')) {
    return null;
  }

  // An added file's base and a deleted file's disk side are empty; with neither side the patch shows alone, its unchanged lines folded for good.
  const sides =
    data.old === null && data.new === null
      ? {}
      : {
          oldFile: { name: data.from ?? data.path, contents: lf(data.old ?? '', data.patch), cacheKey: `${version}:old` },
          newFile: { name: data.path, contents: lf(data.new ?? '', data.patch), cacheKey: `${version}:new` },
        };
  let fileDiff: FileDiffMetadata | undefined;

  try {
    fileDiff = processFile(data.patch, { ...sides, isGitDiff: true, cacheKey: version });
  } catch {
    fileDiff = undefined;
  }

  return fileDiff === undefined ? null : { id: data.path, type: 'diff', fileDiff };
}

function options(layout: 'split' | 'stacked', wrap: boolean): CodeViewOptions<undefined, undefined> {
  return {
    theme: THEME,
    themeType: 'system',
    diffStyle: layout === 'split' ? 'split' : 'unified',
    lineDiffType: 'word-alt',
    expandUnchanged: false,
    hunkSeparators: 'line-info',
    overflow: wrap ? 'wrap' : 'scroll',
    tokenizeMaxLength: TOKENIZE_MAX_LINES,
    stickyHeaders: true,
    unsafeCSS: BACKGROUND_CSS,
    enableLineSelection: true,
    layout: { paddingTop: 0, paddingBottom: 16, gap: 8 },
  };
}

/** Draws one file's diff into `host`; null when its patch does not parse, so the page says so rather than show something else. */
export function mountDiff(host: HTMLElement, data: DiffData, version: string, mount: DiffMountOptions): DiffMount | null {
  const item = diffItem(data, version);

  if (item === null) {
    return null;
  }

  const callbacks = {
    onLineNumberClick: (props: { lineNumber: number; annotationSide?: 'deletions' | 'additions' }) => mount.onLine?.(props.annotationSide === 'deletions' ? 'old' : 'new', props.lineNumber),
    renderHeaderMetadata: () => mount.meta ?? null,
  };
  const view = new CodeView<undefined, undefined>({ ...options(mount.layout, mount.wrap), ...callbacks } as CodeViewOptions<undefined, undefined>, workers());

  view.setup(host);
  view.setItems([item]);

  return {
    set: (layout, wrap) => view.setOptions({ ...options(layout, wrap), ...callbacks } as CodeViewOptions<undefined, undefined>),
    dispose: () => view.cleanUp(),
  };
}

/** Draws a whole file read-only into `host`, scrolled to `line` and with it selected (PRD R118's file view). */
export function mountFile(host: HTMLElement, data: FileData, version: string, mount: FileMountOptions): DiffMount {
  const callbacks = { renderHeaderPrefix: () => mount.prefix ?? null, renderHeaderFilenameSuffix: () => mount.suffix ?? null };
  const view = new CodeView<undefined, undefined>({ ...options('stacked', mount.wrap), ...callbacks }, workers());
  const item: CodeViewItem<undefined> = { id: data.path, type: 'file', file: { name: data.path, contents: data.contents ?? '', cacheKey: version } };

  view.setup(host);
  view.setItems([item]);

  if (mount.line !== null && mount.line > 0) {
    view.scrollTo({ type: 'line', id: data.path, lineNumber: mount.line, align: 'center', behavior: 'instant' });
    view.setSelectedLines({ id: data.path, range: { start: mount.line, end: mount.line } });
  }

  return { set: (_layout, wrap) => view.setOptions({ ...options('stacked', wrap), ...callbacks }), dispose: () => view.cleanUp() };
}

/** The most lines a placeholder is drawn with, so a huge file's placeholder does not stretch the scroll bar before its diff is read. */
export const PLACEHOLDER_MAX_LINES = 400;

/** About how many lines a row's diff takes, from its counts: the changed lines and three lines of context either side of each of about one hunk per 40 changed lines. */
export function placeholderLines(row: Pick<ChangesRowInput, 'additions' | 'deletions'>): number {
  const changed = (row.additions ?? 0) + (row.deletions ?? 0);
  const hunks = Math.min(10, Math.max(1, Math.ceil(changed / 40)));

  return Math.max(1, Math.min(changed + 6 * hunks, PLACEHOLDER_MAX_LINES));
}

/**
 * A patch of `lines` blank lines with the row's paths and kind, which the view draws in a row's place until its diff is read: an added file's
 * lines added, a deleted file's deleted, any other's unchanged, so it is as tall in either layout.
 */
export function placeholderPatch(row: Pick<ChangesRowInput, 'path' | 'from' | 'status'>, lines: number): string {
  // Fixed names, since a path git would quote (a tab, a newline) does not parse unquoted; the item takes the row's names after.
  const path = 'file';
  const from = row.from === undefined || row.from === row.path ? path : 'from';
  const head =
    row.status === 'A' || row.status === 'U'
      ? ['new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines} @@`]
      : row.status === 'D'
        ? ['deleted file mode 100644', `--- a/${path}`, '+++ /dev/null', `@@ -1,${lines} +0,0 @@`]
        : [...(from === path ? [] : ['similarity index 50%', `rename from ${from}`, `rename to ${path}`]), `--- a/${from}`, `+++ b/${path}`, `@@ -1,${lines} +1,${lines} @@`];
  const mark = row.status === 'A' || row.status === 'U' ? '+' : row.status === 'D' ? '-' : ' ';

  return [`diff --git a/${from} b/${path}`, ...head, ...Array.from({ length: lines }, () => mark), ''].join('\n');
}

/** What a row's drawn item is: its diff, a placeholder or a note; the view marks its element so the page's CSS can draw it so. */
export type ItemKind = { kind: 'diff'; path: string } | { kind: 'placeholder'; path: string; row: ChangesRowInput } | { kind: 'note'; path: string; row: ChangesRowInput };

/** The items the view draws, by their metadata, so the header callbacks and the post-render hook know which row and kind each is. */
export const kinds = new WeakMap<FileDiffMetadata, ItemKind>();

/** A drawn-only item: a placeholder of `lines` blank lines, or a note as its only line; whole (not partial), so nothing offers to expand it. */
export function syntheticItem(row: ChangesRowInput, kind: 'placeholder' | 'note', text: string, lines: number, version: number): CodeViewDiffItem<undefined> | null {
  const patch = kind === 'placeholder' ? placeholderPatch(row, lines) : placeholderPatch({ path: row.path, status: 'M' }, 1).replace(/\n \n$/, `\n ${text.replaceAll('\n', ' ')}\n`);
  let fileDiff: FileDiffMetadata | undefined;

  try {
    fileDiff = processFile(patch, { isGitDiff: true, cacheKey: `${kind} ${row.path} ${version}` });
  } catch {
    fileDiff = undefined;
  }

  if (fileDiff === undefined) {
    return null;
  }

  // The patch has fixed names, so the row's are set here; the patch is the whole of what it draws.
  fileDiff.name = row.path;
  fileDiff.isPartial = false;

  if (row.from !== undefined) {
    fileDiff.prevName = row.from;
  }

  kinds.set(fileDiff, { kind, path: row.path, row });
  return { id: row.path, type: 'diff', version, fileDiff };
}

/** The first and last of `count` rows, `top(index)` pixels down, that meet a view `height` pixels tall scrolled `scrollTop` down; null with none. */
export function visibleRange(count: number, top: (index: number) => number, scrollTop: number, height: number, total: number): { first: number; last: number } | null {
  if (count === 0) {
    return null;
  }

  // The first row whose bottom, the next row's top, is below the view's top.
  let low = 0;
  let high = count - 1;

  while (low < high) {
    const mid = (low + high) >> 1;
    const bottom = mid + 1 < count ? top(mid + 1) : total;

    if (bottom > scrollTop) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  const first = low;

  high = count - 1;

  // The last row whose top is above the view's bottom.
  while (low < high) {
    const mid = (low + high + 1) >> 1;

    if (top(mid) < scrollTop + height) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return { first, last: Math.max(first, low) };
}

/** Each kind's look inside Pierre's shadow DOM: a placeholder's text and counts hidden, its lines shimmering; a note's line plain and its number hidden. */
const CHANGES_CSS = `
:host([data-sb-item="placeholder"]) [data-deletions-count], :host([data-sb-item="placeholder"]) [data-additions-count],
:host([data-sb-item="note"]) [data-deletions-count], :host([data-sb-item="note"]) [data-additions-count],
:host([data-sb-item="note"]) [data-line-number-content], :host([data-sb-item="placeholder"]) [data-line-number-content] { visibility: hidden; }
:host([data-sb-item="placeholder"]) pre { animation: sb-loading 1.2s ease-in-out infinite alternate; }
:host([data-sb-item="placeholder"]) [data-line-type] { background: transparent !important; }
:host([data-sb-item="note"]) [data-line-type] { background: transparent !important; font-style: italic; color: var(--diffs-fg-number, inherit); font-family: var(--diffs-header-font-family, inherit); }
@keyframes sb-loading { from { opacity: 0.25; } to { opacity: 0.6; } }
@media (prefers-reduced-motion: reduce) { :host([data-sb-item="placeholder"]) pre { animation: none; opacity: 0.4; } }
`;

/** What a collapsed unread file says it is, briefly, so its name keeps the header's room; its tooltip says expanding reads it. */
const LARGE_SAYS = { binary: null, generated: 'generated', large: 'large' } as const;

/**
 * A placeholder's header suffix: the row's own counts, which its blank lines do not have, then that it is loading, or, collapsed and so not
 * read, nothing more unless it is a binary, generated or large file, which says so.
 */
function headerSuffix(fileDiff: FileDiffMetadata, collapsed: ReadonlySet<string>): Element | null {
  const kind = kinds.get(fileDiff);

  if (kind?.kind !== 'placeholder') {
    return null;
  }

  const span = document.createElement('span');
  const { additions, deletions, binary } = kind.row;
  const counts = [additions === null || (additions === 0 && (deletions ?? 0) > 0) ? null : `+${additions}`, deletions === null || deletions === 0 ? null : `−${deletions}`].filter((one) => one !== null);
  const reason = largeReason(kind.row);
  const said = reason === null ? null : LARGE_SAYS[reason];
  const state = collapsed.has(kind.path) ? (said === null ? [] : [said]) : ['Loading…'];

  span.className = 'sb-loading';

  if (reason !== null && collapsed.has(kind.path)) {
    span.title = `${reason === 'large' ? 'More than 1,500 changed lines' : reason === 'generated' ? 'A generated file' : 'A binary file'}: expand it to read its diff.`;
  }

  span.textContent = [...(binary ? ['binary'] : counts), ...state].join(' · ');
  return span;
}

/**
 * Draws every row of the Changes list into `host` as one scrolling view (PRD R118, architecture.md § Web page): each row a CodeView item, a
 * placeholder about its height until the page gives its diff, so the scroll bar covers the whole change from the start and a jump never waits
 * for the rows above. Pierre mounts only the items on screen and keeps the first visible line still when an item above changes height.
 */
export function mountChanges(host: HTMLElement, rows: ChangesRowInput[], mount: ChangesMountOptions): ChangesMount {
  let order: ChangesRowInput[] = rows;
  const versions = new Map<string, number>();
  const collapsed = new Set<string>();
  const items = new Map<string, CodeViewDiffItem<undefined>>();
  const bump = (path: string): number => {
    const next = (versions.get(path) ?? 0) + 1;

    versions.set(path, next);
    return next;
  };
  // A synthetic patch has fixed names, so it always parses.
  const placeholder = (row: ChangesRowInput, lines = placeholderLines(row)): CodeViewDiffItem<undefined> => syntheticItem(row, 'placeholder', '', lines, bump(row.path))!;
  const withCollapse = (item: CodeViewDiffItem<undefined>): CodeViewDiffItem<undefined> => ({ ...item, id: item.id, collapsed: collapsed.has(item.id) });
  const listeners: (() => void)[] = [];
  let frame = 0;
  const want = (): void => {
    if (frame === 0) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        listeners.forEach((listener) => listener());
      });
    }
  };
  const optionsFor = (layout: 'split' | 'stacked', wrap: boolean): CodeViewOptions<undefined, undefined> =>
    ({
      ...options(layout, wrap),
      unsafeCSS: BACKGROUND_CSS + CHANGES_CSS,
      loadDiffFiles: async (fileDiff: FileDiffMetadata) => {
        const path = [...items.values()].find((item) => item.fileDiff === fileDiff)?.id ?? (items.has(fileDiff.name) ? fileDiff.name : undefined);
        const data = path === undefined ? null : await mount.loadSides(path);

        if (data === null || data.patch === null || (data.old === null && data.new === null)) {
          throw new Error(`The whole of ${path ?? fileDiff.name} could not be read.`);
        }

        const newFile = { name: data.path, contents: lf(data.new ?? '', data.patch) };

        // Pierre takes a pure rename's new side alone.
        return fileDiff.type === 'rename-pure' ? { oldFile: null, newFile } : { oldFile: { name: data.from ?? data.path, contents: lf(data.old ?? '', data.patch) }, newFile };
      },
      renderHeaderFilenameSuffix: (fileDiff: FileDiffMetadata) => headerSuffix(fileDiff, collapsed),
      renderHeaderPrefix: (fileDiff: FileDiffMetadata) => {
        const path = kinds.get(fileDiff)?.path;

        return path === undefined ? null : (mount.headerPrefix?.(path) ?? null);
      },
      renderHeaderMetadata: (fileDiff: FileDiffMetadata) => {
        const path = kinds.get(fileDiff)?.path;

        return path === undefined ? null : (mount.headerMeta?.(path) ?? null);
      },
      onPostRender: (node: HTMLElement, instance: { fileDiff?: FileDiffMetadata }) => {
        const kind = instance.fileDiff === undefined ? undefined : kinds.get(instance.fileDiff);

        node.setAttribute('data-sb-item', kind?.kind ?? 'diff');
      },
      onLineNumberClick: (props: { lineNumber: number; annotationSide?: 'deletions' | 'additions' }, context: { item: { id: string } }) => mount.onLine?.(context.item.id, props.annotationSide === 'deletions' ? 'old' : 'new', props.lineNumber),
    }) as unknown as CodeViewOptions<undefined, undefined>;
  const view = new CodeView<undefined, undefined>(optionsFor(mount.layout, mount.wrap), workers());
  const unsubscribe = view.subscribeToScroll(want);
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(want) : null;
  const indexOf = (path: string): number => order.findIndex((row) => row.path === path);
  const top = (index: number): number => view.getTopForItem(order[index]!.path) ?? 0;
  const drawAll = (): void => view.setItems(order.map((row) => items.get(row.path)!));

  for (const row of order) {
    items.set(row.path, withCollapse(placeholder(row)));
  }

  // A click on a file's own header, but not on the page's controls in it, names the file (`onHeader`).
  const headerClick = (event: Event): void => {
    const trail = event.composedPath();

    if (trail.some((one) => one instanceof Element && one.matches('label, input, button, a')) || !trail.some((one) => one instanceof Element && one.hasAttribute('data-diffs-header'))) {
      return;
    }

    const item = view.getRenderedItems().find((one) => trail.includes(one.element));

    if (item !== undefined) {
      mount.onHeader?.(item.id);
    }
  };

  view.setup(host);
  resize?.observe(host);
  host.addEventListener('click', headerClick);
  drawAll();

  return {
    setRows(next) {
      const kept = new Set(next.map((row) => row.path));

      for (const path of [...items.keys()].filter((one) => !kept.has(one))) {
        items.delete(path);
        versions.delete(path);
        collapsed.delete(path);
      }

      order = next;

      for (const row of order) {
        if (!items.has(row.path)) {
          items.set(row.path, withCollapse(placeholder(row)));
        }
      }

      drawAll();
      want();
    },
    setRow(path, content: RowContent, lines) {
      const row = order.find((one) => one.path === path);

      if (row === undefined) {
        return;
      }

      let item: CodeViewDiffItem<undefined> | null;

      if (content === null) {
        item = placeholder(row, lines);
      } else if ('note' in content) {
        item = syntheticItem(row, 'note', content.note, 1, bump(path));
      } else {
        const version = bump(path);
        const read = diffItem(content.data, `${path} ${version}`) as CodeViewDiffItem<undefined> | null;

        if (read !== null) {
          kinds.set(read.fileDiff, { kind: 'diff', path });
        }

        item = read === null ? syntheticItem(row, 'note', "git's patch for this file could not be read.", 1, version) : { ...read, id: path, version };
      }

      if (item !== null) {
        item = withCollapse(item);
        items.set(path, item);
        view.updateItem(item);
      }
    },
    setCollapsed(path, value) {
      const item = items.get(path);

      if (value) {
        collapsed.add(path);
      } else {
        collapsed.delete(path);
      }

      if (item !== undefined && (item.collapsed === true) !== value) {
        const next = { ...item, collapsed: value, version: bump(path) };

        items.set(path, next);
        view.updateItem(next);
      }
    },
    scrollToFile(path) {
      if (items.has(path)) {
        view.scrollTo({ type: 'item', id: path, align: 'start', behavior: 'instant' });
        want();
      }
    },
    current() {
      const range = visibleRange(order.length, top, view.getScrollTop() + 1, 1, view.getScrollHeight());

      return range === null ? null : order[range.first]!.path;
    },
    visible() {
      // Nothing is on screen while the view has no size (a tab not shown yet, or before layout), and never more than the window shows, so a
      // host that grew with its content does not count every row as on screen.
      const height = Math.min(host.clientHeight, typeof innerHeight === 'number' && innerHeight > 0 ? innerHeight : host.clientHeight);

      return height <= 0 ? null : visibleRange(order.length, top, view.getScrollTop(), height, view.getScrollHeight());
    },
    onWant(listener) {
      listeners.push(listener);
    },
    heightOf(path) {
      const index = indexOf(path);

      return index === -1 ? undefined : (index + 1 < order.length ? top(index + 1) : view.getScrollHeight()) - top(index);
    },
    linesFor(pixels) {
      const lineHeight = parseFloat(getComputedStyle(host).getPropertyValue('--diffs-line-height')) || 19;

      // Less the header and the gap after it.
      return Math.max(1, Math.round((pixels - 52) / lineHeight));
    },
    set: (layout, wrap) => view.setOptions(optionsFor(layout, wrap)),
    dispose: () => {
      cancelAnimationFrame(frame);
      host.removeEventListener('click', headerClick);
      unsubscribe();
      resize?.disconnect();
      view.cleanUp();
    },
  };
}
