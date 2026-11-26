import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { hostKey, isFolderHost } from '@switchboard/core';
import type { PageDevice, Store } from '@switchboard/core';
import type { IncomingHttpHeaders } from 'node:http';
import { ARTIFACT_SEGMENT, artifactType } from '@switchboard/conversation';
import { PAGE_SCRIPT_HASHES } from '@switchboard/web';
import { hostIsPath, windowOf } from './dock.js';
import type { DockHolderNotice, DockHolderResult, DockRow, DockSourceGroup, DockView } from './dock.js';
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

/** How long a pairing link and its code can be used (architecture.md § Remote access). */
export const PAIR_MS = 5 * 60_000;
/** Wrong pairing codes after which every code given out is dropped, so a code cannot be guessed. */
export const PAIR_CODE_TRIES = 10;
/** The letters a pairing code is made of: no 0, 1, I or O, which read alike. */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Where the page's sign-ins are kept: the hub's store, by each cookie's SHA-256. */
export type PageSessions = Pick<Store, 'pageSession' | 'pageSessions' | 'savePageSession' | 'deletePageSessions' | 'trimPageSessions' | 'setPageSessionVoice'>;

/**
 * The Set-Cookie value that signs a browser in with a cookie value (architecture.md § Web page); `Secure` for a device that reaches the page
 * through a remote host, which is always HTTPS.
 */
export function pageCookie(value: string, secure = false): string {
  return `${PAGE_COOKIE}=${value}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Path=/; Max-Age=${PAGE_SESSION_MS / 1000}`;
}

/** The names the page also answers as through `tailscale serve`, and the Tailscale logins a request through them must carry (architecture.md § Remote access). */
export interface RemoteAccess {
  hosts: readonly string[];
  logins: readonly string[];
}

/**
 * Where a page request came from: this computer, with no host or login, or a remote host through `tailscale serve` with the login Tailscale
 * named; `origin` is the `Origin` the page's posts must carry.
 */
export type PageOrigin = { host: null; login: null; origin: string } | { host: string; login: string; origin: string };

/** A request from this computer, where a sign-in is checked when no origin is named. */
const LOCAL_ORIGIN: PageOrigin = { host: null, login: null, origin: '' };

/** Headers only a proxy adds: a request with any of them came through one, so it is never taken as this computer's own. */
const PROXY_HEADERS = ['forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic', 'tailscale-funnel-request', 'tailscale-headers-info', 'tailscale-app-capabilities'];

/** Whether a socket's peer address is this computer's loopback. */
function loopbackPeer(address: string | undefined): boolean {
  return address !== undefined && (/^127\./.test(address) || address === '::1' || /^::ffff:127\./.test(address));
}

/**
 * Where a page request came from (architecture.md § Remote access), or why it is refused. The hub listens on 127.0.0.1 only, so every request
 * comes from this computer, a proxy such as `tailscale serve` included. A request with no proxy header is this computer's own and must name
 * `127.0.0.1:<port>` or `localhost:<port>`, against DNS rebinding. One with a proxy header must name an allowed remote host, as HTTPS, not as a
 * Funnel request, and carry an allowed `Tailscale-User-Login`, which `tailscale serve` sets from the device's owner and removes when a client
 * sends it.
 */
export function pageOrigin(headers: IncomingHttpHeaders, peer: string | undefined, port: number, remote: RemoteAccess): PageOrigin | { refused: string } {
  const host = headers.host;

  if (!loopbackPeer(peer)) {
    return { refused: 'The page is served only through this computer.' };
  }

  if (!PROXY_HEADERS.some((name) => headers[name] !== undefined)) {
    return loopbackHost(host, port) ? { host: null, login: null, origin: `http://${host}` } : { refused: 'The page is served only as 127.0.0.1 or localhost.' };
  }

  const name = (host ?? '').toLowerCase().replace(/:443$/, '');
  const login = headers['tailscale-user-login'];

  if (!remote.hosts.includes(name)) {
    return { refused: 'The page is not served as this name. Turn on Tailscale or set Allowed hosts in Settings › Devices.' };
  }

  if (headers['x-forwarded-proto'] !== 'https' || (headers['x-forwarded-host'] !== undefined && headers['x-forwarded-host'] !== host)) {
    return { refused: 'The page is served to another device only over HTTPS through tailscale serve.' };
  }

  if (headers['tailscale-funnel-request'] !== undefined) {
    return { refused: 'The page is not served through Tailscale Funnel.' };
  }

  if (typeof login !== 'string' || !remote.logins.includes(login.toLowerCase())) {
    return { refused: 'This Tailscale login may not use the page. Set Allowed logins in Settings › Devices.' };
  }

  return { host: name, login: login.toLowerCase(), origin: `https://${name}` };
}

/** A short name for the device a browser runs on, from its User-Agent: its system and its browser, such as "Android · Chrome". */
export function deviceLabel(agent: string | undefined): string {
  const text = agent ?? '';
  const system = /iPhone/.test(text) ? 'iPhone' : /iPad/.test(text) ? 'iPad' : /Android/.test(text) ? 'Android' : /CrOS/.test(text) ? 'ChromeOS' : /Windows/.test(text) ? 'Windows' : /Macintosh|Mac OS X/.test(text) ? 'Mac' : /Linux/.test(text) ? 'Linux' : 'Unknown device';
  const browser = /Edg(A|iOS)?\//.test(text) ? 'Edge' : /SamsungBrowser/.test(text) ? 'Samsung Internet' : /Firefox\/|FxiOS/.test(text) ? 'Firefox' : /Chrome\/|CriOS/.test(text) ? 'Chrome' : /Safari\//.test(text) ? 'Safari' : 'browser';

  return `${system} · ${browser}`;
}

/** A remembered sign-in as the device list shows it: its ID, the start of its hash, its device, when it was made and last used, and whether voice is allowed on it. */
export interface PageDeviceView extends PageDevice {
  id: string;
  createdAt: number;
  usedAt: number;
  voice: boolean;
}

/** A pairing link's parts (architecture.md § Remote access): its URL on the remote host, its code, and when both stop working. */
export interface PagePairing {
  url: string;
  code: string;
  host: string;
  expiresAt: number;
}

function hashOf(cookie: string): string {
  return createHash('sha256').update(cookie).digest('hex');
}

/**
 * The web page's credential (architecture.md § Web page, § Remote access): a one-time token in a link, which the page exchanges for a cookie it
 * cannot read. Tokens live in the hub's memory; a pairing token, for a remote host, also has a short code to type in its place. Each cookie is a
 * remembered sign-in for one device, kept in the store as its hash only with where it was made, so it outlives a hub restart until it goes unused
 * for `PAGE_SESSION_MS` or is revoked, and it works only from where it was made: this computer, or the remote host and login it was paired through.
 */
export class PageAccess {
  // Each token's expiry and, for a pairing token, its remote host and code.
  readonly #tokens = new Map<string, { until: number; host: string | null; code: string | null }>();
  readonly #codes = new Map<string, string>();
  #wrongCodes = 0;

  constructor(
    private readonly sessions: PageSessions,
    private readonly now: () => number = Date.now,
  ) {}

  #prune(): void {
    for (const [old, entry] of this.#tokens) {
      if (entry.until < this.now()) {
        this.#drop(old);
      }
    }
  }

  #drop(token: string): void {
    const code = this.#tokens.get(token)?.code ?? null;

    this.#tokens.delete(token);

    if (code !== null) {
      this.#codes.delete(code);
    }
  }

  /** A new one-time token for this computer, good for `PAGE_LINK_MS`. */
  token(): string {
    this.#prune();

    const token = randomBytes(32).toString('hex');

    this.#tokens.set(token, { until: this.now() + PAGE_LINK_MS, host: null, code: null });
    return token;
  }

  /** A new pairing link for a device on `host`, a remote host: a one-time token and its code, good for `PAIR_MS`; using either uses up both. */
  pair(host: string): PagePairing {
    this.#prune();

    const token = randomBytes(32).toString('hex');
    let code = '';

    do {
      code = [...randomBytes(8)].map((byte) => CODE_LETTERS[byte % CODE_LETTERS.length]).join('');
    } while (this.#codes.has(code));

    const until = this.now() + PAIR_MS;

    this.#tokens.set(token, { until, host, code });
    this.#codes.set(code, token);
    return { url: `https://${host}/page?t=${token}`, code: `${code.slice(0, 4)}-${code.slice(4)}`, host, expiresAt: until };
  }

  /**
   * A new cookie value for a token not used yet and not expired, given out for where the request came from, which it uses up; null otherwise.
   * The sign-in the request's Cookie header already holds is forgotten, so signing in again leaves no old cookie valid.
   */
  exchange(token: string, header?: string, origin: PageOrigin = LOCAL_ORIGIN, label = ''): string | null {
    const entry = this.#tokens.get(token);

    this.#drop(token);

    if (entry === undefined || entry.until < this.now() || entry.host !== origin.host) {
      return null;
    }

    const previous = cookieValue(header, PAGE_COOKIE);

    if (previous !== null) {
      this.sessions.deletePageSessions(hashOf(previous));
    }

    const cookie = randomBytes(32).toString('hex');

    this.sessions.savePageSession(hashOf(cookie), this.now(), { label, host: origin.host, login: origin.login });
    this.sessions.trimPageSessions(this.now() - PAGE_SESSION_MS, PAGE_SESSIONS_KEPT);
    return cookie;
  }

  /**
   * A typed pairing code, in any case and with or without its dash, exchanged as its token is, only through a remote host; null for a wrong one.
   * After `PAIR_CODE_TRIES` wrong codes every code given out is dropped, its link with it.
   */
  exchangeCode(code: string, header: string | undefined, origin: PageOrigin, label: string): string | null {
    const token = origin.host === null ? undefined : this.#codes.get(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));

    if (token === undefined) {
      if (++this.#wrongCodes >= PAIR_CODE_TRIES) {
        this.#wrongCodes = 0;

        for (const one of [...this.#codes.values()]) {
          this.#drop(one);
        }
      }

      return null;
    }

    return this.exchange(token, header, origin, label);
  }

  /**
   * Whether a request's Cookie header carries a sign-in this hub gave out, not revoked and used within `PAGE_SESSION_MS`, made where the request
   * comes from, which counts as a use.
   */
  allows(header: string | undefined, origin: PageOrigin = LOCAL_ORIGIN): boolean {
    const given = cookieValue(header, PAGE_COOKIE);

    if (given === null || !/^[0-9a-f]{64}$/.test(given)) {
      return false;
    }

    const hash = hashOf(given);
    const session = this.sessions.pageSession(hash);
    const now = this.now();

    if (session === null || session.host !== origin.host || session.login !== origin.login) {
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

  /** The remembered sign-ins, the one used last first, each with its ID, the first 8 characters of its hash. */
  devices(): PageDeviceView[] {
    return this.sessions.pageSessions().map(({ hash, label, host, login, createdAt, usedAt, voice }) => ({ id: deviceId(hash), label, host, login, createdAt, usedAt, voice }));
  }

  /** The stored key of the one sign-in with this ID, or null when none or several have it. */
  #find(id: string): string | null {
    const found = this.sessions.pageSessions().filter((one) => deviceId(one.hash) === id.toLowerCase());

    return found.length === 1 ? found[0]!.hash : null;
  }

  /** Forgets the sign-in with this ID; answers its stored key, or null when no one sign-in has it. */
  revoke(id: string): string | null {
    const hash = this.#find(id);

    if (hash !== null) {
      this.sessions.deletePageSessions(hash);
    }

    return hash;
  }

  /**
   * Allows or forbids voice on the paired device with this ID (architecture.md § Remote access); answers its stored key, or null when no one
   * sign-in has it or it is this computer's, whose voice is the computer's own microphone and speaker.
   */
  allowVoice(id: string, on: boolean): string | null {
    const hash = this.#find(id);

    if (hash === null || this.sessions.pageSession(hash)?.host == null) {
      return null;
    }

    this.sessions.setPageSessionVoice(hash, on);
    return hash;
  }

  /**
   * Whether the sign-in with this stored key is still one this hub gave out, made where `origin` names and used within `PAGE_SESSION_MS`, as
   * `allows` checks a request's, without counting a use.
   */
  signedIn(hash: string, origin: PageOrigin): boolean {
    const session = this.sessions.pageSession(hash);

    return session !== null && session.host === origin.host && session.login === origin.login && this.now() - session.usedAt <= PAGE_SESSION_MS;
  }

  /** Whether voice is allowed on the sign-in with this stored key. */
  voiceAllowed(hash: string | null): boolean {
    return hash !== null && this.sessions.pageSession(hash)?.voice === true;
  }

  /** Forgets every sign-in, so every browser needs a new link; answers how many there were. */
  revokeAll(): number {
    return this.sessions.deletePageSessions();
  }
}

/** A sign-in's ID in the device list: the first 8 characters of its stored hash, which tells nothing of the cookie. */
export function deviceId(hash: string): string {
  return hash.slice(0, 8);
}

/** The page's files a browser fetches without its cookie, for installing the page and for the offline page; none holds anything private. */
export const PUBLIC_PAGE_FILES = new Set(['manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']);

/** What `/page/` answers a browser that is not signed in. */
export const SIGNED_OUT_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Switchboard</title><style>html{-webkit-text-size-adjust:100%;text-size-adjust:100%}body{margin:0;display:grid;place-items:center;min-height:100vh;background:#1f1f1f;color:#cccccc;font:14px system-ui,sans-serif}main{max-width:28rem;padding:24px}h1{font-size:18px;font-weight:600;margin:0 0 8px}</style></head><body><main><h1>Not signed in</h1><p>This browser is not signed in to Switchboard. Open the page with a link from <code>hub.js web</code>.</p></main></body></html>';

/**
 * The pairing page's script: it upper-cases the typed code, drops all but letters and digits, keeps 8, and puts the dash after the fourth, keeping
 * the caret after the same letters, so a paste or a backspace over the dash works and the dash need not be typed.
 */
export const PAIR_SCRIPT = "(()=>{const input=document.querySelector('input[name=code]');input.addEventListener('input',(event)=>{if(event.isComposing)return;const clean=(text)=>text.toUpperCase().replace(/[^A-Z0-9]/g,'');const caret=input.selectionStart??input.value.length;const before=Math.min(clean(input.value.slice(0,caret)).length,8);const code=clean(input.value).slice(0,8);const value=code.length>4?code.slice(0,4)+'-'+code.slice(4):code;if(value===input.value)return;input.value=value;const at=before>4?before+1:before;input.setSelectionRange(at,at);});})();";

/** The CSP of the pairing page: its own styles, its one script and a form that asks only this origin. */
export const PAIR_CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${createHash('sha256').update(PAIR_SCRIPT).digest('base64')}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

/**
 * What a remote host answers a device that is not signed in (architecture.md § Remote access): a form that sends a pairing code to `/page`, and
 * after a wrong or expired one, says so.
 */
export function pairHtml(wrong: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Switchboard</title><style>html{-webkit-text-size-adjust:100%;text-size-adjust:100%}body{margin:0;display:grid;place-items:center;min-height:100vh;background:#1f1f1f;color:#cccccc;font:16px system-ui,sans-serif}main{max-width:24rem;padding:24px}h1{font-size:20px;font-weight:600;margin:0 0 8px}p{line-height:1.4}.wrong{color:#f48771}input,button{font:inherit;font-size:20px;padding:10px 12px;border-radius:4px;box-sizing:border-box;width:100%;margin-top:8px}input{background:#313131;color:#cccccc;border:1px solid #3c3c3c;text-transform:uppercase;letter-spacing:2px}button{background:#0078d4;color:#ffffff;border:0}</style></head><body><main><h1>Pair this device</h1><p>On the computer that runs Switchboard, open the web page, choose More Actions, then Pair a device, and scan its code, or type the code it shows here.</p>${wrong ? '<p class="wrong" role="alert">That code is wrong or has expired. Get a new one from Pair a device.</p>' : ''}<form method="get" action="/page"><input name="code" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" inputmode="text" enterkeyhint="go" placeholder="ABCD-EFGH" aria-label="Pairing code" required><button type="submit">Pair</button></form></main><script>${PAIR_SCRIPT}</script></body></html>`;
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

  // A host that is no path, such as a web page's key, hosts nothing: the conversation is a group of its own.
  const hostOfItem = (item: Snapshot['workItems'][number]): string | null => (item.ticket.hostWindow != null && hostIsPath(item.ticket.hostWindow) ? item.ticket.hostWindow : null);

  for (const item of [...open].sort((a, b) => b.id - a.id)) {
    if (hostOfItem(item) !== null) {
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
    const host = hostOfItem(item);

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

/**
 * A row of the page's list: the list row's three lines, its mark and its stripe, as the hub's list view built them (architecture.md § Web page); a work item's
 * with its ID, or a pool ticket's, which has no conversation, with its ticket's ID and no work item.
 */
export interface PageRow {
  workItemId: number | null;
  ticketId: number | null;
  title: string;
  /** Line 1: the priority dot's tooltip, or null, and the time at its end. */
  priority: DockRow['priority'];
  time: DockRow['time'];
  /** The ticket's key, such as `gh 18941`, and its source's plugin, which colours its pill; `url` is the ticket's, empty for an ad-hoc one. */
  ticket: string;
  /** The key without its source's label, shown after the source's logo; left out where the key starts otherwise (`DockRow.ticketNumber`). */
  ticketNumber?: string;
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
  /** A Ready for review row on the agent's turn, which the list dims. */
  dim: boolean;
  /** A hosted conversation's host: its folder's or its window's name; null for other work items. */
  host: string | null;
  /** The hub's row controls the page offers for the row, in menu order (architecture.md § Web page). */
  actions: PageAction[];
  /** The label of the row's main control, shown as its button, when the page offers it; else null. */
  main: string | null;
  /** The labels of the drafted texts Copy offers (PRD R60); the files stay in the hub. */
  pastes: string[];
  /** What the list's search matches: the title, key, linked pull requests and issues, playbook, group and branch (PRD R63). */
  search: string;
  /** What the row opens: Open in VS Code, run with `row-command`, and Open report, opened in a file tab. */
  opens: PageOpen[];
  /** A Done row's date band, such as `Today`, or an older Done row's month, such as `October 2026` (PRD R27); null in the other groups. */
  band: string | null;
  /** Line 1's mic mark, before the time, on the voice target's row; null on the others. */
  voice: { glyph: string; title: string } | null;
  /** Line 1's waiting questions after the title: how many of the work item's questions wait on the operator (PRD R103); 0 on a pool ticket's row. */
  questions: number;
  /** The ticket whose History the row's menu opens, as the row's History command names it: its ID and key; null when the row offers none. */
  history: { ticketId: number; key: string } | null;
}

/** The mic mark of the voice target's row: its key, `item:<work item ID>`, the codicon glyph and the tooltip. */
export interface PageVoiceMark {
  row: string;
  glyph: string;
  title: string;
}

/** The hub's row actions the page may run through `row-action`, each on one work item. */
export const PAGE_ACTIONS = ['start', 'pick', 'retriage-pool', 'approve', 'retry', 'stop', 'mark-done', 'reopen', 'snooze', 'restore', 'comment', 'move', 'reset-position', 'delete'] as const;
export type PageActionType = (typeof PAGE_ACTIONS)[number];

/** The groups of the row menu (`MenuOf`), in its order, with a separator between them; what the row opens comes before `asking`. */
export type PageActionGroup = 'main' | 'work' | 'state' | 'notes' | 'order' | 'asking';

/** The text a control asks for before it runs, without the action fields it fills, which stay in the hub: the row's input dialog. */
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
 * One control the page offers: its label, which names it in `row-action`, the action it runs, its codicon, its group in the row menu,
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

/** The state controls, which change what the work item waits for (`StateActions`). */
const STATE_ACTIONS = new Set<string>(['mark-done', 'reopen', 'snooze', 'restore']);
/** The order controls of a Ready for review row (`OrderActions`). */
const ORDER_ACTIONS = new Set<string>(['move', 'reset-position']);
/** Each control glyph's codicon name, for the page, which draws codicons by name. */
const CONTROL_ICONS = new Map<string, string>(Object.entries(CONTROL_GLYPHS).map(([name, glyph]) => [glyph, name]));
/** The longest text a control's input takes from the page, such as an edited prompt. */
export const MAX_INPUT_CHARS = 100_000;

/**
 * The page's controls for a list row: the hub's row controls whose action is in `PAGE_ACTIONS`, grouped and ordered as the row menu: the row's
 * main control, its work, its state, its notes (Add comment…), its order in Ready for review, then the controls that ask first. Stop session asks first on
 * the page, as Delete does.
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
      const confirm = control.confirm ?? (action === 'stop' ? { question: `Stop the session for ${row.ticket}?`, detail: "Switchboard stops the session's process. The work item then waits for you: as Stopped by you, or for your approval if one was pending.", action: 'Stop session' } : null);
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
 * The action `row-action` posts for a work item's list row, by the control's label: the hub's own control's action, never the page's, with
 * Snooze's `until` and `comment`, and an input's text and changed choice set as the fields the hub's control names; why not when the row no longer offers it or the answer does not do (a text or a changed choice is needed, and a choice must be one
 * offered).
 */
export function pageActionEvent(row: Pick<DockRow, 'controls' | 'main' | 'ticket'>, label: string, extra: PageActionExtra): { event: Record<string, unknown> } | { refused: string } {
  const offered = pageActions(row).find((one) => one.label === label);

  if (offered === undefined) {
    return { refused: 'This work item can no longer do that.' };
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
    return { refused: `Type the ${input.field === 'text' ? 'comment' : input.field} first.` };
  }

  return { event: { ...control.action, [input.field]: text, ...(choice === null ? {} : { [input.choice!.field]: choice }) } };
}

/** What a row opens from the page: Open in VS Code, run with `row-command`, and Open report, which the page opens in a file tab at `file`. */
export interface PageOpen {
  label: string;
  icon: string;
  /** Open report's draft, which the page reads through `local-file`. */
  file?: string;
}

/** The label of the page's control that opens the row's VS Code window. */
export const OPEN_IN_VSCODE = 'Open in VS Code';

/** The label of the control that opens an awaiting-approval row's draft, which the page opens in a file tab. */
export const OPEN_REPORT = 'Open report';

/**
 * The draft the list row's Open report names, which the page opens in a file tab and `local-file` reads for the page's selected work item; null
 * without one. The page shows History itself, and leaves out Open changes and Open in terminal, which its Changes and Console tabs replace.
 */
export function pageReportOf(row: Pick<DockRow, 'commands'>): string | null {
  const url = row.commands.find((command) => command.command['type'] === 'openUrl' && command.label === OPEN_REPORT)?.command['url'];

  return typeof url === 'string' && url !== '' ? url : null;
}

/** The window the page's VS Code controls open: an item window's workspace file, or a folder-hosted conversation's folder; null for none. */
function destinationOf(row: Pick<DockRow, 'window'>): string | null {
  return row.window?.file ?? row.window?.folder ?? null;
}

/** What the row opens from the page: Open in VS Code when it has a window, then Open report when the row lists a draft, with or without a window. */
export function pageOpens(row: Pick<DockRow, 'window' | 'commands'>): PageOpen[] {
  const report = pageReportOf(row);

  return [...(destinationOf(row) === null ? [] : [{ label: OPEN_IN_VSCODE, icon: 'vscode' }]), ...(report === null ? [] : [{ label: OPEN_REPORT, icon: 'symbol-file', file: report }])];
}

/**
 * What `row-command` runs, by its label: Open in VS Code's workspace file or folder, which VS Code opens without the Switchboard extension; why
 * not when the row no longer offers it. Open report opens on the page, not through this.
 */
export function pageCommandOf(row: Pick<DockRow, 'window' | 'commands'>, label: string): { destination: string } | { refused: string } {
  const destination = destinationOf(row);

  if (destination === null || label !== OPEN_IN_VSCODE) {
    return { refused: label === OPEN_REPORT && pageReportOf(row) !== null ? 'Open report shows in a tab here.' : 'This work item can no longer do that.' };
  }

  return { destination };
}

/** A link as the hub opens it for the page: an http or https URL, normalised by the URL parser; null for any other URL. */
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

  return parsed.href;
}

/** The URL `row-open` opens for a row: `url` normalised, only when it is the row's ticket URL or one of its links now and http or https; else null. */
export function rowOpenUrl(row: { url: string; links: ReadonlyArray<{ url: string }> }, url: string): string | null {
  return url !== '' && (row.url === url || row.links.some((link) => link.url === url)) ? tabUrl(url) : null;
}

/** A drafted text as Copy puts it on the clipboard: the file as it is now, without a byte order mark or trailing whitespace (PRD R60). */
export async function pasteText(file: string): Promise<string> {
  return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '').trimEnd();
}

/** A group of the page's list: one of the list view's groups, with its codicon glyph. */
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
 * The page's list (architecture.md § Web page): the list view's groups in its order, with their titles, glyphs and empty texts, holding the
 * list view's rows where it puts them: the work items', hosted conversations included (every conversation is a work item), and the pool
 * tickets' in Unstarted and Snoozed; `voice` names the voice target's row, which gets the mic mark, and `questions` counts a work item's waiting
 * questions (`ConversationService.waitingQuestions`).
 */
export function pageList(dock: Pick<DockView, 'groups'>, snapshot: Pick<Snapshot, 'workItems' | 'pool'>, voice: PageVoiceMark | null = null, questions: (item: Snapshot['workItems'][number]) => number = () => 0): PageListGroup[] {
  const items = new Map(snapshot.workItems.map((item) => [item.id, item]));
  const pool = new Set(snapshot.pool.map((entry) => entry.ticket.id));

  return dock.groups.map((group) => {
    const rows: PageRow[] = [];

    for (const row of group.rows) {
      const id = /^item:(\d+)$/.exec(row.key)?.[1];
      const item = id === undefined ? undefined : items.get(Number(id));
      const ticketId = Number(/^ticket:(\d+)$/.exec(row.key)?.[1] ?? NaN);

      if (item !== undefined) {
        rows.push({ ...pageRow(row, item.id, item.ticket.hostWindow ?? null), voice: row.key === voice?.row ? { glyph: voice.glyph, title: voice.title } : null, questions: questions(item) });
      } else if (pool.has(ticketId)) {
        rows.push(pageRow(row, null, null, ticketId));
      }
    }

    return { key: group.key, title: group.title, glyph: group.glyph, empty: group.empty, rows };
  });
}

/** A work item's list view row as the page's list shows it, `host` being its ticket's host window or null; a pool ticket's with no work item and its `ticketId`. */
export function pageRow(row: DockRow, workItemId: number | null, host: string | null, ticketId: number | null = null): PageRow {
  const actions = pageActions(row);

  return {
    workItemId,
    ticketId,
    title: row.title,
    priority: row.priority,
    time: row.time,
    ticket: row.ticket,
    ...(row.ticketNumber === null ? {} : { ticketNumber: row.ticketNumber }),
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
    opens: pageOpens(row),
    search: row.search,
    band: row.band,
    voice: null,
    questions: 0,
    history: historyOf(row),
  };
}

/** The ticket the row's History command opens, or null without one. */
function historyOf(row: Pick<DockRow, 'commands'>): PageRow['history'] {
  const command = row.commands.find((one) => one.command['type'] === 'history')?.command;

  return command === undefined || typeof command['ticketId'] !== 'number' ? null : { ticketId: command['ticketId'], key: String(command['key'] ?? '') };
}

/** What the page's list header shows besides the list (architecture.md § Web page): the source icons and what More Actions offers. */
export interface PageHeader {
  /** The notes above the groups: settings, playbook, hook, source and voice errors, then what an unconfigured home lacks (PRD R42). */
  notes: string[];
  /** The note while a held session has no work item, "N held sessions without a work item" (PRD R94); absent otherwise. */
  heldNote?: string;
  /** The neutral note while no device has the voice because the phone was lost (PRD R119); absent otherwise. */
  voiceNote?: string;
  /** The configured sources but ad-hoc, by kind, as the header's icons show them. */
  sources: DockSourceGroup[];
  /** The repos an ad-hoc prompt can run in, the first being the default (PRD R6). */
  repoRoots: string[];
  /** The schedules the New session form can run now (PRD R82). */
  schedules: { name: string; playbook: string }[];
  /** The holder notice and restart result (architecture.md § Restarting the holder); absent when there is none. */
  holderNotice?: DockHolderNotice;
  holderResult?: DockHolderResult;
  /** Where the voice is while it is not on this computer, with voice on: a paired phone, or none after the phone left (PRD R119); absent otherwise. */
  voiceDevice?: 'phone' | 'none';
}

/** The page's list header, from the built list view, so the header and the list agree; the New session form asks `page-folders` for its folders. */
export function pageHeader(dock: Pick<DockView, 'notes' | 'heldNote' | 'voiceNote' | 'sources' | 'repoRoots' | 'schedules' | 'holderNotice' | 'holderResult'>): PageHeader {
  return {
    notes: dock.notes,
    ...(dock.heldNote === undefined ? {} : { heldNote: dock.heldNote }),
    ...(dock.voiceNote === undefined ? {} : { voiceNote: dock.voiceNote }),
    sources: dock.sources,
    repoRoots: dock.repoRoots,
    schedules: dock.schedules,
    ...(dock.holderNotice === undefined ? {} : { holderNotice: dock.holderNotice }),
    ...(dock.holderResult === undefined ? {} : { holderResult: dock.holderResult }),
  };
}

/** A pool ticket's row in the list view, or null when no group lists it. */
export function poolRowOf(dock: Pick<DockView, 'groups'>, ticketId: number): DockRow | null {
  return dock.groups.flatMap((group) => group.rows).find((row) => row.key === `ticket:${ticketId}`) ?? null;
}

/** A work item's row in the list view, or null when no group lists it. */
export function dockRowOf(dock: Pick<DockView, 'groups'>, workItemId: number): DockRow | null {
  return dock.groups.flatMap((group) => group.rows).find((row) => row.key === `item:${workItemId}`) ?? null;
}

/** An artifact's file, or a file an artifact uses: `<owner>/<file>` or deeper, each segment an `ARTIFACT_SEGMENT`. */
const artifactFileName = (name: string): boolean => {
  const parts = name.split('/');

  return parts.length > 1 && parts.every((part) => ARTIFACT_SEGMENT.test(part));
};

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
  // Text, data and code the page shows preformatted, served as plain text so a new window shows them too.
  ...Object.fromEntries(['text', 'log', 'jsonl', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'xml', 'diff', 'patch', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'cs', 'sh', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'go', 'rs', 'java', 'rb', 'php', 'c', 'h', 'cpp', 'hpp'].map((ext) => [ext, 'text/plain; charset=utf-8'])),
};

/**
 * The CSP an HTML or SVG artifact is served with (architecture.md § Web page): scripts and styles inline, its own folder's files, no network,
 * no forms, and a sandbox with an opaque origin, so it reaches neither the page's cookie nor the conversation, as claude-collab's artifacts did.
 */
export const ARTIFACT_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; form-action 'none'; base-uri 'none'";

/** The page's own CSP: its own scripts and its inline boot script by hash, styles and fonts, its artifact frames from this origin, and no network beyond the hub. */
export const PAGE_CSP = "default-src 'self'; script-src 'self' " + PAGE_SCRIPT_HASHES.join(' ') + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; font-src 'self' data:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** A file in an artifact folder: its real path, its media type, and whether it is served in the sandbox; null for a name or file outside it. */
export function artifactFile(dir: string, name: string): { path: string; mime: string; sandboxed: boolean } | null {
  if (!artifactFileName(name)) {
    return null;
  }

  try {
    const root = realpathSync.native(dir);
    const real = realpathSync.native(join(dir, ...name.split('/')));
    const inside = relative(root, real);

    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !statSync(real).isFile()) {
      return null;
    }

    return { path: real, ...artifactMime(name) };
  } catch {
    return null;
  }
}

/** An artifact file's media type by its name, and whether it is served in the sandbox: an HTML page, an SVG, or a type with no known media type. */
export function artifactMime(name: string): { mime: string; sandboxed: boolean } {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';

  return { mime, sandboxed: artifactType(name) === 'html' || ext === 'svg' || mime === 'application/octet-stream' };
}

/** A file or folder the composer's picker offers, relative to the session's folder with forward slashes; a folder ends with a slash. */
export interface PageFile {
  path: string;
  dir: boolean;
}

/** Folders the page's file picker never walks into. */
export const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'bin', 'obj']);
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
