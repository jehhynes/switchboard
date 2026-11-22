import { describe, expect, it } from 'vitest';
import { groupOf, PERMISSION_PROMPT, START_PROMPT } from '@switchboard/core/group';
import {
  ANSWER_IN_TERMINAL,
  clockOf,
  controlsOf,
  listGroups,
  moveControls,
  doneBand,
  doneSince,
  doneStamp,
  mainControl,
  openQuestion,
  poolControls,
  priorityTitle,
  queueTime,
  rankOf,
  rowTime,
  setupNotes,
  snapshotErrors,
  startPromptText,
  stripeOf,
  waitTexts,
  limitTexts,
  limitTime,
} from '../src/rows.js';
import type { WorkItemView } from '../src/runtime.js';
import { item, NOW, pool, session, snapshot, triage } from './views.js';

const labels = (entry: WorkItemView) => controlsOf(entry).map((control) => control.label);

describe('unconfirmed start recovery controls', () => {
  it('offers Stop for a warned ordinary start, including a done item, and keeps Delete unavailable until it ends', () => {
    for (const status of ['running', 'done'] as const) {
      const entry = item(1, { status, warning: status === 'done' ? null : 'Unconfirmed start', sessions: [session({ provider: 'claude', state: 'starting', nativeSessionId: null, shortId: null, stateDetail: 'Unconfirmed start' })] });
      expect(controlsOf(entry).find(control => control.label === 'Stop')).toEqual({ label: 'Stop', icon: 'debug-stop', message: { type: 'action', action: { type: 'stop', workItemId: 1 } }, confirm: { question: 'Recheck this start?', detail: 'Only an overdue start with no matching session can be cleared without stopping a process. Resolve duplicate sessions in claude agents first. Inspect it before retrying.', action: 'Stop' } });
      expect(labels(entry)).not.toContain('Delete');
    }
  });

  it('does not offer local clearing for an ordinary in-flight start without recovery detail', () => {
    expect(labels(item(1, { warning: 'Unrelated warning', sessions: [session({ state: 'starting', nativeSessionId: null, shortId: null, stateDetail: null })] }))).not.toContain('Stop');
  });
});

describe('groupOf', () => {
  it('puts done first, then unstarted, triaging and queued work, then ready work, then work blocked on the operator, then the rest', () => {
    expect(groupOf(item(1, { status: 'done', sessions: [session({ state: 'waiting' })] }))).toBe('done');
    expect(['unstarted', 'triaging', 'queued'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['unstarted', 'unstarted', 'unstarted']);
    expect(['blocked', 'failed'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['blocked', 'blocked']);
    expect(groupOf(item(1, { status: 'failed', triage: triage({ error: 'Timed out.' }) }))).toBe('unstarted');
    expect(groupOf(item(1, { sessions: [session({ state: 'waiting' })] }))).toBe('blocked');
    expect(['blocked', 'failed'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'], readyAt: NOW })))).toEqual(['review', 'review']);
    expect(groupOf(item(1, { readyAt: NOW, sessions: [session({ state: 'waiting' })] }))).toBe('review');
    expect(['awaiting-approval', 'finished'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['review', 'review']);
    expect(groupOf(item(1, { readyAt: NOW, sessions: [session()] }))).toBe('review');
    expect(['setup', 'running'].map((status) => groupOf(item(1, { status: status as WorkItemView['status'] })))).toEqual(['progress', 'progress']);
  });
});

describe('controlsOf', () => {
  it('shows only the controls that apply, with no session controls and no Change playbook', () => {
    expect(labels(item(1, { status: 'unstarted' }))).toEqual(['Start', 'Start with guidance…', 'Mark done', 'Snooze…', 'Add comment…', 'Delete', 'History']);
    expect(labels(item(1, { status: 'awaiting-approval' }))).toEqual(['Approve', 'Mark done', 'Snooze…', 'Add comment…', 'Delete', 'History']);
    expect(labels(item(1, { sessions: [session()] }))).toEqual(['Stop', 'Mark done', 'Snooze…', 'Add comment…', 'Open in terminal', 'Delete', 'History']);
    expect(labels(item(1, { sessions: [session({ state: 'starting', shortId: null })] }))).toEqual(['Mark done', 'Snooze…', 'Add comment…', 'History']);
    expect(labels(item(1, { status: 'blocked', sessions: [session({ state: 'ended' })] }))).toEqual(['Mark done', 'Snooze…', 'Add comment…', 'Open in terminal', 'Delete', 'History']);
    expect(labels(item(1, { status: 'finished', sessions: [session({ state: 'ended' })] }))).toEqual(['Mark done', 'Snooze…', 'Add comment…', 'Open in terminal', 'Delete', 'History']);
    expect(labels(item(1, { status: 'failed' }))).toEqual(['Retry', 'Mark done', 'Snooze…', 'Add comment…', 'Delete', 'History']);
    expect(labels(item(1, { status: 'failed', triage: triage({ error: 'Timed out.' }) }))).toEqual(['Retry', 'Mark done', 'Snooze…', 'Add comment…', 'Delete', 'History']);
    // A failed work item whose setup session the operator reopened resumes in that session.
    expect(labels(item(1, { status: 'failed', sessions: [session({ state: 'idle' })] })).includes('Retry')).toBe(false);
    expect(controlsOf(item(7, { status: 'failed' }))[0]).toMatchObject({ icon: 'refresh', message: { type: 'action', action: { type: 'retry', workItemId: 7 } } });
    expect(labels(item(1, { status: 'triaging' }))).toEqual(['Mark done', 'Snooze…', 'Add comment…', 'Delete', 'History']);
    expect(labels(item(1, { status: 'done', sessions: [session({ state: 'ended' })] }))).toEqual(['Reopen', 'Add comment…', 'Open in terminal', 'Delete', 'History']);
    expect(controlsOf(item(7, { status: 'done' })).find((control) => control.label === 'Reopen')?.message).toEqual({ type: 'action', action: { type: 'reopen', workItemId: 7 } });
    expect(labels(item(1, { status: 'done', reopenable: false }))).toEqual(['Add comment…', 'Delete', 'History']);
    expect(labels(item(1, { status: 'failed', ticket: { ...item(1).ticket, source: 'adhoc' } }))).toEqual(['Retry', 'Mark done', 'Snooze…', 'Add comment…', 'Delete', 'History']);
    expect(labels(item(1, { status: 'failed', ticket: { ...item(1).ticket, source: 'schedule' } }))).toEqual(['Retry', 'Mark done', 'Snooze…', 'Add comment…', 'Delete', 'History']);
    expect(labels(item(1, { status: 'blocked', sessions: [session({ released: true })] }))).toEqual(['Mark done', 'Snooze…', 'Add comment…', 'Open in terminal', 'Delete', 'History']);
    expect(controlsOf(item(7, { sessions: [session()] })).map((control) => control.message)).toEqual([
      { type: 'action', action: { type: 'stop', workItemId: 7 } },
      { type: 'action', action: { type: 'mark-done', workItemId: 7 } },
      { type: 'action', action: { type: 'snooze', ticketId: 7 } },
      { type: 'action', action: { type: 'comment', workItemId: 7 } },
      { type: 'terminal', provider: 'claude', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', name: 'gh 107', shortId: 'aaaa1111', active: false },
      { type: 'action', action: { type: 'delete', workItemId: 7 } },
      { type: 'history', ticketId: 7, key: 'gh 107' },
    ]);
  });

  it('asks for guidance before Start with guidance…, posting the same start action, and keeps Start the main control (PRD R77)', () => {
    const unstarted = item(7, { status: 'unstarted' });
    const guided = controlsOf(unstarted).find((control) => control.label === 'Start with guidance…')!;

    expect(guided).toEqual({
      label: 'Start with guidance…',
      icon: 'comment',
      message: { type: 'action', action: { type: 'start', workItemId: 7 } },
      input: { question: 'Start with guidance', detail: "Switchboard adds your guidance to the end of the session's prompt.", field: 'guidance', action: 'Start' },
    });
    expect(mainControl(unstarted)?.label).toBe('Start');
    expect(controlsOf(unstarted).filter((control) => control.input !== undefined).map((control) => control.label)).toEqual(['Start with guidance…', 'Add comment…']);
  });

  it("offers the playbook in Start with guidance… when there is another to choose, triage's selected (PRD R35)", () => {
    const guided = (entry: WorkItemView) => controlsOf(entry).find((control) => control.label === 'Start with guidance…')!.input;

    expect(guided(item(7, { status: 'unstarted', playbookChoices: ['dev:develop', 'dev:other'] }))?.choice).toEqual({ field: 'playbook', label: 'Playbook', value: 'dev:develop', values: ['dev:develop', 'dev:other'] });
    expect(guided(item(7, { status: 'unstarted', playbookChoices: ['dev:develop'] }))).not.toHaveProperty('choice');
    expect(poolControls(pool(3, { playbookChoices: ['dev:develop', 'dev:other'] })).controls.find((control) => control.label === 'Start with guidance…')!.input?.choice).toMatchObject({ value: 'dev:develop', values: ['dev:develop', 'dev:other'] });
  });

  it('offers Start with prompt… in place of Start with guidance… on an ad-hoc work item, with its prompt in the box, as its main control (PRD R77)', () => {
    const adhoc = item(7, { status: 'unstarted', playbook: null, taskPrompt: 'Write hello.txt' });

    expect(controlsOf(adhoc).find((control) => control.label === 'Start with prompt…')).toEqual({
      label: 'Start with prompt…',
      icon: 'edit',
      message: { type: 'action', action: { type: 'start', workItemId: 7 } },
      input: { question: 'Start with prompt', detail: 'The session runs this prompt. Switchboard keeps your changes for later starts.', field: 'prompt', action: 'Start', text: 'Write hello.txt' },
    });
    expect(labels(adhoc)).not.toContain('Start with guidance…');
    expect(labels(adhoc)).toContain('Start');
    expect(mainControl(adhoc)?.label).toBe('Start with prompt…');
    const triaged = item(7, { status: 'unstarted', playbook: 'dev:question', taskPrompt: 'Answer Issue 1.' });
    expect(labels(triaged)).not.toContain('Start with prompt…');
    expect(mainControl(triaged)?.label).toBe('Start');
  });

  it('asks for the text before Add comment… and posts it as the comment action (PRD R87)', () => {
    expect(controlsOf(item(7, { status: 'done' })).find((control) => control.label === 'Add comment…')).toEqual({
      label: 'Add comment…',
      icon: 'comment',
      message: { type: 'action', action: { type: 'comment', workItemId: 7 } },
      input: { question: 'Add comment', detail: 'Switchboard keeps it with the work item and shows it on the row. It is not sent to the source.', field: 'text', action: 'Add' },
    });
  });

  it('asks before Delete, naming the session it stops, and offers no Delete while a session starts (PRD R120)', () => {
    const confirm = (entry: WorkItemView) => controlsOf(entry).find((control) => control.label === 'Delete')?.confirm ?? null;
    const kept = "Switchboard deletes the work item, its sessions and its history. The ticket, its worktree and Claude's session files stay.";
    const returns = 'The ticket gets a new work item only when it is assigned to you again.';

    expect(confirm(item(7, { sessions: [session()] }))).toEqual({ question: 'Delete gh 107?', detail: `Its running session is stopped. ${kept} ${returns}`, action: 'Delete' });
    expect(confirm(item(7, { sessions: [session({ state: 'idle', released: true })] }))?.detail).toBe(`${kept} ${returns}`);
    expect(confirm(item(7, { status: 'done', sessions: [session({ state: 'ended' })] }))?.detail).toBe(`${kept} ${returns}`);
    expect(confirm(item(7, { status: 'failed', ticket: { ...item(7).ticket, source: 'adhoc' } }))?.detail).toBe(kept);
    expect(confirm(item(7, { status: 'failed', ticket: { ...item(7).ticket, source: 'schedule' } }))?.detail).toBe(`${kept} Its schedule makes the next work item at its next time or Run now.`);
    expect(confirm(item(7, { sessions: [session({ state: 'starting', shortId: null })] }))).toBeNull();
  });

  it('offers Stop in place of Open in Claude while a fork waits for the session to be released (PRD R78)', () => {
    const waiting = item(7, { status: 'blocked', sessions: [session({ state: 'waiting', pendingFork: '9e8d7c6b' })] });

    expect(openQuestion(waiting)).toBeNull();
    expect(labels(waiting)).not.toContain('Open in Claude');
    expect(labels(waiting)).toContain('Stop');
    expect(mainControl(waiting)?.label).not.toBe('Open in Claude');
  });

  it('offers Open in terminal, not Open in Claude, while a session waits on a prompt before it starts (PRD R41)', () => {
    const waiting = item(7, { status: 'running', sessions: [session({ state: 'waiting', stateDetail: START_PROMPT })] });

    expect(openQuestion(waiting)).toBeNull();
    expect(labels(waiting)).not.toContain('Open in Claude');
    expect(labels(waiting)).toContain('Stop');
    expect(mainControl(waiting)).toMatchObject({ label: 'Open in terminal', message: { type: 'terminal', shortId: 'aaaa1111', active: false } });
    expect(startPromptText(waiting)).toEqual([{ text: 'Waits on a prompt before it starts', title: "Claude asks before the session starts, such as to approve the project's MCP servers. Open in terminal to answer it." }]);
    expect(startPromptText(item(7, { sessions: [session({ state: 'waiting' })] }))).toEqual([]);
    expect(mainControl(item(7, { sessions: [session({ state: 'waiting' })] }))?.label).toBe('Open in Claude');
  });

  it('offers Open in terminal, not Open in Claude, while a background session waits on a permission prompt (PRD R70)', () => {
    const waiting = item(7, { status: 'running', sessions: [session({ state: 'waiting', stateDetail: PERMISSION_PROMPT })] });

    expect(openQuestion(waiting)).toBeNull();
    expect(labels(waiting)).not.toContain('Open in Claude');
    expect(labels(waiting)).toContain('Stop');
    expect(mainControl(waiting)).toMatchObject({ label: 'Open in terminal', message: { type: 'terminal', shortId: 'aaaa1111', active: false } });
    expect(mainControl(waiting, 'review')).toBe(ANSWER_IN_TERMINAL);
    expect(startPromptText(waiting)).toEqual([{ text: 'Waits on a permission prompt', title: 'Claude asks to approve a tool call. Open in terminal to answer it; stopping the session would drop the prompt.' }]);
    // Released to a VS Code tab, the tab shows the prompt.
    expect(startPromptText(item(7, { sessions: [session({ state: 'waiting', stateDetail: PERMISSION_PROMPT, released: true })] }))).toEqual([]);
  });

  it('attaches a terminal to a background session, resumes the latest ended session, shows one the operator resumed, and offers none while a session starts (PRD R28)', () => {
    const terminal = (entry: WorkItemView) => controlsOf(entry).find((control) => control.label === 'Open in terminal')?.message ?? null;
    const waiting = item(7, { sessions: [session({ state: 'waiting' })] });

    expect(terminal(waiting)).toEqual({ type: 'terminal', provider: 'claude', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', name: 'gh 107', shortId: 'aaaa1111', active: false });
    expect(labels(waiting)).toContain('Open in Claude');
    expect(terminal(item(7, { sessions: [session({ nativeSessionId: null })] }))).toMatchObject({ sessionId: 'aaaa1111', shortId: 'aaaa1111' });
    expect(terminal(item(7, { sessions: [session({ id: 's0', nativeSessionId: 'old-native', state: 'ended' }), session({ state: 'ended', cwd: 'D:/wt' })] }))).toEqual({ type: 'terminal', provider: 'claude', sessionId: 'aaaa1111-native', cwd: 'D:/wt', name: 'gh 107', shortId: null, active: false });
    // Released and not ended: the roster lists it as interactive, as for a terminal or a VS Code tab.
    expect(terminal(item(7, { sessions: [session({ state: 'idle', released: true })] }))).toEqual({ type: 'terminal', provider: 'claude', sessionId: 'aaaa1111-native', cwd: 'D:/git/widgets', name: 'gh 107', shortId: null, active: true });
    expect(terminal(item(7, { sessions: [session({ state: 'starting', shortId: null })] }))).toBeNull();
    // Its release stop has not finished, so its background process may still hold it.
    expect(terminal(item(7, { sessions: [session({ state: 'idle', released: true, releasing: true, provider: 'codex' })] }))).toBeNull();
    expect(labels(item(7, { sessions: [session({ state: 'idle', released: true, releasing: true })] }))).toContain('Stop');
    expect(terminal(item(7, { sessions: [session({ state: 'ended', nativeSessionId: null })] }))).toBeNull();
    expect(terminal(item(7))).toBeNull();
  });
});

describe('Codex sessions (PRD R22)', () => {
  const codex = (patch: Partial<WorkItemView['sessions'][number]> = {}) => session({ provider: 'codex', nativeSessionId: 'thread-1', shortId: 'thread-1', ...patch });
  const terminal = (entry: WorkItemView) => controlsOf(entry).find((control) => control.label === 'Open in terminal')?.message ?? null;

  it('names Codex on Open, as the main control of a waiting session, and in Delete', () => {
    const waiting = item(7, { sessions: [codex({ state: 'waiting', question: { id: 'q1', text: 'Which?' } })] });

    // A Codex session waiting on a permission prompt rather than a reported question offers nothing to open.
    expect(mainControl(item(7, { sessions: [codex({ state: 'waiting' })] }))).toBeNull();

    expect(mainControl(waiting)).toEqual({ label: 'Open in Codex', icon: 'comment-discussion', message: { type: 'open-question', workItemId: 7, sessionId: 'thread-1', cwd: 'D:/git/widgets', provider: 'codex' } });
    expect(labels(waiting)).not.toContain('Open in Claude');
    expect(controlsOf(item(7, { sessions: [codex({ state: 'ended' })] })).find((control) => control.label === 'Delete')?.confirm?.detail).toContain("its worktree and Codex's session files stay");
  });

  it('offers no terminal while the Codex run is in its background process, which has no attach, and codex resume once it ended', () => {
    expect(terminal(item(7, { sessions: [codex()] }))).toBeNull();
    expect(terminal(item(7, { sessions: [codex({ state: 'ended' })] }))).toEqual({ type: 'terminal', provider: 'codex', sessionId: 'thread-1', cwd: 'D:/git/widgets', name: 'gh 107', shortId: null, active: false });
    expect(terminal(item(7, { sessions: [codex({ state: 'idle', released: true })] }))).toMatchObject({ provider: 'codex', active: true });
  });
});

describe('Code Mode sessions (PRD R95)', () => {
  const held = (patch: Partial<WorkItemView['sessions'][number]> = {}) => session({ codeMode: true, ...patch });
  const terminal = (entry: WorkItemView) => controlsOf(entry).find((control) => control.label === 'Open in terminal')?.message ?? null;
  const attach = { type: 'terminal', provider: 'claude', sessionId: 's1', cwd: 'D:/git/widgets', name: 'gh 107', shortId: 'aaaa1111', active: false, codeMode: true };

  it('opens its attach terminal by its Switchboard session ID in every state, starting and ended included', () => {
    for (const patch of [{ state: 'starting' as const, shortId: null }, {}, { state: 'waiting' as const }, { state: 'idle' as const, releasing: true }, { state: 'ended' as const }]) {
      expect(terminal(item(7, { status: 'blocked', sessions: [held(patch)] }))).toEqual({ ...attach, shortId: patch.shortId === undefined ? 'aaaa1111' : null });
    }
  });

  it('offers Open in terminal, not Open in Claude, on a question, a permission prompt and a start prompt, and Answer in terminal with review', () => {
    for (const stateDetail of [null, PERMISSION_PROMPT, START_PROMPT]) {
      const waiting = item(7, { sessions: [held({ state: 'waiting', stateDetail })] });

      expect(openQuestion(waiting)).toBeNull();
      expect(labels(waiting)).not.toContain('Open in Claude');
      expect(mainControl(waiting)).toMatchObject({ label: 'Open in terminal', message: attach });
      expect(mainControl(waiting, 'review')).toBe(ANSWER_IN_TERMINAL);
    }
  });

  it('offers Delete while it starts, saying that Delete stops it, unlike a starting background session (PRD R120)', () => {
    const starting = item(7, { sessions: [held({ state: 'starting', shortId: null })] });
    const remove = controlsOf(starting).find((control) => control.label === 'Delete');

    expect(remove?.message).toEqual({ type: 'action', action: { type: 'delete', workItemId: 7 } });
    expect(remove?.confirm?.detail).toMatch(/^Its running session is stopped\. /);
    expect(labels(item(7, { sessions: [session({ state: 'starting', shortId: null })] }))).not.toContain('Delete');
  });

  it('offers Stop while held, after its turn too, and no main control while it runs or after its turn', () => {
    expect(labels(item(7, { sessions: [held({ state: 'idle' })] }))).toContain('Stop');
    expect(mainControl(item(7, { sessions: [held()] }))).toBeNull();
    expect(mainControl(item(7, { status: 'blocked', sessions: [held({ state: 'idle' })] }))).toBeNull();
  });

  it('offers Stop on an ended session only while the resume guard found leftover processes', () => {
    const ended = item(7, { status: 'blocked', sessions: [held({ state: 'ended' })] });

    expect(labels(ended)).not.toContain('Stop');
    expect(controlsOf({ ...ended, leftovers: [4242] }).find((control) => control.label === 'Stop')?.message).toEqual({ type: 'action', action: { type: 'stop', workItemId: 7 } });
  });

  it('names the Code Mode session in the start and permission prompt tooltips', () => {
    expect(startPromptText(item(7, { sessions: [held({ state: 'waiting', stateDetail: START_PROMPT })] }))[0]?.title).toBe('Claude asks before the Code Mode session starts, such as to trust the folder. Open in terminal to answer it.');
    expect(startPromptText(item(7, { sessions: [held({ state: 'waiting', stateDetail: PERMISSION_PROMPT })] }))[0]?.title).toBe('Claude asks to approve a tool call in the Code Mode session. Open in terminal to answer it; stopping the session would drop the prompt.');
  });
});

describe('mainControl', () => {
  it('picks the one primary control of a Blocked on you, Ready for review or Unstarted row', () => {

    expect(mainControl(item(1, { status: 'awaiting-approval' }))?.label).toBe('Approve');
    expect(mainControl(item(1, { status: 'failed' }))?.label).toBe('Retry');
    expect(mainControl(item(1, { status: 'failed', triage: triage({ error: 'Timed out.' }) }))?.label).toBe('Retry');
    // A ready row keeps the control of what it waits on.
    expect(mainControl(item(1, { status: 'failed', readyAt: NOW }))?.label).toBe('Retry');
    expect(mainControl(item(1, { status: 'awaiting-approval', readyAt: NOW, sessions: [session({ state: 'waiting' })] }))?.label).toBe('Open in Claude');
    expect(mainControl(item(1, { status: 'failed', ticket: { ...item(1).ticket, source: 'adhoc' } }))?.label).toBe('Retry');
    expect(mainControl(item(1, { status: 'blocked', sessions: [session({ state: 'ended' })] }))).toBeNull();
    expect(mainControl(item(1, { status: 'unstarted' }))?.label).toBe('Start');
    expect(mainControl(item(1, { status: 'triaging' }))).toBeNull();
    expect(mainControl(item(1, { sessions: [session({ state: 'waiting', released: true })] }))).toBeNull();
    expect(mainControl(item(1))).toBeNull();
  });
});

describe('clockOf', () => {
  it('counts Blocked on you from the status or the wait, Ready for review from readyAt, In progress from the run start, and the rest from scope entry, stopping at done (PRD R27)', () => {
    const scoped = (patch: Partial<WorkItemView>, scopeAt: number | null = 5, snoozed = false) =>
      item(1, { createdAt: 1, statusAt: 2, runStartedAt: 3, ...patch, ticket: { ...item(1).ticket, scopeAt, snoozed } });

    expect(clockOf(scoped({ status: 'blocked' }))).toEqual({ since: 2, label: 'In this status since' });
    expect(clockOf(scoped({ status: 'running', sessions: [session({ state: 'waiting', stateAt: 4 })] }))).toEqual({ since: 4, label: 'Waiting since' });
    expect(clockOf(scoped({ status: 'setup', sessions: [session({ kind: 'setup', state: 'waiting', stateAt: 4 })] }))).toEqual({ since: 4, label: 'Waiting since' });
    // Open in Claude ended the session but the question still waits from when it was asked (PRD R70).
    expect(clockOf(scoped({ status: 'running', sessions: [session({ state: 'ended', outcome: 'opened', stateAt: 4 })] }))).toEqual({ since: 4, label: 'Waiting since' });
    // A blocked item whose session still waits counts from the block.
    expect(clockOf(scoped({ status: 'blocked', sessions: [session({ state: 'waiting', stateAt: 4 })] }))).toEqual({ since: 2, label: 'In this status since' });
    // A ready work item counts from when it became ready, through a question or a block.
    expect(clockOf(scoped({ status: 'awaiting-approval', readyAt: 6, sessions: [session({ state: 'waiting', stateAt: 4 })] }))).toEqual({ since: 6, label: 'Ready since' });
    expect(clockOf(scoped({ status: 'blocked', readyAt: 6 }))).toEqual({ since: 6, label: 'Ready since' });
    expect(clockOf(scoped({ status: 'awaiting-approval', readyAt: 6 }))).toEqual({ since: 6, label: 'Ready since' });
    expect(clockOf(scoped({ status: 'running', readyAt: 6 }))).toEqual({ since: 6, label: 'Ready since' });
    expect(clockOf(scoped({ status: 'running' }))).toEqual({ since: 3, label: 'Working since' });
    expect(clockOf(scoped({ status: 'setup', runStartedAt: null }))).toEqual({ since: 2, label: 'Working since' });
    expect(clockOf(scoped({ status: 'queued' }))).toEqual({ since: 5, label: 'In scope since' });
    expect(clockOf(scoped({ status: 'unstarted' }))).toEqual({ since: 5, label: 'In scope since' });
    expect(clockOf(scoped({ status: 'unstarted' }, null))).toEqual({ since: 1, label: 'In scope since' });
    expect(clockOf(scoped({ status: 'blocked' }, 5, true))).toEqual({ since: 5, label: 'In scope since' });
    // Done keeps the scope entry the work item had, not the ticket's later one.
    expect(clockOf(scoped({ status: 'done', doneAt: 9, scopeAt: 4 }, 8))).toEqual({ since: 4, label: 'In scope from' });
    expect(clockOf(scoped({ status: 'done', doneAt: 9 }, 8))).toEqual({ since: 1, label: 'In scope from' });
  });
});

describe('doneStamp and doneBand', () => {
  // Wednesday 7 October 2026, 10:00 local time; the week began on Monday 5 October.
  const now = new Date(2026, 9, 7, 10).getTime();
  const at = (day: number, hour = 0) => new Date(2026, 9, day, hour).getTime();

  it('bands by local day, with weeks starting on Monday', () => {
    const times = [at(7), at(6, 23), at(6), at(5), at(4, 23), new Date(2026, 8, 28).getTime(), new Date(2026, 8, 27, 23).getTime()];

    expect(times.map((time) => doneBand(time, now))).toEqual(['Today', 'Yesterday', 'Yesterday', 'Earlier this week', 'Last week', 'Last week', 'Two weeks ago']);
  });

  it('lists Done from the Monday two weeks before this week’s, so Two weeks ago is a whole week', () => {
    expect(doneSince(now)).toBe(new Date(2026, 8, 21).getTime());
    expect(doneSince(at(5))).toBe(new Date(2026, 8, 21).getTime());
    expect(doneSince(at(11, 23))).toBe(new Date(2026, 8, 21).getTime());
    expect(doneSince(at(12))).toBe(new Date(2026, 8, 28).getTime());
    expect(doneBand(doneSince(now), now)).toBe('Two weeks ago');
  });

  it('puts Monday’s yesterday in Yesterday, not Last week', () => {
    expect(doneBand(at(4, 12), at(5, 9))).toBe('Yesterday');
    expect(doneBand(at(3, 12), at(5, 9))).toBe('Last week');
  });

  it('stamps a done time as 24-hour HH:mm today and m/d before today, in local time', () => {
    expect([at(7, 9), at(7, 13) + 5 * 60_000, at(7, 0), at(6, 23), new Date(2026, 8, 28).getTime()].map((time) => doneStamp(time, now))).toEqual(['09:00', '13:05', '00:00', '10/6', '9/28']);
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

describe('poolControls', () => {
  it('offers Start once triage chose a playbook, Triage again after a failed triage, and neither while it runs', () => {
    const labels = (entry: ReturnType<typeof pool>) => {
      const { main, controls } = poolControls(entry);

      return [main?.label ?? null, controls.map((control) => control.label)];
    };

    expect(labels(pool(3))).toEqual(['Start', ['Start', 'Start with guidance…', 'Snooze…', 'History']]);
    expect(labels(pool(3, { triage: triage({ playbook: null, error: 'timed out' }) }))).toEqual(['Triage again', ['Triage again', 'Snooze…', 'History']]);
    expect(labels(pool(3, { triage: triage({ playbook: null, endedAt: null }) }))).toEqual([null, ['Snooze…', 'History']]);
    expect(labels(pool(3, { ticket: { ...pool(3).ticket, snoozed: true } }))).toEqual(['Start', ['Start', 'Start with guidance…', 'Snooze…', 'Unsnooze', 'History']]);
    expect(poolControls(pool(3)).main?.message).toEqual({ type: 'action', action: { type: 'pick', ticketId: 3 } });
    expect(poolControls(pool(3)).controls[1]).toMatchObject({ message: { type: 'action', action: { type: 'pick', ticketId: 3 } }, input: { field: 'guidance', action: 'Start' } });
  });
});

describe('stripeOf', () => {
  it("stripes failed rows red, blocked or waiting rows yellow and the operator's turn, but not the agent's turn, Snoozed or the other groups (PRD R27)", () => {
    expect(stripeOf(item(1, { status: 'failed' }))).toBe('error');
    expect(stripeOf(item(1, { status: 'failed', triage: triage({ error: 'Timed out.' }) }))).toBeNull();
    expect(stripeOf(item(1, { status: 'failed', triage: triage({ error: null }) }))).toBe('error');
    expect(stripeOf(item(1, { status: 'blocked' }))).toBe('warning');
    expect(stripeOf(item(1, { sessions: [session({ state: 'waiting' })] }))).toBe('warning');
    // A ready row keeps the stripe of what it waits on.
    expect(stripeOf(item(1, { status: 'failed', readyAt: NOW }))).toBe('error');
    expect(stripeOf(item(1, { status: 'awaiting-approval', readyAt: NOW, sessions: [session({ state: 'waiting' })] }))).toBe('warning');
    expect(stripeOf(item(1, { status: 'awaiting-approval' }))).toBe('turn');
    expect(stripeOf(item(1, { status: 'finished' }))).toBe('turn');
    expect(stripeOf(item(1, { status: 'running', readyAt: NOW, sessions: [session()] }))).toBeNull();
    expect(stripeOf(item(1, { status: 'running', sessions: [session()] }))).toBeNull();
    expect(stripeOf(item(1, { status: 'unstarted' }))).toBeNull();
    expect(stripeOf(item(1, { status: 'done' }))).toBeNull();
    expect(stripeOf(item(1, { status: 'failed', ticket: { ...item(1).ticket, snoozed: true } }))).toBeNull();
  });
});

describe('listGroups', () => {
  it("orders Blocked on you by wait, Ready for review by the operator's place or readyAt, and In progress by run start (PRD R27)", () => {
    const groups = listGroups(
      snapshot([
        item(1, { status: 'awaiting-approval', readyAt: NOW - 3000 }),
        item(2, { status: 'running', readyAt: NOW - 5000, sessions: [session()] }),
        item(3, { status: 'finished', readyAt: NOW - 1000, orderAt: NOW - 9000 }),
        item(4, { status: 'blocked', statusAt: NOW - 100 }),
        item(5, { status: 'failed', statusAt: NOW - 200 }),
        item(6, { status: 'running', runStartedAt: NOW - 10, sessions: [session()] }),
        item(7, { status: 'setup', runStartedAt: NOW - 20, sessions: [session()] }),
      ]),
    );
    const ids = (rows: unknown[]) => rows.map((row) => (row as WorkItemView).id);

    expect([ids(groups.blocked), ids(groups.review), ids(groups.progress)]).toEqual([
      [5, 4],
      [3, 2, 1],
      [7, 6],
    ]);
  });

  it('keeps a Ready for review row in its place while its turn changes', () => {
    const rows = (first: Partial<WorkItemView>) =>
      listGroups(snapshot([item(1, { readyAt: NOW - 3000, ...first }), item(2, { status: 'awaiting-approval', readyAt: NOW - 2000 }), item(3, { status: 'finished', readyAt: NOW - 1000 })])).review.map(
        (row) => (row as WorkItemView).id,
      );

    expect(rows({ status: 'awaiting-approval', statusAt: NOW })).toEqual([1, 2, 3]);
    expect(rows({ status: 'running', statusAt: NOW, sessions: [session()] })).toEqual([1, 2, 3]);
    expect(rows({ status: 'queued', statusAt: NOW })).toEqual([1, 2, 3]);
  });
});

describe('moveControls', () => {
  it("offers Move to top, Move up and Move down from the row's neighbours, and Reset position once moved (PRD R73)", () => {
    const moves = (id: number, orderAt: number | null = null) =>
      moveControls(item(id, { status: 'awaiting-approval', orderAt }), [4, 7, 9]).map((control) => [control.label, control.message['action']]);

    expect(moves(4)).toEqual([['Move down', { type: 'move', workItemId: 4, after: 7 }]]);
    expect(moves(7)).toEqual([
      ['Move to top', { type: 'move', workItemId: 7, after: null }],
      ['Move up', { type: 'move', workItemId: 7, after: null }],
      ['Move down', { type: 'move', workItemId: 7, after: 9 }],
    ]);
    expect(moves(9, NOW)).toEqual([
      ['Move to top', { type: 'move', workItemId: 9, after: null }],
      ['Move up', { type: 'move', workItemId: 9, after: 4 }],
      ['Reset position', { type: 'reset-position', workItemId: 9 }],
    ]);
    expect(moves(5)).toEqual([]);
  });
});

describe('waitTexts', () => {
  it('words each reason a queued row waits, with what ends it', () => {
    expect(
      waitTexts(
        item(1, {
          status: 'queued',
          waits: [
            { kind: 'slot', used: 2, limit: 2 },
            { kind: 'session', sessionId: 's2', shortId: null, ownItem: false, playbook: null },
            { kind: 'snoozed' },
            { kind: 'blockers', blockers: [{ url: 'https://github.com/o/r/issues/12', ref: '#12', title: 'Migrate the schema' }] },
          ],
        }),
      ),
    ).toEqual([
      { text: 'Waits for a slot · 2/2 in use', title: '2 sessions are running; sessions.concurrency is 2.' },
      { text: "Waits for the ad-hoc session's turn to end", title: 'Session s2 on this ticket is running or waiting on a question. This starts when its turn ends.' },
      { text: 'Starts after the snooze ends', title: 'The ticket is snoozed.' },
      { text: 'Starts when #12 closes', title: 'Open issues that block this one:\n#12 Migrate the schema' },
    ]);
  });
});

describe('rowTime', () => {
  it('shows the time in queue, or the done time on an unsnoozed Done row', () => {
    expect(rowTime(item(1, { status: 'blocked', statusAt: NOW - 3 * 3_600_000 }), NOW)).toEqual({ text: '3h', title: 'In this status since 2026-10-03 09:00 UTC' });
    expect(rowTime(item(1, { status: 'done', doneAt: NOW - 2 * 86_400_000, scopeAt: NOW - 5 * 86_400_000 }), NOW)).toEqual({
      text: `${new Date(NOW - 2 * 86_400_000).getMonth() + 1}/${new Date(NOW - 2 * 86_400_000).getDate()}`,
      title: 'Done 2026-10-01 12:00 UTC; in scope from 2026-09-28 12:00 UTC',
    });
  });
});

describe('priorityTitle', () => {
  it('names the rating of a priority ticket only', () => {
    expect(priorityTitle(triage({ immediacy: 'BLOCKING', severity: null }))).toBe('Immediacy: BLOCKING   Severity: ?');
    expect(priorityTitle(triage({ immediacy: 'NON-BLOCKING', severity: 'LOW' }))).toBeNull();
    expect(priorityTitle(null)).toBeNull();
  });
});

describe('snapshotErrors and setupNotes', () => {
  it('lists every configuration error, and what an unconfigured home lacks', () => {
    expect(snapshotErrors(snapshot([], { errors: { settings: 'bad JSON', playbooks: ['dev/x.md: no description'], hooks: 'malformed', sources: { zoho: 'no token' } } }))).toEqual([
      'Settings: bad JSON',
      'Playbook dev/x.md: no description',
      'Hooks: malformed',
      'zoho: no token',
    ]);
    expect(snapshotErrors(snapshot([]))).toEqual([]);
    expect(setupNotes(snapshot([]))).toEqual([]);
    expect(setupNotes(snapshot([], { sources: [], playbooks: [] }))).toEqual([
      'No source is polled. Turn one on in the header.',
      'No task playbooks are loaded. Add them under playbooks in C:\\Users\\me\\.claude\\switchboard\\settings.json.',
    ]);
    expect(setupNotes(snapshot([], { sources: [], sourceStates: [] }))).toEqual(['No source is configured. Add one in C:\\Users\\me\\.claude\\switchboard\\settings.json.']);
    expect(setupNotes(snapshot([], { sources: [], sourceStates: [], configDir: '/home/me/.claude/switchboard' }))).toEqual(['No source is configured. Add one in /home/me/.claude/switchboard/settings.json.']);
  });
});


describe('limitTexts (architecture.md § Rate limits)', () => {
  const RESET = NOW + 2 * 3_600_000;
  const limit = { kind: 'usage' as const, window: 'five_hour', resetsAt: RESET, exact: true, cli: true, message: "You've hit your 5-hour limit · resets 2:00pm (America/New_York)", since: NOW, at: NOW, launchId: 'l', attempts: 0, nextAt: RESET + 180_000 };
  const time = (at: number) => limitTime(at, NOW);

  it("shows the reset Claude Code waits for itself, with Switchboard's own attempt in the tooltip", () => {
    const [text] = limitTexts(item(1, { status: 'running', sessions: [session({ codeMode: true, state: 'failed', stateDetail: 'rate_limit', rateLimit: limit })] }), NOW);

    expect(text).toEqual({ text: `Rate limited · resumes ${time(RESET)}`, title: `${limit.message}\nClaude Code continues on its own after the reset; Switchboard continues it at ${time(RESET + 180_000)} if it has not.` });
  });

  it("shows the hub's next attempt: resumes before the first, retries after one or without a reset time", () => {
    const held = (patch: object) => limitTexts(item(1, { status: 'running', sessions: [session({ execution: 'app-server', state: 'failed', stateDetail: 'rate_limit', rateLimit: { ...limit, ...patch } })] }), NOW)[0]!.text;

    expect(held({ cli: false, nextAt: RESET + 60_000 })).toBe(`Rate limited · resumes ${time(RESET + 60_000)}`);
    expect(held({ cli: false, resetsAt: null, nextAt: NOW + 300_000 })).toBe(`Rate limited · retries ${time(NOW + 300_000)}`);
    expect(held({ attempts: 2, nextAt: NOW + 600_000 })).toBe(`Rate limited · retries ${time(NOW + 600_000)}`);
  });

  it('shows when a background session can be continued, and nothing once a turn runs or without a limit', () => {
    expect(limitTexts(item(1, { status: 'blocked', sessions: [session({ state: 'failed', stateDetail: 'rate_limit', rateLimit: limit })] }), NOW)[0]?.text).toBe(`Rate limited · resets ${time(RESET)}`);
    expect(limitTexts(item(1, { status: 'blocked', sessions: [session({ state: 'ended', released: true, rateLimit: limit })] }), NOW)[0]?.text).toBe(`Rate limited · resets ${time(RESET)}`);
    expect(limitTexts(item(1, { status: 'blocked', sessions: [session({ state: 'ended', released: true, rateLimit: limit })] }), RESET)).toEqual([]);
    expect(limitTexts(item(1, { status: 'running', sessions: [session({ state: 'running', rateLimit: limit })] }), NOW)).toEqual([]);
    expect(limitTexts(item(1, { status: 'running', sessions: [session({ codeMode: true, state: 'running', rateLimit: limit })] }), NOW)).toEqual([]);
    expect(limitTexts(item(1, { status: 'running', sessions: [session({ codeMode: true, state: 'idle' })] }), NOW)).toEqual([]);
  });

  it('names another day by its weekday', () => {
    expect(limitTime(NOW + 26 * 3_600_000, NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M$/);
    expect(limitTime(NOW, NOW)).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
  });

  it("explains a queued start held by its provider's usage limit", () => {
    const [wait] = waitTexts(item(1, { status: 'queued', waits: [{ kind: 'limit', provider: 'codex', until: RESET }] }));

    expect(wait!.text).toBe(`Starts after the usage limit resets, ${limitTime(RESET, null)}`);
    expect(wait!.title).toContain('A Codex session stopped at a usage limit');
  });
});
