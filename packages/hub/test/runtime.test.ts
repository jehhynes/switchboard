import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec, ExecResult } from '@switchboard/claude';
import { DEFAULT_SETTINGS, parsePlaybook, Store } from '@switchboard/core';
import type { ContextResult, Playbook, PolledTicket, PollResult, Settings, Source } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { Runtime, WAKE_MS } from '../src/runtime.js';

const T0 = Date.UTC(2026, 9, 3, 12);

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'switchboard-runtime-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function playbook(name: string, text: string): [string, Playbook] {
  const parsed = parsePlaybook(name, text);

  if ('error' in parsed) {
    throw new Error(parsed.error);
  }

  return [name, parsed.playbook];
}

const PLAYBOOKS = new Map([
  playbook('triage:github', '---\ndescription: Triage\nkind: triage\n---\nClassify.'),
  playbook('dev:develop', '---\ndescription: Build it\nautoStart: true\nreports: done, approval, worktree\n---\nBuild {{ticket.sourceKey}}.'),
]);

function config(patch: Partial<Settings['sessions']> = {}): Config {
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      sessions: { ...DEFAULT_SETTINGS.sessions, installHooks: false, ...patch },
      sources: { github: { enabled: true, pollIntervalSeconds: 300, repoRoot: 'D:/git/widgets', triagePlaybook: 'triage:github', setupPrompt: '', namespace: '', pickPrompt: '', options: {} } },
    },
    settingsError: null,
    playbooks: PLAYBOOKS,
    playbookErrors: [],
  };
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '', missing: false, timedOut: false });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr, missing: false, timedOut: false });

/** A fake Claude CLI and git. `roster` is what `claude agents --json` lists. */
class FakeCli {
  roster: object[] = [];
  calls: string[][] = [];
  classifyResult = ok(JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:develop', summary: 'Build the thing.' } }));
  /** Per-ticket classifier output by triage context, overriding `classifyResult`. */
  classifyByContext = new Map<string, ExecResult>();
  startResult: ExecResult | null = null;
  stopResult = ok('');
  worktrees = 'worktree D:/git/widgets\nHEAD abc\nbranch refs/heads/master\n\nworktree D:/git/widgets-wt/7-fix\nHEAD def\nbranch refs/heads/7-fix\n';
  private started = 0;

  exec: Exec = async (file, args, options) => {
    this.calls.push([file, ...args]);

    if (file === 'git') {
      return ok(this.worktrees);
    }

    if (args[0] === '-p') {
      return this.classifyByContext.get(options.stdin ?? '') ?? this.classifyResult;
    }

    if (args[0] === '--bg') {
      if (this.startResult !== null) {
        return this.startResult;
      }

      const id = `0000000${++this.started}`;
      this.roster.push({ id, sessionId: `${id}-native`, pid: 100 + this.started, kind: 'background', cwd: '', state: 'working' });

      return ok(`backgrounded · ${id} · name\n`);
    }

    if (args[0] === 'agents') {
      return ok(JSON.stringify(this.roster));
    }

    if (args[0] === 'stop') {
      this.roster = this.roster.filter((entry) => (entry as { id: string }).id !== args[1]);
      return this.stopResult;
    }

    throw new Error(`unexpected call ${file} ${args.join(' ')}`);
  };
}

class FakeSource implements Source {
  readonly name = 'github';
  result: PollResult = { tickets: [] };
  context: (ticket: { sourceKey: string }) => Promise<ContextResult> = async (ticket) => ({ context: `Issue ${ticket.sourceKey} text` });

  async poll(): Promise<PollResult> {
    return this.result;
  }

  keyOfBranch(branch: string): string | null {
    return /^(\d+)-/.exec(branch)?.[1] ?? null;
  }
}

const issue = (key: string): PolledTicket => ({ sourceKey: key, ref: `#${key}`, sourceId: null, title: `Issue ${key}`, url: `u/${key}`, assigned: true, pool: false, sortAt: null, enteredAt: null });

function setup(cfg = config(), now = () => T0) {
  const store = Store.open(':memory:');
  const cli = new FakeCli();
  const source = new FakeSource();
  let ids = 0;
  const logs: string[] = [];
  const runtime = new Runtime(
    {
      home,
      store,
      exec: cli.exec,
      claudePath: 'claude',
      makeSource: (name) => (name === 'github' ? { source } : null),
      now,
      sleep: async () => {},
      newSessionId: () => `s${++ids}`,
      claudeSettings: join(home, '.claude', 'settings.json'),
      log: (line) => logs.push(line),
    },
    cfg,
  );

  return { store, cli, source, runtime, logs };
}

describe('Runtime', () => {
  it('wakes a due snooze on its minute tick, without any other event', async () => {
    vi.useFakeTimers();
    try {
      let now = T0;
      const { store, source, runtime } = setup(config(), () => now);
      source.result = { tickets: [issue('5')] };
      store.insertTicket({ source: 'github', sourceKey: '5', ref: '#5', sourceId: null, title: 'Issue 5', url: 'u', assigned: true, pool: false, snoozed: true, snoozedUntil: T0 + WAKE_MS, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
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
    expect(store.triage(1)).toMatchObject({ context: 'Issue 7 text', playbook: 'dev:develop', summary: 'Build the thing.' });
    expect(store.session('s1')).toMatchObject({ shortId: '00000001', nativeSessionId: '00000001-native', state: 'running', cwd: 'D:/git/widgets-wt/7-fix' });
    expect(store.workItem(1)?.status).toBe('running');
    expect(store.worktreeFor(1)).toMatchObject({ path: 'D:/git/widgets-wt/7-fix', branch: '7-fix', linkedBy: 'convention' });
    expect(cli.calls.find((call) => call[0] === 'git')).toEqual(['git', 'worktree', 'list', '--porcelain']);
    expect(changes).toBeGreaterThan(3);
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

  it("fails a start with Claude's message", async () => {
    const { store, cli, source, runtime } = setup();
    cli.startResult = fail('Workspace not trusted. Run `claude` in D:\\git\\widgets once and accept the trust prompt, then retry.');
    source.result = { tickets: [issue('8')] };

    await runtime.pollSource('github');
    await runtime.settled();

    expect(store.workItem(1)).toMatchObject({ status: 'failed', error: 'Workspace not trusted. Run `claude` in D:\\git\\widgets once and accept the trust prompt, then retry.' });
  });

  it('observes markers and the roster, releases the finished turn, and ends sessions that leave the roster', async () => {
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

    expect(cli.calls.filter((call) => call[1] === 'stop')).toEqual([['claude', 'stop', '00000001']]);
    expect(store.session('s1')).toMatchObject({ state: 'ended', released: true });
    expect(store.workItem(1)).toMatchObject({ status: 'blocked', error: 'The turn ended without a done report.' });
    expect(runtime.hasActiveSessions()).toBe(false);
  });

  it('never releases a session the roster lists as interactive', async () => {
    const { store, cli, source, runtime, logs } = setup(config({ installHooks: true }));
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    (cli.roster[0] as { kind: string }).kind = 'interactive';
    mkdirSync(join(home, '.switchboard', 'activity'), { recursive: true });
    writeFileSync(join(home, '.switchboard', 'activity', '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'Stop', backgroundTasks: 0 }));
    runtime.readMarkers();
    await runtime.settled();

    expect(cli.calls.filter((call) => call[1] === 'stop')).toEqual([]);
    expect(logs).toEqual(['release skipped: session s1 is not a background process']);
    expect(store.session('s1')).toMatchObject({ state: 'idle', released: true });
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
    cfg.playbooks = new Map([...PLAYBOOKS, playbook('dev:develop', '---\ndescription: Build it\nautoStart: true\nrequiresWorktree: true\n---\nBuild.')]);
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
    expect(logs).toEqual(['roster read failed: claude agents returned an unexpected response.']);
  });

  it('records reports, validating a worktree with git', async () => {
    const { store, cli, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Planning' })).toEqual({ refused: null });
    expect(store.workItem(1)?.stage).toBe('Planning');

    expect(await runtime.report({ sessionId: 's1', kind: 'worktree', path: 'D:\\git\\widgets-wt\\7-fix\\' })).toEqual({ refused: null });
    expect(store.worktreeFor(1)).toMatchObject({ path: 'D:/git/widgets-wt/7-fix', branch: '7-fix', linkedBy: 'report' });
    expect(cli.calls.at(-1)).toEqual(['git', 'worktree', 'list', '--porcelain']);

    expect(await runtime.report({ sessionId: 's1', kind: 'worktree', path: 'D:/elsewhere' })).toEqual({ refused: 'D:/elsewhere is not a git worktree.' });
    expect(await runtime.report({ sessionId: 's9', kind: 'done' })).toEqual({ refused: 'Unknown session s9.' });
    expect(await runtime.report({ sessionId: 's1', kind: 'approval', prompt: '/publish', summary: 'Ready.', report: 'D:/wt/review.md' })).toEqual({ refused: null });
    expect(store.workItem(1)).toMatchObject({ status: 'awaiting-approval', approvalPrompt: '/publish', approvalSummary: 'Ready.', approvalReport: 'D:/wt/review.md' });
    expect(await runtime.report({ sessionId: 's1', kind: 'done' })).toEqual({ refused: null });
    expect(store.workItem(1)?.status).toBe('done');

    source.result = { tickets: [issue('9')] };
    await runtime.pollSource('github');
    await runtime.settled();
    store.updateSession('s2', { reports: ['stage', 'link'] });
    expect(await runtime.report({ sessionId: 's2', kind: 'done' })).toEqual({ refused: "This session's prompt does not offer the done report." });
    expect(store.workItem(2)?.status).toBe('running');
  });

  it('stops a session and reports a failed stop', async () => {
    const { store, cli, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    cli.stopResult = fail('No such agent');
    runtime.send({ type: 'stop', workItemId: 1 });
    await runtime.settled();
    expect(store.workItem(1)).toMatchObject({ status: 'running', error: 'Stop failed: No such agent' });

    cli.stopResult = ok('');
    runtime.send({ type: 'stop', workItemId: 1 });
    await runtime.settled();
    expect(store.workItem(1)).toMatchObject({ status: 'blocked', error: 'Stopped by you.' });
  });

  it('reconciles at startup and installs hooks when enabled', async () => {
    const { store, runtime } = setup(config({ installHooks: true }));
    store.insertTicket({ source: 'adhoc', sourceKey: '1', ref: '#1', sourceId: null, title: 'x', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: 'D:/x' });
    runtime.send({ type: 'adhoc', prompt: 'Do it', repoRoot: 'D:/scratch' });
    await runtime.settled();
    store.updateSession('s1', { state: 'starting', shortId: null });

    await runtime.startup();

    expect(store.session('s1')).toMatchObject({ state: 'ended', outcome: 'failed' });
    expect(store.workItem(1)).toMatchObject({ status: 'failed', error: 'The hub stopped while the session was starting.' });
    expect(Object.keys(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks)).toHaveLength(11);
    expect(runtime.snapshot().errors.hooks).toBeNull();
  });

  it('shows a failed hook install instead of failing startup', async () => {
    const { runtime } = setup(config({ installHooks: true }));
    mkdirSync(join(home, '.claude', 'settings.json'), { recursive: true });

    await runtime.startup();

    expect(runtime.snapshot().errors.hooks).toMatch(/^Switchboard could not add its hooks to .*settings\.json: EISDIR/);
  });

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

  it('hands a pending open to the first window on its folder within two minutes', () => {
    let now = T0;
    const { runtime } = setup(config(), () => now);

    runtime.recordOpen('a-native', 'D:/git/widgets-wt/7-fix');
    now += 2 * 60_000;
    expect(runtime.claimOpen('D:\\git\\widgets-wt\\7-fix')).toBe('a-native');

    runtime.recordOpen('b-native', 'D:/git/widgets-wt/8-fix');
    now += 2 * 60_000 + 1;
    expect(runtime.claimOpen('D:/git/widgets-wt/8-fix')).toBeNull();
  });

  it('triages the pool, lists it oldest first, and runs a pick with fake runners', async () => {
    const cfg = config();
    cfg.settings.sources['github']!.pickPrompt = 'Claim {{ticket.sourceKey}}, then stop.';
    const { store, cli, source, runtime } = setup(cfg);
    source.result = { tickets: [{ ...issue('9'), assigned: false, pool: true, sortAt: 20, enteredAt: null }, { ...issue('8'), assigned: false, pool: true, sortAt: 10, enteredAt: null }] };

    await runtime.pollSource('github');
    await runtime.settled();

    const pool = runtime.snapshot().pool;
    expect(pool.map((entry) => [entry.ticket.sourceKey, entry.triage?.playbook])).toEqual([['8', 'dev:develop'], ['9', 'dev:develop']]);
    expect(runtime.snapshot().workItems).toEqual([]);

    expect(runtime.send({ type: 'pick', ticketId: pool[0]!.ticket.id }).refused).toBeNull();
    await runtime.settled();

    const start = cli.calls.find((call) => call[1] === '--bg');
    expect(start?.at(-1)).toMatch(/^Claim 8, then stop\.\n\nReport to Switchboard with these commands:/);
    expect(store.session('s1')).toMatchObject({ kind: 'pick', state: 'running' });
    expect(runtime.snapshot().pool.map((entry) => entry.ticket.sourceKey)).toEqual(['9']);
    expect(runtime.snapshot().workItems).toMatchObject([{ status: 'setup', needsPick: true, triage: { playbook: 'dev:develop' } }]);
  });

  it('lists the pool oldest first with each rating, counts the started done work items of a returned ticket, and hides a disabled source (PRD R50, R51)', async () => {
    const { store, cli, source, runtime } = setup();
    const rated = (immediacy: string, severity: string) => ok(JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:develop', summary: 's', immediacy, severity } }));
    cli.classifyByContext.set('Issue 2 text', rated('NON-BLOCKING', 'LOW'));
    cli.classifyByContext.set('Issue 3 text', rated('BLOCKING', 'HIGH'));
    cli.classifyByContext.set('Issue 4 text', rated('URGENT', 'MED'));
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

    // Of three done work items, only the one whose session started counts: one never ran a session, one's launch failed.
    const ticket = store.findTicket('github', '1')!;
    const done = { ticketId: ticket.id, playbook: null, status: 'done', stage: null, stageAt: null, taskPrompt: null, warning: null, error: null, failedStep: null, unassignedAt: null, queuedAt: null, needsPick: false, approvalPrompt: null, approvalSummary: null, approvalReport: null, createdAt: T0, statusAt: T0, runStartedAt: null, scopeAt: null, doneAt: T0, doneReason: 'operator' } as const;
    const ran = store.insertWorkItem(done);
    store.insertWorkItem(done);
    const refused = store.insertWorkItem(done);
    const session = { kind: 'task', provider: 'claude', nativeSessionId: null, cwd: 'C:/repo', state: 'ended', stateAt: T0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: T0, endedAt: T0, released: false } as const;
    store.insertSession({ ...session, id: 'ran', workItemId: ran.id, shortId: 'abc123', reports: [] });
    store.insertSession({ ...session, id: 'refused', workItemId: refused.id, shortId: null, reports: [] });

    expect(runtime.snapshot().pool.map((entry) => [entry.ticket.sourceKey, entry.returned])).toEqual([['5', 0], ['1', 1], ['2', 0], ['4', 0], ['3', 0]]);

    // A disabled source's pool is not read, so it is hidden; the filter lists it as off.
    const off = config();
    off.settings.sources['github']!.enabled = false;
    off.settings.sources['github']!.namespace = 'dev';
    runtime.reload(off);

    expect(runtime.snapshot().pool).toEqual([]);
    expect(runtime.snapshot().sourceStates).toEqual([{ name: 'github', enabled: false }]);
    expect(runtime.snapshot().namespaces).toEqual({ github: 'dev' });
  });

  it('records a link report and lists the ticket links and earlier work items on the work item (PRD R51, R52)', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(await runtime.report({ sessionId: 's1', kind: 'link', label: 'PR #12', target: 'https://github.com/o/r/pull/12' })).toEqual({ refused: null });
    expect(await runtime.report({ sessionId: 'nope', kind: 'link', label: 'x', target: 'https://x' })).toEqual({ refused: 'Unknown session nope.' });
    expect(runtime.snapshot().workItems[0]).toMatchObject({ returned: 0, links: [{ label: 'PR #12', target: 'https://github.com/o/r/pull/12' }] });

    // The started earlier work item is counted after it leaves the Done list; work item 2 started no session, so it is not.
    const { id: _id, ...first } = store.workItem(1)!;
    store.updateWorkItem(1, { status: 'done', doneAt: T0 - 30 * 86_400_000, doneReason: 'operator' });
    store.insertWorkItem({ ...first, status: 'triaging', createdAt: T0 });
    store.insertWorkItem({ ...first, status: 'triaging', createdAt: T0 });

    expect(runtime.snapshot().workItems.map((item) => [item.id, item.returned, item.links.length])).toEqual([[3, 1, 1], [2, 1, 1]]);
  });

  it('reports an unknown or misconfigured source', () => {
    const cfg = config();
    cfg.settings.sources['zoho'] = { ...cfg.settings.sources['github']!, enabled: true };
    const { runtime } = setup(cfg);

    expect(runtime.snapshot().errors.sources).toEqual({ zoho: 'Switchboard has no source named zoho.' });
  });
});
