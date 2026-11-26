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
import { T0, home, playbook, PLAYBOOKS, config, fail, issue, deferred, setup, appServerRunner } from './runtimeFixtures.js';

describe('handled assignment reports', () => {
  const url = 'https://github.com/acme/widgets/issues/7';
  const lookup = (key: string | null = 'I:A', assigned = true) => ({ ticket: { sourceKey: '7', ref: '#7', repo: '', title: 'Fix', url, open: true }, assignmentKey: key, assigned });
  async function ready() {
    const h = setup();
    h.runtime.send({ type: 'adhoc', prompt: 'Prepare a fix', repoRoot: 'D:/repo', start: true });
    await h.runtime.settled();
    h.source.assignmentAt = vi.fn(async () => lookup());
    return h;
  }

  it('registers, reads targets absent from search, and admits a reassignment between polls', async () => {
    const { runtime, store, source } = await ready();
    expect(await runtime.handled('s1', url, null)).toEqual({ assignmentKey: 'I:A' });
    const ticket = store.findTicket('github', '7')!;
    await runtime.pollSource('github');
    expect(store.ticket(ticket.id)).toMatchObject({ assigned: true, handledAssignmentKey: 'I:A' });
    expect(store.workItemsForTicket(ticket.id)).toHaveLength(0);
    source.assignmentAt = async () => lookup('I:B');
    await runtime.pollSource('github');
    await runtime.settled();
    expect(store.ticket(ticket.id)?.handledAssignmentKey).toBeNull();
    expect(store.workItemsForTicket(ticket.id)).toHaveLength(1);
    runtime.stop(); store.close();
  });

  it("rereads a registered ticket through its own source whatever board it is on, so leaving the board does not fail the poll (PRD R85)", async () => {
    const { runtime, store, source } = await ready();
    expect(await runtime.handled('s1', url, null)).toEqual({ assignmentKey: 'I:A' });
    expect(source.assignmentAt).toHaveBeenLastCalledWith(url, false);
    source.assignmentAt = vi.fn(async (_url: string, anyBoard?: boolean) => (anyBoard === true ? lookup('I:A', false) : null));
    await runtime.pollSource('github');

    expect(source.assignmentAt).toHaveBeenCalledWith(url, true);
    expect(runtime.snapshot().errors.sources).toEqual({});
    expect(store.findTicket('github', '7')).toMatchObject({ assigned: false, handledAssignmentKey: 'I:A' });

    // The owning source releases it off the board, too.
    expect(await runtime.handled('s1', url, 'I:A')).toEqual({ assignmentKey: null });
    expect(store.findTicket('github', '7')).toMatchObject({ handledAssignmentKey: null });
    runtime.stop(); store.close();
  });

  it('uses fresh eligibility on release instead of stale stored assignment', async () => {
    const { runtime, store, source } = await ready();
    await runtime.handled('s1', url, null);
    await runtime.pollSource('github');
    source.assignmentAt = async () => lookup(null, false);
    expect(await runtime.handled('s1', url, 'I:A')).toEqual({ assignmentKey: null });
    const ticket = store.findTicket('github', '7')!;
    expect(store.ticket(ticket.id)).toMatchObject({ assigned: false, handledAssignmentKey: null });
    expect(store.workItemsForTicket(ticket.id)).toHaveLength(0);
    runtime.stop(); store.close();
  });

  it('keeps every ticket unchanged when a handled assignment read fails', async () => {
    const { runtime, store, source } = await ready();
    await runtime.handled('s1', url, null);
    await runtime.pollSource('github');
    const ticket = store.findTicket('github', '7')!;
    source.result = { tickets: [issue('9')] };
    source.assignmentAt = async () => ({ error: 'offline' });
    await runtime.pollSource('github');
    expect(store.ticket(ticket.id)).toMatchObject({ assigned: true, handledAssignmentKey: 'I:A' });
    expect(store.findTicket('github', '9')).toBeNull();
    expect(await runtime.handled('s1', url, null)).toEqual({ refused: 'offline' });
    runtime.stop(); store.close();
  });

  it('does not apply a timed-out registration when the lookup eventually returns', async () => {
    const { runtime, store, source, late } = await ready();
    const gate = deferred();
    source.assignmentAt = async () => { await gate.promise; return lookup(); };
    const report = runtime.handled('s1', url, null);
    late.resolve();
    expect(await report).toHaveProperty('refused');
    gate.resolve();
    await runtime.settled();
    expect(store.findTicket('github', '7')).toBeNull();
    runtime.stop(); store.close();
  });

  it('serializes a registration lookup with polling', async () => {
    const { runtime, store, source } = await ready();
    const entered = deferred();
    const gate = deferred();
    source.assignmentAt = async () => { entered.resolve(); await gate.promise; return lookup(); };
    const report = runtime.handled('s1', url, null);
    await entered.promise;
    await runtime.pollSource('github');
    expect(source.polls).toBe(0);
    gate.resolve();
    expect(await report).toEqual({ assignmentKey: 'I:A' });
    await runtime.pollSource('github');
    expect(store.workItemsForTicket(store.findTicket('github', '7')!.id)).toHaveLength(0);
    runtime.stop(); store.close();
  });

  it('refuses unsupported, unassigned and closed targets', async () => {
    const { runtime, store, source } = await ready();
    source.assignmentAt = async () => null;
    expect(await runtime.handled('s1', url, null)).toHaveProperty('refused');
    source.assignmentAt = async () => lookup(null);
    expect(await runtime.handled('s1', url, null)).toHaveProperty('refused');
    source.assignmentAt = async () => ({ ...lookup(), ticket: { ...lookup().ticket, open: false } });
    expect(await runtime.handled('s1', url, null)).toHaveProperty('refused');
    expect(store.findTicket('github', '7')).toBeNull();
    runtime.stop(); store.close();
  });
});

describe('Runtime', () => {
  it('triages with the default provider, falls back from a mismatched model, and follows a provider reload', async () => {
    const cfg = config({ provider: 'codex' });
    cfg.settings.triage = { ...cfg.settings.triage, model: 'claude-sonnet-5-5' };
    const { store, cli, source, runtime, logs } = setup(cfg);
    source.result = { tickets: [issue('7')] };
    await runtime.pollSource('github');
    await runtime.settled();
    const codexCall = cli.calls.find((call) => call.includes('--output-schema'));
    expect(codexCall?.[0]).toBe('codex');
    expect(codexCall).not.toContain('--model');
    expect(cli.calls.some((call) => call.includes('-p'))).toBe(false);
    expect(store.triage(1)).toMatchObject({ playbook: 'dev:develop', model: null, error: null });
    expect(logs).toContain("triage: the model claude-sonnet-5-5 is not a Codex model, so triage uses Codex's default. Change Settings › Triage › Model.");

    runtime.reload({ ...cfg, settings: { ...cfg.settings, sessions: { ...cfg.settings.sessions, provider: 'claude' } } });
    source.result = { tickets: [issue('7'), issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    expect(cli.calls.find((call) => call.includes('-p'))?.slice(-2)).toEqual(['--model', 'claude-sonnet-5-5']);
    expect(store.triage(2)).toMatchObject({ playbook: 'dev:develop', model: 'claude-sonnet-5-5', error: null });
  });

  it('records Codex triage failures without invoking Claude', async () => {
    const { store, cli, source, runtime } = setup(config({ provider: 'codex' }));
    cli.codexClassifyResult = fail('Codex quota exhausted');
    source.result = { tickets: [issue('7')] };
    await runtime.pollSource('github');
    await runtime.settled();
    expect(store.triage(1)?.error).toBe('Codex quota exhausted');
    expect(store.workItem(1)?.status).toBe('failed');
    expect(cli.calls.some((call) => call.includes('-p'))).toBe(false);
  });
  it('wakes a due snooze on its minute tick, without any other event', async () => {
    vi.useFakeTimers();
    try {
      let now = T0;
      const { store, source, runtime } = setup(config(), () => now);
      source.result = { tickets: [issue('5')] };
      store.insertTicket({ source: 'github', sourceKey: '5', ref: '#5', repo: '', sourceId: null, title: 'Issue 5', url: 'u', assigned: true, pool: false, snoozed: true, snoozedUntil: T0 + WAKE_MS, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
      let changes = 0;
      runtime.onChange(() => changes++);
      runtime.start();

      now = T0 + WAKE_MS - 1;
      await vi.advanceTimersByTimeAsync(WAKE_MS - 1);
      expect(store.ticket(1)).toMatchObject({ snoozed: true, snoozedUntil: T0 + WAKE_MS });

      now = T0 + WAKE_MS;
      await vi.advanceTimersByTimeAsync(1);
      expect(store.ticket(1)).toMatchObject({ snoozed: false, snoozedUntil: null });
      expect(changes).toBeGreaterThan(0);
      runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });


  it('reads the pull requests of open work items in each poll and again when a window comes to the front, and shows them on their links (PRD R92)', async () => {
    let now = T0;
    const { store, source, runtime } = setup(config(), () => now);
    const asked: string[][] = [];
    const statuses: Record<string, PullRequestStatus> = { 'https://github.com/acme/widgets/pull/12': { state: 'open', review: 'changes-requested', checks: 'failing' } };

    source.pullRequests = async (urls) => {
      asked.push([...urls]);
      return { statuses };
    };
    source.result = { tickets: [issue('7')] };
    await runtime.pollSource('github');
    await runtime.settled();
    // No pull request linked yet: nothing to read.
    expect(asked).toEqual([]);
    store.addLink({ ticketId: 1, label: 'PR', target: 'https://github.com/acme/widgets/pull/12', reportedAt: T0, mentioned: false });
    store.addLink({ ticketId: 1, label: 'Issue', target: 'https://github.com/acme/widgets/issues/3', reportedAt: T0, mentioned: false });
    await runtime.pollSource('github');
    await runtime.settled();
    expect(asked).toEqual([['https://github.com/acme/widgets/pull/12']]);
    expect(dockView(runtime.snapshot(), now, 'W').groups.flatMap((group) => group.rows).find((row) => row.key === 'item:1')?.links.find((link) => link.kind === 'pr')?.pr).toEqual({ state: 'open', review: 'changes-requested', checks: 'failing' });

    // A window in front reads them again, at most every 30 seconds.
    statuses['https://github.com/acme/widgets/pull/12'] = { state: 'merged', review: 'approved', checks: 'passing' };
    runtime.refreshPullRequests();
    await runtime.settled();
    runtime.refreshPullRequests();
    await runtime.settled();
    expect(asked).toHaveLength(2);
    expect(runtime.snapshot().pullRequests?.['https://github.com/acme/widgets/pull/12']?.state).toBe('merged');
    // A merged pull request is not read again.
    now += PULL_REQUESTS_FOCUS_MS;
    runtime.refreshPullRequests();
    await runtime.settled();
    expect(asked).toHaveLength(2);
    // A ticket that left the poll keeps its open work item's pull request read.
    store.addLink({ ticketId: 1, label: 'PR 3', target: 'https://github.com/acme/widgets/pull/14', reportedAt: T0, mentioned: false });
    source.result = { tickets: [] };
    await runtime.pollSource('github');
    await runtime.settled();
    expect(store.workItem(1)?.status).not.toBe('done');
    expect(asked.at(-1)).toEqual(['https://github.com/acme/widgets/pull/14']);
    source.result = { tickets: [issue('7')] };
    // A failed read keeps what was read.
    store.addLink({ ticketId: 1, label: 'PR 2', target: 'https://github.com/acme/widgets/pull/13', reportedAt: T0, mentioned: false });
    source.pullRequests = async () => ({ error: 'GitHub did not answer within 30 seconds.' });
    await runtime.pollSource('github');
    await runtime.settled();
    expect(runtime.snapshot().pullRequests?.['https://github.com/acme/widgets/pull/12']?.state).toBe('merged');
  });

  it("lists worktrees in the home repository's resolved root and offers no pattern as a repo root (PRD R6, R25)", async () => {
    const cfg = config();
    cfg.settings.sources['github'] = { ...cfg.settings.sources['github']!, repoRoot: 'D:/git/{name}', options: { repo: 'acme/widgets' } };
    const { store, cli, source, runtime } = setup(cfg);
    source.result = { tickets: [{ ...issue('7'), repo: 'acme/widgets' }] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(cli.gitCwds[0]).toBe('D:/git/widgets');
    expect(store.worktreeFor(1)).toMatchObject({ path: 'D:/git/widgets-wt/7-fix', linkedBy: 'convention' });
    expect(runtime.snapshot().repoRoots).toEqual(['D:/git/widgets']);
  });

  it('sends no worktree-found event for a ticket whose worktree is linked, so a poll rebuilds the views once', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('7')] };
    await runtime.pollSource('github');
    await runtime.settled();
    expect(store.worktreeFor(1)).toMatchObject({ path: 'D:/git/widgets-wt/7-fix', linkedBy: 'convention' });

    let changes = 0;
    runtime.onChange(() => changes++);
    await runtime.pollSource('github');
    await runtime.settled();

    expect(changes).toBe(1);
  });

  it('polls, triages through the source and classifier, and starts the chosen playbook', async () => {
    const { store, cli, source, runtime } = setup();
    let changes = 0;
    runtime.onChange(() => changes++);
    source.result = { tickets: [issue('7')] };
    source.context = async (ticket) => ({ context: `Issue ${ticket.sourceKey} text`, links: [{ label: 'Pull request #70', target: 'https://github.com/o/r/pull/70' }] });

    await runtime.pollSource('github');
    await runtime.settled();

    expect(store.linksFor(1)).toMatchObject([{ label: 'Pull request #70', target: 'https://github.com/o/r/pull/70' }]);
    const classifyCall = cli.calls.find((call) => call[1] === '-p');
    expect(classifyCall?.at(-1)).toContain('Classify.');
    expect(store.triage(1)?.context).toBe('Current time: 2026-10-03 12:00 UTC\n\nIssue 7 text');
    expect(store.triage(1)).toMatchObject({ playbook: 'dev:develop' });
    expect(store.session('s1')).toMatchObject({ shortId: '00000001', nativeSessionId: '00000001-native', state: 'running', cwd: 'D:/git/widgets-wt/7-fix' });
    expect(store.workItem(1)?.status).toBe('running');
    expect(store.worktreeFor(1)).toMatchObject({ path: 'D:/git/widgets-wt/7-fix', branch: '7-fix', linkedBy: 'convention' });
    expect(cli.calls.find((call) => call[0] === 'git')).toEqual(['git', 'worktree', 'list', '--porcelain']);
    expect(changes).toBeGreaterThan(3);

    // The next poll gets the tickets the store lists as current, so a source can read again one its search omits (mechanics M46).
    source.result = { tickets: [] };
    await runtime.pollSource('github');
    await runtime.pollSource('github');
    expect(source.current).toEqual([[], ['7'], []]);
  });

  it('logs a context warning and still triages', async () => {
    const { store, source, runtime, logs } = setup();
    source.result = { tickets: [issue('7')] };
    source.context = async (ticket) => ({ context: `Issue ${ticket.sourceKey} text`, warning: 'Roles file r.json is not JSON.' });

    await runtime.pollSource('github');
    await runtime.settled();

    expect(logs).toContain('triage context for #7: Roles file r.json is not JSON.');
    expect(store.triage(1)).toMatchObject({ playbook: 'dev:develop', error: null });
  });

  it('records a failed poll and a failed triage', async () => {
    const { store, cli, source, runtime } = setup();

    source.result = { error: 'The GitHub CLI is not signed in. Run gh auth login.' };
    await runtime.pollSource('github');
    expect(runtime.snapshot().errors.sources).toEqual({ github: 'The GitHub CLI is not signed in. Run gh auth login.' });

    source.result = { tickets: [issue('7')] };
    source.context = async () => ({ context: 'Issue 7 text', links: [{ label: 'Pull request #70', target: 'https://github.com/o/r/pull/70' }] });
    cli.classifyResult = fail('API Error: 529');
    await runtime.pollSource('github');
    await runtime.settled();

    expect(runtime.snapshot().errors.sources).toEqual({});
    expect(store.workItem(1)).toMatchObject({ status: 'failed', error: 'API Error: 529' });
    expect(store.linksFor(1)).toEqual([]);

    source.context = async () => ({ error: 'Issue 7 was not found in acme/widgets.' });
    runtime.send({ type: 'retry', workItemId: 1 });
    await runtime.settled();
    expect(store.workItem(1)).toMatchObject({ status: 'failed', error: 'Issue 7 was not found in acme/widgets.' });
  });

  it('names what a hub restart waits for: a session the holder is starting, and nothing once settled', async () => {
    const { store, source, runtime } = setup();

    expect(runtime.restartBlocker()).toBeNull();

    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    expect(runtime.restartBlocker()).toBe('a session is starting');

    await runtime.settled();
    expect(store.session('s1')?.state).not.toBe('starting');
    expect(runtime.restartBlocker()).toBeNull();

    store.updateSession('s1', { state: 'starting' });
    expect(runtime.restartBlocker()).toBe('a session is starting');
  });

  it("fails a start with Claude's message", async () => {
    const { store, cli, source, runtime } = setup();
    cli.startResult = fail('Workspace not trusted. Run `claude` in D:\\git\\widgets once and accept the trust prompt, then retry.');
    source.result = { tickets: [issue('8')] };

    await runtime.pollSource('github');
    await runtime.settled();

    expect(store.workItem(1)).toMatchObject({ status: 'failed', error: 'Workspace not trusted. Run `claude` in D:\\git\\widgets once and accept the trust prompt, then retry.' });
  });

  it('observes markers and the roster, keeps a held session after its turn, and ends sessions that leave the roster', async () => {
    const { store, cli, source, runtime } = setup(config({ installHooks: true }));
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    mkdirSync(join(home, '.switchboard', 'activity'), { recursive: true });
    writeFileSync(join(home, '.switchboard', 'activity', '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'PermissionRequest' }));
    runtime.readMarkers();
    expect(store.session('s1')?.state).toBe('waiting');

    writeFileSync(join(home, '.switchboard', 'activity', '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'Stop', backgroundTasks: 0 }));
    await runtime.readRoster();
    await runtime.settled();

    expect(cli.calls.filter((call) => call[1] === 'stop')).toEqual([]);
    expect(store.session('s1')).toMatchObject({ state: 'idle', released: false });
    expect(store.workItem(1)).toMatchObject({ status: 'blocked', error: 'The session finished its turn without reporting done.' });

    cli.roster = [];
    await runtime.readRoster();
    expect(store.session('s1')).toMatchObject({ state: 'ended', released: true });
    expect(runtime.hasActiveSessions()).toBe(false);
  });

  it('reads the activity folder once for every runner in a marker read', () => {
    const dir = join(home, '.switchboard', 'activity');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ sessionId: 'a', event: 'Stop' }));
    const seen: string[][] = [];
    const reading = (write: boolean): SessionRunner['markers'] => () => {
      seen.push([...readMarkers(join(home, '.switchboard')).keys()]);
      // A marker written after the first runner's read is left to the next marker read.
      if (write) writeFileSync(join(dir, 'b.json'), JSON.stringify({ sessionId: 'b', event: 'Stop' }));
      return new Map();
    };
    const { runtime } = setup(config({ installHooks: true }), () => T0, { claude: { ...appServerRunner(), markers: reading(true) }, codeMode: { ...appServerRunner(), markers: reading(false) } });

    runtime.readMarkers();
    expect(seen).toEqual([['a'], ['a']]);

    runtime.readMarkers();
    expect(seen.slice(2).map((keys) => keys.sort())).toEqual([['a', 'b'], ['a', 'b']]);
  });

  it('reads a marker as soon as the hook writes it, before the marker timer fires', async () => {
    const { store, source, runtime } = setup(config({ installHooks: true }));
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    runtime.start();

    try {
      writeFileSync(join(home, '.switchboard', 'activity', '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'PermissionRequest' }));
      await vi.waitFor(() => expect(store.session('s1')?.state).toBe('waiting'), { timeout: MARKER_MS / 2 });

      writeFileSync(join(home, '.switchboard', 'activity', '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'PostToolUse', toolName: 'AskUserQuestion' }));
      await vi.waitFor(() => expect(store.session('s1')?.state).toBe('running'), { timeout: MARKER_MS / 2 });
    } finally {
      runtime.stop();
    }
  });

  it('watches the activity folder again after it is removed', async () => {
    const { store, source, runtime, logs } = setup(config({ installHooks: true }));
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    runtime.start();

    try {
      const dir = join(home, '.switchboard', 'activity');
      // Made again at once, so only the folder's identity shows the watch is stale.
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
      writeFileSync(join(dir, 'other.json'), '{}');
      await vi.waitFor(() => expect(logs).toContain('marker watch stopped: the activity folder was removed or replaced'), { timeout: MARKER_MS / 2 });
      // The retry, MARKER_WATCH_RETRY_MS later, watches the new folder.
      await vi.waitFor(() => expect([runtime['markerWatchRetry'], runtime['markerWatcher'] !== null]).toEqual([null, true]), { timeout: MARKER_WATCH_RETRY_MS * 4 });

      writeFileSync(join(dir, '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'PermissionRequest' }));
      await vi.waitFor(() => expect(store.session('s1')?.state).toBe('waiting'), { timeout: MARKER_MS / 2 });
    } finally {
      runtime.stop();
    }
  }, MARKER_MS + MARKER_WATCH_RETRY_MS * 4 + 2_000);

  it('reads the roster when a session that ended writes a marker, so a session resumed outside the holder returns to Working at once', async () => {
    let now = T0;
    const { store, cli, source, runtime } = setup(config({ installHooks: true }), () => now);
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    // A session Switchboard does not hold, which Claude's roster follows, as an earlier hub's background session (PRD R93).
    store.updateSession('s1', { codeMode: false, launchId: null, released: true });

    const dir = join(home, '.switchboard', 'activity');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'Stop', backgroundTasks: 0, at: T0 }));
    cli.roster = [];
    await runtime.readRoster();
    await runtime.settled();
    expect(store.session('s1')?.state).toBe('ended');
    expect(store.workItem(1)?.status).toBe('blocked');

    // Each marker reads the roster once, so a marker left by a process that is gone reads it once only.
    const reads = () => cli.calls.filter((call) => call[1] === 'agents').length;
    const before = reads();
    runtime.readMarkers();
    await vi.waitFor(() => expect(reads()).toBe(before + 1));
    await runtime.settled();
    runtime.readMarkers();
    // Nothing to wait for: a window of 20 ms shows no second read.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.settled();
    expect(reads()).toBe(before + 1);
    expect(store.session('s1')?.state).toBe('ended');

    // The marker time is the hook's clock, so a resume counts even when it is earlier than the hub's end time.
    now = T0 + 60_000;
    cli.roster = [{ id: '00000001', sessionId: '00000001-native', pid: 200, kind: 'interactive', status: 'busy' }];
    writeFileSync(join(dir, '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'UserPromptSubmit', at: T0 - 1 }));
    runtime.readMarkers();
    await vi.waitFor(() => expect(store.workItem(1)?.status).toBe('running'));
    expect(store.session('s1')?.state).toBe('running');
  });

  it('takes in the hook markers after worktree discovery, so a marker written during it is not overwritten', async () => {
    const cfg = config({ installHooks: true });
    cfg.settings.sources['github']!.setupPrompt = '/init-worktree {{ticket.sourceKey}}';
    cfg.playbooks = new Map([...PLAYBOOKS, playbook('dev:develop', { description: 'Build it', autoStart: true, requiresWorktree: true, template: 'Build.' })]);
    const { runtime, store, cli, source } = setup(cfg);
    cli.worktrees = 'worktree D:/git/widgets\nHEAD abc\nbranch refs/heads/master\n';
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const dir = join(home, '.switchboard', 'activity');
    const write = (event: string, at: number) => writeFileSync(join(dir, '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event, at, backgroundTasks: 0 }));

    mkdirSync(dir, { recursive: true });
    write('Stop', 1);
    const entered = deferred();
    const gate = deferred();
    cli.gitEntered = entered.resolve;
    cli.gitGate = gate.promise;
    const read = runtime.readRoster();
    await entered.promise;
    write('UserPromptSubmit', 2);
    runtime.readMarkers();
    expect(store.session('s1')?.state).toBe('running');

    gate.resolve();
    await read;
    await runtime.settled();
    expect(store.session('s1')).toMatchObject({ state: 'running', released: false, releasing: false, question: null });
    runtime.stop();
  });

  it('leaves a marker reading that needs the roster read to it, without changing the session', async () => {
    const real = new ClaudeRunner({ claudePath: () => 'claude', exec: async () => ({ code: 0, stdout: '[]', stderr: '', missing: false, timedOut: false }), now: () => T0, home, claudeSettings: join(home, '.claude', 'settings.json'), hooks: () => true, nodePath: () => 'node' });
    const roster = deferred();
    let reads = 0;
    const runner: SessionRunner = Object.assign(Object.create(real) as SessionRunner, {
      start: async () => ({ shortId: 'abc', nativeSessionId: 'native-1' }),
      markers: () => new Map([['native-1', { at: 1, observed: { state: 'idle' as const, detail: null }, recheck: true }]]),
      observe: async (sessions: Session[]) => {
        reads += 1;
        await roster.promise;
        return { sessions: sessions.map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) };
      },
    });
    const { runtime, store } = setup(config(), () => T0, { codeMode: runner });

    runtime.send({ type: 'adhoc', prompt: 'test', repoRoot: 'D:/git/widgets', start: true });
    await runtime.settled();
    runtime.readMarkers();
    await new Promise((done) => setImmediate(done));

    expect(reads).toBe(1);
    expect(store.session('s1')).toMatchObject({ state: 'running', released: false, releasing: false, question: null });

    roster.resolve();
    await runtime.readRoster();
    expect(store.session('s1')).toMatchObject({ state: 'running', released: false, releasing: false, question: null });
    runtime.stop();
  });

  it('reads the roster again when asked during a read, so an older result does not end a resumed session', async () => {
    const { store, cli, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const reads = () => cli.calls.filter((call) => call[1] === 'agents').length;
    const before = reads();
    const roster = cli.roster;
    cli.roster = [];
    const first = runtime.readRoster();
    cli.roster = roster;
    const second = runtime.readRoster();
    expect(second).toBe(first);
    await first;

    expect(reads()).toBe(before + 2);
    expect(store.session('s1')).toMatchObject({ state: 'running' });
  });

  it('keeps a session whose start is confirmed during a roster read that did not look for it', async () => {
    const { store, cli, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const gate = deferred();
    cli.rosterGate = gate.promise;
    const read = runtime.readRoster();

    source.result = { tickets: [issue('8'), issue('9')] };
    await runtime.pollSource('github');
    await runtime.settled();
    expect(store.session('s2')).toMatchObject({ state: 'running' });

    gate.resolve();
    await read;
    expect(store.session('s2')).toMatchObject({ state: 'running', released: false, releasing: false, question: null });
  });

  it('ignores markers when hooks are off', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    mkdirSync(join(home, '.switchboard', 'activity'), { recursive: true });
    writeFileSync(join(home, '.switchboard', 'activity', '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'PermissionRequest' }));
    runtime.readMarkers();
    await runtime.readRoster();

    expect(store.session('s1')?.state).toBe('running');
  });

  it('links a setup worktree by branch name before the setup session ends', async () => {
    const cfg = config();
    cfg.settings.sources['github']!.setupPrompt = '/init-worktree {{ticket.sourceKey}}';
    cfg.playbooks = new Map([...PLAYBOOKS, playbook('dev:develop', { description: 'Build it', autoStart: true, requiresWorktree: true, template: 'Build.' })]);
    const { store, cli, source, runtime } = setup(cfg);
    cli.worktrees = 'worktree D:/git/widgets\nHEAD abc\nbranch refs/heads/master\n';
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    expect(store.session('s1')).toMatchObject({ kind: 'setup', state: 'running' });

    cli.worktrees += '\nworktree D:/git/widgets-wt/8-new\nHEAD def\nbranch refs/heads/8-new\n';
    cli.roster = [];
    await runtime.readRoster();
    await runtime.settled();

    expect(store.worktreeFor(1)).toMatchObject({ path: 'D:/git/widgets-wt/8-new', linkedBy: 'convention' });
    expect(store.session('s2')).toMatchObject({ kind: 'task', cwd: 'D:/git/widgets-wt/8-new', state: 'running' });
  });

  it('skips a failed roster read', async () => {
    const { store, cli, source, runtime, logs } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    cli.roster = 'not a list' as unknown as object[];
    await runtime.readRoster();

    expect(store.session('s1')?.state).toBe('running');
    expect(logs).toEqual(['sessions: could not list running Code Mode sessions: claude agents returned an unexpected response; trying again']);
  });

  it('records reports, validating a worktree with git', async () => {
    const { store, cli, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Planning' })).toEqual({ refused: null });
    expect(store.workItemState(1)?.headline).toBe('Planning');

    expect(await runtime.report({ sessionId: 's1', kind: 'worktree', path: 'D:\\git\\widgets-wt\\7-fix\\' })).toEqual({ refused: null });
    expect(store.worktreeFor(1)).toMatchObject({ path: 'D:/git/widgets-wt/7-fix', branch: '7-fix', linkedBy: 'report' });
    expect(cli.calls.at(-1)).toEqual(['git', 'worktree', 'list', '--porcelain']);

    expect(await runtime.report({ sessionId: 's1', kind: 'worktree', path: 'D:/elsewhere' })).toEqual({ refused: 'D:/elsewhere is not a git worktree.' });
    // The flow never sees this report, so the hub logs the refusal itself (PRD R59).
    expect(store.ticketHistory(1)!.events.at(-1)).toMatchObject({ type: 'report', actor: 'session', sessionId: 's1', detail: { kind: 'worktree', path: 'D:/elsewhere' }, refused: 'D:/elsewhere is not a git worktree.' });
    // A request the hub rejects keeps only the report's kind and short fields, never its prompt.
    runtime.refuseReport('s1', { sessionId: 's1', kind: 'task', prompt: 'secret plan', title: 'Fix', repo: 7 }, 'Expected {…}.');
    expect(store.ticketHistory(1)!.events.at(-1)).toMatchObject({ type: 'report', sessionId: 's1', detail: { kind: 'task', title: 'Fix' }, refused: 'Expected {…}.' });
    expect(JSON.stringify(store.ticketHistory(1)!.events.at(-1))).not.toContain('secret plan');
    expect(await runtime.report({ sessionId: 's9', kind: 'done' })).toEqual({ refused: 'Unknown session s9.' });
    expect(await runtime.report({ sessionId: 's1', kind: 'approval', prompt: '/publish', summary: 'Ready.', report: 'D:/wt/review.md' })).toEqual({ refused: null });
    expect(store.workItem(1)).toMatchObject({ status: 'awaiting-approval', approvalPrompt: '/publish', approvalSummary: 'Ready.', approvalReport: 'D:/wt/review.md' });
    source.result = { tickets: [] };
    expect(await runtime.report({ sessionId: 's1', kind: 'done' })).toEqual({ refused: null });
    expect(store.workItem(1)?.status).toBe('done');

    source.result = { tickets: [issue('9')] };
    await runtime.pollSource('github');
    await runtime.settled();
    store.updateSession('s2', { reports: ['stage', 'link'] });
    expect(await runtime.report({ sessionId: 's2', kind: 'done' })).toEqual({ refused: "This session's report contract does not offer the done report." });
    expect(store.workItem(2)?.status).toBe('running');
  });

  it('records a paste only from a session offered it, and puts the pastes in the snapshot (R60)', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    store.updateSession('s1', { reports: ['stage', 'link'] });
    expect(await runtime.report({ sessionId: 's1', kind: 'paste', label: 'Customer reply', file: 'D:/case/draft-reply.md' })).toEqual({ refused: "This session's report contract does not offer the paste report." });
    expect(runtime.snapshot().workItems[0]?.pastes).toEqual([]);

    store.updateSession('s1', { reports: ['stage', 'link', 'paste'] });
    expect(await runtime.report({ sessionId: 's1', kind: 'paste', label: 'Customer reply', file: 'D:/case/draft-reply.md' })).toEqual({ refused: null });
    expect(runtime.snapshot().workItems[0]?.pastes).toMatchObject([{ workItemId: 1, label: 'Customer reply', file: 'D:/case/draft-reply.md' }]);
  });

  it("puts a work item's comments in the snapshot, oldest first (PRD R87)", async () => {
    const { source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(runtime.snapshot().workItems[0]?.comments).toEqual([]);
    expect(runtime.send({ type: 'comment', workItemId: 1, text: 'First' }).refused).toBeNull();
    expect(runtime.send({ type: 'comment', workItemId: 1, text: 'Second' }).refused).toBeNull();
    expect(runtime.snapshot().workItems[0]?.comments.map((comment) => comment.text)).toEqual(['First', 'Second']);
  });

  it('turns a task report into an unstarted ad-hoc row from its parent, which Start runs in the repo (PRD R68)', async () => {
    const { store, cli, source, runtime } = setup();
    source.result = { tickets: [issue('18941')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(await runtime.report({ sessionId: 's1', kind: 'task', prompt: 'Fix the flaky CartTests', repo: null, title: null })).toEqual({ refused: null });
    expect(await runtime.report({ sessionId: 's1', kind: 'task', prompt: 'x', repo: 'D:/git/support', title: null })).toEqual({ refused: 'D:/git/support is not a configured repo root. Repo roots: D:/git/widgets.' });

    const child = runtime.snapshot().workItems.find((item) => item.parentId === 1);
    expect(child).toMatchObject({ status: 'unstarted', playbook: null, ticket: { source: 'adhoc', title: 'Fix the flaky CartTests', repoRoot: 'D:/git/widgets' }, parent: { source: 'github', sourceKey: '18941' } });
    expect(runtime.snapshot().workItems.find((item) => item.id === 1)?.parent).toBeNull();

    runtime.send({ type: 'start', workItemId: child!.id });
    await runtime.settled();

    expect(store.sessionsFor(child!.id)).toMatchObject([{ cwd: 'D:/git/widgets', state: 'running' }]);
    const start = cli.heldStarts.at(-1);
    expect(start?.prompt).toBe('Fix the flaky CartTests');
    expect(start?.contract).toMatch(/^Report to Switchboard/);
  });
});
