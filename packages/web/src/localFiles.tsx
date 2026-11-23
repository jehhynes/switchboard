// Local file links (architecture.md § Web page): a reply's or a status's link to a file or folder on this computer, relative to the session's
// working folder or a file: URI, often with #L<line>, opens in a closable tab of its own, as a diff does: Markdown drawn as an artifact is,
// pictures and PDFs in the page, code and text in the diff viewer's file view at the line, a folder as a list of its entries.
import type { ComponentChild, ComponentChildren, VNode } from 'preact';
import { FileIcon } from './fileIcons.js';

export { linkTarget, localFileUrl } from './localLinks.js';
export type { LocalFileData } from './localLinks.js';
import { mount } from './island.js';
import { linkTarget, localFileUrl, localMarkdown } from './localLinks.js';
import type { LocalFileData } from './localLinks.js';
import { trusted } from './trusted.js';
import { readVersion } from './readVersion.js';
import type { DiffModule, DiffMount } from './diff/types.js';

type LocalEntry = { state: 'loading' } | { state: 'ok'; data: LocalFileData; version: string } | { state: 'error'; error: string };

/** One file's tab: the target the link named, the line it named, and the file as read. */
export interface LocalTab {
  id: number;
  target: string;
  line: number | null;
  entry: LocalEntry;
}

export interface LocalFilesView {
  tabs: LocalTab[];
  /** The tab the file tab shows. */
  open: number | null;
}

/** The most file tabs a conversation keeps; opening another closes the oldest. */
export const LOCAL_TABS_MAX = 12;

const baseName = (path: string): string => path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path;

/** A tab's name: the file's, once read, else the last part of the target. */
function tabName(tab: LocalTab): string {
  return tab.entry.state === 'ok' ? tab.entry.data.name : baseName(tab.target);
}

/**
 * The file tabs, after the diff tabs and before the Changes button, each with its file's icon and a close mark, as a diff's tab is drawn; `push`
 * when no diff tab comes before them, so the first starts the strip's right-hand group.
 */
export function localTabs(files: LocalFilesView, shown: boolean, push: boolean): ComponentChildren {
  return files.tabs.map((tab, index) => {
    const selected = shown && tab.id === files.open;
    const name = tabName(tab);
    const dir = tab.entry.state === 'ok' && tab.entry.data.kind === 'dir';
    const title = tab.entry.state === 'ok' ? tab.entry.data.path : tab.target;

    return (
      <span class={`tab diff-tab local-tab${push && index === 0 ? ' push' : ''}${selected ? ' selected' : ''}`} role="presentation">
        <button class="tab-open" type="button" role="tab" data-action="local-tab" data-local={String(tab.id)} aria-selected={selected} tabindex={selected ? 0 : -1} title={tab.line === null ? title : `${title}:${tab.line}`}>
          {dir ? <span class="codicon codicon-folder" aria-hidden="true"></span> : <FileIcon path={name} />}
          <span class="tab-label">{name}</span>
        </button>
        <button class="tab-close" type="button" data-action="local-close" data-local={String(tab.id)} aria-label={`Close ${name}`} title="Close" tabindex={selected ? 0 : -1}>
          <span class="codicon codicon-close" aria-hidden="true"></span>
        </button>
      </span>
    );
  });
}

/** What the file tab says in place of the file: a read on its way, why it failed, a binary file or one too large. */
export function localNote(entry: LocalEntry): string | null {
  if (entry.state === 'loading') {
    return 'Reading the file…';
  }

  if (entry.state === 'error') {
    return entry.error;
  }

  if (entry.data.kind === 'binary') {
    return 'Binary file not shown.';
  }

  return entry.data.tooLarge ? 'This file is too large to show here.' : null;
}

export interface LocalFilesDeps {
  fetch: typeof fetch;
  /** The page key, null before the stream's hello. */
  key(): string | null;
  draw(): void;
  /** Shows the file tab, in the side column on a wide screen and in the conversation's strip on a narrower one. */
  show(): void;
  /** The last file tab closed while it showed: the strip shows another tab. */
  closed(): void;
  loadDiff(): Promise<DiffModule | null>;
  /** Empties a pane Preact drew into, before the file view draws into it itself. */
  takePane(pane: HTMLElement): void;
  /** Draws a Preact tree into a pane. */
  drawPane(pane: HTMLElement, tree: ComponentChild): void;
  /** Draws the Mermaid diagrams in a pane. */
  drawDiagrams(pane: HTMLElement): void;
}

/** The page's side of local file links: opens and closes their tabs, reads each file from the hub and draws the one shown. */
export class LocalFilesController {
  readonly view: LocalFilesView = { tabs: [], open: null };
  #for: string | null = null;
  #ids = 0;
  #module: Promise<DiffModule | null> | null = null;
  /** The file view on each host it draws into, dropped once its host leaves the page. */
  readonly #mounted = new Map<HTMLElement, DiffMount | null>();

  constructor(private readonly deps: LocalFilesDeps) {}

  /** Follows the page's work item (`followed` in main.ts): another one closes every file tab; a new session of the same one does not. */
  follow(id: string | null): void {
    if (id !== this.#for) {
      this.#for = id;
      this.view.tabs = [];
      this.view.open = null;
    }
  }

  /** The tab shown, while there is one. */
  shown(): LocalTab | null {
    return this.view.tabs.find((tab) => tab.id === this.view.open) ?? null;
  }

  /** Whether the tab shown draws the diff viewer's file view, which fills its pane edge to edge. */
  codeShown(): boolean {
    const tab = this.shown();

    return tab?.entry.state === 'ok' && tab.entry.data.kind === 'text' && tab.entry.data.contents !== null;
  }

  /** Opens a link's target in its own tab, or shows the tab it has, at the line the link names. */
  open(target: string, line: number | null): void {
    let tab = this.view.tabs.find((one) => one.target === target || (one.entry.state === 'ok' && one.entry.data.path === target));

    if (tab === undefined) {
      tab = { id: ++this.#ids, target, line, entry: { state: 'loading' } };
      this.view.tabs.push(tab);

      while (this.view.tabs.length > LOCAL_TABS_MAX) {
        this.view.tabs.shift();
      }

      void this.#read(tab);
    } else if (line !== null && line !== tab.line) {
      tab.line = line;
    }

    this.view.open = tab.id;
    this.deps.show();
  }

  /** Closes a tab; closing the one shown shows its neighbour, or another tab of the strip when it was the last. */
  close(id: number): void {
    const at = this.view.tabs.findIndex((tab) => tab.id === id);

    if (at === -1) {
      return;
    }

    this.view.tabs.splice(at, 1);

    if (this.view.open !== id) {
      this.deps.draw();
      return;
    }

    const next = this.view.tabs[at] ?? this.view.tabs[at - 1];

    this.view.open = next?.id ?? null;

    if (next === undefined) {
      this.deps.closed();
    } else {
      this.deps.draw();
    }
  }

  async #read(tab: LocalTab): Promise<void> {
    const key = this.deps.key();
    const conversation = this.#for;

    if (key === null) {
      tab.entry = { state: 'error', error: 'Switchboard is not connected.' };
      return;
    }

    let entry: LocalEntry;

    try {
      const response = await this.deps.fetch(localFileUrl(key, tab.target), { credentials: 'same-origin', cache: 'no-store' });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      entry = response.ok ? { state: 'ok', data: body as unknown as LocalFileData, version: readVersion() } : { state: 'error', error: String(body['error'] ?? `Switchboard answered ${response.status}.`) };
    } catch (failure) {
      entry = { state: 'error', error: `Switchboard did not answer: ${String(failure)}` };
    }

    // An answer for a tab closed since, or for a conversation the page has left, is dropped.
    if (conversation !== this.#for || !this.view.tabs.includes(tab)) {
      return;
    }

    tab.entry = entry;
    this.deps.draw();
  }

  /**
   * Handles a click on a local file link, a file tab or a folder's entry; false for any other click. A paired device's page opens links too: the
   * hub sends it only files in the session's working folder and its work item's checkouts, and says why it refuses any other (architecture.md § Remote access).
   */
  click(target: HTMLElement): boolean {
    const button = target.closest<HTMLElement>('[data-action]');
    const action = button?.dataset['action'];

    if (action === 'local-file') {
      const link = linkTarget(button!.dataset['target'] ?? '');

      if (link !== null) {
        this.open(link.path, link.line);
      }

      return true;
    }

    const id = Number(button?.dataset['local']);

    if (action === 'local-tab' && this.view.tabs.some((tab) => tab.id === id)) {
      this.view.open = id;
      this.deps.show();
      return true;
    }

    if (action === 'local-close') {
      this.close(id);
      return true;
    }

    if (action === 'local-entry') {
      this.open(button!.dataset['path'] ?? '', null);
      return true;
    }

    return false;
  }

  /** Draws the tab shown into a pane: the file view for code and text, else the page's own drawing of the file or folder. */
  draw(pane: HTMLElement): void {
    const tab = this.shown();
    const key = this.deps.key();

    if (tab === null || key === null) {
      return;
    }

    const note = localNote(tab.entry);

    if (note === null && tab.entry.state === 'ok' && tab.entry.data.kind === 'text') {
      this.#drawCode(pane, tab, tab.entry.data, tab.entry.version);
      return;
    }

    this.drop(true);
    this.deps.drawPane(pane, <LocalView key={`${tab.id}`} tab={tab} note={note} pageKey={key} />);
    this.deps.drawDiagrams(pane);
  }

  #drawCode(pane: HTMLElement, tab: LocalTab, data: LocalFileData, version: string): void {
    const id = `${tab.id}\u0000${version}\u0000${tab.line ?? ''}`;
    let view = pane.querySelector<HTMLElement>(':scope > .diff-view.local-code');

    if (view?.dataset['local'] === id) {
      return;
    }

    this.deps.takePane(pane);
    view = document.createElement('div');
    view.className = 'diff-view local-code';
    view.dataset['local'] = id;

    const host = document.createElement('div');
    const suffix = document.createElement('span');
    const say = (text: string): void => {
      const line = document.createElement('p');

      line.className = 'empty';
      line.textContent = text;
      host.replaceChildren(line);
    };

    suffix.className = 'diff-slot';
    host.className = 'diff-host file-view';
    view.append(host);
    pane.replaceChildren(view);
    this.drop();
    mount(suffix, tab.line === null ? null : <span class="diff-at">:{tab.line}</span>);
    this.#mounted.set(host, null);
    say('Loading the file viewer…');
    this.#module ??= this.deps.loadDiff();
    void this.#module.then((module) => {
      if (!this.#mounted.has(host) || !host.isConnected) {
        return;
      }

      if (module === null) {
        this.#module = null;
        say('The file viewer could not be loaded. Reload the page to try again.');
        return;
      }

      host.replaceChildren();
      this.#mounted.set(host, module.mountFile(host, { path: data.path, side: 'disk', contents: data.contents, binary: false, tooLarge: false }, version, { wrap: false, line: tab.line, suffix }));
    });
  }

  /** Ends the file views whose host has left the page, or every one with `all`. */
  drop(all = false): void {
    for (const [host, mounted] of this.#mounted) {
      if (all || !host.isConnected) {
        this.#mounted.delete(host);
        mounted?.dispose();
      }
    }
  }
}

function LocalView({ tab, note, pageKey }: { tab: LocalTab; note: string | null; pageKey: string }): VNode {
  const data = tab.entry.state === 'ok' ? tab.entry.data : null;
  const path = data?.path ?? tab.target;
  let body: ComponentChildren;

  if (note !== null || data === null) {
    body = <p class="empty">{note}</p>;
  } else if (data.kind === 'dir') {
    body = (
      <ul class="local-entries" aria-label={`Files in ${data.name}`}>
        {(data.entries ?? []).map((entry) => (
          <li>
            <button class="local-entry" type="button" data-action="local-entry" data-path={`${data.path.replace(/\/$/, '')}/${entry.name}`} title={entry.name}>
              {entry.dir ? <span class="codicon codicon-folder" aria-hidden="true"></span> : <FileIcon path={entry.name} />}
              <span class="local-entry-name">{entry.name}</span>
            </button>
          </li>
        ))}
        {(data.entries ?? []).length === 0 ? <li class="empty">This folder is empty.</li> : null}
        {data.more ? <li class="empty">Only the first {data.entries?.length} entries are listed.</li> : null}
      </ul>
    );
  } else if (data.kind === 'image') {
    body = <img class="media" alt={data.name} src={localFileUrl(pageKey, data.path, true)} />;
  } else if (data.kind === 'pdf') {
    body = <iframe class="artifact-frame artifact-pdf" referrerpolicy="no-referrer" src={localFileUrl(pageKey, data.path, true)} title={data.name}></iframe>;
  } else {
    body = <div class="artifact-doc md-doc body">{trusted(localMarkdown(pageKey, data))}</div>;
  }

  return (
    <div class="artifact-view local-view" data-local={String(tab.id)}>
      <div class="artifact-head">
        <span class="artifact-badge">{data?.kind === 'dir' ? 'folder' : (data?.kind ?? 'file')}</span>
        <span class="artifact-title" title={path}>
          {/* The title cuts its start, right to left; the path itself reads left to right, so `../a` stays `../a`. */}
          <bdi dir="ltr">
            {path}
            {tab.line === null ? null : `:${tab.line}`}
          </bdi>
        </span>
      </div>
      {body}
    </div>
  );
}
