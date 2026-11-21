import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listenHub } from '../src/server.js';
import type { HubServer, PageRoutes } from '../src/server.js';
import { createHash } from 'node:crypto';
import { Store } from '@switchboard/core';
import { artifactFile, cookieValue, dockRowOf, findFiles, knownFolder, pageHeader, loopbackHost, PageAccess, pageCookie, PUBLIC_PAGE_FILES, PAGE_LINK_MS, PAGE_SESSION_MS, PAGE_SESSIONS_KEPT, pageActionEvent, pageActions, pageCommandOf, pageGroups, pageList, pageOpens, pasteText, rowOpenUrl, tabUrl } from '../src/page.js';
import { dockView } from '../src/dock.js';
import type { DockView } from '../src/dock.js';
import { pageAsset } from '../src/pageAssets.js';
import { item, NOW, session, snapshot } from './views.js';
import { until } from './helpers.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-page-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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

    expect(store.pageSession(hash)).toEqual({ createdAt: 1_000, usedAt: 1_000 });
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
});

describe('pageList', () => {
  const WINDOWS = 'C:/sb/windows';

  it("lists the dock's groups in the dock's order with its titles and rows, work items only, hosted conversations where the dock puts them", () => {
    const own = item(1, { ticket: { ...item(1).ticket, title: 'Fix the badge' }, sessions: [session({ id: 's1', workItemId: 1, cwd: 'D:/w1' })] });
    const byFolder = item(4, { ticket: { ...item(4).ticket, title: 'Folder chat', hostWindow: 'D:/git/support' } });
    const byWindow = item(5, { ticket: { ...item(5).ticket, title: 'Aside', hostWindow: 'C:/sb/windows/x.code-workspace' } });
    const view = snapshot([own, byFolder, byWindow]);
    const dock = dockView(view, NOW, WINDOWS);
    const list = pageList(dock, view);
    const ownRow = dock.groups.flatMap((group) => group.rows).find((row) => row.key === 'item:1')!;

    expect(list.map((group) => [group.key, group.title, group.glyph])).toEqual(dock.groups.map((group) => [group.key, group.title, group.glyph]));
    expect(list.flatMap((group) => group.rows).find((row) => row.workItemId === 1)).toEqual({ workItemId: 1, title: 'Fix the badge', priority: ownRow.priority, time: ownRow.time, ticket: ownRow.ticket, sourceKind: ownRow.sourceKind, url: ownRow.url, playbook: ownRow.playbook, links: [], returned: ownRow.returned, comment: ownRow.comment, mark: ownRow.mark, details: ownRow.details, stripe: ownRow.stripe, dim: ownRow.dim, host: null, actions: pageActions(ownRow), main: null, pastes: [], opens: pageOpens(ownRow), search: ownRow.search });
    expect(pageOpens(ownRow).map((one) => one.label)).toEqual(['Open in VS Code']);
    // Each row in the dock's group, in the dock's order, a hosted conversation with its host's name.
    expect(list.map((group) => group.rows.map((row) => row.workItemId))).toEqual(dock.groups.map((group) => group.rows.map((row) => Number(row.key.slice('item:'.length)))));
    expect(list.flatMap((group) => group.rows).filter((row) => row.host !== null).map((row) => [row.workItemId, row.host]).sort()).toEqual([[4, 'support'], [5, 'x']]);
    expect(list.some((group) => (group.key as string) === 'conversations')).toBe(false);
  });

  it('leaves out pool tickets and rows of work items the snapshot lacks, and keeps a done hosted conversation in Done', () => {
    const doneHosted = item(6, { status: 'done', ticket: { ...item(6).ticket, title: 'Old chat', hostWindow: 'D:/git/support' } });
    const row = (key: string) => ({ key, title: key, ticket: 'gh 1', sourceKind: 'github', playbook: 'dev', links: [], details: [], mark: null, stripe: null, dim: false, controls: [], main: null, pastes: [] }) as unknown as DockView['groups'][number]['rows'][number];
    const dock = { groups: [{ key: 'unstarted', title: 'Unstarted', glyph: 'u', empty: 'Nothing waits to be started.', rows: [row('ticket:9'), row('item:77')] }, { key: 'done', title: 'Done', glyph: 'd', empty: null, rows: [row('item:6')] }] } as Pick<DockView, 'groups'>;
    const list = pageList(dock, snapshot([doneHosted]));

    expect(list).toEqual([
      { key: 'unstarted', title: 'Unstarted', glyph: 'u', empty: 'Nothing waits to be started.', rows: [] },
      { key: 'done', title: 'Done', glyph: 'd', empty: null, rows: [expect.objectContaining({ workItemId: 6, host: 'support' })] },
    ]);
  });
});

describe('pageHeader', () => {
  it("offers the dock's sources and schedules, and as folders the repo roots, then each folder that hosts a conversation, once", () => {
    const byFolder = item(4, { ticket: { ...item(4).ticket, hostWindow: 'D:/git/support' } });
    const again = item(5, { ticket: { ...item(5).ticket, hostWindow: 'd:/git/Support' } });
    const byWindow = item(6, { ticket: { ...item(6).ticket, hostWindow: 'C:/sb/windows/x.code-workspace' } });
    const root = item(7, { ticket: { ...item(7).ticket, hostWindow: 'D:/w1' } });
    const sources = [{ kind: 'github', enabled: true, title: 'gh: polled', sources: [{ name: 'gh', enabled: true }] }];
    const header = pageHeader({ sources, repoRoots: ['D:/w1'], schedules: [{ name: 'nightly', playbook: 'dev:sweep' }] }, snapshot([byFolder, again, byWindow, root]));

    expect(header).toEqual({ sources, repoRoots: ['D:/w1'], folders: ['D:/w1', 'D:/git/support'], schedules: [{ name: 'nightly', playbook: 'dev:sweep' }] });
    expect(knownFolder(header.folders, 'd:/git/support')).toBe('D:/git/support');
    expect(knownFolder(header.folders, 'D:/git')).toBeNull();
  });
});

describe('pageList rows', () => {
  it("carries the dock row's three lines as the dock built them, without a pull request's status", () => {
    const dockRow = {
      key: 'item:3', title: 'Fix it', priority: 'Priority: P1', time: { text: '2h', title: 'In queue since 11:40' }, ticket: 'gh 3', sourceKind: 'github', url: 'https://github.com/o/r/issues/3', playbook: 'dev:build',
      links: [{ label: 'PR #9', url: 'https://github.com/o/r/pull/9', kind: 'pr', badge: '9', glyph: '\u{ea64}', mentioned: false, pr: { state: 'open' } }],
      returned: 2, comment: { glyph: 'c', title: 'Nov 20\nWaits on Sam' }, mark: { kind: 'limited', glyph: 'w', title: 'Rate limited' },
      details: [{ text: 'Rate limited · resumes 1:20 PM', title: 'Resets at 1:20 PM', tone: 'warning' }, { text: 'Post the reply', title: null, tone: null }],
      stripe: null, dim: false, controls: [], main: null, pastes: [], search: 'Fix it · gh 3 · PR #9 · dev:build',
    } as unknown as DockView['groups'][number]['rows'][number];
    const dock = { groups: [{ key: 'progress', title: 'In progress', glyph: 'p', empty: null, rows: [dockRow] }] } as Pick<DockView, 'groups'>;
    const [shown] = pageList(dock, snapshot([item(3)]))[0]!.rows;

    expect(shown).toMatchObject({ priority: 'Priority: P1', time: { text: '2h', title: 'In queue since 11:40' }, url: 'https://github.com/o/r/issues/3', returned: 2, comment: { glyph: 'c', title: 'Nov 20\nWaits on Sam' }, mark: { kind: 'limited', glyph: 'w', title: 'Rate limited' }, details: dockRow.details });
    expect(shown!.links).toEqual([{ label: 'PR #9', url: 'https://github.com/o/r/pull/9', kind: 'pr', badge: '9', glyph: '\u{ea64}', mentioned: false }]);
    // The list's search matches what the dock's search box matches.
    expect(shown!.search).toBe('Fix it · gh 3 · PR #9 · dev:build');
  });
});

describe('pageActions', () => {
  const WINDOWS = 'C:/sb/windows';
  const rowOf = (one: ReturnType<typeof item>) => dockRowOf(dockView(snapshot([one]), NOW, WINDOWS), one.id)!;

  it("offers the dock's Start, Approve, Retry, state controls and Delete in its menu order, its main control, and asks before Stop and Delete", () => {
    const unstarted = rowOf(item(1, { status: 'unstarted' }));

    expect(pageActions(unstarted).map((one) => one.label)).toEqual(['Start', 'Start with guidance…', 'Mark done', 'Snooze…', 'Add comment…', 'Delete']);
    expect(pageActions(unstarted).find((one) => one.action === 'delete')?.confirm).toEqual(unstarted.controls.find((one) => one.label === 'Delete')!.confirm);
    expect(pageActions(unstarted).map((one) => one.group)).toEqual(['main', 'work', 'state', 'state', 'notes', 'asking']);
    expect(pageActions(rowOf(item(2, { status: 'awaiting-approval' })))[0]).toEqual({ label: 'Approve', action: 'approve', icon: 'check', group: 'main', confirm: null, input: null });
    expect(pageActions(rowOf(item(3, { status: 'failed' }))).map((one) => one.action)).toContain('retry');

    const running = rowOf(item(4, { status: 'running', sessions: [session({ id: 's4', workItemId: 4, codeMode: true, state: 'running' })] }));
    const stop = pageActions(running).find((one) => one.action === 'stop');

    expect(stop?.confirm).toMatchObject({ action: 'Stop', question: `Stop ${running.ticket}?` });
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
    // The order group comes after the state controls and before Delete, as in the dock's menu.
    expect(pageActions(middle).map((one) => one.group).filter((group, index, all) => all.indexOf(group) === index)).toEqual(['main', 'work', 'state', 'notes', 'order', 'asking'].filter((group) => pageActions(middle).some((one) => one.group === group)));
    expect(pageActionEvent(middle, 'Move down', { until: null, comment: null })).toEqual({ event: { type: 'move', workItemId: ids[1], after: ids[2] } });
    expect(pageActionEvent(middle, 'Move to top', { until: null, comment: null })).toEqual({ event: { type: 'move', workItemId: ids[1], after: null } });
  });

  it("asks for the dock's input text, sets it and a changed choice as the hub's own fields, and refuses a blank text or a choice not offered", () => {
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

  it("offers Open in VS Code for a row with a window, then the dock's Open changes and Open report, never History or Open in terminal", () => {
    const worktree = { id: 1, ticketId: 1, path: 'D:/git/wt/101', branch: '101', linkedBy: 'report' as const };
    const review = rowOf(item(1, { status: 'awaiting-approval', worktree, approvalReport: 'D:/git/wt/101/report.md' }));

    expect(pageOpens(review)).toEqual([{ label: 'Open in VS Code', icon: 'vscode' }, { label: 'Open changes', icon: 'diff-multiple' }, { label: 'Open report', icon: 'symbol-file' }]);
    expect(review.commands.map((one) => one.label)).toContain('History');
    expect(pageCommandOf(review, 'Open changes')).toEqual({ destination: review.window!.file, command: review.commands.find((one) => one.label === 'Open changes')!.command });
    expect(pageCommandOf(review, 'Open report')).toEqual({ destination: review.window!.file, command: { type: 'openUrl', url: 'D:/git/wt/101/report.md' } });
    expect(pageCommandOf(review, 'Open in VS Code')).toEqual({ destination: review.window!.file, command: null });
    expect(pageCommandOf(review, 'History')).toEqual({ refused: 'The work item no longer offers this.' });
    expect(pageCommandOf(review, 'Open in terminal')).toEqual({ refused: 'The work item no longer offers this.' });

    // A row with no window opens nothing in VS Code.
    const windowless = { window: null, commands: review.commands };

    expect(pageOpens(windowless)).toEqual([]);
    expect(pageCommandOf(windowless, 'Open changes')).toEqual({ refused: 'The work item no longer offers this.' });
    // A folder-hosted conversation opens its folder.
    expect(pageCommandOf({ window: { name: 'f', title: 't', folders: ['D:/w'], file: null, hosted: true, folder: 'D:/w' }, commands: [] }, 'Open in VS Code')).toEqual({ destination: 'D:/w', command: null });
  });

  it("opens only the row's own http or https ticket URL or link, marked as the dock marks it", () => {
    const row = { url: 'https://github.com/o/r/issues/1', links: [{ url: 'https://example.test/a?b=1#top' }, { url: 'javascript:alert(1)' }, { url: 'file:///C:/x' }] };

    expect(rowOpenUrl(row, 'https://github.com/o/r/issues/1')).toBe('https://github.com/o/r/issues/1#switchboard-tab');
    expect(rowOpenUrl(row, 'https://example.test/a?b=1#top')).toBe('https://example.test/a?b=1&switchboard-tab=1#top');
    // A link the row holds but that is not http or https, or a URL the row does not hold, never opens.
    expect(rowOpenUrl(row, 'javascript:alert(1)')).toBeNull();
    expect(rowOpenUrl(row, 'file:///C:/x')).toBeNull();
    expect(rowOpenUrl(row, 'https://evil.test/')).toBeNull();
    expect(rowOpenUrl({ url: '', links: [] }, '')).toBeNull();
    // The parser's form goes out, so a space or quote cannot split the browser's argument.
    expect(tabUrl('https://example.test/a b"c')).toBe('https://example.test/a%20b%22c#switchboard-tab');
    expect(tabUrl('https://example.test/?q=1#x')).toBe('https://example.test/?q=1&switchboard-tab=1#x');
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
    writeFileSync(join(dir, 'outside', 'secret.md'), 'secret');
    symlinkSync(join(dir, 'outside'), join(folder, 'chat', 'link'), 'junction');

    expect(artifactFile(folder, 'chat/page.html')).toMatchObject({ mime: 'text/html; charset=utf-8', sandboxed: true });
    expect(artifactFile(folder, 'chat/page/pic.svg')).toMatchObject({ mime: 'image/svg+xml', sandboxed: true });
    expect(artifactFile(folder, 'chat/notes.md')).toMatchObject({ sandboxed: false });
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
    // Every file served without a sign-in is one of the page's own.
    expect([...PUBLIC_PAGE_FILES].filter((name) => pageAsset(name, dir) === null)).toEqual([]);
    expect(pageAsset('mermaid.min.js', dir)).toBeNull();
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'mermaid.min.js'), 'mermaid');
    expect(String(pageAsset('mermaid.min.js', dir)?.body)).toBe('mermaid');
    expect(pageAsset('toString', dir)).toBeNull();
    expect(pageAsset('../hub.json', dir)).toBeNull();
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

  async function serve() {
    const posted: unknown[] = [];
    const uploaded: unknown[] = [];
    const closed: string[] = [];
    const consoles: string[] = [];
    const pages = new Set<string>();
    let keys = 0;
    const folder = join(dir, 'w1');

    mkdirSync(join(folder, 'chat'), { recursive: true });
    writeFileSync(join(folder, 'chat', 'page.html'), '<script>1</script>');

    const page: PageRoutes = {
      access: new PageAccess(store),
      asset: (name) => (name === 'index.html' ? { mime: 'text/html; charset=utf-8', body: '<html>page {{build}}</html>' } : ['manifest.webmanifest', 'sw.js', 'page.js'].includes(name) ? { mime: 'text/plain', body: name } : null),
      opened: () => {
        const key = `page-${++keys}`;

        pages.add(key);
        return key;
      },
      isPage: (key) => pages.has(key),
      list: () => [{ kind: 'item', title: 'T', conversations: [] }],
      files: async (key) => (key === 'page-1' ? [{ path: 'a.ts', dir: false }] : null),
      artifact: (key, name) => (key === 'page-1' ? artifactFile(folder, name) : null),
      upload: (key, scopeGen, name, bytes) => {
        uploaded.push({ key, scopeGen, name, bytes: Buffer.from(bytes).toString('utf8') });
        return { status: 200, body: { path: 'C:\\Temp\\a.txt', image: false } };
      },
      console: (key, sessionId, write) => {
        if (key !== 'page-1' || sessionId !== 's1') {
          return { status: 403, error: 'Not in this window.' };
        }

        write('size', { cols: 80, rows: 24 });
        write('data', { data: 'hello\r\n' });
        return { close: () => consoles.push(`closed ${key}`) };
      },
    };

    server = await listenHub({
      identity: { hub: 'switchboard', protocol: 1, version: '0', pid: 1 },
      onShutdown: () => {},
      page,
      build: 'b7',
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
      },
    });

    const link = await send(server.port, 'POST', '/page/link', { Authorization: `Bearer ${server.token}` });
    const url = new URL(JSON.parse(link.body).url as string);

    return { posted, uploaded, closed, consoles, url, folder, open: () => page.opened() };
  }

  it("serves the page on its fixed port, which the link names, by that port's Host only, and nothing but the page there", async () => {
    const { posted } = await serve();

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
    const stream = request({ host: '127.0.0.1', port, path: '/v1/conversation/events?page=1', headers: { Host: `127.0.0.1:${port}`, Cookie: cookie } }, (response) => response.resume());

    stream.on('error', () => {});
    stream.end();
    await until(() => (server.clients() === 1 ? true : null));

    const post = (path: string, origin: string, headers: Record<string, string> = { Cookie: cookie }) => send(port, 'POST', path, { 'Content-Type': 'application/json', Origin: origin, ...headers }, { window: 'page-1', workItemId: 4 });

    expect((await post('/v1/conversation/resume', `http://127.0.0.1:${port}`)).status).toBe(200);
    expect((await post('/v1/conversation/row-action', `http://127.0.0.1:${port}`)).status).toBe(200);
    // The list header's commands are page commands too, under the same cookie and origin checks.
    expect((await post('/v1/conversation/page-source', `http://127.0.0.1:${port}`)).status).toBe(200);
    expect((await post('/v1/conversation/page-source', `http://127.0.0.1:${server.port}`)).status).toBe(403);
    expect((await post('/v1/conversation/page-source', `http://127.0.0.1:${port}`, {})).status).toBe(404);
    expect((await post('/v1/conversation/resume', `http://127.0.0.1:${server.port}`)).status).toBe(403);
    expect((await post('/v1/conversation/resume', `http://127.0.0.1:${port}`, {})).status).toBe(404);
    expect((await post('/v1/conversation/resume', `http://127.0.0.1:${port}`, { Cookie: 'sb_page=forged' })).status).toBe(401);
    expect(posted).toHaveLength(3);
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
    expect((await send(server.port, 'GET', '/page/offline.js', {})).status).toBe(404);
    expect((await send(server.port, 'GET', '/page/page.js', {})).status).toBe(401);
    expect(JSON.parse((await send(server.port, 'GET', '/page/ping', {})).body)).toEqual({ build: 'b7' });
    expect((await send(server.port, 'GET', '/page/ping', { Host: `evil.example:${server.port}` })).status).toBe(403);
    expect((await send(server.port, 'GET', '/page/manifest.webmanifest', { Host: `evil.example:${server.port}` })).status).toBe(403);
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
    const { url, posted, closed } = await serve();
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

    stream.destroy();
    await until(() => (closed.includes('page-1') ? true : null));
  });

  it('takes a file the composer attaches only with the cookie, from its own origin, for a page key, with its length and at most 10 MB', async () => {
    const { url, uploaded, open } = await serve();
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
    expect((await sendBytes(server.port, path, { Cookie: cookie, Origin: origin }, bytes, null)).status).toBe(411);

    const large = await sendBytes(server.port, path, { Cookie: cookie, Origin: origin }, Buffer.alloc(0), 10 * 1024 * 1024 + 1);

    expect(large.status).toBe(413);
    expect(JSON.parse(large.body)).toEqual({ error: 'notes one.txt is larger than 10 MB.' });
    // A window's GET, or the hub token, reaches no upload: the route is the page's alone.
    expect((await send(server.port, 'GET', path, { Cookie: cookie })).status).toBe(401);
    expect((await sendBytes(server.port, path, { Authorization: `Bearer ${server.token}` }, bytes)).status).toBe(404);
    expect(uploaded).toHaveLength(1);
  });

  it("serves a page's artifact by the page key alone, sandboxed with no network, and nothing outside its folder", async () => {
    const { open } = await serve();

    expect(open()).toBe('page-1');

    const served = await send(server.port, 'GET', '/v1/conversation/artifact/page-1/chat/page.html', {});

    expect(served.status).toBe(200);
    expect(served.body).toBe('<script>1</script>');
    expect(served.headers['content-security-policy']).toMatch(/^sandbox allow-scripts; default-src 'none'/);
    expect(served.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(served.headers['content-security-policy']).not.toContain('connect-src');
    expect(served.headers['referrer-policy']).toBe('no-referrer');
    expect((await send(server.port, 'GET', '/v1/conversation/artifact/page-2/chat/page.html', {})).status).toBe(404);
    expect((await send(server.port, 'GET', '/v1/conversation/artifact/page-1/..%2F..%2Fw1%2Fchat%2Fpage.html', {})).status).toBe(404);
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
    expect(refused.body).toBe('event: unavailable\ndata: {"reason":"Not in this window."}\n\n');

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
