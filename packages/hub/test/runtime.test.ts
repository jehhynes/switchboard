import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ClaudeRunner, conversationRules, projectSlug } from '@switchboard/claude';
import { CodexRunner } from '@switchboard/codex';
import type { Exec, ExecResult } from '@switchboard/claude';
import { BACKOFF_MS, CLI_MARGIN_MS, CONTINUE_TEXT, DEFAULT_SETTINGS, launchOptions, MESSAGES, parsePlaybook, QUESTION_CARD, Store, toneSection, toneVersion, UNCONFIRMED_DONE } from '@switchboard/core';
import { recordPath } from '@switchboard/holder';
import type { SessionEntry } from '@switchboard/holder';
import { NotWritten } from '@switchboard/conversation';
import { markOf } from '@switchboard/core/group';
import type { ContextResult, CopyRelation, Playbook, PolledTicket, PollResult, PullRequestStatus, Session, SessionRunner, Settings, Source, StartAction, Ticket } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import type { HolderConnection } from '../src/holder.js';
import { ATTACH_RESERVATION_MS, INPUT_SETTLE_MS, PULL_REQUESTS_FOCUS_MS, questionCardOpen, REPORT_CHECK_MS, MARKER_MS, RECHECK_MS, MARKER_WATCH_RETRY_MS, repoKeysOf, Runtime, SESSION_ENDED, SESSION_RELAUNCHED, triageText, WAKE_MS } from '../src/runtime.js';
import type { RuntimeDeps } from '../src/runtime.js';
import { controlsOf, doneSince } from '../src/rows.js';
import { dockView } from '../src/dock.js';

const T0 = Date.UTC(2026, 9, 3, 12);

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'switchboard-runtime-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function playbook(name: string, entry: unknown): [string, Playbook] {
  const parsed = parsePlaybook(name, entry);

  if ('error' in parsed) {
    throw new Error(parsed.error);
  }

  return [name, parsed.playbook];
}

const PLAYBOOKS = new Map([
  playbook('triage:github', { description: 'Triage', kind: 'triage', template: 'Classify.' }),
  playbook('dev:develop', { description: 'Build it', autoStart: true, reports: ['done', 'approval', 'worktree'], template: 'Build {{ticket.sourceKey}}.' }),
]);

function config(patch: Partial<Settings['sessions']> = {}): Config {
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      sessions: { ...DEFAULT_SETTINGS.sessions, installHooks: false, ...patch },
      sources: { github: { kind: 'github', pollIntervalSeconds: 300, repoRoot: 'D:/git/widgets', triagePlaybook: 'triage:github', setupPrompt: '', namespace: '', options: {} } },
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
  gitGate: Promise<void> | null = null;
  gitEntered: (() => void) | null = null;
  /** When set, the next roster read lists the roster as it is now, then waits for this before returning. */
  rosterGate: Promise<void> | null = null;
  calls: string[][] = [];
  /** What `<sessions.nodePath> --version` answers. */
  nodeResult = ok('v24.0.0\n');
  /** When set, each Node.js check waits here for its answer instead of answering `nodeResult`. */
  heldNode: ((answer: ExecResult) => void)[] | null = null;
  nodeEnvs: Record<string, string>[] = [];
  /** Answers a Node.js check by its environment, before `nodeResult`. */
  nodeAnswer: ((env: Record<string, string>) => ExecResult | undefined) | null = null;
  classifyResult = ok(JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:develop' } }));
  codexClassifyResult = ok('{"type":"turn.completed"}\n');
  /** Per-ticket classifier output by triage context, overriding `classifyResult`. */
  classifyByContext = new Map<string, ExecResult>();
  startResult: ExecResult | null = null;
  stopResult = ok('');
  worktrees = 'worktree D:/git/widgets\nHEAD abc\nbranch refs/heads/master\n\nworktree D:/git/widgets-wt/7-fix\nHEAD def\nbranch refs/heads/7-fix\n';
  private started = 0;
  /** The folder of each git call. */
  gitCwds: string[] = [];

  exec: Exec = async (file, args, options) => {
    this.calls.push([file, ...args]);

    if (file === 'git') {
      this.gitCwds.push(options.cwd ?? '');
      this.gitEntered?.();
      const gate = this.gitGate;
      this.gitGate = null;

      if (gate !== null) {
        await gate;
      }

      return ok(this.worktrees);
    }

    if (args[0] === '-p') {
      return this.classifyByContext.get(options.stdin ?? '') ?? this.classifyResult;
    }

    if (args[0] === 'exec' && args.includes('--output-schema')) {
      writeFileSync(args[args.indexOf('--output-last-message') + 1]!, '{"playbook":"dev:develop"}');
      return this.codexClassifyResult;
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
      const listed = JSON.stringify(this.roster);
      const gate = this.rosterGate;
      this.rosterGate = null;
      await gate;

      return ok(listed);
    }

    if (args[0] === 'stop') {
      this.roster = this.roster.filter((entry) => (entry as { id: string }).id !== args[1]);
      return this.stopResult;
    }

    if (args[0] === '--version') {
      this.nodeEnvs.push(options.env ?? {});
      return this.heldNode === null ? (this.nodeAnswer?.(options.env ?? {}) ?? this.nodeResult) : new Promise((answer) => this.heldNode!.push(answer));
    }

    throw new Error(`unexpected call ${file} ${args.join(' ')}`);
  };
}

class FakeSource implements Source {
  readonly name = 'github';
  result: PollResult = { tickets: [] };
  /** When set, the next poll waits for this before returning the `result` it started with. */
  gate: Promise<void> | null = null;
  polls = 0;
  /** The sourceKeys of the current tickets each poll was given. */
  current: string[][] = [];
  context: (ticket: { sourceKey: string }) => Promise<ContextResult> = async (ticket) => ({ context: `Issue ${ticket.sourceKey} text` });
  checkLink?: NonNullable<Source['checkLink']>;
  ticketAt?: NonNullable<Source['ticketAt']>;
  assignmentAt?: NonNullable<Source['assignmentAt']>;
  pullRequests?: NonNullable<Source['pullRequests']>;

  async poll(current: readonly Ticket[]): Promise<PollResult> {
    this.polls++;
    this.current.push(current.map((ticket) => ticket.sourceKey));
    const result = this.result;
    const gate = this.gate;
    this.gate = null;
    await gate;

    return result;
  }

  /** The repository each branch was read in. */
  branchRepos: string[] = [];

  keyOfBranch(branch: string, repo: string): string | null {
    this.branchRepos.push(repo);
    const number = /^(\d+)-/.exec(branch)?.[1] ?? null;
    return number === null || repo === '' || repo === 'acme/widgets' ? number : `${repo}#${number}`;
  }
}

const issue = (key: string): PolledTicket => ({ sourceKey: key, ref: `#${key}`, repo: '', sourceId: null, title: `Issue ${key}`, url: `u/${key}`, assigned: true, pool: false, sortAt: null, enteredAt: null });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/**
 * A fake Codex: a process table, a spawner whose runs write `onSpawn`'s log, and a trust call, so no test starts a real Codex process. Its
 * runs live until a test ends them.
 */
class FakeCodex {
  alive = new Set<number>();
  nextPid = 500;
  spawned: string[][] = [];
  commandLines = new Map<number, string>();
  kills: number[] = [];
  trustError: string | null = null;
  trustCalls = 0;
  /** When set, each trust call waits here for its answer instead of answering `trustError`. */
  heldTrust: ((answer: string | null) => void)[] | null = null;
  queryError: string | null = null;
  onSpawn: (stdout: string, pid: number, args: string[]) => string = () => '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n';
  /** Holds the next process query until released. */
  queryGate: Promise<void> | null = null;
  queryEntered: (() => void) | null = null;

  runner(): CodexRunner {
    return new CodexRunner({
      codexPath: () => 'codex',
      exec: async () => {
        throw new Error('unexpected exec');
      },
      sleep: async () => {},
      now: () => T0,
      home: join(home, '.switchboard'),
      codexHome: join(home, '.codex'),
      env: {},
      hooks: () => true,
      nodePath: () => 'node',
      spawn: async (_file, args, options) => {
        const pid = this.nextPid++;

        this.spawned.push(args);
        this.commandLines.set(pid, args.join(' '));
        this.alive.add(pid);
        writeFileSync(options.stdout, this.onSpawn(options.stdout, pid, args));
        writeFileSync(options.stderr, '');
        return { pid, error: null };
      },
      processes: async (pids) => {
        const gate = this.queryGate;

        this.queryGate = null;
        this.queryEntered?.();
        await gate;

        return this.queryError !== null ? { error: this.queryError } : new Map(pids.filter((pid) => this.alive.has(pid)).map((pid) => [pid, { pid, created: `c${pid}`, name: 'codex.exe', commandLine: this.commandLines.get(pid) ?? '' }]));
      },
      tagged: async () => null,
      alive: (pid) => this.alive.has(pid),
      kill: async (pid) => {
        this.kills.push(pid);
        this.alive.delete(pid);
        return null;
      },
      trust: async () => {
        this.trustCalls += 1;
        return this.heldTrust === null ? this.trustError : new Promise((answer) => this.heldTrust!.push(answer));
      },
    });
  }
}

/** A null `codex` leaves the runtime to build its own Codex runner. */
function setup(cfg = config(), now = () => T0, runners?: RuntimeDeps['runners'], codex: FakeCodex | null = new FakeCodex(), named: Record<string, FakeSource> = {}, extra: Partial<RuntimeDeps> = {}) {
  const store = Store.open(':memory:');
  const cli = new FakeCli();

  for (const name of Object.keys(cfg.settings.sources)) {
    store.setSourceEnabled(name, true);
  }

  const source = new FakeSource();
  let ids = 0;
  const logs: string[] = [];
  // The done check's timeout fires only when a test releases it.
  const late = deferred();
  // The re-read after a blocked done report runs only when a test releases it.
  const recheck = deferred();
  const runtime = new Runtime(
    {
      home,
      store,
      exec: cli.exec,
      makeSource: (name, settings) => (named[name] !== undefined ? { source: named[name] } : settings.kind === 'github' ? { source } : null),
      now,
      sleep: (ms) => (ms === REPORT_CHECK_MS ? late.promise : ms === RECHECK_MS ? recheck.promise : Promise.resolve()),
      newSessionId: () => `s${++ids}`,
      claudeSettings: join(home, '.claude', 'settings.json'),
      configDir: join(home, 'cfg'),
      log: (line) => logs.push(line),
      runners: { ...(codex === null ? {} : { codex: codex.runner() }), ...runners },
      ...extra,
    },
    cfg,
  );

  return { store, cli, source, runtime, logs, late, recheck, codex };
}

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
    expect(logs).toContain('Triage model claude-sonnet-5-5 does not match codex; using its default model.');

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
      await new Promise((resolve) => setTimeout(resolve, MARKER_WATCH_RETRY_MS + 200));

      writeFileSync(join(dir, '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'PermissionRequest' }));
      await vi.waitFor(() => expect(store.session('s1')?.state).toBe('waiting'), { timeout: MARKER_MS / 2 });
    } finally {
      runtime.stop();
    }
  });

  it('reads the roster when a session that ended writes a marker, so a resumed session returns to Working at once', async () => {
    let now = T0;
    const { store, cli, source, runtime } = setup(config({ installHooks: true }), () => now);
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const dir = join(home, '.switchboard', 'activity');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '00000001-native.json'), JSON.stringify({ sessionId: '00000001-native', event: 'Stop', backgroundTasks: 0, at: T0 }));
    await runtime.readRoster();
    await runtime.settled();
    expect(store.session('s1')?.state).toBe('ended');
    expect(store.workItem(1)?.status).toBe('blocked');

    // Each marker reads the roster once, so a marker left by a process that is gone reads it once only.
    const reads = () => cli.calls.filter((call) => call[1] === 'agents').length;
    const idle = () => new Promise((resolve) => setTimeout(resolve, 20));
    const before = reads();
    runtime.readMarkers();
    await idle();
    expect(reads()).toBe(before + 1);
    runtime.readMarkers();
    await idle();
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
    const real = new ClaudeRunner({ claudePath: () => 'claude', exec: async () => ({ code: 0, stdout: '[]', stderr: '', missing: false, timedOut: false }), sleep: async () => {}, now: () => T0, home, claudeSettings: join(home, '.claude', 'settings.json'), hooks: () => true, nodePath: () => 'node' });
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
    const { runtime, store } = setup(config(), () => T0, { claude: runner });

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
    expect(logs).toEqual(['claude roster read failed: claude agents returned an unexpected response.']);
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
    const start = cli.calls.filter((call) => call[1] === '--bg').at(-1);
    expect(start?.at(-1)).toBe('Fix the flaky CartTests');
    expect(start?.at(-2)).toMatch(/^Report to Switchboard/);
  });

  it('leaves a done report open while a fresh read lists the ticket as assigned, and blocks it when the recheck still does, without telling the session (PRD R10)', async () => {
    const { store, source, runtime, recheck } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    expect(await runtime.report({ sessionId: 's1', kind: 'done' })).toEqual({ refused: null });
    expect(store.workItem(1)).toMatchObject({ status: 'running', error: null });
    expect(store.session('s1')?.outcome).toBe('done');

    recheck.resolve();
    await vi.waitFor(() => expect(store.workItem(1)?.status).toBe('blocked'));
    expect(source.polls).toBe(3);
    expect(store.workItem(1)?.error).toBe('The session reported done, but the ticket is still assigned to you.');
  });

  it('finishes a done report once the recheck lists the ticket unassigned, or fails to read (mechanics M34)', async () => {
    const { store, source, runtime, recheck } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    await runtime.report({ sessionId: 's1', kind: 'done' });
    expect(source.polls).toBe(2);
    source.result = { tickets: [] };
    recheck.resolve();
    await vi.waitFor(() => expect(store.workItem(1)?.status).toBe('done'));
    expect(source.polls).toBe(3);

    const failed = setup();
    failed.source.result = { tickets: [issue('8')] };
    await failed.runtime.pollSource('github');
    await failed.runtime.settled();
    await failed.runtime.report({ sessionId: 's1', kind: 'done' });
    failed.source.result = { error: 'GitHub is down.' };
    failed.recheck.resolve();
    await vi.waitFor(() => expect(failed.store.workItem(1)).toMatchObject({ status: 'done', doneReason: 'session' }));
  });

  it('rechecks at startup a done report the hub stopped before checking again', async () => {
    const { store, source, runtime, recheck } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    store.updateSession('s1', { outcome: 'done', outcomeDetail: `${UNCONFIRMED_DONE}; it was still assigned at 2026-10-13T16:25:13.183Z.` });

    await runtime.startup();
    expect(store.workItem(1)?.status).toBe('running');
    recheck.resolve();
    await vi.waitFor(() => expect(store.workItem(1)?.status).toBe('blocked'));
    expect(source.polls).toBe(2);
  });

  it('schedules one recheck for a done report that startup finds again', async () => {
    const { store, source, runtime, recheck } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    await runtime.report({ sessionId: 's1', kind: 'done' });
    expect(store.session('s1')?.outcomeDetail).toMatch(new RegExp(`^${UNCONFIRMED_DONE}`));

    await runtime.startup();
    recheck.resolve();
    await vi.waitFor(() => expect(store.workItem(1)?.status).toBe('blocked'));
    await runtime.settled();
    await new Promise((done) => setTimeout(done, 0));
    expect(source.polls).toBe(3);
  });

  it('rechecks a later done report while the recheck of an earlier one is still pending', async () => {
    let now = T0;
    const { store, source, runtime, recheck } = setup(config(), () => now);
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    await runtime.report({ sessionId: 's1', kind: 'done' });
    const first = store.session('s1')?.outcomeDetail;
    now += 1_000;
    await runtime.report({ sessionId: 's1', kind: 'done' });
    expect(store.session('s1')?.outcomeDetail).not.toBe(first);

    recheck.resolve();
    await vi.waitFor(() => expect(store.workItem(1)?.status).toBe('blocked'));
  });

  it('accepts a done report when the second read outlasts REPORT_CHECK_MS', async () => {
    const { store, source, runtime, recheck, late, logs } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    await runtime.report({ sessionId: 's1', kind: 'done' });

    source.gate = new Promise(() => {});
    recheck.resolve();
    await vi.waitFor(() => expect(source.polls).toBe(3));
    late.resolve();
    await vi.waitFor(() => expect(store.workItem(1)).toMatchObject({ status: 'done', doneReason: 'session' }));
    expect(logs).toContain('done report for #8 accepted unchecked: the second github read took over 6 seconds');
    expect(source.polls).toBe(3);
  });
  it('queues the recheck behind a read in flight, and skips it after the hub stops', async () => {
    const { store, source, runtime, recheck } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    await runtime.report({ sessionId: 's1', kind: 'done' });

    // A scheduled read still lists the ticket and is in flight when the recheck fires.
    const slow = deferred();
    source.gate = slow.promise;
    const scheduled = runtime.pollSource('github');
    await vi.waitFor(() => expect(source.polls).toBe(3));
    source.result = { tickets: [] };
    recheck.resolve();
    slow.resolve();
    await scheduled;
    await vi.waitFor(() => expect(store.workItem(1)).toMatchObject({ status: 'done', doneReason: 'unassigned' }));
    expect(source.polls).toBe(4);

    const stopped = setup();
    stopped.source.result = { tickets: [issue('8')] };
    await stopped.runtime.pollSource('github');
    await stopped.runtime.settled();
    await stopped.runtime.report({ sessionId: 's1', kind: 'done' });
    stopped.runtime.stop();
    stopped.recheck.resolve();
    await new Promise((done) => setTimeout(done, 0));
    expect(stopped.source.polls).toBe(2);

    // Stopped while the recheck waits behind a read in flight.
    const queued = setup();
    queued.source.result = { tickets: [issue('8')] };
    await queued.runtime.pollSource('github');
    await queued.runtime.settled();
    await queued.runtime.report({ sessionId: 's1', kind: 'done' });
    const held = deferred();
    queued.source.gate = held.promise;
    const inFlight = queued.runtime.pollSource('github');
    await vi.waitFor(() => expect(queued.source.polls).toBe(3));
    queued.recheck.resolve();
    await new Promise((done) => setTimeout(done, 0));
    queued.runtime.stop();
    held.resolve();
    await inFlight;
    await new Promise((done) => setTimeout(done, 0));
    expect(queued.source.polls).toBe(3);
  });

  it('does not read the source again after a done report the read accepts', async () => {
    const { source, runtime, recheck } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    source.result = { tickets: [] };
    await runtime.report({ sessionId: 's1', kind: 'done' });
    recheck.resolve();
    await runtime.settled();
    await new Promise((done) => setTimeout(done, 0));
    expect(source.polls).toBe(2);
  });

  it('finishes on a done report when a fresh read lists the ticket outside the assigned state', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    source.result = { tickets: [{ ...issue('8'), assigned: false }] };
    expect(await runtime.report({ sessionId: 's1', kind: 'done' })).toEqual({ refused: null });
    expect(store.workItem(1)).toMatchObject({ status: 'done', doneReason: 'session' });
    expect(store.ticket(1)?.assigned).toBe(false);
  });

  it('accepts a done report when the source read fails', async () => {
    const { store, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    source.result = { error: 'GitHub is down.' };
    expect(await runtime.report({ sessionId: 's1', kind: 'done' })).toEqual({ refused: null });
    expect(store.workItem(1)?.status).toBe('done');
    expect(runtime.snapshot().errors.sources).toEqual({ github: 'GitHub is down.' });
  });

  it('polls each source now on Refresh and restarts its interval, and refuses when no source is on', async () => {
    vi.useFakeTimers();
    try {
      const { source, runtime } = setup();
      runtime.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(source.polls).toBe(1);

      await vi.advanceTimersByTimeAsync(100_000);
      expect(runtime.pollNow()).toBeNull();
      await vi.advanceTimersByTimeAsync(0);
      expect(source.polls).toBe(2);

      // The 300-second interval counts from the refresh, not from the start.
      await vi.advanceTimersByTimeAsync(299_999);
      expect(source.polls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(source.polls).toBe(3);

      // A refresh during a read does not read again, and the interval still counts from the refresh.
      const slow = deferred();
      source.gate = slow.promise;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(source.polls).toBe(4);
      expect(runtime.pollNow()).toBeNull();
      await vi.advanceTimersByTimeAsync(0);
      expect(source.polls).toBe(4);
      slow.resolve();
      await vi.advanceTimersByTimeAsync(299_999);
      expect(source.polls).toBe(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(source.polls).toBe(5);

      expect(runtime.setSourceEnabled('github', false)).toBeNull();
      expect(runtime.pollNow()).toBe('No source is polled. Turn one on in the header.');
      await vi.advanceTimersByTimeAsync(300_000);
      expect(source.polls).toBe(5);
      runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the build error on Refresh when the only source that is on cannot be built', () => {
    const cfg = config();
    cfg.settings.sources = { jira: { ...cfg.settings.sources['github']!, kind: 'jira' } };
    const { runtime } = setup(cfg);

    expect(runtime.pollNow()).toBe('jira: Switchboard has no source kind jira.');
  });

  it('drops a read that finishes after its source is turned off', async () => {
    const { store, source, runtime } = setup();
    const slow = deferred();
    source.gate = slow.promise;
    source.result = { error: 'The forum database cannot be reached; check the VPN.' };
    const scheduled = runtime.pollSource('github');
    await vi.waitFor(() => expect(source.polls).toBe(1));

    expect(runtime.setSourceEnabled('github', false)).toBeNull();
    slow.resolve();
    await scheduled;
    await runtime.settled();

    expect(runtime.snapshot().errors.sources).toEqual({});

    // A slow read of tickets is dropped as well.
    expect(runtime.setSourceEnabled('github', true)).toBeNull();
    source.result = { tickets: [issue('8')] };
    const second = deferred();
    source.gate = second.promise;
    const again = runtime.pollSource('github');
    await vi.waitFor(() => expect(source.polls).toBe(2));
    expect(runtime.setSourceEnabled('github', false)).toBeNull();
    second.resolve();
    await again;
    await runtime.settled();

    expect(store.findTicket('github', '8')).toBeNull();
  });

  it('accepts a done report unchecked when the source read outlasts the check, and applies reads in order', async () => {
    const { store, source, runtime, logs, late } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const slow = deferred();
    source.gate = slow.promise;
    const scheduled = runtime.pollSource('github');
    await vi.waitFor(() => expect(source.polls).toBe(2));
    source.result = { tickets: [] };
    const report = runtime.report({ sessionId: 's1', kind: 'done' });
    late.resolve();

    expect(await report).toEqual({ refused: null });
    expect(store.workItem(1)).toMatchObject({ status: 'done', doneReason: 'session' });
    expect(logs).toContain('done report for #8 accepted unchecked: the github read took over 6 seconds');

    // The scheduled poll, read before the ticket left, applies before the done check's read, so the ticket ends unassigned.
    slow.resolve();
    await scheduled;
    await vi.waitFor(() => expect(store.ticket(1)?.assigned).toBe(false));
    await runtime.settled();
    expect(store.workItemsForTicket(1)).toHaveLength(1);
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

  it('logs a failed stop of a deleted work item, which has no row to show it (PRD R76)', async () => {
    const { store, cli, source, runtime, logs } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    const [session] = store.sessionsFor(1);

    cli.stopResult = fail('No such agent');
    runtime.send({ type: 'delete', workItemId: 1 });
    await runtime.settled();

    expect(store.workItem(1)).toBeNull();
    expect(logs).toContain(`stop of deleted session ${session!.id} (${session!.shortId}) failed; it may still be running: No such agent`);
  });

  it('reconciles at startup and installs hooks when enabled', async () => {
    const { store, runtime } = setup(config({ installHooks: true }));
    store.insertTicket({ source: 'adhoc', sourceKey: '1', ref: '#1', repo: '', sourceId: null, title: 'x', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: 'D:/x' });
    runtime.send({ type: 'adhoc', prompt: 'Do it', repoRoot: 'D:/scratch', start: true });
    await runtime.settled();
    store.updateSession('s1', { state: 'starting', shortId: null });

    await runtime.startup();

    expect(store.session('s1')).toMatchObject({ state: 'ended', outcome: 'failed' });
    expect(store.workItem(1)).toMatchObject({ status: 'failed', error: 'The hub stopped while the session was starting.' });
    expect(Object.keys(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks)).toHaveLength(13);
    expect(runtime.snapshot().errors.hooks).toBeNull();
  });

  it("installs both agents' hooks at startup and shows each failure", async () => {
    const codex = new FakeCodex();
    const { runtime } = setup(config({ installHooks: true }), () => T0, undefined, codex);

    codex.trustError = "Codex did not trust Switchboard's hooks: no app-server";
    await runtime.startup();

    expect(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).toContain('codex-hook.mjs');
    expect(runtime.snapshot().errors.hooks).toBe("Codex did not trust Switchboard's hooks: no app-server");
  });

  it('trusts Codex hooks with the CLI sessions.codexPath names, and trusts them again when the setting changes', async () => {
    const first = join(home, 'missing', 'codex');
    const second = join(home, 'other', 'codex');
    // The runtime's own Codex runner; neither path exists, so no Codex process starts.
    const { runtime } = setup(config({ installHooks: true, codexPath: first }), () => T0, undefined, null);

    await runtime.startup();
    expect(runtime.snapshot().errors.hooks).toBe(`Codex was not found at ${first}. Install it or set sessions.codexPath.`);

    runtime.reload(config({ installHooks: true, codexPath: second }));
    await runtime.settled();
    expect(runtime.snapshot().errors.hooks).toBe(`Codex was not found at ${second}. Install it or set sessions.codexPath.`);
  });

  it('clears the Codex hook error when a new sessions.codexPath is trusted, and keeps it on a reload that leaves the path', async () => {
    const codex = new FakeCodex();
    const { runtime } = setup(config({ installHooks: true }), () => T0, undefined, codex);

    codex.trustError = 'Codex was not found at codex. Install it or set sessions.codexPath.';
    await runtime.startup();
    codex.trustError = null;

    runtime.reload(config({ installHooks: true, concurrency: 1 }));
    await runtime.settled();
    expect(runtime.snapshot().errors.hooks).toBe('Codex was not found at codex. Install it or set sessions.codexPath.');

    runtime.reload(config({ installHooks: true, codexPath: '/usr/local/bin/codex' }));
    await runtime.settled();
    expect(runtime.snapshot().errors.hooks).toBeNull();
  });

  it('runs the Claude Code CLI that sessions.claudePath names, read again after a reload', async () => {
    const { cli, source, runtime } = setup();
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    await runtime.readRoster();
    runtime.reload(config({ claudePath: '/opt/claude/bin/claude' }));
    await runtime.settled();
    await runtime.readRoster();

    source.result = { tickets: [issue('8'), issue('9')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const rosterReads = cli.calls.filter((call) => call[1] === 'agents').map((call) => call[0]);
    expect(rosterReads[0]).toBe('claude');
    expect(rosterReads.at(-1)).toBe('/opt/claude/bin/claude');
    const triages = cli.calls.filter((call) => call.includes('--json-schema')).map((call) => call[0]);
    expect(triages[0]).toBe('claude');
    expect(triages.at(-1)).toBe('/opt/claude/bin/claude');
  });

  it('runs a Codex hook install a reload asks for after the one in flight, so the older result cannot replace it', async () => {
    const codex = new FakeCodex();
    const { runtime } = setup(config({ installHooks: true }), () => T0, undefined, codex);
    const held: ((answer: string | null) => void)[] = [];

    codex.heldTrust = held;
    const startup = runtime.startup();
    await vi.waitFor(() => expect(held).toHaveLength(1));

    runtime.reload(config({ installHooks: true, codexPath: '/usr/local/bin/codex' }));
    await new Promise((done) => setImmediate(done));
    expect(held).toHaveLength(1);

    held[0]!('Codex was not found at codex. Install it or set sessions.codexPath.');
    await vi.waitFor(() => expect(held).toHaveLength(2));
    held[1]!(null);
    await startup;
    await runtime.settled();

    expect(runtime.snapshot().errors.hooks).toBeNull();
  });

  it("keeps Claude's hook error when a path change installs Codex's hooks again", async () => {
    const codex = new FakeCodex();
    const { runtime } = setup(config({ installHooks: true }), () => T0, undefined, codex);

    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '[]');
    codex.trustError = 'Codex was not found at codex. Install it or set sessions.codexPath.';
    await runtime.startup();
    const both = runtime.snapshot().errors.hooks!;
    const claude = both.replace(' Codex was not found at codex. Install it or set sessions.codexPath.', '');
    expect(claude).not.toBe(both);
    expect(claude).not.toBe('');

    codex.trustError = null;
    runtime.reload(config({ installHooks: true, codexPath: '/usr/local/bin/codex' }));
    await runtime.settled();

    expect(runtime.snapshot().errors.hooks).toBe(claude);
  });

  it('shows a sessions.nodePath that cannot run with the hook errors, and clears it when a reload names one that runs', async () => {
    const { cli, runtime } = setup();

    cli.nodeResult = { code: null, stdout: '', stderr: 'spawn node ENOENT', missing: true, timedOut: false };
    await runtime.startup();
    expect(runtime.snapshot().errors.hooks).toBe("Node.js was not found at node on the PATH Claude Code and Codex get from the hub, so Switchboard's hooks and session reports there cannot run. Install it or set sessions.nodePath.");

    cli.nodeResult = fail('bad option');
    runtime.reload(config({ nodePath: '/opt/node/bin/node' }));
    await runtime.settled();
    expect(runtime.snapshot().errors.hooks).toBe("/opt/node/bin/node --version failed, so Switchboard's hooks and session reports may not run: bad option.");

    cli.nodeResult = ok('v24.0.0\n');
    runtime.reload(config({ nodePath: '/usr/local/bin/node' }));
    await runtime.settled();
    expect(runtime.snapshot().errors.hooks).toBeNull();
    expect(cli.calls.filter((call) => call[1] === '--version').map((call) => call[0])).toEqual(['node', '/opt/node/bin/node', '/usr/local/bin/node']);
  });

  it('keeps the latest Node.js check when an older one answers after it, as when a path changes and changes back', async () => {
    const { cli, runtime } = setup();
    const held: ((answer: ExecResult) => void)[] = [];
    const missing: ExecResult = { code: null, stdout: '', stderr: '', missing: true, timedOut: false };

    cli.heldNode = held;
    const startup = runtime.startup();
    await vi.waitFor(() => expect(held).toHaveLength(1));
    runtime.reload(config({ nodePath: '/opt/node' }));
    runtime.reload(config());
    await vi.waitFor(() => expect(held).toHaveLength(3));

    held[2]!(ok('v24.0.0\n'));
    held[0]!(missing);
    held[1]!(missing);
    await startup;
    await runtime.settled();

    expect(runtime.snapshot().errors.hooks).toBeNull();
  });

  it("checks Node.js on each agent's own PATH, with its absolute path's directory first, and names the agent that lacks it", async () => {
    const { cli, runtime } = setup();
    const bin = join(home, 'nvm', 'bin');
    const firstOnPath = (env: Record<string, string>) => env[Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH']?.split(delimiter)[0];

    cli.nodeResult = { code: null, stdout: '', stderr: '', missing: true, timedOut: false };
    await runtime.startup();
    expect(cli.nodeEnvs).toEqual([{}]);

    // Node.js only beside Codex: Claude Code still lacks it.
    cli.nodeAnswer = (env) => (firstOnPath(env) === bin ? ok('v24.0.0\n') : undefined);
    runtime.reload(config({ codexPath: join(bin, 'codex') }));
    await runtime.settled();

    expect(cli.nodeEnvs.slice(1).map(firstOnPath).sort()).toEqual([bin, undefined].sort());
    expect(runtime.snapshot().errors.hooks).toBe("Node.js was not found at node on the PATH Claude Code gets from the hub, so Switchboard's hooks and session reports there cannot run. Install it or set sessions.nodePath.");
  });

  it("writes a new sessions.nodePath into both agents' hooks and the report command on reload", async () => {
    const codex = new FakeCodex();
    const { runtime } = setup(config({ installHooks: true }), () => T0, undefined, codex);
    const node = 'C:/nodejs/node.exe';
    const claudeCommands = () => [...new Set(Object.values(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks as { hooks: { command: string }[] }[][]).flat().flatMap((group) => group.hooks.map((hook) => hook.command)))];

    await runtime.startup();
    expect(claudeCommands()).toEqual(['node']);
    expect(codex.trustCalls).toBe(1);

    runtime.reload(config({ installHooks: true, nodePath: node }));
    await runtime.settled();

    expect(claudeCommands()).toEqual([node]);
    expect(codex.trustCalls).toBe(2);
    expect(runtime.reportCommand).toBe(`${node} "${join(home, '.switchboard').replaceAll('\\', '/')}/hub.js" report`);
  });

  it('installs both agents\' hooks when sessions.installHooks turns on, and drops their errors when it turns off', async () => {
    const codex = new FakeCodex();
    const { runtime } = setup(config(), () => T0, undefined, codex);

    await runtime.startup();
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
    expect(codex.trustCalls).toBe(0);

    codex.trustError = 'Codex did not trust Switchboard\'s hooks: no app-server';
    runtime.reload(config({ installHooks: true }));
    await runtime.settled();
    expect(Object.keys(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks)).toHaveLength(13);
    expect(codex.trustCalls).toBe(1);
    expect(runtime.snapshot().errors.hooks).toBe("Codex did not trust Switchboard's hooks: no app-server");

    runtime.reload(config({ installHooks: true, concurrency: 1 }));
    await runtime.settled();
    expect(codex.trustCalls).toBe(1);

    runtime.reload(config());
    await runtime.settled();
    expect(runtime.snapshot().errors.hooks).toBeNull();
  });

  it('clears the hook error of an install still running when sessions.installHooks turns off', async () => {
    const codex = new FakeCodex();
    const { runtime } = setup(config(), () => T0, undefined, codex);
    const held: ((answer: string | null) => void)[] = [];

    await runtime.startup();
    codex.heldTrust = held;
    runtime.reload(config({ installHooks: true }));
    await vi.waitFor(() => expect(held).toHaveLength(1));
    runtime.reload(config());
    held[0]!("Codex did not trust Switchboard's hooks: no app-server");
    await runtime.settled();

    expect(runtime.snapshot().errors.hooks).toBeNull();
  });

  it('does not install hooks on a path change while sessions.installHooks is off', async () => {
    const codex = new FakeCodex();
    const { runtime } = setup(config(), () => T0, undefined, codex);

    codex.trustError = 'should not run';
    runtime.reload(config({ codexPath: '/usr/local/bin/codex' }));
    await runtime.settled();

    expect(runtime.snapshot().errors.hooks).toBeNull();
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false);
  });

  it('runs a Codex session through the Codex runner: started, running, released when its turn ends, then ended', async () => {
    const codex = new FakeCodex();
    const cfg = config({ provider: 'codex' });
    const { store, runtime } = setup(cfg, () => T0, undefined, codex);

    runtime.send({ type: 'adhoc', prompt: '/sb-plan 1', repoRoot: 'D:/git/widgets', start: true });
    await runtime.settled();

    expect(codex.spawned[0]!.slice(0, 2)).toEqual(['exec', '--json']);
    expect(codex.spawned[0]!.at(-1)).toBe('$sb-plan 1');
    // Existing exec sessions keep their release behavior after upgrading.
    store.updateSession('s1', { execution: null });
    expect(store.session('s1')).toMatchObject({ provider: 'codex', nativeSessionId: 'thread-1', shortId: 'thread-1', state: 'running' });

    await runtime.readRoster();
    expect(store.session('s1')).toMatchObject({ state: 'running', released: false, releasing: false, question: null });

    // The turn ends and its process exits; the next read delivers the end, the release lets the process go, and the session ends.
    writeFileSync(join(home, '.switchboard', 'codex', 's1.jsonl'), '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n{"type":"turn.completed"}\n');
    codex.alive.clear();
    await runtime.readRoster();
    await runtime.settled();
    expect(store.session('s1')).toMatchObject({ state: 'ended', released: true });
    expect(store.workItem(1)).toMatchObject({ status: 'blocked', error: 'The turn ended without a done report.' });
    expect(codex.kills).toEqual([]);
  });

  it('asks again at each roster read about a Codex start it could not settle at startup', async () => {
    const codex = new FakeCodex();
    const { store, runtime, logs } = setup(config({ provider: 'codex' }), () => T0, undefined, codex);

    runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets', start: true });
    await runtime.settled();

    // As a hub that stopped before the thread appeared would leave it.
    const recordFile = join(home, '.switchboard', 'codex', 's1.json');
    writeFileSync(recordFile, JSON.stringify({ ...JSON.parse(readFileSync(recordFile, 'utf8')), threadId: null }));
    writeFileSync(join(home, '.switchboard', 'codex', 's1.jsonl'), '');
    store.updateSession('s1', { state: 'starting', shortId: null, nativeSessionId: null });
    codex.queryError = 'WMI is down';

    await runtime.startup();
    expect(store.session('s1')).toMatchObject({ state: 'starting' });
    expect(logs).toContain('session s1 left starting by the hub that stopped is not settled yet: The Codex process query failed: WMI is down');

    codex.queryError = null;
    writeFileSync(join(home, '.switchboard', 'codex', 's1.jsonl'), '{"type":"thread.started","thread_id":"thread-1"}\n');
    await runtime.readRoster();
    expect(store.session('s1')).toMatchObject({ state: 'running', nativeSessionId: 'thread-1' });
  });

  it("keeps one agent's sessions as they were when its read fails, while the other agent's read applies", async () => {
    const codex = new FakeCodex();
    const { store, cli, source, runtime, logs } = setup(config(), () => T0, undefined, codex);

    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    runtime.reload({ ...config({ provider: 'codex' }), playbooks: PLAYBOOKS });
    runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets', start: true });
    await runtime.settled();
    expect(store.session('s2')).toMatchObject({ provider: 'codex', state: 'running' });

    cli.roster = 'not a list' as unknown as object[];
    codex.alive.clear();
    await runtime.readRoster();

    expect(store.session('s1')).toMatchObject({ provider: 'claude', state: 'running' });
    expect(store.session('s2')).toMatchObject({ state: 'ended' });
    expect(logs).toContain('claude roster read failed: claude agents returned an unexpected response.');
  });

  it('counts Claude and Codex sessions against one concurrency limit (PRD R38)', async () => {
    const codex = new FakeCodex();
    const { store, source, runtime } = setup(config({ concurrency: 1 }), () => T0, undefined, codex);

    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    runtime.reload({ ...config({ concurrency: 1, provider: 'codex' }), playbooks: PLAYBOOKS });
    runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets', start: true });
    await runtime.settled();

    expect(store.workItem(2)).toMatchObject({ status: 'queued' });
    expect(codex.spawned).toHaveLength(0);
  });

  it("offers Open in Codex once the turn that reported a question ends, and stops the session for it (PRD R70)", async () => {
    const codex = new FakeCodex();
    const { store, runtime } = setup(config({ provider: 'codex' }), () => T0, undefined, codex);
    const log = join(home, '.switchboard', 'codex', 's1.jsonl');
    const opens = () => controlsOf(runtime.snapshot().workItems[0]!).filter((control) => control.message['type'] === 'open-question');

    runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets', start: true });
    await runtime.settled();
    store.updateSession('s1', { execution: null });
    expect(await runtime.report({ sessionId: 's1', kind: 'question', text: 'Which tree?' })).toEqual({ refused: null });
    expect(store.session('s1')!.question).toEqual({ id: 's2', text: 'Which tree?' });

    // Running: the question waits for the turn to end.
    await runtime.readRoster();
    expect(opens()).toEqual([]);

    writeFileSync(log, '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n{"type":"turn.completed"}\n');
    codex.alive.clear();
    await runtime.readRoster();
    await runtime.settled();
    expect(store.session('s1')).toMatchObject({ state: 'waiting', released: false });
    expect(opens().map((control) => control.label)).toEqual(['Open in Codex']);

    expect(runtime.send({ type: 'open-question', workItemId: 1, nativeSessionId: 'thread-1' }).refused).toBeNull();
    await runtime.settled();
    expect(store.workItem(1)).toMatchObject({ status: 'running', error: null });
    expect(store.session('s1')).toMatchObject({ state: 'ended', question: null, outcome: 'opened' });
    expect(markOf({ ...runtime.snapshot().workItems[0]!, approvalSends: false })).toBe('question');
  });

  describe('Codex question races and recovery (PRD R70)', () => {
    const START = '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n';
    const DONE = START + '{"type":"turn.completed"}\n';
    const log = () => join(home, '.switchboard', 'codex', 's1.jsonl');

    it('keeps a question reported while a roster read ran, and decides it at the next read', async () => {
      const codex = new FakeCodex();
      const { store, runtime } = setup(config({ provider: 'codex' }), () => T0, undefined, codex);

      runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets', start: true });
      await runtime.settled();

      const entered = deferred();
      const gate = deferred();

      codex.queryEntered = entered.resolve;
      codex.queryGate = gate.promise;
      const read = runtime.readRoster();

      await entered.promise;
      codex.queryEntered = null;
      await runtime.report({ sessionId: 's1', kind: 'question', text: 'Which tree?' });
      writeFileSync(log(), DONE);
      codex.alive.clear();
      gate.resolve();
      await read;
      await runtime.settled();

      expect(store.session('s1')).toMatchObject({ state: 'waiting', released: false });
      expect(store.session('s1')!.question).toMatchObject({ text: 'Which tree?' });
    });

    it('keeps an approval through a question, and holds no slot while it waits (PRD R34, R38)', async () => {
      const codex = new FakeCodex();
      const cfg = config({ provider: 'codex', concurrency: 1 });
      const { store, runtime } = setup(cfg, () => T0, undefined, codex);

      runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets', start: true });
      await runtime.settled();
      await runtime.report({ sessionId: 's1', kind: 'approval', prompt: '/sb-ship 1', summary: 'Ship it', report: null });
      await runtime.report({ sessionId: 's1', kind: 'question', text: 'Ship now?' });
      writeFileSync(log(), DONE);
      codex.alive.clear();
      await runtime.readRoster();
      await runtime.settled();

      expect(store.workItem(1)).toMatchObject({ status: 'awaiting-approval', approvalPrompt: '/sb-ship 1' });
      expect(store.session('s1')).toMatchObject({ state: 'waiting' });

      runtime.send({ type: 'adhoc', prompt: 'Other work', repoRoot: 'D:/git/widgets', start: true });
      await runtime.settled();
      expect(store.workItem(2)).toMatchObject({ status: 'running' });
    });
  });

  it('stops a running Codex session for the operator by ending its process', async () => {
    const codex = new FakeCodex();
    const { store, runtime } = setup(config({ provider: 'codex' }), () => T0, undefined, codex);

    runtime.send({ type: 'adhoc', prompt: 'Work', repoRoot: 'D:/git/widgets', start: true });
    await runtime.settled();
    await runtime.readRoster();

    expect(runtime.send({ type: 'stop', workItemId: 1 }).refused).toBeNull();
    await runtime.settled();
    expect(codex.kills).toEqual([500]);
    expect(store.workItem(1)).toMatchObject({ status: 'blocked', error: 'Stopped by you.' });
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

    const start = cli.calls.find((call) => call[1] === '--bg');
    expect(start?.slice(-3)).toEqual(['--append-system-prompt', expect.stringMatching(/^Report to Switchboard with these commands:\n- .* stage s1 /), 'Build 8.']);
    expect(store.session('s1')).toMatchObject({ kind: 'task', state: 'running' });
    // After a compaction, the hook gets the contract the session started with (mechanics M30).
    expect(runtime.contract(store.session('s1')!.nativeSessionId!)).toBe(start?.at(-2));
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

    expect(cli.calls.filter((call) => call[1] === '--bg')).toHaveLength(2);
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
    const done = { ticketId: ticket.id, playbook: 'dev:develop', status: 'done', stage: null, stageAt: null, taskPrompt: null, guidance: null, reportedPrompt: null, warning: null, error: null, unassignedAt: null, queuedAt: null, approvalPrompt: null, approvalSummary: null, approvalReport: null, approvalHeld: false, createdAt: T0, statusAt: T0, runStartedAt: null, readyAt: null, orderAt: null, scopeAt: null, doneAt: T0, doneReason: 'operator', parentId: null } as const;
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
    expect(runtime.snapshot().sourceStates).toEqual([{ name: 'github', kind: 'github', enabled: false }]);
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
    expect(runtime.snapshot().sourceStates).toEqual([{ name: 'github', kind: 'github', enabled: false }]);
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
      { name: 'github', kind: 'github', enabled: true },
      { name: 'widgets-dashboard', kind: 'github', enabled: true },
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

  it('leaves an issue on two boards with the source that stored it first and notes it, even after that source is turned off (PRD R44)', async () => {
    const cfg = config();
    cfg.settings.sources['personal'] = { ...cfg.settings.sources['github']! };
    const personal = new FakeSource();
    const { runtime, store, source } = setup(cfg, undefined, undefined, undefined, { personal });
    const shared = { ...issue('63'), url: 'https://github.com/Acme/Widgets/issues/63' };

    source.result = { tickets: [{ ...shared, url: 'https://github.com/acme/widgets/issues/63' }] };
    personal.result = { tickets: [{ ...shared, sourceKey: 'acme/widgets#63' }, issue('4')] };
    await runtime.pollSource('github');
    await runtime.pollSource('personal');

    expect(store.tickets('personal').map((ticket) => ticket.sourceKey)).toEqual(['4']);
    expect(runtime.snapshot().notes).toEqual(['personal: https://github.com/Acme/Widgets/issues/63 belongs to github.']);

    expect(runtime.setSourceEnabled('github', false)).toBeNull();
    await runtime.pollSource('personal');
    expect(store.tickets('personal').map((ticket) => ticket.sourceKey)).toEqual(['4']);
  });

  it('keeps one ticket for an issue two overlapping polls list, whichever stores it first (PRD R44)', async () => {
    const cfg = config();
    cfg.settings.sources['personal'] = { ...cfg.settings.sources['github']! };
    const personal = new FakeSource();
    const { runtime, store, source } = setup(cfg, undefined, undefined, undefined, { personal });
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
    expect(runtime.snapshot().notes).toEqual(['github: https://github.com/acme/widgets/issues/63 belongs to personal.']);
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

describe('Open in Claude (PRD R70)', () => {
  /** A running dev:develop session s1 (short ID 00000001) for ticket 8. */
  async function started() {
    const context = setup(config(), () => T0);
    context.source.result = { tickets: [issue('8')] };
    await context.runtime.pollSource('github');
    await context.runtime.settled();

    return context;
  }

  it('stops the session for Open in Claude without the release check, and keeps the work item waiting on the question', async () => {
    const { store, cli, runtime } = await started();
    runtime.send({ type: 'marker', sessionId: 's1', state: 'waiting', detail: null });
    const roster = cli.calls.filter((call) => call[1] === 'agents').length;

    runtime.send({ type: 'open-question', workItemId: 1, nativeSessionId: '00000001-native' });
    await runtime.settled();

    expect(cli.calls.filter((call) => call[1] === 'stop')).toEqual([['claude', 'stop', '00000001']]);
    expect(cli.calls.filter((call) => call[1] === 'agents')).toHaveLength(roster);
    expect(store.workItem(1)).toMatchObject({ status: 'running', error: null });
    expect(store.session('s1')).toMatchObject({ state: 'ended', released: true, outcome: 'opened' });
    expect(markOf({ ...runtime.snapshot().workItems[0]!, approvalSends: false })).toBe('question');
  });
});

describe('focus (PRD R79)', () => {
  const ISSUE = 'https://github.com/o/r/issues/7';
  const COMMENT = `${ISSUE}#issuecomment-1`;
  const LATER = `${ISSUE}#issuecomment-2`;
  const focused = (focus: string) => ok(JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:develop', focus } }));
  const waiting = (): Config => ({
    ...config(),
    playbooks: new Map([playbook('triage:github', { description: 'Triage', kind: 'triage', template: 'Classify.' }), playbook('dev:develop', { description: 'Build it', focus: 'ticket', template: 'Build {{ticket.sourceKey}}.' })]),
  });

  it("offers the source's anchor ids, focuses the ticket after a failed triage, and stores the chosen comment's URL from Retry's triage", async () => {
    const { store, cli, source, runtime } = setup(waiting());
    source.result = { tickets: [{ ...issue('7'), url: ISSUE }] };
    source.context = async () => {
      return {
        context: 'Issue 7 [ticket]\n### alice, 2026-10-01 [c1]\nPlease fix.\n### bob, 2026-10-02 [c2]\nStill broken.',
        anchors: [
          { id: 'ticket', url: ISSUE, page: 'ticket' },
          { id: 'c1', url: COMMENT, page: 'ticket' },
          { id: 'c2', url: LATER, page: 'ticket' },
        ],
      };
    };
    cli.classifyResult = fail('API Error: 529');

    await runtime.pollSource('github');
    await runtime.settled();

    const schema = JSON.parse(cli.calls.find((call) => call[1] === '-p')![5]!);
    expect(schema.properties.focus).toEqual({ type: 'string', enum: ['ticket', 'c1', 'c2'] });
    expect(runtime.snapshot().workItems[0]).toMatchObject({ status: 'failed', focus: ISSUE });

    cli.classifyResult = focused('c1');
    runtime.send({ type: 'retry', workItemId: 1 });
    await runtime.settled();
    expect(store.triage(2)?.focus).toBe(COMMENT);
    expect(runtime.snapshot().workItems[0]).toMatchObject({ status: 'unstarted', focus: COMMENT });
  });

  it("lists the playbook choices of an unstarted work item, and keeps its focus when Start chooses another (PRD R35)", async () => {
    const cfg = waiting();
    cfg.playbooks.set('dev:other', { ...cfg.playbooks.get('dev:develop')!, name: 'dev:other' });
    const { cli, source, runtime } = setup(cfg);
    source.result = { tickets: [{ ...issue('7'), url: ISSUE }] };
    source.context = async () => ({ context: 'Issue 7 [ticket]\n### alice, 2026-10-01 [c1]\nPlease fix.', anchors: [{ id: 'ticket', url: ISSUE, page: 'ticket' }, { id: 'c1', url: COMMENT, page: 'ticket' }] });
    cli.classifyResult = focused('c1');

    await runtime.pollSource('github');
    await runtime.settled();
    expect(runtime.snapshot().workItems[0]).toMatchObject({ status: 'unstarted', playbook: 'dev:develop', playbookChoices: ['dev:develop', 'dev:other'] });

    expect(runtime.send({ type: 'start', workItemId: 1, playbook: 'dev:other' }).refused).toBeNull();
    expect(runtime.snapshot().workItems[0]).toMatchObject({ playbook: 'dev:other', playbookChoices: [], focus: COMMENT });
  });

  it('focuses the ticket when the source tags no anchors', async () => {
    const { store, cli, source, runtime } = setup(waiting());
    source.result = { tickets: [{ ...issue('7'), url: ISSUE }] };
    cli.classifyResult = focused('c1');

    await runtime.pollSource('github');
    await runtime.settled();

    expect(JSON.parse(cli.calls.find((call) => call[1] === '-p')![5]!).properties).not.toHaveProperty('focus');
    expect(store.triage(1)?.focus).toBeNull();
    expect(runtime.snapshot().workItems[0]?.focus).toBe(ISSUE);
  });
});

describe('activity since the earlier work item (PRD R80)', () => {
  const NOTE = 'Earlier work: a dev:question work item for this ticket handled the activity up to 2026-10-03 12:00 UTC, so that activity is background.';

  /** Marks issue 7's first work item done at T0, then reassigns it an hour later, so work item 2 triages to the auto-starting dev:develop. */
  async function reassigned(activityAt: number | null | undefined) {
    let now = T0;
    const cfg = { ...config(), playbooks: new Map([...PLAYBOOKS, playbook('dev:question', { description: 'Answer it', template: 'Answer {{ticket.sourceKey}}.' })]) };
    const env = setup(cfg, () => now);
    env.source.result = { tickets: [issue('7')] };
    env.source.context = async () => ({ context: 'Issue 7 text', ...(activityAt === undefined ? {} : { activityAt }) });
    env.cli.classifyResult = ok(JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:question' } }));

    await env.runtime.pollSource('github');
    await env.runtime.settled();
    env.runtime.send({ type: 'mark-done', workItemId: 1 });
    env.source.result = { tickets: [] };
    await env.runtime.pollSource('github');

    now = T0 + 60 * 60_000;
    env.cli.classifyResult = ok(JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:develop' } }));
    env.source.result = { tickets: [issue('7')] };
    await env.runtime.pollSource('github');
    await env.runtime.settled();

    return env;
  }

  it('tells triage that nothing is newer and leaves an auto-starting playbook unstarted when no activity is newer, or there is none', async () => {
    for (const activityAt of [T0 - 60_000, T0, null]) {
      const { store } = await reassigned(activityAt);

      expect(store.triage(2)?.context).toBe(`Current time: 2026-10-03 13:00 UTC\n\n${NOTE} Nothing from anyone else in the activity below is newer, so nothing new asks for an action.\n\nIssue 7 text`);
      expect({ activityAt, ...store.workItem(2) }).toMatchObject({ activityAt, status: 'unstarted', playbook: 'dev:develop' });
      expect(store.ticketHistory(1)?.events.find((event) => event.type === 'triage-succeeded' && event.workItemId === 2)?.detail).toMatchObject({ playbook: 'dev:develop', stale: true });
    }
  });

  it('starts the playbook, naming the earlier work item without saying nothing is newer, when activity is newer or the source reports none', async () => {
    for (const activityAt of [T0 + 1, undefined]) {
      const { store } = await reassigned(activityAt);

      expect(store.triage(2)?.context).toBe(`Current time: 2026-10-03 13:00 UTC\n\n${NOTE}\n\nIssue 7 text`);
      expect({ activityAt, status: store.workItem(2)?.status }).toEqual({ activityAt, status: 'running' });
      expect(store.ticketHistory(1)?.events.find((event) => event.type === 'triage-succeeded' && event.workItemId === 2)?.detail).not.toHaveProperty('stale');
    }
  });
});

describe('forks (PRD R78)', () => {
  const FORK = { nativeSessionId: '9e8d7c6b-0000', shortId: '9e8d7c6b' };

  /** A Claude runner whose roster, markers and transcript answers the test sets. */
  function forking() {
    const real = new ClaudeRunner({ claudePath: () => 'claude', exec: async () => ok('[]'), sleep: async () => {}, now: () => T0, home, claudeSettings: join(home, '.claude', 'settings.json'), hooks: () => true, nodePath: () => 'node' });
    const state = {
      reads: 0,
      listed: true,
      forks: [] as { sessionId: string; nativeSessionId: string; shortId: string; state: 'running' | 'idle'; detail: null }[],
      markers: new Map<string, { at: number; cwd: string | null; observed: null; recheck: false }>(),
      relation: 'unrelated' as 'newer' | 'older' | 'unrelated',
      forkOf: null as Session | null,
    };
    const runner: SessionRunner = Object.assign(Object.create(real) as SessionRunner, {
      start: async () => ({ shortId: 'abc12345', nativeSessionId: 'native-1' }),
      isBackground: async () => true,
      stop: async () => null,
      markers: () => state.markers,
      observe: async (sessions: Session[]) => {
        state.reads += 1;
        return { sessions: state.listed ? sessions.filter((session) => session.state !== 'ended').map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) : [], forks: state.forks };
      },
      relation: () => state.relation,
      forkOf: () => state.forkOf,
    });

    return { runner, state };
  }

  async function released() {
    const fake = forking();
    const setUp = setup(config(), () => T0, { claude: fake.runner });

    setUp.runtime.send({ type: 'adhoc', prompt: 'test', repoRoot: 'D:/git/widgets', start: true });
    await setUp.runtime.settled();
    // The turn ends, and the release stop ends the background process.
    await setUp.runtime.readRoster();
    await setUp.runtime.settled();
    fake.state.listed = false;
    expect(setUp.store.session('s1')).toMatchObject({ nativeSessionId: 'native-1', released: true, releasing: false });

    return { ...setUp, ...fake };
  }

  it("sends the runner's forks with the roster, and the flow continues the session as the fork", async () => {
    const { runtime, store, state } = await released();

    state.forks = [{ sessionId: 's1', ...FORK, state: 'running', detail: null }];
    await runtime.readRoster();
    expect(store.session('s1')).toMatchObject({ ...FORK, retiredIds: ['native-1'], state: 'running' });
    runtime.stop();
  });

  it("reads the roster when an unknown copy's marker changes in a session's project directory", async () => {
    const { runtime, state } = await released();
    const reads = async () => {
      runtime.readMarkers();
      await new Promise((done) => setImmediate(done));
      return state.reads;
    };
    const before = state.reads;

    state.markers.set(FORK.nativeSessionId, { at: 1, cwd: 'd:\\git\\widgets', observed: null, recheck: false });
    expect(await reads()).toBe(before + 1);
    expect(await reads()).toBe(before + 1);
    state.markers.set(FORK.nativeSessionId, { at: 2, cwd: 'd:\\git\\widgets', observed: null, recheck: false });
    expect(await reads()).toBe(before + 2);
    state.markers.set('other', { at: 1, cwd: 'D:/git/other', observed: null, recheck: false });
    state.markers.set('old', { at: 1, cwd: null, observed: null, recheck: false });
    expect(await reads()).toBe(before + 2);
    runtime.stop();
  });

  it('refuses a report from a retired copy, records one from a newer fork and reads the roster, and records one from an unrelated copy', async () => {
    const { runtime, store, state } = await released();
    const before = state.reads;

    state.relation = 'older';
    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Planning' }, 'old-copy')).toEqual({ refused: 'Session old-copy was replaced by fork abc12345, so the report was not recorded.' });
    expect(store.workItem(1)?.stage).toBeNull();

    state.relation = 'newer';
    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Planning' }, 'new-copy')).toEqual({ refused: null });
    expect(state.reads).toBe(before + 1);

    state.relation = 'unrelated';
    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Testing' }, 'other')).toEqual({ refused: null });
    // The current copy, or a report without a copy, is not resolved.
    state.relation = 'older';
    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Testing' }, 'native-1')).toEqual({ refused: null });
    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Testing' })).toEqual({ refused: null });
    runtime.stop();
  });

  it('refuses a report from the copy a fork retired while its worktree check ran', async () => {
    const { runtime, store, state, cli } = await released();
    const gate = deferred();
    const entered = deferred();

    cli.gitGate = gate.promise;
    cli.gitEntered = entered.resolve;
    const report = runtime.report({ sessionId: 's1', kind: 'worktree', path: 'D:/git/widgets-wt/7-fix' }, 'native-1');
    await entered.promise;
    state.forks = [{ sessionId: 's1', ...FORK, state: 'running', detail: null }];
    state.relation = 'older';
    await runtime.readRoster();
    gate.resolve();

    expect(await report).toEqual({ refused: 'Session native-1 was replaced by fork 9e8d7c6b, so the report was not recorded.' });
    expect(store.worktreeFor(1)).toBeNull();
    runtime.stop();
  });

  it('refuses a done report from the copy a fork retired while the assignment read ran', async () => {
    const fake = forking();
    const { runtime, store, source } = setup(config(), () => T0, { claude: fake.runner });
    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();
    await runtime.readRoster();
    await runtime.settled();
    fake.state.listed = false;
    const gate = deferred();

    source.gate = gate.promise;
    const report = runtime.report({ sessionId: 's1', kind: 'done' }, 'native-1');
    await new Promise((done) => setImmediate(done));
    fake.state.forks = [{ sessionId: 's1', ...FORK, state: 'running', detail: null }];
    fake.state.relation = 'older';
    await runtime.readRoster();
    gate.resolve();

    expect(await report).toEqual({ refused: 'Session native-1 was replaced by fork 9e8d7c6b, so the report was not recorded.' });
    expect(store.session('s1')).toMatchObject({ ...FORK, outcome: null });
    expect(store.workItem(1)?.status).toBe('running');
    runtime.stop();
  });

  it("ignores the Claude copy a Codex session's report names, which it inherited", async () => {
    const { runtime, store, state } = await released();

    store.updateSession('s1', { provider: 'codex' });
    state.relation = 'older';
    expect(await runtime.report({ sessionId: 's1', kind: 'stage', stage: 'Planning' }, 'inherited')).toEqual({ refused: null });
    runtime.stop();
  });

  it('restores the contract of a session to a newer fork that compacts before it is adopted', async () => {
    const { runtime, store, state } = await released();

    expect(runtime.contract(FORK.nativeSessionId)).toBeNull();
    state.forkOf = store.session('s1');
    expect(runtime.contract(FORK.nativeSessionId)).toContain('report stage s1');
    runtime.stop();
  });

  it('names the copy a stop targeted in its result', async () => {
    const { runtime, store } = await released();
    const send = vi.spyOn(runtime, 'send');

    store.updateSession('s1', { state: 'idle', released: false });
    runtime.send({ type: 'stop', workItemId: 1 });
    await runtime.settled();
    expect(send).toHaveBeenCalledWith({ type: 'stop-succeeded', sessionId: 's1', reason: 'operator', shortId: 'abc12345' });
    runtime.stop();
  });
});

describe('registered sessions (PRD R81)', () => {
  const NATIVE = '9273f594-1111-4222-8333-444455556666';

  /** A Claude runner whose roster lists `live` and whose transcripts relate a native ID to a session by `relation`. */
  function registering(live: Awaited<ReturnType<NonNullable<SessionRunner['live']>>>, relation: (native: string) => CopyRelation = () => 'unrelated') {
    const real = new ClaudeRunner({ claudePath: () => 'claude', exec: async () => ok('[]'), sleep: async () => {}, now: () => T0, home, claudeSettings: join(home, '.claude', 'settings.json'), hooks: () => true, nodePath: () => 'node' });

    return Object.assign(Object.create(real) as SessionRunner, { live: async () => live, relation });
  }

  it('registers a live session in its directory and answers its key and contract, which the compaction hook also gets', async () => {
    const { runtime, store } = setup(config(), () => T0, { claude: registering({ shortId: '9273f594', cwd: 'D:/git/widgets' }) });

    const result = await runtime.register(NATIVE, 'Fix the badge');

    expect(result).toEqual({ key: 'adhoc 1', already: false, contract: expect.stringMatching(/^Report to Switchboard with these commands:\n- node ".*hub\.js" report stage s1 /) });
    expect(runtime.contract(NATIVE)).toBe((result as { contract: string }).contract);
    expect(store.session('s1')).toMatchObject({ nativeSessionId: NATIVE, shortId: '9273f594', cwd: 'D:/git/widgets', released: true, external: true });
    expect(runtime.snapshot().workItems).toMatchObject([{ status: 'running', ticket: { title: 'Fix the badge', repoRoot: 'D:/git/widgets' } }]);
  });

  it('refuses a session the roster does not list, a failed roster read, and a newer, older or retired copy of a Switchboard session, and answers a second registration again', async () => {
    const unlisted = setup(config(), () => T0, { claude: registering(null) });
    expect(await unlisted.runtime.register(NATIVE, 'x')).toEqual({ refused: `Claude does not list session ${NATIVE} as running.` });

    const failed = setup(config(), () => T0, { claude: registering({ error: 'claude agents timed out' }) });
    expect(await failed.runtime.register(NATIVE, 'x')).toEqual({ refused: 'claude agents timed out' });

    const copies: Record<string, CopyRelation> = { 'newer-copy': 'newer', 'older-copy': 'older' };
    const { runtime, store } = setup(config(), () => T0, { claude: registering({ shortId: '9273f594', cwd: 'D:/git/widgets' }, (native) => copies[native] ?? 'unrelated') });

    const first = await runtime.register(NATIVE, 'First');
    expect(await runtime.register(NATIVE, 'Again')).toEqual({ ...first, already: true });

    for (const copy of ['newer-copy', 'older-copy']) {
      expect(await runtime.register(copy, 'Copy')).toEqual({ refused: 'This session is a copy of adhoc 1, which Switchboard continues in its latest copy.' });
    }

    store.updateSession('s1', { retiredIds: ['retired-copy'] });
    expect(await runtime.register('retired-copy', 'Copy')).toEqual({ refused: 'This session is a copy of adhoc 1, which Switchboard continues in its latest copy.' });
    expect(store.tickets('adhoc')).toHaveLength(1);
    expect(unlisted.store.tickets('adhoc')).toEqual([]);
  });
});

describe('ticket reports (PRD R83)', () => {
  const NATIVE = '9273f594-1111-4222-8333-444455556666';
  const URL = 'https://github.com/o/r/issues/115';
  const found = (open = true) => ({ ticket: { sourceKey: '115', ref: '#115', repo: '', title: 'Snapshot wrapper', url: URL, open } });

  async function registered() {
    const real = new ClaudeRunner({ claudePath: () => 'claude', exec: async () => ok('[]'), sleep: async () => {}, now: () => T0, home, claudeSettings: join(home, '.claude', 'settings.json'), hooks: () => true, nodePath: () => 'node' });
    // `old-copy` is a copy a fork retired, and so is the registered copy once a fork named `fork-copy` continues it (PRD R78).
    const claude = Object.assign(Object.create(real) as SessionRunner, {
      live: async () => ({ shortId: '9273f594', cwd: 'D:/git/widgets' }),
      relation: (native: string, session: Session): CopyRelation => (native === 'old-copy' || (native === NATIVE && session.nativeSessionId === 'fork-copy') ? 'older' : 'unrelated'),
    });
    const harness = setup(config(), () => T0, { claude });

    await harness.runtime.register(NATIVE, 'Explore snapshots');

    return harness;
  }

  it('asks each enabled source until one has the issue on its board, refuses when none has, and treats a failed read as a refusal (PRD R83)', async () => {
    const real = new ClaudeRunner({ claudePath: () => 'claude', exec: async () => ok('[]'), sleep: async () => {}, now: () => T0, home, claudeSettings: join(home, '.claude', 'settings.json'), hooks: () => true, nodePath: () => 'node' });
    const claude = Object.assign(Object.create(real) as SessionRunner, { live: async () => ({ shortId: '9273f594', cwd: 'D:/git/widgets' }), relation: (): CopyRelation => 'unrelated' });
    const cfg = config();
    cfg.settings.sources['personal'] = { ...cfg.settings.sources['github']! };
    const personal = new FakeSource();
    const { runtime, source, store } = setup(cfg, () => T0, { claude }, undefined, { personal });
    await runtime.register(NATIVE, 'Explore snapshots');
    const asked: string[] = [];
    source.ticketAt = async () => (asked.push('github'), null);
    personal.ticketAt = async () => (asked.push('personal'), { ticket: { ...found().ticket, sourceKey: 'o/r#115', ref: 'o/r#115', repo: 'o/r' } });

    expect(await runtime.ticket('s1', URL, null, NATIVE)).toMatchObject({ key: 'personal o/r#115' });
    expect(asked).toEqual(['github', 'personal']);
    expect(store.ticket(1)).toMatchObject({ source: 'personal', sourceKey: 'o/r#115', repo: 'o/r' });

    personal.ticketAt = async () => null;
    expect(await runtime.ticket('s1', 'https://github.com/o/r/issues/9', null, NATIVE)).toEqual({ refused: 'No enabled source has https://github.com/o/r/issues/9 on its board.' });

    // The owner of a stored issue answers for it; while it is off, no other source may store the issue again.
    expect(runtime.setSourceEnabled('personal', false)).toBeNull();
    source.ticketAt = async () => found();
    expect(await runtime.ticket('s1', URL.toUpperCase().replace('HTTPS://GITHUB.COM', 'https://github.com'), null, NATIVE)).toEqual({ refused: `${URL.toUpperCase().replace('HTTPS://GITHUB.COM', 'https://github.com')} belongs to personal, which is off. Turn it on in the header.` });
    expect(await runtime.handled('s1', URL, null, NATIVE)).toEqual({ refused: `${URL} belongs to personal, which is off. Turn it on in the header.` });
    expect(runtime.setSourceEnabled('personal', true)).toBeNull();
    source.ticketAt = async () => ({ error: 'offline' });
    expect(await runtime.ticket('s1', 'https://github.com/o/r/issues/9', null, NATIVE)).toEqual({ refused: 'offline' });
  });

  it("moves a registered session's work item onto the issue and answers its key and the playbook's contract, again for a retry and after compaction", async () => {
    const { runtime, source, store } = await registered();
    const urls: string[] = [];
    source.ticketAt = async (url) => {
      urls.push(url);
      return found();
    };

    const result = await runtime.ticket('s1', URL, 'dev:develop', NATIVE);

    expect(result).toEqual({ key: 'github 115', contract: expect.stringMatching(/^Report to Switchboard with these commands:\n/) });
    const { contract } = result as { contract: string };
    expect(contract).toContain('report approval s1 ');
    expect(contract).not.toContain('report paste s1 ');
    expect(runtime.contract(NATIVE)).toBe(contract);
    expect(urls).toEqual([URL]);
    expect(store.ticket(1)).toMatchObject({ source: 'github', sourceKey: '115', title: 'Snapshot wrapper', url: URL, assigned: false, adhocKey: '1' });
    expect(runtime.snapshot().workItems).toMatchObject([{ playbook: 'dev:develop', status: 'running', moved: true, ticket: { source: 'github', sourceKey: '115' } }]);
    expect(await runtime.ticket('s1', URL, 'dev:develop', NATIVE)).toEqual(result);

    // Once the work is done, the issue's return to scope makes a work item of its own, which was not moved.
    runtime.send({ type: 'mark-done', workItemId: 1 });
    expect(runtime.snapshot().workItems.map((item) => [item.id, item.reopenable])).toEqual([[1, true]]);
    source.result = { tickets: [{ ...issue('115'), url: URL }] };
    await runtime.pollSource('github');
    await runtime.settled();
    // Only the ticket's latest work item, once done, can be reopened (PRD R86).
    expect(runtime.snapshot().workItems.map((item) => [item.id, item.moved, item.reopenable])).toEqual([
      [2, false, false],
      [1, true, false],
    ]);
  });

  it('refuses a URL no enabled source has, a closed issue, a failed or late lookup, an unknown session and a retired copy, and logs each refusal', async () => {
    const { runtime, source, store, late } = await registered();
    const refused = async (url = URL, native: string | null = NATIVE, sessionId = 's1') => ((await runtime.ticket(sessionId, url, null, native)) as { refused: string }).refused;

    expect(await refused()).toBe(`No enabled source has ${URL} on its board.`);
    source.ticketAt = async () => null;
    expect(await refused()).toBe(`No enabled source has ${URL} on its board.`);
    source.ticketAt = async () => found(false);
    expect(await refused()).toBe('#115 is closed.');
    source.ticketAt = async () => ({ error: 'Issue #115 was not found in o/r.' });
    expect(await refused()).toBe('Issue #115 was not found in o/r.');
    source.ticketAt = async () => {
      throw new Error('boom');
    };
    expect(await refused()).toBe('Error: boom');
    source.ticketAt = () => new Promise(() => {});
    const pending = refused();
    late.resolve();
    expect(await pending).toBe(`github did not answer within ${REPORT_CHECK_MS / 1000} seconds.`);
    expect(await refused(URL, null, 's9')).toBe('Unknown session s9.');

    source.ticketAt = async () => found();
    expect(await refused(URL, 'old-copy')).toBe('Session old-copy was replaced by fork 9273f594, so the report was not recorded.');
    // A roster read continues the session as a fork while the lookup runs.
    source.ticketAt = async () => {
      store.updateSession('s1', { nativeSessionId: 'fork-copy', shortId: 'f0f0f0f0' });
      return found();
    };
    expect(await refused()).toBe('Session 9273f594 was replaced by fork f0f0f0f0, so the report was not recorded.');
    store.updateSession('s1', { nativeSessionId: NATIVE, shortId: '9273f594' });
    // The operator turns the source off while the lookup runs.
    source.ticketAt = async () => {
      runtime.setSourceEnabled('github', false);
      return found();
    };
    expect(await refused()).toBe('The github source changed during the lookup. Send the report again.');

    expect(store.ticket(1)).toMatchObject({ source: 'adhoc', sourceKey: '1', adhocKey: null });
    expect(store.ticketHistory(1)!.events.filter((event) => event.refused !== null).map((event) => [event.detail, event.refused])).toEqual([
      [{ kind: 'ticket', url: URL }, `No enabled source has ${URL} on its board.`],
      [{ kind: 'ticket', url: URL }, `No enabled source has ${URL} on its board.`],
      [{ kind: 'ticket', url: URL }, '#115 is closed.'],
      [{ kind: 'ticket', url: URL }, 'Issue #115 was not found in o/r.'],
      [{ kind: 'ticket', url: URL }, 'Error: boom'],
      [{ kind: 'ticket', url: URL }, `github did not answer within ${REPORT_CHECK_MS / 1000} seconds.`],
      [{ kind: 'ticket', url: URL }, 'Session old-copy was replaced by fork 9273f594, so the report was not recorded.'],
      [{ kind: 'ticket', url: URL }, 'Session 9273f594 was replaced by fork f0f0f0f0, so the report was not recorded.'],
      [{ kind: 'ticket', url: URL }, 'The github source changed during the lookup. Send the report again.'],
    ]);
  });
});


describe('Code Mode sessions (PRD R93-R95)', () => {
  /** A stand-in runner whose observation and stops a test sets. */
  function fakeRunner(overrides: Partial<SessionRunner> = {}): SessionRunner & { stops: string[]; starts: string[] } {
    const stops: string[] = [];
    const starts: string[] = [];

    return {
      start: async (action) => {
        starts.push(action.sessionId);
        return { shortId: `${action.sessionId}-short`, nativeSessionId: `${action.sessionId}-native`, ...(action.codeMode === true ? { launchId: `${action.sessionId}-launch` } : {}) };
      },
      observe: async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) }),
      markers: () => new Map(),
      isBackground: async () => true,
      stop: async (target) => {
        stops.push(target.sessionId);
        return null;
      },
      reconcile: async () => [],
      installHooks: async () => null,
      stops,
      starts,
      ...overrides,
    };
  }

  /** A background session s1 and a held Code Mode session s2, both running. */
  async function twoSessions(codeMode: SessionRunner) {
    const claude = fakeRunner();
    const context = setup(config(), () => T0, { claude, codeMode });

    context.runtime.send({ type: 'adhoc', prompt: 'background', repoRoot: 'D:/git/widgets', start: true });
    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();
    context.store.updateSession('s2', { codeMode: true, launchId: 'launch-2' });

    return { ...context, claude };
  }

  it('starts a Code Mode session with the Code Mode runner and records its launch', async () => {
    const claude = fakeRunner();
    const codeMode = fakeRunner();
    const { runtime, store } = setup(config(), () => T0, { claude, codeMode });

    runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: false });
    const session = { id: 's9', workItemId: 1, kind: 'task' as const, provider: 'claude' as const, cwd: 'D:/git/widgets', state: 'starting' as const, stateAt: T0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: T0, endedAt: null, released: false, releasing: false, question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null, nativeSessionId: null, shortId: null, codeMode: true, launchId: null };

    store.insertSession(session);
    await runtime['run']({ type: 'start-session', sessionId: 's9', workItemId: 1, kind: 'task', provider: 'claude', cwd: 'D:/git/widgets', prompt: 'p', contract: 'c', name: 'n', permissionMode: 'auto', model: null, codeMode: true });

    expect(codeMode.starts).toEqual(['s9']);
    expect(claude.starts).toEqual([]);
    expect(store.session('s9')).toMatchObject({ state: 'running', nativeSessionId: 's9-native', launchId: 's9-launch' });
    runtime.stop();
  });

  it('starts new Claude sessions with the Code Mode runner while sessions.codeMode is on, with the IDs stored before the start', async () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const claude = fakeRunner();
    const seen: { action: StartAction; stored: Session | null }[] = [];
    const codeMode = fakeRunner();
    const context = setup(config({ codeMode: true }), () => T0, { claude, codeMode });

    codeMode.start = async (action) => {
      seen.push({ action, stored: context.store.session(action.sessionId) });
      return { shortId: action.nativeSessionId!.slice(0, 8), nativeSessionId: action.nativeSessionId!, launchId: action.launchId! };
    };
    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();

    expect(claude.starts).toEqual([]);
    expect(seen).toHaveLength(1);
    const [{ action, stored }] = seen as [(typeof seen)[number]];
    expect(action).toMatchObject({ provider: 'claude', codeMode: true, nativeSessionId: expect.stringMatching(UUID), launchId: expect.stringMatching(UUID) });
    expect(action.nativeSessionId).not.toBe(action.launchId);
    expect(stored).toMatchObject({ state: 'starting', codeMode: true, nativeSessionId: action.nativeSessionId, launchId: action.launchId });
    expect(context.store.session(action.sessionId)).toMatchObject({ state: 'running', shortId: action.nativeSessionId!.slice(0, 8) });
    context.runtime.stop();
  });

  it('defers a held turn end until a conversation read only asynchronously is in, and drops it for a newer state (PRD R103)', async () => {
    const codeMode = fakeRunner();
    const { runtime, store } = setup(config({ codeMode: true }), () => T0, { codeMode });

    runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await runtime.settled();
    const id = store.activeSessions()[0]!.id;
    let release = (): void => {};
    let held = true;
    runtime.setConversationReader({
      read: () => {},
      catchUp: () => (held ? new Promise<void>((resolve) => { release = () => { held = false; resolve(); }; }) : null),
    });

    runtime.send({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    expect(store.session(id)?.state).toBe('running');
    store.addReply({ id: 'r1', sessionId: id, workItemId: 1, at: T0, kind: 'reply', answers: null, opening: '1. Which?\n   - A) One\n   - B) Two', source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: 'r1' });
    release();
    await runtime.settled();
    expect(store.session(id)).toMatchObject({ state: 'idle', stateDetail: QUESTION_CARD });
    expect(store.workItem(1)?.status).toBe('running');

    // A held idle marker that a newer state overtook is dropped.
    held = true;
    runtime.send({ type: 'marker', sessionId: id, state: 'running', detail: null });
    runtime.send({ type: 'marker', sessionId: id, state: 'idle', detail: null });
    const deferredRelease = release;
    held = false;
    runtime.send({ type: 'marker', sessionId: id, state: 'waiting', detail: null });
    deferredRelease();
    await runtime.settled();
    expect(store.session(id)?.state).toBe('waiting');
    runtime.stop();
  });

  it('finds a card after more replies than one page, and takes no message still being typed as its answer (PRD R103)', () => {
    const store = Store.open(':memory:');
    const reply = (id: string, opening: string, at: number) => store.addReply({ id, sessionId: 's1', workItemId: 1, at, kind: 'reply', answers: null, opening, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: id });

    store.addMessage({ id: 'm1', sessionId: 's1', workItemId: 1, at: T0, origin: 'terminal', text: 'Go', transcriptUuid: 'm1', provisional: false, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null });
    reply('card', '1. Which?\n   - A) One\n   - B) Two', T0 + 1);
    for (let index = 0; index < 150; index++) reply(`r${index}`, `Step ${index}.`, T0 + 2 + index);
    expect(questionCardOpen(store, 's1')).toBe(true);

    store.addMessage({ id: 'm2', sessionId: 's1', workItemId: 1, at: T0 + 500, origin: 'typed', text: '1A', transcriptUuid: null, provisional: true, withdrawn: false, delivery: 'open', error: null, opId: 'o', pastedAt: null });
    expect(questionCardOpen(store, 's1')).toBe(true);
    store.updateMessage('m2', { delivery: 'sent', provisional: false });
    expect(questionCardOpen(store, 's1')).toBe(false);
    store.close();
  });

  it('reads the conversation before a held turn ends, so a question card written last keeps its work item waiting on the answer (PRD R103)', async () => {
    const codeMode = fakeRunner();
    const context = setup(config({ codeMode: true }), () => T0, { codeMode });
    const { runtime, store } = context;
    const reads: string[][] = [];

    runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await runtime.settled();
    const session = store.activeSessions()[0]!;
    const reply = (id: string, opening: string) => store.addReply({ id, sessionId: session.id, workItemId: 1, at: T0, kind: 'reply', answers: null, opening, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: id });

    store.addMessage({ id: 'm1', sessionId: session.id, workItemId: 1, at: T0, origin: 'terminal', text: 'Start', transcriptUuid: 'm1', provisional: false, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null });
    // The card reaches the store only through the read the turn's end asks for, as a transcript line read between polls does.
    runtime.setConversationReader({
      read: (ids) => {
        reads.push([...ids]);
        reply('r1', 'Before I go on:\n\n1. Which port?\n   - A) 8765\n   - B) 8799');
      },
      catchUp: () => null,
    });
    runtime.send({ type: 'marker', sessionId: session.id, state: 'idle', detail: null });

    expect(reads).toEqual([[session.id]]);
    expect(store.session(session.id)).toMatchObject({ state: 'idle', stateDetail: QUESTION_CARD });
    expect(store.workItem(1)?.status).toBe('running');
    expect(markOf({ ...store.workItem(1)!, sessions: store.sessionsFor(1), triage: null, approvalSends: false })).toBe('question');

    // The marker keeps reading idle while the card waits; that is no change to send again.
    codeMode.markers = () => new Map([[session.nativeSessionId!, { at: 1, observed: { state: 'idle' as const, detail: null }, recheck: false }]]);
    const sent = vi.spyOn(runtime, 'send');
    runtime.readMarkers();
    expect(sent).not.toHaveBeenCalled();
    // A session already idle needs no read before the flow decides.
    runtime.send({ type: 'roster', sessions: [{ sessionId: session.id, state: 'idle', detail: null }] });
    expect(reads).toHaveLength(1);

    // Once a message answers the card, the next idle reading settles the turn as before: this prompt offers done, so it blocks.
    store.addMessage({ id: 'm2', sessionId: session.id, workItemId: 1, at: T0 + 1, origin: 'terminal', text: '1A', transcriptUuid: 'm2', provisional: false, withdrawn: false, delivery: null, error: null, opId: null, pastedAt: null });
    runtime.send({ type: 'roster', sessions: [{ sessionId: session.id, state: 'idle', detail: null }] });
    expect(store.session(session.id)?.stateDetail).toBeNull();
    expect(store.workItem(1)?.status).toBe('blocked');
    runtime.stop();
  });

  it('gives a Code Mode session the conversation rules after a resume and with its contract after a compaction', async () => {
    const codeMode = fakeRunner();
    const context = setup(config({ codeMode: true }), () => T0, { codeMode });

    codeMode.start = async (action) => ({ shortId: action.nativeSessionId!.slice(0, 8), nativeSessionId: action.nativeSessionId!, launchId: action.launchId! });
    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();

    const session = context.store.activeSessions()[0]!;

    expect(context.runtime.contract(session.nativeSessionId!, 'resume')).toBe(conversationRules(join(session.cwd, '.wip', 'artifacts', `w${session.workItemId}`)));
    expect(context.runtime.contract(session.nativeSessionId!, 'resume')).toContain(`artifact folder, \`${join(session.cwd, '.wip', 'artifacts', `w${session.workItemId}`)}\``);
    expect(context.runtime.contract(session.nativeSessionId!, 'compact')).toMatch(/^Report to Switchboard with these commands:\n[\s\S]*\n\n## Conversation view\n/);
    expect(context.runtime.contract(session.nativeSessionId!, 'resume')).not.toContain('## Spoken replies');

    // With voice on, the rules carry the spoken-reply section, after a resume and after a compaction.
    const voiced = config({ codeMode: true });

    context.runtime.reload({ ...voiced, settings: { ...voiced.settings, voice: { ...voiced.settings.voice, enabled: true } } });
    expect(context.runtime.contract(session.nativeSessionId!, 'resume')).toBe(conversationRules(join(session.cwd, '.wip', 'artifacts', `w${session.workItemId}`), true));
    expect(context.runtime.contract(session.nativeSessionId!, 'compact')).toContain('## Spoken replies');
    context.runtime.stop();
  });

  it("gives a Code Mode session its persona's tone section last, as the settings have it now, and records it (architecture.md § Personas)", async () => {
    const codeMode = fakeRunner();
    const base = config({ codeMode: true });
    const nova = { id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: 'Warm and direct.' } as const;
    const orion = { id: 'orion', name: 'Orion', voice: 'ash', style: 'none', personality: 'Terse.' } as const;
    const voiced = { ...base, settings: { ...base.settings, voice: { ...base.settings.voice, enabled: true, personas: [nova, orion] } } };
    const context = setup(voiced, () => T0, { codeMode });
    const starts: StartAction[] = [];

    codeMode.start = async (action) => (starts.push(action), { shortId: action.nativeSessionId!.slice(0, 8), nativeSessionId: action.nativeSessionId!, launchId: action.launchId! });
    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();

    const session = context.store.activeSessions()[0]!;

    expect(starts[0]?.tone).toBe(toneSection(nova));
    expect(context.runtime.contract(session.nativeSessionId!, 'resume')).toMatch(/\n\n## Persona\nIn this session you are Nova\. Warm and direct\.\n[^#]*$/);

    // A pin waits for the hook, which records the section it gave.
    context.runtime.send({ type: 'persona', sessionId: session.id, personaId: 'orion' });
    expect(context.store.session(session.id)?.personaVersion).toBe(toneVersion(toneSection(nova)));
    expect(context.runtime.contract(session.nativeSessionId!, 'compact')).toContain('In this session you are Orion. Terse.');
    expect(context.store.session(session.id)?.personaVersion).toBe(toneVersion(toneSection(orion)));

    // With voice off, a reset in place of the section the launch's prompt may still carry.
    context.runtime.reload(base);
    expect(context.runtime.contract(session.nativeSessionId!, 'resume')).toMatch(/\n\n## Persona\nNo persona applies in this session any more: ignore any earlier Persona section\.$/);
    expect(context.store.session(session.id)?.personaVersion).toBeNull();
    context.runtime.stop();
  });

  it('gives a background session nothing after a resume, which keeps its contract, and only its contract after a compaction', async () => {
    const { source, runtime, store } = setup();

    source.result = { tickets: [issue('8')] };
    await runtime.pollSource('github');
    await runtime.settled();

    const native = store.session('s1')!.nativeSessionId!;

    expect(runtime.contract(native, 'resume')).toBeNull();
    expect(runtime.contract(native, 'compact')).not.toContain('## Conversation view');
    runtime.stop();
  });

  it('applies the background runner\'s observation when the holder read fails, and changes no held session', async () => {
    const codeMode = fakeRunner({ observe: async () => ({ error: 'The terminal holder did not answer.' }) });
    const { runtime, store, claude, logs } = await twoSessions(codeMode);

    claude.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) });
    await runtime.readRoster();

    // The background session's turn end applied, so it was released.
    expect(claude.stops).toEqual(['s1']);
    expect(store.session('s1')).toMatchObject({ released: true });
    expect(store.session('s2')).toMatchObject({ state: 'running', released: false });
    expect(logs).toContain('codeMode roster read failed: The terminal holder did not answer.');
    runtime.stop();
  });

  it('ends the sessions of a gone holder with the cause, not as finished runs', async () => {
    const codeMode = fakeRunner({ observe: async () => ({ sessions: [], forks: [], gone: true }) });
    const { runtime, store } = await twoSessions(codeMode);

    await runtime.readRoster();

    expect(store.session('s2')).toMatchObject({ state: 'ended', outcome: 'failed', outcomeDetail: 'The terminal holder stopped.' });
    expect(store.workItem(store.session('s2')!.workItemId)).toMatchObject({ status: 'blocked', error: 'The terminal holder stopped.' });
    expect(store.session('s1')).toMatchObject({ state: 'running' });
    runtime.stop();
  });

  it('defers the idle end of a held session while a terminal is attached, then ends it at a later read', async () => {
    let clients = 1;
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients, lastInputAt: null }) });
    const { runtime, store, logs } = await twoSessions(codeMode);

    codeMode.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })), idle: ['s2'] });
    await runtime.readRoster();
    await runtime.settled();

    expect(store.session('s2')).toMatchObject({ state: 'idle', releasing: true, released: false });
    expect(codeMode.stops).toEqual([]);
    expect(logs).toContain('end of held session s2 deferred: 1 terminal is attached');

    clients = 0;
    await runtime.readRoster();
    await runtime.settled();

    expect(codeMode.stops).toEqual(['s2']);
    expect(store.session('s2')).toMatchObject({ state: 'ended', released: true, releasing: false });
    runtime.stop();
  });

  it('drops a deferred end once a new turn cancels it', async () => {
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients: 1, lastInputAt: null }) });
    const { runtime, store, logs } = await twoSessions(codeMode);

    codeMode.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })), idle: ['s2'] });
    await runtime.readRoster();
    await runtime.settled();
    codeMode.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) });
    await runtime.readRoster();
    await runtime.settled();

    await runtime.readRoster();
    await runtime.settled();

    expect(store.session('s2')).toMatchObject({ state: 'running', releasing: false, released: false });
    expect(codeMode.stops).toEqual([]);
    expect(logs.filter((line) => line.startsWith('end of held session s2'))).toEqual(['end of held session s2 deferred: 1 terminal is attached']);
    runtime.stop();
  });

  it('ends the held sessions when a holder lookup finds none, as before a start replaces it, but not a starting one', async () => {
    const { runtime, store, logs } = await twoSessions(fakeRunner());

    store.updateSession('s1', { codeMode: true, state: 'starting' });
    expect(await runtime['holder'].find(false)).toEqual({ gone: true });

    expect(store.session('s2')).toMatchObject({ state: 'ended', outcome: 'failed', outcomeDetail: 'The terminal holder stopped.' });
    expect(store.session('s1')).toMatchObject({ state: 'starting' });
    expect(logs).toContain('session s2 ended: the terminal holder stopped');
    runtime.stop();
  });

  it('defers an end while input after the turn may be a prompt not yet observed, and ends it once that input is old', async () => {
    let now = T0;
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients: 0, lastInputAt: T0 + 1_000 }) });
    const claude = fakeRunner();
    const context = setup(config(), () => now, { claude, codeMode });

    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();
    context.store.updateSession('s1', { codeMode: true, launchId: 'launch-1', state: 'idle', stateAt: T0, releasing: true });
    claude.observe = codeMode.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) });
    now = T0 + 2_000;
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);
    expect(context.logs).toContain('end of held session s1 deferred: input arrived after its turn');

    now = T0 + 1_000 + INPUT_SETTLE_MS;
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual(['s1']);
    context.runtime.stop();
  });

  it('measures input against the turn end its marker records, not when the hub applied it, and skips an end the marker shows a new turn for', async () => {
    let now = T0 + 3_000;
    let marker = { at: T0, observed: { state: 'idle' as const, detail: null }, recheck: false };
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients: 0, lastInputAt: T0 + 1_000 }), markers: () => new Map([['s1-native', marker]]) as never });
    const claude = fakeRunner();
    const context = setup(config(), () => now, { claude, codeMode });

    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();
    context.store.updateSession('s1', { codeMode: true, launchId: 'launch-1', state: 'idle', stateAt: T0 + 2_000, releasing: true });
    codeMode.observe = async () => ({ error: 'not read in this test' });
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);
    expect(context.logs).toContain('end of held session s1 deferred: input arrived after its turn');

    marker = { at: T0 + 1_500, observed: { state: 'running', detail: null } as never, recheck: false };
    now = T0 + 1_000 + INPUT_SETTLE_MS;
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);
    expect(context.logs).toContain('end of held session s1 skipped: its last marker is not a turn end');
    context.runtime.stop();
  });

  it('ends a session whose last marker is a manual compaction once its input and output are older than the settle time', async () => {
    let now = T0 + 3_000;
    const marker = { at: T0 + 2_000, observed: null, recheck: false, compacted: true as const };
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients: 0, lastInputAt: T0 + 1_000, lastOutputAt: T0 + 2_500 }), markers: () => new Map([['s1-native', marker]]) as never });
    const claude = fakeRunner();
    const context = setup(config(), () => now, { claude, codeMode });

    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();
    context.store.updateSession('s1', { codeMode: true, launchId: 'launch-1', state: 'idle', stateAt: T0, releasing: true });
    codeMode.observe = async () => ({ error: 'not read in this test' });
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);

    now = T0 + 2_500 + INPUT_SETTLE_MS;
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual(['s1']);
    context.runtime.stop();
  });

  it('skips an end when a marker with no state, such as a PreToolUse that replaced the prompt marker, is newer than the input', async () => {
    const now = T0 + 3_000;
    const marker = { at: T0 + 2_000, observed: null, recheck: true };
    const codeMode = fakeRunner({ heldActivity: async () => ({ clients: 0, lastInputAt: T0 + 1_000 }), markers: () => new Map([['s1-native', marker]]) as never });
    const claude = fakeRunner();
    const context = setup(config(), () => now, { claude, codeMode });

    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();
    context.store.updateSession('s1', { codeMode: true, launchId: 'launch-1', state: 'idle', stateAt: T0, releasing: true });
    codeMode.observe = async () => ({ error: 'not read in this test' });
    await context.runtime.readRoster();
    await context.runtime.settled();

    expect(codeMode.stops).toEqual([]);
    expect(context.logs).toContain('end of held session s1 skipped: its last marker is not a turn end');
    context.runtime.stop();
  });

  it('ends a held session a stopped hub left waiting to end, once, at the next roster read', async () => {
    let answer = () => {};
    const codeMode = fakeRunner({ heldActivity: () => new Promise((done) => (answer = () => done({ clients: 0, lastInputAt: null }))) });
    const { runtime, store } = await twoSessions(codeMode);

    codeMode.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) });
    store.updateSession('s2', { state: 'idle', releasing: true });
    const first = runtime.readRoster();

    await first;
    await runtime.readRoster();
    answer();
    await runtime.settled();

    expect(codeMode.stops).toEqual(['s2']);
    expect(store.session('s2')).toMatchObject({ state: 'ended', released: true });
    runtime.stop();
  });

  it('ends a Code Mode session that finishes starting after Delete removed its work item', async () => {
    let started = () => {};
    const codeMode = fakeRunner();
    const { runtime, store, logs } = setup(config(), () => T0, { claude: fakeRunner(), codeMode });

    codeMode.start = (action) => new Promise((done) => (started = () => done({ shortId: 'short', nativeSessionId: 'native', launchId: 'launch' })));
    runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: false });
    store.insertSession({ id: 's9', workItemId: 1, kind: 'task', provider: 'claude', cwd: 'D:/git/widgets', state: 'starting', stateAt: T0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: T0, endedAt: null, released: false, releasing: false, question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null, nativeSessionId: null, shortId: null, codeMode: true, launchId: null });

    const start = runtime['run']({ type: 'start-session', sessionId: 's9', workItemId: 1, kind: 'task', provider: 'claude', cwd: 'D:/git/widgets', prompt: 'p', contract: 'c', name: 'n', permissionMode: 'auto', model: null, codeMode: true });

    expect(runtime.send({ type: 'delete', workItemId: 1 }).refused).toBeNull();
    await runtime.settled();
    started();
    await start;

    expect(store.session('s9')).toBeNull();
    expect(codeMode.stops).toEqual(['s9', 's9']);
    expect(logs).toContain('session s9 started after its work item was deleted; ended it');
    runtime.stop();
  });

  it('refuses to register the new ID of a held session after /clear', async () => {
    const codeMode = fakeRunner({ heldBy: (nativeSessionId, sessions) => (nativeSessionId === 'cleared-uuid' ? (sessions.find((session) => session.id === 's2') ?? null) : null) });
    const { runtime, store } = await twoSessions(codeMode);
    const key = (() => {
      const ticket = store.ticket(store.workItem(store.session('s2')!.workItemId)!.ticketId)!;

      return `${ticket.source} ${ticket.sourceKey}`;
    })();

    expect(await runtime.register('cleared-uuid', 'Mine')).toEqual({ refused: `This session runs in the terminal holder for ${key}, which Switchboard follows there.` });
    runtime.stop();
  });

  it('refuses a report from another Claude session ID than the held session\'s', async () => {
    const { runtime, store } = await twoSessions(fakeRunner());

    expect(await runtime.report({ sessionId: 's2', kind: 'stage', stage: 'testing' } as never, 'other-native-uuid')).toEqual({ refused: 'Session other-na is not the session Switchboard started, so the report was not recorded.' });
    expect(await runtime.report({ sessionId: 's2', kind: 'stage', stage: 'testing' } as never, 's2-native')).toEqual({ refused: null });
    expect(store.workItem(store.session('s2')!.workItemId)?.stage).toBe('testing');
    runtime.stop();
  });

  describe('attach (PRD R95)', () => {
    const HOLDER = { port: 4100, token: 'holder-token', session: 's1' };

    function held(session: string, exited = false): SessionEntry {
      return { session, label: 'l', pid: 900, cwd: 'D:/git/widgets', startedAt: T0, lastInputAt: null, lastOutputAt: null, exitedAt: exited ? T0 : null, exitCode: exited ? 0 : null, clients: 0, memoryBytes: null };
    }

    /** A held Code Mode session s1 and a holder whose list the test sets; `now` is settable. */
    async function attaching(codeMode: SessionRunner, cfg = config({ installHooks: true })) {
      const clock = { now: T0 };
      const entries: SessionEntry[] = [held('s1')];
      const connection: HolderConnection = {
        welcome: { protocol: 1, build: 'b', pid: 4243 },
        compatible: true,
        spawn: async () => ({ session: 's', pid: 1 }),
        list: async () => entries,
        kill: async () => 0,
        screen: async () => ({ head: '', text: '' }),
        shutdown: async () => {},
        onClose: () => {},
        close: () => {},
      };

      mkdirSync(join(home, '.switchboard'), { recursive: true });
      writeFileSync(recordPath(join(home, '.switchboard')), JSON.stringify({ protocol: 1, build: 'b', port: 4100, token: 'holder-token', pid: 4243, startedAt: '2026-11-18T00:00:00.000Z' }));

      const context = setup(cfg, () => clock.now, { claude: fakeRunner(), codeMode }, new FakeCodex(), {}, { holder: { connect: async () => connection, lockHeld: async () => true } });

      context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
      await context.runtime.settled();
      context.store.updateSession('s1', { codeMode: true, launchId: 'launch-1' });

      return { ...context, clock, entries };
    }

    /** The session's process has exited and the flow has ended it. */
    function endIt(context: { store: Store; entries: SessionEntry[] }): void {
      context.entries.splice(0, context.entries.length, held('s1', true));
      context.store.updateSession('s1', { state: 'ended', endedAt: T0, released: true });
    }

    const idleObservation: SessionRunner['observe'] = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) });

    function resumer(overrides: Partial<SessionRunner> = {}): SessionRunner & { stops: string[]; starts: string[]; resumes: Array<{ id: string; permissionMode: string; model: string | null; label: string }> } {
      const resumes: Array<{ id: string; permissionMode: string; model: string | null; label: string }> = [];

      return {
        ...fakeRunner({
          resumeHeld: async (session, permissionMode, model, label) => {
            resumes.push({ id: session.id, permissionMode, model, label });
            return { launchId: `launch-${resumes.length + 1}` };
          },
          leftovers: async () => [],
          ...overrides,
        }),
        resumes,
      };
    }

    it('answers the holder of a live session at once, without resuming it', async () => {
      const codeMode = resumer();
      const { runtime } = await attaching(codeMode);

      expect(await runtime.attach('s1')).toEqual(HOLDER);
      expect(codeMode.resumes).toEqual([]);
      runtime.stop();
    });

    it('refuses an unknown session with 404 and a background session with 409', async () => {
      const { runtime, store } = await attaching(resumer());

      expect(await runtime.attach('nope')).toEqual({ refused: 'No session nope.', status: 404 });
      store.updateSession('s1', { codeMode: false });
      expect(await runtime.attach('s1')).toEqual({ refused: 'Session s1-short is not a Code Mode session; open it in Claude.', status: 409 });
      runtime.stop();
    });

    it('refuses with the holder lookup failure', async () => {
      const { runtime, store } = setup(config({ installHooks: true }), () => T0, { claude: fakeRunner(), codeMode: resumer() }, new FakeCodex(), {}, { holder: { connect: async () => Promise.reject(new Error('refused')), lockHeld: async () => true } });

      runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
      await runtime.settled();
      store.updateSession('s1', { codeMode: true, launchId: 'launch-1' });
      mkdirSync(join(home, '.switchboard'), { recursive: true });
      writeFileSync(recordPath(join(home, '.switchboard')), JSON.stringify({ protocol: 1, build: 'b', port: 4100, token: 'holder-token', pid: 4243, startedAt: '2026-11-18T00:00:00.000Z' }));

      expect(await runtime.attach('s1')).toEqual({ refused: 'The terminal holder holds its lock but does not answer.', status: 409 });
      runtime.stop();
    });

    it("resumes an ended session with its work item's mode and model and a label as its start had, then answers the holder", async () => {
      const codeMode = resumer();
      const context = await attaching(codeMode, config({ installHooks: true, permissionMode: 'auto', model: 'haiku' }));

      endIt(context);
      expect(await context.runtime.attach('s1')).toEqual(HOLDER);
      expect(codeMode.resumes).toEqual([{ id: 's1', permissionMode: 'auto', model: 'haiku', label: 'switchboard · ad-hoc · adhoc 1 s1-native' }]);
      expect(context.store.session('s1')).toMatchObject({ state: 'idle', released: false, launchId: 'launch-2' });
      expect(context.logs).toContain('session s1 resumed in the terminal holder');
      context.runtime.stop();
    });

    it('ends a session the holder no longer lists with a roster read before resuming it, and refuses one still listed by the roster', async () => {
      const codeMode = resumer({ observe: async () => ({ sessions: [] }) });
      const context = await attaching(codeMode);

      context.entries.splice(0, 1);
      expect(await context.runtime.attach('s1')).toEqual(HOLDER);
      expect(codeMode.resumes.map((resume) => resume.id)).toEqual(['s1']);

      const still = resumer();
      const other = await attaching(still);

      other.entries.splice(0, 1);
      expect(await other.runtime.attach('s1')).toEqual({ refused: 'Session s1-short is still ending; try again.', status: 409 });
      expect(still.resumes).toEqual([]);
      context.runtime.stop();
      other.runtime.stop();
    });

    it("passes an ended session's last tree to the runner for Stop, and clears it once the processes have ended", async () => {
      const targets: unknown[] = [];
      const codeMode = resumer({
        stop: async (target) => {
          targets.push(target);
          return null;
        },
      });
      const context = await attaching(codeMode);
      const tree = [{ pid: 100, created: '1' }];

      endIt(context);
      context.store.updateSession('s1', { lastTree: tree });
      expect(context.runtime.send({ type: 'stop', workItemId: 1 }).refused).toBeNull();
      await context.runtime.settled();

      expect(targets).toEqual([{ type: 'stop-session', sessionId: 's1', provider: 'claude', shortId: 's1-short', reason: 'operator', codeMode: true, lastTree: tree }]);
      expect(context.store.session('s1')!.lastTree).toBeNull();
      context.runtime.stop();
    });

    it('ends a resumed process and refuses the attach when Delete removed the session during the spawn', async () => {
      const spawning = deferred();
      const spawned = deferred();
      const codeMode = resumer();
      const context = await attaching(codeMode);
      const resumeHeld = codeMode.resumeHeld!;

      codeMode.resumeHeld = async (...args) => {
        spawning.resolve();
        await spawned.promise;
        return resumeHeld(...args);
      };
      endIt(context);

      const attach = context.runtime.attach('s1');

      await spawning.promise;
      expect(context.runtime.send({ type: 'delete', workItemId: 1 }).refused).toBeNull();
      await context.runtime.settled();
      expect(codeMode.stops).toEqual([]);
      spawned.resolve();

      expect(await attach).toEqual({ refused: 'No session s1.', status: 404 });
      expect(codeMode.stops).toEqual(['s1']);
      expect(context.logs).toContain('session s1 changed while it resumed; ended the resumed process');
      context.runtime.stop();
    });

    it('does not end a session resumed while a roster read that left it out was running', async () => {
      const listed = deferred();
      const release = deferred();
      const codeMode = resumer();
      const context = await attaching(codeMode);

      endIt(context);
      context.runtime.send({ type: 'adhoc', prompt: 'other', repoRoot: 'D:/git/widgets', start: true });
      await context.runtime.settled();
      context.store.updateSession('s2', { codeMode: true, launchId: 'launch-s2' });
      context.entries.push(held('s2'));
      codeMode.observe = async (sessions) => {
        const live = sessions.filter((session) => context.entries.some((entry) => entry.session === session.id && entry.exitedAt === null));

        listed.resolve();
        await release.promise;
        return { sessions: live.map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) };
      };

      const read = context.runtime.readRoster();

      await listed.promise;
      expect(await context.runtime.attach('s1')).toEqual(HOLDER);
      release.resolve();
      await read;

      expect(context.store.session('s1')).toMatchObject({ state: 'idle', launchId: 'launch-2', released: false });
      context.runtime.stop();
    });

    it('waits for an operator Stop to reach the flow before resuming the stopped session', async () => {
      const killed = deferred();
      const reported = deferred();
      const codeMode = resumer({ observe: idleObservation });
      const context = await attaching(codeMode);
      let discoveries = 0;

      codeMode.stop = async () => {
        context.entries.splice(0, 1, held('s1', true));
        return null;
      };
      context.runtime['findSetupWorktrees'] = async () => {
        if (discoveries++ === 0) {
          killed.resolve();
          await reported.promise;
        }
      };
      expect(context.runtime.send({ type: 'stop', workItemId: 1 }).refused).toBeNull();
      await killed.promise;

      const attach = context.runtime.attach('s1');

      await new Promise((done) => setImmediate(done));
      expect(codeMode.resumes).toEqual([]);
      reported.resolve();

      expect(await attach).toEqual(HOLDER);
      await context.runtime.settled();
      expect(codeMode.resumes.map((resume) => resume.id)).toEqual(['s1']);
      expect(context.store.session('s1')).toMatchObject({ state: 'idle', launchId: 'launch-2', released: false });
      context.runtime.stop();
    });

    it('waits for a Stop that starts while the attach looks up the holder, then resumes the stopped session', async () => {
      const looking = deferred();
      const found = deferred();
      const killed = deferred();
      const reported = deferred();
      const codeMode = resumer({ observe: idleObservation });
      const context = await attaching(codeMode);
      const holder = context.runtime['holder'];
      const find = holder.find.bind(holder);
      let discoveries = 0;

      holder.find = async (start) => {
        const result = await find(start);

        looking.resolve();
        await found.promise;
        return result;
      };
      codeMode.stop = async () => {
        context.entries.splice(0, 1, held('s1', true));
        return null;
      };
      context.runtime['findSetupWorktrees'] = async () => {
        if (discoveries++ === 0) {
          killed.resolve();
          await reported.promise;
        }
      };

      const attach = context.runtime.attach('s1');

      await looking.promise;
      expect(context.runtime.send({ type: 'stop', workItemId: 1 }).refused).toBeNull();
      await killed.promise;
      found.resolve();
      await new Promise((done) => setImmediate(done));
      expect(codeMode.resumes).toEqual([]);
      reported.resolve();

      expect(await attach).toEqual(HOLDER);
      await context.runtime.settled();
      expect(codeMode.resumes.map((resume) => resume.id)).toEqual(['s1']);
      expect(context.store.session('s1')).toMatchObject({ state: 'idle', launchId: 'launch-2', released: false });
      context.runtime.stop();
    });

    it('leaves a session being resumed out of a roster read that lists its new process', async () => {
      const codeMode = resumer();
      const context = await attaching(codeMode);
      const resumeHeld = codeMode.resumeHeld!;

      endIt(context);
      context.runtime.send({ type: 'adhoc', prompt: 'other', repoRoot: 'D:/git/widgets', start: true });
      await context.runtime.settled();
      context.store.updateSession('s2', { codeMode: true, launchId: 'launch-s2' });
      context.entries.push(held('s2'));
      codeMode.observe = async (sessions) => ({
        sessions: sessions.filter((session) => context.entries.some((entry) => entry.session === session.id && entry.exitedAt === null)).map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })),
      });
      codeMode.resumeHeld = async (...args) => {
        context.entries.splice(0, 1, held('s1'));
        await context.runtime.readRoster();
        return resumeHeld(...args);
      };

      expect(await context.runtime.attach('s1')).toEqual(HOLDER);
      expect(codeMode.stops).toEqual([]);
      expect(context.store.session('s1')).toMatchObject({ state: 'idle', launchId: 'launch-2', released: false });
      context.runtime.stop();
    });

    it('stores the launch before the spawn, so a hub restarted during it holds the live process under that launch', async () => {
      const spawned = deferred();
      const never = deferred();
      const codeMode = resumer();
      const context = await attaching(codeMode);
      const launches: Array<string | undefined> = [];

      codeMode.newLaunchId = () => 'launch-stored';
      codeMode.resumeHeld = async (session, _mode, _model, _label, launchId) => {
        launches.push(launchId);
        context.entries.splice(0, 1, held('s1'));
        spawned.resolve();
        await never.promise;
        return { launchId: launchId! };
      };
      endIt(context);
      void context.runtime.attach('s1');
      await spawned.promise;
      expect(context.store.session('s1')).toMatchObject({ state: 'ended', launchId: 'launch-stored' });
      context.runtime.stop();

      const restarted = new Runtime(context.runtime['deps'], context.runtime['config']);

      try {
        expect(await restarted.attach('s1')).toEqual(HOLDER);
        expect(launches).toEqual(['launch-stored']);
        expect(context.store.session('s1')).toMatchObject({ state: 'idle', released: false, launchId: 'launch-stored' });
        expect(context.logs).toContain('session s1 is live in the terminal holder under launch launch-stored; holding it again');
      } finally {
        restarted.stop();
      }
    });

    it('holds again an ended session that a roster read finds live under its stored launch', async () => {
      const codeMode = resumer({ observe: async (sessions) => ({ sessions: sessions.filter((session) => context.entries.some((entry) => entry.session === session.id && entry.exitedAt === null)).map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) }) });
      const context = await attaching(codeMode);

      endIt(context);
      context.store.updateSession('s1', { launchId: 'launch-stored' });
      context.runtime.send({ type: 'adhoc', prompt: 'other', repoRoot: 'D:/git/widgets', start: true });
      await context.runtime.settled();
      context.store.updateSession('s2', { codeMode: true, launchId: 'launch-s2' });
      context.entries.splice(0, 1, held('s1'), held('s2'));
      await context.runtime.readRoster();

      expect(context.store.session('s1')).toMatchObject({ state: 'idle', released: false, launchId: 'launch-stored' });
      context.runtime.stop();
    });

    it('ignores a roster result for a session that Stop ended while the read ran', async () => {
      const listed = deferred();
      const release = deferred();
      const codeMode = resumer();
      const context = await attaching(codeMode);

      codeMode.observe = async (sessions) => {
        listed.resolve();
        await release.promise;
        return { sessions: sessions.map((session) => ({ sessionId: session.id, state: 'running' as const, detail: null })) };
      };

      const read = context.runtime.readRoster();

      await listed.promise;
      expect(context.runtime.send({ type: 'stop', workItemId: 1 }).refused).toBeNull();
      await context.runtime.settled();
      expect(context.store.workItem(1)).toMatchObject({ status: 'blocked', error: 'Stopped by you.' });
      release.resolve();
      await read;

      expect(context.store.session('s1')).toMatchObject({ state: 'ended', released: true });
      expect(context.store.workItem(1)).toMatchObject({ status: 'blocked', error: 'Stopped by you.' });
      expect(context.logs.some((line) => line.includes('holding it again'))).toBe(false);
      context.runtime.stop();
    });

    it('refuses a resume with hooks off', async () => {
      const codeMode = resumer();
      const context = await attaching(codeMode, config({ installHooks: false }));

      endIt(context);
      expect(await context.runtime.attach('s1')).toEqual({ refused: 'Code Mode sessions need sessions.installHooks.', status: 409 });
      expect(codeMode.resumes).toEqual([]);
      context.runtime.stop();
    });

    it('refuses a resume while processes of the last run still run, or when they cannot be checked', async () => {
      let left: Awaited<ReturnType<NonNullable<SessionRunner['leftovers']>>> = [{ pid: 100, created: '1' }, { pid: 101, created: '2' }];
      const trees: unknown[] = [];
      const codeMode = resumer({
        leftovers: async (tree) => {
          trees.push(tree);
          return left;
        },
      });
      const context = await attaching(codeMode);

      endIt(context);
      context.store.updateSession('s1', { lastTree: [{ pid: 100, created: '1' }, { pid: 101, created: '2' }, { pid: 102, created: '3' }] });
      expect(await context.runtime.attach('s1')).toEqual({ refused: 'Session s1-short still has 2 processes from its previous run (pids 100, 101). Stop them or wait for them to end.', status: 409 });
      expect(trees).toEqual([[{ pid: 100, created: '1' }, { pid: 101, created: '2' }, { pid: 102, created: '3' }]]);

      left = [{ pid: 100, created: '1' }];
      expect(await context.runtime.attach('s1')).toMatchObject({ refused: 'Session s1-short still has 1 process from its previous run (pid 100). Stop them or wait for them to end.' });

      left = { error: 'The process table could not be read: Access is denied.' };
      expect(await context.runtime.attach('s1')).toEqual({ refused: 'The process table could not be read: Access is denied.', status: 409 });

      left = [];
      expect(await context.runtime.attach('s1')).toEqual(HOLDER);
      expect(codeMode.resumes).toHaveLength(1);
      context.runtime.stop();
    });

    it('offers Stop on the row while the guard refuses, until a leftover stop or a resume succeeds (PRD R95)', async () => {
      let left: Awaited<ReturnType<NonNullable<SessionRunner['leftovers']>>> = [{ pid: 100, created: '1' }];
      const codeMode = resumer({ leftovers: async () => left });
      const context = await attaching(codeMode);
      const shown = () => context.runtime.snapshot().workItems[0]!;
      const tree = [{ pid: 100, created: '1' }];

      endIt(context);
      context.store.updateSession('s1', { lastTree: tree });
      expect(shown().leftovers).toBeUndefined();
      expect(controlsOf(shown()).map((control) => control.label)).not.toContain('Stop');

      await context.runtime.attach('s1');
      expect(shown().leftovers).toEqual([100]);
      expect(controlsOf(shown()).find((control) => control.label === 'Stop')?.message).toEqual({ type: 'action', action: { type: 'stop', workItemId: 1 } });

      expect(context.runtime.send({ type: 'stop', workItemId: 1 }).refused).toBeNull();
      await context.runtime.settled();
      expect(context.store.session('s1')?.lastTree ?? null).toBeNull();
      expect(shown().leftovers).toBeUndefined();

      context.store.updateSession('s1', { lastTree: tree });
      await context.runtime.attach('s1');
      expect(shown().leftovers).toEqual([100]);
      left = [];
      expect(await context.runtime.attach('s1')).toEqual(HOLDER);
      expect(shown().leftovers).toBeUndefined();
      context.runtime.stop();
    });

    it('refuses with the reason a resume fails, and leaves the session ended', async () => {
      const codeMode = resumer({ resumeHeld: async () => ({ error: 'The terminal holder did not start.' }) });
      const context = await attaching(codeMode);

      endIt(context);
      expect(await context.runtime.attach('s1')).toEqual({ refused: 'The terminal holder did not start.', status: 409 });
      expect(context.store.session('s1')).toMatchObject({ state: 'ended' });
      context.runtime.stop();
    });

    it('resumes once for attaches made together', async () => {
      const gate = deferred();
      const codeMode = resumer();
      const context = await attaching(codeMode);
      const resumeHeld = codeMode.resumeHeld!;

      codeMode.resumeHeld = async (...args) => {
        await gate.promise;
        return resumeHeld(...args);
      };
      endIt(context);

      const attaches = [context.runtime.attach('s1'), context.runtime.attach('s1')];

      gate.resolve();

      expect(await Promise.all(attaches)).toEqual([HOLDER, HOLDER]);
      expect(codeMode.resumes).toHaveLength(1);
      context.runtime.stop();
    });

    it('defers an end that reads the terminals while an attach arrives, until the reservation expires', async () => {
      let answer = (): void => {};
      const codeMode = resumer({ heldActivity: () => new Promise((done) => (answer = () => done({ clients: 0, lastInputAt: null }))), observe: idleObservation });
      const context = await attaching(codeMode);

      context.store.updateSession('s1', { state: 'idle', releasing: true });
      await context.runtime.readRoster();

      const attach = context.runtime.attach('s1');

      answer();
      expect(await attach).toEqual(HOLDER);
      await context.runtime.settled();

      expect(codeMode.stops).toEqual([]);
      expect(context.logs).toContain('end of held session s1 deferred: a terminal is attaching');

      context.clock.now = T0 + ATTACH_RESERVATION_MS;
      codeMode.heldActivity = async () => ({ clients: 0, lastInputAt: null });
      await context.runtime.readRoster();
      await context.runtime.settled();

      expect(codeMode.stops).toEqual(['s1']);
      context.runtime.stop();
    });

    it('waits for an end in progress, then resumes the ended session', async () => {
      let ended = (): void => {};
      const order: string[] = [];
      const codeMode = resumer({ heldActivity: async () => ({ clients: 0, lastInputAt: null }), observe: idleObservation });
      const context = await attaching(codeMode);
      const resumeHeld = codeMode.resumeHeld!;

      codeMode.stop = (target) =>
        new Promise((done) => {
          ended = () => {
            order.push(`stop ${target.sessionId}`);
            context.entries.splice(0, 1, held('s1', true));
            done(null);
          };
        });
      codeMode.resumeHeld = async (...args) => {
        order.push(`resume ${args[0].id}`);
        return resumeHeld(...args);
      };
      context.store.updateSession('s1', { state: 'idle', releasing: true });
      await context.runtime.readRoster();

      const attach = context.runtime.attach('s1');

      await vi.waitFor(() => expect(order).toEqual([]));
      ended();

      expect(await attach).toEqual(HOLDER);
      expect(order).toEqual(['stop s1', 'resume s1']);
      expect(context.store.session('s1')).toMatchObject({ state: 'idle', launchId: 'launch-2' });
      context.runtime.stop();
    });

    it('defers an end while a message is typed, and refuses a reservation for another launch or an ended session', async () => {
      const codeMode = resumer({ heldActivity: async () => ({ clients: 0, lastInputAt: null }), observe: idleObservation });
      const context = await attaching(codeMode);

      expect(await context.runtime.reserveInput('s1', 'launch-0')).toEqual({ refused: SESSION_RELAUNCHED });

      const reservation = await context.runtime.reserveInput('s1', 'launch-1');

      if (!('release' in reservation)) {
        throw new Error('expected a reservation');
      }

      context.store.updateSession('s1', { state: 'idle', releasing: true });
      await context.runtime.readRoster();
      await context.runtime.settled();

      expect(codeMode.stops).toEqual([]);
      expect(context.logs).toContain('end of held session s1 deferred: a message is being typed');

      // A second release changes nothing.
      reservation.release();
      reservation.release();
      await context.runtime.readRoster();
      await context.runtime.settled();

      expect(codeMode.stops).toEqual(['s1']);
      endIt(context);
      expect(await context.runtime.reserveInput('s1', 'launch-1')).toEqual({ refused: SESSION_ENDED });
      context.runtime.stop();
    });

    it('waits for an end in progress before it reserves, and then refuses the ended session', async () => {
      let ended = (): void => {};
      const order: string[] = [];
      const codeMode = resumer({ heldActivity: async () => ({ clients: 0, lastInputAt: null }), observe: idleObservation });
      const context = await attaching(codeMode);

      codeMode.stop = (target) =>
        new Promise((done) => {
          ended = () => {
            order.push(`stop ${target.sessionId}`);
            context.entries.splice(0, 1, held('s1', true));
            done(null);
          };
        });
      context.store.updateSession('s1', { state: 'idle', releasing: true });
      await context.runtime.readRoster();

      const reserving = context.runtime.reserveInput('s1', 'launch-1').then((result) => {
        order.push('reserved');
        return result;
      });

      await vi.waitFor(() => expect(order).toEqual([]));
      ended();

      expect(await reserving).toEqual({ refused: SESSION_ENDED });
      expect(order).toEqual(['stop s1', 'reserved']);
      context.runtime.stop();
    });

    it('types through the connected holder only when it serves write', async () => {
      const context = await attaching(resumer());

      expect(context.runtime.heldCannotType()).toBeNull();
      await context.runtime.readRoster();

      const cannotType = context.runtime.heldCannotType();

      expect(cannotType).toMatch(/^The terminal holder is from an older build and cannot type\. To switch to this build, run \S+ "[^"]+\/\.switchboard\/hub\.js" holder stop --all in a terminal: .* again with --yes\. Until then, open the session in the terminal\.$/);
      expect(context.runtime.heldHolder()).toMatchObject({ protocol: 1 });
      await expect(context.runtime.writeHeld('s1', 'x')).rejects.toThrow(new NotWritten(cannotType!));
      context.runtime.stop();
    });

    it("shows a held session in the page's console and resizes it only through a holder that serves view", async () => {
      const context = await attaching(resumer());

      await context.runtime.readRoster();

      const handlers = { onSize: () => undefined, onData: () => undefined, onReplayed: () => undefined, onExit: () => undefined, onClose: () => undefined };

      await expect(context.runtime.viewHeld('s1', handlers)).rejects.toThrow(/^The terminal holder is from an older build and cannot show its sessions here\. To switch to this build, run .* holder stop --all/);
      await expect(context.runtime.sizeHeld('s1', 100, 30)).rejects.toBeInstanceOf(NotWritten);
      context.runtime.stop();
    });

    it("streams a held session to the page's console over its own view connection, and resizes and types with a key through the holder", async () => {
      const context = await attaching(resumer());
      const calls: string[] = [];
      const fake = createNetServer((socket) => {
        let buffer = '';

        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');

          for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
            const message = JSON.parse(buffer.slice(0, index)) as { type: string; token?: string; session?: string };

            buffer = buffer.slice(index + 1);
            calls.push(message.type === 'hello' ? `hello ${message.token}` : `${message.type} ${message.session}`);

            if (message.type === 'hello') {
              socket.write(JSON.stringify({ type: 'welcome', protocol: 1, build: 'b', pid: 4243, features: ['snapshot', 'write', 'view'] }) + '\n');
            } else if (message.type === 'view') {
              for (const line of [{ type: 'resized', cols: 80, rows: 24 }, { type: 'replay', data: 'screen' }, { type: 'replayed' }, { type: 'output', data: 'more' }, { type: 'exited', exitCode: 0 }]) {
                socket.write(JSON.stringify(line) + '\n');
              }

              socket.end();
            }
          }
        });
      });

      await new Promise<void>((done) => fake.listen(0, '127.0.0.1', done));
      writeFileSync(recordPath(join(home, '.switchboard')), JSON.stringify({ protocol: 1, build: 'b', port: (fake.address() as { port: number }).port, token: 'holder-token', pid: 4243, startedAt: '2026-11-18T00:00:00.000Z' }));
      context.runtime.stop();

      const connection: HolderConnection = {
        welcome: { protocol: 1, build: 'b', pid: 4243, features: ['snapshot', 'write', 'view'] },
        compatible: true,
        spawn: async () => ({ session: 's', pid: 1 }),
        list: async () => context.entries,
        kill: async () => 0,
        screen: async () => ({ head: '', text: '' }),
        write: async (session, data, key) => {
          calls.push(`write ${session} ${data} ${String(key)}`);
          return { rev: 1 };
        },
        size: async (session, cols, rows) => {
          calls.push(`size ${session} ${cols}x${rows}`);
          return { rev: 1 };
        },
        shutdown: async () => {},
        onClose: () => {},
        close: () => {},
      };
      const viewing = setup(config({ installHooks: true }), () => T0, { claude: fakeRunner(), codeMode: resumer() }, new FakeCodex(), {}, { holder: { connect: async () => connection, lockHeld: async () => true } });
      const seen: string[] = [];
      const closed = new Promise<string | null>((done) => {
        void viewing.runtime.viewHeld('s1', {
          onSize: (cols, rows) => seen.push(`size ${cols}x${rows}`),
          onData: (data) => seen.push(data),
          onReplayed: () => seen.push('replayed'),
          onExit: (exitCode) => seen.push(`exited ${String(exitCode)}`),
          onClose: done,
        });
      });

      expect(await closed).toBeNull();
      expect(seen).toEqual(['size 80x24', 'screen', 'replayed', 'more', 'exited 0']);
      await viewing.runtime.sizeHeld('s1', 100, 30);
      await viewing.runtime.writeHeld('s1', 'k', true);
      expect(calls).toEqual(['hello holder-token', 'view s1', 'size s1 100x30', 'write s1 k true']);
      viewing.runtime.stop();
      await new Promise((done) => fake.close(done));
    });
    describe('held sessions (PRD R94)', () => {
      const CLAUDE = '9273f594-1111-4222-8333-444455556666';
      const label = (key: string, native: string) => `switchboard · ad-hoc · ${key} ${native}`;

      it('lists the holder\'s sessions joined with the store, orphans first, and logs each orphan once', async () => {
        const context = await attaching(resumer());

        context.store.updateSession('s1', { nativeSessionId: CLAUDE });
        context.entries.splice(0, 1, { ...held('s1'), label: label('adhoc 1', 'old-native'), lastInputAt: T0 + 5, lastOutputAt: T0 + 9, clients: 2, memoryBytes: 300 * 1024 * 1024 }, { ...held('gone-1'), label: label('gh 7', 'aaaabbbb-0000') });
        await context.runtime.readRoster();
        await context.runtime.readRoster();

        expect(context.runtime.snapshot().held).toEqual([
          { session: 'gone-1', label: label('gh 7', 'aaaabbbb-0000'), workItemId: null, key: 'gh 7', nativeSessionId: 'aaaabbbb-0000', cwd: 'D:/git/widgets', state: 'live', idleSince: T0, memoryBytes: null, clients: 0, exitedAt: null, exitCode: null, orphan: true },
          { session: 's1', label: label('adhoc 1', 'old-native'), workItemId: 1, key: 'adhoc 1', nativeSessionId: CLAUDE, cwd: 'D:/git/widgets', state: 'running', idleSince: T0 + 9, memoryBytes: 300 * 1024 * 1024, clients: 2, exitedAt: null, exitCode: null, orphan: false },
        ]);
        expect(context.logs.filter((line) => line.startsWith('held session'))).toEqual([`held session gone-1 has no work item: ${label('gh 7', 'aaaabbbb-0000')}`]);
        context.runtime.stop();
      });

      it('counts an ended session still live as an orphan, but not an older session whose end waits, nor an exited one', async () => {
        const context = await attaching(resumer());

        context.runtime.send({ type: 'adhoc', prompt: 'other', repoRoot: 'D:/git/widgets', start: true });
        await context.runtime.settled();
        context.store.updateSession('s2', { codeMode: true, state: 'ended', endedAt: T0, released: true });
        context.store.updateSession('s1', { state: 'idle', releasing: true });
        context.entries.splice(0, 1, held('s1'), held('s2'), held('s3', true));

        expect((await context.runtime.listHeld()).map((one) => [one.session, one.orphan, one.state])).toEqual([
          ['s2', true, 'live'],
          ['s1', false, 'idle'],
          ['s3', false, 'exited'],
        ]);
        context.runtime.stop();
      });

      it('reads the list with no active Code Mode session, keeps it when a read fails, and empties it once the holder is gone', async () => {
        const context = await attaching(resumer());
        const connection = await context.runtime['holder'].find(false);
        let closed = (): void => {};
        let fail: string | null = null;

        if (!('holder' in connection)) {
          throw new Error('no holder');
        }

        connection.holder.onClose = (listener) => (closed = listener);
        connection.holder.list = async () => (fail === null ? context.entries : Promise.reject(new Error(fail)));
        context.runtime.send({ type: 'delete', workItemId: 1 });
        await context.runtime.settled();
        context.runtime['holder'].close();
        context.entries.splice(0, 1, held('s9'));

        await context.runtime.readRoster();
        expect(context.runtime.snapshot().held?.map((one) => one.session)).toEqual(['s9']);

        fail = 'The terminal holder did not answer.';
        await context.runtime.readRoster();
        await context.runtime.readRoster();
        expect(context.runtime.snapshot().held?.map((one) => one.session)).toEqual(['s9']);
        expect(context.logs.filter((line) => line.startsWith('held session list failed'))).toEqual(['held session list failed: The terminal holder did not answer.']);

        context.runtime['holder']['deps'].connect = async () => Promise.reject(new Error('refused'));
        context.runtime['holder']['deps'].lockHeld = async () => false;
        closed();
        await context.runtime.readRoster();
        expect(context.runtime.snapshot().held).toBeUndefined();
        context.runtime.stop();
      });

      it('never connects without a holder record', async () => {
        const connect = vi.fn(async () => Promise.reject(new Error('no holder')));
        const { runtime } = setup(config({ installHooks: true }), () => T0, { claude: fakeRunner(), codeMode: resumer() }, new FakeCodex(), {}, { holder: { connect, lockHeld: async () => false } });

        expect(await runtime.listHeld()).toEqual([]);
        await runtime.readRoster();
        expect(connect).not.toHaveBeenCalled();
        expect(runtime.snapshot().held).toBeUndefined();
        runtime.stop();
      });

      it('stops an active held session through the flow by its Switchboard ID, Claude ID, a retired ID or 8 characters of one', async () => {
        for (const id of ['s1', CLAUDE, 'retired-claude-id', CLAUDE.slice(0, 8)]) {
          const codeMode = resumer();
          const context = await attaching(codeMode);

          context.store.updateSession('s1', { nativeSessionId: CLAUDE, retiredIds: ['retired-claude-id'] });

          expect(await context.runtime.stopHeld(id)).toEqual({ stopped: 's1' });
          expect(codeMode.stops).toEqual(['s1']);
          expect(context.store.session('s1')).toMatchObject({ state: 'ended', outcome: 'stopped', outcomeDetail: 'Stopped by you.' });
          expect(context.store.workItem(1)).toMatchObject({ status: 'blocked', error: 'Stopped by you.' });
          context.runtime.stop();
        }
      });

      it('refuses an unknown ID, a prefix of several sessions, an exited session and a failed stop', async () => {
        const codeMode = resumer({ stop: async () => ({ error: 'The process did not exit.' }) });
        const context = await attaching(codeMode);

        context.store.updateSession('s1', { nativeSessionId: CLAUDE });
        context.entries.push({ ...held('o1'), label: label('gh 7', `${CLAUDE.slice(0, 8)}-other`) }, held('x1', true));

        expect(await context.runtime.stopHeld('nope')).toEqual({ refused: 'No held session nope.', status: 404 });
        expect(await context.runtime.stopHeld(CLAUDE.slice(0, 8))).toEqual({ refused: `${CLAUDE.slice(0, 8)} matches more than one held session: o1, s1.`, status: 409 });
        expect(await context.runtime.stopHeld('x1')).toEqual({ refused: 'Held session x1 has exited.', status: 409 });
        expect(await context.runtime.stopHeld('s1')).toEqual({ refused: 'Stop failed: The process did not exit.', status: 409 });
        expect(await context.runtime.stopHeld('o1')).toEqual({ refused: 'Stop failed: The process did not exit.', status: 409 });
        expect(context.store.session('s1')).toMatchObject({ state: 'running' });
        context.runtime.stop();
      });

      it('ends an orphan in the holder directly and logs it', async () => {
        const codeMode = resumer();
        const context = await attaching(codeMode);

        context.entries.push({ ...held('o1'), label: label('gh 7', 'n') });

        expect(await context.runtime.stopHeld('o1')).toEqual({ stopped: 'o1' });
        expect(codeMode.stops).toEqual(['o1']);
        expect(context.logs).toContain(`stopped orphaned held session o1: ${label('gh 7', 'n')}`);
        expect(context.store.session('s1')).toMatchObject({ state: 'running' });
        context.runtime.stop();
      });

      it('waits for a resume in progress, then stops the resumed session through the flow', async () => {
        let spawn = (): void => {};
        const codeMode = resumer();
        const context = await attaching(codeMode);
        const resumeHeld = codeMode.resumeHeld!;

        endIt(context);
        codeMode.resumeHeld = async (...args) => {
          context.entries.splice(0, 1, held('s1'));
          await new Promise<void>((done) => (spawn = done));
          return resumeHeld(...args);
        };
        codeMode.stop = async (target) => {
          codeMode.stops.push(target.sessionId);
          context.entries.splice(0, 1, held('s1', true));
          return null;
        };

        const attach = context.runtime.attach('s1');

        await vi.waitFor(() => expect(context.runtime['resuming'].has('s1')).toBe(true));

        const stop = context.runtime.stopHeld('s1');

        await new Promise((done) => setTimeout(done, 10));
        expect(codeMode.stops).toEqual([]);
        spawn();

        expect(await attach).toEqual(HOLDER);
        expect(await stop).toEqual({ stopped: 's1' });
        expect(codeMode.stops).toEqual(['s1']);
        expect(context.store.session('s1')).toMatchObject({ state: 'ended', outcome: 'stopped', outcomeDetail: 'Stopped by you.' });
        expect(context.logs.some((line) => line.startsWith('stopped orphaned held session'))).toBe(false);
        context.runtime.stop();
      });

      it('makes an attach wait for a held stop, which it then resumes', async () => {
        const order: string[] = [];
        let ended = (): void => {};
        const codeMode = resumer({ observe: idleObservation });
        const context = await attaching(codeMode);
        const resumeHeld = codeMode.resumeHeld!;

        codeMode.stop = (target) =>
          new Promise((done) => {
            ended = () => {
              order.push(`stop ${target.sessionId}`);
              context.entries.splice(0, 1, held('s1', true));
              done(null);
            };
          });
        codeMode.resumeHeld = async (...args) => {
          order.push(`resume ${args[0].id}`);
          return resumeHeld(...args);
        };

        const stop = context.runtime.stopHeld('s1');

        await vi.waitFor(() => expect(context.runtime['ending'].has('s1')).toBe(true));

        const attach = context.runtime.attach('s1');

        await Promise.resolve();
        expect(order).toEqual([]);
        ended();

        expect(await stop).toEqual({ stopped: 's1' });
        expect(await attach).toEqual(HOLDER);
        expect(order).toEqual(['stop s1', 'resume s1']);
        context.runtime.stop();
      });
    });
  });
});

describe('Codex app-server resume (PRD R107)', () => {
  async function stopped() {
    const h = setup(config({ provider: 'codex' }));
    h.runtime.send({ type: 'adhoc', prompt: 'Do it', repoRoot: 'D:/repo', start: true });
    await h.runtime.settled();
    const started = h.store.session('s1')!;
    expect(started).toMatchObject({ execution: 'app-server' });
    h.runtime.send({ type: 'stop-succeeded', sessionId: 's1', reason: 'operator' });
    expect(h.store.session('s1')).toMatchObject({ state: 'ended' });
    return { ...h, started };
  }

  it('resumes an ended thread once with the start options, and holds it again under a new launch', async () => {
    const h = await stopped();
    const configure = vi.spyOn(h.runtime.codexAppServer, 'configure').mockResolvedValue();
    expect(await Promise.all([h.runtime.resumeThread('s1'), h.runtime.resumeThread('s1')])).toEqual([null, null]);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(h.store.session('s1')).toMatchObject({ state: 'idle', released: false, endedAt: null });
    expect(h.store.session('s1')!.launchId).not.toBe(h.started.launchId);
    expect(h.logs).toContain('session s1 resumed in the Codex daemon');
    expect(h.runtime.codexAppServer.deps.resumeOptions?.(h.store.session('s1')!)).toEqual(launchOptions(config({ provider: 'codex' }).settings, null, 'task', 'codex'));
    // A live session is not resumed again.
    expect(await h.runtime.resumeThread('s1')).toBeNull();
    expect(configure).toHaveBeenCalledTimes(1);
    expect(await h.runtime.resumeThread('missing')).toBe('No session missing.');
    h.runtime.stop(); h.store.close();
  });

  it('leaves the session ended with why when Codex refuses, and follows a resume another Codex client made', async () => {
    const h = await stopped();
    const configure = vi.spyOn(h.runtime.codexAppServer, 'configure').mockRejectedValueOnce(new Error('thread not found'));
    expect(await h.runtime.resumeThread('s1')).toContain('thread not found');
    expect(h.store.session('s1')).toMatchObject({ state: 'ended' });
    configure.mockResolvedValue();
    h.runtime.threadResumedElsewhere('unknown-thread');
    h.runtime.threadResumedElsewhere(h.started.nativeSessionId!);
    await h.runtime.settled();
    expect(configure).toHaveBeenCalledTimes(2);
    expect(h.store.session('s1')).toMatchObject({ state: 'idle' });
    h.runtime.stop(); h.store.close();
  });

  it('waits for a Stop still running, and leaves the thread when a newer session started during the resume', async () => {
    const h = await stopped();
    let finish = (): void => undefined;
    const stopping = new Promise<void>((resolve) => { finish = resolve; });
    (h.runtime as unknown as { ending: Map<string, Promise<void>> }).ending.set('s1', stopping);
    const real = h.store.sessionsFor.bind(h.store);
    let newer = false;
    vi.spyOn(h.store, 'sessionsFor').mockImplementation((id) => (newer ? [...real(id), { ...real(id)[0]!, id: 's9' }] : real(id)));
    const configure = vi.spyOn(h.runtime.codexAppServer, 'configure').mockImplementation(async () => { newer = true; });
    const stop = vi.spyOn(h.runtime.codexAppServer, 'stop').mockResolvedValue(null);
    const resumed = h.runtime.resumeThread('s1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(configure).not.toHaveBeenCalled();
    (h.runtime as unknown as { ending: Map<string, Promise<void>> }).ending.delete('s1');
    finish();
    expect(await resumed).toContain('A newer session');
    expect(configure).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith({ sessionId: 's1', shortId: h.started.nativeSessionId }, 'release');
    expect(h.store.session('s1')).toMatchObject({ state: 'ended' });
    h.runtime.stop(); h.store.close();
  });
});


describe('rate limits (architecture.md § Rate limits)', () => {
  const RESET = T0 + 2 * 3_600_000;
  const prompt = { type: 'user', message: { role: 'user', content: 'Go.' }, origin: { kind: 'human' } };
  const usage = { type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 2:00pm (America/New_York)" }] }, apiError: 'usage_limit_reached', apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: RESET / 1000, rateLimitType: 'five_hour' } }, error: 'rate_limit', isApiErrorMessage: true };
  const grace = { type: 'user', message: { role: 'user', content: '[Usage limit reached; a short grace allowance remains …]' }, isMeta: true, usageLimitNote: 'wrap_up' };
  const wait = { type: 'system', subtype: 'informational', content: 'Usage limit reached · continuing automatically at 2:00pm · esc to cancel' };

  function runner(overrides: Partial<SessionRunner> = {}): SessionRunner & { starts: string[] } {
    const starts: string[] = [];

    return {
      start: async (action) => {
        starts.push(action.sessionId);
        return { shortId: `${action.sessionId}-short`, nativeSessionId: `${action.sessionId}-native`, ...(action.codeMode === true ? { launchId: `${action.sessionId}-launch` } : {}) };
      },
      observe: async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: session.state === 'starting' ? ('running' as const) : (session.state as 'running'), detail: session.stateDetail })) }),
      markers: () => new Map(),
      isBackground: async () => true,
      stop: async () => null,
      reconcile: async () => [],
      installHooks: async () => null,
      starts,
      ...overrides,
    };
  }

  /** A held session s1 of an ad-hoc work item whose transcript holds `lines`, and a marker reading the test sets. */
  async function heldWith(lines: unknown[], typed_: { keyAt: number | null } = { keyAt: null }) {
    let now = T0;
    let observed: { state: 'running' | 'idle' | 'failed'; detail: string | null } = { state: 'running', detail: null };
    const codeMode = runner({
      markers: (sessions) => new Map(sessions.filter((session) => session.nativeSessionId !== null).map((session) => [session.nativeSessionId!, { at: now, observed, recheck: false }])),
    });
    const context = setup(config({ codeMode: true }), () => now, { codeMode });
    const typed: string[] = [];
    const guards: Array<() => string | null> = [];

    // The holder's last key from an attached terminal, which the hub's own typing never sets.
    (context.runtime as unknown as { keyAt: () => Promise<number | null> }).keyAt = async () => typed_.keyAt;
    context.runtime.setConversationReader({ read: () => {}, catchUp: () => null, continueAfterLimit: (sessionId, text, guard) => (typed.push(`${sessionId}: ${text}`), guards.push(guard), null) });
    context.runtime.send({ type: 'adhoc', prompt: 'held', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();

    const session = context.store.activeSessions()[0]!;
    const dir = join(home, '.claude', 'projects', projectSlug(session.cwd));
    const path = join(dir, `${session.nativeSessionId}.jsonl`);

    mkdirSync(dir, { recursive: true });
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    return {
      ...context,
      id: session.id,
      codeMode,
      typed,
      guards,
      key: (at: number | null) => (typed_.keyAt = at),
      append: (line: unknown) => writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify(line) + '\n'),
      observe: (state: typeof observed) => (observed = state),
      at: (time: number) => (now = time),
    };
  }

  it('reads the reset time from the transcript when the marker shows the failed turn, and keeps the work item running', async () => {
    const t = await heldWith([prompt, usage]);

    t.observe({ state: 'failed', detail: 'rate_limit' });
    t.runtime.readMarkers();
    expect(t.store.session(t.id)).toMatchObject({ state: 'failed', rateLimit: { kind: 'usage', resetsAt: RESET, exact: true, cli: false } });
    expect(t.store.workItem(1)?.status).toBe('running');
    t.runtime.stop();
  });

  it("finds Claude Code's own wait written after the turn's marker, and stops looking two minutes after the turn end", async () => {
    const t = await heldWith([prompt, grace]);

    t.observe({ state: 'idle', detail: null });
    t.runtime.readMarkers();
    expect(t.store.session(t.id)?.rateLimit).toMatchObject({ resetsAt: null, cli: false });
    expect(t.store.workItem(1)?.status).toBe('running');

    t.append(wait);
    t.at(T0 + 5_000);
    t.runtime.readMarkers();
    expect(t.store.session(t.id)?.rateLimit).toMatchObject({ cli: true });
    expect(t.store.session(t.id)?.rateLimit?.resetsAt).not.toBeNull();

    const before = t.store.session(t.id)?.rateLimit;

    t.append(usage);
    t.at(T0 + 121_000);
    t.runtime.readMarkers();
    expect(t.store.session(t.id)?.rateLimit).toEqual(before);
    t.runtime.stop();
  });

  it('types the continue text once the next attempt is due, and backs off after it', async () => {
    const t = await heldWith([prompt, usage, wait]);

    t.observe({ state: 'failed', detail: 'rate_limit' });
    t.runtime.readMarkers();
    expect(t.store.session(t.id)?.rateLimit?.nextAt).toBe(RESET + CLI_MARGIN_MS);

    t.at(RESET + CLI_MARGIN_MS - 1);
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([]);

    t.at(RESET + CLI_MARGIN_MS);
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([`${t.id}: ${CONTINUE_TEXT}`]);
    expect(t.store.session(t.id)?.rateLimit).toMatchObject({ attempts: 1, attemptedAt: RESET + CLI_MARGIN_MS, nextAt: RESET + CLI_MARGIN_MS + 5 * 60_000 });
    expect(t.logs.filter((line) => line.includes('usage limit'))).toEqual([`session ${t.id} continued after its usage limit, attempt 1`]);

    await t.runtime.continueLimited();
    expect(t.typed).toHaveLength(1);
    t.runtime.stop();
  });

  it('leaves the session to the operator who typed in its terminal during the wait', async () => {
    const t = await heldWith([prompt, usage], { keyAt: T0 + 60_000 });

    t.observe({ state: 'failed', detail: 'rate_limit' });
    t.runtime.readMarkers();
    t.at(RESET + 3_600_000);
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([]);
    expect(t.store.session(t.id)?.rateLimit ?? null).toBeNull();
    expect(t.store.workItem(1)).toMatchObject({ status: 'blocked', error: MESSAGES.limitSkipped });
    t.runtime.stop();
  });

  it('releases an idle Codex app-server thread an hour after its turn, but not one waiting on its usage limit (PRD R107)', async () => {
    let now = T0;
    const codexAppServer = runner();
    const context = setup(config({ provider: 'codex' }), () => now, { codexAppServer });

    context.runtime.send({ type: 'adhoc', prompt: 'one', repoRoot: 'D:/git/widgets', start: true });
    context.runtime.send({ type: 'adhoc', prompt: 'two', repoRoot: 'D:/git/widgets', start: true });
    await context.runtime.settled();
    context.runtime.send({ type: 'marker', sessionId: 's1', state: 'idle', detail: null });
    context.runtime.send({ type: 'marker', sessionId: 's2', state: 'failed', detail: 'rate_limit', limit: { kind: 'usage', window: null, resetsAt: T0 + 7_200_000, exact: true, cli: false, message: null } });

    now = T0 + 3_600_000 - 1;
    context.runtime.wake();
    await context.runtime.settled();
    expect(context.store.session('s1')?.state).toBe('idle');

    now = T0 + 3_600_000;
    context.runtime.wake();
    await context.runtime.settled();
    expect(context.store.session('s1')).toMatchObject({ state: 'ended', released: true });
    expect(context.store.session('s2')).toMatchObject({ state: 'failed', released: false, releasing: false });
    context.runtime.stop();
  });

  it("passes a guard that refuses the typing once the session's limit or work item changed while it was queued", async () => {
    const t = await heldWith([prompt, usage, wait]);

    t.observe({ state: 'failed', detail: 'rate_limit' });
    t.runtime.readMarkers();
    t.at(RESET + CLI_MARGIN_MS);
    await t.runtime.continueLimited();

    const [guard] = t.guards;

    // The attempt itself moved nextAt, so the queued typing's guard now refuses; so does a new turn.
    expect(guard!()).toBe('The session no longer waits on that usage limit.');
    t.store.updateSession(t.id, { state: 'running' });
    expect(guard!()).toBe('The session no longer waits on that usage limit.');
    t.runtime.stop();
  });

  it('skips an attempt whose work item stopped running, and a key typed after a refused attempt still leaves it to the operator', async () => {
    const t = await heldWith([prompt, usage]);

    t.observe({ state: 'failed', detail: 'rate_limit' });
    t.runtime.readMarkers();
    t.store.updateWorkItem(1, { status: 'blocked' });
    t.at(RESET + 3_600_000);
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([]);

    t.store.updateWorkItem(1, { status: 'running' });
    t.runtime.send({ type: 'limit-attempt', sessionId: t.id, error: 'The session is busy.' });
    t.key(RESET + 3_600_000 + 30_000);
    t.at(RESET + 3_600_000 + BACKOFF_MS[0]!);
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([]);
    expect(t.store.workItem(1)).toMatchObject({ status: 'blocked', error: MESSAGES.limitSkipped });
    t.runtime.stop();
  });

  it('reads the limit when the roster settles the turn end before the marker pass does', async () => {
    const t = await heldWith([prompt, grace]);

    t.codeMode.observe = async (sessions) => ({ sessions: sessions.map((session) => ({ sessionId: session.id, state: 'idle' as const, detail: null })) });
    await (t.runtime as unknown as { readRoster(): Promise<void> }).readRoster();
    expect(t.store.session(t.id)).toMatchObject({ state: 'idle', rateLimit: { kind: 'usage' } });
    expect(t.store.workItem(1)?.status).toBe('running');
    t.runtime.stop();
  });

  it('reads once after a hub start a turn end older than two minutes that has no limit yet', async () => {
    const t = await heldWith([prompt, grace]);

    t.store.updateSession(t.id, { state: 'idle', stateAt: T0 - 10 * 60_000, rateLimit: null });
    t.observe({ state: 'idle', detail: null });
    t.runtime.readMarkers();
    expect(t.store.session(t.id)?.rateLimit).toMatchObject({ kind: 'usage' });
    t.runtime.stop();
  });

  it('does not continue a session resumed under another launch, or a background one', async () => {
    const t = await heldWith([prompt, usage]);

    t.observe({ state: 'failed', detail: 'rate_limit' });
    t.runtime.readMarkers();
    t.store.updateSession(t.id, { launchId: 'another' });
    t.at(RESET + 3_600_000);
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([]);

    t.store.updateSession(t.id, { launchId: t.store.session(t.id)!.rateLimit!.launchId, codeMode: false });
    await t.runtime.continueLimited();
    expect(t.typed).toEqual([]);
    t.runtime.stop();
  });
});
