import type { Snapshot, WorkItemView } from '@switchboard/hub';
import { beforeEach, describe, expect, it } from 'vitest';
import { startPanel } from '../src/webview/main.js';
import { age, controlsOf, groupOf, mainControl, renderPanel, statusOf } from '../src/webview/render.js';

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
    ticket: { id, source: 'github', sourceKey: String(100 + id), sourceId: null, title: `Issue <${id}>`, url: `https://github.com/o/r/issues/${100 + id}`, assigned: true, pool: false, iceboxed: false, sortAt: null, lastPolledAt: NOW, repoRoot: '' },
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
  it('shows only the controls that apply', () => {
    expect(labels(item(1, { status: 'awaiting-approval' }))).toEqual(['Approve', 'Triage again', 'Mark done', 'Icebox']);
    expect(labels(item(1, { sessions: [session()] }))).toEqual(['Attach', 'Stop', 'Mark done', 'Icebox']);
    expect(labels(item(1, { sessions: [session({ state: 'starting', shortId: null })] }))).toEqual(['Mark done', 'Icebox']);
    expect(labels(item(1, { status: 'blocked', sessions: [session({ state: 'ended' })] }))).toEqual(['Retry', 'Open in VS Code', 'Triage again', 'Mark done', 'Icebox']);
    expect(labels(item(1, { status: 'triaging' }))).toEqual(['Mark done', 'Icebox']);
    expect(labels(item(1, { status: 'done', sessions: [session({ state: 'ended' })] }))).toEqual(['Open in VS Code']);
    expect(labels(item(1, { status: 'failed', ticket: { ...item(1).ticket, source: 'adhoc' } }))).toEqual(['Retry', 'Mark done', 'Icebox']);
    expect(labels(item(1, { status: 'blocked', sessions: [session({ released: true })] }))).toEqual(['Retry', 'Open in VS Code', 'Mark done', 'Icebox']);
  });

  it('posts the action, attach or open message', () => {
    const [attach, stop] = controlsOf(item(7, { sessions: [session()] }));

    expect(attach?.message).toEqual({ type: 'attach', shortId: 'aaaa1111', name: 'github 107' });
    expect(stop?.message).toEqual({ type: 'action', action: { type: 'stop', workItemId: 7 } });
    expect(controlsOf(item(7, { status: 'done', sessions: [session({ state: 'ended' })] }))[0]?.message).toEqual({ type: 'open', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets' });
  });
});

describe('statusOf and mainControl', () => {
  it('words the status and puts the one main control on a Needs you row', () => {
    expect(statusOf(item(1, { status: 'awaiting-approval' }))).toBe('Awaiting approval');
    expect(statusOf(item(1, { sessions: [session({ state: 'waiting' })] }))).toBe('Waiting on you');
    expect(statusOf(item(1, { status: 'setup', needsPick: true }))).toBe('Claiming');
    expect(['queued', 'running', 'blocked'].map((status) => statusOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['Queued', 'Running', 'Blocked']);

    expect(mainControl(item(1, { status: 'awaiting-approval' }))?.label).toBe('Approve');
    expect(mainControl(item(1, { status: 'failed' }))?.label).toBe('Retry');
    expect(mainControl(item(1, { sessions: [session({ state: 'waiting' })] }))?.label).toBe('Attach');
    expect(mainControl(item(1))).toBeNull();
  });

  it('shows the main control on the collapsed row and not again in the expanded controls', () => {
    const root = document.createElement('div');
    root.innerHTML = renderPanel(snapshot([item(1, { status: 'awaiting-approval' })]), NOW, new Set(), new Set());

    expect([...root.querySelectorAll('summary button.control')].map((b) => b.getAttribute('title'))).toEqual(['Approve']);
    expect([...root.querySelectorAll('.controls button.control')].map((b) => b.getAttribute('title'))).toEqual(['Triage again', 'Mark done', 'Icebox']);
  });
});

describe('renderPanel', () => {
  it('groups rows, escapes text, and shows stage age, notes and errors', () => {
    const html = renderPanel(
      snapshot(
        [
          item(1, { status: 'done', doneAt: NOW }),
          item(2, { status: 'failed', error: 'Workspace not trusted.' }),
          item(3, { stage: 'Planning', stageAt: NOW - 3 * 60_000, sessions: [session()] }),
        ],
        { errors: { settings: 'sessions.concurrency must be a whole number from 1 to 4.', playbooks: ['dev/bad.md: description is required.'], hooks: null, sources: { github: 'The GitHub CLI is not signed in.' } } },
      ),
      NOW,
      new Set([3]),
      new Set(),
    );
    const root = document.createElement('div');
    root.innerHTML = html;

    expect([...root.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Needs you (1)', 'Working (1)', 'Done (1)']);
    expect(root.querySelector('details.item[data-item="3"]')?.hasAttribute('open')).toBe(true);
    expect(root.querySelector('details[data-group="done"]')?.hasAttribute('open')).toBe(false);
    expect(root.querySelector('[data-item="2"] .title')?.textContent).toBe('Issue <2>');
    expect(root.querySelector('[data-item="2"] summary .note')?.textContent).toBe('Workspace not trusted.');
    expect(root.querySelector('[data-item="3"] .stage')?.textContent).toBe('Planning · 3m');
    expect([...root.querySelectorAll('.errors .note')].map((note) => note.textContent?.trim())).toEqual([
      'Settings: sessions.concurrency must be a whole number from 1 to 4.',
      'Playbook dev/bad.md: description is required.',
      'github: The GitHub CLI is not signed in.',
    ]);
    expect([...root.querySelectorAll('form.adhoc option')].map((option) => option.textContent)).toEqual(['D:/git/widgets', 'D:/git/support']);
  });

  it('shows the triage summary, context, prompt and session history when expanded', () => {
    const root = document.createElement('div');
    root.innerHTML = renderPanel(
      snapshot([item(1, { status: 'blocked', taskPrompt: 'Build 101.', triage: { id: 1, ticketId: 1, workItemId: 1, context: 'Issue text', playbook: 'dev:develop', summary: 'A summary.', immediacy: null, severity: null, model: null, startedAt: NOW, endedAt: NOW, error: null }, sessions: [session({ state: 'ended', outcome: 'stopped', outcomeDetail: 'Stopped by you.' })] })]),
      NOW,
      new Set([1]),
      new Set(),
    );

    expect([...root.querySelectorAll('.detail h4')].map((h) => h.textContent)).toEqual(['Summary', 'Triage context', 'Task prompt', 'Sessions']);
    expect(root.querySelector('.detail li')?.textContent).toBe('task s1: ended, stopped (Stopped by you.), started 5m ago');
    expect([...root.querySelectorAll('select.playbook option')].map((option) => option.textContent)).toEqual(['Change playbook…', 'support:defect']);
  });

  it('shows the worktree, and an active session on a done work item', () => {
    const root = document.createElement('div');
    root.innerHTML = renderPanel(
      snapshot([item(1, { status: 'done', doneAt: NOW, sessions: [session()], worktree: { id: 1, ticketId: 1, path: 'D:/git/widgets-wt/101-fix', branch: '101-fix', linkedBy: 'report' } })]),
      NOW,
      new Set(),
      new Set(['done']),
    );

    expect(root.querySelector('summary .worktree')?.textContent?.trim()).toBe('101-fix');
    expect(root.querySelector('summary .worktree')?.getAttribute('title')).toBe('D:/git/widgets-wt/101-fix');
    expect(root.querySelector('summary .status')?.textContent).toBe('Done, session running');
  });

  it('says what an unconfigured home is missing', () => {
    const root = document.createElement('div');
    root.innerHTML = renderPanel(snapshot([], { sources: [], playbooks: [], repoRoots: [] }), NOW, new Set(), new Set());

    expect([...root.querySelectorAll('p.empty')].slice(0, 2).map((p) => p.textContent?.trim())).toEqual([
      'No source is polled. Enable a source in C:\\Users\\me\\.switchboard\\settings.json.',
      'No task playbooks are loaded. Add them under C:\\Users\\me\\.switchboard\\playbooks.',
    ]);
    expect(root.querySelector('form.adhoc button')?.hasAttribute('disabled')).toBe(true);
    expect(renderPanel(snapshot([]), NOW, new Set(), new Set())).not.toContain('No source is polled');
  });

  it('lists the pool with each rating, summary, Returned mark, Pick and Icebox, and Triage again for a failed triage', () => {
    const ticket = (id: number) => ({ id, source: 'zoho', sourceKey: String(500 + id), sourceId: `z${id}`, title: `Case <${id}>`, url: `https://desk.example.test/${id}`, assigned: false, pool: true, iceboxed: false, sortAt: id, lastPolledAt: NOW, repoRoot: '' });
    const triage = (id: number, patch: object) => ({ id, ticketId: id, workItemId: null, context: 'ctx', playbook: 'support:case', summary: 'Fix sync — defect', immediacy: 'BLOCKING' as const, severity: 'MED' as const, model: null, startedAt: NOW, endedAt: NOW, error: null, ...patch });
    const root = document.createElement('div');
    root.innerHTML = renderPanel(
      snapshot([], {
        pool: [
          { ticket: ticket(1), triage: triage(1, {}), returned: 2 },
          { ticket: ticket(2), triage: triage(2, { playbook: null, summary: null, immediacy: null, severity: null, error: 'Timed out.' }), returned: 0 },
          { ticket: ticket(3), triage: null, returned: 0 },
        ],
      }),
      NOW,
      new Set(),
      new Set(),
    );
    const rows = [...root.querySelectorAll('.pool-item')];

    expect([...root.querySelectorAll('h3')].map((h) => h.textContent).at(-1)).toBe('Pool (3)');
    expect(rows.map((row) => row.querySelector('.title')?.textContent)).toEqual(['Case <1>', 'Case <2>', 'Case <3>']);
    expect(rows[0]!.querySelector('.summary')?.textContent).toBe('Fix sync — defect');
    expect(rows[0]!.querySelector('.importance')?.textContent).toBe('BLOCKING/MED');
    expect(rows[0]!.querySelector('.returned')?.textContent).toBe('Returned ×2');
    expect(rows[0]!.querySelector('.returned')?.getAttribute('title')).toBe('2 earlier work items');
    expect([...rows[0]!.querySelectorAll('.line.second button.control')].map((b) => b.getAttribute('title'))).toEqual(['Pick', 'Icebox']);
    expect(rows[0]!.querySelectorAll('.line.second')).toHaveLength(1);
    expect(rows[1]!.querySelector('.importance')).toBeNull();
    expect(rows[1]!.querySelector('.returned')).toBeNull();
    expect(rows[0]!.querySelector('.playbook-name')?.textContent).toBe('support:case');
    expect(JSON.parse(rows[0]!.querySelector<HTMLElement>('button.control[title="Pick"]')!.dataset['message']!)).toEqual({ type: 'action', action: { type: 'pick', ticketId: 1 } });
    expect(rows[1]!.querySelector('.note')?.textContent).toBe('Timed out.');
    expect([...rows[1]!.querySelectorAll('button.control')].map((b) => b.getAttribute('title'))).toEqual(['Triage again', 'Pick', 'Icebox']);
    expect(rows[2]!.querySelector('.summary')?.textContent).toBe('Triaging…');
    expect(renderPanel(snapshot([]), NOW, new Set(), new Set())).not.toContain('Pool (');
  });

  it('moves iceboxed work items and pool tickets into a collapsed Icebox group, and shows an approval summary', () => {
    const icy = item(2, { status: 'awaiting-approval', ticket: { ...item(2).ticket, iceboxed: true } });
    const ready = item(3, { status: 'awaiting-approval', approvalPrompt: '/review-pr pr:123 publish', approvalSummary: 'Review ready to post.' });
    const poolTicket = { id: 9, source: 'zoho', sourceKey: '509', sourceId: 'z9', title: 'Cold case', url: '', assigned: false, pool: true, iceboxed: true, sortAt: 1, lastPolledAt: NOW, repoRoot: '' };
    const root = document.createElement('div');
    root.innerHTML = renderPanel(snapshot([icy, ready], { pool: [{ ticket: poolTicket, triage: null, returned: 0 }] }), NOW, new Set(), new Set());
    const icebox = root.querySelector<HTMLDetailsElement>('details[data-group="icebox"]')!;

    expect([...root.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Needs you (1)', 'Working (0)', 'Done (0)', 'Icebox (2)']);
    expect(icebox.open).toBe(false);
    expect([...icebox.querySelectorAll('.title')].map((t) => t.textContent)).toEqual(['Issue <2>', 'Cold case']);
    expect(JSON.parse(icebox.querySelector<HTMLElement>('button.control[title="Restore"]')!.dataset['message']!)).toEqual({ type: 'action', action: { type: 'restore', ticketId: 2 } });
    expect(root.querySelector('[data-item="3"] .approval')?.textContent).toBe('Review ready to post.');
    expect(renderPanel(snapshot([icy]), NOW, new Set(), new Set(['icebox']))).toContain('data-group="icebox" open');
    expect(labels(item(4, { status: 'done', ticket: { ...item(4).ticket, iceboxed: true } }))).toEqual(['Restore']);
  });

  it('shows the rating, Returned and link badges on a work item, and opens a link through the extension (PRD R50–R52)', () => {
    const rated = item(1, {
      returned: 1,
      triage: { id: 1, ticketId: 1, workItemId: 1, context: 'c', playbook: 'support:case', summary: 's', immediacy: 'URGENT', severity: 'HIGH', model: null, startedAt: NOW, endedAt: NOW, error: null },
      links: [
        { id: 1, ticketId: 1, label: 'PR #12', target: 'https://github.com/o/r/pull/12', reportedAt: NOW },
        { id: 2, ticketId: 1, label: 'case.md', target: 'D:\\cases\\1\\case.md', reportedAt: NOW },
      ],
    });
    const root = document.createElement('div');
    const posted: unknown[] = [];
    startPanel(root, { postMessage: (message) => posted.push(message) }, () => NOW);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', snapshot: snapshot([rated, item(2)]) } }));
    const row = root.querySelector('[data-item="1"]')!;

    expect(row.querySelector('.importance.urgent')?.textContent).toBe('URGENT/HIGH');
    expect(row.querySelector('.returned')?.textContent).toBe('Returned ×1');
    expect([...row.querySelectorAll('a.badge')].map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual([
      ['PR #12', 'https://github.com/o/r/pull/12'],
      ['case.md', 'D:\\cases\\1\\case.md'],
    ]);
    expect(root.querySelector('[data-item="2"] .links')).toBeNull();
    expect(root.querySelector('[data-item="2"] .importance')).toBeNull();

    row.querySelectorAll<HTMLElement>('a.badge')[1]!.click();
    expect(posted.at(-1)).toEqual({ type: 'openUrl', url: 'D:\\cases\\1\\case.md' });
    expect(row.hasAttribute('open')).toBe(false);
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

  it('announces itself, renders each state, and posts clicks', () => {
    expect(posted).toEqual([{ type: 'ready' }]);

    send(snapshot([item(1, { status: 'awaiting-approval' })]));
    root.querySelector<HTMLButtonElement>('button.control[title="Approve"]')!.click();
    root.querySelector<HTMLAnchorElement>('a[href]')!.click();

    expect(posted.slice(1)).toEqual([
      { type: 'action', action: { type: 'approve', workItemId: 1 } },
      { type: 'openUrl', url: 'https://github.com/o/r/issues/101' },
    ]);
  });

  it('posts a playbook change and an ad-hoc prompt, keeping a half-typed prompt across redraws', () => {
    send(snapshot([item(1, { status: 'awaiting-approval' })]));

    const select = root.querySelector<HTMLSelectElement>('select.playbook')!;
    select.value = 'support:defect';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    root.querySelector<HTMLTextAreaElement>('form.adhoc textarea')!.value = 'Write hello.txt';
    root.querySelector<HTMLSelectElement>('form.adhoc select')!.value = 'D:/git/support';
    send(snapshot([item(1, { status: 'awaiting-approval' })]));

    expect(root.querySelector<HTMLTextAreaElement>('form.adhoc textarea')!.value).toBe('Write hello.txt');

    const typing = root.querySelector<HTMLTextAreaElement>('form.adhoc textarea')!;
    typing.focus();
    typing.setSelectionRange(2, 5);
    send(snapshot([item(1, { status: 'awaiting-approval' })]));
    const redrawn = root.querySelector<HTMLTextAreaElement>('form.adhoc textarea')!;

    expect(document.activeElement).toBe(redrawn);
    expect([redrawn.selectionStart, redrawn.selectionEnd]).toEqual([2, 5]);
    expect(root.querySelector<HTMLSelectElement>('form.adhoc select')!.value).toBe('D:/git/support');

    root.querySelector<HTMLFormElement>('form.adhoc')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(posted.slice(1)).toEqual([
      { type: 'action', action: { type: 'change-playbook', workItemId: 1, playbook: 'support:defect' } },
      { type: 'action', action: { type: 'adhoc', prompt: 'Write hello.txt', repoRoot: 'D:/git/support' } },
    ]);
    expect(root.querySelector<HTMLTextAreaElement>('form.adhoc textarea')!.value).toBe('');
  });

  it('keeps the rows the operator expanded and the done group across redraws', () => {
    send(snapshot([item(1), item(2, { status: 'done', doneAt: NOW })]));

    const row = root.querySelector<HTMLDetailsElement>('details.item[data-item="1"]')!;
    row.open = true;
    row.dispatchEvent(new Event('toggle'));
    const done = root.querySelector<HTMLDetailsElement>('details[data-group="done"]')!;
    done.open = true;
    done.dispatchEvent(new Event('toggle'));

    send(snapshot([item(1), item(2, { status: 'done', doneAt: NOW })]));

    expect(root.querySelector<HTMLDetailsElement>('details.item[data-item="1"]')!.open).toBe(true);
    expect(root.querySelector<HTMLDetailsElement>('details[data-group="done"]')!.open).toBe(true);
  });

  it('ignores an empty ad-hoc prompt', () => {
    send(snapshot([]));
    root.querySelector<HTMLFormElement>('form.adhoc')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(posted).toEqual([{ type: 'ready' }]);
  });
});
