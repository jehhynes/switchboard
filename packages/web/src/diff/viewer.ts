// The diff viewer (PRD R118, architecture.md § Web page), built as its own ES modules (build.mjs) that the page imports the first time a diff
// or a file shows, so nothing of it slows the page's first load: @pierre/diffs' CodeView over git's patch with both whole sides, so folded
// unchanged regions expand, highlighted by Shiki in a pool of workers with VS Code's Dark Modern and Light Modern colours.
import { CodeView, processFile, registerCustomTheme } from '@pierre/diffs';
import type { CodeViewItem, CodeViewOptions, FileDiffMetadata } from '@pierre/diffs';
import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
import type { DiffData, DiffMount, DiffMountOptions, FileData, FileMountOptions } from './types.js';

registerCustomTheme('sb-dark-modern', () => import('./themes/sb-dark-modern.json').then((module) => module.default as never));
registerCustomTheme('sb-light-modern', () => import('./themes/sb-light-modern.json').then((module) => module.default as never));

const THEME = { dark: 'sb-dark-modern', light: 'sb-light-modern' } as const;
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
