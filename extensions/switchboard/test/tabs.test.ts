import type { Snapshot, WorkItemView } from '@switchboard/hub';
import { describe, expect, it } from 'vitest';
import { ItemTabs } from '../src/tabs.js';

const NOW = Date.UTC(2026, 9, 9, 12);
const WINDOWS = 'C:\\Users\\me\\.switchboard\\windows';
const WORKTREE = 'D:/git/widgets/.worktrees/107-fix';
const FILE = `${WINDOWS}\\gh-107-58c609.code-workspace`;
const ISSUE = 'https://github.com/o/r/issues/107';
const PR = 'https://github.com/o/r/pull/19002';
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
    parent: null,
    approvalSends: false,
    waits: [],
    ticket: { id: 7, source: 'github', sourceKey: '107', ref: '#107', sourceId: null, title: 'Issue 7', url: ISSUE, assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: NOW, repoRoot: '' },
    triage: null,
    sessions: [],
    worktree: { id: 1, ticketId: 7, path: WORKTREE, branch: '107-fix', linkedBy: 'report' },
    links: [],
    returned: 0,
    ...patch,
  };
}

const pr = { links: [{ id: 1, ticketId: 7, label: 'PR', target: PR, reportedAt: NOW }] };
const report = { status: 'awaiting-approval' as const, approvalReport: REPORT };

function snapshot(items: WorkItemView[]): Snapshot {
  return {
    workItems: items,
    pool: [],
    playbooks: [],
    repoRoots: [],
    sources: ['github'],
    sourceStates: [{ name: 'github', enabled: true }],
    namespaces: { github: 'dev' },
    configDir: 'C:\\Users\\me\\.switchboard',
    errors: { settings: null, playbooks: [], hooks: null, sources: {} },
  };
}

function tabs(file: string | null = FILE, fail: string | null = null) {
  const opened: string[] = [];
  const tracker = new ItemTabs(file, WINDOWS, async (target) => {
    opened.push(target);

    if (target === fail) {
      throw new Error(`cannot open ${target}`);
    }
  });

  return { tracker, opened };
}

describe('ItemTabs', () => {
  it('opens nothing for the first snapshot, then each pull request and report a later one adds', async () => {
    const { tracker, opened } = tabs();

    await tracker.update(snapshot([item()]));
    expect(opened).toEqual([]);

    await tracker.update(snapshot([item(pr)]));
    await tracker.update(snapshot([item({ ...pr, ...report })]));
    await tracker.update(snapshot([item({ ...pr, ...report, stage: 'waiting' })]));
    expect(opened).toEqual([PR, REPORT]);
  });

  it('opens a report again when its work item awaits approval again', async () => {
    const { tracker, opened } = tabs();

    await tracker.update(snapshot([item(report)]));
    await tracker.update(snapshot([item({ status: 'running', approvalReport: REPORT })]));
    await tracker.update(snapshot([item(report)]));
    expect(opened).toEqual([REPORT]);
  });

  it('does not open a ticket or pull request again when it leaves the snapshot and returns', async () => {
    const { tracker, opened } = tabs();

    await tracker.update(snapshot([]));
    await tracker.update(snapshot([item(pr)]));
    await tracker.update(snapshot([]));
    await tracker.update(snapshot([item(pr)]));
    expect(opened).toEqual([ISSUE, PR]);
  });

  it('opens every tab for the window the dock opened, and afterwards only what is added', async () => {
    const { tracker, opened } = tabs();

    await tracker.update(snapshot([item(report)]));
    await tracker.openAll(snapshot([item({ ...pr, ...report })]));
    expect(opened).toEqual([ISSUE, PR, REPORT]);

    await tracker.update(snapshot([item({ ...pr, ...report })]));
    expect(opened).toHaveLength(3);
  });

  it('opens every tab before the first snapshot, without opening them again when it arrives', async () => {
    const { tracker, opened } = tabs();

    await tracker.openAll(snapshot([item(pr)]));
    await tracker.update(snapshot([item(pr)]));
    expect(opened).toEqual([ISSUE, PR]);
  });

  it("does nothing in a window that is not an item window, or for another item's window", async () => {
    const folder = tabs(null);

    await folder.tracker.openAll(snapshot([item(pr)]));
    await folder.tracker.update(snapshot([item(pr)]));
    await folder.tracker.update(snapshot([item({ ...pr, ...report })]));
    expect(folder.opened).toEqual([]);

    const other = tabs(`${WINDOWS}\\gh-108-aaaaaa.code-workspace`);

    await other.tracker.openAll(snapshot([item(pr)]));
    await other.tracker.openAll(null);
    expect(other.opened).toEqual([]);
  });

  it('opens the remaining tabs after one fails, then reports the failure', async () => {
    const { tracker, opened } = tabs(FILE, ISSUE);

    await expect(tracker.openAll(snapshot([item({ ...pr, ...report })]))).rejects.toThrow(`cannot open ${ISSUE}`);
    expect(opened).toEqual([ISSUE, PR, REPORT]);
  });
});
