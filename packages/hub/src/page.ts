import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { hostKey, isFolderHost } from '@switchboard/core';
import { artifactType } from '@switchboard/conversation';
import { windowOf } from './dock.js';
import type { DockRow, DockView } from './dock.js';
import type { RowGroup } from './rows.js';
import type { Snapshot } from './snapshot.js';

/** The cookie a page holds once it exchanged its one-time link (architecture.md § Web page). */
export const PAGE_COOKIE = 'sb_page';
/** How long a page link can be opened. */
export const PAGE_LINK_MS = 2 * 60_000;
/** The most page cookies kept; the oldest is dropped past it. */
const PAGE_COOKIES_KEPT = 20;

/**
 * The web page's credential (architecture.md § Web page): a one-time token in a link, which the page exchanges for a cookie it cannot read.
 * Both live in the hub's memory only, so a restarted hub needs a new link.
 */
export class PageAccess {
  readonly #tokens = new Map<string, number>();
  readonly #cookies: string[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** A new one-time token, good for `PAGE_LINK_MS`. */
  token(): string {
    const token = randomBytes(32).toString('hex');

    for (const [old, until] of this.#tokens) {
      if (until < this.now()) {
        this.#tokens.delete(old);
      }
    }

    this.#tokens.set(token, this.now() + PAGE_LINK_MS);
    return token;
  }

  /** The cookie value for a token not used yet and not expired, which it uses up; null otherwise. */
  exchange(token: string): string | null {
    const until = this.#tokens.get(token);

    this.#tokens.delete(token);

    if (until === undefined || until < this.now()) {
      return null;
    }

    const cookie = randomBytes(32).toString('hex');

    this.#cookies.push(cookie);

    if (this.#cookies.length > PAGE_COOKIES_KEPT) {
      this.#cookies.shift();
    }

    return cookie;
  }

  /** Whether a request's Cookie header carries a page cookie this hub gave out. */
  allows(header: string | undefined): boolean {
    const given = cookieValue(header, PAGE_COOKIE);

    if (given === null) {
      return false;
    }

    const bytes = Buffer.from(given);

    return this.#cookies.some((cookie) => {
      const known = Buffer.from(cookie);

      return known.length === bytes.length && timingSafeEqual(known, bytes);
    });
  }
}

/** A cookie's value from a Cookie header, or null. */
export function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');

    if (key === name) {
      return value.join('=');
    }
  }

  return null;
}

/**
 * One group of the page's list (architecture.md § Web page): an item work item with the ad hoc conversations its window hosts, or the
 * conversations hosted by a folder or by an item window whose work item is not listed. `ids` lists the work items, a work item group's own
 * first.
 */
export interface PageGroup {
  kind: 'item' | 'folder' | 'window';
  title: string;
  ids: number[];
}

/**
 * The page's list: every work item that is not done, and `keep` when it is, each hosted conversation under its host, the newest group first and the hosted
 * conversations newest first after their host.
 */
export function pageGroups(snapshot: Snapshot, windows: string, keep: number | null = null): PageGroup[] {
  // A page's selected work item stays in its group when it is done, as a window keeps a selected conversation until another is selected.
  const open = snapshot.workItems.filter((item) => item.status !== 'done' || item.id === keep);
  const groups = new Map<string, PageGroup & { newest: number }>();
  const hostOf = new Map<string, string>();

  for (const item of [...open].sort((a, b) => b.id - a.id)) {
    if (item.ticket.hostWindow != null) {
      continue;
    }

    groups.set(`item:${item.id}`, { kind: 'item', title: item.ticket.title, ids: [item.id], newest: item.id });

    const file = windowOf(item, windows)?.file ?? null;

    // The newest work item of a window is its host, as the window's primary is.
    if (file !== null && !hostOf.has(hostKey(file))) {
      hostOf.set(hostKey(file), `item:${item.id}`);
    }
  }

  for (const item of [...open].sort((a, b) => b.id - a.id)) {
    const host = item.ticket.hostWindow ?? null;

    if (host === null) {
      continue;
    }

    const folder = isFolderHost(host);
    const key = (folder ? undefined : hostOf.get(hostKey(host))) ?? `${folder ? 'folder' : 'window'}:${hostKey(host)}`;
    const group = groups.get(key) ?? { kind: folder ? 'folder' : 'window', title: folder ? basename(host) || host : basename(host).replace(/\.code-workspace$/i, ''), ids: [], newest: item.id };

    group.ids.push(item.id);
    group.newest = Math.max(group.newest, item.id);
    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) => b.newest - a.newest).map(({ kind, title, ids }) => ({ kind, title, ids }));
}

/** A row of the page's list: the dock row's line 1 and line 2, its mark and its stripe (architecture.md § Web page). */
export interface PageRow {
  workItemId: number;
  title: string;
  /** The ticket's key, such as `gh 18941`, and its source's plugin, which colours its pill as the dock's. */
  ticket: string;
  sourceKind: string;
  playbook: string;
  mark: DockRow['mark'];
  stripe: DockRow['stripe'];
  /** A Ready for review row on the agent's turn, dimmed as the dock dims it. */
  dim: boolean;
  /** A hosted conversation's host: its folder's or its window's name; null for other work items. */
  host: string | null;
  /** The dock's controls the page offers for the row, in the dock's menu order (architecture.md § Web page). */
  actions: PageAction[];
  /** The label of the control the dock shows as the row's button, when the page offers it; else null. */
  main: string | null;
  /** The labels of the drafted texts Copy offers (PRD R60); the files stay in the hub. */
  pastes: string[];
}

/** The dock's actions the page may run through `row-action`, each on one work item. */
export const PAGE_ACTIONS = ['start', 'approve', 'retry', 'stop', 'mark-done', 'snooze', 'restore', 'delete'] as const;
export type PageActionType = (typeof PAGE_ACTIONS)[number];

/** One control the page offers: its dock label, the action it runs, and what the page asks first. */
export interface PageAction {
  label: string;
  action: PageActionType;
  confirm: { question: string; detail: string; action: string } | null;
}

/** The dock's state controls, which its menu lists after the work controls. */
const STATE_ACTIONS = new Set<string>(['mark-done', 'snooze', 'restore']);

/**
 * The page's controls for a dock row: the dock's hub controls whose action is in `PAGE_ACTIONS` and that ask for no text, in the dock's menu
 * order (the row's button, its work, its state, then the controls that ask first). Stop asks first on the page, as Delete does in the dock.
 */
export function pageActions(row: Pick<DockRow, 'controls' | 'main' | 'ticket'>): PageAction[] {
  const offered = row.controls.filter((control) => (PAGE_ACTIONS as readonly string[]).includes(String(control.action['type'])) && control.input === undefined && control.group === undefined);
  const shown = (control: DockRow['controls'][number]): PageAction => {
    const action = String(control.action['type']) as PageActionType;
    const confirm = control.confirm ?? (action === 'stop' ? { question: `Stop ${row.ticket}?`, detail: 'Switchboard stops its running session, and the work item waits for you as Stopped by you.', action: 'Stop' } : null);

    return { label: control.label, action, confirm };
  };
  const main = offered.filter((control) => control.label === row.main && control.confirm === undefined);
  const rest = offered.filter((control) => !main.includes(control));
  const work = rest.filter((control) => control.confirm === undefined && !STATE_ACTIONS.has(String(control.action['type'])));
  const state = rest.filter((control) => control.confirm === undefined && STATE_ACTIONS.has(String(control.action['type'])));
  const asking = rest.filter((control) => control.confirm !== undefined);

  return [...main, ...work, ...state, ...asking].map(shown);
}

/**
 * The action `row-action` posts for a work item's dock row: the hub's own control's action, never the page's, with Snooze's `until` and
 * `comment`; null when the row no longer offers it.
 */
export function pageActionEvent(row: Pick<DockRow, 'controls' | 'main' | 'ticket'>, action: string, snooze: { until: number | null; comment: string | null }): Record<string, unknown> | null {
  if (!pageActions(row).some((one) => one.action === action)) {
    return null;
  }

  const control = row.controls.find((one) => one.action['type'] === action && one.input === undefined && one.group === undefined)!;

  return action === 'snooze' ? { ...control.action, until: snooze.until, ...(snooze.comment === null ? {} : { comment: snooze.comment }) } : { ...control.action };
}

/** A drafted text as Copy puts it on the clipboard: the file as it is now, without a byte order mark or trailing whitespace (PRD R60). */
export async function pasteText(file: string): Promise<string> {
  return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '').trimEnd();
}

/** A group of the page's list: one of the dock's groups, with its codicon glyph. */
export interface PageListGroup {
  key: RowGroup;
  title: string;
  glyph: string;
  /** What the group says when it has no rows, or null. */
  empty: string | null;
  rows: PageRow[];
}

/** A host's name: a folder's last segment, or a workspace file's name without `.code-workspace`. */
function hostTitle(host: string): string {
  return isFolderHost(host) ? basename(host) || host : basename(host).replace(/\.code-workspace$/i, '');
}

/**
 * The page's list (architecture.md § Web page): the dock's groups in the dock's order, with its titles, glyphs and empty texts, holding the
 * dock's work item rows where the dock puts them, hosted conversations included (every conversation is a work item); pool tickets, which have
 * no conversation, are left out.
 */
export function pageList(dock: Pick<DockView, 'groups'>, snapshot: Pick<Snapshot, 'workItems'>): PageListGroup[] {
  const items = new Map(snapshot.workItems.map((item) => [item.id, item]));
  return dock.groups.map((group) => {
    const rows: PageRow[] = [];

    for (const row of group.rows) {
      const id = /^item:(\d+)$/.exec(row.key)?.[1];
      const item = id === undefined ? undefined : items.get(Number(id));

      if (item === undefined) {
        continue;
      }

      const host = item.ticket.hostWindow ?? null;
      const actions = pageActions(row);
      const shown: PageRow = {
        workItemId: item.id,
        title: row.title,
        ticket: row.ticket,
        sourceKind: row.sourceKind,
        playbook: row.playbook,
        mark: row.mark,
        stripe: row.stripe,
        dim: row.dim,
        host: host === null ? null : hostTitle(host),
        actions,
        main: actions.some((one) => one.label === row.main && one.confirm === null) ? row.main : null,
        pastes: row.pastes.map((paste) => paste.label),
      };

      rows.push(shown);
    }

    return { key: group.key, title: group.title, glyph: group.glyph, empty: group.empty, rows };
  });
}

/** A work item's row in the dock's view, or null when no group lists it. */
export function dockRowOf(dock: Pick<DockView, 'groups'>, workItemId: number): DockRow | null {
  return dock.groups.flatMap((group) => group.rows).find((row) => row.key === `item:${workItemId}`) ?? null;
}

/** An artifact's file, or a file an artifact uses, as the page names it: `<owner>/<file>` or deeper, no segment starting with a dot. */
const ARTIFACT_FILE = /^[\w-][\w.-]*(\/[\w-][\w.-]*)+$/;

const MIME: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
};

/**
 * The CSP an HTML or SVG artifact is served with (architecture.md § Web page): scripts and styles inline, its own folder's files, no network,
 * no forms, and a sandbox with an opaque origin, so it reaches neither the page's cookie nor the conversation, as claude-collab's artifacts did.
 */
export const ARTIFACT_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; form-action 'none'; base-uri 'none'";

/** The page's own CSP: its own scripts, styles and fonts, its artifact frames from this origin, and no network beyond the hub. */
export const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; font-src 'self' data:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** A file in an artifact folder: its real path, its media type, and whether it is served in the sandbox; null for a name or file outside it. */
export function artifactFile(dir: string, name: string): { path: string; mime: string; sandboxed: boolean } | null {
  if (!ARTIFACT_FILE.test(name)) {
    return null;
  }

  try {
    const root = realpathSync.native(dir);
    const real = realpathSync.native(join(dir, ...name.split('/')));
    const inside = relative(root, real);

    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !statSync(real).isFile()) {
      return null;
    }

    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';

    return { path: real, mime, sandboxed: artifactType(name) === 'html' || ext === 'svg' || mime === 'application/octet-stream' };
  } catch {
    return null;
  }
}

/** A file or folder the composer's picker offers, relative to the session's folder with forward slashes; a folder ends with a slash. */
export interface PageFile {
  path: string;
  dir: boolean;
}

/** Folders the page's file picker never walks into. */
const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'bin', 'obj']);
/** The most entries one picker search reads. */
const WALK_LIMIT = 20_000;
/** The most files and folders the picker shows. */
export const PAGE_FILES = 50;

/**
 * The page's `@` picker (architecture.md § Web page): the files and folders under `folder` whose path holds the query, without case, a name that
 * starts with it first, then a name that holds it, then shorter paths; never in a skipped folder, a dot folder or through a link out of it.
 */
export async function findFiles(folder: string, query: string): Promise<PageFile[]> {
  const want = query.trim().toLowerCase().replaceAll('\\', '/');
  const found: PageFile[] = [];
  let read = 0;
  const root = await realpath(folder).catch(() => null);

  if (root === null) {
    return [];
  }

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (read++ > WALK_LIMIT) {
        return;
      }

      const path = `${prefix}${entry.name}`;
      const isDir = entry.isDirectory();

      if (isDir && (SKIPPED.has(entry.name) || entry.name.startsWith('.'))) {
        continue;
      }

      if (path.toLowerCase().includes(want)) {
        found.push({ path: isDir ? `${path}/` : path, dir: isDir });
      }

      if (isDir) {
        await walk(join(dir, entry.name), `${path}/`);
      }
    }
  };

  if ((await stat(root).catch(() => null))?.isDirectory() === true) {
    await walk(root, '');
  }

  const rank = (item: PageFile): number => {
    const name = item.path.replace(/\/$/, '').split('/').pop()!.toLowerCase();

    return name.startsWith(want) ? 0 : name.includes(want) ? 1 : 2;
  };

  return found.sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || a.path.localeCompare(b.path)).slice(0, PAGE_FILES);
}

/** Whether a request's Host header names this server on the loopback, so a page reached through another name (DNS rebinding) is refused. */
export function loopbackHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
