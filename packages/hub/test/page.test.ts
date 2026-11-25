import { gunzipSync, gzipSync } from 'node:zlib';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_PAGE_COMMANDS, listenHub } from '../src/server.js';
import { zip } from '../src/browserExtension.js';
import { unzip } from './zip.js';
import type { HubServer, PageRoutes } from '../src/server.js';
import type { RemoteAccess } from '../src/page.js';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { Store } from '@switchboard/core';
import { PAGE_CSP } from '../src/page.js';
import { artifactFile, cookieValue, deviceLabel, pairHtml, SIGNED_OUT_HTML, PAIR_CODE_TRIES, PAIR_MS, PAIR_SCRIPT, pageOrigin, dockRowOf, findFiles, pageHeader, loopbackHost, PageAccess, pageCookie, PUBLIC_PAGE_FILES, PAGE_LINK_MS, PAGE_SESSION_MS, PAGE_SESSIONS_KEPT, pageActionEvent, pageActions, pageCommandOf, pageGroups, pageList, pageOpens, pageReportOf, pasteText, poolRowOf, rowOpenUrl, tabUrl } from '../src/page.js';
import { dockView } from '../src/dock.js';
import type { DockView } from '../src/dock.js';
import { PAGE_ASSETS } from '@switchboard/web';
import { pageAsset } from '../src/pageAssets.js';
import { LOCAL_FILES_PAIRED_ONLY, localRoots, openLocalFile } from '../src/localFiles.js';
import { item, NOW, session, snapshot, triage } from './views.js';
import { until } from './helpers.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-page-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the signed-out and pairing pages', () => {
  it('draw at the device width with every text at its set size, which iOS would enlarge in landscape', () => {
    for (const html of [SIGNED_OUT_HTML, pairHtml(false), pairHtml(true)]) {
      expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
      expect(html).toContain('<style>html{-webkit-text-size-adjust:100%;text-size-adjust:100%}');
    }
  });
});

describe('PAIR_SCRIPT', () => {
  // Runs the pairing page's script against a stand-in for its input: each call sets the value and caret as the browser would before `input`.
  function codeBox() {
    const input = {
      value: '',
      selectionStart: 0 as number | null,
      listener: (_event: { isComposing: boolean }) => {},
      addEventListener(type: string, listener: (event: { isComposing: boolean }) => void) {
        expect(type).toBe('input');
        input.listener = listener;
      },
      setSelectionRange(start: number, end: number) {
        expect(end).toBe(start);
        input.selectionStart = start;
      },
    };

    runInNewContext(PAIR_SCRIPT, { document: { querySelector: (selector: string) => (selector === 'input[name=code]' ? input : null) } });
    return (value: string, caret = value.length, isComposing = false) => {
      input.value = value;
      input.selectionStart = caret;
      input.listener({ isComposing });
      return [input.value, input.selectionStart];
    };
  }

  it('upper-cases the code and adds the dash after the fourth character as it is typed', () => {
    const type = codeBox();

    expect(type('abc')).toEqual(['ABC', 3]);
    expect(type('ABCd')).toEqual(['ABCD', 4]);
    expect(type('ABCDe')).toEqual(['ABCD-E', 6]);
    expect(type('ABCD-EFGHJ')).toEqual(['ABCD-EFGH', 9]);
  });

  it('drops spaces, dashes and other characters from a paste and keeps 8', () => {
    const type = codeBox();

    expect(type(' abcd efgh ')).toEqual(['ABCD-EFGH', 9]);
    expect(type('a-b c.d_e/f g h j k')).toEqual(['ABCD-EFGH', 9]);
  });

  it('keeps the caret after the same characters on a backspace or an edit in the middle', () => {
    const type = codeBox();

    // Backspace over the dash puts it back, the caret before it.
    expect(type('ABCDEFGH', 4)).toEqual(['ABCD-EFGH', 4]);
    // Backspace over the character after the dash.
    expect(type('ABCD-FGH', 5)).toEqual(['ABCD-FGH', 5]);
    // Backspace over the second character.
    expect(type('ACD-EFGH', 1)).toEqual(['ACDE-FGH', 1]);
    // A character typed before the dash pushes the rest along.
    expect(type('ABXCD-EFG', 3)).toEqual(['ABXC-DEFG', 3]);
    expect(type('ABCDX-EFG', 5)).toEqual(['ABCD-XEFG', 6]);
  });

  it('leaves a value it would not change, and one still being composed, alone', () => {
    const type = codeBox();

    expect(type('ABCD-E', 2)).toEqual(['ABCD-E', 2]);
    expect(type('abc', 3, true)).toEqual(['abc', 3]);
  });
});

describe('PageAccess', () => {
  let store: Store;

  beforeEach(() => {
    store = Store.open(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('exchanges a token once, before it expires, for a cookie it then recognises', () => {
    let now = 1_000;
    const access = new PageAccess(store, () => now);
    const token = access.token();
    const cookie = access.exchange(token);

    expect(cookie).toMatch(/^[0-9a-f]{64}$/);
    expect(access.exchange(token)).toBeNull();
    expect(access.allows(`a=1; sb_page=${cookie}`)).toBe(true);
    expect(access.allows('sb_page=forged')).toBe(false);
    expect(access.allows(undefined)).toBe(false);

    const late = access.token();

    now += PAGE_LINK_MS + 1;
    expect(access.exchange(late)).toBeNull();
    expect(access.exchange('never-given')).toBeNull();
  });

  it('remembers a sign-in across a hub restart by its hash only, until it goes unused for 30 days, renewing it with use', () => {
    let now = 1_000;
    const first = new PageAccess(store, () => now);
    const cookie = first.exchange(first.token())!;
    const hash = createHash('sha256').update(cookie).digest('hex');

    expect(store.pageSession(hash)).toMatchObject({ createdAt: 1_000, usedAt: 1_000, host: null, login: null });
    expect(store.pageSession(cookie)).toBeNull();

    // A new hub reads the same store; its tokens are its own.
    const second = new PageAccess(store, () => now);

    now += PAGE_SESSION_MS - 1;
    expect(second.allows(`sb_page=${cookie}`)).toBe(true);
    expect(store.pageSession(hash)?.usedAt).toBe(now);
    now += PAGE_SESSION_MS;
    expect(second.allows(`sb_page=${cookie}`)).toBe(true);
    now += PAGE_SESSION_MS + 1;
    expect(second.allows(`sb_page=${cookie}`)).toBe(false);
    expect(store.pageSession(hash)).toBeNull();
    // A hash itself, sent as the cookie, is not a sign-in.
    const other = second.exchange(second.token())!;

    expect(second.allows(`sb_page=${createHash('sha256').update(other).digest('hex')}`)).toBe(false);
  });

  it('replaces the sign-in a browser already holds when it signs in again, keeps the 20 used last, and revokes them all', () => {
    let now = 1_000;
    const access = new PageAccess(store, () => now);
    const old = access.exchange(access.token())!;
    const renewed = access.exchange(access.token(), `x=1; sb_page=${old}`)!;

    expect(access.allows(`sb_page=${old}`)).toBe(false);
    expect(access.allows(`sb_page=${renewed}`)).toBe(true);

    const cookies = Array.from({ length: PAGE_SESSIONS_KEPT }, () => {
      now += 1;
      return access.exchange(access.token())!;
    });

    expect(access.allows(`sb_page=${renewed}`)).toBe(false);
    expect(cookies.every((cookie) => access.allows(`sb_page=${cookie}`))).toBe(true);
    expect(access.revokeAll()).toBe(PAGE_SESSIONS_KEPT);
    expect(cookies.some((cookie) => access.allows(`sb_page=${cookie}`))).toBe(false);
    expect(pageCookie('ab')).toBe(`sb_page=ab; HttpOnly; SameSite=Strict; Path=/; Max-Age=${PAGE_SESSION_MS / 1000}`);
  });

  it('reads a cookie by its name and answers the loopback names only', () => {
    expect(cookieValue('x=1; sb_page=abc=; y=2', 'sb_page')).toBe('abc=');
    expect(cookieValue('x=1', 'sb_page')).toBeNull();
    expect(loopbackHost('127.0.0.1:5000', 5000)).toBe(true);
    expect(loopbackHost('localhost:5000', 5000)).toBe(true);
    expect(loopbackHost('evil.example:5000', 5000)).toBe(false);
    expect(loopbackHost('127.0.0.1:5001', 5000)).toBe(false);
  });
});

describe('remote access', () => {
  let store: Store;

  beforeEach(() => {
    store = Store.open(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  const remote: RemoteAccess = { hosts: ['pc.tail.ts.net'], logins: ['alex@example.com'] };
  const proxied = { host: 'pc.tail.ts.net', 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.2', 'x-forwarded-host': 'pc.tail.ts.net', 'tailscale-user-login': 'Alex@Example.com' };

  it('takes a request with no proxy header as local by its loopback Host, and a proxied one as remote only from an allowed host and login over HTTPS', () => {
    expect(pageOrigin({ host: '127.0.0.1:5000' }, '127.0.0.1', 5000, remote)).toEqual({ host: null, login: null, origin: 'http://127.0.0.1:5000' });
    expect(pageOrigin({ host: 'localhost:5000' }, '::1', 5000, remote)).toEqual({ host: null, login: null, origin: 'http://localhost:5000' });
    expect(pageOrigin({ host: 'pc.tail.ts.net' }, '127.0.0.1', 5000, remote)).toEqual({ refused: 'The page is served only as 127.0.0.1 or localhost.' });
    expect(pageOrigin(proxied, '127.0.0.1', 5000, remote)).toEqual({ host: 'pc.tail.ts.net', login: 'alex@example.com', origin: 'https://pc.tail.ts.net' });
    expect(pageOrigin({ ...proxied, host: 'PC.tail.ts.net:443', 'x-forwarded-host': 'PC.tail.ts.net:443' }, '::ffff:127.0.0.1', 5000, remote)).toMatchObject({ host: 'pc.tail.ts.net', origin: 'https://pc.tail.ts.net' });
    // A peer that is not this computer is refused, though the hub listens on the loopback only.
    expect(pageOrigin({ host: '127.0.0.1:5000' }, '192.168.1.5', 5000, remote)).toHaveProperty('refused');
    // A proxied request is never local, even when it names the loopback, so a tailnet client cannot pass for this computer.
    expect(pageOrigin({ ...proxied, host: '127.0.0.1:5000', 'x-forwarded-host': '127.0.0.1:5000' }, '127.0.0.1', 5000, remote)).toHaveProperty('refused');
    expect(pageOrigin({ host: '127.0.0.1:5000', forwarded: 'for=1.2.3.4' }, '127.0.0.1', 5000, remote)).toHaveProperty('refused');
    expect(pageOrigin({ ...proxied, host: 'other.tail.ts.net', 'x-forwarded-host': 'other.tail.ts.net' }, '127.0.0.1', 5000, remote)).toEqual({ refused: 'The page is not served as this name. Set web.tailscale or web.remoteHosts in settings.json.' });
    expect(pageOrigin({ ...proxied, 'x-forwarded-proto': 'http' }, '127.0.0.1', 5000, remote)).toEqual({ refused: 'The page is served to another device only over HTTPS through tailscale serve.' });
    expect(pageOrigin({ ...proxied, 'x-forwarded-proto': undefined }, '127.0.0.1', 5000, remote)).toHaveProperty('refused');
    expect(pageOrigin({ ...proxied, 'x-forwarded-host': 'evil.example' }, '127.0.0.1', 5000, remote)).toHaveProperty('refused');
    expect(pageOrigin({ ...proxied, 'tailscale-funnel-request': '?1' }, '127.0.0.1', 5000, remote)).toEqual({ refused: 'The page is not served through Tailscale Funnel.' });
    const login = { refused: 'This Tailscale login may not use the page. Set web.tailscale or web.remoteLogins in settings.json.' };

    expect(pageOrigin({ ...proxied, 'tailscale-user-login': undefined }, '127.0.0.1', 5000, remote)).toEqual(login);
    expect(pageOrigin({ ...proxied, 'tailscale-user-login': 'mallory@example.com' }, '127.0.0.1', 5000, remote)).toEqual(login);
    // With no login allowed, no remote request is let in.
    expect(pageOrigin(proxied, '127.0.0.1', 5000, { hosts: remote.hosts, logins: [] })).toEqual(login);
  });

  it('gives a pairing link for its remote host only, uses its token or its code once, and binds the sign-in to that host and login', () => {
    let now = 1_000;
    const access = new PageAccess(store, () => now);
    const at = { host: 'pc.tail.ts.net', login: 'alex@example.com', origin: 'https://pc.tail.ts.net' } as const;
    const local = { host: null, login: null, origin: 'http://127.0.0.1:1' } as const;
    const pairing = access.pair('pc.tail.ts.net');
    const token = new URL(pairing.url).searchParams.get('t')!;

    expect(pairing).toMatchObject({ host: 'pc.tail.ts.net', expiresAt: 1_000 + PAIR_MS });
    expect(pairing.url).toBe(`https://pc.tail.ts.net/page?t=${token}`);
    expect(pairing.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    // Tried on this computer, a pairing token is refused and used up.
    expect(access.exchange(token, undefined, local, 'x')).toBeNull();
    expect(access.exchange(token, undefined, at, 'x')).toBeNull();
    expect(access.exchangeCode(pairing.code, undefined, at, 'x')).toBeNull();

    const second = access.pair('pc.tail.ts.net');
    const cookie = access.exchangeCode(second.code.toLowerCase().replace('-', ' '), undefined, at, 'Android · Chrome')!;

    expect(cookie).toMatch(/^[0-9a-f]{64}$/);
    expect(access.exchange(new URL(second.url).searchParams.get('t')!, undefined, at, 'x')).toBeNull();
    expect(access.allows(`sb_page=${cookie}`, at)).toBe(true);
    expect(access.allows(`sb_page=${cookie}`, local)).toBe(false);
    expect(access.allows(`sb_page=${cookie}`, { ...at, login: 'other@example.com' })).toBe(false);
    expect(access.allows(`sb_page=${cookie}`, { ...at, host: 'other.tail.ts.net' })).toBe(false);

    // A local token works only on this computer.
    const localToken = access.token();

    expect(access.exchange(localToken, undefined, at, 'x')).toBeNull();

    now += 1;

    const own = access.exchange(access.token(), undefined, local, 'Windows · Edge')!;

    expect(access.allows(`sb_page=${own}`, at)).toBe(false);
    expect(access.allows(`sb_page=${own}`)).toBe(true);
    // A code is never taken on this computer, and expires with its link.
    const third = access.pair('pc.tail.ts.net');

    expect(access.exchangeCode(third.code, undefined, local, 'x')).toBeNull();
    now += PAIR_MS + 1;
    expect(access.exchangeCode(third.code, undefined, at, 'x')).toBeNull();

    const devices = access.devices();

    expect(devices.map((one) => [one.label, one.host, one.login])).toEqual([
      ['Windows · Edge', null, null],
      ['Android · Chrome', 'pc.tail.ts.net', 'alex@example.com'],
    ]);
    expect(devices[1]!.id).toBe(createHash('sha256').update(cookie).digest('hex').slice(0, 8));
    expect(access.revoke('00000000')).toBeNull();
    expect(access.revoke(devices[1]!.id.toUpperCase())).toBe(createHash('sha256').update(cookie).digest('hex'));
    expect(access.allows(`sb_page=${cookie}`, at)).toBe(false);
    expect(access.devices()).toHaveLength(1);
  });

  it(`drops every code given out after ${PAIR_CODE_TRIES} wrong ones`, () => {
    const access = new PageAccess(store);
    const at = { host: 'pc.tail.ts.net', login: 'alex@example.com', origin: 'https://pc.tail.ts.net' } as const;
    const pairing = access.pair('pc.tail.ts.net');

    for (let wrong = 0; wrong < PAIR_CODE_TRIES; wrong++) {
      expect(access.exchangeCode('AAAA-AAAA', undefined, at, 'x')).toBeNull();
    }

    expect(access.exchangeCode(pairing.code, undefined, at, 'x')).toBeNull();
    expect(access.exchange(new URL(pairing.url).searchParams.get('t')!, undefined, at, 'x')).toBeNull();
    // A new code after that works.
    expect(access.exchangeCode(access.pair('pc.tail.ts.net').code, undefined, at, 'x')).toMatch(/^[0-9a-f]{64}$/);
    expect(pageCookie('ab', true)).toBe(`sb_page=ab; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${PAGE_SESSION_MS / 1000}`);
  });

  it('names a device by its system and browser', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36')).toBe('Android · Chrome');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0')).toBe('Windows · Edge');
    expect(deviceLabel('Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0')).toBe('Android · Firefox');
    expect(deviceLabel(undefined)).toBe('Unknown device · browser');
  });
});

describe('pageGroups', () => {
  it("lists each item work item with the conversations its window hosts, a folder's under the folder, and leaves done work out", () => {
    const own = item(1, { ticket: { ...item(1).ticket, title: 'Fix the badge' }, sessions: [session({ id: 's1', workItemId: 1, cwd: 'D:/w1' })] });
    const done = item(2, { status: 'done' });
    const view = snapshot([own, done]);
    const file = 'C:/sb/windows/x.code-workspace';
    const hostedByItem = item(3, { ticket: { ...item(3).ticket, title: 'Aside', hostWindow: file } });
    const hostedByFolder = item(4, { ticket: { ...item(4).ticket, title: 'Folder chat', hostWindow: 'D:/git/support' } });
    const groups = pageGroups(snapshot([own, done, hostedByItem, hostedByFolder]), 'C:/sb/windows');

    expect(groups.map((group) => group.ids).flat()).not.toContain(2);
    expect(groups.find((group) => group.kind === 'folder')).toEqual({ kind: 'folder', title: 'support', ids: [4] });
    // The hosted conversation's host window is not one of the listed work items' windows, so it is a group of its own.
    expect(groups.find((group) => group.ids.includes(3))?.kind).toBe('window');
    expect(groups.find((group) => group.ids.includes(1))).toEqual({ kind: 'item', title: 'Fix the badge', ids: [1] });
    expect(view.workItems).toHaveLength(2);
  });

  it("lists a conversation whose host is no path, such as a web page's key, as a work item of its own, not under a group named after the key", () => {
    const keyed = item(5, { ticket: { ...item(5).ticket, title: 'Page chat', hostWindow: 'a3f9c0de11b2a3f9c0de11b2' } });

    expect(pageGroups(snapshot([keyed]), 'C:/sb/windows')).toEqual([{ kind: 'item', title: 'Page chat', ids: [5] }]);
  });
});

describe('pageList', () => {
  const WINDOWS = 'C:/sb/windows';

  it("lists the list view's groups in its order with their titles and rows, work items only, hosted conversations where the list view puts them", () => {
    const own = item(1, { ticket: { ...item(1).ticket, title: 'Fix the badge' }, sessions: [session({ id: 's1', workItemId: 1, cwd: 'D:/w1' })] });
    const byFolder = item(4, { ticket: { ...item(4).ticket, title: 'Folder chat', hostWindow: 'D:/git/support' } });
    const byWindow = item(5, { ticket: { ...item(5).ticket, title: 'Aside', hostWindow: 'C:/sb/windows/x.code-workspace' } });
    const view = snapshot([own, byFolder, byWindow]);
    const dock = dockView(view, NOW, WINDOWS);
    const list = pageList(dock, view);
    const ownRow = dock.groups.flatMap((group) => group.rows).find((row) => row.key === 'item:1')!;

    expect(list.map((group) => [group.key, group.title, group.glyph])).toEqual(dock.groups.map((group) => [group.key, group.title, group.glyph]));
    expect(list.flatMap((group) => group.rows).find((row) => row.workItemId === 1)).toEqual({ workItemId: 1, ticketId: null, title: 'Fix the badge', priority: ownRow.priority, time: ownRow.time, ticket: ownRow.ticket, ticketNumber: ownRow.ticket.slice('gh '.length), sourceKind: ownRow.sourceKind, url: ownRow.url, playbook: ownRow.playbook, links: [], returned: ownRow.returned, comment: ownRow.comment, mark: ownRow.mark, details: ownRow.details, stripe: ownRow.stripe, dim: ownRow.dim, host: null, actions: pageActions(ownRow), main: null, pastes: [], opens: pageOpens(ownRow), search: ownRow.search, band: null, voice: null, history: { ticketId: own.ticket.id, key: ownRow.ticket } });
    // The voice target's row alone has the mic mark.
    const marked = pageList(dock, view, { row: 'item:1', glyph: '\u{ec12}', title: 'Voice is set to this session. Mic on.' }).flatMap((group) => group.rows);

    expect(marked.filter((row) => row.voice !== null).map((row) => [row.workItemId, row.voice])).toEqual([[1, { glyph: '\u{ec12}', title: 'Voice is set to this session. Mic on.' }]]);
    expect(pageOpens(ownRow).map((one) => one.label)).toEqual(['Open in VS Code']);
    // The list view's row offers Open in terminal for a session it can attach to or resume; the page leaves it out, as its Console tab shows that terminal.
    const codeMode = item(7, { status: 'running', sessions: [session({ id: 's7', workItemId: 7, codeMode: true, state: 'running' })] });
    const dock7 = dockView(snapshot([codeMode]), NOW, WINDOWS);
    const dockRow7 = dockRowOf(dock7, 7)!;
    const page7 = pageList(dock7, snapshot([codeMode])).flatMap((group) => group.rows).find((row) => row.workItemId === 7)!;

    expect(dockRow7.terminal !== null || dockRow7.commands.some((one) => one.command['type'] === 'terminal')).toBe(true);
    expect([...page7.opens, ...page7.actions].map((one) => one.label)).not.toContain('Open in terminal');
    // Each row in the list view's group, in its order, a hosted conversation with its host's name.
    expect(list.map((group) => group.rows.map((row) => row.workItemId))).toEqual(dock.groups.map((group) => group.rows.map((row) => Number(row.key.slice('item:'.length)))));
    expect(list.flatMap((group) => group.rows).filter((row) => row.host !== null).map((row) => [row.workItemId, row.host]).sort()).toEqual([[4, 'support'], [5, 'x']]);
    expect(list.some((group) => (group.key as string) === 'conversations')).toBe(false);
  });

  it('leaves out rows whose work item or pool ticket the snapshot lacks, and keeps a done hosted conversation in Done', () => {
    const doneHosted = item(6, { status: 'done', ticket: { ...item(6).ticket, title: 'Old chat', hostWindow: 'D:/git/support' } });
    const row = (key: string) => ({ key, title: key, ticket: 'gh 1', sourceKind: 'github', playbook: 'dev', links: [], details: [], mark: null, stripe: null, dim: false, controls: [], main: null, pastes: [], commands: [] }) as unknown as DockView['groups'][number]['rows'][number];
    const dock = { groups: [{ key: 'unstarted', title: 'Unstarted', glyph: 'u', empty: 'Nothing waits to be started.', rows: [row('ticket:9'), row('item:77')] }, { key: 'done', title: 'Done', glyph: 'd', empty: null, rows: [row('item:6')] }] } as Pick<DockView, 'groups'>;
    const list = pageList(dock, snapshot([doneHosted]));

    expect(list).toEqual([
      { key: 'unstarted', title: 'Unstarted', glyph: 'u', empty: 'Nothing waits to be started.', rows: [] },
      { key: 'done', title: 'Done', glyph: 'd', empty: null, rows: [expect.objectContaining({ workItemId: 6, host: 'support' })] },
    ]);
  });
});

describe('pageHeader', () => {
  it("offers the list view's sources, repo roots and schedules", () => {
    const sources = [{ kind: 'github', label: 'GitHub', enabled: true, title: 'gh: polled', sources: [{ name: 'gh', enabled: true }] }];

    expect(pageHeader({ notes: [], sources, repoRoots: ['D:/w1'], schedules: [{ name: 'nightly', playbook: 'dev:sweep' }] })).toEqual({ notes: [], sources, repoRoots: ['D:/w1'], schedules: [{ name: 'nightly', playbook: 'dev:sweep' }] });
  });

  it("carries the list view's holder notice and restart result", () => {
    const holderNotice = { text: 'The terminal holder is from an older build. Restart it to update.', confirm: { question: 'Restart the terminal holder?', detail: 'd', action: 'Restart and resume' } };
    const holderResult = { at: 5, text: 'The terminal holder restarted.', failed: false };
    const header = pageHeader({ notes: [], sources: [], repoRoots: [], schedules: [], holderNotice, holderResult });

    expect(header).toMatchObject({ holderNotice, holderResult });
    expect(pageHeader({ notes: [], sources: [], repoRoots: [], schedules: [] })).not.toHaveProperty('holderNotice');
  });

  it("carries the list view's notes and its held-session note, which is absent while every held session has a work item", () => {
    const notes = ['Settings: settings.json is not valid JSON.', 'Voice: the voice process stopped.'];
    const header = pageHeader({ notes, heldNote: '2 held sessions without a work item', sources: [], repoRoots: [], schedules: [] });

    expect(header).toMatchObject({ notes, heldNote: '2 held sessions without a work item' });
    expect(pageHeader({ notes: [], sources: [], repoRoots: [], schedules: [] })).not.toHaveProperty('heldNote');
    // The lost phone's note goes apart from the warning notes, untoned (PRD R119).
    expect(pageHeader({ notes: [], voiceNote: 'Voice stopped unexpectedly.', sources: [], repoRoots: [], schedules: [] })).toMatchObject({ notes: [], voiceNote: 'Voice stopped unexpectedly.' });
    expect(pageHeader({ notes: [], sources: [], repoRoots: [], schedules: [] })).not.toHaveProperty('voiceNote');
    // From the list view itself: a settings error is its note, and the page's.
    const view = snapshot([]);
    const broken = { ...view, errors: { ...view.errors, settings: 'settings.json is not valid JSON.' } };

    expect(pageHeader(dockView(broken, NOW, 'C:/sb/windows')).notes).toContain('Settings: settings.json is not valid JSON.');
  });
});

describe('pageList pool rows', () => {
  it("lists a pool ticket's row where the list view puts it, by its ticket, with Start or Triage again and its menu's other controls", () => {
    const ticket = { ...item(9).ticket, id: 9, pool: true, assigned: false, url: 'https://github.com/o/r/issues/9' };
    const picked = { ticket, triage: triage({ ticketId: 9, workItemId: null, playbook: 'dev:build' }), focus: null, links: [], returned: 0, playbookChoices: ['dev:build', 'dev:fix'] };
    const failed = { ...picked, ticket: { ...ticket, id: 10 }, triage: triage({ ticketId: 10, workItemId: null, playbook: null, error: 'Triage failed' } as never) };
    const view = snapshot([], { pool: [picked, failed] } as never);
    const dock = dockView(view, NOW, 'C:/sb/windows');
    const rows = pageList(dock, view).flatMap((group) => group.rows);
    const nine = rows.find((row) => row.ticketId === 9)!;

    expect(nine).toMatchObject({ workItemId: null, ticketId: 9, title: ticket.title, url: 'https://github.com/o/r/issues/9', main: 'Start', opens: [], host: null, history: { ticketId: 9, key: poolRowOf(dock, 9)!.ticket } });
    expect(nine.actions.map((one) => [one.label, one.group])).toEqual([['Start', 'main'], ['Start with guidance…', 'work'], ['Snooze…', 'state']]);
    expect(pageActionEvent(poolRowOf(dock, 9)!, 'Start', { until: null, comment: null })).toEqual({ event: { type: 'pick', ticketId: 9 } });
    expect(pageActionEvent(poolRowOf(dock, 9)!, 'Start with guidance…', { until: null, comment: null, text: 'Use staging', choice: 'dev:fix' })).toEqual({ event: { type: 'pick', ticketId: 9, guidance: 'Use staging', playbook: 'dev:fix' } });
    expect(poolRowOf(dock, 1)).toBeNull();
    expect(rows.find((row) => row.ticketId === 10)?.actions.map((one) => one.label)).toEqual(['Triage again', 'Snooze…']);
  });
});

describe('pageList rows', () => {
  it("carries the list row's three lines as the list view built them, without a pull request's status", () => {
    const dockRow = {
      key: 'item:3', title: 'Fix it', priority: 'Priority: P1', time: { text: '2h', title: 'In queue since 11:40' }, ticket: 'gh 3', sourceKind: 'github', url: 'https://github.com/o/r/issues/3', playbook: 'dev:build',
      links: [{ label: 'PR #9', url: 'https://github.com/o/r/pull/9', kind: 'pr', badge: '9', glyph: '\u{ea64}', mentioned: false, pr: { state: 'open' } }],
      returned: 2, comment: { glyph: 'c', title: 'Nov 20\nWaits on Sam' }, mark: { kind: 'limited', glyph: 'w', title: 'Rate limited' },
      details: [{ text: 'Rate limited · resumes 1:20 PM', title: 'Resets at 1:20 PM', tone: 'warning' }, { text: 'Post the reply', title: null, tone: null }],
      stripe: null, dim: false, controls: [], main: null, pastes: [], commands: [], search: 'Fix it · gh 3 · PR #9 · dev:build', band: 'Yesterday',
    } as unknown as DockView['groups'][number]['rows'][number];
    const dock = { groups: [{ key: 'progress', title: 'In progress', glyph: 'p', empty: null, rows: [dockRow] }] } as Pick<DockView, 'groups'>;
    const [shown] = pageList(dock, snapshot([item(3)]))[0]!.rows;

    expect(shown).toMatchObject({ priority: 'Priority: P1', time: { text: '2h', title: 'In queue since 11:40' }, url: 'https://github.com/o/r/issues/3', returned: 2, comment: { glyph: 'c', title: 'Nov 20\nWaits on Sam' }, mark: { kind: 'limited', glyph: 'w', title: 'Rate limited' }, details: dockRow.details });
    expect(shown!.links).toEqual([{ label: 'PR #9', url: 'https://github.com/o/r/pull/9', kind: 'pr', badge: '9', glyph: '\u{ea64}', mentioned: false }]);
    // The list's search matches the list view row's search text.
    expect(shown!.search).toBe('Fix it · gh 3 · PR #9 · dev:build');
    // A Done row's date band, under which the page draws it.
    expect(shown!.band).toBe('Yesterday');
  });
});

describe('pageActions', () => {
  const WINDOWS = 'C:/sb/windows';
  const rowOf = (one: ReturnType<typeof item>) => dockRowOf(dockView(snapshot([one]), NOW, WINDOWS), one.id)!;

  it("offers the row's Start, Approve, Retry, state controls and Delete in menu order, its main control, and asks before Stop session and Delete", () => {
    const unstarted = rowOf(item(1, { status: 'unstarted' }));

    expect(pageActions(unstarted).map((one) => one.label)).toEqual(['Start', 'Start with guidance…', 'Mark done', 'Snooze…', 'Add comment…', 'Delete']);
    expect(pageActions(unstarted).find((one) => one.action === 'delete')?.confirm).toEqual(unstarted.controls.find((one) => one.label === 'Delete')!.confirm);
    expect(pageActions(unstarted).map((one) => one.group)).toEqual(['main', 'work', 'state', 'state', 'notes', 'asking']);
    expect(pageActions(rowOf(item(2, { status: 'awaiting-approval' })))[0]).toEqual({ label: 'Approve', action: 'approve', icon: 'check', group: 'main', confirm: null, input: null });
    expect(pageActions(rowOf(item(3, { status: 'failed' }))).map((one) => one.action)).toContain('retry');

    const running = rowOf(item(4, { status: 'running', sessions: [session({ id: 's4', workItemId: 4, codeMode: true, state: 'running' })] }));
    const stop = pageActions(running).find((one) => one.action === 'stop');

    expect(stop?.confirm).toMatchObject({ action: 'Stop session', question: `Stop the session for ${running.ticket}?` });
    expect(pageActions(running).map((one) => one.action).at(-1)).toBe('delete');
  });

  it("builds the action from the row's own control, adds only Snooze's wake time and comment, and refuses one the row does not offer", () => {
    const row = rowOf(item(1, { status: 'unstarted' }));

    const none = { refused: 'The work item no longer offers this.' };

    expect(pageActionEvent(row, 'Start', { until: 5, comment: 'x', text: 'ignored' })).toEqual({ event: { type: 'start', workItemId: 1 } });
    expect(pageActionEvent(row, 'Snooze…', { until: 5, comment: 'later' })).toEqual({ event: { type: 'snooze', ticketId: row.controls.find((one) => one.label === 'Snooze…')!.action['ticketId'], until: 5, comment: 'later' } });
    expect((pageActionEvent(row, 'Snooze…', { until: null, comment: null }) as { event: object }).event).not.toHaveProperty('comment');
    expect(pageActionEvent(row, 'Approve', { until: null, comment: null })).toEqual(none);
    expect(pageActionEvent(row, 'Reopen', { until: null, comment: null })).toEqual(none);
    // An action type is not a label.
    expect(pageActionEvent(row, 'start', { until: null, comment: null })).toEqual(none);
  });

  it("offers Reopen with the state controls, and Ready for review's Move and Reset position as the order group, each running the row's own move", () => {
    const done = rowOf(item(1, { status: 'done', doneAt: NOW, reopenable: true }));

    expect(pageActions(done).map((one) => [one.label, one.group, one.icon])).toEqual([['Reopen', 'state', 'issue-reopened'], ['Add comment…', 'notes', 'comment'], ['Delete', 'asking', 'trash']]);
    expect(pageActionEvent(done, 'Reopen', { until: null, comment: null })).toEqual({ event: { type: 'reopen', workItemId: 1 } });

    const review = dockView(snapshot([item(1, { status: 'awaiting-approval', readyAt: NOW - 3 }), item(2, { status: 'awaiting-approval', readyAt: NOW - 2, orderAt: NOW }), item(3, { status: 'awaiting-approval', readyAt: NOW - 1 })]), NOW, WINDOWS);
    const ids = review.groups.find((group) => group.key === 'review')!.rows.map((row) => Number(row.key.slice('item:'.length)));
    const middle = dockRowOf(review, ids[1]!)!;
    const moves = pageActions(middle).filter((one) => one.group === 'order');

    expect(moves.map((one) => one.label)).toEqual(['Move to top', 'Move up', 'Move down', ...(middle.controls.some((one) => one.label === 'Reset position') ? ['Reset position'] : [])]);
    expect(moves.map((one) => one.icon).slice(0, 3)).toEqual(['arrow-circle-up', 'arrow-up', 'arrow-down']);
    // The order group comes after the state controls and before Delete.
    expect(pageActions(middle).map((one) => one.group).filter((group, index, all) => all.indexOf(group) === index)).toEqual(['main', 'work', 'state', 'notes', 'order', 'asking'].filter((group) => pageActions(middle).some((one) => one.group === group)));
    expect(pageActionEvent(middle, 'Move down', { until: null, comment: null })).toEqual({ event: { type: 'move', workItemId: ids[1], after: ids[2] } });
    expect(pageActionEvent(middle, 'Move to top', { until: null, comment: null })).toEqual({ event: { type: 'move', workItemId: ids[1], after: null } });
  });

  it("asks for the control's input text, sets it and a changed choice as the hub's own fields, and refuses a blank text or a choice not offered", () => {
    const row = rowOf(item(1, { status: 'unstarted', playbook: 'dev:build', playbookChoices: ['dev:build', 'dev:fix'] }));
    const guided = pageActions(row).find((one) => one.label === 'Start with guidance…')!;

    // The page gets the question, never the field names.
    expect(guided.input).toEqual({ question: 'Start with guidance', detail: expect.any(String), action: 'Start', text: null, choice: { label: 'Playbook', value: 'dev:build', values: ['dev:build', 'dev:fix'] } });
    expect(guided.input).not.toHaveProperty('field');
    expect(guided.input?.choice).not.toHaveProperty('field');
    expect(pageActionEvent(row, 'Start with guidance…', { until: null, comment: null, text: '  Use the staging DB ', choice: 'dev:build' })).toEqual({ event: { type: 'start', workItemId: 1, guidance: 'Use the staging DB' } });
    expect(pageActionEvent(row, 'Start with guidance…', { until: null, comment: null, text: '', choice: 'dev:fix' })).toEqual({ event: { type: 'start', workItemId: 1, guidance: '', playbook: 'dev:fix' } });
    expect(pageActionEvent(row, 'Start with guidance…', { until: null, comment: null, text: '   ', choice: 'dev:build' })).toEqual({ refused: 'Start with guidance needs a text.' });
    expect(pageActionEvent(row, 'Start with guidance…', { until: null, comment: null, text: 'x', choice: 'ops:wipe' })).toEqual({ refused: 'Choose one of the offered playbooks.' });
    expect(pageActionEvent(row, 'Add comment…', { until: null, comment: null, text: 'Asked Ana' })).toEqual({ event: { type: 'comment', workItemId: 1, text: 'Asked Ana' } });
    expect(pageActionEvent(row, 'Add comment…', { until: null, comment: null })).toEqual({ refused: 'Add comment needs a text.' });

    const adhoc = rowOf(item(2, { status: 'unstarted', playbook: null, ticket: { ...item(2).ticket, source: 'adhoc', sourceKey: '9', url: '' }, prompt: 'Fix the build' } as never));
    const prompted = pageActions(adhoc).find((one) => one.label === 'Start with prompt…');

    if (prompted !== undefined) {
      expect(prompted.input?.text).toBe('Fix the build');
      expect(prompted.group).toBe(adhoc.main === 'Start with prompt…' ? 'main' : 'work');
      expect(pageActionEvent(adhoc, 'Start with prompt…', { until: null, comment: null, text: 'Fix the tests' })).toEqual({ event: { type: 'start', workItemId: 2, prompt: 'Fix the tests' } });
    }
  });

  it("offers Open in VS Code for a row with a window, then the row's Open report with its draft, never History, Open changes or Open in terminal", () => {
    const worktree = { id: 1, ticketId: 1, path: 'D:/git/wt/101', branch: '101', linkedBy: 'report' as const };
    const review = rowOf(item(1, { status: 'awaiting-approval', worktree, approvalReport: 'D:/git/wt/101/report.md' }));

    expect(pageOpens(review)).toEqual([{ label: 'Open in VS Code', icon: 'vscode' }, { label: 'Open report', icon: 'symbol-file', file: 'D:/git/wt/101/report.md' }]);
    expect(pageReportOf(review)).toBe('D:/git/wt/101/report.md');
    // The list view's row offers History and Open changes; the page shows History itself and its Changes tab replaces Open changes.
    expect(review.commands.map((one) => one.label)).toEqual(expect.arrayContaining(['History', 'Open changes']));
    expect(pageCommandOf(review, 'Open changes')).toEqual({ refused: 'The work item no longer offers this.' });
    // Open report opens on the page, never through VS Code.
    expect(pageCommandOf(review, 'Open report')).toEqual({ refused: 'Open report opens on the page.' });
    expect(pageCommandOf(review, 'Open in VS Code')).toEqual({ destination: review.window!.file });
    expect(pageCommandOf(review, 'History')).toEqual({ refused: 'The work item no longer offers this.' });
    expect(pageCommandOf(review, 'Open in terminal')).toEqual({ refused: 'The work item no longer offers this.' });

    // A row with no window opens nothing in VS Code, and still opens its report on the page.
    const windowless = { window: null, commands: review.commands };

    expect(pageOpens(windowless)).toEqual([{ label: 'Open report', icon: 'symbol-file', file: 'D:/git/wt/101/report.md' }]);
    expect(pageCommandOf(windowless, 'Open in VS Code')).toEqual({ refused: 'The work item no longer offers this.' });
    // A row that is not awaiting approval has no report.
    expect(pageReportOf(rowOf(item(1, { worktree, approvalReport: 'D:/git/wt/101/report.md' })))).toBeNull();
    // A folder-hosted conversation opens its folder.
    expect(pageCommandOf({ window: { name: 'f', title: 't', folders: ['D:/w'], file: null, hosted: true, folder: 'D:/w' }, commands: [] }, 'Open in VS Code')).toEqual({ destination: 'D:/w' });
  });

  it("opens only the row's own http or https ticket URL or link, unchanged but for the URL parser's form", () => {
    const row = { url: 'https://github.com/o/r/issues/1', links: [{ url: 'https://example.test/a?b=1#top' }, { url: 'javascript:alert(1)' }, { url: 'file:///C:/x' }] };

    expect(rowOpenUrl(row, 'https://github.com/o/r/issues/1')).toBe('https://github.com/o/r/issues/1');
    expect(rowOpenUrl(row, 'https://example.test/a?b=1#top')).toBe('https://example.test/a?b=1#top');
    // A link the row holds but that is not http or https, or a URL the row does not hold, never opens.
    expect(rowOpenUrl(row, 'javascript:alert(1)')).toBeNull();
    expect(rowOpenUrl(row, 'file:///C:/x')).toBeNull();
    expect(rowOpenUrl(row, 'https://evil.test/')).toBeNull();
    expect(rowOpenUrl({ url: '', links: [] }, '')).toBeNull();
    // The parser's form goes out, so a space or quote cannot split the browser's argument.
    expect(tabUrl('https://example.test/a b"c')).toBe('https://example.test/a%20b%22c');
    expect(tabUrl('https://example.test/?q=1#x')).toBe('https://example.test/?q=1#x');
    expect(tabUrl('not a url')).toBeNull();
  });

  it('reads a drafted text as Copy pastes it, without a byte order mark or trailing whitespace', async () => {
    writeFileSync(join(dir, 'reply.md'), '\uFEFFDear Ana,\n\nThanks.  \n\n');
    expect(await pasteText(join(dir, 'reply.md'))).toBe('Dear Ana,\n\nThanks.');
  });
});

describe('artifactFile', () => {
  it('serves a file inside the artifact folder and refuses names and links that leave it', () => {
    const folder = join(dir, 'w1');

    mkdirSync(join(folder, 'chat', 'page'), { recursive: true });
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(folder, 'chat', 'page.html'), '<p>hi</p>');
    writeFileSync(join(folder, 'chat', 'page', 'pic.svg'), '<svg/>');
    writeFileSync(join(folder, 'chat', 'notes.md'), '# n');
    writeFileSync(join(folder, 'chat', 'run.log'), 'line');
    writeFileSync(join(folder, 'chat', 'blob.bin'), 'x');
    writeFileSync(join(dir, 'outside', 'secret.md'), 'secret');
    symlinkSync(join(dir, 'outside'), join(folder, 'chat', 'link'), 'junction');

    expect(artifactFile(folder, 'chat/page.html')).toMatchObject({ mime: 'text/html; charset=utf-8', sandboxed: true });
    expect(artifactFile(folder, 'chat/page/pic.svg')).toMatchObject({ mime: 'image/svg+xml', sandboxed: true });
    expect(artifactFile(folder, 'chat/notes.md')).toMatchObject({ sandboxed: false });
    // Text, data and code are plain text, which a new window shows; an unknown file stays a sandboxed download.
    expect(artifactFile(folder, 'chat/run.log')).toMatchObject({ mime: 'text/plain; charset=utf-8', sandboxed: false });
    expect(artifactFile(folder, 'chat/blob.bin')).toMatchObject({ mime: 'application/octet-stream', sandboxed: true });
    expect(artifactFile(folder, '../outside/secret.md')).toBeNull();
    expect(artifactFile(folder, 'chat/link/secret.md')).toBeNull();
    expect(artifactFile(folder, 'chat/.hidden')).toBeNull();
    expect(artifactFile(folder, 'chat')).toBeNull();
    expect(artifactFile(folder, 'chat/missing.md')).toBeNull();
  });
});

describe('findFiles', () => {
  it('finds files and folders holding the query, name matches first, and never walks into skipped folders', async () => {
    mkdirSync(join(dir, 'src', 'hello'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'hello'), { recursive: true });
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'src', 'hello', 'index.ts'), '');
    writeFileSync(join(dir, 'src', 'say-hello.ts'), '');
    writeFileSync(join(dir, 'node_modules', 'hello', 'hello.js'), '');
    writeFileSync(join(dir, '.git', 'hello'), '');

    expect(await findFiles(dir, 'HELLO')).toEqual([
      { path: 'src/hello/', dir: true },
      { path: 'src/say-hello.ts', dir: false },
      { path: 'src/hello/index.ts', dir: false },
    ]);
    expect(await findFiles(join(dir, 'missing'), '')).toEqual([]);
  });
});

describe('pageAsset', () => {
  it("serves the page's own files and Mermaid from the home, and nothing else", () => {
    expect(pageAsset('index.html', dir)?.mime).toBe('text/html; charset=utf-8');
    expect(Buffer.isBuffer(pageAsset('codicon.ttf', dir)?.body)).toBe(true);
    // VS Code's Seti file icons, with their licence in the mapping.
    expect(pageAsset('seti.woff', dir)?.mime).toBe('font/woff');
    expect((pageAsset('seti.woff', dir)?.body as Buffer).subarray(0, 4).toString()).toBe('wOFF');
    expect(JSON.parse(String(pageAsset('file-icons.json', dir)?.body)).license).toContain('Copyright (c) 2014 Jesse Weed');
    // Every file served without a sign-in is one of the page's own.
    expect([...PUBLIC_PAGE_FILES].filter((name) => pageAsset(name, dir) === null)).toEqual([]);
    expect(pageAsset('mermaid.min.js', dir)).toBeNull();
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'mermaid.min.js'), 'mermaid');
    expect(String(pageAsset('mermaid.min.js', dir)?.body)).toBe('mermaid');
    expect(pageAsset('toString', dir)).toBeNull();
    expect(pageAsset('../hub.json', dir)).toBeNull();
  });

  it('serves each shell file for good, gzipped, under the hashed name the page loads it by, which the page names with its boot script allowed by its hash', () => {
    const page = String(pageAsset('index.html', dir)?.body);

    for (const name of ['page.js', 'page.css', 'theme.css', 'codicon.css', 'codicon.ttf']) {
      const hashed = PAGE_ASSETS[name]!.hashed!;
      const shell = pageAsset(hashed, dir)!;

      expect(hashed).toMatch(new RegExp(`^${name.replace(/\.(\w+)$/, '')}-[0-9a-f]{16}\\.${name.split('.').pop()}$`));
      expect(shell.immutable).toBe(true);
      expect(gunzipSync(shell.gzip!).equals(Buffer.from(shell.body as string | Buffer))).toBe(true);
      // Its plain name stays, served as any page file, never kept for good.
      expect(pageAsset(name, dir)?.immutable).toBeUndefined();

      if (name !== 'codicon.ttf') {
        expect(page).toContain(`"${hashed}"`);
      }
    }

    expect(String(pageAsset(PAGE_ASSETS['codicon.css']!.hashed!, dir)?.body)).toContain(`url("./${PAGE_ASSETS['codicon.ttf']!.hashed!}")`);

    const boot = /<script>([\s\S]*?)<\/script>/.exec(page)![1]!;

    expect(PAGE_CSP).toContain(`script-src 'self' 'sha256-${createHash('sha256').update(boot).digest('base64')}'`);
    expect(pageAsset('page-0123456789abcdef.js', dir)).toBeNull();
  });

  it("serves the audio worklet for good under its content's hash, and under another build's name or none without keeping it", () => {
    const name = Object.keys(PAGE_ASSETS).find((one) => /^voice-worklet-[0-9a-f]{16}\.js$/.test(one))!;
    const worklet = pageAsset(name, dir);

    expect(worklet).toMatchObject({ mime: 'text/javascript; charset=utf-8', immutable: true });
    expect(String(worklet?.body)).toContain('sb-capture');

    for (const other of ['voice-worklet.js', 'voice-worklet-0123456789abcdef.js']) {
      expect(pageAsset(other, dir)).toEqual({ mime: worklet!.mime, body: worklet!.body });
    }

    expect(pageAsset('voice-worklet-x.js', dir)).toBeNull();
  });
});

/** A port nothing listens on now. */
async function freePort(): Promise<number> {
  const probe = createServer();

  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));

  const port = (probe.address() as { port: number }).port;

  await new Promise((done) => probe.close(done));
  return port;
}

/** A request with chosen headers, answering its status, headers and body. */
function send(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const outbound = request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      let text = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
    });

    outbound.on('error', reject);
    outbound.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** A POST of raw bytes, answering its status and body; `length` replaces the Content-Length header, and null sends the body chunked. */
function sendBytes(port: number, path: string, headers: Record<string, string>, body: Buffer, length: number | null = body.length): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const outbound = request({ host: '127.0.0.1', port, method: 'POST', path, headers: { Host: `127.0.0.1:${port}`, ...headers, ...(length === null ? {} : { 'Content-Length': String(length) }) } }, (response) => {
      let text = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
    });

    outbound.on('error', reject);
    // A length larger than the body is refused before the body is read, so none is sent; a body written before the end goes chunked.
    if (length === null) {
      outbound.write(body);
      outbound.end();
    } else {
      outbound.end(length > body.length ? undefined : body);
    }
  });
}

describe('the web page routes', () => {
  let server: HubServer;
  let store: Store;

  beforeEach(() => {
    store = Store.open(':memory:');
  });

  afterEach(async () => {
    await server.close();
    store.close();
  });

  // The remote hosts and logins the served page reads, none until a test sets them.
  let remoteAccess: RemoteAccess = { hosts: [], logins: [] };

  async function serve(hubLog: PageRoutes['hubLog'] = async (lines) => ({ text: `2026-11-22T12:00:00Z ${lines} lines\n`, more: lines < 1000, limited: false, missing: false }), heartbeatMs?: number) {
    const iframe = { enabled: false };
    const uploadLogs: string[] = [];
    remoteAccess = { hosts: [], logins: [] };
    const posted: unknown[] = [];
    const uploaded: unknown[] = [];
    const closed: string[] = [];
    const consoles: string[] = [];
    const pages = new Set<string>();
    const installed: boolean[] = [];
    let keys = 0;
    const folder = join(dir, 'w1');

    mkdirSync(join(folder, 'chat'), { recursive: true });
    writeFileSync(join(folder, 'chat', 'page.html'), '<script>1</script>');

    const browserPosts: unknown[] = [];
    const page: PageRoutes = {
      access: new PageAccess(store),
      remote: () => remoteAccess,
      hubLog,
      browser: {
        iframeEnabled: () => iframe.enabled,
        snoozed: () => ['https://github.com/o/r/issues/1'],
        cards: () => [{ url: 'https://github.com/o/r/issues/2', playbook: 'dev:new-dev', group: 'progress', snoozed: false, workItemId: 7 }],
        snooze: (url, until) => {
          browserPosts.push({ snooze: url, until });
          return url.endsWith('/2') ? { refused: null } : null;
        },
        unsnooze: (url) => {
          browserPosts.push({ unsnooze: url });
          return url.endsWith('/2') ? { refused: null } : null;
        },
        download: (origin) => zip([{ name: 'switchboard-extension/remote.json', body: Buffer.from(JSON.stringify({ origin })) }]),
      },
      asset: (name) => (name === 'diff/b1/diff.js' ? { mime: 'text/javascript; charset=utf-8', body: 'plain', immutable: true, gzip: gzipSync('plain') } : name === 'index.html' ? { mime: 'text/html; charset=utf-8', body: '<html>page {{build}}</html>' } : ['manifest.webmanifest', 'sw.js', 'page.js'].includes(name) ? { mime: 'text/plain', body: name } : null),
      opened: (app) => {
        const key = `page-${++keys}`;

        pages.add(key);
        installed.push(app === true);
        return key;
      },
      isPage: (key) => pages.has(key),
      list: () => [{ kind: 'item', title: 'T', conversations: [] }],
      files: async (key) => (key === 'page-1' ? [{ path: 'a.ts', dir: false }] : null),
      changes: async (route, key, query) => (route === 'changes' && key === 'page-1' ? { status: 200, body: { rows: 'x'.repeat(2000), q: query.get('q') }, etag: 'e1' } : { status: 403, body: { error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' } }),
      artifact: (key, name) => {
        const external = join(folder, 'report.md');

        // An external artifact's file comes open with its checked size, as the hub's service hands it over.
        if (key === 'page-1' && (name === '@1/report.md' || name === '@1/empty.md')) {
          writeFileSync(external, '# Report grown later');
          return { path: external, mime: 'text/markdown; charset=utf-8', sandboxed: false, fd: openSync(external, 'r'), size: name === '@1/empty.md' ? 0 : 8 };
        }

        return key === 'page-1' ? artifactFile(folder, name) : null;
      },
      localFile: async (key, target, paired) => (pages.has(key) ? openLocalFile(localRoots({ folder, cwd: folder }, [], null, paired), target) : null),
      upload: (key, scopeGen, name, bytes) => {
        uploaded.push({ key, scopeGen, name, bytes: Buffer.from(bytes).toString('utf8') });
        return { status: 200, body: { path: 'C:\\Temp\\a.txt', image: false } };
      },
      console: (key, sessionId, write) => {
        if (key !== 'page-1' || sessionId !== 's1') {
          return { status: 403, error: 'This page now shows another work item or session, so that was not done. Check what it shows and try again.' };
        }

        write('size', { cols: 80, rows: 24 });
        write('data', { data: 'hello\r\n' });
        return { close: () => consoles.push(`closed ${key}`) };
      },
    };

    server = await listenHub({
      identity: { hub: 'switchboard', protocol: 1, version: '0', pid: 1 },
      onShutdown: () => {},
      log: (line) => uploadLogs.push(line),
      page,
      build: 'b7',
      ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
      windowClosed: (key) => closed.push(key),
      conversation: (key, write) => {
        write(`event: hello\ndata: {"key":"${key}"}\n\n`);
        return { close: () => {} };
      },
      post: {
        '/v1/conversation/select': async (body) => {
          posted.push(body);
          return { status: 200, body: { scopeGen: 1 } };
        },
        '/v1/conversation/new-conversation': async () => ({ status: 200, body: {} }),
        '/v1/conversation/resume': async (body) => {
          posted.push(body);
          return { status: 200, body: {} };
        },
        '/v1/conversation/row-action': async (body) => {
          posted.push(body);
          return { status: 200, body: {} };
        },
        '/v1/conversation/console-input': async (body) => {
          posted.push(body);
          return { status: 200, body: { done: true } };
        },
        '/v1/conversation/page-source': async (body) => {
          posted.push(body);
          return { status: 200, body: {} };
        },
        '/v1/conversation/page-history': async (body) => {
          posted.push(body);
          return { status: 200, body: {} };
        },
        '/v1/conversation/page-holder-restart': async (body) => {
          posted.push(body);
          return { status: 200, body: { started: true } };
        },
        ...Object.fromEntries(
          ['row-open', 'page-settings-read', 'page-settings-check', 'page-settings-save', 'page-voice-enroll', 'page-voice-computer', 'brief-replies', 'page-new-session', 'page-folders'].map((command) => [
            `/v1/conversation/${command}`,
            async (body: unknown) => {
              posted.push(body);
              return { status: 200, body: { command } };
            },
          ]),
        ),
        '/holder/open': async (body) => { posted.push(body); return { status: 200, body: { done: true } }; },
        '/holder/list': async (body) => { posted.push(body); return { status: 200, body: { held: [] } }; },
        '/holder/stop': async (body) => { posted.push(body); return { status: 200, body: { stopped: 's' } }; },
        '/page-url': async (_body, context) => ({ status: 200, body: { url: await context!.pageUrl() } }),
        '/v1/conversation/page-settings-save': async (body) => {
          posted.push(body);
          return { status: 200, body: {} };
        },
      },
    });

    const link = await send(server.port, 'POST', '/page/link', { Authorization: `Bearer ${server.token}` });
    const url = new URL(JSON.parse(link.body).url as string);

    return { posted, uploaded, uploadLogs, closed, consoles, url, folder, installed, browserPosts, iframe, access: page.access, open: () => page.opened() };
  }

  it('serves a read-only hub log tail only to a signed-in page with a valid line count', async () => {
    await serve();
    const link = new URL(JSON.parse((await send(server.port, 'POST', '/page/link', { Authorization: `Bearer ${server.token}` })).body).url);
    const exchange = await send(server.port, 'GET', `${link.pathname}${link.search}`, {});
    const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
    const get = (query = '', headers = { Cookie: cookie }) => send(server.port, 'GET', `/v1/page/hub-log${query}`, headers);
    expect((await get('', { Cookie: 'sb_page=forged' })).status).toBe(401);
    expect((await send(server.port, 'GET', '/v1/page/hub-log', {})).status).toBe(401);
    const tail = await get();
    expect(tail.status).toBe(200);
    expect(tail.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(tail.body)).toEqual({ text: '2026-11-22T12:00:00Z 500 lines\n', more: true, limited: false, missing: false });
    expect(JSON.parse((await get('?lines=1000')).body).more).toBe(false);
    for (const count of ['0', '-1', '1.5', 'abc', '', '20001', 'Infinity']) expect((await get(`?lines=${count}`)).status).toBe(400);
    expect((await send(server.port, 'POST', '/v1/page/hub-log', { Cookie: cookie })).status).toBe(405);
  });

  it('allows the hub log on a paired device only through its allowed host and Tailscale login', async () => {
    await serve();
    remoteAccess = { hosts: ['pc.tail.ts.net'], logins: ['alex@example.com'] };
    const headers = { Host: 'pc.tail.ts.net', 'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': 'alex@example.com' };
    const pairing = JSON.parse((await send(server.port, 'POST', '/page/pair', { Authorization: `Bearer ${server.token}` })).body);
    const link = new URL(pairing.url);
    const exchange = await send(server.port, 'GET', `${link.pathname}${link.search}`, headers);
    const Cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
    expect((await send(server.port, 'GET', '/v1/page/hub-log', headers)).status).toBe(401);
    expect((await send(server.port, 'GET', '/v1/page/hub-log', { ...headers, Cookie })).status).toBe(200);
    expect((await send(server.port, 'GET', '/v1/page/hub-log', { ...headers, Cookie, 'Tailscale-User-Login': 'someone@example.com' })).status).toBe(403);
    expect((await send(server.port, 'GET', '/v1/page/hub-log', { Cookie })).status).toBe(401);
    remoteAccess = { hosts: [], logins: [] };
    expect((await send(server.port, 'GET', '/v1/page/hub-log', { ...headers, Cookie })).status).toBe(403);
  });

  it('withholds a pending hub log read when access is revoked and reports read failures without paths', async () => {
    let release: (() => void) | undefined;
    let fail = false;
    await serve(async () => {
      if (fail) throw new Error('EACCES C:/private/hub.log');
      await new Promise<void>((done) => { release = done; });
      return { text: 'private', more: false, limited: false, missing: false };
    });
    const link = new URL(JSON.parse((await send(server.port, 'POST', '/page/link', { Authorization: `Bearer ${server.token}` })).body).url);
    const exchange = await send(server.port, 'GET', `${link.pathname}${link.search}`, {});
    const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
    fail = true;
    const failure = await send(server.port, 'GET', '/v1/page/hub-log', { Cookie: cookie });
    expect(failure.status).toBe(500);
    expect(JSON.parse(failure.body)).toEqual({ error: 'The hub log could not be read.' });
    fail = false;
    const pending = send(server.port, 'GET', '/v1/page/hub-log', { Cookie: cookie });
    await until(() => release ?? null);
    await send(server.port, 'POST', '/page/revoke', { Authorization: `Bearer ${server.token}` });
    release!();
    const refused = await pending;
    expect(refused.status).toBe(403);
    expect(refused.body).not.toContain('private');
  });

  it('gates the iframe status by page sign-in and permits only the extension ancestor in the embedded page CSP', async () => {
    const { url, iframe } = await serve();
    expect((await send(server.port, 'GET', '/v1/browser/iframe', {})).status).toBe(401);
    const exchange = await send(server.port, 'GET', `${url.pathname}${url.search}`, {});
    const Cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
    expect(JSON.parse((await send(server.port, 'GET', '/v1/browser/iframe', { Cookie })).body)).toEqual({ enabled: false });
    const off = await send(server.port, 'GET', '/page/', { Cookie });
    expect(off.headers['content-security-policy']).toContain("frame-src 'self';");
    iframe.enabled = true;
    expect(JSON.parse((await send(server.port, 'GET', '/v1/browser/iframe', { Cookie })).body)).toEqual({ enabled: true });
    const on = await send(server.port, 'GET', '/page/', { Cookie });
    expect(on.headers['content-security-policy']).toContain("frame-src 'self';");
    expect(on.headers['content-security-policy']).toContain('frame-ancestors chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije');
    expect(on.headers['x-frame-options']).toBe('DENY');
  });

  it('invalidates cached HTML when its extension framing policy changes in either direction', async () => {
    const { url, iframe } = await serve();
    const exchange = await send(server.port, 'GET', `${url.pathname}${url.search}`, {});
    const Cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
    const off = await send(server.port, 'GET', '/page/', { Cookie });
    expect(off.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await send(server.port, 'GET', '/page/', { Cookie, 'If-None-Match': String(off.headers['etag']) })).status).toBe(304);

    iframe.enabled = true;
    const on = await send(server.port, 'GET', '/page/', { Cookie, 'If-None-Match': String(off.headers['etag']) });
    expect(on.status).toBe(200);
    expect(on.headers['etag']).not.toBe(off.headers['etag']);
    expect(on.headers['content-security-policy']).toContain('frame-ancestors chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije');
    expect(on.headers['x-frame-options']).toBe('DENY');
    expect((await send(server.port, 'GET', '/page/', { Cookie, 'If-None-Match': String(on.headers['etag']) })).status).toBe(304);

    iframe.enabled = false;
    const disabled = await send(server.port, 'GET', '/page/', { Cookie, 'If-None-Match': String(on.headers['etag']) });
    expect(disabled.status).toBe(200);
    expect(disabled.headers['etag']).toBe(off.headers['etag']);
    expect(disabled.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(disabled.headers['x-frame-options']).toBe('DENY');
  });

  it("serves the page on its fixed port, which the link names, by that port's Host only, and nothing but the page there", async () => {
    const { posted, installed } = await serve();

    const port = await freePort();

    expect(await server.listenPage(port)).toBeNull();

    const link = JSON.parse((await send(server.port, 'POST', '/page/link', { Authorization: `Bearer ${server.token}` })).body) as { url: string; notice?: string };
    const url = new URL(link.url);

    expect(url.host).toBe(`127.0.0.1:${port}`);
    expect(link.notice).toBeUndefined();

    const exchange = await send(port, 'GET', `${url.pathname}${url.search}`, {});
    const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;

    expect(exchange.status).toBe(303);
    expect((await send(port, 'GET', '/page/', { Cookie: cookie })).status).toBe(200);
    expect((await send(port, 'GET', '/page/', { Cookie: cookie, Host: `localhost:${port}` })).status).toBe(200);
    // The hub's own port is another address for the page listener.
    expect((await send(port, 'GET', '/page/', { Cookie: cookie, Host: `127.0.0.1:${server.port}` })).status).toBe(403);
    expect((await send(port, 'GET', '/status', { Authorization: `Bearer ${server.token}` })).status).toBe(404);
    expect((await send(port, 'POST', '/page/link', { Authorization: `Bearer ${server.token}` })).status).toBe(404);
    expect((await send(port, 'GET', '/hub', {})).status).toBe(404);

    // The page's commands work there with the cookie and that port's own origin only.
    const stream = request({ host: '127.0.0.1', port, path: '/v1/conversation/events?page=1&installed=1', headers: { Host: `127.0.0.1:${port}`, Cookie: cookie } }, (response) => response.resume());

    stream.on('error', () => {});
    stream.end();
    await until(() => (server.clients() === 1 ? true : null));
    // The installed app says so as it opens its stream; the hub's routes learn the page's address on its fixed port.
    expect(installed).toEqual([true]);
    expect(JSON.parse((await send(server.port, 'POST', '/page-url', { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, {})).body)).toEqual({ url: `http://127.0.0.1:${port}/page/` });

    const post = (path: string, origin: string, headers: Record<string, string> = { Cookie: cookie }) => send(port, 'POST', path, { 'Content-Type': 'application/json', Origin: origin, ...headers }, { window: 'page-1', workItemId: 4 });

    expect((await post('/v1/conversation/resume', `http://127.0.0.1:${port}`)).status).toBe(200);
    expect((await post('/v1/conversation/row-action', `http://127.0.0.1:${port}`)).status).toBe(200);
    // The list header's commands are page commands too, under the same cookie and origin checks.
    expect((await post('/v1/conversation/page-source', `http://127.0.0.1:${port}`)).status).toBe(200);
    expect((await post('/v1/conversation/page-source', `http://127.0.0.1:${server.port}`)).status).toBe(403);
    expect((await post('/v1/conversation/page-source', `http://127.0.0.1:${port}`, {})).status).toBe(404);
    // So are Settings' reads and saves of settings.json.
    expect((await post('/v1/conversation/page-settings-save', `http://127.0.0.1:${port}`)).status).toBe(200);
    expect((await post('/v1/conversation/page-settings-save', `http://127.0.0.1:${server.port}`)).status).toBe(403);
    expect((await post('/v1/conversation/page-settings-save', `http://127.0.0.1:${port}`, {})).status).toBe(404);
    // History is a page command too.
    expect((await post('/v1/conversation/page-history', `http://127.0.0.1:${port}`)).status).toBe(200);
    expect((await post('/v1/conversation/page-history', `http://127.0.0.1:${server.port}`)).status).toBe(403);
    // Restart and resume from the list header passes the page's cookie and origin checks.
    expect((await post('/v1/conversation/page-holder-restart', `http://127.0.0.1:${port}`)).status).toBe(200);
    expect((await post('/v1/conversation/page-holder-restart', `http://127.0.0.1:${server.port}`)).status).toBe(403);
    expect((await post('/v1/conversation/page-holder-restart', `http://127.0.0.1:${port}`, { Cookie: 'sb_page=forged' })).status).toBe(401);
    expect((await post('/v1/conversation/resume', `http://127.0.0.1:${server.port}`)).status).toBe(403);
    expect((await post('/v1/conversation/resume', `http://127.0.0.1:${port}`, {})).status).toBe(404);
    expect((await post('/v1/conversation/resume', `http://127.0.0.1:${port}`, { Cookie: 'sb_page=forged' })).status).toBe(401);
    for (const command of ['held-list', 'held-stop', 'held-open']) {
      const answer = await post(`/v1/conversation/${command}`, `http://127.0.0.1:${port}`);
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toEqual(command === 'held-list' ? { held: [] } : command === 'held-stop' ? { stopped: 's' } : { done: true });
      expect(posted.at(-1)).toEqual({ window: 'page-1', workItemId: 4 });
      expect((await post(`/v1/conversation/${command}`, `http://127.0.0.1:${server.port}`)).status).toBe(403);
      expect((await post(`/v1/conversation/${command}`, `http://127.0.0.1:${port}`, { Cookie: 'sb_page=forged' })).status).toBe(401);
    }
    expect(posted).toHaveLength(9);
    stream.destroy();
  });

  it('links to the hub port with a notice once a taken fixed port stays taken, and takes one that frees up in time', async () => {
    await serve();

    const holder = createServer();

    await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done));

    const port = (holder.address() as { port: number }).port;
    const listening = server.listenPage(port, 300);
    // A link asked for meanwhile waits for the answer.
    const link = send(server.port, 'POST', '/page/link', { Authorization: `Bearer ${server.token}` });

    expect(await listening).toMatch(/EADDRINUSE/);

    const body = JSON.parse((await link).body) as { url: string; notice?: string };

    expect(new URL(body.url).port).toBe(String(server.port));
    expect(body.notice).toContain(`not on port ${port}`);

    const freed = server.listenPage(port, 5_000);

    setTimeout(() => holder.close(), 300);
    expect(await freed).toBeNull();
    expect(new URL((JSON.parse((await send(server.port, 'POST', '/page/link', { Authorization: `Bearer ${server.token}` })).body) as { url: string }).url).port).toBe(String(port));
  });

  it('keeps a sign-in across a hub restart, renews its cookie as the page loads, and says when a browser is not signed in', async () => {
    const { url } = await serve();
    const exchange = await send(server.port, 'GET', `${url.pathname}${url.search}`, {});
    const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;

    expect(String(exchange.headers['set-cookie'])).toContain(`Max-Age=${PAGE_SESSION_MS / 1000}`);
    await server.close();
    await serve();

    const shown = await send(server.port, 'GET', '/page/', { Cookie: cookie });

    expect(shown.status).toBe(200);
    expect(String(shown.headers['set-cookie'])).toBe(pageCookie(cookie.slice('sb_page='.length)));

    const signedOut = await send(server.port, 'GET', '/page/', {});

    expect(signedOut.status).toBe(401);
    expect(signedOut.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(signedOut.body).toContain('not signed in to Switchboard');
    expect(signedOut.headers['set-cookie']).toBeUndefined();
    // Any signed-in request renews it, as a page left open makes no page loads; a file anyone may fetch does not.
    expect(String((await send(server.port, 'GET', '/v1/page/list', { Cookie: cookie })).headers['set-cookie'])).toBe(pageCookie(cookie.slice('sb_page='.length)));
    expect((await send(server.port, 'GET', '/page/manifest.webmanifest', { Cookie: cookie })).headers['set-cookie']).toBeUndefined();
  });

  it("answers ping with the build and whether the browser is signed in, and ticks on a page's stream in place of the heartbeat comment", async () => {
    const { url } = await serve(undefined, 20);
    const cookie = String((await send(server.port, 'GET', `${url.pathname}${url.search}`, {})).headers['set-cookie']).split(';')[0]!;
    const ping = await send(server.port, 'GET', '/page/ping', { Cookie: cookie });

    expect(JSON.parse(ping.body)).toEqual({ build: 'b7', signedIn: true });
    expect(ping.headers['cache-control']).toBe('no-store');

    // The page carries an ETag the browser asks with.
    const shown = await send(server.port, 'GET', '/page/', { Cookie: cookie });

    expect(shown.headers['etag']).toMatch(/^"[\w-]{22}"$/);
    expect((await send(server.port, 'GET', '/page/', { Cookie: cookie, 'If-None-Match': String(shown.headers['etag']) })).status).toBe(304);
    expect(JSON.parse((await send(server.port, 'GET', '/page/ping', { Cookie: 'sb_page=' + '0'.repeat(64) })).body)).toEqual({ build: 'b7', signedIn: false });

    // The page's watchdog sees a named event; a comment never reaches its script.
    const text = await new Promise<string>((done) => {
      let got = '';
      const stream = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/events?page=1', headers: { Host: `127.0.0.1:${server.port}`, Cookie: cookie } }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          got += chunk;

          if (got.includes('event: tick')) {
            stream.destroy();
            done(got);
          }
        });
      });

      stream.on('error', () => {});
      stream.end();
    });

    expect(text).toContain('event: tick\ndata: {}\n\n');
    expect(text).not.toContain(': ping');
  });

  it('ends the streams of a sign-in that a new link replaces, and only those', async () => {
    const { url } = await serve();
    const signIn = async (cookie?: string): Promise<string> => {
      const link = new URL((JSON.parse((await send(server.port, 'POST', '/page/link', { Authorization: `Bearer ${server.token}` })).body) as { url: string }).url);

      return String((await send(server.port, 'GET', `${link.pathname}${link.search}`, cookie === undefined ? {} : { Cookie: cookie })).headers['set-cookie']).split(';')[0]!;
    };
    const first = String((await send(server.port, 'GET', `${url.pathname}${url.search}`, {})).headers['set-cookie']).split(';')[0]!;
    const other = await signIn();
    const open = (cookie: string) => {
      const state = { ended: false };
      const stream = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/events?page=1', headers: { Host: `127.0.0.1:${server.port}`, Cookie: cookie } }, (response) => {
        response.resume();
        response.on('end', () => (state.ended = true));
      });

      stream.on('error', () => {});
      stream.end();
      return state;
    };
    const firstStream = open(first);
    const otherStream = open(other);

    await until(() => (server.clients() === 2 ? true : null));

    const renewed = await signIn(first);

    await until(() => (firstStream.ended ? true : null));
    expect(otherStream.ended).toBe(false);
    expect((await send(server.port, 'GET', '/v1/page/list', { Cookie: first })).status).toBe(401);
    expect((await send(server.port, 'GET', '/v1/page/list', { Cookie: renewed })).status).toBe(200);
  });

  it("serves the installed page's public files and ping without a sign-in, but the page's own files only with one", async () => {
    await serve();

    const manifest = await send(server.port, 'GET', '/page/manifest.webmanifest', {});

    expect(manifest).toMatchObject({ status: 200, body: 'manifest.webmanifest' });
    expect(manifest.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await send(server.port, 'GET', '/page/sw.js', {})).body).toBe('sw.js');
    // A public name the page lacks is not found.
    expect((await send(server.port, 'GET', '/page/icon-512.png', {})).status).toBe(404);
    expect((await send(server.port, 'GET', '/page/page.js', {})).status).toBe(401);
    expect(JSON.parse((await send(server.port, 'GET', '/page/ping', {})).body)).toEqual({ build: 'b7', signedIn: false });
    expect((await send(server.port, 'GET', '/page/ping', { Host: `evil.example:${server.port}` })).status).toBe(403);
    expect((await send(server.port, 'GET', '/page/manifest.webmanifest', { Host: `evil.example:${server.port}` })).status).toBe(403);
  });

  it('serves the page through tailscale serve to an allowed host and login over HTTPS only, redirects / to the page, and asks a device for a code', async () => {
    await serve();

    const local = await send(server.port, 'GET', '/', {});

    expect(local.status).toBe(303);
    expect(local.headers['location']).toBe('/page/');

    const ts = { Host: 'pc.tail.ts.net', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '100.64.0.2', 'X-Forwarded-Host': 'pc.tail.ts.net', 'Tailscale-User-Login': 'alex@example.com' };

    // Off until the host and login are set.
    expect((await send(server.port, 'GET', '/', ts)).status).toBe(403);
    remoteAccess = { hosts: ['pc.tail.ts.net'], logins: ['alex@example.com'] };

    const root = await send(server.port, 'GET', '/', ts);

    expect(root.status).toBe(303);
    expect(root.headers['location']).toBe('/page/');
    expect(root.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(JSON.parse((await send(server.port, 'GET', '/page/ping', ts)).body)).toEqual({ build: 'b7', signedIn: false });
    expect((await send(server.port, 'GET', '/page/manifest.webmanifest', ts)).status).toBe(200);
    expect((await send(server.port, 'GET', '/page/ping', { ...ts, 'X-Forwarded-Proto': 'http' })).status).toBe(403);
    expect((await send(server.port, 'GET', '/page/ping', { ...ts, 'Tailscale-User-Login': 'mallory@example.com' })).status).toBe(403);
    expect((await send(server.port, 'GET', '/page/ping', { ...ts, 'Tailscale-Funnel-Request': '?1' })).status).toBe(403);
    expect((await send(server.port, 'GET', '/page/ping', { ...ts, Host: `127.0.0.1:${server.port}`, 'X-Forwarded-Host': `127.0.0.1:${server.port}` })).status).toBe(403);

    const signedOut = await send(server.port, 'GET', '/page/', ts);

    expect(signedOut.status).toBe(401);
    expect(signedOut.body).toContain('<form method="get" action="/page">');
    expect(signedOut.body).not.toContain('wrong or has expired');
    expect(signedOut.headers['content-security-policy']).toBe(`default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${createHash('sha256').update(PAIR_SCRIPT).digest('base64')}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    expect(signedOut.body).toContain(`<script>${PAIR_SCRIPT}</script>`);
    expect(signedOut.body).toMatch(/<input name="code" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" inputmode="text" enterkeyhint="go" placeholder="ABCD-EFGH" aria-label="Pairing code" required>/);
    expect((await send(server.port, 'GET', '/page', ts)).status).toBe(200);

    const wrong = await send(server.port, 'GET', '/page?code=AAAA-AAAA', ts);

    expect(wrong.status).toBe(403);
    expect(wrong.body).toContain('That code is wrong or has expired.');
  });

  it('pairs a device only from this computer, by link or code once, with a Secure cookie bound to its host and login, and lists and revokes devices', async () => {
    const { url, posted } = await serve();
    const localCookie = String((await send(server.port, 'GET', `${url.pathname}${url.search}`, {})).headers['set-cookie']).split(';')[0]!;
    const stream = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/events?page=1', headers: { Host: `127.0.0.1:${server.port}`, Cookie: localCookie } }, (response) => response.resume());

    stream.on('error', () => {});
    stream.end();
    await until(() => (server.clients() === 1 ? true : null));

    const here = `http://127.0.0.1:${server.port}`;
    const post = (command: string, headers: Record<string, string>, body: Record<string, unknown> = {}) => send(server.port, 'POST', `/v1/conversation/${command}`, { 'Content-Type': 'application/json', ...headers }, { window: 'page-1', ...body });

    expect(JSON.parse((await post('page-pair', { Cookie: localCookie, Origin: here })).body)).toEqual({ error: expect.stringContaining('Pairing a device needs remote access') });
    remoteAccess = { hosts: ['pc.tail.ts.net'], logins: ['alex@example.com', 'other@example.com'] };

    const ts = { Host: 'pc.tail.ts.net', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '100.64.0.2', 'Tailscale-User-Login': 'alex@example.com', 'User-Agent': 'Mozilla/5.0 (Linux; Android 15) Chrome/141.0 Mobile Safari/537.36' };
    const pairing = JSON.parse((await post('page-pair', { Cookie: localCookie, Origin: here })).body) as { url: string; code: string; host: string };
    const link = new URL(pairing.url);

    expect(link.origin).toBe('https://pc.tail.ts.net');
    // Its token is not taken on this computer, which uses it up.
    expect((await send(server.port, 'GET', `${link.pathname}${link.search}`, {})).status).toBe(403);
    expect((await send(server.port, 'GET', `${link.pathname}${link.search}`, ts)).status).toBe(403);

    const again = new URL((JSON.parse((await post('page-pair', { Cookie: localCookie, Origin: here })).body) as { url: string }).url);
    const paired = await send(server.port, 'GET', `${again.pathname}${again.search}`, ts);
    const phone = String(paired.headers['set-cookie']).split(';')[0]!;

    expect(paired.status).toBe(303);
    expect(String(paired.headers['set-cookie'])).toMatch(/; HttpOnly; Secure; SameSite=Strict; Path=\//);
    expect((await send(server.port, 'GET', `${again.pathname}${again.search}`, ts)).status).toBe(403);

    const list = await send(server.port, 'GET', '/v1/page/list', { ...ts, Cookie: phone });

    expect(list.status).toBe(200);
    expect(String(list.headers['set-cookie'])).toContain('; Secure;');
    // The phone's cookie works only through its host and login, and this computer's only here.
    expect((await send(server.port, 'GET', '/v1/page/list', { Cookie: phone })).status).toBe(401);
    expect((await send(server.port, 'GET', '/v1/page/list', { ...ts, Cookie: phone, 'Tailscale-User-Login': 'other@example.com' })).status).toBe(401);
    expect((await send(server.port, 'GET', '/v1/page/list', { ...ts, Cookie: localCookie })).status).toBe(401);

    // The code pairs a second device once.
    const code = (JSON.parse((await post('page-pair', { Cookie: localCookie, Origin: here })).body) as { code: string }).code;
    const tablet = await send(server.port, 'GET', `/page?code=${code.toLowerCase()}`, { ...ts, 'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) Version/19.0 Safari/604.1' });

    expect(tablet.status).toBe(303);
    expect((await send(server.port, 'GET', `/page?code=${code}`, ts)).status).toBe(403);
    // A code typed on this computer is not a link.
    expect((await send(server.port, 'GET', `/page?code=${code}`, {})).status).toBe(403);

    // A paired device posts from its own origin and may not pair, list devices, drive the browser pane, open a link or a held terminal on this computer, restart the holder, use Settings or set Brief replies.
    expect((await post('page-source', { ...ts, Cookie: phone, Origin: here })).status).toBe(403);
    expect((await post('page-source', { ...ts, Cookie: phone, Origin: 'https://pc.tail.ts.net' })).status).toBe(200);
    for (const command of ['page-pair', 'page-devices', 'page-device-revoke', 'held-open', 'row-open', 'page-holder-restart', 'page-settings-read', 'page-settings-check', 'page-settings-save', 'page-voice-enroll', 'page-voice-computer', 'brief-replies']) {
      const refused = await post(command, { ...ts, Cookie: phone, Origin: 'https://pc.tail.ts.net' });

      expect(refused.status).toBe(403);
      expect(JSON.parse(refused.body)).toEqual({ error: 'Do this from the page on the computer that runs Switchboard.' });
    }

    for (const command of ['held-list', 'held-stop']) {
      expect((await post(command, { ...ts, Cookie: phone, Origin: 'https://pc.tail.ts.net' })).status).toBe(200);
    }

    // The New session form's commands learn whether they came through a remote host, whatever the page sent (PRD R122).
    for (const command of ['page-new-session', 'page-folders']) {
      posted.length = 0;
      expect((await post(command, { ...ts, Cookie: phone, Origin: 'https://pc.tail.ts.net' }, { remote: false })).status).toBe(200);
      expect((await post(command, { Cookie: localCookie, Origin: here }, { remote: true })).status).toBe(200);
      expect(posted).toEqual([{ window: 'page-1', remote: true }, { window: 'page-1', remote: false }]);
    }

    // This computer's page still opens links, restarts the holder and uses Settings.
    for (const command of ['held-open', 'row-open', 'page-holder-restart', 'page-settings-read', 'page-settings-check', 'page-settings-save', 'page-voice-enroll', 'page-voice-computer', 'brief-replies']) {
      expect((await post(command, { Cookie: localCookie, Origin: here })).status).toBe(200);
    }

    expect([...LOCAL_PAGE_COMMANDS]).toEqual(['held-open', 'page-pair', 'page-devices', 'page-device-revoke', 'page-device-voice', 'row-open', 'page-holder-restart', 'page-settings-read', 'page-settings-check', 'page-settings-save', 'page-voice-enroll', 'page-voice-computer', 'brief-replies']);

    const devices = JSON.parse((await post('page-devices', { Cookie: localCookie, Origin: here })).body) as { devices: Array<{ id: string; label: string; host: string | null; login: string | null; current: boolean }> };

    expect(devices.devices.map(({ label, host, login, current }) => ({ label, host, login, current }))).toEqual([
      { label: 'iPad · Safari', host: 'pc.tail.ts.net', login: 'alex@example.com', current: false },
      { label: 'Android · Chrome', host: 'pc.tail.ts.net', login: 'alex@example.com', current: false },
      { label: 'Unknown device · browser', host: null, login: null, current: true },
    ]);
    expect(JSON.parse((await send(server.port, 'POST', '/page/devices', { Authorization: `Bearer ${server.token}` })).body).devices).toHaveLength(3);

    // Revoking the phone ends its open page and leaves the others signed in.
    let ended = false;
    const phoneStream = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/events?page=1', headers: { ...ts, Cookie: phone } }, (response) => {
      response.resume();
      response.on('end', () => (ended = true));
    });

    phoneStream.on('error', () => {});
    phoneStream.end();
    await until(() => (server.clients() === 2 ? true : null));

    const phoneId = devices.devices[1]!.id;

    expect((await post('page-device-revoke', { Cookie: localCookie, Origin: here }, { id: 'zz' })).status).toBe(400);
    expect(JSON.parse((await post('page-device-revoke', { Cookie: localCookie, Origin: here }, { id: phoneId })).body)).toEqual({ revoked: 1 });
    await until(() => (ended ? true : null));
    expect((await send(server.port, 'GET', '/v1/page/list', { ...ts, Cookie: phone })).status).toBe(401);
    expect((await send(server.port, 'GET', '/v1/page/list', { Cookie: localCookie })).status).toBe(200);
    expect((await send(server.port, 'POST', '/page/revoke', { Authorization: `Bearer ${server.token}` }, { id: phoneId })).status).toBe(404);
    expect(JSON.parse((await send(server.port, 'POST', '/page/revoke', { Authorization: `Bearer ${server.token}` }, { id: devices.devices[0]!.id })).body)).toEqual({ revoked: 1 });
    expect(JSON.parse((await send(server.port, 'POST', '/page/pair', { Authorization: `Bearer ${server.token}` })).body)).toMatchObject({ host: 'pc.tail.ts.net', url: expect.stringMatching(/^https:\/\/pc\.tail\.ts\.net\/page\?t=[0-9a-f]{64}$/) });
    expect((await send(server.port, 'POST', '/page/pair', {})).status).toBe(401);
    stream.destroy();
  });

  it('downloads a portable app shortcut for the authenticated page origin, including a paired device', async () => {
    const { url, access } = await serve();
    const localCookie = String((await send(server.port, 'GET', `${url.pathname}${url.search}`, {})).headers['set-cookie']).split(';')[0]!;
    const path = '/page/switchboard-shortcut.zip?browser=edge&profile=Profile+1';
    const download = (headers: Record<string, string>, target = path) => new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((done, fail) => {
      const outbound = request({ host: '127.0.0.1', port: server.port, path: target, headers: { Host: `127.0.0.1:${server.port}`, ...headers } }, (response) => {
        const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      }); outbound.on('error', fail); outbound.end();
    });
    expect((await download({})).status).toBe(401);
    const local = await download({ Cookie: localCookie });
    expect(local.status).toBe(200); expect(local.headers['content-disposition']).toBe('attachment; filename="switchboard-shortcut.zip"');
    expect(local.headers['cache-control']).toBe('no-store');
    expect([...unzip(local.body).keys()]).toEqual(['Switchboard.lnk']);
    expect(unzip(local.body).get('Switchboard.lnk')!.toString('utf16le')).toContain(encodeURIComponent(url.origin));
    expect((await download({ Cookie: localCookie }, path + '&origin=https://evil.test')).status).toBe(400);
    expect((await download({ Cookie: localCookie }, '/page/switchboard-shortcut.zip?browser=cmd')).status).toBe(400);
    remoteAccess = { hosts: ['pc.tail.ts.net'], logins: ['alex@example.com'] };
    const ts = { Host: 'pc.tail.ts.net', 'X-Forwarded-Proto': 'https', 'Tailscale-User-Login': 'alex@example.com' };
    const link = new URL(access.pair('pc.tail.ts.net').url);
    const paired = String((await send(server.port, 'GET', `${link.pathname}${link.search}`, ts)).headers['set-cookie']).split(';')[0]!;
    expect((await download(ts)).status).toBe(401); expect((await download({ ...ts, Cookie: localCookie })).status).toBe(401);
    const remote = await download({ ...ts, Cookie: paired }); expect(remote.status).toBe(200);
    const remoteLink = unzip(remote.body).get('Switchboard.lnk')!;
    expect(remoteLink.toString('utf16le')).toContain('https%3A%2F%2Fpc.tail.ts.net');
    expect(remoteLink.toString('utf16le')).not.toContain('127.0.0.1');
    expect(remoteLink.includes(Buffer.from(paired.split('=')[1]!, 'utf16le'))).toBe(false);
    remoteAccess = { hosts: [], logins: [] };
    expect((await download({ ...ts, Cookie: paired })).status).toBe(403);
  });

  it("serves the browser extension's download and routes through the page's origin to a signed-in browser, taking posts only from an extension (PRD R121)", async () => {
    const { url, browserPosts, access, iframe } = await serve();
    const localCookie = String((await send(server.port, 'GET', `${url.pathname}${url.search}`, {})).headers['set-cookie']).split(';')[0]!;
    const ts = { Host: 'pc.tail.ts.net', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '100.64.0.2', 'Tailscale-User-Login': 'alex@example.com' };
    const download = async (headers: Record<string, string>) => {
      const answer = await new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
        const outbound = request({ host: '127.0.0.1', port: server.port, path: '/page/switchboard-extension.zip', headers: { Host: `127.0.0.1:${server.port}`, ...headers } }, (response) => {
          const chunks: Buffer[] = [];

          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
        });

        outbound.on('error', reject);
        outbound.end();
      });

      return answer;
    };

    // This computer's copy names no origin, and needs the sign-in.
    expect((await download({})).status).toBe(401);

    const local = await download({ Cookie: localCookie });

    expect(local.status).toBe(200);
    expect(local.headers['content-type']).toBe('application/zip');
    expect(local.headers['content-disposition']).toBe('attachment; filename="switchboard-extension.zip"');
    expect(JSON.parse(unzip(local.body).get('switchboard-extension/remote.json')!.toString('utf8'))).toEqual({ origin: null });

    // A paired device's copy names its page's origin.
    remoteAccess = { hosts: ['pc.tail.ts.net'], logins: ['alex@example.com'] };

    const link = new URL(access.pair('pc.tail.ts.net').url);
    const phone = String((await send(server.port, 'GET', `${link.pathname}${link.search}`, ts)).headers['set-cookie']).split(';')[0]!;

    iframe.enabled = true;
    expect((await send(server.port, 'GET', '/v1/browser/iframe', ts)).status).toBe(401);
    expect((await send(server.port, 'GET', '/v1/browser/iframe', { ...ts, Cookie: localCookie })).status).toBe(401);
    expect(JSON.parse((await send(server.port, 'GET', '/v1/browser/iframe', { ...ts, Cookie: phone })).body)).toEqual({ enabled: true });

    expect((await download(ts)).status).toBe(401);
    expect(JSON.parse(unzip((await download({ ...ts, Cookie: phone })).body).get('switchboard-extension/remote.json')!.toString('utf8'))).toEqual({ origin: 'https://pc.tail.ts.net' });

    // The extension's reads carry the browser's sign-in, from the device's host and login only.
    expect((await send(server.port, 'GET', '/v1/browser/cards', ts)).status).toBe(401);
    expect((await send(server.port, 'GET', '/v1/browser/cards', { Cookie: phone })).status).toBe(401);
    expect((await send(server.port, 'GET', '/v1/browser/cards', { ...ts, Cookie: phone, 'Tailscale-User-Login': 'mallory@example.com' })).status).toBe(403);
    expect(JSON.parse((await send(server.port, 'GET', '/v1/browser/cards', { ...ts, Cookie: phone })).body)).toEqual({ cards: [{ url: 'https://github.com/o/r/issues/2', playbook: 'dev:new-dev', group: 'progress', snoozed: false, workItemId: 7 }] });
    expect(JSON.parse((await send(server.port, 'GET', '/v1/browser/snoozed', { ...ts, Cookie: phone })).body)).toEqual({ urls: ['https://github.com/o/r/issues/1'] });
    expect((await send(server.port, 'GET', '/v1/browser/other', { ...ts, Cookie: phone })).status).toBe(404);

    // A post comes from an extension with JSON, never from a web page, the page's own origin included.
    const extension = { ...ts, Cookie: phone, Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'Content-Type': 'application/json' };

    expect((await send(server.port, 'POST', '/v1/browser/snooze', { ...extension, Origin: 'https://pc.tail.ts.net' }, { url: 'https://github.com/o/r/issues/2', until: null })).status).toBe(403);
    expect((await send(server.port, 'POST', '/v1/browser/snooze', { ...extension, 'Content-Type': 'text/plain' }, { url: 'https://github.com/o/r/issues/2', until: null })).status).toBe(415);
    expect((await send(server.port, 'POST', '/v1/browser/snooze', { ...extension, Cookie: localCookie }, { url: 'https://github.com/o/r/issues/2', until: null })).status).toBe(401);
    expect(browserPosts).toEqual([]);
    expect(JSON.parse((await send(server.port, 'POST', '/v1/browser/snooze', extension, { url: 'https://github.com/o/r/issues/2', until: 5 })).body)).toEqual({ done: true });
    expect((await send(server.port, 'POST', '/v1/browser/unsnooze', { ...extension, Origin: 'moz-extension://5f1e' }, { url: 'https://github.com/o/r/issues/9' })).status).toBe(404);
    expect(browserPosts).toEqual([{ snooze: 'https://github.com/o/r/issues/2', until: 5 }, { unsnooze: 'https://github.com/o/r/issues/9' }]);

    // Once remote access no longer allows the device, nothing is served to it.
    remoteAccess = { hosts: [], logins: [] };
    expect((await send(server.port, 'GET', '/v1/browser/iframe', { ...ts, Cookie: phone })).status).toBe(403);
    expect((await send(server.port, 'GET', '/v1/browser/cards', { ...ts, Cookie: phone })).status).toBe(403);
    expect((await send(server.port, 'POST', '/v1/browser/snooze', extension, { url: 'https://github.com/o/r/issues/2', until: null })).status).toBe(403);
    expect(browserPosts).toHaveLength(2);
  });

  it('ends a paired device\'s open page when remote access no longer allows its host or login, and keeps the others', async () => {
    const { url } = await serve();
    const localCookie = String((await send(server.port, 'GET', `${url.pathname}${url.search}`, {})).headers['set-cookie']).split(';')[0]!;
    const ts = { Host: 'pc.tail.ts.net', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '100.64.0.2', 'Tailscale-User-Login': 'alex@example.com' };

    remoteAccess = { hosts: ['pc.tail.ts.net'], logins: ['alex@example.com'] };

    const pairing = new URL((JSON.parse((await send(server.port, 'POST', '/page/pair', { Authorization: `Bearer ${server.token}` })).body) as { url: string }).url);
    const phone = String((await send(server.port, 'GET', `${pairing.pathname}${pairing.search}`, ts)).headers['set-cookie']).split(';')[0]!;
    const ended = { local: false, phone: false };
    const open = (name: 'local' | 'phone', headers: Record<string, string>) => {
      const stream = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/events?page=1', headers }, (response) => {
        response.resume();
        response.on('end', () => (ended[name] = true));
      });

      stream.on('error', () => {});
      stream.end();
      return stream;
    };
    const local = open('local', { Host: `127.0.0.1:${server.port}`, Cookie: localCookie });

    open('phone', { ...ts, Cookie: phone });
    await until(() => (server.clients() === 2 ? true : null));

    // A change that still allows the phone's host and login keeps it.
    remoteAccess = { hosts: ['other.tail.ts.net', 'pc.tail.ts.net'], logins: ['alex@example.com'] };
    server.remoteChanged();
    await new Promise((done) => setTimeout(done, 50));
    expect(ended).toEqual({ local: false, phone: false });

    // A command whose body was still arriving when its login was removed is refused once read.
    let answered: { status: number; body: string } | null = null;
    const slow = request({ host: '127.0.0.1', port: server.port, method: 'POST', path: '/v1/conversation/page-source', headers: { ...ts, Cookie: phone, Origin: 'https://pc.tail.ts.net', 'Content-Type': 'application/json' } }, (response) => {
      let body = '';

      response.on('data', (chunk: Buffer) => (body += chunk.toString()));
      response.on('end', () => (answered = { status: response.statusCode ?? 0, body }));
    });

    slow.on('error', () => {});
    slow.write('{"window":');
    await new Promise((done) => setTimeout(done, 50));

    remoteAccess = { hosts: ['pc.tail.ts.net'], logins: [] };
    server.remoteChanged();
    slow.end('"page-2"}');
    await until(() => answered);
    expect(answered).toEqual({ status: 403, body: JSON.stringify({ error: 'Remote access no longer allows this device.' }) });
    await until(() => (ended.phone ? true : null));
    expect(ended.local).toBe(false);
    expect((await send(server.port, 'GET', '/v1/page/list', { ...ts, Cookie: phone })).status).toBe(403);
    local.destroy();
  });

  it('revokes every sign-in only with the hub token and ends the open pages\' streams', async () => {
    const { url, closed } = await serve();
    const exchange = await send(server.port, 'GET', `${url.pathname}${url.search}`, {});
    const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
    let ended = false;
    const stream = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/events?page=1', headers: { Host: `127.0.0.1:${server.port}`, Cookie: cookie } }, (response) => {
      response.resume();
      response.on('end', () => (ended = true));
    });

    stream.on('error', () => {});
    stream.end();
    await until(() => (server.clients() === 1 ? true : null));
    expect((await send(server.port, 'POST', '/page/revoke', { Cookie: cookie })).status).toBe(401);
    expect(ended).toBe(false);

    const revoked = await send(server.port, 'POST', '/page/revoke', { Authorization: `Bearer ${server.token}` });

    expect(JSON.parse(revoked.body)).toEqual({ revoked: 1 });
    await until(() => (ended && closed.includes('page-1') ? true : null));
    expect((await send(server.port, 'GET', '/v1/page/list', { Cookie: cookie })).status).toBe(401);
  });

  it('exchanges a one-time link for an HttpOnly, SameSite=Strict cookie and serves the page only with it, under its own CSP', async () => {
    const { url } = await serve();

    expect(url.host).toBe(`127.0.0.1:${server.port}`);
    expect((await send(server.port, 'POST', '/page/link', {})).status).toBe(401);

    const exchange = await send(server.port, 'GET', `${url.pathname}${url.search}`, {});
    const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;

    expect(exchange.status).toBe(303);
    expect(exchange.headers['location']).toBe('/page/');
    expect(String(exchange.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict; Path=\//);
    expect((await send(server.port, 'GET', `${url.pathname}${url.search}`, {})).status).toBe(403);
    expect((await send(server.port, 'GET', '/page/', {})).status).toBe(401);
    expect((await send(server.port, 'GET', '/page/', { Cookie: 'sb_page=forged' })).status).toBe(401);

    const shown = await send(server.port, 'GET', '/page/', { Cookie: cookie });

    // The page names the build of the hub that served it.
    expect(shown).toMatchObject({ status: 200, body: '<html>page b7</html>' });
    expect(shown.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await send(server.port, 'GET', '/page/missing.js', { Cookie: cookie })).status).toBe(404);
    // Another name for this machine, as DNS rebinding gives, is refused even with the cookie.
    expect((await send(server.port, 'GET', '/page/', { Cookie: cookie, Host: `evil.example:${server.port}` })).status).toBe(403);
    expect(JSON.parse((await send(server.port, 'GET', '/v1/page/list', { Cookie: cookie })).body)).toEqual({ groups: [{ kind: 'item', title: 'T', conversations: [] }] });
    expect((await send(server.port, 'GET', '/v1/page/list', {})).status).toBe(401);
  });

  it("gives a page stream a page key that dies with it, and takes a page's commands only from its origin, for its key and the commands a page may send", async () => {
    const { url, posted, closed, installed } = await serve();
    const exchange = await send(server.port, 'GET', `${url.pathname}${url.search}`, {});
    const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
    const chunks: string[] = [];
    const stream = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/events?page=1', headers: { Host: `127.0.0.1:${server.port}`, Cookie: cookie } }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => chunks.push(chunk));
    });

    stream.on('error', () => {});
    stream.end();
    await until(() => (chunks.join('').includes('page-1') ? true : null));
    expect(installed).toEqual([false]);

    const origin = `http://127.0.0.1:${server.port}`;
    const post = (path: string, body: unknown, headers: Record<string, string> = { Cookie: cookie, Origin: origin }) => send(server.port, 'POST', path, { 'Content-Type': 'application/json', ...headers }, body);

    expect((await post('/v1/conversation/select', { window: 'page-1', workItemId: 4 })).status).toBe(200);
    expect(posted).toEqual([{ window: 'page-1', workItemId: 4 }]);
    expect((await post('/v1/conversation/select', { window: 'page-1', workItemId: 4 }, { Cookie: cookie, Origin: 'http://127.0.0.1:8766' })).status).toBe(403);
    expect((await post('/v1/conversation/select', { window: 'page-1', workItemId: 4 }, { Cookie: cookie })).status).toBe(403);
    expect((await post('/v1/conversation/select', { window: 'a-window-key', workItemId: 4 })).status).toBe(403);
    expect((await post('/v1/conversation/new-conversation', { window: 'page-1' })).status).toBe(404);
    expect((await post('/v1/conversation/select', { window: 'page-1', workItemId: 4 }, { Cookie: 'sb_page=forged', Origin: origin })).status).toBe(401);
    expect(posted).toHaveLength(1);

    const files = await send(server.port, 'GET', '/v1/conversation/files?window=page-1&q=a', { Cookie: cookie });

    expect(JSON.parse(files.body)).toEqual({ files: [{ path: 'a.ts', dir: false }] });
    expect((await send(server.port, 'GET', '/v1/conversation/files?window=page-2&q=a', { Cookie: cookie })).status).toBe(403);

    // The change routes: for a page key only, with the cookie, gzipped when taken, and 304 for the ETag the page holds.
    const changes = await send(server.port, 'GET', '/v1/conversation/changes?window=page-1&q=z', { Cookie: cookie });

    expect(changes.status).toBe(200);
    expect(changes.headers['etag']).toBe('"e1"');
    expect(JSON.parse(changes.body)).toEqual({ rows: 'x'.repeat(2000), q: 'z' });
    const gzipped = await send(server.port, 'GET', '/v1/conversation/changes?window=page-1', { Cookie: cookie, 'Accept-Encoding': 'gzip' });

    expect(gzipped.headers['content-encoding']).toBe('gzip');
    // The gzipped bytes have their own strong ETag, and neither validates the other.
    expect(gzipped.headers['etag']).toBe('"e1-gzip"');
    expect((await send(server.port, 'GET', '/v1/conversation/changes?window=page-1', { Cookie: cookie, 'If-None-Match': '"e1-gzip"' })).status).toBe(200);
    expect((await send(server.port, 'GET', '/v1/conversation/changes?window=page-1', { Cookie: cookie, 'Accept-Encoding': 'gzip', 'If-None-Match': '"e1"' })).status).toBe(200);
    const unchanged = await send(server.port, 'GET', '/v1/conversation/changes?window=page-1', { Cookie: cookie, 'Accept-Encoding': 'gzip', 'If-None-Match': '"e1-gzip"' });

    expect(unchanged.status).toBe(304);
    expect(unchanged.headers['vary']).toBe('Accept-Encoding');
    expect((await send(server.port, 'GET', '/v1/conversation/changes?window=page-1', { Cookie: cookie, 'If-None-Match': '"e1"' })).status).toBe(304);
    expect((await send(server.port, 'GET', '/v1/conversation/changes?window=page-2', { Cookie: cookie })).status).toBe(403);
    expect((await send(server.port, 'GET', '/v1/conversation/changes?window=page-1', {})).status).toBe(401);

    // The diff viewer's files: kept by the browser, gzipped when taken, and only with the cookie.
    const viewer = await send(server.port, 'GET', '/page/diff/b1/diff.js', { Cookie: cookie, 'Accept-Encoding': 'gzip' });

    expect(viewer.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(viewer.headers['content-encoding']).toBe('gzip');
    expect((await send(server.port, 'GET', '/page/diff/b1/diff.js', { Cookie: cookie })).body).toBe('plain');
    expect((await send(server.port, 'GET', '/page/diff/b1/diff.js', {})).status).toBe(401);

    stream.destroy();
    await until(() => (closed.includes('page-1') ? true : null));
  });

  it('takes a file the composer attaches only with the cookie, from its own origin, for a page key, with or without its length and at most 10 MB', async () => {
    const { url, uploaded, uploadLogs, open } = await serve();
    const exchange = await send(server.port, 'GET', `${url.pathname}${url.search}`, {});
    const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
    const origin = `http://127.0.0.1:${server.port}`;
    const path = '/v1/conversation/upload?window=page-1&scopeGen=3&name=notes%20one.txt';
    const bytes = Buffer.from('hello');

    expect(open()).toBe('page-1');

    const taken = await sendBytes(server.port, path, { Cookie: cookie, Origin: origin, 'Content-Type': 'text/plain' }, bytes);

    expect(taken.status).toBe(200);
    expect(JSON.parse(taken.body)).toEqual({ path: 'C:\\Temp\\a.txt', image: false });
    expect(uploaded).toEqual([{ key: 'page-1', scopeGen: 3, name: 'notes one.txt', bytes: 'hello' }]);

    expect((await sendBytes(server.port, path, { Origin: origin }, bytes)).status).toBe(401);
    expect((await sendBytes(server.port, path, { Cookie: 'sb_page=forged', Origin: origin }, bytes)).status).toBe(401);
    expect((await sendBytes(server.port, path, { Cookie: cookie }, bytes)).status).toBe(403);
    expect((await sendBytes(server.port, path, { Cookie: cookie, Origin: 'http://127.0.0.1:8766' }, bytes)).status).toBe(403);
    expect((await sendBytes(server.port, path, { Cookie: cookie, Origin: `http://evil.example:${server.port}`, Host: `evil.example:${server.port}` }, bytes)).status).toBe(403);
    expect((await sendBytes(server.port, path.replace('page-1', 'page-2'), { Cookie: cookie, Origin: origin }, bytes)).status).toBe(403);
    const chunked = await sendBytes(server.port, path, { Cookie: cookie, Origin: origin }, bytes, null);

    expect(chunked.status).toBe(200);
    expect(JSON.parse(chunked.body)).toEqual({ path: 'C:\\Temp\\a.txt', image: false });
    expect((await sendBytes(server.port, `${path}&retry=1`, { Cookie: cookie, Origin: origin }, bytes)).status).toBe(200);

    const large = await sendBytes(server.port, path, { Cookie: cookie, Origin: origin }, Buffer.alloc(0), 10 * 1024 * 1024 + 1);

    expect(large.status).toBe(413);
    expect(JSON.parse(large.body)).toEqual({ error: 'notes one.txt is larger than 10 MB.' });
    const largeChunked = await sendBytes(server.port, path, { Cookie: cookie, Origin: origin }, Buffer.alloc(10 * 1024 * 1024 + 1), null);

    expect(largeChunked.status).toBe(413);
    expect(JSON.parse(largeChunked.body)).toEqual({ error: 'notes one.txt is larger than 10 MB.' });
    expect(uploadLogs).toContain('web upload: 200, local, declared none, transfer chunked, received 5');
    expect(uploadLogs).toContain('web upload: 200, local, retry, declared 5, transfer none, received 5');
    expect(uploadLogs).toContain('web upload: 413, local, declared none, transfer chunked, received >10 MB');
    expect(uploadLogs.filter((line) => line === 'web upload: 401, local, declared 5, transfer none, received 0')).toHaveLength(2);
    expect(uploadLogs.filter((line) => line === 'web upload: 403, unknown, declared 5, transfer none, received 0')).toHaveLength(1);
    expect(uploadLogs.join('\n')).not.toContain('notes one.txt');
    expect(uploadLogs.join('\n')).not.toContain(cookie);
    // A window's GET, or the hub token, reaches no upload: the route is the page's alone.
    expect((await send(server.port, 'GET', path, { Cookie: cookie })).status).toBe(401);
    expect((await sendBytes(server.port, path, { Authorization: `Bearer ${server.token}` }, bytes)).status).toBe(404);
    expect(uploaded).toEqual(Array(3).fill({ key: 'page-1', scopeGen: 3, name: 'notes one.txt', bytes: 'hello' }));
  });

  it("serves a page's artifact by the page key alone, only from where its page signed in, sandboxed with no network, and nothing outside its folder", async () => {
    const { url } = await serve();
    const cookie = String((await send(server.port, 'GET', `${url.pathname}${url.search}`, {})).headers['set-cookie']).split(';')[0]!;
    // Through a remote host the page key of this computer's page is not found, and a key never opened by a page stream is none.
    const ts = { Host: 'pc.tail.ts.net', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '100.64.0.2', 'Tailscale-User-Login': 'alex@example.com' };
    const stream = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/events?page=1', headers: { Host: `127.0.0.1:${server.port}`, Cookie: cookie } }, (response) => response.resume());

    stream.on('error', () => {});
    stream.end();
    await until(() => (server.clients() === 1 ? true : null));
    remoteAccess = { hosts: ['pc.tail.ts.net'], logins: ['alex@example.com'] };
    expect((await send(server.port, 'GET', '/v1/conversation/artifact/page-1/chat/page.html', ts)).status).toBe(404);

    const served = await send(server.port, 'GET', '/v1/conversation/artifact/page-1/chat/page.html', {});

    expect(served.status).toBe(200);
    expect(served.body).toBe('<script>1</script>');
    expect(served.headers['content-security-policy']).toMatch(/^sandbox allow-scripts; default-src 'none'/);
    expect(served.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(served.headers['content-security-policy']).not.toContain('connect-src');
    expect(served.headers['referrer-policy']).toBe('no-referrer');
    expect((await send(server.port, 'GET', '/v1/conversation/artifact/page-2/chat/page.html', {})).status).toBe(404);
    expect((await send(server.port, 'GET', '/v1/conversation/artifact/page-1/..%2F..%2Fw1%2Fchat%2Fpage.html', {})).status).toBe(404);
    // An external artifact is read from the handle it came with, no further than its checked size.
    expect(await send(server.port, 'GET', '/v1/conversation/artifact/page-1/%401/report.md', {})).toMatchObject({ status: 200, body: '# Report' });
    expect(await send(server.port, 'GET', '/v1/conversation/artifact/page-1/%401/empty.md', {})).toMatchObject({ status: 200, body: '' });
    stream.destroy();
    await until(() => (server.clients() === 0 ? true : null));
    expect((await send(server.port, 'GET', '/v1/conversation/artifact/page-1/chat/page.html', {})).status).toBe(404);
  });

  it("serves a local file a link names to the page of its own page key, with the cookie, nothing outside its folders, and a paired device only files", async () => {
    const { url } = await serve();
    const cookie = String((await send(server.port, 'GET', `${url.pathname}${url.search}`, {})).headers['set-cookie']).split(';')[0]!;
    const folder = join(dir, 'w1');

    writeFileSync(join(folder, 'notes.md'), '# Notes');
    writeFileSync(join(folder, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(folder, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    writeFileSync(join(dir, 'secret.txt'), 'secret');

    const stream = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/events?page=1', headers: { Host: `127.0.0.1:${server.port}`, Cookie: cookie } }, (response) => response.resume());

    stream.on('error', () => {});
    stream.end();
    await until(() => (server.clients() === 1 ? true : null));

    const get = (path: string, headers: Record<string, string> = { Cookie: cookie }) => send(server.port, 'GET', path, headers);
    const shown = await get('/v1/conversation/local-file?window=page-1&path=notes.md');

    expect(shown.status).toBe(200);
    expect(JSON.parse((await get('/v1/conversation/local-file?window=page-1&path=.')).body)).toMatchObject({ kind: 'dir' });
    expect(JSON.parse(shown.body)).toMatchObject({ kind: 'markdown', name: 'notes.md', contents: '# Notes' });
    expect(shown.headers['cache-control']).toBe('no-cache');

    // An open file tab reads again with the ETag it holds: an unchanged file answers 304, a changed one its new view and ETag.
    const etag = String(shown.headers['etag']);

    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await get('/v1/conversation/local-file?window=page-1&path=notes.md', { Cookie: cookie, 'If-None-Match': etag })).status).toBe(304);
    writeFileSync(join(folder, 'notes.md'), '# Notes, revised');
    const revised = await get('/v1/conversation/local-file?window=page-1&path=notes.md', { Cookie: cookie, 'If-None-Match': etag });

    expect(revised.status).toBe(200);
    expect(JSON.parse(revised.body)).toMatchObject({ contents: '# Notes, revised' });
    expect(revised.headers['etag']).not.toBe(etag);
    writeFileSync(join(folder, 'notes.md'), '# Notes');

    const picture = await get('/v1/conversation/local-file-raw?window=page-1&path=shot.png');

    expect(picture.status).toBe(200);
    expect(picture.headers['content-type']).toBe('image/png');
    expect(picture.headers['x-content-type-options']).toBe('nosniff');
    expect(picture.headers['content-security-policy']).toBeUndefined();
    // An SVG's scripts run with an opaque origin and no network, as an artifact's do, should it be opened on its own.
    expect((await get('/v1/conversation/local-file-raw?window=page-1&path=logo.svg')).headers['content-security-policy']).toMatch(/^sandbox allow-scripts; default-src 'none'/);
    // Text goes only as the page's own view of it, never as a document of this origin.
    expect((await get('/v1/conversation/local-file-raw?window=page-1&path=notes.md')).status).toBe(404);
    expect((await get(`/v1/conversation/local-file?window=page-1&path=${encodeURIComponent('../secret.txt')}`)).status).toBe(404);
    expect((await get(`/v1/conversation/local-file?window=page-1&path=${encodeURIComponent(join(dir, 'secret.txt'))}`)).status).toBe(404);
    expect((await get(`/v1/conversation/local-file-raw?window=page-1&path=${encodeURIComponent('../secret.txt')}`)).status).toBe(404);
    // Without the cookie, or for a key no stream of this sign-in holds, nothing.
    expect((await get('/v1/conversation/local-file?window=page-1&path=notes.md', {})).status).toBe(401);
    expect((await get('/v1/conversation/local-file?window=page-2&path=notes.md')).status).toBe(403);

    // Another browser's sign-in on this computer cannot read through this page's key.
    const second = new URL((JSON.parse((await send(server.port, 'POST', '/page/link', { Authorization: `Bearer ${server.token}` })).body) as { url: string }).url);
    const other = String((await send(server.port, 'GET', `${second.pathname}${second.search}`, {})).headers['set-cookie']).split(';')[0]!;

    expect(other).toMatch(/^sb_page=/);
    expect((await get('/v1/conversation/local-file?window=page-1&path=notes.md', { Cookie: other })).status).toBe(403);

    // A paired device reads files in the session's working folder through its own page key only, never a folder or a file outside it
    // (architecture.md § Remote access).
    const ts = { Host: 'pc.tail.ts.net', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '100.64.0.2', 'Tailscale-User-Login': 'alex@example.com' };

    remoteAccess = { hosts: ['pc.tail.ts.net'], logins: ['alex@example.com'] };

    const pairing = new URL((JSON.parse((await send(server.port, 'POST', '/page/pair', { Authorization: `Bearer ${server.token}` })).body) as { url: string }).url);
    const phone = String((await send(server.port, 'GET', `${pairing.pathname}${pairing.search}`, ts)).headers['set-cookie']).split(';')[0]!;
    const asPhone = { ...ts, Cookie: phone };

    expect((await get('/v1/conversation/local-file?window=page-1&path=notes.md', asPhone)).status).toBe(403);

    const phoneStream = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/events?page=1', headers: asPhone }, (response) => response.resume());

    phoneStream.on('error', () => {});
    phoneStream.end();
    await until(() => (server.clients() === 2 ? true : null));

    const onPhone = await get('/v1/conversation/local-file?window=page-2&path=notes.md', asPhone);

    expect(onPhone.status).toBe(200);
    expect(JSON.parse(onPhone.body)).toMatchObject({ kind: 'markdown', contents: '# Notes' });

    const phonePicture = await get('/v1/conversation/local-file-raw?window=page-2&path=shot.png', asPhone);

    expect(phonePicture.status).toBe(200);
    expect(phonePicture.headers['content-type']).toBe('image/png');

    for (const target of ['.', '../secret.txt', join(dir, 'secret.txt')]) {
      const refused = await get(`/v1/conversation/local-file?window=page-2&path=${encodeURIComponent(target)}`, asPhone);

      expect(refused.status).toBe(404);
      expect(JSON.parse(refused.body)).toEqual({ error: LOCAL_FILES_PAIRED_ONLY });
    }

    // This computer's page cannot read through the phone's key, nor the phone through this computer's.
    expect((await get('/v1/conversation/local-file?window=page-2&path=notes.md')).status).toBe(403);
    expect((await get('/v1/conversation/local-file-raw?window=page-1&path=shot.png', asPhone)).status).toBe(403);
    phoneStream.destroy();
    stream.destroy();
    await until(() => (server.clients() === 0 ? true : null));
    expect((await get('/v1/conversation/local-file?window=page-1&path=notes.md')).status).toBe(403);
  });

  it("streams a page's console only with its cookie, for its page key and shown session, and takes its keys only from the page's origin", async () => {
    const { url, posted, consoles, open } = await serve();
    const exchange = await send(server.port, 'GET', `${url.pathname}${url.search}`, {});
    const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;

    expect(open()).toBe('page-1');
    expect((await send(server.port, 'GET', '/v1/conversation/console?window=page-1&sessionId=s1', {})).status).toBe(401);
    expect((await send(server.port, 'GET', '/v1/conversation/console?window=page-1&sessionId=s1', { Cookie: cookie, Host: `evil.example:${server.port}` })).status).toBe(403);

    const refused = await send(server.port, 'GET', '/v1/conversation/console?window=page-1&sessionId=other', { Cookie: cookie });

    expect(refused.headers['content-type']).toBe('text/event-stream');
    expect(refused.body).toBe('event: unavailable\ndata: {"reason":"This page now shows another work item or session, so that was not done. Check what it shows and try again."}\n\n');

    const chunks: string[] = [];
    const stream = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/console?window=page-1&sessionId=s1', headers: { Host: `127.0.0.1:${server.port}`, Cookie: cookie } }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => chunks.push(chunk));
    });

    stream.on('error', () => {});
    stream.end();
    await until(() => (chunks.join('').includes('hello') ? true : null));
    expect(chunks.join('')).toBe('event: size\ndata: {"cols":80,"rows":24}\n\nevent: data\ndata: {"data":"hello\\r\\n"}\n\n');
    stream.destroy();
    await until(() => (consoles.includes('closed page-1') ? true : null));

    const origin = `http://127.0.0.1:${server.port}`;
    const keys = { window: 'page-1', scopeGen: 1, opId: 'o1', sessionId: 's1', launch: 'L', data: 'x' };
    const post = (body: unknown, headers: Record<string, string>) => send(server.port, 'POST', '/v1/conversation/console-input', { 'Content-Type': 'application/json', ...headers }, body);

    expect((await post(keys, { Cookie: cookie })).status).toBe(403);
    expect((await post(keys, { Cookie: cookie, Origin: 'http://localhost:1' })).status).toBe(403);
    expect((await post({ ...keys, window: 'a-window-key' }, { Cookie: cookie, Origin: origin })).status).toBe(403);
    expect((await post(keys, { Cookie: cookie, Origin: origin })).status).toBe(200);
    expect(posted).toEqual([keys]);
  });
});
