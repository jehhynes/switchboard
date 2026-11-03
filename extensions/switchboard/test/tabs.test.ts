import type { Snapshot, WorkItemView } from '@switchboard/hub';
import { describe, expect, it } from 'vitest';
import { ItemTabs, reuseFilter } from '../src/tabs.js';

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
    ticket: { id: 7, source: 'github', sourceKey: '107', ref: '#107', sourceId: null, title: 'Issue 7', url: ISSUE, assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: NOW, repoRoot: '', adhocKey: null, blockers: [] },
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
    sourceStates: [{ name: 'github', enabled: true }],
    namespaces: { github: 'dev' },
    configDir: 'C:\\Users\\me\\.switchboard',
    openVSCode: 'always',
    openTerminal: 'vscode',
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
  it('opens nothing for the first snapshot, then a changed focus and each report a later one adds, but not a link (PRD R72, R79)', async () => {
    const { tracker, opened } = tabs();

    await tracker.update(snapshot([item()]));
    expect(opened).toEqual([]);

    await tracker.update(snapshot([item(pr)]));
    await tracker.update(snapshot([item({ ...pr, focus: REVIEW })]));
    await tracker.update(snapshot([item({ ...pr, focus: REVIEW, ...report })]));
    await tracker.update(snapshot([item({ ...pr, focus: REVIEW, ...report, stage: 'waiting' })]));
    expect(opened).toEqual([REVIEW, REPORT]);
  });

  it('opens a focus again when a later triage changes it back', async () => {
    const { tracker, opened } = tabs();

    await tracker.update(snapshot([item({ focus: COMMENT })]));
    await tracker.update(snapshot([item({ focus: REVIEW })]));
    await tracker.update(snapshot([item({ focus: COMMENT })]));
    expect(opened).toEqual([REVIEW, COMMENT]);
  });

  it('opens a report once, not again when its work item awaits approval again, and a new report when it names one', async () => {
    const { tracker, opened } = tabs();
    const OTHER = 'D:/drafts/reply-2.md';

    await tracker.update(snapshot([item()]));
    await tracker.update(snapshot([item(report)]));
    await tracker.update(snapshot([item({ status: 'running', approvalReport: REPORT })]));
    await tracker.update(snapshot([item(report)]));
    expect(opened).toEqual([REPORT]);

    await tracker.update(snapshot([item({ ...report, approvalReport: OTHER })]));
    await tracker.update(snapshot([item(report)]));
    expect(opened).toEqual([REPORT, OTHER]);
  });

  it('does not open a report openAll opened when its work item awaits approval again, nor one another work item already reported', async () => {
    const { tracker, opened } = tabs();
    const OTHER = 'D:/drafts/reply-2.md';
    const earlier = (patch: Partial<WorkItemView>) => item({ id: 6, focus: null, ...patch });

    await tracker.openAll(snapshot([item(report)]));
    await tracker.update(snapshot([item({ status: 'running', approvalReport: REPORT })]));
    await tracker.update(snapshot([item(report)]));
    expect(opened).toEqual([ISSUE, REPORT]);

    await tracker.update(snapshot([earlier(report), item({ status: 'running', approvalReport: REPORT })]));
    await tracker.update(snapshot([earlier({ ...report, approvalReport: OTHER }), item(report)]));
    expect(opened).toEqual([ISSUE, REPORT, OTHER]);
  });

  it('does not open a report the first snapshot showed when its work item awaits approval again', async () => {
    const { tracker, opened } = tabs();

    await tracker.update(snapshot([item(report)]));
    await tracker.update(snapshot([item({ status: 'running', approvalReport: REPORT })]));
    await tracker.update(snapshot([item(report)]));
    expect(opened).toEqual([]);
  });

  it('opens a work item that joins the window once, and nothing when it leaves the snapshot and returns', async () => {
    const { tracker, opened } = tabs();

    await tracker.update(snapshot([]));
    await tracker.update(snapshot([item({ focus: COMMENT })]));
    await tracker.update(snapshot([]));
    await tracker.update(snapshot([item({ focus: COMMENT })]));
    expect(opened).toEqual([COMMENT]);
  });

  it("opens each work item's own new focus in a shared window, and a focus two of them share once", async () => {
    const { tracker, opened } = tabs();
    const earlier = (patch: Partial<WorkItemView>) => item({ id: 6, status: 'done', ...patch });

    await tracker.update(snapshot([earlier({ focus: COMMENT }), item({ focus: ISSUE })]));
    await tracker.update(snapshot([earlier({ focus: COMMENT }), item({ focus: COMMENT })]));
    expect(opened).toEqual([COMMENT]);

    await tracker.update(snapshot([earlier({ focus: REVIEW }), item({ focus: REVIEW })]));
    expect(opened).toEqual([COMMENT, REVIEW]);
  });

  it('opens every focus and report for the window the dock opened, each once, and afterwards only what changes', async () => {
    const { tracker, opened } = tabs();

    await tracker.update(snapshot([item(report)]));
    await tracker.openAll(snapshot([item({ id: 6, focus: COMMENT }), item({ ...pr, ...report, focus: COMMENT })]));
    expect(opened).toEqual([COMMENT, REPORT]);

    await tracker.update(snapshot([item({ ...pr, ...report, focus: COMMENT })]));
    expect(opened).toHaveLength(2);
  });

  it('opens nothing for a work item with no focus', async () => {
    const { tracker, opened } = tabs();

    await tracker.openAll(snapshot([item({ focus: null })]));
    expect(opened).toEqual([]);
  });

  it('opens every tab before the first snapshot, without opening them again when it arrives', async () => {
    const { tracker, opened } = tabs();

    await tracker.openAll(snapshot([item(pr)]));
    await tracker.update(snapshot([item(pr)]));
    expect(opened).toEqual([ISSUE]);
  });

  it("does nothing in a window that is not an item window, or for another item's window", async () => {
    const folder = tabs(null);

    await folder.tracker.openAll(snapshot([item(pr)]));
    await folder.tracker.update(snapshot([item(pr)]));
    await folder.tracker.update(snapshot([item({ ...pr, ...report, focus: REVIEW })]));
    expect(folder.opened).toEqual([]);

    const other = tabs(`${WINDOWS}\\gh-108-aaaaaa.code-workspace`);

    await other.tracker.openAll(snapshot([item(pr)]));
    await other.tracker.openAll(null);
    expect(other.opened).toEqual([]);
  });

  it('opens the remaining tabs after one fails, then reports the failure', async () => {
    const { tracker, opened } = tabs(FILE, ISSUE);

    await expect(tracker.openAll(snapshot([item({ ...pr, ...report })]))).rejects.toThrow(`cannot open ${ISSUE}`);
    expect(opened).toEqual([ISSUE, REPORT]);
  });
});

describe('reuseFilter', () => {
  it("matches a Zoho Desk ticket link's tab at the agent page Zoho redirects it to", () => {
    expect(reuseFilter('https://desk.zoho.com/support/acme/ShowHomePage.do#Cases/dv/90000000062480627')).toBe('https://desk.zoho.com/agent/*/*/tickets/details/90000000062480627');
  });

  it('keeps any other URL, including a Zoho Desk page that is not a ticket', () => {
    expect(reuseFilter(COMMENT)).toBe(COMMENT);
    expect(reuseFilter('https://desk.zoho.com/support/acme/ShowHomePage.do#Cases')).toBe('https://desk.zoho.com/support/acme/ShowHomePage.do#Cases');
  });
});
