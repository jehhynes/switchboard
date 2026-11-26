// The file view (architecture.md § Web page, File view): how the page draws one file, for the Changes tab's file view and local file tabs. Code
// and text go through the diff viewer's file mode at a line, a new version replacing the text in place so the view keeps where it is
// scrolled; Markdown, pictures and PDFs are drawn by the page as artifacts are. Each caller reads the file, decides what may be read and opened,
// and keeps where its views are scrolled; this module only draws.
import type { ComponentChild, VNode } from 'preact';
import { mount } from './island.js';
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

/** A Markdown file drawn as an artifact's is, a picture, or a PDF in a frame of the page; `html` is the Markdown's, already rendered with the caller's links. */
export function FileBody({ kind, name, html, rawUrl }: { kind: 'markdown' | 'image' | 'pdf'; name: string; html?: string | undefined; rawUrl?: string | undefined }): VNode {
  if (kind === 'image') {
    return <img class="media" alt={name} src={rawUrl} />;
  }

  if (kind === 'pdf') {
    return <iframe class="artifact-frame artifact-pdf" referrerpolicy="no-referrer" src={rawUrl} title={name}></iframe>;
  }

  return <div class="artifact-doc md-doc body">{trusted(html ?? '')}</div>;
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
