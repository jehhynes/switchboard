import type { Snapshot, WorkItemView } from '@switchboard/hub';
import { describe, expect, it, vi } from 'vitest';
import type { DockRow } from '@switchboard/hub';
import { mainTerminal, paneModel, windowRows } from '../src/paneModel.js';
import type { PaneItem } from '../src/paneModel.js';

/** A pane item's fields the pane draws beside its links and actions. */
const EXTRA: Omit<PaneItem, 'key' | 'links' | 'report' | 'main'> = { sourceKind: 'github', playbook: 'dev:develop', mark: null, stripe: null, progress: [], status: null, alerts: [] };
import { SIZE_MS, startPane } from '../src/webview/paneMain.js';
import { clickMessage, renderPane } from '../src/webview/paneRender.js';

const NOW = Date.UTC(2026, 9, 9, 12);
const WINDOWS = 'C:\\Users\\me\\.switchboard\\windows';
const WORKTREE = 'D:/git/widgets/.worktrees/107-fix';
const FILE = `${WINDOWS}\\gh-107-58c609.code-workspace`;
const ISSUE = 'https://github.com/o/r/issues/107';
const PR = 'https://github.com/o/r/pull/19002';
const COMMENT = `${ISSUE}#issuecomment-5`;
const REVIEW = `${PR}#discussion_r9`;
const REPORT = 'D:/drafts/reply.md';

function item(patch: Partial<WorkItemView> = {}): WorkItemView {
  return {
    id: 7,
    ticketId: 7,
    playbook: 'dev:develop',
    status: 'running',
    stage: null,
    stageAt: null,
    taskPrompt: null,
    guidance: null,
    reportedPrompt: null,
    warning: null,
    error: null,
    unassignedAt: null,
    queuedAt: null,
    approvalPrompt: null,
    approvalSummary: null,
    approvalReport: null,
    approvalHeld: false,
    createdAt: NOW,
    statusAt: NOW,
    runStartedAt: NOW,
    readyAt: patch.status === 'awaiting-approval' || patch.status === 'finished' ? NOW : null,
    orderAt: null,
    scopeAt: null,
    doneAt: null,
    doneReason: null,
    parentId: null,
    pastes: [],
    comments: [],
    parent: null,
    moved: false,
    approvalSends: false,
    reopenable: false,
    playbookChoices: [],
    waits: [],
    ticket: { id: 7, source: 'github', sourceKey: '107', ref: '#107', repo: '', sourceId: null, title: 'Issue 7', url: ISSUE, assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: NOW, repoRoot: '', adhocKey: null, blockers: [] },
    triage: null,
    focus: ISSUE,
    sessions: [],
    worktree: { id: 1, ticketId: 7, path: WORKTREE, branch: '107-fix', linkedBy: 'report' },
    links: [],
    returned: 0,
    unread: 0,
    ...patch,
  };
}

const pr = { links: [{ id: 1, ticketId: 7, label: 'PR', target: PR, reportedAt: NOW, mentioned: false }] };
const report = { status: 'awaiting-approval' as const, approvalReport: REPORT };

function snapshot(items: WorkItemView[]): Snapshot {
  return {
    workItems: items,
    pool: [],
    playbooks: [],
    repoRoots: [],
    schedules: [],
    sources: ['github'],
    sourceStates: [{ name: 'github', kind: 'github', enabled: true }],
    namespaces: { github: 'dev' },
    configDir: 'C:\\Users\\me\\.switchboard',
    openVSCode: 'always',
    openTerminal: 'vscode',
    errors: { settings: null, playbooks: [], hooks: null, sources: {} },
  };
}

const approval = { ...report, approvalPrompt: '/send-reply', approvalSummary: 'send the reply' };

describe('paneModel (PRD R92)', () => {
  it('shows an approval in this window as its pills, its report and Approve', () => {
    const model = paneModel(snapshot([item({ ...approval, ...pr })]), FILE, WINDOWS, NOW);

    expect(model.items).toHaveLength(1);
    expect(model.items[0]!.links.map(({ text, url, kind, mentioned }) => ({ text, url, kind, mentioned }))).toEqual([
      { text: 'gh 107', url: ISSUE, kind: 'ticket', mentioned: false },
      { text: '19002', url: PR, kind: 'pr', mentioned: false },
    ]);
    expect(model.items[0]!.links[0]!.title).toBe('Issue 7');
    expect(model.items[0]!.report).toBe(REPORT);
    expect(model.items[0]!.main).toMatchObject({ label: 'Approve', title: 'Approve: runs /send-reply' });
    expect(model.items[0]!.main!.glyph).not.toBeNull();
  });

  it('gives a running work item no report and no main control', () => {
    const model = paneModel(snapshot([item()]), FILE, WINDOWS, NOW);

    expect(model.items[0]!.report).toBeNull();
    expect(model.items[0]!.main).toBeNull();
  });

  it('leaves out the report of a work item that no longer awaits approval', () => {
    expect(paneModel(snapshot([item({ approvalReport: REPORT, status: 'running' })]), FILE, WINDOWS, NOW).items[0]!.report).toBeNull();
  });

  it('marks a link named in the ticket and says so in its tooltip', () => {
    const mentioned = { links: [{ id: 2, ticketId: 7, label: 'gh 55', target: 'https://github.com/o/r/issues/55', reportedAt: NOW, mentioned: true }] };
    const link = paneModel(snapshot([item(mentioned)]), FILE, WINDOWS, NOW).items[0]!.links[1]!;

    expect(link.mentioned).toBe(true);
    expect(link.title).toMatch(/named in the ticket$/);
  });

  it('leaves out a work item of another window', () => {
    const other = item({ id: 8, worktree: { id: 2, ticketId: 7, path: 'D:/git/widgets/.worktrees/other', branch: 'other', linkedBy: 'report' } });

    expect(paneModel(snapshot([other]), FILE, WINDOWS, NOW).items).toEqual([]);
  });

  it('leaves out a done work item of the window while the window has another work item', () => {
    const done = item({ id: 6, status: 'done', doneAt: NOW - 1000, doneReason: 'session', ...pr });
    const merge = item({ id: 7, playbook: 'dev:merge', status: 'blocked', ...pr });
    const model = paneModel(snapshot([done, merge]), FILE, WINDOWS, NOW);

    expect(model.items.map((shown) => shown.key)).toEqual(['item:7']);
  });

  it('shows a done work item when it is the window only work item', () => {
    const done = item({ status: 'done', doneAt: NOW - 1000, doneReason: 'session', ...pr });

    expect(paneModel(snapshot([done]), FILE, WINDOWS, NOW).items.map((shown) => shown.links.map((link) => link.text))).toEqual([['gh 107', '19002']]);
  });

  it('matches the window file whatever its case and slashes', () => {
    expect(paneModel(snapshot([item()]), FILE.replaceAll('\\', '/').toUpperCase(), WINDOWS, NOW).items).toHaveLength(1);
  });

  it('shows no work item and nothing global, such as what needs the operator elsewhere, in a window that is not an item window', () => {
    expect(paneModel({ ...snapshot([]), needsCount: 3 }, null, WINDOWS, NOW)).toEqual({ items: [], voice: null });
    expect(paneModel(snapshot([item({ ...approval })]), null, WINDOWS, NOW)).toEqual({ items: [], voice: null });
  });

  it('shows nothing before the first snapshot but this window\'s voice', () => {
    expect(paneModel(null, FILE, WINDOWS, NOW)).toEqual({ items: [], voice: null });
    expect(paneModel(null, FILE, WINDOWS, NOW, { status: null, voice: { enabled: true, here: false, mic: 'off', speaking: null, speakReplies: true, error: null, recognizer: null } }).voice).toEqual({ icon: 'circle-slash', text: 'Voice not here', tooltip: 'Voice is not in this window. Click to talk here.', talkHere: true });
  });

  it("shows each work item's source, playbook and mark, its stage, the window's latest status, its alerts and its pull request's review and checks", () => {
    const failed = item({ status: 'failed', error: 'Setup ended without a worktree.', stage: 'Writing the fix', stageAt: NOW - 60_000, ...pr });
    const statuses = { [PR]: { state: 'open' as const, review: 'changes-requested' as const, checks: 'failing' as const } };
    const model = paneModel({ ...snapshot([failed]), pullRequests: statuses }, FILE, WINDOWS, NOW, { status: { workItemId: 7, line: 'Fixed the badge; tests run' }, voice: null });
    const shown = model.items[0]!;

    expect(shown).toMatchObject({ sourceKind: 'github', playbook: expect.stringContaining('develop'), stripe: 'error', status: 'Fixed the badge; tests run' });
    expect(shown.mark?.title).toBeTruthy();
    expect(shown.alerts.map((alert) => alert.text)).toEqual(['Setup ended without a worktree.']);
    expect(shown.links[1]).toMatchObject({ kind: 'pr', pr: statuses[PR], title: 'PR #19002 · Open · Changes requested · Checks failing' });
    // A rate-limit wait, which the dock draws untoned, is an alert here, with its reset time.
    const limited = { ...failed, status: 'blocked' as const, error: null, sessions: [{ id: 's7', workItemId: 7, kind: 'task' as const, provider: 'claude' as const, nativeSessionId: 'n7', shortId: 'ab12', cwd: WORKTREE, state: 'ended' as const, stateAt: NOW, stateDetail: null, outcome: 'failed' as const, outcomeDetail: null, startedAt: NOW, endedAt: NOW, released: false, releasing: false, question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null, rateLimit: { kind: 'usage', message: null, resetsAt: NOW + 3_600_000, cli: false, attempts: 0, nextAt: NOW + 3_600_000 } }] };
    const row = windowRows(snapshot([limited as never]), FILE, WINDOWS, NOW)[0]!;
    const limitDetail = row.details.find((detail) => detail.text.startsWith('Rate limited'));

    expect(limitDetail?.tone).toBeNull();
    expect(paneModel(snapshot([limited as never]), FILE, WINDOWS, NOW).items[0]!.alerts.map((one) => one.text)).toContain(limitDetail!.text);
    expect(paneModel(snapshot([limited as never]), FILE, WINDOWS, NOW).items[0]!.progress.map((one) => one.text)).not.toContain(limitDetail!.text);

    // Another work item's status is not this one's.
    expect(paneModel(snapshot([failed]), FILE, WINDOWS, NOW, { status: { workItemId: 9, line: 'Other' }, voice: null }).items[0]!.status).toBeNull();
  });

  it('shows the key of a ticket with no page without a link', () => {
    const adhoc = item({ ticket: { ...item().ticket, url: '' } });

    expect(paneModel(snapshot([adhoc]), FILE, WINDOWS, NOW).items[0]!.links[0]!.url).toBeNull();
  });
});

describe('mainTerminal (PRD R28, R92)', () => {
  const waiting = { id: 's7', workItemId: 7, kind: 'task' as const, provider: 'claude' as const, nativeSessionId: 'native-7', shortId: 'ab12', cwd: WORKTREE, state: 'waiting' as const, stateAt: NOW, stateDetail: 'permission-prompt', outcome: null, outcomeDetail: null, startedAt: NOW, endedAt: null, released: false, releasing: false, question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null };
  const row = (openTerminal: Snapshot['openTerminal']): DockRow => windowRows({ ...snapshot([item({ sessions: [waiting] })]), openTerminal }, FILE, WINDOWS, NOW)[0]!;
  const attach = { type: 'terminal', provider: 'claude', sessionId: 'native-7', cwd: WORKTREE, shortId: 'ab12', active: false };

  it("takes the row's window command for a permission prompt in VS Code's terminal", () => {
    expect(row('vscode').main).toBe('Open in terminal');
    expect(mainTerminal(row('vscode'))).toMatchObject(attach);
  });

  it("builds the same command from the row's terminal when the dock would open the terminal app", () => {
    expect(row('app').commands.some((command) => command.command['type'] === 'terminal')).toBe(false);
    expect(mainTerminal(row('app'))).toMatchObject(attach);
  });

  it('attaches to a Code Mode session waiting on a question by its Switchboard session ID, where a background session opens in Claude (PRD R95)', () => {
    const question = { ...waiting, stateDetail: 'Which branch?' };
    const held = { ...question, codeMode: true };
    const rowOf = (session: typeof waiting, openTerminal: Snapshot['openTerminal']): DockRow => windowRows({ ...snapshot([item({ sessions: [session] })]), openTerminal }, FILE, WINDOWS, NOW)[0]!;
    const expected = { type: 'terminal', provider: 'claude', sessionId: 's7', cwd: WORKTREE, name: 'gh 107', shortId: null, active: false, codeMode: true };

    expect(rowOf(question, 'vscode').main).toBe('Open in Claude');
    expect(mainTerminal(rowOf(question, 'vscode'))).toBeNull();
    expect(paneModel(snapshot([item({ sessions: [held] })]), FILE, WINDOWS, NOW).items[0]!.main).toMatchObject({ label: 'Open in terminal', title: 'Open in terminal: attaches to the Code Mode session' });
    expect(mainTerminal(rowOf(held, 'vscode'))).toMatchObject({ ...expected, shortId: 'ab12' });
    expect(mainTerminal(rowOf(held, 'app'))).toEqual(expected);
  });

  it('gives no command for another main control, or a row with no terminal', () => {
    expect(mainTerminal(windowRows(snapshot([item(approval)]), FILE, WINDOWS, NOW)[0]!)).toBeNull();
    expect(mainTerminal({ ...row('app'), terminal: null })).toBeNull();
  });
});

describe('renderPane (PRD R92)', () => {
  const root = () => {
    const div = document.createElement('div');

    document.body.replaceChildren(div);
    return div;
  };

  it('says the window has no work item, with no count of other work, and draws the voice with Talk here while it is elsewhere', () => {
    const div = root();

    div.innerHTML = renderPane({ items: [], voice: null });
    expect(div.querySelector('.idle span')!.textContent).toBe('No work item in this window. Open one from the dock to see it here.');
    expect(div.querySelector('button')).toBeNull();
    div.innerHTML = renderPane({ items: [], voice: { icon: 'circle-slash', text: 'Voice not here', tooltip: 'Voice is not in this window.', talkHere: true } });
    expect(div.querySelector('.voice-text')!.textContent).toBe('Voice not here');
    expect(clickMessage(div.querySelector('.voice button'))).toEqual({ type: 'talk-here' });
    div.innerHTML = renderPane({ items: [], voice: { icon: 'mic-filled', text: 'Listening', tooltip: '', talkHere: false } });
    expect(div.querySelector('.voice button')).toBeNull();
  });

  it("draws the ticket pill in its source's colour, the pull request's review and checks, the stage, status and alerts", () => {
    const div = root();
    const statuses = { [PR]: { state: 'open' as const, review: 'approved' as const, checks: 'running' as const } };

    div.innerHTML = renderPane(paneModel({ ...snapshot([item({ status: 'failed', error: 'Usage limit; resets at 3:00 PM.', ...pr })]), pullRequests: statuses }, FILE, WINDOWS, NOW, { status: { workItemId: 7, line: 'Done & tested' }, voice: null }));
    expect(div.querySelector('.pill.ticket')!.classList.contains('source-github')).toBe(true);
    expect(div.querySelector('.pill.pr .pr-review.approved')).not.toBeNull();
    expect(div.querySelector('.pill.pr .pr-checks.running')).not.toBeNull();
    expect(div.querySelector('.pill.pr')!.getAttribute('title')).toBe('PR #19002 · Open · Approved · Checks running');
    expect(div.querySelector('.status span:last-child')!.textContent).toBe('Done & tested');
    expect(div.querySelector('.alert span:last-child')!.textContent).toBe('Usage limit; resets at 3:00 PM.');
    expect(div.querySelector('.item')!.classList.contains('stripe-error')).toBe(true);
  });

  it('draws the pills, Report and the main control, each with its click', () => {
    const div = root();

    div.innerHTML = renderPane(paneModel(snapshot([item({ ...approval, ...pr })]), FILE, WINDOWS, NOW));

    const buttons = [...div.querySelectorAll('button')];

    expect(buttons.map((button) => button.textContent?.replace(/[\u{e000}-\u{f8ff}]/gu, ''))).toEqual(['gh 107', '19002', 'Report', 'Approve']);
    expect(buttons.map((button) => clickMessage(button))).toEqual([
      { type: 'open', target: ISSUE },
      { type: 'open', target: PR },
      { type: 'open', target: REPORT },
      { type: 'main', key: expect.any(String) },
    ]);
    expect(buttons[1]!.classList.contains('pr')).toBe(true);
    expect(buttons[3]!.title).toBe('Approve: runs /send-reply');
  });

  it('draws only the pills of a work item with nothing to act on', () => {
    const div = root();

    div.innerHTML = renderPane(paneModel(snapshot([item()]), FILE, WINDOWS, NOW));

    expect(div.querySelector('.actions')).toBeNull();
    expect(div.querySelectorAll('button')).toHaveLength(1);
  });

  it('draws a pill with no link as text that sends nothing', () => {
    const div = root();

    div.innerHTML = renderPane({ items: [{ key: 'k', ...EXTRA, links: [{ text: 'adhoc 3', glyph: null, url: null, kind: 'ticket', mentioned: false, title: 'Fix', pr: null }], report: null, main: null }], voice: null });

    expect(div.querySelector('button')).toBeNull();
    expect(div.querySelector('span.pill')!.textContent).toBe('adhoc 3');
  });

  it('escapes markup in texts and URLs', () => {
    const div = root();

    div.innerHTML = renderPane({ items: [{ key: 'k"<', ...EXTRA, links: [{ text: '<b>x</b>', glyph: null, url: 'https://e/?a="1"', kind: 'url', mentioned: true, title: 't', pr: null }], report: null, main: null }], voice: null });

    expect(div.querySelector('b')).toBeNull();
    expect(div.querySelector('button')!.textContent).toBe('<b>x</b>');
    expect(clickMessage(div.querySelector('button'))).toEqual({ type: 'open', target: 'https://e/?a="1"' });
    expect(div.querySelector('button')!.classList.contains('mentioned')).toBe(true);
  });

  it('sends nothing for a click outside a button or on an unmarked one', () => {
    const div = root();

    div.innerHTML = '<p>text</p><button>plain</button>';

    expect(clickMessage(div.querySelector('p'))).toBeNull();
    expect(clickMessage(div.querySelector('button'))).toBeNull();
    expect(clickMessage(null)).toBeNull();
  });
});

describe('startPane (PRD R92)', () => {
  it('posts ready, renders each model and posts each click', () => {
    const div = document.createElement('div');
    const postMessage = vi.fn();

    document.body.replaceChildren(div);
    startPane(div, { postMessage });

    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'model', model: { items: [], voice: { icon: 'circle-slash', text: 'Voice not here', tooltip: '', talkHere: true } } } }));
    expect(div.textContent).toContain('No work item in this window. Open one from the dock to see it here.');

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'other' } }));
    expect(div.textContent).toContain('No work item in this window. Open one from the dock to see it here.');

    div.querySelector('button')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'talk-here' });

    postMessage.mockClear();
    div.querySelector('span')!.click();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('redraws in place, so a focused button keeps its focus when a model adds a work item before it', () => {
    const div = document.createElement('div');
    const block = (key: string, label: string) => ({ key, ...EXTRA, links: [{ text: key, glyph: null, url: null, kind: 'ticket' as const, mentioned: false, title: key, pr: null }], report: null, main: { label, glyph: null, title: label } });
    const show = (items: ReturnType<typeof block>[]) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'model', model: { items, voice: null } } }));

    document.body.replaceChildren(div);
    startPane(div, { postMessage: vi.fn() });
    show([block('item:7', 'Approve')]);

    const button = div.querySelector<HTMLButtonElement>('[data-main="item:7"]')!;

    button.focus();
    show([block('item:8', 'Start'), block('item:7', 'Retry')]);

    expect(div.querySelector('[data-main="item:7"]')).toBe(button);
    expect(button.textContent).toBe('Retry');
    expect(document.activeElement).toBe(button);
    expect([...div.querySelectorAll('[data-main]')].map((main) => main.textContent)).toEqual(['Start', 'Retry']);
  });

  it('keys link pills by their target, so two pills with the same text keep their own buttons', () => {
    const div = document.createElement('div');
    const link = (url: string) => ({ text: '42', glyph: null, url, kind: 'pr' as const, mentioned: false, title: url, pr: null });
    const show = () => window.dispatchEvent(new MessageEvent('message', { data: { type: 'model', model: { items: [{ key: 'item:7', ...EXTRA, links: [link('https://github.com/a/r/pull/42'), link('https://github.com/b/r/pull/42')], report: null, main: null }], voice: null } } }));

    document.body.replaceChildren(div);
    startPane(div, { postMessage: vi.fn() });
    show();

    const second = div.querySelectorAll<HTMLButtonElement>('[data-open]')[1]!;

    second.focus();
    show();

    expect(div.querySelectorAll('[data-open]')[1]).toBe(second);
    expect(document.activeElement).toBe(second);
  });

  it('keeps the focused main control on its own button when a Report button appears before it', () => {
    const div = document.createElement('div');
    const model = (report: string | null) => ({ items: [{ key: 'item:7', ...EXTRA, links: [], report, main: { label: 'Approve', glyph: null, title: 'Approve' } }], voice: null });
    const show = (report: string | null) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'model', model: model(report) } }));

    document.body.replaceChildren(div);
    startPane(div, { postMessage: vi.fn() });
    show(null);

    const main = div.querySelector<HTMLButtonElement>('[data-main]')!;

    main.focus();
    show(REPORT);

    expect(div.querySelector('[data-main]')).toBe(main);
    expect(document.activeElement).toBe(main);
    expect(div.querySelector('[data-open]')!.textContent).toBe('Report');
  });

  it("posts its width and the window's every quarter second and when it resizes (PRD R91)", () => {
    const observed: (() => void)[] = [];
    const postMessage = vi.fn();

    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observed.push(callback); } observe() {} });

    try {
      startPane(document.createElement('div'), { postMessage });
      postMessage.mockClear();
      vi.advanceTimersByTime(SIZE_MS);
      expect(postMessage).toHaveBeenCalledWith({ type: 'size', inner: window.innerWidth, outer: window.outerWidth, dpr: window.devicePixelRatio });

      postMessage.mockClear();
      observed[0]!();
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage.mock.calls[0]![0]).toMatchObject({ type: 'size' });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
