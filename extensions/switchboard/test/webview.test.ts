import type { Snapshot, WorkItemView } from '@switchboard/hub';
import { beforeEach, describe, expect, it } from 'vitest';
import { startPanel } from '../src/webview/main.js';
import { age, CAPS, clip, clockOf, controlsOf, editorAction, groupOf, linkKind, mainControl, markOf, queueTime, rankOf, openAction, renderPanel, unstartedOrder } from '../src/webview/render.js';
import type { PanelUi } from '../src/webview/render.js';

const NOW = Date.UTC(2026, 9, 3, 12);

type Session = WorkItemView['sessions'][number];

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 's1',
    workItemId: 1,
    kind: 'task',
    provider: 'claude',
    nativeSessionId: 'aaaa1111-native',
    shortId: 'aaaa1111',
    cwd: 'D:/git/widgets',
    state: 'running',
    stateAt: NOW,
    stateDetail: null,
    outcome: null,
    outcomeDetail: null,
    startedAt: NOW - 5 * 60_000,
    endedAt: null,
    released: false,
    reports: ['stage', 'done', 'link'],
    ...patch,
  };
}

function item(id: number, patch: Partial<WorkItemView> = {}): WorkItemView {
  return {
    id,
    ticketId: id,
    playbook: 'dev:develop',
    status: 'running',
    stage: null,
    stageAt: null,
    taskPrompt: null,
    warning: null,
    error: null,
    failedStep: null,
    unassignedAt: null,
    queuedAt: null,
    needsPick: false,
    approvalPrompt: null,
    approvalSummary: null,
    approvalReport: null,
    createdAt: NOW,
    statusAt: NOW,
    runStartedAt: NOW,
    scopeAt: null,
    doneAt: null,
    doneReason: null,
    ticket: { id, source: 'github', sourceKey: String(100 + id), ref: `#${100 + id}`, sourceId: null, title: `Issue <${id}>`, url: `https://github.com/o/r/issues/${100 + id}`, assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: NOW, repoRoot: '' },
    triage: null,
    sessions: [],
    worktree: null,
    links: [],
    returned: 0,
    ...patch,
  };
}

function snapshot(items: WorkItemView[], patch: Partial<Snapshot> = {}): Snapshot {
  return {
    workItems: items,
    pool: [],
    playbooks: [
      { name: 'dev:develop', description: 'Build it' },
      { name: 'support:defect', description: 'Research a defect' },
    ],
    repoRoots: ['D:/git/widgets', 'D:/git/support'],
    sources: ['github'],
    sourceStates: [{ name: 'github', enabled: true }],
    namespaces: { github: 'dev', zoho: 'support', adhoc: '' },
    home: 'C:\\Users\\me\\.switchboard',
    errors: { settings: null, playbooks: [], hooks: null, sources: {} },
    ...patch,
  };
}

const labels = (entry: WorkItemView) => controlsOf(entry).map((control) => control.label);

describe('groupOf', () => {
  it('puts done first, then unstarted and triaging work, then work that needs the operator, then the rest', () => {
    expect(groupOf(item(1, { status: 'done', sessions: [session({ state: 'waiting' })] }))).toBe('done');
    expect(['unstarted', 'triaging'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['unstarted', 'unstarted']);
    expect(['awaiting-approval', 'blocked', 'failed'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['needs', 'needs', 'needs']);
    expect(groupOf(item(1, { sessions: [session({ state: 'waiting' })] }))).toBe('needs');
    expect(['queued', 'setup', 'running'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['working', 'working', 'working']);
  });
});

describe('controlsOf', () => {
  it('shows only the controls that apply, with no session controls and no Change playbook', () => {
    expect(labels(item(1, { status: 'unstarted' }))).toEqual(['Start', 'Triage again', 'Mark done', 'Snooze']);
    expect(labels(item(1, { status: 'awaiting-approval' }))).toEqual(['Approve', 'Triage again', 'Mark done', 'Snooze']);
    expect(labels(item(1, { sessions: [session()] }))).toEqual(['Stop', 'Mark done', 'Snooze']);
    expect(labels(item(1, { sessions: [session({ state: 'starting', shortId: null })] }))).toEqual(['Mark done', 'Snooze']);
    expect(labels(item(1, { status: 'blocked', sessions: [session({ state: 'ended' })] }))).toEqual(['Retry', 'Triage again', 'Mark done', 'Snooze']);
    expect(labels(item(1, { status: 'triaging' }))).toEqual(['Mark done', 'Snooze']);
    expect(labels(item(1, { status: 'done', sessions: [session({ state: 'ended' })] }))).toEqual([]);
    expect(labels(item(1, { status: 'failed', ticket: { ...item(1).ticket, source: 'adhoc' } }))).toEqual(['Retry', 'Mark done', 'Snooze']);
    expect(labels(item(1, { status: 'blocked', sessions: [session({ released: true })] }))).toEqual(['Retry', 'Mark done', 'Snooze']);
    expect(controlsOf(item(7, { sessions: [session()] }))[0]?.message).toEqual({ type: 'action', action: { type: 'stop', workItemId: 7 } });
  });
});

describe('openAction', () => {
  const worktree = { id: 1, ticketId: 7, path: 'D:/git/widgets-wt/107-fix', branch: '107-fix', linkedBy: 'report' as const };
  const action = (sessions: ReturnType<typeof session>[], patch: Partial<WorkItemView> = {}) => openAction(item(7, { sessions, ...patch }));

  it('attaches to a background session, resumes any other latest session in a terminal, then opens the worktree, then the ticket', () => {
    expect(action([session()], { worktree })).toEqual({ type: 'attach', shortId: 'aaaa1111', name: 'github 107' });
    expect(action([session({ state: 'idle', released: true })], { worktree })).toEqual({ type: 'resume', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', name: 'github 107', active: true });
    expect(action([session({ state: 'ended' })], { worktree })).toEqual({ type: 'resume', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', name: 'github 107', active: false });
    expect(action([], { worktree })).toEqual({ type: 'openFolder', path: 'D:/git/widgets-wt/107-fix' });
    expect(action([session({ state: 'starting', shortId: null, nativeSessionId: null })], { worktree })).toEqual({ type: 'openFolder', path: 'D:/git/widgets-wt/107-fix' });
    expect(action([])).toEqual({ type: 'openUrl', url: 'https://github.com/o/r/issues/107' });
    expect(action([], { ticket: { ...item(7).ticket, source: 'adhoc', url: '' } })).toBeNull();
    expect(action([session({ state: 'starting', shortId: null, nativeSessionId: null })])).toBeNull();
  });

  it('opens the session in VS Code on Ctrl+click, or the worktree while the session runs in its background process', () => {
    expect(editorAction(item(7, { sessions: [session({ state: 'ended' })], worktree }))).toEqual({ type: 'open', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets' });
    expect(editorAction(item(7, { sessions: [session({ state: 'waiting', released: true })] }))).toEqual({ type: 'open', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets' });
    expect(editorAction(item(7, { sessions: [session()], worktree }))).toEqual({ type: 'openFolder', path: 'D:/git/widgets-wt/107-fix' });
    expect(editorAction(item(7, { sessions: [session()] }))).toBeNull();
    expect(editorAction(item(7))).toBeNull();
  });
});


const ui = (patch: Partial<PanelUi> = {}): PanelUi => ({ groups: new Map(), selected: null, ...patch });

const render = (data: Snapshot, patch: Partial<PanelUi> = {}) => {
  const root = document.createElement('div');
  root.innerHTML = renderPanel(data, NOW, ui(patch));
  return root;
};

const titles = (scope: Element, selector: string) => [...scope.querySelectorAll(selector)].map((element) => element.getAttribute('title'));
/** The commands a row's right-click menu shows, by key, with the hub action each passes. */
const rowMenu = (row: Element) => {
  const context = JSON.parse(row.getAttribute('data-vscode-context')!) as Record<string, unknown> & { actions: Record<string, unknown> };
  const shown = Object.keys(context).filter((key) => key.startsWith('switchboard.row.') && context[key] === true).map((key) => key.slice('switchboard.row.'.length));

  return { section: context['webviewSection'], defaults: context['preventDefaultContextMenuItems'], shown, actions: context.actions };
};
const headings = (scope: Element) => [...scope.querySelectorAll('details.group > summary')].map((summary) => `${summary.querySelector('h3')!.textContent} ${summary.querySelector('.count')!.textContent}`);
/** A control's name: the tooltip of an icon button, or the text of a labelled one. */
const controlLabels = (scope: Element, selector: string) => [...scope.querySelectorAll(selector)].map((element) => element.getAttribute('title') ?? element.textContent);
const controlNamed = (scope: Element, label: string) => [...scope.querySelectorAll<HTMLButtonElement>('button.control')].find((button) => (button.getAttribute('title') ?? button.textContent) === label)!;

type Triage = NonNullable<WorkItemView['triage']>;

const triage = (patch: Partial<Triage> = {}): Triage => ({
  id: 1,
  ticketId: 1,
  workItemId: 1,
  context: 'Issue text',
  playbook: 'dev:develop',
  summary: 'A summary.',
  immediacy: null,
  severity: null,
  model: null,
  startedAt: NOW,
  endedAt: NOW,
  error: null,
  ...patch,
});

describe('mainControl', () => {
  it('picks the one primary control of a Needs you or Unstarted row', () => {

    expect(mainControl(item(1, { status: 'awaiting-approval' }))?.label).toBe('Approve');
    expect(mainControl(item(1, { status: 'failed' }))?.label).toBe('Retry');
    expect(mainControl(item(1, { status: 'unstarted' }))?.label).toBe('Start');
    expect(mainControl(item(1, { status: 'triaging' }))).toBeNull();
    expect(mainControl(item(1, { sessions: [session({ state: 'waiting' })] }))).toBeNull();
    expect(mainControl(item(1))).toBeNull();
  });
});

describe('markOf', () => {
  const mark = (patch: Partial<WorkItemView>) => {
    const found = markOf(item(1, patch));
    return found === 'priority' ? found : [found.icon, found.title, found.tone ?? null];
  };

  it('shows what the operator must do in Needs you', () => {
    expect(mark({ status: 'awaiting-approval', approvalPrompt: '/publish' })).toEqual(['cloud-upload', 'Approve the publish', null]);
    expect(mark({ status: 'unstarted' })).toBe('priority');
    expect(mark({ status: 'triaging' })).toEqual(['loading codicon-modifier-spin', 'Triaging', null]);
    expect(mark({ sessions: [session({ state: 'waiting' })] })).toEqual(['comment-discussion', 'Answer a question', null]);
    expect(mark({ status: 'blocked', error: 'Which account should I use?' })).toEqual(['debug-pause', 'Blocked', null]);
    expect(mark({ status: 'blocked', error: 'Needs VPN access.' })).toEqual(['debug-pause', 'Blocked', null]);
    expect(mark({ status: 'failed', error: 'exit 1' })).toEqual(['error', 'Failed', 'error']);
  });

  it('shows the phase in Working and how it ended in Done', () => {
    expect(mark({ status: 'queued' })).toEqual(['clock', 'Queued', null]);
    expect(mark({ status: 'setup', needsPick: true })).toEqual(['tools', 'Claiming', null]);
    expect(mark({ status: 'setup' })).toEqual(['tools', 'Setting up', null]);
    expect(mark({ status: 'running' })).toEqual(['sync codicon-modifier-spin', 'Running', null]);
    expect(mark({ status: 'done', doneReason: 'session' })).toEqual(['check', 'Finished by the session', null]);
    expect(mark({ status: 'done', doneReason: 'operator' })).toEqual(['account', 'Marked done', null]);
    expect(mark({ status: 'done', doneReason: 'unassigned' })).toEqual(['sign-out', 'Left the assigned state', null]);
  });
});

describe('clockOf', () => {
  it('counts Needs you from the status or the wait, Working from the run start, and the rest from scope entry, stopping at done (PRD R27)', () => {
    const scoped = (patch: Partial<WorkItemView>, scopeAt: number | null = 5, snoozed = false) =>
      item(1, { createdAt: 1, statusAt: 2, runStartedAt: 3, ...patch, ticket: { ...item(1).ticket, scopeAt, snoozed } });

    expect(clockOf(scoped({ status: 'blocked' }))).toEqual({ since: 2, label: 'In this status since' });
    expect(clockOf(scoped({ status: 'running', sessions: [session({ state: 'waiting', stateAt: 4 })] }))).toEqual({ since: 4, label: 'Waiting since' });
    expect(clockOf(scoped({ status: 'setup', sessions: [session({ kind: 'pick', state: 'waiting', stateAt: 4 })] }))).toEqual({ since: 4, label: 'Waiting since' });
    // A blocked item whose session still waits counts from the block.
    expect(clockOf(scoped({ status: 'blocked', sessions: [session({ state: 'waiting', stateAt: 4 })] }))).toEqual({ since: 2, label: 'In this status since' });
    expect(clockOf(scoped({ status: 'running' }))).toEqual({ since: 3, label: 'Working since' });
    expect(clockOf(scoped({ status: 'queued', runStartedAt: null }))).toEqual({ since: 2, label: 'Working since' });
    expect(clockOf(scoped({ status: 'unstarted' }))).toEqual({ since: 5, label: 'In scope since' });
    expect(clockOf(scoped({ status: 'unstarted' }, null))).toEqual({ since: 1, label: 'In scope since' });
    expect(clockOf(scoped({ status: 'blocked' }, 5, true))).toEqual({ since: 5, label: 'In scope since' });
    // Done keeps the scope entry the work item had, not the ticket's later one.
    expect(clockOf(scoped({ status: 'done', doneAt: 9, scopeAt: 4 }, 8))).toEqual({ since: 4, label: 'In scope from' });
    expect(clockOf(scoped({ status: 'done', doneAt: 9 }, 8))).toEqual({ since: 1, label: 'In scope from' });
  });

  it('shows the span from scope entry to done in a done row', () => {
    const root = render(snapshot([item(1, { status: 'done', scopeAt: NOW - 3 * 86_400_000, doneAt: NOW - 86_400_000 })]), { groups: new Map([['done', true]]) });

    expect(root.querySelector('[data-item="1"] .queue')?.textContent).toBe('2d');
    expect(root.querySelector('[data-item="1"] .queue')?.getAttribute('title')).toMatch(/^In scope from .+ UTC to .+ UTC$/);
  });
});

describe('rankOf and queueTime', () => {
  it('ranks only a full rating', () => {
    expect(rankOf(triage({ immediacy: 'URGENT', severity: 'HIGH' }))).toBe(0);
    expect(rankOf(triage({ immediacy: 'NON-BLOCKING', severity: 'LOW' }))).toBe(4);
    expect(rankOf(triage({ immediacy: 'BLOCKING' }))).toBeNull();
    expect(rankOf(null)).toBeNull();
  });

  it('gives whole minutes, hours, days and weeks', () => {
    expect([59_000, 59 * 60_000, 60 * 60_000, 23 * 3_600_000 + 59 * 60_000, 86_400_000, 6 * 86_400_000, 7 * 86_400_000, 20 * 86_400_000, -5_000].map((ms) => queueTime(NOW - ms, NOW))).toEqual([
      '0m',
      '59m',
      '1h',
      '23h',
      '1d',
      '6d',
      '1w',
      '2w',
      '0m',
    ]);
  });
});

describe('renderPanel', () => {
  it('groups rows in collapsible groups, escapes text, and shows the mark, stage age, notes and errors', () => {
    const root = render(
      snapshot(
        [
          item(1, { status: 'done', doneAt: NOW, doneReason: 'session' }),
          item(2, { status: 'failed', error: 'Workspace not trusted.' }),
          item(3, { stage: 'Planning', stageAt: NOW - 3 * 60_000, sessions: [session()] }),
        ],
        { errors: { settings: 'sessions.concurrency must be a whole number from 1 to 4.', playbooks: ['dev/bad.md: description is required.'], hooks: null, sources: { github: 'The GitHub CLI is not signed in.' } } },
      ),
    );

    expect(headings(root)).toEqual(['Needs you 1', 'Working 1', 'Unstarted 0', 'Done 1']);
    expect([...root.querySelectorAll<HTMLDetailsElement>('details.group')].map((group) => [group.dataset['group'], group.open])).toEqual([
      ['needs', true],
      ['working', true],
      ['unstarted', true],
      ['done', false],
    ]);
    expect(root.querySelector('[data-group="unstarted"] p.empty')?.textContent).toBe('Nothing waits to be started.');
    expect(root.querySelector('details.item, details:not(.group), .detail')).toBeNull();
    expect(root.querySelector('[data-item="2"] .title')?.textContent).toBe('Issue <2>');
    expect(root.querySelector('[data-item="2"] .line.third .note')?.textContent).toBe('Workspace not trusted.');
    expect(root.querySelector('[data-item="2"] .line.third .note')?.hasAttribute('title')).toBe(false);
    expect([...root.querySelectorAll('[data-item="3"] .line')].map((line) => line.className)).toEqual(['line first', 'line second', 'line third']);
    // Line 1 is the title and the time; line 2 the playbook, the ticket and the actions.
    expect([...root.querySelector('[data-item="3"] .line')!.children].map((child) => child.className)).toEqual(['title', 'queue']);
    expect(root.querySelector('[data-item="3"] .line.second .meta')?.textContent).toBe('dev:developgh 103');
    expect(root.querySelector('[data-item="3"] .line.second a.key')?.getAttribute('href')).toBe('https://github.com/o/r/issues/103');
    expect(root.querySelectorAll('.title[title], .playbook-name[title], .key[title], .approval[title], .note[title], .returned[title]')).toHaveLength(0);
    // The source names the key's colour class; only github is shortened.
    expect(root.querySelector('[data-item="3"] .line.second a.key')?.className).toBe('key github');
    // No status text: the group and the mark say it, and the mark's tooltip names it.
    expect(root.querySelector('.status')).toBeNull();
    expect([...root.querySelectorAll('.item')].map((row) => row.textContent).join(' ')).not.toMatch(/Failed|Running|Finished/);
    expect(titles(root, '[data-item="3"] .line.third .mark')).toEqual(['Running']);
    expect(root.querySelector('[data-item="2"] .line.third .mark.codicon-error.error')?.getAttribute('title')).toBe('Failed');
    expect(root.querySelector('[data-item="3"] .line.third .stage')?.textContent).toBe('Planning · 3m');
    expect([...root.querySelectorAll('.errors .note')].map((note) => note.textContent?.trim())).toEqual([
      'Settings: sessions.concurrency must be a whole number from 1 to 4.',
      'Playbook dev/bad.md: description is required.',
      'github: The GitHub CLI is not signed in.',
    ]);
    expect(root.querySelector('form')).toBeNull();
  });

  it('honours groups the operator opened or closed', () => {
    const root = render(snapshot([item(1, { status: 'done', doneAt: NOW })]), { groups: new Map([['needs', false], ['done', true]]) });

    expect([...root.querySelectorAll<HTMLDetailsElement>('details.group')].map((group) => group.open)).toEqual([false, true, true, true]);
  });

  it('shows only the primary control and no session state, with every control in the right-click menu', () => {
    const closed = render(snapshot([item(1, { status: 'awaiting-approval' }), item(2)]));

    expect(controlLabels(closed, '[data-item="1"] button.control')).toEqual(['Approve']);
    expect(titles(closed, '[data-item="1"] .actions > button.control')).toEqual(['Approve']);
    expect(closed.querySelector('.more-button, .menu')).toBeNull();
    expect(titles(closed, '[data-item="2"] button.control')).toEqual([]);

    const running = render(snapshot([item(4, { status: 'blocked', sessions: [session({ state: 'waiting' })] })]));

    expect(titles(running, '[data-item="4"] .actions > *')).toEqual(['Retry']);
    expect(JSON.parse(running.querySelector<HTMLElement>('[data-item="4"]')!.dataset['open']!)).toEqual({ type: 'attach', shortId: 'aaaa1111', name: 'github 104' });
    expect(running.querySelector('.session-button')).toBeNull();
    expect(JSON.parse(render(snapshot([item(6, { status: 'unstarted' })])).querySelector<HTMLElement>('[data-item="6"]')!.dataset['open']!)).toEqual({ type: 'openUrl', url: 'https://github.com/o/r/issues/106' });
    expect(render(snapshot([item(6, { sessions: [session({ state: 'starting', shortId: null, nativeSessionId: null })] })])).querySelector('[data-item="6"]')!.hasAttribute('data-open')).toBe(false);
    expect(render(snapshot([item(7, { sessions: [session({ state: 'starting', shortId: null, nativeSessionId: null })] })])).querySelector('[data-item="7"] .actions')).toBeNull();

    expect(rowMenu(closed.querySelector('[data-item="1"]')!)).toEqual({
      section: 'row',
      defaults: true,
      shown: ['approve', 'triageAgain', 'markDone', 'snooze'],
      actions: {
        approve: { type: 'approve', workItemId: 1 },
        triageAgain: { type: 'retriage', workItemId: 1 },
        markDone: { type: 'mark-done', workItemId: 1 },
        snooze: { type: 'snooze', ticketId: 1 },
      },
    });
    expect(rowMenu(running.querySelector('[data-item="4"]')!).shown).toEqual(['retry', 'stop', 'markDone', 'snooze']);
    expect(rowMenu(render(snapshot([item(3, { status: 'done', doneAt: NOW })]), { groups: new Map([['done', true]]) }).querySelector('[data-item="3"]')!).shown).toEqual([]);
  });

  it('puts the primary actions as text buttons in a column beside lines 2 and 3, with Report before Approve on an approval row', () => {
    const links = [{ id: 3, ticketId: 1, label: 'Docs', target: 'https://example.test/docs', reportedAt: NOW }];
    const report = 'D:\\wt\\round-2\\review.md';
    const root = render(snapshot([item(1, { status: 'awaiting-approval', approvalReport: report, links }), item(2, { status: 'blocked', approvalReport: report, links })]));
    const approval = root.querySelector('[data-item="1"]')!;
    const blocked = root.querySelector('[data-item="2"]')!;

    // Report is an icon with the report's filename in the tooltip; Approve is primary, Retry takes the error colour on a failed row and the warning colour on a blocked one, and Start has no tone.
    expect([...approval.querySelectorAll<HTMLButtonElement>(':scope > .actions > button')].map((button) => [button.title, button.textContent, button.className])).toEqual([
      ['review.md', '', 'control action-button icon-only'],
      ['Approve', 'Approve', 'control action-button primary'],
    ]);
    expect(root.querySelector('[data-item="2"] .action-button')?.className).toBe('control action-button warning');
    expect(render(snapshot([item(3, { status: 'failed' })])).querySelector('[data-item="3"] .action-button')?.className).toBe('control action-button error');
    expect(render(snapshot([item(4, { status: 'unstarted' })])).querySelector('[data-item="4"] .action-button')?.className).toBe('control action-button');
    expect(approval.querySelector('.line .actions, .line button')).toBeNull();
    expect(JSON.parse(controlNamed(approval, 'review.md').dataset['message']!)).toEqual({ type: 'openUrl', url: report });
    expect([...approval.querySelectorAll('.line.third a.badge')].map((badge) => badge.textContent?.trim())).toEqual(['Docs']);
    // Only an approval row shows Report: not a blocked, done, waiting or approval row without a report.
    expect([...blocked.querySelectorAll<HTMLButtonElement>(':scope > .actions > button')].map((button) => button.title)).toEqual(['Retry']);
    const others = render(
      snapshot([
        item(5, { status: 'done', doneAt: NOW, approvalReport: report }),
        item(6, { status: 'running', sessions: [session({ state: 'waiting' })], approvalReport: report }),
        item(7, { status: 'awaiting-approval', approvalPrompt: '/push' }),
      ]),
      { groups: new Map([['done', true]]) },
    );
    expect([5, 6, 7].map((id) => [...others.querySelectorAll<HTMLButtonElement>(`[data-item="${id}"] > .actions > button`)].map((button) => button.title))).toEqual([[], [], ['Approve: runs /push']]);

    const done = render(snapshot([item(5, { status: 'done', doneAt: NOW, doneReason: 'session', warning: 'The ticket left the assigned state.', stage: 'review', stageAt: NOW - 60_000, links })])).querySelector('[data-item="5"]')!;
    // The warning note follows its mark, before the stage and the badges.
    expect([...done.querySelector('.line.third .meta')!.children].map((child) => child.className)).toEqual(['mark codicon codicon-check', 'note', 'stage', 'badge url']);
  });

  it('shows no triage summary, triage context, task prompt or session history', () => {
    const root = render(snapshot([item(1, { status: 'blocked', taskPrompt: 'Build 101.', triage: triage({ summary: 'A summary.', context: 'Issue text' }), sessions: [session({ state: 'ended', outcome: 'stopped', outcomeDetail: 'Stopped by you.' })] })]));

    for (const hidden of ['A summary.', 'Issue text', 'Build 101.', 'Stopped by you.']) {
      expect(root.textContent).not.toContain(hidden);
    }
  });

  it('shows no worktree symbol, the time in queue, and no actions on a done work item with a running session', () => {
    const root = render(
      snapshot([item(1, { status: 'done', createdAt: NOW - 3 * 86_400_000, doneAt: NOW - 86_400_000, sessions: [session()], worktree: { id: 1, ticketId: 1, path: 'D:/git/widgets-wt/101-fix', branch: '101-fix', linkedBy: 'report' } })]),
      { groups: new Map([['done', true]]) },
    );

    expect(root.querySelector('.codicon-git-branch')).toBeNull();
    expect(root.textContent).not.toContain('101-fix');
    expect(titles(root, '[data-item="1"] .line.third .mark')).toEqual(['Finished by the session']);
    // A done item with a running session has no control, so no actions column.
    expect(root.querySelector('[data-item="1"] .actions')).toBeNull();
    // A done item stops its clock when it ends.
    expect(root.querySelector('[data-item="1"] .queue')?.textContent).toBe('2d');
  });

  it('says what an unconfigured home is missing', () => {
    const root = render(snapshot([], { sources: [], sourceStates: [], playbooks: [], repoRoots: [] }));

    expect(render(snapshot([], { sources: [], sourceStates: [{ name: 'zoho', enabled: false }] })).querySelector('p.empty')?.textContent?.trim()).toBe('No source is polled. Turn one on in the title bar.');
    expect([...root.querySelectorAll('p.empty')].slice(0, 2).map((p) => p.textContent?.trim())).toEqual([
      'No source is configured. Add one in C:\\Users\\me\\.switchboard\\settings.json.',
      'No task playbooks are loaded. Add them under C:\\Users\\me\\.switchboard\\playbooks.',
    ]);
    expect(renderPanel(snapshot([]), NOW, ui())).not.toContain('No source is polled');
  });

  it('lists pool tickets in Unstarted with no Unclaimed tag, a priority dot, time in queue, Returned mark and Start, with Snooze in the right-click menu and no summary', () => {
    const ticket = (id: number) => ({ id, source: 'zoho', sourceKey: String(500 + id), ref: `#${500 + id}`, sourceId: `z${id}`, title: `Case <${id}>`, url: `https://desk.example.test/${id}`, assigned: false, pool: true, snoozed: false, snoozedUntil: null, sortAt: NOW - id * 3_600_000, scopeAt: NOW - id * 1_800_000, lastPolledAt: NOW, repoRoot: '' });
    const rated = (id: number, patch: Partial<Triage> = {}) => triage({ id, ticketId: id, workItemId: null, playbook: 'support:case', summary: 'Fix sync — defect', immediacy: 'BLOCKING', severity: 'MED', ...patch });
    const root = render(
      snapshot([], {
        pool: [
          { ticket: ticket(1), triage: rated(1, { immediacy: 'URGENT', severity: 'MED' }), returned: 2 },
          { ticket: ticket(2), triage: rated(2), returned: 0 },
          { ticket: ticket(3), triage: rated(3, { immediacy: 'NON-BLOCKING', severity: 'MED' }), returned: 0 },
          { ticket: ticket(4), triage: rated(4, { playbook: null, summary: null, immediacy: null, severity: null, error: 'Timed out.' }), returned: 0 },
          { ticket: ticket(5), triage: rated(5, { playbook: null, summary: null, immediacy: null, severity: null, endedAt: null }), returned: 0 },
        ],
      }),
    );
    // Rank 1, then rank 2 with the unrated ones counted as 2, oldest first, then rank 3.
    const rows = [...root.querySelectorAll('.pool-item')];
    const byId = (id: number) => root.querySelector(`.pool-item[data-ticket="${id}"]`)!;

    expect(headings(root)).toContain('Unstarted 5');
    expect(rows.map((row) => row.getAttribute('data-ticket'))).toEqual(['1', '5', '4', '2', '3']);
    expect([1, 2, 3, 4, 5].map((id) => byId(id).querySelector('.title > .priority:first-child') !== null)).toEqual([true, true, false, false, false]);
    expect(byId(1).querySelector('.priority')?.getAttribute('title')).toBe('Immediacy: URGENT   Severity: MED');
    // A row that is not priority reserves no space for the dot.
    expect(byId(3).querySelector('.line:first-child .mark')).toBeNull();
    expect(byId(3).querySelector('.title')?.innerHTML).toBe('Case &lt;3&gt;');
    expect(root.querySelector('.tag')).toBeNull();
    expect(root.textContent).not.toContain('Unclaimed');
    expect(byId(1).querySelector('.line.second a.key')?.textContent).toBe('zoho 501');
    expect(JSON.parse(byId(1).getAttribute('data-open')!)).toEqual({ type: 'openUrl', url: 'https://desk.example.test/1' });
    expect(byId(1).querySelector('.line.second a.key')?.getAttribute('href')).toBe('https://desk.example.test/1');
    expect(titles(byId(1), ':scope > .actions > button.control.action-button')).toEqual(['Start']);
    expect(byId(1).querySelector('.line:first-child .actions')).toBeNull();
    expect(rowMenu(byId(1))).toMatchObject({ shown: ['start', 'snooze'], actions: { start: { type: 'pick', ticketId: 1 }, snooze: { type: 'snooze', ticketId: 1 } } });
    expect(byId(1).querySelector('.line.second .meta > .playbook-name:first-child')?.textContent).toBe('support:case');
    expect(byId(1).querySelector('.line:first-child .playbook-name')).toBeNull();
    expect(byId(1).querySelector('button.action-button')?.textContent).toBe('Start');
    expect(root.textContent).not.toContain('URGENT/MED');
    // A pool ticket counts from entering scope, not from the customer's last message, which orders the group.
    expect(byId(1).querySelector('.queue')?.textContent).toBe('30m');
    expect(byId(1).querySelector('.queue')?.getAttribute('title')).toMatch(/^In scope since \d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
    expect(root.textContent).not.toContain('Fix sync — defect');
    expect(byId(1).querySelector('.line.second .returned')?.textContent).toBe('Returned ×2');
    expect(byId(2).querySelector('.returned')).toBeNull();
    expect(byId(1).querySelector('.playbook-name')?.textContent).toBe('support:case');
    expect([byId(1).querySelector('.playbook-name .namespace')?.textContent, byId(1).querySelector('.playbook-name .name')?.textContent]).toEqual(['support:', 'case']);
    expect(controlLabels(byId(1), 'button.control')).toEqual(['Start']);
    expect(JSON.parse(controlNamed(byId(1), 'Start').dataset['message']!)).toEqual({ type: 'action', action: { type: 'pick', ticketId: 1 } });
    expect(byId(4).querySelector('.note')?.textContent).toBe('Timed out.');
    expect(titles(byId(4), '.actions > button.control')).toEqual(['Triage again']);
    expect(rowMenu(byId(4))).toMatchObject({ shown: ['triageAgain', 'start', 'snooze'], actions: { triageAgain: { type: 'retriage-pool', ticketId: 4 } } });
    expect(titles(byId(5), '.line.third .mark.codicon-loading.codicon-modifier-spin')).toEqual(['Triaging']);
    expect(byId(5).querySelector('.playbook-name')?.textContent).toBe('support:triage');
    const adhoc = render(snapshot([item(6, { ticket: { ...item(6).ticket, source: 'adhoc', sourceKey: '6', url: '' } })]));
    expect(adhoc.querySelector('.line.second span.key')?.textContent).toBe('adhoc 6');
    expect(byId(1).querySelector('.line.second a.key')?.className).toBe('key zoho');
    expect(byId(5).textContent).not.toContain('Triaging');
    expect(root.textContent).not.toContain('Pick');
  });

  it('puts unstarted work items in Unstarted as Assigned with Start, ordered with the pool by importance then age, and Approve only on an approval report', () => {
    const rated = (immediacy: Triage['immediacy'], severity: Triage['severity']) => triage({ immediacy, severity, summary: 'Build it.' });
    const assigned = item(1, { status: 'unstarted', createdAt: NOW - 5 * 3_600_000, triage: rated('BLOCKING', 'HIGH') });
    const unrated = item(2, { status: 'unstarted', createdAt: NOW - 9 * 3_600_000 });
    const ticket = { id: 9, source: 'forum', sourceKey: '509', ref: 'T509', sourceId: null, title: 'Topic', url: '', assigned: false, pool: true, snoozed: false, snoozedUntil: null, sortAt: NOW - 3_600_000, scopeAt: null, lastPolledAt: NOW, repoRoot: '' };
    const pool = [{ ticket, triage: rated('NON-BLOCKING', 'HIGH'), returned: 0 }];
    const root = render(snapshot([assigned, unrated, item(3, { status: 'awaiting-approval', approvalPrompt: '/publish' })], { pool }));
    const unstarted = root.querySelector('[data-group="unstarted"]')!;

    expect(unstartedOrder([assigned, unrated], pool).map((entry) => entry.ticket.id)).toEqual([1, 2, 9]);
    expect(unstarted.querySelector('[data-ticket="9"]')!.hasAttribute('data-open')).toBe(false);
    expect([...unstarted.querySelectorAll('.item')].map((row) => row.getAttribute('data-item') ?? `ticket ${row.getAttribute('data-ticket')}`)).toEqual(['1', '2', 'ticket 9']);
    expect(headings(unstarted)).toEqual(['Unstarted 3']);
    expect(unstarted.querySelector('[data-item="1"] .tag')).toBeNull();
    expect(unstarted.textContent).not.toContain('Assigned');
    expect(unstarted.textContent).not.toContain('Build it.');
    expect(unstarted.querySelector('[data-item="1"] .title > .priority')).not.toBeNull();
    // An unstarted work item has no status mark, so with nothing else to show it has no third line.
    expect(unstarted.querySelector('[data-item="2"] .line.third')).toBeNull();
    expect(titles(unstarted, '[data-item="1"] .actions > button.control')).toEqual(['Start']);
    expect(JSON.parse(controlNamed(unstarted.querySelector('[data-item="1"]')!, 'Start').dataset['message']!)).toEqual({ type: 'action', action: { type: 'start', workItemId: 1 } });
    expect(titles(root, '[data-group="needs"] .actions > button.control')).toEqual(['Approve: runs /publish']);
    expect(labels(item(4, { status: 'unstarted' }))).not.toContain('Approve');
  });

  it('lists a triaging work item in Unstarted with its source namespace and triage as the playbook, the Triaging mark and no Start', () => {
    const triaging = (id: number, source: string) => item(id, { status: 'triaging', playbook: 'dev:develop', ticket: { ...item(id).ticket, source } });
    const root = render(snapshot([triaging(1, 'github'), triaging(2, 'zoho'), triaging(3, 'other')]));
    const byId = (id: number) => root.querySelector(`[data-group="unstarted"] [data-item="${id}"]`)!;

    expect(headings(root)).toEqual(['Needs you 0', 'Working 0', 'Unstarted 3', 'Done 0']);
    expect([1, 2, 3].map((id) => byId(id).querySelector('.playbook-name')?.textContent)).toEqual(['dev:triage', 'support:triage', 'triage']);
    expect(titles(byId(1), '.line.third .mark.codicon-loading.codicon-modifier-spin')).toEqual(['Triaging']);
    expect(byId(1).querySelector('.actions')).toBeNull();
    expect(rowMenu(byId(1)).shown).toEqual(['markDone', 'snooze']);
  });

  it('moves snoozed work items and pool tickets into a collapsed Snoozed group with their own marks and wake times, and shows an approval summary', () => {
    const wakeAt = new Date(2026, 9, 12, 6).getTime();
    const sleepy = item(2, { status: 'unstarted', ticket: { ...item(2).ticket, snoozed: true, snoozedUntil: wakeAt } });
    const ready = item(3, { status: 'awaiting-approval', approvalPrompt: '/review-pr pr:123 publish', approvalSummary: 'Review ready to post.' });
    const poolTicket = { id: 9, source: 'zoho', sourceKey: '509', ref: '#509', sourceId: 'z9', title: 'Cold case', url: '', assigned: false, pool: true, snoozed: true, snoozedUntil: null, sortAt: 1, scopeAt: null, lastPolledAt: NOW, repoRoot: '' };
    const data = snapshot([sleepy, ready], { pool: [{ ticket: poolTicket, triage: null, returned: 0 }] });
    const root = render(data);
    const snoozed = root.querySelector<HTMLDetailsElement>('details[data-group="snoozed"]')!;

    expect(headings(root)).toEqual(['Needs you 1', 'Working 0', 'Unstarted 0', 'Done 0', 'Snoozed 2']);
    expect(snoozed.open).toBe(false);
    expect([...snoozed.querySelectorAll('.title')].map((t) => t.textContent)).toEqual(['Issue <2>', 'Cold case']);
    expect(snoozed.querySelectorAll('.priority')).toHaveLength(0);
    expect(snoozed.querySelector('.mark.codicon')).toBeNull();
    expect([...snoozed.querySelectorAll('.wake')].map((w) => [w.textContent?.trim(), w.getAttribute('title')])).toEqual([['Mon, Oct 12, 6:00 AM', 'Wakes Mon, Oct 12, 6:00 AM']]);
    expect(root.querySelector('[data-item="2"] .wake .codicon-clock')).not.toBeNull();
    expect(root.querySelector('[data-ticket="9"] .line.third')).toBeNull();
    expect(titles(root, '[data-item="3"] .line.third .mark')).toEqual(['Approve the publish']);
    expect(rowMenu(snoozed.querySelector('[data-item="2"]')!)).toMatchObject({ shown: ['start', 'triageAgain', 'markDone', 'snooze', 'restore'], actions: { snooze: { type: 'snooze', ticketId: 2 }, restore: { type: 'restore', ticketId: 2 } } });
    expect(rowMenu(snoozed.querySelector('[data-ticket="9"]')!)).toMatchObject({ shown: ['start', 'snooze', 'restore'], actions: { snooze: { type: 'snooze', ticketId: 9 }, restore: { type: 'restore', ticketId: 9 } } });
    expect(root.querySelector('[data-item="3"] .approval')?.textContent).toBe('Review ready to post.');
    expect(root.querySelector('[data-item="3"] .approval')?.hasAttribute('title')).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('[data-item="3"] .actions > button.control')?.title).toBe('Approve: runs /review-pr pr:123 publish');
    expect(render(data, { groups: new Map([['snoozed', true]]) }).querySelector<HTMLDetailsElement>('details[data-group="snoozed"]')!.open).toBe(true);
    expect(labels(item(4, { status: 'done', ticket: { ...item(4).ticket, snoozed: true, snoozedUntil: null } }))).toEqual(['Snooze', 'Restore']);
    expect(render(snapshot([item(5, { ticket: { ...item(5).ticket, snoozed: false, snoozedUntil: wakeAt } })])).querySelector('.wake')).toBeNull();
  });

  it('shows one Snoozed row per ticket: its pool entry, else its open work item, else its latest, and no row elsewhere', () => {
    const asleep = (id: number, ticketId: number, status: WorkItemView['status']) =>
      item(id, { ticketId, status, ticket: { ...item(ticketId).ticket, snoozed: true, snoozedUntil: null } });
    const root = render(snapshot([asleep(1, 7, 'done'), asleep(2, 7, 'unstarted'), asleep(3, 8, 'done'), asleep(4, 8, 'done'), asleep(5, 9, 'done')]));
    const snoozed = root.querySelector('details[data-group="snoozed"]')!;

    expect(headings(root)).toEqual(['Needs you 0', 'Working 0', 'Unstarted 0', 'Done 0', 'Snoozed 3']);
    expect([...snoozed.querySelectorAll('[data-item]')].map((row) => row.getAttribute('data-item'))).toEqual(['2', '4', '5']);

    // A ticket back in the pool shows as its pool row only.
    const pooled = { ...item(9).ticket, assigned: false, pool: true, snoozed: true };
    const back = render(snapshot([asleep(6, 9, 'done')], { pool: [{ ticket: pooled, triage: null, returned: 1 }] }));

    expect(headings(back).at(-1)).toBe('Snoozed 1');
    expect(back.querySelector('[data-item="6"]')).toBeNull();
    expect(back.querySelector('details[data-group="snoozed"] [data-ticket="9"]')).not.toBeNull();
  });

  it('shows the priority dot first, pull requests and other-repo issues on line 2, then Returned on line 2, and other links on line 3 (PRD R50–R52)', () => {
    const link = (id: number, label: string, target: string) => ({ id, ticketId: 1, label, target, reportedAt: NOW });
    const zoho = { ...item(1).ticket, source: 'zoho', sourceKey: '501', url: 'https://desk.example.test/501' };
    const rated = item(1, {
      returned: 1,
      ticket: zoho,
      triage: triage({ playbook: 'support:case', immediacy: 'URGENT', severity: 'HIGH' }),
      links: [
        link(1, 'Docs', 'https://example.test/docs'),
        link(2, 'Issue #7', 'https://github.com/o/r/issues/7'),
        link(3, 'Fix the sync', 'https://github.com/o/r/pull/12'),
        link(4, 'Case', 'https://desk.example.test/501'),
      ],
    });
    // A GitHub ticket's issue links stay on line 3, and a link to the ticket itself is not repeated.
    const github = item(9, {
      links: [link(5, 'Issue #8', 'https://github.com/o/r/issues/8'), link(6, 'PR 13', 'https://github.com/o/r/pull/13'), link(7, 'Self', 'https://github.com/o/r/issues/109')],
    });
    const rating = (id: number, immediacy: Triage['immediacy'], severity: Triage['severity']) => item(id, { triage: triage({ immediacy, severity }) });
    const root = render(
      snapshot([
        rated,
        rating(2, 'NON-BLOCKING', 'HIGH'),
        rating(3, 'NON-BLOCKING', 'LOW'),
        rating(4, 'BLOCKING', 'LOW'),
        rating(5, null, 'HIGH'),
        rating(6, 'BLOCKING', null),
        rating(7, 'NON-BLOCKING', null),
        rating(8, null, 'MED'),
        github,
      ]),
    );
    const row = root.querySelector('[data-item="1"]')!;
    const badges = (selector: string) => [...root.querySelectorAll(`${selector} a.badge`)].map((a) => [a.textContent?.trim(), a.getAttribute('href')]);

    expect(row.querySelector('.line:first-child > .title > .priority:first-child')?.getAttribute('title')).toBe('Immediacy: URGENT   Severity: HIGH');
    expect(root.querySelector('[data-item="2"] .line:first-child .title > .priority')).not.toBeNull();
    expect([3, 4, 5, 6, 7, 8].map((id) => root.querySelector(`[data-item="${id}"] .priority`)?.getAttribute('title') ?? null)).toEqual([
      null,
      'Immediacy: BLOCKING   Severity: LOW',
      'Immediacy: ?   Severity: HIGH',
      'Immediacy: BLOCKING   Severity: ?',
      null,
      null,
    ]);
    expect([...row.querySelector('.line.second .meta')!.children].map((child) => child.textContent?.trim())).toEqual(['dev:develop', 'zoho 501', '12', 'gh 7', 'Returned ×1']);
    expect(badges('[data-item="1"] .line.third')).toEqual([['Docs', 'https://example.test/docs']]);
    expect(row.querySelector('.line.third .returned')).toBeNull();
    expect(badges('[data-item="9"] .line.second')).toEqual([['13', 'https://github.com/o/r/pull/13']]);
    // Each kind has its own class and icon; a GitHub issue looks like a GitHub ticket's key, with no icon.
    expect([...row.querySelectorAll('a.badge')].map((a) => [a.className, a.querySelector('.codicon')?.className])).toEqual([
      ['badge pr', 'codicon codicon-git-pull-request'],
      ['badge url', 'codicon codicon-link'],
    ]);
    expect([...root.querySelectorAll('[data-item="1"] .line.second a.key, [data-item="9"] .line.third a.key')].map((a) => [a.className, a.textContent, a.getAttribute('href'), a.querySelector('.codicon')])).toEqual([
      ['key zoho', 'zoho 501', 'https://desk.example.test/501', null],
      ['key github', 'gh 7', 'https://github.com/o/r/issues/7', null],
      ['key github', 'gh 8', 'https://github.com/o/r/issues/8', null],
    ]);
    expect(['https://example.test/x', 'http://github.com/o/r/pull/1', 'HTTPS://example.test/x', 'https://github.com/o/r/pull/1/files', 'https://github.com/o/r/issues/2'].map(linkKind)).toEqual([
      'url',
      'url',
      'url',
      'pr',
      'issue',
    ]);
    expect(badges('[data-item="9"] .line.third')).toEqual([]);
    expect(root.querySelector('[data-item="2"] a.badge')).toBeNull();
  });

  it('cuts a reported text at its cap on a word boundary, with the whole text in the tooltip (PRD R23)', () => {
    expect(clip('Review ready', 60)).toEqual({ text: 'Review ready', full: null });
    expect(clip('Round 2 (Scoped): 4 of 5 prior findings fixed; history-2 still present at Plausible.', 60)).toEqual({
      text: 'Round 2 (Scoped): 4 of 5 prior findings fixed; history-2…',
      full: 'Round 2 (Scoped): 4 of 5 prior findings fixed; history-2 still present at Plausible.',
    });
    // No space in the second half of the cut: the cut falls at the cap itself.
    const run = `a ${'b'.repeat(60)}`;
    expect(clip(run, 30)).toEqual({ text: `a ${'b'.repeat(28)}…`, full: run });
    // Graphemes count, so an emoji or an accented letter at the cap stays whole and a 24-grapheme text is not cut.
    expect(clip(`${'x'.repeat(23)}😀abc`, 24)).toEqual({ text: `${'x'.repeat(23)}😀…`, full: `${'x'.repeat(23)}😀abc` });
    expect(clip(`${'x'.repeat(23)}e\u0301`, 24)).toEqual({ text: `${'x'.repeat(23)}e\u0301`, full: null });

    const summary = 'Round 2 (Fix and sweep): 7 of 8 prior findings fixed, 1 withdrawn, 0 new findings, 1 Bonus Point. Posting also returns #19516 to devlead at Dev.';
    const reason = 'Which of the two migration strategies in the plan should the fix use, the backfill or the lazy rewrite on read?';
    const root = render(
      snapshot([
        item(1, { status: 'awaiting-approval', approvalPrompt: '/publish', approvalSummary: summary, stage: 'Waiting for the operator to approve', stageAt: NOW }),
        item(2, { status: 'blocked', error: reason }),
      ]),
    );
    const approval = root.querySelector<HTMLElement>('[data-item="1"] .approval')!;
    const stage = root.querySelector<HTMLElement>('[data-item="1"] .stage')!;
    const note = root.querySelector<HTMLElement>('[data-item="2"] .note')!;

    expect(approval.textContent).toBe('Round 2 (Fix and sweep): 7 of 8 prior findings fixed, 1…');
    expect(approval.textContent!.length).toBeLessThanOrEqual(CAPS.approval + 1);
    expect([approval.title, approval.hasAttribute('data-full')]).toEqual([summary, true]);
    expect(stage.textContent).toBe('Waiting for the operator… · 0s');
    expect(stage.title).toBe('Waiting for the operator to approve');
    expect(note.textContent).toBe('Which of the two migration strategies in the plan should the fix use, the…');
    expect(note.title).toBe(reason);
  });

  it('formats ages', () => {
    expect([age(NOW - 40_000, NOW), age(NOW - 5 * 60_000, NOW), age(NOW - 2 * 3_600_000, NOW), age(NOW - 3 * 86_400_000, NOW)]).toEqual(['40s', '5m', '2h', '3d']);
  });
});

describe('startPanel', () => {
  let root: HTMLElement;
  let posted: unknown[];

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    root = document.getElementById('root')!;
    posted = [];
    startPanel(root, { postMessage: (message) => posted.push(message) }, () => NOW);
  });

  const send = (data: Snapshot) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', snapshot: data } }));

  it('announces itself, renders each state, and posts clicks, link opens and the row open action on a click or Enter', () => {
    expect(posted).toEqual([{ type: 'ready' }]);
    // VS Code's webview host listens for clicks on the window and opens every anchor it sees (mechanics M16).
    const reachedWindow: string[] = [];
    window.addEventListener('click', (event) => reachedWindow.push((event.target as HTMLElement).className));

    send(snapshot([item(1, { status: 'awaiting-approval', sessions: [session({ state: 'ended' })], approvalReport: 'D:\\wt\\review.md' })]));
    controlNamed(root, 'Approve').click();
    root.querySelector<HTMLAnchorElement>('a.key')!.click();
    controlNamed(root, 'review.md').click();
    root.querySelector<HTMLElement>('[data-item="1"] .title')!.click();
    root.querySelector<HTMLElement>('[data-item="1"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    root.querySelector<HTMLElement>('[data-item="1"] .title')!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    root.querySelector<HTMLElement>('[data-item="1"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    root.querySelector<HTMLElement>('details[data-group="needs"] > summary')!.click();

    // A control or a link runs only its own action, not the row's.
    expect(posted.slice(1)).toEqual([
      { type: 'action', action: { type: 'approve', workItemId: 1 } },
      { type: 'openUrl', url: 'https://github.com/o/r/issues/101' },
      { type: 'openUrl', url: 'D:\\wt\\review.md' },
      { type: 'resume', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', name: 'github 101', active: false },
      { type: 'resume', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', name: 'github 101', active: false },
      { type: 'open', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets' },
      { type: 'open', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets' },
    ]);
    // A link click stops at the panel, so the host does not open the link a second time; other clicks still reach the window.
    expect(reachedWindow).not.toContain('key github');
    expect(reachedWindow).toContain('title');
  });

  it('selects a row on focus, keeps the selection and focus across redraws, and moves the selection on a click in another row', () => {
    send(snapshot([item(1, { status: 'awaiting-approval' }), item(2, { status: 'awaiting-approval' })]));
    const row = (id: number) => root.querySelector<HTMLElement>(`[data-item="${id}"]`)!;

    expect(root.querySelectorAll('.item.selected')).toHaveLength(0);
    expect(row(1).tabIndex).toBe(0);
    row(1).focus();
    expect(row(1).classList.contains('selected')).toBe(true);
    send(snapshot([item(1, { status: 'awaiting-approval' }), item(2, { status: 'awaiting-approval' })]));
    expect(row(1).classList.contains('selected')).toBe(true);
    expect(document.activeElement).toBe(row(1));

    row(2).querySelector<HTMLElement>('.title')!.click();
    expect([...root.querySelectorAll('.item.selected')].map((element) => element.getAttribute('data-item'))).toEqual(['2']);
  });

  it('keeps focus on the same button or link across a redraw, so Enter still acts on it, and falls back to the row when the button is gone', () => {
    const links = [{ id: 2, ticketId: 1, label: 'PR', target: 'https://github.com/o/r/pull/2', reportedAt: NOW }];
    const report = { id: 3, ticketId: 1, label: 'Docs', target: 'https://example.test/docs', reportedAt: NOW };
    send(snapshot([item(1, { status: 'awaiting-approval', sessions: [session({ state: 'ended' })], links: [...links, report] })]));
    const row = () => root.querySelector<HTMLElement>('[data-item="1"]')!;

    controlNamed(row(), 'Approve').focus();
    send(snapshot([item(1, { status: 'awaiting-approval', sessions: [session({ state: 'ended' })], links: [...links, report] })]));
    expect(document.activeElement).toBe(controlNamed(row(), 'Approve'));

    row().querySelector<HTMLElement>('a[href="https://example.test/docs"]')!.focus();
    send(snapshot([item(1, { status: 'awaiting-approval', sessions: [session({ state: 'ended' })], links: [...links, report] })]));
    expect(document.activeElement).toBe(row().querySelector('a[href="https://example.test/docs"]'));

    controlNamed(row(), 'Approve').focus();
    send(snapshot([item(1, { status: 'blocked', sessions: [session({ state: 'ended' })], links })]));
    expect(document.activeElement).toBe(row());
  });

  it('shows clipped text in full in a tooltip on hover, and no tooltip on text that fits', () => {
    send(snapshot([item(1, { status: 'awaiting-approval' })]));
    const title = root.querySelector<HTMLElement>('[data-item="1"] .title')!;
    const hover = () => title.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    Object.defineProperty(title, 'clientWidth', { configurable: true, value: 50 });
    Object.defineProperty(title, 'scrollWidth', { configurable: true, value: 120 });
    hover();
    expect(title.getAttribute('title')).toBe('Issue <1>');
    Object.defineProperty(title, 'scrollWidth', { configurable: true, value: 50 });
    hover();
    expect(title.hasAttribute('title')).toBe(false);

    // A text cut at its cap keeps the whole text as its tooltip, whatever its width.
    send(snapshot([item(1, { status: 'awaiting-approval', approvalSummary: 'x'.repeat(CAPS.approval + 5) })]));
    const approval = root.querySelector<HTMLElement>('[data-item="1"] .approval')!;

    Object.defineProperty(approval, 'clientWidth', { configurable: true, value: 500 });
    Object.defineProperty(approval, 'scrollWidth', { configurable: true, value: 500 });
    approval.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(approval.title).toBe('x'.repeat(CAPS.approval + 5));
  });

  it('selects a row on right-click, so its menu acts on the highlighted row', () => {
    send(snapshot([item(1, { status: 'awaiting-approval' }), item(2, { status: 'awaiting-approval' })]));

    root.querySelector('[data-item="2"] .title')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect([...root.querySelectorAll('.item.selected')].map((element) => element.getAttribute('data-item'))).toEqual(['2']);
    expect(root.querySelector('.more-button, .menu')).toBeNull();
  });

  it('keeps the groups the operator opened or closed across redraws', () => {
    send(snapshot([item(1), item(2, { status: 'done', doneAt: NOW })]));

    const done = root.querySelector<HTMLDetailsElement>('details[data-group="done"]')!;
    done.open = true;
    done.dispatchEvent(new Event('toggle'));
    const working = root.querySelector<HTMLDetailsElement>('details[data-group="working"]')!;
    working.open = false;
    working.dispatchEvent(new Event('toggle'));

    send(snapshot([item(1), item(2, { status: 'done', doneAt: NOW })]));

    expect(root.querySelector<HTMLDetailsElement>('details[data-group="done"]')!.open).toBe(true);
    expect(root.querySelector<HTMLDetailsElement>('details[data-group="working"]')!.open).toBe(false);
  });
});
