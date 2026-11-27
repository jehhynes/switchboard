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
import { T0, home, config, ok, fail, issue, FakeCodex, setup } from './runtimeFixtures.js';

describe('Runtime', () => {
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

  it('logs a failed stop of a deleted work item, which has no row to show it (PRD R120)', async () => {
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
    let now = T0;
    const { store, runtime, cli } = setup(config({ installHooks: true }), () => now);
    store.insertTicket({ source: 'adhoc', sourceKey: '1', ref: '#1', repo: '', sourceId: null, title: 'x', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: 'D:/x' });
    runtime.send({ type: 'adhoc', prompt: 'Do it', repoRoot: 'D:/scratch', start: true });
    await runtime.settled();
    store.updateSession('s1', { state: 'starting', shortId: null });

    await runtime.startup();

    expect(store.session('s1')).toMatchObject({ state: 'running', nativeSessionId: '00000001-native', shortId: '00000001', stateDetail: null, outcome: null });
    expect(store.workItem(1)).toMatchObject({ status: 'running', error: null, warning: null });

    // One the holder no longer holds failed to start.
    store.updateSession('s1', { state: 'starting', shortId: null });
    cli.roster = [];
    now += 1_000;
    await runtime.startup();
    expect(store.session('s1')).toMatchObject({ state: 'ended', outcome: 'failed', outcomeDetail: 'Switchboard stopped while the session was starting.' });
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

  it('shows a failed hook install instead of failing startup', async () => {
    const { runtime } = setup(config({ installHooks: true }));
    mkdirSync(join(home, '.claude', 'settings.json'), { recursive: true });

    await runtime.startup();

    expect(runtime.snapshot().errors.hooks).toMatch(/^Switchboard could not add its hooks to .*settings\.json: EISDIR/);
  });
});
