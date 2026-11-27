// The file viewer (architecture.md § Web page, File viewer): the one way the page draws a file, whether a file tab, an artifact's tab or the
// Changes tab shows it. A head names the file by its type's icon, its title and its path, with when it changed and its tools; under it code and
// text go through the diff viewer's file mode at a line, a new version replacing the text in place so the view keeps where it is scrolled, and
// Markdown, pictures, PDFs, pages, recordings and videos are drawn by the page. Each caller reads the file and decides what may be read and
// opened; this module draws, and keeps a view's Source and selected lines.
import type { ComponentChild, ComponentChildren, VNode } from 'preact';
import { fullTime } from '@switchboard/conversation/messageMeta';
import { mount, unmount } from './island.js';
import { ago } from './render.js';
import { showToast } from './toast.js';
import { trusted } from './trusted.js';
import type { DiffModule, FileMount, LineRange } from './diff/types.js';

/** A file of code or text as the diff viewer's file view draws it. */
export interface CodeInput {
  /** The file and line shown: a new `version` of the same place replaces the text in place, any other place draws a new view. */
  place: string;
  version: string;
  path: string;
  /** Which side of a change the file is, as the viewer's data names it; disk by default. */
  side?: 'disk' | 'base';
  contents: string;
  line: number | null;
  wrap: boolean;
  /** What the file's header shows before its name, after it, and at its end; drawn again on every draw. */
  prefix?: ComponentChild;
  suffix?: ComponentChild;
  meta?: ComponentChild;
  /** False to draw no header, where the caller shows the file's name itself; drawn by default. */
  header?: boolean;
  /** Lines selected by dragging over their numbers, or null when the selection is cleared. */
  onSelect?(range: LineRange | null): void;
}

interface Mounted {
  mount: FileMount | null;
  slots: { prefix: HTMLElement; suffix: HTMLElement; meta: HTMLElement };
}

function slot(): HTMLElement {
  const element = document.createElement('span');

  element.className = 'diff-slot';
  return element;
}

/** Says `text` in a host in place of the file. */
export function sayIn(host: HTMLElement, text: ComponentChild): void {
  const line = document.createElement('p');

  line.className = 'empty';
  host.replaceChildren(line);
  mount(line, text);
}

/**
 * Draws code into a container through the diff viewer's file mode, loading the viewer on first use: `container > .<wrapper> > .diff-host`, or
 * `container > .diff-host` without a wrapper. One instance per caller; it ends the views whose host has left the page (`drop`).
 */
export class CodeDraw {
  readonly #mounted = new Map<HTMLElement, Mounted>();
  #module: Promise<DiffModule | null> | null = null;

  constructor(private readonly deps: { loadDiff(): Promise<DiffModule | null>; takePane?(pane: HTMLElement): void }) {}

  draw(container: HTMLElement, input: CodeInput, wrapper: string | null): void {
    const id = `${input.place}\u0000${input.version}`;
    const selector = wrapper === null ? ':scope > .diff-host' : `:scope > .${wrapper.split(' ').join('.')}`;
    let view = container.querySelector<HTMLElement>(selector);
    const host = view === null ? null : wrapper === null ? view : view.querySelector<HTMLElement>(':scope > .diff-host');
    const kept = host === null ? undefined : this.#mounted.get(host);

    if (kept !== undefined) {
      mount(kept.slots.prefix, input.prefix ?? null);
      mount(kept.slots.suffix, input.suffix ?? null);
      mount(kept.slots.meta, input.meta ?? null);
      kept.mount?.set('stacked', input.wrap);
    }

    if (view?.dataset['file'] === id) {
      return;
    }

    // A new version of the file shown replaces its text in the view, which keeps where it is scrolled to.
    if (view !== null && view.dataset['place'] === input.place && kept?.mount != null) {
      kept.mount.update(input.contents, input.version);
      view.dataset['file'] = id;
      return;
    }

    this.deps.takePane?.(container);

    const made = document.createElement('div');

    made.className = 'diff-host file-view';

    if (wrapper === null) {
      view = made;
    } else {
      view = document.createElement('div');
      view.className = wrapper;
      view.append(made);
    }

    view.dataset['file'] = id;
    view.dataset['place'] = input.place;
    container.replaceChildren(view);
    this.drop();

    const slots = { prefix: slot(), suffix: slot(), meta: slot() };
    const entry: Mounted = { mount: null, slots };

    mount(slots.prefix, input.prefix ?? null);
    mount(slots.suffix, input.suffix ?? null);
    mount(slots.meta, input.meta ?? null);
    this.#mounted.set(made, entry);
    sayIn(made, [input.prefix ?? null, 'Loading the file viewer…']);
    this.#module ??= this.deps.loadDiff();
    void this.#module.then((module) => {
      if (this.#mounted.get(made) !== entry || !made.isConnected) {
        return;
      }

      if (module === null) {
        this.#module = null;
        sayIn(made, [input.prefix ?? null, 'The file viewer could not be loaded. Reload the page to try again.']);
        return;
      }

      made.replaceChildren();
      entry.mount = module.mountFile(made, { path: input.path, side: input.side ?? 'disk', contents: input.contents, binary: false, tooLarge: false }, input.version, {
        wrap: input.wrap,
        line: input.line,
        ...(input.header === false ? { header: false } : {}),
        ...(input.prefix === undefined ? {} : { prefix: slots.prefix }),
        suffix: slots.suffix,
        ...(input.meta === undefined ? {} : { meta: slots.meta }),
        ...(input.onSelect === undefined ? {} : { onSelect: input.onSelect }),
      });
    });
  }

  /** Ends the views whose host has left the page, or every one with `all`. */
  drop(all = false): void {
    for (const [host, kept] of this.#mounted) {
      if (all || !host.isConnected) {
        this.#mounted.delete(host);
        kept.mount?.dispose();
      }
    }
  }
}

/** How the viewer shows a file: code and text, Markdown, a picture, a PDF, a page or SVG in a sandboxed frame, a recording, a video, or none. */
export type ViewKind = 'code' | 'markdown' | 'image' | 'pdf' | 'frame' | 'audio' | 'video' | 'none';

/** A kind's name for the head's icon, and its codicon. */
export function viewType(kind: ViewKind, html = false): { name: string; icon: string } {
  switch (kind) {
    case 'markdown':
      return { name: 'Markdown document', icon: 'markdown' };
    case 'frame':
      return html ? { name: 'HTML page', icon: 'globe' } : { name: 'Picture', icon: 'file-media' };
    case 'image':
      return { name: 'Picture', icon: 'file-media' };
    case 'audio':
      return { name: 'Recording', icon: 'unmute' };
    case 'video':
      return { name: 'Video', icon: 'device-camera-video' };
    case 'pdf':
      return { name: 'PDF', icon: 'file-pdf' };
    case 'code':
      return { name: 'Text or data', icon: 'file-text' };
    case 'none':
      return { name: 'Other file', icon: 'file-binary' };
  }
}

/** A file's body when the page draws it: Markdown as an artifact's is, a picture, a PDF, a page in a frame sandboxed to scripts, a recording or a video; `html` is the Markdown's, already rendered with the caller's links. */
export function FileBody({ kind, name, html, rawUrl }: { kind: Exclude<ViewKind, 'code' | 'none'>; name: string; html?: string | null | undefined; rawUrl?: string | undefined }): VNode {
  switch (kind) {
    case 'image':
      return <img class="media" alt={name} src={rawUrl} />;
    case 'pdf':
      return <iframe class="artifact-frame artifact-pdf" referrerpolicy="no-referrer" src={rawUrl} title={name}></iframe>;
    case 'frame':
      return <iframe class="artifact-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" src={rawUrl} title={name}></iframe>;
    case 'audio':
      return <audio class="media" controls preload="metadata" src={rawUrl}></audio>;
    case 'video':
      return <video class="media" controls preload="metadata" src={rawUrl}></video>;
    case 'markdown':
      return <div class="artifact-doc md-doc body">{html === undefined ? <p class="empty">Loading…</p> : html === null ? <p class="empty">This file could not be read.</p> : trusted(html)}</div>;
  }
}

/** Where Open in new window goes: a file's own address in a browser tab, or the page's action that opens a Markdown document as drawn. */
export type OpenTarget = { href: string } | { action: string };

/** What a file's head shows and offers. */
export interface HeadInput {
  kind: ViewKind | null;
  /** Whether a `frame` is an HTML page rather than an SVG. */
  html?: boolean;
  /** An artifact's reported title, or the file's name. */
  title: string;
  /** The path as shown, worktree-relative inside the worktree, else absolute; `pathTitle` the full path for the tooltip and Copy path. */
  path: string;
  pathTitle?: string;
  line: number | null;
  /** The revision a Changes view shows, as " at HEAD", null on disk. */
  at?: string | null;
  /** When the file changed, epoch milliseconds, and the time to count from. */
  changed?: number | null;
  now?: number;
  /** The tools, each an action the caller handles, or left out where it does not apply. */
  quote?: { action: string; view?: string } | null;
  source?: { on: boolean; action: string; view?: string } | null;
  wrap?: { on: boolean; action: string; className?: string } | null;
  /** Tools of the caller's own, as the Changes tab's Diff, before Source. */
  extra?: ComponentChildren;
  copy?: boolean;
  open?: OpenTarget | null;
}

function HeadButton({ action, icon, label, pressed, data = {} }: { action: string; icon: string; label: string; pressed?: boolean; data?: Record<string, string> }): VNode {
  return (
    <button class="icon" type="button" data-action={action} {...data} title={label} aria-label={label} aria-pressed={pressed}>
      <span class={`codicon codicon-${icon}`} aria-hidden="true"></span>
    </button>
  );
}

/**
 * A file's head, the same wherever the file shows: its type's icon, named for screen readers, its title, its path with the line and revision
 * after it, cut at its start, when it changed, with the full time as its tooltip, then Quote while lines are selected, the caller's tools,
 * Source, Wrap, Copy path and Open in new window. Drawn as the children of the caller's row: an artifact view's head or the Changes tab's bar.
 */
export function FileHead(input: HeadInput): VNode {
  const type = input.kind === null ? { name: 'File', icon: 'file' } : viewType(input.kind, input.html);
  const full = input.pathTitle ?? input.path;
  const view = (one: { view?: string }): Record<string, string> => (one.view === undefined ? {} : { 'data-view': one.view });

  return (
    <>
      <span class={`codicon codicon-${type.icon} artifact-type`} role="img" aria-label={type.name} title={type.name}></span>
      <span class="file-name" title={input.line === null ? full : `${full}:${input.line}`}>
        <span class="artifact-title">{input.title}</span>
        {/* The path cuts its start, right to left; the path itself reads left to right, so `../a` stays `../a`. */}
        <span class="file-path">
          <bdi dir="ltr">{input.path}</bdi>
          {input.line === null && input.at == null ? null : (
            <span class="diff-at">
              {input.line === null ? null : `:${input.line}`}
              {input.at == null ? null : <span class="diff-from">{input.at}</span>}
            </span>
          )}
        </span>
      </span>
      {input.changed == null ? null : (
        <time class="artifact-age" dateTime={new Date(input.changed).toISOString()} title={fullTime(input.changed)}>
          {ago(input.changed, input.now ?? Date.now())}
        </time>
      )}
      <span class="file-tools">
        {input.quote == null ? null : <HeadButton action={input.quote.action} icon="quote" label="Quote the selected lines in the message" data={view(input.quote)} />}
        {input.extra}
        {input.source == null ? null : <HeadButton action={input.source.action} icon="code" label={input.source.on ? 'Show the preview' : 'Show the source'} pressed={input.source.on} data={view(input.source)} />}
        {input.wrap == null ? null : <WrapButton wrapped={input.wrap.on} action={input.wrap.action} className={input.wrap.className ?? 'icon'} />}
        {input.copy === false ? null : <HeadButton action="viewer-copy-path" icon="copy" label="Copy path" data={{ 'data-path': full }} />}
        {input.open == null ? null : 'href' in input.open ? (
          <a class="icon" href={input.open.href} target="_blank" rel="noopener noreferrer" title="Open in new window" aria-label="Open in new window">
            <span class="codicon codicon-link-external" aria-hidden="true"></span>
          </a>
        ) : (
          <HeadButton action={input.open.action} icon="link-external" label="Open in new window" data={{ 'data-title': input.title }} />
        )}
      </span>
    </>
  );
}

/** Copies a file's path (`viewer-copy-path`), saying in the toast whether it was copied. */
export function copyPath(path: string): void {
  void (navigator.clipboard?.writeText(path) ?? Promise.reject(new Error('no clipboard'))).then(
    () => showToast('Copied the path.', 'info'),
    () => showToast('The path could not be copied.'),
  );
}

/** A file as a file tab or an artifact's tab shows it (`FileViews.draw`). */
export interface FileSpec {
  /** The tab it shows in, as `file:<path>` or `artifact:<path>`: another id draws a new view; Source and the selection are kept by it. */
  id: string;
  /** The version shown: a new one draws the body again, code in place. */
  version: string;
  kind: ViewKind;
  html?: boolean;
  title: string;
  /** The file's path, which names its language and its quotes; `shown`, the path the head shows. */
  path: string;
  shown: string;
  line: number | null;
  changed: number | null;
  /** Code's or Markdown's text, null when it is not read. */
  contents: string | null;
  /** Markdown's preview, undefined while it is read, null when it could not be. */
  markdown?: string | null | undefined;
  rawUrl?: string;
  /** What shows in place of the body: a read on its way, why it failed, a binary file or one too large. */
  note?: string | null;
  open?: OpenTarget | null;
  /** The artifact the view shows, for `data-artifact`, which keeps its reader's place. */
  artifact?: string;
}

export interface FileViewsDeps {
  loadDiff(): Promise<DiffModule | null>;
  /** Empties a pane Preact drew into, before the viewer draws into it itself. */
  takePane(pane: HTMLElement): void;
  draw(): void;
  drawDiagrams(element: HTMLElement): void;
  /** Whether code wraps in a pane, and the choice that toggles it (`viewer-wrap`). */
  wrapped(pane: HTMLElement | null): boolean;
  toggleWrap(wrapped: boolean): void;
  /** Quotes lines of a file in the message being written. */
  quote(path: string, start: number, end: number, lines: string[]): void;
  now(): number;
}

/**
 * The file tabs' and artifact tabs' viewer: it draws a file into a pane as `.artifact-view.file-viewer`, its head, then its body, and keeps
 * which views show their source and the lines selected in the one shown. One instance per page.
 */
export class FileViews {
  readonly #code: CodeDraw;
  readonly #source = new Set<string>();
  #selection: { id: string; path: string; range: LineRange } | null = null;
  /** The text each code view shows now, which a quote reads, so a new version drawn in place is quoted as it is. */
  readonly #texts = new Map<string, string>();

  constructor(private readonly deps: FileViewsDeps) {
    this.#code = new CodeDraw({ loadDiff: () => deps.loadDiff() });
  }

  /** Whether a view shows its Markdown's source. */
  source(id: string): boolean {
    return this.#source.has(id);
  }

  draw(pane: HTMLElement, spec: FileSpec): void {
    let view = pane.querySelector<HTMLElement>(':scope > .file-viewer');

    if (view === null || view.dataset['view'] !== spec.id) {
      this.deps.takePane(pane);
      view = document.createElement('div');
      view.className = 'artifact-view file-viewer';
      view.dataset['view'] = spec.id;

      const head = document.createElement('div');
      const body = document.createElement('div');

      head.className = 'artifact-head';
      body.className = 'file-body';
      view.append(head, body);
      pane.replaceChildren(view);
      this.#code.drop();
    }

    if (spec.artifact === undefined) {
      delete view.dataset['artifact'];
    } else {
      view.dataset['artifact'] = spec.artifact;
    }

    view.dataset['version'] = spec.version;

    const head = view.querySelector<HTMLElement>(':scope > .artifact-head')!;
    const body = view.querySelector<HTMLElement>(':scope > .file-body')!;
    const source = spec.kind === 'markdown' && spec.contents !== null && this.#source.has(spec.id);
    const mode = spec.note != null ? 'note' : spec.kind === 'code' || source ? 'code' : spec.kind;
    const wrap = this.deps.wrapped(pane);
    const selected = this.#selection?.id === spec.id && mode === 'code';

    if (!selected && this.#selection?.id === spec.id) {
      this.#selection = null;
    }

    mount(
      head,
      <FileHead
        kind={spec.kind}
        html={spec.html ?? false}
        title={spec.title}
        path={spec.shown}
        pathTitle={spec.path}
        line={spec.line}
        changed={spec.changed}
        now={this.deps.now()}
        quote={selected ? { action: 'viewer-quote', view: spec.id } : null}
        source={spec.kind === 'markdown' && spec.contents !== null && spec.note == null ? { on: source, action: 'viewer-source', view: spec.id } : null}
        wrap={mode === 'code' ? { on: wrap, action: 'viewer-wrap' } : null}
        open={source ? null : (spec.open ?? null)}
      />,
    );

    if (mode === 'code') {
      if (body.dataset['mode'] !== 'code') {
        unmount(body);
        body.replaceChildren();
        body.dataset['mode'] = 'code';
      }

      const contents = spec.contents ?? '';

      this.#texts.clear();
      this.#texts.set(spec.id, contents);

      const onSelect = (range: LineRange | null): void => {
        const was = this.#selection?.id === spec.id;

        this.#selection = range === null ? (was ? null : this.#selection) : { id: spec.id, path: spec.path, range };

        if (was !== (range !== null)) {
          this.deps.draw();
        }
      };

      this.#code.draw(body, { place: `${spec.id}\x00${spec.line ?? ''}\x00${source ? 'source' : ''}`, version: spec.version, path: spec.path, contents, line: spec.line, wrap, header: false, onSelect }, 'diff-view local-code');
      return;
    }

    if (body.dataset['mode'] === 'code') {
      body.replaceChildren();
      this.#code.drop();
    }

    const drawn = body.dataset['mode'] !== mode || body.dataset['version'] !== spec.version;

    body.dataset['mode'] = mode;
    body.dataset['version'] = spec.version;
    mount(body, mode === 'note' ? <p class="empty">{spec.note}</p> : mode === 'none' ? <p class="empty">This kind of file cannot be shown here. Open it in a new window.</p> : <FileBody kind={mode as Exclude<ViewKind, 'code' | 'none'>} name={spec.title} html={spec.markdown} rawUrl={spec.rawUrl} />);

    if (mode === 'markdown' && drawn) {
      this.deps.drawDiagrams(body);
    }
  }

  /** Handles a click on a viewer's tools: Source, Wrap, Quote and Copy path; false for any other click. */
  click(target: HTMLElement): boolean {
    const button = target.closest<HTMLElement>('[data-action]');
    const action = button?.dataset['action'];

    if (action === 'viewer-source') {
      const id = button!.dataset['view'] ?? '';

      this.#source.has(id) ? this.#source.delete(id) : this.#source.add(id);
      this.#selection = null;
      this.deps.draw();
      return true;
    }

    if (action === 'viewer-wrap') {
      // The opposite of what the view shows, kept on this device for the Changes tab's diffs too.
      this.deps.toggleWrap(this.deps.wrapped(button!.closest<HTMLElement>('.diff-pane')));
      this.deps.draw();
      return true;
    }

    if (action === 'viewer-quote') {
      const selection = this.#selection;

      if (selection !== null && selection.id === button!.dataset['view']) {
        const { start, end } = selection.range;

        this.deps.quote(selection.path, start, end, (this.#texts.get(selection.id) ?? '').split('\n').slice(start - 1, end));
      }

      return true;
    }

    if (action === 'viewer-copy-path') {
      copyPath(button!.dataset['path'] ?? '');
      return true;
    }

    return false;
  }

  /** Ends the code views whose host has left the page, or every one with `all`. */
  drop(all = false): void {
    this.#code.drop(all);
  }
}

/** Wrap, pressed while long lines wrap, at the end of a file view's header. */
export function WrapButton({ wrapped, action, className = 'diff-wrap', disabled }: { wrapped: boolean; action: string; className?: string; disabled?: boolean }): VNode {
  const label = wrapped ? 'Do not wrap long lines' : 'Wrap long lines';

  return (
    <button class={className} type="button" data-action={action} title={label} aria-label={label} aria-pressed={wrapped} disabled={disabled}>
      <span class="codicon codicon-word-wrap" aria-hidden="true"></span>
    </button>
  );
}
