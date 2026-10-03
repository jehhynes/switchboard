import type { Snapshot, WorkItemView } from '@switchboard/hub';
import { beforeEach, describe, expect, it } from 'vitest';
import { startPanel } from '../src/webview/main.js';
import { age, controlsOf, groupOf, mainControl, markOf, queueTime, rankOf, renderPanel, sessionControl, unstartedOrder } from '../src/webview/render.js';
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
    createdAt: NOW,
    doneAt: null,
    doneReason: null,
    ticket: { id, source: 'github', sourceKey: String(100 + id), ref: `#${100 + id}`, sourceId: null, title: `Issue <${id}>`, url: `https://github.com/o/r/issues/${100 + id}`, assigned: true, pool: false, iceboxed: false, sortAt: null, lastPolledAt: NOW, repoRoot: '' },
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
    home: 'C:\\Users\\me\\.switchboard',
    errors: { settings: null, playbooks: [], hooks: null, sources: {} },
    ...patch,
  };
}

const labels = (entry: WorkItemView) => controlsOf(entry).map((control) => control.label);

describe('groupOf', () => {
  it('puts done first, then work that needs the operator, then the rest', () => {
    expect(groupOf(item(1, { status: 'done', sessions: [session({ state: 'waiting' })] }))).toBe('done');
    expect(['awaiting-approval', 'blocked', 'failed'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['needs', 'needs', 'needs']);
    expect(groupOf(item(1, { sessions: [session({ state: 'waiting' })] }))).toBe('needs');
    expect(['triaging', 'queued', 'setup', 'running'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['working', 'working', 'working', 'working']);
  });
});

describe('controlsOf', () => {
  it('shows only the controls that apply, with no session controls and no Change playbook', () => {
    expect(labels(item(1, { status: 'unstarted' }))).toEqual(['Start', 'Triage again', 'Mark done', 'Icebox']);
    expect(labels(item(1, { status: 'awaiting-approval' }))).toEqual(['Approve', 'Triage again', 'Mark done', 'Icebox']);
    expect(labels(item(1, { sessions: [session()] }))).toEqual(['Stop', 'Mark done', 'Icebox']);
    expect(labels(item(1, { sessions: [session({ state: 'starting', shortId: null })] }))).toEqual(['Mark done', 'Icebox']);
    expect(labels(item(1, { status: 'blocked', sessions: [session({ state: 'ended' })] }))).toEqual(['Retry', 'Triage again', 'Mark done', 'Icebox']);
    expect(labels(item(1, { status: 'triaging' }))).toEqual(['Mark done', 'Icebox']);
    expect(labels(item(1, { status: 'done', sessions: [session({ state: 'ended' })] }))).toEqual([]);
    expect(labels(item(1, { status: 'failed', ticket: { ...item(1).ticket, source: 'adhoc' } }))).toEqual(['Retry', 'Mark done', 'Icebox']);
    expect(labels(item(1, { status: 'blocked', sessions: [session({ released: true })] }))).toEqual(['Retry', 'Mark done', 'Icebox']);
    expect(controlsOf(item(7, { sessions: [session()] }))[0]?.message).toEqual({ type: 'action', action: { type: 'stop', workItemId: 7 } });
  });
});

describe('sessionControl', () => {
  const control = (sessions: ReturnType<typeof session>[]) => sessionControl(item(7, { sessions }));

  it('attaches to a background session, opens any other latest session in VS Code, and names the state', () => {
    expect(control([])).toBeNull();
    expect(control([session()])).toEqual({ state: 'running', title: 'Session running. Attach', message: { type: 'attach', shortId: 'aaaa1111', name: 'github 107' } });
    expect(control([session({ state: 'waiting' })])?.state).toBe('waiting');
    expect(control([session({ state: 'idle', released: true })])).toEqual({ state: 'idle', title: 'Session idle. Open in VS Code', message: { type: 'open', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets' } });
    expect(control([session({ state: 'failed' })])?.state).toBe('failed');
    expect(control([session({ state: 'ended' })])).toEqual({ state: null, title: 'No active session. Open in VS Code', message: { type: 'open', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets' } });
    expect(control([session({ state: 'starting', shortId: null, nativeSessionId: null })])).toEqual({ state: 'running', title: 'Session running', message: null });
  });
});


const ui = (patch: Partial<PanelUi> = {}): PanelUi => ({ groups: new Map(), menu: null, ...patch });

const render = (data: Snapshot, patch: Partial<PanelUi> = {}) => {
  const root = document.createElement('div');
  root.innerHTML = renderPanel(data, NOW, ui(patch));
  return root;
};

const titles = (scope: Element, selector: string) => [...scope.querySelectorAll(selector)].map((element) => element.getAttribute('title'));

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
    expect(mark({ sessions: [session({ state: 'waiting' })] })).toEqual(['comment-discussion', 'Answer a question', null]);
    expect(mark({ status: 'blocked', error: 'Which account should I use?' })).toEqual(['comment-discussion', 'Answer a question', null]);
    expect(mark({ status: 'blocked', error: 'Needs VPN access.' })).toEqual(['debug-pause', 'Blocked', null]);
    expect(mark({ status: 'failed', error: 'exit 1' })).toEqual(['error', 'Failed', 'error']);
  });

  it('shows the phase in Working and how it ended in Done', () => {
    expect(mark({ status: 'triaging' })).toEqual(['search', 'Triaging', null]);
    expect(mark({ status: 'queued' })).toEqual(['clock', 'Queued', null]);
    expect(mark({ status: 'setup', needsPick: true })).toEqual(['tools', 'Claiming', null]);
    expect(mark({ status: 'setup' })).toEqual(['tools', 'Setting up', null]);
    expect(mark({ status: 'running' })).toEqual(['sync codicon-modifier-spin', 'Running', null]);
    expect(mark({ status: 'done', doneReason: 'session' })).toEqual(['check', 'Finished by the session', null]);
    expect(mark({ status: 'done', doneReason: 'operator' })).toEqual(['account', 'Marked done', null]);
    expect(mark({ status: 'done', doneReason: 'unassigned' })).toEqual(['warning', 'Left without a done report', 'warning']);
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

    expect([...root.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Needs you (1)', 'Working (1)', 'Unstarted (0)', 'Done (1)']);
    expect([...root.querySelectorAll<HTMLDetailsElement>('details.group')].map((group) => [group.dataset['group'], group.open])).toEqual([
      ['needs', true],
      ['working', true],
      ['unstarted', true],
      ['done', false],
    ]);
    expect(root.querySelector('[data-group="unstarted"] p.empty')?.textContent).toBe('Nothing waits to be started.');
    expect(root.querySelector('details.item, details:not(.group), .detail')).toBeNull();
    expect(root.querySelector('[data-item="2"] .title')?.textContent).toBe('Issue <2>');
    expect(root.querySelector('[data-item="2"] .line.second .note')?.textContent).toBe('Workspace not trusted.');
    expect(root.querySelector('[data-item="2"] .line.second .note')?.getAttribute('title')).toBe('Workspace not trusted.');
    expect(root.querySelectorAll('[data-item="3"] .line')).toHaveLength(2);
    // No status text: the group and the mark say it, and the mark's tooltip names it.
    expect(root.querySelector('.status')).toBeNull();
    expect([...root.querySelectorAll('.item')].map((row) => row.textContent).join(' ')).not.toMatch(/Failed|Running|Finished/);
    expect(titles(root, '[data-item="3"] .mark')).toEqual(['Running']);
    // A row with nothing more to say keeps its second line, holding only the playbook.
    expect(root.querySelector('[data-item="1"] .line.second')?.textContent).toBe('dev:develop');
    expect(root.querySelector('[data-item="2"] .mark.codicon-error.error')?.getAttribute('title')).toBe('Failed');
    expect(root.querySelector('[data-item="3"] .stage')?.textContent).toBe('Planning · 3m');
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

  it('shows only the primary control and the session button, with the other controls behind the ... menu', () => {
    const closed = render(snapshot([item(1, { status: 'awaiting-approval' }), item(2)]));

    expect(titles(closed, '[data-item="1"] button.control')).toEqual(['Approve']);
    expect(titles(closed, '[data-item="1"] .actions > button.control')).toEqual(['Approve']);
    expect(titles(closed, '[data-item="1"] button.more-button')).toEqual(['More actions']);
    expect(closed.querySelector('.menu')).toBeNull();
    expect(titles(closed, '[data-item="2"] button.control')).toEqual([]);

    const running = render(snapshot([item(4, { status: 'blocked', sessions: [session({ state: 'waiting' })] })]));
    const sessionButton = running.querySelector<HTMLElement>('[data-item="4"] button.session-button')!;

    expect(titles(running, '[data-item="4"] .actions > button.control')).toEqual(['Retry', 'Session waiting. Attach']);
    expect(sessionButton.querySelector('.state-dot.waiting')).not.toBeNull();
    expect(JSON.parse(sessionButton.dataset['message']!)).toEqual({ type: 'attach', shortId: 'aaaa1111', name: 'github 104' });
    expect(render(snapshot([item(5, { status: 'blocked', sessions: [session({ state: 'ended' })] })])).querySelector('[data-item="5"] button.session-button .state-dot')).toBeNull();
    expect(render(snapshot([item(6, { status: 'triaging' })])).querySelector('[data-item="6"] button.session-button')).toBeNull();
    expect(render(snapshot([item(7, { sessions: [session({ state: 'starting', shortId: null, nativeSessionId: null })] })])).querySelector<HTMLButtonElement>('[data-item="7"] button.session-button')!.disabled).toBe(true);

    const open = render(snapshot([item(1, { status: 'awaiting-approval' })]), { menu: 'item:1' });

    expect(titles(open, '.menu button.control')).toEqual(['Triage again', 'Mark done', 'Icebox']);
    expect(open.querySelector('.menu select')).toBeNull();
    expect(render(snapshot([item(3, { status: 'done', doneAt: NOW })]), { groups: new Map([['done', true]]) }).querySelector('[data-item="3"] .more')).toBeNull();
  });

  it('shows no triage summary, triage context, task prompt or session history', () => {
    const root = render(snapshot([item(1, { status: 'blocked', taskPrompt: 'Build 101.', triage: triage({ summary: 'A summary.', context: 'Issue text' }), sessions: [session({ state: 'ended', outcome: 'stopped', outcomeDetail: 'Stopped by you.' })] })]));

    for (const hidden of ['A summary.', 'Issue text', 'Build 101.', 'Stopped by you.']) {
      expect(root.textContent).not.toContain(hidden);
    }
  });

  it('shows the worktree as an icon, the time in queue, and an active session on a done work item', () => {
    const root = render(
      snapshot([item(1, { status: 'done', createdAt: NOW - 3 * 86_400_000, doneAt: NOW - 86_400_000, sessions: [session()], worktree: { id: 1, ticketId: 1, path: 'D:/git/widgets-wt/101-fix', branch: '101-fix', linkedBy: 'report' } })]),
      { groups: new Map([['done', true]]) },
    );

    expect(root.querySelector('.worktree.codicon-git-branch')?.textContent).toBe('');
    expect(root.querySelector('.worktree')?.getAttribute('title')).toBe('101-fix\nD:/git/widgets-wt/101-fix');
    expect(titles(root, '[data-item="1"] .mark')).toEqual(['Finished by the session']);
    expect(root.querySelector('[data-item="1"] .session-button .state-dot.running')).not.toBeNull();
    // A done item stops its clock when it ends.
    expect(root.querySelector('[data-item="1"] .queue')?.textContent).toBe('2d');
  });

  it('says what an unconfigured home is missing', () => {
    const root = render(snapshot([], { sources: [], playbooks: [], repoRoots: [] }));

    expect([...root.querySelectorAll('p.empty')].slice(0, 2).map((p) => p.textContent?.trim())).toEqual([
      'No source is polled. Enable a source in C:\\Users\\me\\.switchboard\\settings.json.',
      'No task playbooks are loaded. Add them under C:\\Users\\me\\.switchboard\\playbooks.',
    ]);
    expect(renderPanel(snapshot([]), NOW, ui())).not.toContain('No source is polled');
  });

  it('lists pool tickets in Unstarted as Unclaimed with a priority dot, time in queue, Returned mark and Start, with Icebox in the menu and no summary', () => {
    const ticket = (id: number) => ({ id, source: 'zoho', sourceKey: String(500 + id), ref: `#${500 + id}`, sourceId: `z${id}`, title: `Case <${id}>`, url: `https://desk.example.test/${id}`, assigned: false, pool: true, iceboxed: false, sortAt: NOW - id * 3_600_000, lastPolledAt: NOW, repoRoot: '' });
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
      { menu: 'ticket:4' },
    );
    // Rank 1, then rank 2 with the unrated ones counted as 2, oldest first, then rank 3.
    const rows = [...root.querySelectorAll('.pool-item')];
    const byId = (id: number) => root.querySelector(`.pool-item[data-ticket="${id}"]`)!;

    expect(root.querySelector('[data-group="unstarted"] h3')?.textContent).toBe('Unstarted (5)');
    expect(rows.map((row) => row.getAttribute('data-ticket'))).toEqual(['1', '5', '4', '2', '3']);
    expect([1, 2, 3, 4, 5].map((id) => byId(id).querySelector('.mark .priority')?.className)).toEqual(['priority high', 'priority medium', 'priority low', undefined, undefined]);
    expect(byId(1).querySelector('.priority')?.getAttribute('title')).toBe('Priority high: URGENT/MED');
    // An unrated row keeps the empty mark slot, so its key lines up.
    expect(byId(4).querySelector('.mark')?.innerHTML).toBe('');
    expect(rows.map((row) => row.querySelector('.line.second .tag')?.textContent)).toEqual(['Unclaimed', 'Unclaimed', 'Unclaimed', 'Unclaimed', 'Unclaimed']);
    expect(titles(byId(1), '.line.second .actions > button.control.icon-button')).toEqual(['Start']);
    expect(byId(1).querySelector('.line:first-child .actions')).toBeNull();
    expect(byId(1).querySelector('.line.second .meta > .playbook-name:first-child')?.textContent).toBe('support:case');
    expect(byId(1).querySelector('.line:first-child .playbook-name')).toBeNull();
    expect(byId(1).querySelector('button.icon-button')?.textContent).toBe('');
    expect(root.textContent).not.toContain('URGENT/MED');
    expect(byId(1).querySelector('.queue')?.textContent).toBe('1h');
    expect(root.textContent).not.toContain('Fix sync — defect');
    expect(byId(1).querySelector('.returned')?.textContent).toBe('Returned ×2');
    expect(byId(1).querySelector('.returned')?.getAttribute('title')).toBe('2 earlier work items');
    expect(byId(2).querySelector('.returned')).toBeNull();
    expect(byId(1).querySelector('.playbook-name')?.textContent).toBe('support:case');
    expect([byId(1).querySelector('.playbook-name .namespace')?.textContent, byId(1).querySelector('.playbook-name .name')?.textContent]).toEqual(['support:', 'case']);
    expect(titles(byId(1), 'button.control')).toEqual(['Start']);
    expect(JSON.parse(byId(1).querySelector<HTMLElement>('button.control[title="Start"]')!.dataset['message']!)).toEqual({ type: 'action', action: { type: 'pick', ticketId: 1 } });
    expect(byId(4).querySelector('.note')?.textContent).toBe('Timed out.');
    expect(titles(byId(4), '.actions > button.control')).toEqual(['Triage again']);
    expect(titles(byId(4), '.menu button.control')).toEqual(['Start', 'Icebox']);
    expect(titles(byId(5), '.mark.codicon-search')).toEqual(['Triaging']);
    expect(byId(5).textContent).not.toContain('Triaging');
    expect(byId(1).querySelector('.playbook-name')?.getAttribute('title')).toBe('support:case');
    expect(root.textContent).not.toContain('Pick');
  });

  it('puts unstarted work items in Unstarted as Assigned with Start, ordered with the pool by importance then age, and Approve only on an approval report', () => {
    const rated = (immediacy: Triage['immediacy'], severity: Triage['severity']) => triage({ immediacy, severity, summary: 'Build it.' });
    const assigned = item(1, { status: 'unstarted', createdAt: NOW - 5 * 3_600_000, triage: rated('BLOCKING', 'HIGH') });
    const unrated = item(2, { status: 'unstarted', createdAt: NOW - 9 * 3_600_000 });
    const ticket = { id: 9, source: 'forum', sourceKey: '509', ref: 'T509', sourceId: null, title: 'Topic', url: '', assigned: false, pool: true, iceboxed: false, sortAt: NOW - 3_600_000, lastPolledAt: NOW, repoRoot: '' };
    const pool = [{ ticket, triage: rated('NON-BLOCKING', 'HIGH'), returned: 0 }];
    const root = render(snapshot([assigned, unrated, item(3, { status: 'awaiting-approval', approvalPrompt: '/publish' })], { pool }));
    const unstarted = root.querySelector('[data-group="unstarted"]')!;

    expect(unstartedOrder([assigned, unrated], pool).map((entry) => entry.ticket.id)).toEqual([1, 2, 9]);
    expect([...unstarted.querySelectorAll('.item')].map((row) => row.getAttribute('data-item') ?? `ticket ${row.getAttribute('data-ticket')}`)).toEqual(['1', '2', 'ticket 9']);
    expect(unstarted.querySelector('h3')?.textContent).toBe('Unstarted (3)');
    expect(unstarted.querySelector('[data-item="1"] .tag')).toBeNull();
    expect(unstarted.textContent).not.toContain('Assigned');
    expect(unstarted.textContent).not.toContain('Build it.');
    expect(unstarted.querySelector('[data-item="1"] .mark .priority.high')).not.toBeNull();
    expect(unstarted.querySelector('[data-item="1"] .title .priority')).toBeNull();
    expect(titles(unstarted, '[data-item="1"] .actions > button.control')).toEqual(['Start']);
    expect(JSON.parse(unstarted.querySelector<HTMLElement>('[data-item="1"] button.control[title="Start"]')!.dataset['message']!)).toEqual({ type: 'action', action: { type: 'start', workItemId: 1 } });
    expect(titles(root, '[data-group="needs"] .actions > button.control')).toEqual(['Approve']);
    expect(labels(item(4, { status: 'unstarted' }))).not.toContain('Approve');
  });

  it('moves iceboxed work items and pool tickets into a collapsed Icebox group with their own marks, and shows an approval summary', () => {
    const icy = item(2, { status: 'unstarted', ticket: { ...item(2).ticket, iceboxed: true } });
    const ready = item(3, { status: 'awaiting-approval', approvalPrompt: '/review-pr pr:123 publish', approvalSummary: 'Review ready to post.' });
    const poolTicket = { id: 9, source: 'zoho', sourceKey: '509', ref: '#509', sourceId: 'z9', title: 'Cold case', url: '', assigned: false, pool: true, iceboxed: true, sortAt: 1, lastPolledAt: NOW, repoRoot: '' };
    const data = snapshot([icy, ready], { pool: [{ ticket: poolTicket, triage: null, returned: 0 }] });
    const root = render(data, { menu: 'item:2' });
    const icebox = root.querySelector<HTMLDetailsElement>('details[data-group="icebox"]')!;

    expect([...root.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Needs you (1)', 'Working (0)', 'Unstarted (0)', 'Done (0)', 'Icebox (2)']);
    expect(icebox.open).toBe(false);
    expect([...icebox.querySelectorAll('.title')].map((t) => t.textContent)).toEqual(['Issue <2>', 'Cold case']);
    expect(icebox.querySelectorAll('.mark .priority')).toHaveLength(0);
    expect(icebox.querySelector('.mark.codicon')).toBeNull();
    expect(titles(root, '[data-item="3"] .mark')).toEqual(['Approve the publish']);
    expect(JSON.parse(icebox.querySelector<HTMLElement>('.menu button.control[title="Restore"]')!.dataset['message']!)).toEqual({ type: 'action', action: { type: 'restore', ticketId: 2 } });
    expect(root.querySelector('[data-item="3"] .approval')?.textContent).toBe('Review ready to post.');
    expect(render(data, { groups: new Map([['icebox', true]]) }).querySelector<HTMLDetailsElement>('details[data-group="icebox"]')!.open).toBe(true);
    expect(labels(item(4, { status: 'done', ticket: { ...item(4).ticket, iceboxed: true } }))).toEqual(['Restore']);
  });

  it('shows a red or orange priority dot, Returned and link badges on a work item (PRD R50–R52)', () => {
    const rated = item(1, {
      returned: 1,
      triage: triage({ playbook: 'support:case', immediacy: 'URGENT', severity: 'HIGH' }),
      links: [
        { id: 1, ticketId: 1, label: 'PR #12', target: 'https://github.com/o/r/pull/12', reportedAt: NOW },
        { id: 2, ticketId: 1, label: 'case.md', target: 'D:\\cases\\1\\case.md', reportedAt: NOW },
      ],
    });
    const root = render(snapshot([rated, item(2, { triage: triage({ immediacy: 'NON-BLOCKING', severity: 'HIGH' }) }), item(3, { triage: triage({ immediacy: 'NON-BLOCKING', severity: 'LOW' }) })]));
    const row = root.querySelector('[data-item="1"]')!;

    expect(row.querySelector('.title .priority.high')?.getAttribute('title')).toBe('Priority high: URGENT/HIGH');
    expect(root.querySelector('[data-item="2"] .title .priority.medium')).not.toBeNull();
    expect(root.querySelector('[data-item="3"] .priority')).toBeNull();
    expect(row.querySelector('.returned')?.textContent).toBe('Returned ×1');
    expect([...row.querySelectorAll('a.badge')].map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual([
      ['PR #12', 'https://github.com/o/r/pull/12'],
      ['case.md', 'D:\\cases\\1\\case.md'],
    ]);
    expect(root.querySelector('[data-item="2"] a.badge')).toBeNull();
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

  it('announces itself, renders each state, and posts clicks, link opens and the session button', () => {
    expect(posted).toEqual([{ type: 'ready' }]);

    send(snapshot([item(1, { status: 'awaiting-approval', sessions: [session({ state: 'ended' })], links: [{ id: 2, ticketId: 1, label: 'case.md', target: 'D:\\cases\\1\\case.md', reportedAt: NOW }] })]));
    root.querySelector<HTMLButtonElement>('button.control[title="Approve"]')!.click();
    root.querySelector<HTMLAnchorElement>('a.key')!.click();
    root.querySelector<HTMLAnchorElement>('a.badge')!.click();
    root.querySelector<HTMLButtonElement>('button.session-button')!.click();

    expect(posted.slice(1)).toEqual([
      { type: 'action', action: { type: 'approve', workItemId: 1 } },
      { type: 'openUrl', url: 'https://github.com/o/r/issues/101' },
      { type: 'openUrl', url: 'D:\\cases\\1\\case.md' },
      { type: 'open', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets' },
    ]);
  });

  it('opens and closes the ... menu, keeps it across redraws, and closes it after an action or a click elsewhere', () => {
    send(snapshot([item(1, { status: 'awaiting-approval' })]));
    const more = () => root.querySelector<HTMLButtonElement>('button.more-button')!;

    more().click();
    expect(root.querySelector('.menu')).not.toBeNull();
    send(snapshot([item(1, { status: 'awaiting-approval' })]));
    expect(root.querySelector('.menu')).not.toBeNull();

    root.querySelector<HTMLButtonElement>('.menu button.control[title="Mark done"]')!.click();
    expect(root.querySelector('.menu')).toBeNull();

    more().click();
    more().click();
    expect(root.querySelector('.menu')).toBeNull();

    // A click on a group heading closes the menu and still toggles the group.
    more().click();
    root.querySelector<HTMLElement>('details[data-group="working"] > summary')!.click();
    expect(root.querySelector('.menu')).toBeNull();
    expect(root.querySelector<HTMLDetailsElement>('details[data-group="working"]')!.open).toBe(false);

    expect(posted.slice(1)).toEqual([
      { type: 'action', action: { type: 'mark-done', workItemId: 1 } },
    ]);
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
