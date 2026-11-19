import type { Snapshot, WorkItemView } from '@switchboard/hub';
import { describe, expect, it, vi } from 'vitest';
import type { DockRow } from '@switchboard/hub';
import { mainTerminal, paneModel, windowRows } from '../src/paneModel.js';
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

  it("shows the hub's count of what needs the operator in a window that is not an item window, which names no work item", () => {
    expect(paneModel({ ...snapshot([]), needsCount: 3 }, null, WINDOWS, NOW)).toEqual({ items: [], needs: 3 });
    expect(paneModel(snapshot([item({ ...approval })]), null, WINDOWS, NOW)).toEqual({ items: [], needs: 0 });
  });

  it('shows nothing before the first snapshot', () => {
    expect(paneModel(null, FILE, WINDOWS, NOW)).toEqual({ items: [], needs: 0 });
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

  it('says what needs the operator, with Show the Dock, when the window has no work items', () => {
    const div = root();

    for (const [needs, text] of [[0, 'Nothing needs you'], [1, '1 needs you'], [3, '3 need you']] as const) {
      div.innerHTML = renderPane({ items: [], needs });
      expect(div.querySelector('.idle span')!.textContent).toBe(text);
      expect(clickMessage(div.querySelector('button'))).toEqual({ type: 'dock' });
    }
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

    div.innerHTML = renderPane({ items: [{ key: 'k', links: [{ text: 'adhoc 3', glyph: null, url: null, kind: 'ticket', mentioned: false, title: 'Fix' }], report: null, main: null }], needs: 0 });

    expect(div.querySelector('button')).toBeNull();
    expect(div.querySelector('span.pill')!.textContent).toBe('adhoc 3');
  });

  it('escapes markup in texts and URLs', () => {
    const div = root();

    div.innerHTML = renderPane({ items: [{ key: 'k"<', links: [{ text: '<b>x</b>', glyph: null, url: 'https://e/?a="1"', kind: 'url', mentioned: true, title: 't' }], report: null, main: null }], needs: 0 });

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

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'model', model: { items: [], needs: 2 } } }));
    expect(div.textContent).toContain('2 need you');

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'other' } }));
    expect(div.textContent).toContain('2 need you');

    div.querySelector('button')!.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'dock' });

    postMessage.mockClear();
    div.querySelector('span')!.click();
    expect(postMessage).not.toHaveBeenCalled();
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
