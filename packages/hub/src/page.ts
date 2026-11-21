import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { hostKey, isFolderHost } from '@switchboard/core';
import type { Store } from '@switchboard/core';
import { artifactType } from '@switchboard/conversation';
import { windowOf } from './dock.js';
import type { DockRow, DockSourceGroup, DockView } from './dock.js';
import { CONTROL_GLYPHS } from './rows.js';
import type { RowGroup } from './rows.js';
import type { Snapshot } from './snapshot.js';

/** Output queued for a page's console stream beyond this ends the stream, as the holder drops a client that does not read. */
export const CONSOLE_QUEUE_BYTES = 8 * 1024 * 1024;

/** The cookie a page holds once it exchanged its one-time link (architecture.md § Web page). */
export const PAGE_COOKIE = 'sb_page';
/** How long a page link can be opened. */
export const PAGE_LINK_MS = 2 * 60_000;
/** A sign-in not used for this long is forgotten; also the cookie's Max-Age, renewed each time the page loads. */
export const PAGE_SESSION_MS = 30 * 24 * 60 * 60_000;
/** The most sign-ins kept; the one used longest ago is dropped past it. */
export const PAGE_SESSIONS_KEPT = 20;
/** How often a sign-in's latest use is written to the store. */
const PAGE_SESSION_TOUCH_MS = 60 * 60_000;

/** Where the page's sign-ins are kept: the hub's store, by each cookie's SHA-256. */
export type PageSessions = Pick<Store, 'pageSession' | 'savePageSession' | 'deletePageSessions' | 'trimPageSessions'>;

/** The Set-Cookie value that signs this computer in with a cookie value (architecture.md § Web page). */
export function pageCookie(value: string): string {
  return `${PAGE_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${PAGE_SESSION_MS / 1000}`;
}

function hashOf(cookie: string): string {
  return createHash('sha256').update(cookie).digest('hex');
}

/**
 * The web page's credential (architecture.md § Web page): a one-time token in a link, which the page exchanges for a cookie it cannot read. Tokens
 * live in the hub's memory; each cookie is a remembered sign-in for this computer, kept in the store as its hash only, so it outlives a hub restart
 * until it goes unused for `PAGE_SESSION_MS` or is revoked.
 */
export class PageAccess {
  readonly #tokens = new Map<string, number>();

  constructor(
    private readonly sessions: PageSessions,
    private readonly now: () => number = Date.now,
  ) {}

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

  /**
   * A new cookie value for a token not used yet and not expired, which it uses up; null otherwise. The sign-in the request's Cookie header
   * already holds is forgotten, so signing in again leaves no old cookie valid.
   */
  exchange(token: string, header?: string): string | null {
    const until = this.#tokens.get(token);

    this.#tokens.delete(token);

    if (until === undefined || until < this.now()) {
      return null;
    }

    const previous = cookieValue(header, PAGE_COOKIE);

    if (previous !== null) {
      this.sessions.deletePageSessions(hashOf(previous));
    }

    const cookie = randomBytes(32).toString('hex');

    this.sessions.savePageSession(hashOf(cookie), this.now());
    this.sessions.trimPageSessions(this.now() - PAGE_SESSION_MS, PAGE_SESSIONS_KEPT);
    return cookie;
  }

  /** Whether a request's Cookie header carries a sign-in this hub gave out, not revoked and used within `PAGE_SESSION_MS`, which counts as a use. */
  allows(header: string | undefined): boolean {
    const given = cookieValue(header, PAGE_COOKIE);

    if (given === null || !/^[0-9a-f]{64}$/.test(given)) {
      return false;
    }

    const hash = hashOf(given);
    const session = this.sessions.pageSession(hash);
    const now = this.now();

    if (session === null) {
      return false;
    }

    if (now - session.usedAt > PAGE_SESSION_MS) {
      this.sessions.deletePageSessions(hash);
      return false;
    }

    if (now - session.usedAt >= PAGE_SESSION_TOUCH_MS) {
      this.sessions.savePageSession(hash, now);
    }

    return true;
  }

  /** The stored key of the sign-in a Cookie header names, whether or not it is valid, or null for none. */
  sessionOf(header: string | undefined): string | null {
    const given = cookieValue(header, PAGE_COOKIE);

    return given === null ? null : hashOf(given);
  }

  /** Forgets every sign-in, so every browser needs a new link; answers how many there were. */
  revokeAll(): number {
    return this.sessions.deletePageSessions();
  }
}

/** The page's files a browser fetches without its cookie, for installing the page and for the offline page; none holds anything private. */
export const PUBLIC_PAGE_FILES = new Set(['manifest.webmanifest', 'sw.js', 'offline.html', 'offline.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']);

/** What `/page/` answers a browser that is not signed in. */
export const SIGNED_OUT_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Switchboard</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#1f1f1f;color:#cccccc;font:14px system-ui,sans-serif}main{max-width:28rem;padding:24px}h1{font-size:18px;font-weight:600;margin:0 0 8px}</style></head><body><main><h1>Not signed in</h1><p>This browser is not signed in to Switchboard. Open the page with Switchboard: Open Web Page in VS Code, or <code>hub.js web</code>.</p></main></body></html>';

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

/** A row of the page's list: the dock row's three lines, its mark and its stripe, as the dock built them (architecture.md § Web page). */
export interface PageRow {
  workItemId: number;
  title: string;
  /** Line 1: the priority dot's tooltip, or null, and the time at its end. */
  priority: DockRow['priority'];
  time: DockRow['time'];
  /** The ticket's key, such as `gh 18941`, and its source's plugin, which colours its pill as the dock's; `url` is the ticket's, empty for an ad-hoc one. */
  ticket: string;
  sourceKind: string;
  url: string;
  playbook: string;
  /** Line 2 after the ticket's key: its link pills, the Returned count, and the comment icon before the playbook. */
  links: Omit<DockRow['links'][number], 'pr'>[];
  returned: number;
  comment: DockRow['comment'];
  /** Line 3: the mark, then the details. */
  mark: DockRow['mark'];
  details: DockRow['details'];
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
  /** What the list's search matches, as the dock's search box does: the title, key, linked pull requests and issues, playbook, group and branch (PRD R63). */
  search: string;
}

/** The dock's actions the page may run through `row-action`, each on one work item. */
export const PAGE_ACTIONS = ['start', 'approve', 'retry', 'stop', 'mark-done', 'reopen', 'snooze', 'restore', 'comment', 'move', 'reset-position', 'delete'] as const;
export type PageActionType = (typeof PAGE_ACTIONS)[number];

/** The groups of the dock's row menu (`MenuOf`), in its order, with a separator between them; what the row opens comes before `asking`. */
export type PageActionGroup = 'main' | 'work' | 'state' | 'notes' | 'order' | 'asking';

/** The text a control asks for before it runs, without the action fields it fills, which stay in the hub: the dock's input dialog. */
export interface PageInput {
  question: string;
  detail: string;
  /** The label of the button that goes ahead. */
  action: string;
  /** The text the box starts with, such as Start with prompt…'s prompt; null for an empty box. */
  text: string | null;
  /** A choice beside the text, such as Start with guidance…'s playbook, `value` chosen at first; null for none. */
  choice: { label: string; value: string; values: string[] } | null;
}

/**
 * One control the page offers: its dock label, which names it in `row-action`, the action it runs, its codicon, its group in the dock's menu,
 * what the page asks first, and the text it asks for.
 */
export interface PageAction {
  label: string;
  action: PageActionType;
  icon: string;
  group: PageActionGroup;
  confirm: { question: string; detail: string; action: string } | null;
  input: PageInput | null;
}

/** The dock's state controls, which change what the work item waits for (`StateActions` in the dock). */
const STATE_ACTIONS = new Set<string>(['mark-done', 'reopen', 'snooze', 'restore']);
/** The order controls of a Ready for review row (`OrderActions` in the dock). */
const ORDER_ACTIONS = new Set<string>(['move', 'reset-position']);
/** Each control glyph's codicon name, for the page, which draws codicons by name. */
const CONTROL_ICONS = new Map<string, string>(Object.entries(CONTROL_GLYPHS).map(([name, glyph]) => [glyph, name]));
/** The longest text a control's input takes from the page, such as an edited prompt. */
export const MAX_INPUT_CHARS = 100_000;

/**
 * The page's controls for a dock row: the dock's hub controls whose action is in `PAGE_ACTIONS`, grouped and ordered as the dock's menu: the row's
 * main control, its work, its state, its notes (Add comment…), its order in Ready for review, then the controls that ask first. Stop asks first on
 * the page, as Delete does in the dock.
 */
export function pageActions(row: Pick<DockRow, 'controls' | 'main' | 'ticket'>): PageAction[] {
  const offered = row.controls.filter((control) => (PAGE_ACTIONS as readonly string[]).includes(String(control.action['type'])) && control.group === undefined);
  const main = offered.find((control) => control.label === row.main && control.confirm === undefined);
  const groupOf = (control: DockRow['controls'][number]): PageActionGroup => {
    const type = String(control.action['type']);

    return control === main ? 'main' : control.confirm !== undefined ? 'asking' : STATE_ACTIONS.has(type) ? 'state' : ORDER_ACTIONS.has(type) ? 'order' : type === 'comment' ? 'notes' : 'work';
  };
  const order: PageActionGroup[] = ['main', 'work', 'state', 'notes', 'order', 'asking'];

  return offered
    .map((control) => {
      const action = String(control.action['type']) as PageActionType;
      const confirm = control.confirm ?? (action === 'stop' ? { question: `Stop ${row.ticket}?`, detail: 'Switchboard stops its running session, and the work item waits for you as Stopped by you.', action: 'Stop' } : null);
      const input = control.input === undefined ? null : { question: control.input.question, detail: control.input.detail, action: control.input.action, text: control.input.text ?? null, choice: control.input.choice === undefined ? null : { label: control.input.choice.label, value: control.input.choice.value, values: [...control.input.choice.values] } };

      return { label: control.label, action, icon: CONTROL_ICONS.get(control.glyph) ?? 'circle-outline', group: groupOf(control), confirm, input };
    })
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/** What the page sends with a control: Snooze's wake time and comment, and the text and choice a control with an input asks for. */
export interface PageActionExtra {
  until: number | null;
  comment: string | null;
  text?: string | null;
  choice?: string | null;
}

/**
 * The action `row-action` posts for a work item's dock row, by the control's label: the hub's own control's action, never the page's, with
 * Snooze's `until` and `comment`, and an input's text and changed choice set as the fields the hub's control names, as the dock's input dialog
 * sets them; why not when the row no longer offers it or the answer does not do (a text or a changed choice is needed, and a choice must be one
 * offered).
 */
export function pageActionEvent(row: Pick<DockRow, 'controls' | 'main' | 'ticket'>, label: string, extra: PageActionExtra): { event: Record<string, unknown> } | { refused: string } {
  const offered = pageActions(row).find((one) => one.label === label);

  if (offered === undefined) {
    return { refused: 'The work item no longer offers this.' };
  }

  const control = row.controls.find((one) => one.label === label && one.group === undefined)!;

  if (offered.action === 'snooze') {
    return { event: { ...control.action, until: extra.until, ...(extra.comment === null ? {} : { comment: extra.comment }) } };
  }

  const input = control.input;

  if (input === undefined) {
    return { event: { ...control.action } };
  }

  const text = (extra.text ?? '').trim();
  const choice = input.choice === undefined || extra.choice == null || extra.choice === input.choice.value ? null : extra.choice;

  if (choice !== null && !input.choice!.values.includes(choice)) {
    return { refused: `Choose one of the offered ${input.choice!.label.toLowerCase()}s.` };
  }

  if (text === '' && choice === null) {
    return { refused: `${input.question} needs a text.` };
  }

  return { event: { ...control.action, [input.field]: text, ...(choice === null ? {} : { [input.choice!.field]: choice }) } };
}

/** The bookmark and the query parameter the dock adds to a link it opens (`Switcher.Marked`), so the Chrome extension groups its tab (PRD R74). */
const TAB_BOOKMARK = '#switchboard-tab';
const TAB_PARAMETER = 'switchboard-tab=1';

/**
 * A link as the hub opens it for the page: an http or https URL, normalised by the URL parser, with the dock's mark (the bookmark added or, when
 * it has one, the parameter last in its query before it); null for any other URL.
 */
export function tabUrl(url: string): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const href = parsed.href;
  const hash = href.indexOf('#');

  if (hash === -1) {
    return `${href}${TAB_BOOKMARK}`;
  }

  const target = href.slice(0, hash);

  return `${target}${target.includes('?') ? '&' : '?'}${TAB_PARAMETER}${href.slice(hash)}`;
}

/** The URL `row-open` opens for a row: `url` marked, only when it is the row's ticket URL or one of its links now and http or https; else null. */
export function rowOpenUrl(row: { url: string; links: ReadonlyArray<{ url: string }> }, url: string): string | null {
  return url !== '' && (row.url === url || row.links.some((link) => link.url === url)) ? tabUrl(url) : null;
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

      if (item !== undefined) {
        rows.push(pageRow(row, item.id, item.ticket.hostWindow ?? null));
      }
    }

    return { key: group.key, title: group.title, glyph: group.glyph, empty: group.empty, rows };
  });
}

/** A work item's dock row as the page's list shows it; `host` is its ticket's host window, or null. */
export function pageRow(row: DockRow, workItemId: number, host: string | null): PageRow {
  const actions = pageActions(row);

  return {
    workItemId,
    title: row.title,
    priority: row.priority,
    time: row.time,
    ticket: row.ticket,
    sourceKind: row.sourceKind,
    url: row.url,
    playbook: row.playbook,
    links: row.links.map(({ label, url, kind, badge, glyph, mentioned }) => ({ label, url, kind, badge, glyph, mentioned })),
    returned: row.returned,
    comment: row.comment,
    mark: row.mark,
    details: row.details,
    stripe: row.stripe,
    dim: row.dim,
    host: host === null ? null : hostTitle(host),
    actions,
    main: actions.some((one) => one.label === row.main && one.confirm === null) ? row.main : null,
    pastes: row.pastes.map((paste) => paste.label),
    search: row.search,
  };
}

/** What the page's list header shows besides the list (architecture.md § Web page): the dock header's source icons and what its More Actions offer. */
export interface PageHeader {
  /** The configured sources but ad-hoc, by kind, as the dock's header icons show them. */
  sources: DockSourceGroup[];
  /** The repos an ad-hoc prompt can run in, the first being the default (PRD R6). */
  repoRoots: string[];
  /** The folders New ad-hoc session and New conversation in a folder offer: the repo roots, then the folders that host conversations. */
  folders: string[];
  /** The schedules New ad-hoc session can run now (PRD R82). */
  schedules: { name: string; playbook: string }[];
}

/**
 * The page's list header, from the built dock view, so the page and the dock show the same sources. A page cannot browse this computer's
 * folders, so its folder choices are the ones the hub knows: the repo roots, then each folder a conversation is hosted by, once each.
 */
export function pageHeader(dock: Pick<DockView, 'sources' | 'repoRoots' | 'schedules'>, snapshot: Pick<Snapshot, 'workItems'>): PageHeader {
  const folders = new Map<string, string>();

  for (const folder of [...dock.repoRoots, ...snapshot.workItems.flatMap((item) => (item.ticket.hostWindow != null && isFolderHost(item.ticket.hostWindow) ? [item.ticket.hostWindow] : []))]) {
    if (!folders.has(hostKey(folder))) {
      folders.set(hostKey(folder), folder);
    }
  }

  return { sources: dock.sources, repoRoots: dock.repoRoots, folders: [...folders.values()], schedules: dock.schedules };
}

/** The folder of `folders` that names the same folder as `folder`, in any spelling `hostKey` treats as one, or null. */
export function knownFolder(folders: readonly string[], folder: string): string | null {
  return folders.find((one) => hostKey(one) === hostKey(folder)) ?? null;
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
