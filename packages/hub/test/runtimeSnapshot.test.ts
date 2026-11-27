import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ClaudeRunner, conversationRules, markerState, projectSlug, readMarkers, rosterState } from '@switchboard/claude';
import type { RosterEntry } from '@switchboard/claude';
import { CodexRunner } from '@switchboard/codex';
import type { Exec, ExecResult } from '@switchboard/claude';
import { BACKOFF_MS, CLI_MARGIN_MS, CONTINUE_TEXT, CONVERSATION_RETENTION, DEFAULT_SETTINGS, launchOptions, MESSAGES, parsePlaybook, QUESTION_CARD, Store, toneSection, toneVersion, UNCONFIRMED_DONE } from '@switchboard/core';
import { recordPath } from '@switchboard/holder';
import type { SessionEntry } from '@switchboard/holder';
import { NotWritten } from '@switchboard/conversation';
import { markOf } from '@switchboard/core/group';
import type { ContextResult, CopyRelation, Playbook, PolledTicket, PollResult, PullRequestStatus, Session, SessionRunner, Settings, Source, StartAction, Ticket } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import type { HolderConnection } from '../src/holder.js';
import { ConversationService } from '../src/conversation.js';
import { WindowScopes } from '../src/windows.js';
import { ATTACH_RESERVATION_MS, INPUT_SETTLE_MS, PULL_REQUESTS_FOCUS_MS, questionCardOpen, REPORT_CHECK_MS, MARKER_MS, RECHECK_MS, MARKER_WATCH_RETRY_MS, repoKeysOf, Runtime, SESSION_ENDED, SESSION_RELAUNCHED, triageText, WAKE_MS } from '../src/runtime.js';
import type { RuntimeDeps } from '../src/runtime.js';
import { controlsOf, doneSince } from '../src/rows.js';
import { dockView } from '../src/dock.js';
import { questionIndex, QUESTIONS_SINCE } from '../src/questions.js';
import { T0, home, playbook, PLAYBOOKS, config, ok, FakeSource, issue, deferred, setup } from './runtimeFixtures.js';

describe('Runtime', () => {
  it('builds the panel snapshot', async () => {
    const { source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const snapshot = runtime.snapshot();

    expect(snapshot.workItems).toHaveLength(1);
    expect(snapshot.workItems[0]).toMatchObject({ id: 1, status: 'running', ticket: { sourceKey: '8' }, triage: { playbook: 'dev:develop' }, sessions: [{ id: 's1' }] });
    expect(snapshot.playbooks).toEqual([{ name: 'dev:develop', description: 'Build it' }]);
    expect(snapshot.repoRoots).toEqual(['D:/git/widgets']);
    expect(runtime.reportCommand).toBe(`node "${join(home, '.switchboard').replaceAll('\\', '/')}/hub.js" report`);
  });

  it('triages the pool, lists it oldest first, and starts the triaged playbook on a pick with fake runners', async () => {
    const { store, cli, source, runtime } = setup(config());
    source.result = { tickets: [{ ...issue('9'), assigned: false, pool: true, sortAt: 20, enteredAt: null }, { ...issue('8'), assigned: false, pool: true, sortAt: 10, enteredAt: null }] };
    source.context = async (ticket) => ({ context: `Issue ${ticket.sourceKey} text`, links: ticket.sourceKey === '9' ? [{ label: 'Issue #90', target: 'https://github.com/o/r/issues/90' }] : [] });

    await runtime.pollSource('github');
    await runtime.settled();

    const pool = runtime.snapshot().pool;
    expect(pool.map((entry) => [entry.ticket.sourceKey, entry.triage?.playbook])).toEqual([['8', 'dev:develop'], ['9', 'dev:develop']]);
    // A pool ticket shows the links its triage found before any session runs (PRD R61).
    expect(pool.map((entry) => entry.links.map((link) => link.target))).toEqual([[], ['https://github.com/o/r/issues/90']]);
    expect(runtime.snapshot().workItems).toEqual([]);

    expect(runtime.send({ type: 'pick', ticketId: pool[0]!.ticket.id }).refused).toBeNull();
    await runtime.settled();

    const start = cli.heldStarts[0];
    expect(start).toMatchObject({ contract: expect.stringMatching(/^Report to Switchboard with these commands:\n- .* stage s1 /), prompt: 'Build 8.' });
    expect(store.session('s1')).toMatchObject({ kind: 'task', state: 'running' });
    // After a compaction, the hook gets the contract the session started with, then the conversation rules (mechanics M30).
    expect(runtime.contract(store.session('s1')!.nativeSessionId!)?.startsWith(`${start!.contract}\n\n`)).toBe(true);
    expect(runtime.contract('not-a-switchboard-session')).toBeNull();
    expect(runtime.snapshot().pool.map((entry) => entry.ticket.sourceKey)).toEqual(['9']);
    expect(runtime.snapshot().workItems).toMatchObject([{ status: 'running', playbook: 'dev:develop', triage: { playbook: 'dev:develop' } }]);
  });

  it('runs a schedule now in its repo root, accepts its done report without a source read, and counts no earlier run as a return (PRD R82)', async () => {
    const cfg = config();
    cfg.settings.schedules = { cleanup: { playbook: 'ops:cleanup', repoRoot: 'D:/git/widgets', every: null, day: null, at: null } };
    cfg.playbooks = new Map([...PLAYBOOKS, playbook('ops:cleanup', { description: 'Remove finished worktrees', reports: ['done'], template: '/cleanup-worktrees' })]);
    const { store, cli, source, runtime } = setup(cfg);

    expect(runtime.snapshot().schedules).toEqual([{ name: 'cleanup', playbook: 'ops:cleanup' }]);

    for (const run of [1, 2]) {
      expect(runtime.send({ type: 'run-schedule', name: 'cleanup' }).refused).toBeNull();
      await runtime.settled();

      const sessionId = `s${run}`;
      const reads = source.polls;

      expect(store.session(sessionId)).toMatchObject({ cwd: 'D:/git/widgets', state: 'running' });
      expect(await runtime.report({ sessionId, kind: 'done' })).toEqual({ refused: null });
      expect(source.polls).toBe(reads);
      expect(runtime.snapshot().workItems.find((item) => item.sessions[0]?.id === sessionId)).toMatchObject({ status: 'done', returned: 0, ticket: { source: 'schedule', sourceKey: 'cleanup' } });
      runtime.send({ type: 'roster', sessions: [], checked: [sessionId] });
    }

    expect(cli.heldStarts).toHaveLength(2);
  });

  it('lists the pool oldest first with each rating, counts the started done work items of a returned ticket with the same playbook or one it is a return of, and hides a disabled source (PRD R50, R51)', async () => {
    const cfg = config();
    cfg.playbooks = new Map([...PLAYBOOKS, playbook('triage:github', { description: 'Triage', kind: 'triage', rates: true, template: 'Classify and rate.' })]);
    const { store, cli, source, runtime } = setup(cfg);
    const rated = (immediacy: string, severity: string) => ok(JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:develop', immediacy, severity } }));
    cli.classifyByContext.set(triageText('Issue 2 text', T0), rated('NON-BLOCKING', 'LOW'));
    cli.classifyByContext.set(triageText('Issue 3 text', T0), rated('BLOCKING', 'HIGH'));
    cli.classifyByContext.set(triageText('Issue 4 text', T0), rated('URGENT', 'MED'));
    const pooled = (key: string, sortAt: number) => ({ ...issue(key), assigned: false, pool: true, sortAt, enteredAt: null });
    source.result = { tickets: [pooled('1', 10), pooled('2', 20), pooled('3', 30), pooled('4', 25), pooled('5', 5)] };

    await runtime.pollSource('github');
    await runtime.settled();

    // The panel orders by importance; the snapshot keeps the source's sort time.
    expect(runtime.snapshot().pool.map((entry) => [entry.ticket.sourceKey, entry.triage?.immediacy ?? null, entry.triage?.severity ?? null])).toEqual([
      ['5', null, null],
      ['1', null, null],
      ['2', 'NON-BLOCKING', 'LOW'],
      ['4', 'URGENT', 'MED'],
      ['3', 'BLOCKING', 'HIGH'],
    ]);

    // Of four done work items, only the started one with the triaged playbook counts: one never ran a session, one's launch failed, one ran another playbook.
    const ticket = store.findTicket('github', '1')!;
    const done = { ticketId: ticket.id, playbook: 'dev:develop', status: 'done', taskPrompt: null, guidance: null, reportedPrompt: null, warning: null, error: null, unassignedAt: null, queuedAt: null, approvalPrompt: null, approvalSummary: null, approvalReport: null, approvalHeld: false, createdAt: T0, statusAt: T0, runStartedAt: null, readyAt: null, orderAt: null, scopeAt: null, doneAt: T0, doneReason: 'operator', parentId: null } as const;
    const ran = store.insertWorkItem(done);
    store.insertWorkItem(done);
    const refused = store.insertWorkItem(done);
    const review = store.insertWorkItem({ ...done, playbook: 'dev:review' });
    const session = { kind: 'task', provider: 'claude', nativeSessionId: null, cwd: 'C:/repo', state: 'ended', stateAt: T0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: T0, endedAt: T0, released: false, releasing: false, question: null, pendingFork: null, external: false, move: null, movedAt: null } as const;
    store.insertSession({ ...session, id: 'ran', workItemId: ran.id, shortId: 'abc123', reports: [], retiredIds: [] });
    store.insertSession({ ...session, id: 'refused', workItemId: refused.id, shortId: null, reports: [], retiredIds: [] });
    store.insertSession({ ...session, id: 'review', workItemId: review.id, shortId: 'def456', reports: [], retiredIds: [] });

    expect(runtime.snapshot().pool.map((entry) => [entry.ticket.sourceKey, entry.returned])).toEqual([['5', 0], ['1', 1], ['2', 0], ['4', 0], ['3', 0]]);

    // With dev:develop a return of dev:review, the started dev:review work item counts as well.
    const returning = config();
    returning.playbooks = new Map([...cfg.playbooks, playbook('dev:develop', { description: 'Build it', returnOf: ['dev:review'], template: 'Build.' })]);
    runtime.reload(returning);

    expect(runtime.snapshot().pool.find((entry) => entry.ticket.sourceKey === '1')?.returned).toBe(2);

    // A disabled source's pool is not read, so it is hidden; the filter lists it as off.
    const off = config();
    off.settings.sources['github']!.namespace = 'dev';
    runtime.reload(off);

    expect(runtime.setSourceEnabled('github', false)).toBeNull();
    expect(store.enabledSources()).toEqual(new Set());
    expect(runtime.snapshot().pool).toEqual([]);
    expect(runtime.snapshot().sourceStates).toEqual([{ name: 'github', kind: 'github', label: 'github', enabled: false }]);
    expect(runtime.snapshot().namespaces).toEqual({ github: 'dev' });
    expect(runtime.setSourceEnabled('zoho', true)).toBe('settings.json has no source named zoho.');
    expect(runtime.setSourceEnabled('adhoc', true)).toBe('settings.json has no source named adhoc.');
    expect(store.enabledSources()).toEqual(new Set());
  });

  it('gives each work item its current playbook\'s approvalSends (PRD R27)', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(runtime.snapshot().workItems.map((item) => [item.playbook, item.approvalSends])).toEqual([['dev:develop', false]]);

    const sends = config();
    sends.playbooks = new Map([...PLAYBOOKS, playbook('dev:develop', { description: 'Build it', reports: ['approval'], approvalSends: true, template: 'Build.' })]);
    runtime.reload(sends);
    expect(runtime.snapshot().workItems.map((item) => item.approvalSends)).toEqual([true]);

    // A work item with no playbook, or one whose playbook is gone, has no approval that sends.
    store.updateWorkItem(1, { playbook: 'dev:gone' });
    expect(runtime.snapshot().workItems.map((item) => item.approvalSends)).toEqual([false]);
  });

  it('lists the queue waits of a queued work item only (PRD R34)', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    // The task started, so its live session keeps the work item from starting again once it is queued.
    expect(runtime.snapshot().workItems.map((item) => [item.status, item.waits])).toEqual([['running', []]]);

    store.updateWorkItem(1, { status: 'queued', queuedAt: T0 });
    expect(runtime.snapshot().workItems[0]!.waits).toMatchObject([{ kind: 'session', sessionId: 's1', ownItem: true, playbook: null }]);
  });

  it("refuses a link report its ticket's source refuses, and logs the refusal in History (PRD R52)", async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    const checked: [string, string][] = [];
    source.checkLink = async (ticket, target) => {
      checked.push([ticket.sourceKey, target]);
      return { refused: target.endsWith('/13') ? 'Pull request #13 does not close #8.' : null };
    };

    expect(await runtime.report({ sessionId: 's1', kind: 'link', label: 'PR #13', target: 'https://github.com/o/r/pull/13' })).toEqual({ refused: 'Pull request #13 does not close #8.' });
    expect(await runtime.report({ sessionId: 's1', kind: 'link', label: 'PR #12', target: 'https://github.com/o/r/pull/12' })).toEqual({ refused: null });
    expect(checked).toEqual([['8', 'https://github.com/o/r/pull/13'], ['8', 'https://github.com/o/r/pull/12']]);
    expect(store.linksFor(1).map((link) => link.target)).toEqual(['https://github.com/o/r/pull/12']);
    expect(store.ticketHistory(1)!.events.find((event) => event.refused !== null && event.type === 'report')).toMatchObject({ sessionId: 's1', detail: { kind: 'link', label: 'PR #13', target: 'https://github.com/o/r/pull/13' }, refused: 'Pull request #13 does not close #8.' });
  });

  it('accepts a link report unchecked when the check fails, throws or outlasts REPORT_CHECK_MS', async () => {
    const { store, source, runtime, logs, late } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    source.checkLink = async () => ({ error: 'GitHub is down.' });
    expect(await runtime.report({ sessionId: 's1', kind: 'link', label: 'PR #12', target: 'https://github.com/o/r/pull/12' })).toEqual({ refused: null });
    source.checkLink = async () => {
      throw new Error('boom');
    };
    expect(await runtime.report({ sessionId: 's1', kind: 'link', label: 'PR #13', target: 'https://github.com/o/r/pull/13' })).toEqual({ refused: null });
    source.checkLink = () => new Promise(() => {});
    const report = runtime.report({ sessionId: 's1', kind: 'link', label: 'PR #14', target: 'https://github.com/o/r/pull/14' });
    late.resolve();

    expect(await report).toEqual({ refused: null });
    expect(store.linksFor(1).map((link) => link.label)).toEqual(['PR #12', 'PR #13', 'PR #14']);
    expect(logs).toEqual(
      expect.arrayContaining([
        'link report for #8 accepted unchecked: GitHub is down.',
        'link report for #8 accepted unchecked: the check failed',
        'link report for #8 accepted unchecked: the github check took over 6 seconds',
      ]),
    );
  });

  it('lists a done work item from the Monday two weeks before this week, and not before (PRD R27)', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    store.updateWorkItem(1, { status: 'done', doneAt: doneSince(T0), doneReason: 'operator' });
    expect(runtime.snapshot().workItems.map((item) => item.id)).toEqual([1]);

    store.updateWorkItem(1, { doneAt: doneSince(T0) - 1 });
    expect(runtime.snapshot().workItems).toEqual([]);
  });

  it('records a link report and lists the ticket links and earlier work items, with those of playbooks it is a return of, on the work item (PRD R51, R52)', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(await runtime.report({ sessionId: 's1', kind: 'link', label: 'PR #12', target: 'https://github.com/o/r/pull/12' })).toEqual({ refused: null });
    expect(await runtime.report({ sessionId: 'nope', kind: 'link', label: 'x', target: 'https://x' })).toEqual({ refused: 'Unknown session nope.' });
    expect(runtime.snapshot().workItems[0]).toMatchObject({ returned: 0, links: [{ label: 'PR #12', target: 'https://github.com/o/r/pull/12' }] });

    // The started earlier work item is counted after it leaves the Done list; work item 2 started no session, so it is not.
    // Work item 4 has another playbook, so the earlier started work item does not count for it.
    const { id: _id, ...first } = store.workItem(1)!;
    store.updateWorkItem(1, { status: 'done', doneAt: T0 - 30 * 86_400_000, doneReason: 'operator' });
    store.insertWorkItem({ ...first, status: 'triaging', createdAt: T0 });
    store.insertWorkItem({ ...first, status: 'triaging', createdAt: T0 });
    store.insertWorkItem({ ...first, playbook: 'dev:review', status: 'triaging', createdAt: T0 });

    expect(runtime.snapshot().workItems.map((item) => [item.id, item.playbook, item.returned, item.links.length])).toEqual([
      [4, 'dev:review', 0, 1],
      [3, 'dev:develop', 1, 1],
      [2, 'dev:develop', 1, 1],
    ]);

    // A playbook that is a return of dev:develop counts its started work items too.
    const cfg = config();
    cfg.playbooks = new Map([...PLAYBOOKS, playbook('dev:review', { description: 'Review it', returnOf: ['dev:develop'], template: 'Review.' })]);
    runtime.reload(cfg);

    expect(runtime.snapshot().workItems.map((item) => [item.id, item.returned])).toEqual([[4, 1], [3, 1], [2, 1]]);

    // Counting runs one way: a later dev:develop work item does not count the started dev:review one.
    store.insertSession({ id: 'review', workItemId: 4, shortId: 'def456', kind: 'task', provider: 'claude', nativeSessionId: null, cwd: 'C:/repo', state: 'ended', stateAt: T0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: T0, endedAt: T0, released: false, releasing: false, question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null });
    const later = store.insertWorkItem({ ...first, status: 'triaging', createdAt: T0 });

    expect(runtime.snapshot().workItems.find((item) => item.id === later.id)?.returned).toBe(1);
  });

  it('turns off a source that was removed from settings.json, so adding it again starts it off, and keeps it while the file is invalid', () => {
    const { store, runtime } = setup();
    const removed = config();
    removed.settings.sources = {};

    runtime.reload({ ...removed, settingsError: 'sessions.concurrency must be a whole number from 1 to 10.' });
    expect(store.enabledSources()).toEqual(new Set(['github']));

    runtime.reload(removed);
    expect(store.enabledSources()).toEqual(new Set());

    runtime.reload(config());
    expect(runtime.snapshot().sourceStates).toEqual([{ name: 'github', kind: 'github', label: 'github', enabled: false }]);
  });

  it('reports a source whose kind has no plugin', () => {
    const cfg = config();
    cfg.settings.sources['jira'] = { ...cfg.settings.sources['github']!, kind: 'jira' };
    const { runtime } = setup(cfg);

    expect(runtime.snapshot().errors.sources).toEqual({ jira: 'Switchboard has no source kind jira.' });
  });

  it('polls a second source of one kind under its own name, with its own tickets and toggle (PRD R3)', async () => {
    const cfg = config();
    cfg.settings.sources['widgets-dashboard'] = { ...cfg.settings.sources['github']!, repoRoot: 'D:/git/widgets-dashboard' };
    const dashboard = new FakeSource();
    const { runtime, store, source } = setup(cfg, undefined, undefined, undefined, { 'widgets-dashboard': dashboard });

    expect(runtime.snapshot().sourceStates).toEqual([
      { name: 'github', kind: 'github', label: 'github', enabled: true },
      { name: 'widgets-dashboard', kind: 'github', label: 'github', enabled: true },
    ]);

    source.result = { tickets: [issue('63')] };
    dashboard.result = { tickets: [{ ...issue('63'), title: 'Dashboard 63', url: 'https://github.com/o/dashboard/issues/63' }] };
    await runtime.pollSource('github');
    await runtime.pollSource('widgets-dashboard');

    expect(store.findTicket('github', '63')).toMatchObject({ title: 'Issue 63' });
    expect(store.findTicket('widgets-dashboard', '63')).toMatchObject({ title: 'Dashboard 63' });

    expect(runtime.setSourceEnabled('widgets-dashboard', false)).toBeNull();
    expect(runtime.snapshot().sources).toEqual(['github']);
    expect(runtime.snapshot().errors.sources).toEqual({});
  });

  it('leaves an issue on two boards with the source that stored it first and logs it once, even after that source is turned off (PRD R44)', async () => {
    const cfg = config();
    cfg.settings.sources['personal'] = { ...cfg.settings.sources['github']! };
    const personal = new FakeSource();
    const { runtime, store, source, logs } = setup(cfg, undefined, undefined, undefined, { personal });
    const owned = (line: string) => line.includes('belongs to');
    const shared = { ...issue('63'), url: 'https://github.com/Acme/Widgets/issues/63' };

    source.result = { tickets: [{ ...shared, url: 'https://github.com/acme/widgets/issues/63' }] };
    personal.result = { tickets: [{ ...shared, sourceKey: 'acme/widgets#63' }, issue('4')] };
    await runtime.pollSource('github');
    await runtime.pollSource('personal');

    expect(store.tickets('personal').map((ticket) => ticket.sourceKey)).toEqual(['4']);
    expect(logs.filter(owned)).toEqual(['personal: https://github.com/Acme/Widgets/issues/63 belongs to github, so personal leaves it out.']);
    expect(runtime.snapshot().errors.sources).toEqual({});

    expect(runtime.setSourceEnabled('github', false)).toBeNull();
    await runtime.pollSource('personal');
    expect(store.tickets('personal').map((ticket) => ticket.sourceKey)).toEqual(['4']);
    // Logged once per issue, not on every poll.
    expect(logs.filter(owned)).toHaveLength(1);
  });

  it('keeps one ticket for an issue two overlapping polls list, whichever stores it first (PRD R44)', async () => {
    const cfg = config();
    cfg.settings.sources['personal'] = { ...cfg.settings.sources['github']! };
    const personal = new FakeSource();
    const { runtime, store, source, logs } = setup(cfg, undefined, undefined, undefined, { personal });
    const shared = { ...issue('63'), url: 'https://github.com/acme/widgets/issues/63' };
    const slow = deferred();

    source.gate = slow.promise;
    source.result = { tickets: [shared] };
    personal.result = { tickets: [{ ...shared, sourceKey: 'acme/widgets#63' }] };
    const first = runtime.pollSource('github');
    await vi.waitFor(() => expect(source.polls).toBe(1));
    await runtime.pollSource('personal');
    slow.resolve();
    await first;

    expect([...store.tickets('github'), ...store.tickets('personal')].map((ticket) => `${ticket.source} ${ticket.sourceKey}`)).toEqual(['personal acme/widgets#63']);
    expect(logs.filter((line) => line.includes('belongs to'))).toEqual(['github: https://github.com/acme/widgets/issues/63 belongs to personal, so github leaves it out.']);
  });

  it("fails a start in a pattern's folder that holds no clone, naming the repository, and starts one that does (PRD R21)", async () => {
    const root = mkdtempSync(join(tmpdir(), 'switchboard-clone-'));
    const forward = root.split(String.fromCharCode(92)).join('/');
    try {
      const cfg = config();
      cfg.settings.sources['github'] = { ...cfg.settings.sources['github']!, repoRoot: `${forward}/{name}`, options: { repo: 'acme/widgets' } };
      mkdirSync(join(root, 'widgets'));
      const { runtime, store, source } = setup(cfg);
      source.result = { tickets: [{ ...issue('7'), repo: 'acme/widgets' }] };
      runtime.send({ type: 'poll', source: 'github', tickets: source.result.tickets });
      await runtime.settled();
      runtime.send({ type: 'triage-succeeded', triageId: 1, context: 'c', playbook: 'dev:develop', immediacy: null, severity: null, model: null });
      await runtime.settled();

      expect(store.workItem(1)).toMatchObject({ status: 'failed', error: `No clone of acme/widgets at ${forward}/widgets.` });

      mkdirSync(join(root, 'widgets', '.git'));
      runtime.send({ type: 'retry', workItemId: 1 });
      await runtime.settled();
      expect(store.workItem(1)?.status).not.toBe('failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("links worktrees in each open repository's resolved root by that repository's branches (PRD R25)", async () => {
    const cfg = config();
    cfg.settings.sources['github'] = { ...cfg.settings.sources['github']!, repoRoot: 'D:/git/{name}', options: { repo: 'acme/widgets' } };
    const { cli, source, runtime, store } = setup(cfg);
    source.result = { tickets: [{ ...issue('acme/widgets-dashboard#7'), repo: 'acme/widgets-dashboard' }] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(cli.gitCwds.slice(0, 2)).toEqual(['D:/git/widgets', 'D:/git/widgets-dashboard']);
    expect(source.branchRepos).toContain('acme/widgets-dashboard');
    // The fake clone's branch 7-fix is the dashboard's 7, not the home repository's.
    expect(store.findTicket('github', '7')).toBeNull();
    expect(store.worktreeFor(store.findTicket('github', 'acme/widgets-dashboard#7')!.id)).toMatchObject({ branch: '7-fix' });
  });

  it('gives rows short keys for other repositories: a label, else a unique name, else owner/name#n (PRD R27)', () => {
    const settings = { ...config().settings };
    settings.sources = {
      github: { ...settings.sources['github']!, options: { repo: 'acme/widgets', labels: { 'Acme/Widgets-Dashboard': 'dash' } } },
      personal: { ...settings.sources['github']!, options: { repo: 'work-login/switchboard' } },
    };

    expect(repoKeysOf(settings, { github: ['acme/widgets', 'acme/widgets-test', 'alice/tools'], personal: ['work-login/switchboard', 'bob/tools'] })).toEqual({
      homes: { github: 'acme/widgets', personal: 'work-login/switchboard' },
      prefixes: { 'acme/widgets-dashboard': 'dash', 'acme/widgets': 'widgets', 'acme/widgets-test': 'widgets-test', 'work-login/switchboard': 'switchboard' },
    });
  });
});
