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
import type { DiffModule, FileMount } from './diff/types.js';
import { filePath } from './tabs.js';

type LocalEntry = { state: 'loading' } | { state: 'ok'; data: LocalFileData; version: string; etag: string | null } | { state: 'error'; error: string };

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
export function localTabName(tab: LocalTab): string {
  return tab.entry.state === 'ok' ? tab.entry.data.name : baseName(tab.target);
}

/** A file's tab, after the artifact tabs and before Changes (tabs.ts), with its file's icon and a close mark. */
export function LocalTabButton({ tab, selected }: { tab: LocalTab; selected: boolean }) {
  const name = localTabName(tab);
  const dir = tab.entry.state === 'ok' && tab.entry.data.kind === 'dir';
  const title = tab.entry.state === 'ok' ? tab.entry.data.path : tab.target;

  return (
    <span class={`tab diff-tab local-tab${selected ? ' selected' : ''}`} role="presentation">
      <button class="tab-open" type="button" role="tab" data-action="local-tab" data-local={String(tab.id)} aria-selected={selected} tabindex={selected ? 0 : -1} title={tab.line === null ? title : `${title}:${tab.line}`}>
        {dir ? <span class="codicon codicon-folder" aria-hidden="true"></span> : <FileIcon path={name} />}
        <span class="tab-label">{name}</span>
      </button>
      <button class="tab-close" type="button" data-action="local-close" data-local={String(tab.id)} aria-label={`Close ${name}`} title="Close" tabindex={selected ? 0 : -1}>
        <span class="codicon codicon-close" aria-hidden="true"></span>
      </button>
    </span>
  );
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
  /** Opens a document's tab or shows the one it has (`openDoc` in main.ts): `file:<path>` at a line, or `artifact:<path>`; not `chosen` for a restore. */
  openDoc(id: string, line: number | null, chosen?: boolean): void;
  /** Whether the page shows the file tab now: the column's tab on a wide page, the conversation's on a narrower one. */
  fileShown(): boolean;
  /** Makes an artifact the column's choice in place of a file tab kept there but not shown, as on a narrow page, without changing what shows. */
  keepArtifact(path: string): void;
  /** Closes a tab and shows its neighbour when it showed (`closeDoc` in main.ts): `file:<path>`. */
  closeDoc(id: string): void;
  loadDiff(): Promise<DiffModule | null>;
  /** Empties a pane Preact drew into, before the file view draws into it itself. */
  takePane(pane: HTMLElement): void;
  /** Draws a Preact tree into a pane. */
  drawPane(pane: HTMLElement, tree: ComponentChild): void;
  /** Draws the Mermaid diagrams in a pane. */
  drawDiagrams(pane: HTMLElement): void;
  /** Whether the file tab is in view: the tab shown in its strip, on a page the operator can see. */
  inView(): boolean;
  /** What the page shows: its page key and scope generation, so an answer read for an earlier one, as before a reconnect or a change of session, is dropped. */
  shown(): string;
}

/** The page's side of local file links: opens and closes their tabs, reads each file from the hub and draws the one shown. */
export class LocalFilesController {
  readonly view: LocalFilesView = { tabs: [], open: null };
  #for: string | null = null;
  #ids = 0;
  #module: Promise<DiffModule | null> | null = null;
  /** The tabs a restore put back, until the operator opens one, whose giving way to an artifact is no choice of the operator's. */
  readonly #restored = new WeakSet<LocalTab>();
  /** The file view on each host it draws into, dropped once its host leaves the page. */
  readonly #mounted = new Map<HTMLElement, FileMount | null>();
  /** The tabs being read, so a tab is never read twice at once. */
  readonly #reading = new Set<LocalTab>();
  /** The tabs asked to be read again while a read was on its way: that read's answer is dropped and the tab read again at once. */
  readonly #newer = new WeakSet<LocalTab>();

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

  /**
   * Opens a link's target in its own tab, or shows the tab it has, read again, at the line the link names; a target the hub reads as an artifact
   * opens that artifact. Every open reads the file, so the hub checks it each time. Not `chosen` for a tab a restore puts back.
   */
  open(target: string, line: number | null, chosen = true): void {
    let tab = this.view.tabs.find((one) => one.target === target || (one.entry.state === 'ok' && one.entry.data.path === target));

    if (tab === undefined) {
      tab = { id: ++this.#ids, target, line, entry: { state: 'loading' } };
      this.view.tabs.push(tab);

      if (!chosen) {
        this.#restored.add(tab);
      }

      while (this.view.tabs.length > LOCAL_TABS_MAX) {
        this.view.tabs.shift();
      }

      void this.#read(tab);
    } else {
      if (line !== null && line !== tab.line) {
        tab.line = line;
      }

      if (chosen) {
        this.#restored.delete(tab);
      }

      void this.#read(tab, true);
    }

    this.view.open = tab.id;
    this.deps.show();
  }

  /** Shows a tab without opening it (`showDoc` in main.ts), read again. */
  select(id: number): void {
    const tab = this.view.tabs.find((one) => one.id === id);

    this.view.open = tab?.id ?? null;

    if (tab !== undefined) {
      void this.#read(tab, true);
    }
  }

  /** Removes the tab of a file, named by its path (`filePath`); `closeDoc` chooses what shows next. */
  remove(path: string): void {
    const at = this.view.tabs.findIndex((tab) => filePath(tab) === path);

    if (at !== -1 && this.view.open === this.view.tabs.splice(at, 1)[0]!.id) {
      this.view.open = null;
    }
  }

  /**
   * Reads the tab shown again while it is in view, so a file changed on disk shows its new version (architecture.md § Web page, Local files): after
   * a turn ends, on a reconnect and when the page shows, so a failed read tries again; and on every `poll`, which leaves a read on its way to
   * answer rather than asking for a newer one, so a slow hub still answers.
   */
  refresh(poll = false): void {
    const tab = this.shown();

    if (tab !== null && this.deps.inView()) {
      void this.#read(tab, true, !poll);
    }
  }

  /**
   * Reads a tab's file. `again` reads a tab already shown, sending the ETag it holds, so an unchanged file answers 304 and nothing is drawn; such a
   * read keeps what the tab shows when the hub does not answer or refuses for a reason other than the file being gone, as while it restarts, and
   * gives way to an artifact without the operator choosing it. A read asked for while another is on its way, unless by a poll (`newer` false),
   * waits for that read, drops its answer and is made then, so the answer shows the file as it is after the ask.
   */
  async #read(tab: LocalTab, again = false, newer = true): Promise<void> {
    const key = this.deps.key();
    const conversation = this.#for;

    if (this.#reading.has(tab)) {
      if (newer) {
        this.#newer.add(tab);
      }

      return;
    }

    if (again && tab.entry.state === 'loading') {
      return;
    }

    if (key === null) {
      if (!again) {
        tab.entry = { state: 'error', error: 'Switchboard is not connected.' };
      }

      return;
    }

    const etag = again && tab.entry.state === 'ok' ? tab.entry.etag : null;
    const shown = this.deps.shown();
    let entry: LocalEntry | null;

    this.#reading.add(tab);

    try {
      const response = await this.deps.fetch(localFileUrl(key, tab.target), { credentials: 'same-origin', cache: 'no-store', ...(etag === null ? {} : { headers: { 'If-None-Match': etag } }) });

      if (response.status === 304 || (again && !response.ok && response.status !== 404)) {
        entry = null;
      } else {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

        entry = response.ok ? { state: 'ok', data: body as unknown as LocalFileData, version: readVersion(), etag: response.headers?.get?.('ETag') ?? null } : { state: 'error', error: String(body['error'] ?? `Switchboard answered ${response.status}.`) };
      }
    } catch (failure) {
      entry = again ? null : { state: 'error', error: `Switchboard did not answer: ${String(failure)}` };
    } finally {
      this.#reading.delete(tab);
    }

    // A read asked for since, or a first read answered for what the page showed before, reads the file again now, dropping this answer.
    const asked = this.#newer.delete(tab);

    if (conversation === this.#for && this.view.tabs.includes(tab) && (asked || (shown !== this.deps.shown() && tab.entry.state === 'loading'))) {
      void this.#read(tab, tab.entry.state !== 'loading');
      return;
    }

    // An answer for a tab closed since, for a conversation the page has left or for what it showed before, is dropped, and a refusal read again changes nothing.
    if (entry === null || conversation !== this.#for || shown !== this.deps.shown() || !this.view.tabs.includes(tab) || (entry.state === 'error' && tab.entry.state === 'error' && entry.error === tab.entry.error)) {
      return;
    }

    // A file that is an artifact, or that another tab shows by another spelling, has one tab: the artifact's, or the other one.
    const data = entry.state === 'ok' ? entry.data : null;
    const same = data === null ? undefined : this.view.tabs.find((one) => one !== tab && one.entry.state === 'ok' && one.entry.data.path === data.path);

    if (data?.artifact !== undefined || same !== undefined) {
      const artifact = data?.artifact;
      const open = this.view.open === tab.id;
      // Only a tab the page shows takes the page to the tab it gives way to; one the operator has left gives way unseen.
      const seen = open && this.deps.fileShown();

      this.view.tabs.splice(this.view.tabs.indexOf(tab), 1);

      if (artifact === undefined && tab.line !== null) {
        same!.line = tab.line;
      }

      if (!open) {
        this.deps.draw();
      } else if (artifact !== undefined) {
        this.view.open = null;

        if (seen) {
          // A restored tab, or one read again, gives way without the operator choosing it.
          this.deps.openDoc(`artifact:${artifact}`, null, !again && !this.#restored.has(tab));
        } else {
          this.deps.keepArtifact(artifact);
        }
      } else {
        this.view.open = same!.id;

        if (seen) {
          this.deps.show();
        } else {
          this.deps.draw();
        }
      }

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
        this.deps.openDoc(`file:${link.path}`, link.line);
      }

      return true;
    }

    const tab = this.view.tabs.find((one) => one.id === Number(button?.dataset['local']));

    if (action === 'local-tab' && tab !== undefined) {
      this.deps.openDoc(`file:${filePath(tab)}`, null);
      return true;
    }

    if (action === 'local-close') {
      if (tab !== undefined) {
        this.deps.closeDoc(`file:${filePath(tab)}`);
      }

      return true;
    }

    if (action === 'local-entry') {
      this.deps.openDoc(`file:${button!.dataset['path'] ?? ''}`, null);
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
    const place = `${tab.id}\u0000${tab.line ?? ''}`;
    const id = `${place}\u0000${version}`;
    let view = pane.querySelector<HTMLElement>(':scope > .diff-view.local-code');

    if (view?.dataset['local'] === id) {
      return;
    }

    // A new version of the file shown replaces its text in the view, which keeps where it is scrolled to.
    const shown = view?.dataset['place'] === place ? view.querySelector<HTMLElement>(':scope > .diff-host') : null;
    const mounted = shown === null ? undefined : this.#mounted.get(shown);

    if (view != null && mounted != null) {
      mounted.update(data.contents ?? '', version);
      view.dataset['local'] = id;
      return;
    }

    this.deps.takePane(pane);
    view = document.createElement('div');
    view.className = 'diff-view local-code';
    view.dataset['local'] = id;
    view.dataset['place'] = place;

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

/** A picture's or PDF's bytes, with its modification time, so a new version loads again. */
function rawUrl(pageKey: string, data: LocalFileData): string {
  const url = localFileUrl(pageKey, data.path, true);

  return data.modified == null ? url : `${url}&v=${data.modified}`;
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
    body = <img class="media" alt={data.name} src={rawUrl(pageKey, data)} />;
  } else if (data.kind === 'pdf') {
    body = <iframe class="artifact-frame artifact-pdf" referrerpolicy="no-referrer" src={rawUrl(pageKey, data)} title={data.name}></iframe>;
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
