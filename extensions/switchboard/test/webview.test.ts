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
    createdAt: NOW,
    doneAt: null,
    doneReason: null,
    ticket: { id, source: 'github', sourceKey: String(100 + id), sourceId: null, title: `Issue <${id}>`, url: `https://github.com/o/r/issues/${100 + id}`, assigned: true, lastPolledAt: NOW, repoRoot: '' },
    triage: null,
    sessions: [],
    worktree: null,
    ...patch,
  };
}

function snapshot(items: WorkItemView[], patch: Partial<Snapshot> = {}): Snapshot {
  return {
    workItems: items,
    playbooks: [
      { name: 'dev:develop', description: 'Build it' },
      { name: 'support:defect', description: 'Research a defect' },
    ],
    repoRoots: ['D:/git/widgets', 'D:/git/support'],
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
    expect(labels(item(1, { status: 'awaiting-approval' }))).toEqual(['Approve', 'Triage again', 'Mark done']);
    expect(labels(item(1, { sessions: [session()] }))).toEqual(['Attach', 'Stop', 'Mark done']);
    expect(labels(item(1, { sessions: [session({ state: 'starting', shortId: null })] }))).toEqual(['Mark done']);
    expect(labels(item(1, { status: 'blocked', sessions: [session({ state: 'ended' })] }))).toEqual(['Retry', 'Open in VS Code', 'Triage again', 'Mark done']);
    expect(labels(item(1, { status: 'triaging' }))).toEqual(['Mark done']);
    expect(labels(item(1, { status: 'done', sessions: [session({ state: 'ended' })] }))).toEqual(['Open in VS Code']);
    expect(labels(item(1, { status: 'failed', ticket: { ...item(1).ticket, source: 'adhoc' } }))).toEqual(['Retry', 'Mark done']);
    expect(labels(item(1, { status: 'blocked', sessions: [session({ released: true })] }))).toEqual(['Retry', 'Open in VS Code', 'Mark done']);
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
    expect(['queued', 'running', 'blocked'].map((status) => statusOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['Queued', 'Running', 'Blocked']);

    expect(mainControl(item(1, { status: 'awaiting-approval' }))?.label).toBe('Approve');
    expect(mainControl(item(1, { status: 'failed' }))?.label).toBe('Retry');
    expect(mainControl(item(1, { sessions: [session({ state: 'waiting' })] }))?.label).toBe('Attach');
    expect(mainControl(item(1))).toBeNull();
  });

  it('shows the main control on the collapsed row and not again in the expanded controls', () => {
    const root = document.createElement('div');
    root.innerHTML = renderPanel(snapshot([item(1, { status: 'awaiting-approval' })]), NOW, new Set(), false);

    expect([...root.querySelectorAll('summary button.control')].map((b) => b.getAttribute('title'))).toEqual(['Approve']);
    expect([...root.querySelectorAll('.controls button.control')].map((b) => b.getAttribute('title'))).toEqual(['Triage again', 'Mark done']);
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
      false,
    );
    const root = document.createElement('div');
    root.innerHTML = html;

    expect([...root.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Needs you (1)', 'Working (1)', 'Done (1)']);
    expect(root.querySelector('details.item[data-item="3"]')?.hasAttribute('open')).toBe(true);
    expect(root.querySelector('details.done')?.hasAttribute('open')).toBe(false);
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
      snapshot([item(1, { status: 'blocked', taskPrompt: 'Build 101.', triage: { id: 1, workItemId: 1, context: 'Issue text', playbook: 'dev:develop', summary: 'A summary.', model: null, startedAt: NOW, endedAt: NOW, error: null }, sessions: [session({ state: 'ended', outcome: 'stopped', outcomeDetail: 'Stopped by you.' })] })]),
      NOW,
      new Set([1]),
      false,
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
      true,
    );

    expect(root.querySelector('summary .worktree')?.textContent?.trim()).toBe('101-fix');
    expect(root.querySelector('summary .worktree')?.getAttribute('title')).toBe('D:/git/widgets-wt/101-fix');
    expect(root.querySelector('summary .status')?.textContent).toBe('Done, session running');
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
    const done = root.querySelector<HTMLDetailsElement>('details.done')!;
    done.open = true;
    done.dispatchEvent(new Event('toggle'));

    send(snapshot([item(1), item(2, { status: 'done', doneAt: NOW })]));

    expect(root.querySelector<HTMLDetailsElement>('details.item[data-item="1"]')!.open).toBe(true);
    expect(root.querySelector<HTMLDetailsElement>('details.done')!.open).toBe(true);
  });

  it('ignores an empty ad-hoc prompt', () => {
    send(snapshot([]));
    root.querySelector<HTMLFormElement>('form.adhoc')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(posted).toEqual([{ type: 'ready' }]);
  });
});
