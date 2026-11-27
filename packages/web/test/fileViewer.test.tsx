// The file viewer (fileView.tsx): one head and one body for every file the page shows, in a file tab, an artifact's tab or the Changes tab.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileHead, FileViews } from '../src/fileView.js';
import type { FileSpec, FileViewsDeps } from '../src/fileView.js';
import type { DiffModule, FileMountOptions, LineRange } from '../src/diff/types.js';
import { mount } from '../src/island.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A diff viewer whose file view writes its text, and keeps the options it was mounted with. */
function fakeModule() {
  const mounted: Array<{ contents: string; options: FileMountOptions }> = [];
  const module = {
    mountFile: (host: HTMLElement, data: { contents: string | null }, _version: string, options: FileMountOptions) => {
      mounted.push({ contents: data.contents ?? '', options });
      host.textContent = data.contents;
      return { set: () => {}, update: () => {}, dispose: () => {} };
    },
  } as unknown as DiffModule;

  return { module, mounted };
}

function viewer(patch: Partial<FileViewsDeps> = {}) {
  const { module, mounted } = fakeModule();
  const deps: FileViewsDeps = { loadDiff: async () => module, takePane: () => {}, draw: vi.fn(), drawDiagrams: vi.fn(), wrapped: () => false, toggleWrap: vi.fn(), quote: vi.fn(), now: () => 10 * 60_000, ...patch };

  return { views: new FileViews(deps), deps, mounted };
}

const spec = (patch: Partial<FileSpec> = {}): FileSpec => ({ id: 'file:D:/w/docs/plan.md', version: 'v1', kind: 'markdown', title: 'plan.md', path: 'D:/w/docs/plan.md', shown: 'docs/plan.md', line: null, changed: 60_000, contents: '# Plan', markdown: '<h1>Plan</h1>', note: null, open: { action: 'artifact-window' }, ...patch });

describe('the file viewer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('FileHead_EachKind_NamesItsTypeTitlePathAndTime', () => {
    const host = document.createElement('div');
    const named = (kind: Parameters<typeof FileHead>[0]['kind'], html = false) => {
      mount(host, <FileHead kind={kind} html={html} title="t" path="p" line={null} />);
      return host.querySelector('.artifact-type')!.getAttribute('aria-label');
    };

    expect([named('markdown'), named('code'), named('image'), named('pdf'), named('frame', true), named('frame'), named('audio'), named('video'), named('none'), named(null)]).toEqual(['Markdown document', 'Text or data', 'Picture', 'PDF', 'HTML page', 'Picture', 'Recording', 'Video', 'Other file', 'File']);

    mount(host, <FileHead kind="code" title="a.ts" path="src/a.ts" pathTitle="D:/w/src/a.ts" line={12} at=" at HEAD" changed={0} now={5 * 60_000} />);
    expect(host.querySelector('.artifact-title')!.textContent).toBe('a.ts');
    expect(host.querySelector('.file-path bdi')!.textContent).toBe('src/a.ts');
    expect(host.querySelector('.file-path .diff-at')!.textContent).toBe(':12 at HEAD');
    expect(host.querySelector('.file-name')!.getAttribute('title')).toBe('D:/w/src/a.ts:12');
    expect(host.querySelector('.artifact-age')!.textContent).toBe('5 min ago');
    // Copy path copies the full path; with no other tools there is nothing else.
    expect([...host.querySelectorAll<HTMLElement>('.file-tools [data-action]')].map((one) => [one.dataset['action'], one.dataset['path'] ?? null])).toEqual([['viewer-copy-path', 'D:/w/src/a.ts']]);
  });

  it('FileHead_Tools_ShowOnlyWhereTheyApplyInOneOrder', () => {
    const host = document.createElement('div');

    mount(host, <FileHead kind="markdown" title="a.md" path="a.md" line={null} quote={{ action: 'q' }} extra={<button data-action="extra" />} source={{ on: true, action: 's' }} wrap={{ on: true, action: 'w' }} open={{ action: 'artifact-window' }} />);
    expect([...host.querySelectorAll<HTMLElement>('.file-tools [data-action]')].map((one) => one.dataset['action'])).toEqual(['q', 'extra', 's', 'w', 'viewer-copy-path', 'artifact-window']);
    expect(host.querySelector('[data-action="s"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-action="artifact-window"]')!.getAttribute('data-title')).toBe('a.md');

    mount(host, <FileHead kind="image" title="a.png" path="a.png" line={null} copy={false} open={{ href: '/raw/a.png' }} />);
    expect(host.querySelector('[data-action="viewer-copy-path"]')).toBeNull();
    expect(host.querySelector('a[title="Open in new window"]')!.getAttribute('href')).toBe('/raw/a.png');
    expect(host.querySelector('a[title="Open in new window"]')!.getAttribute('target')).toBe('_blank');
  });

  it('FileViews_Markdown_TogglesBetweenItsPreviewAndItsSourceInTheCodeView', async () => {
    const pane = document.body.appendChild(document.createElement('div'));
    const { views, deps, mounted } = viewer();

    views.draw(pane, spec());
    expect(pane.querySelector('.file-viewer .file-body[data-mode="markdown"] .artifact-doc h1')!.textContent).toBe('Plan');
    expect(deps.drawDiagrams).toHaveBeenCalledTimes(1);

    expect(views.click(pane.querySelector('[data-action="viewer-source"]')!)).toBe(true);
    expect(views.source('file:D:/w/docs/plan.md')).toBe(true);
    expect(deps.draw).toHaveBeenCalledTimes(1);
    views.draw(pane, spec());
    await flush();
    expect(pane.querySelector('.file-body')!.getAttribute('data-mode')).toBe('code');
    expect(mounted.at(-1)!.contents).toBe('# Plan');
    expect(pane.querySelector('[data-action="viewer-wrap"]')).not.toBeNull();
    expect(pane.querySelector('[data-action="viewer-source"]')!.getAttribute('aria-pressed')).toBe('true');
    // Open in new window opens the preview as drawn, so the source offers none.
    expect(pane.querySelector('[data-action="artifact-window"]')).toBeNull();

    views.click(pane.querySelector('[data-action="viewer-source"]')!);
    views.draw(pane, spec());
    expect(pane.querySelector('.file-body[data-mode="markdown"] h1')!.textContent).toBe('Plan');
    expect(pane.querySelector('[data-action="viewer-wrap"]')).toBeNull();
  });

  it('FileViews_NewVersionOfAPreview_KeepsItsScroller', () => {
    const pane = document.body.appendChild(document.createElement('div'));
    const { views } = viewer();

    views.draw(pane, spec());
    const doc = pane.querySelector('.artifact-doc');

    views.draw(pane, spec({ version: 'v2', markdown: '<h1>Plan 2</h1>' }));
    expect(pane.querySelector('.artifact-doc')).toBe(doc);
    expect(doc!.textContent).toBe('Plan 2');
    // Another file draws a new view.
    views.draw(pane, spec({ id: 'file:D:/w/other.md' }));
    expect(pane.querySelector('.artifact-doc')).not.toBe(doc);
  });

  it('FileViews_LinesSelected_OffersQuoteWithTheirText', async () => {
    const pane = document.body.appendChild(document.createElement('div'));
    const { views, deps, mounted } = viewer();
    const code = spec({ id: 'file:D:/w/a.ts', kind: 'code', title: 'a.ts', path: 'D:/w/a.ts', shown: 'a.ts', contents: 'one\ntwo\nthree\nfour', markdown: undefined, open: null });

    views.draw(pane, code);
    await flush();
    await flush();
    expect(pane.querySelector('[data-action="viewer-quote"]')).toBeNull();
    mounted.at(-1)!.options.onSelect!({ start: 2, end: 3 } as LineRange);
    expect(deps.draw).toHaveBeenCalledTimes(1);
    views.draw(pane, code);
    views.click(pane.querySelector<HTMLElement>('[data-action="viewer-quote"]')!);
    expect(deps.quote).toHaveBeenCalledWith('D:/w/a.ts', 2, 3, ['two', 'three']);

    // A new version drawn in place is quoted as it is now, not as it was when the lines were selected.
    views.draw(pane, { ...code, version: 'v2', contents: 'one\nTWO\nTHREE\nfour' });
    views.click(pane.querySelector<HTMLElement>('[data-action="viewer-quote"]')!);
    expect(deps.quote).toHaveBeenLastCalledWith('D:/w/a.ts', 2, 3, ['TWO', 'THREE']);

    // The selection belongs to its view: another file shown offers no Quote.
    views.draw(pane, spec());
    expect(pane.querySelector('[data-action="viewer-quote"]')).toBeNull();
  });

  it('FileViews_RecordingVideoPageAndNote_DrawnInThePage', () => {
    const pane = document.body.appendChild(document.createElement('div'));
    const { views } = viewer();

    views.draw(pane, spec({ id: 'a', kind: 'audio', rawUrl: '/raw/a.mp3', contents: null }));
    expect(pane.querySelector('audio.media')!.getAttribute('src')).toBe('/raw/a.mp3');
    views.draw(pane, spec({ id: 'v', kind: 'video', rawUrl: '/raw/v.mp4', contents: null }));
    expect(pane.querySelector('video.media')!.getAttribute('src')).toBe('/raw/v.mp4');
    views.draw(pane, spec({ id: 'h', kind: 'frame', html: true, rawUrl: '/art/p.html', contents: null }));
    expect(pane.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts');
    views.draw(pane, spec({ id: 'n', note: 'Binary file not shown.' }));
    expect(pane.querySelector('.file-body .empty')!.textContent).toBe('Binary file not shown.');
    expect(pane.querySelector('[data-action="viewer-source"]')).toBeNull();
  });

  it('FileViews_CopyPath_CopiesTheFullPath', async () => {
    const writeText = vi.fn(async () => {});

    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const pane = document.body.appendChild(document.createElement('div'));
    const { views } = viewer();

    views.draw(pane, spec());
    expect(views.click(pane.querySelector<HTMLElement>('[data-action="viewer-copy-path"] .codicon')!)).toBe(true);
    expect(writeText).toHaveBeenCalledWith('D:/w/docs/plan.md');
  });
});
