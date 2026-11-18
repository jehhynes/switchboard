import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSION_PROMPT, START_PROMPT } from '@switchboard/core';
import type { Session, StartAction } from '@switchboard/core';
import type { SessionEntry, SpawnRequest } from '@switchboard/holder';
import {
  CodeModeRunner,
  HOOKS_REQUIRED,
  claudeFile,
  codeModeEnvironment,
  codeModeEvidence,
  codeModeResumeArgs,
  codeModeSettings,
  codeModeStartArgs,
  showsStartPrompt,
} from '../src/codeMode.js';
import type { HolderAccess, HolderLookup } from '../src/codeMode.js';

const fixture = (name: string): { head: string; text: string } => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'codemode', `${name}.json`), 'utf8')) as { head: string; text: string };
const ON = fixture('on');
const OFF = fixture('telemetry-off');
const TRUST = fixture('trust');
const SETTINGS = '{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com","ANTHROPIC_API_KEY":"","ANTHROPIC_AUTH_TOKEN":"","ANTHROPIC_CUSTOM_HEADERS":""}}';
const NATIVE = '11111111-2222-3333-4444-555555555555';
const LAUNCH = 'launch-1';

describe('Code Mode command', () => {
  it('builds the environment from the hub\'s without VS Code, Node.js options, session markers or credentials, with Code Mode, the direct API and the launch', () => {
    const env = codeModeEnvironment(
      {
        PATH: 'C:/bin',
        CLAUDE_CONFIG_DIR: 'C:/cfg',
        ELECTRON_RUN_AS_NODE: '1',
        VSCODE_PID: '7',
        NODE_OPTIONS: '--inspect',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'parent',
        AI_AGENT: 'x',
        ANTHROPIC_API_KEY: 'key',
        ANTHROPIC_AUTH_TOKEN: 'token',
        ANTHROPIC_CUSTOM_HEADERS: 'X-Api-Key: k',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
        ANTHROPIC_MODEL: 'kept',
        CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bin/bash.exe',
        CLAUDE_CODE_MESSAGING_PORT: '9',
      },
      LAUNCH,
      'claude',
    );

    expect(env).toEqual({
      PATH: 'C:/bin',
      CLAUDE_CONFIG_DIR: 'C:/cfg',
      ANTHROPIC_MODEL: 'kept',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bin/bash.exe',
      CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      SWITCHBOARD_LAUNCH: LAUNCH,
    });
  });

  it('puts an absolute claudePath\'s folder first on PATH', () => {
    const claude = join(tmpdir(), 'tools', 'claude.exe');
    const env = codeModeEnvironment({ Path: 'C:/bin' }, LAUNCH, claude);

    expect(env['Path']).toBe(`${join(tmpdir(), 'tools')}${delimiter}C:/bin`);
    expect(env['PATH']).toBeUndefined();
  });

  it('overrides the gateway and credentials in --settings, so user settings cannot restore them (mechanics M64)', () => {
    expect(codeModeSettings()).toBe(SETTINGS);
  });

  it('starts with the session ID, permission mode, name, model, contract and settings, and the prompt as one last argument', () => {
    const action = { permissionMode: 'auto', name: 'Switchboard · #12', model: 'haiku', contract: 'Report with …', prompt: '/fix the bug\nnow' } as const;

    expect(codeModeStartArgs(action, NATIVE)).toEqual(['--session-id', NATIVE, '--permission-mode', 'auto', '-n', 'Switchboard · #12', '--model', 'haiku', '--append-system-prompt', 'Report with …', '--settings', SETTINGS, '/fix the bug\nnow']);
    expect(codeModeStartArgs({ ...action, model: null }, NATIVE)).not.toContain('--model');
  });

  it('resumes with no prompt, keeping the permission mode, model and settings', () => {
    expect(codeModeResumeArgs(NATIVE, 'manual', 'opus')).toEqual(['--resume', NATIVE, '--permission-mode', 'manual', '--model', 'opus', '--settings', SETTINGS]);
    expect(codeModeResumeArgs(NATIVE, 'auto', null)).toEqual(['--resume', NATIVE, '--permission-mode', 'auto', '--settings', SETTINGS]);
  });

  it('runs claude.exe on Windows when the path names no extension', () => {
    expect(claudeFile('claude', 'win32')).toBe('claude.exe');
    expect(claudeFile('C:/x.y/claude', 'win32')).toBe('C:/x.y/claude.exe');
    expect(claudeFile('C:/bin/claude.exe', 'win32')).toBe('C:/bin/claude.exe');
    expect(claudeFile('claude', 'linux')).toBe('claude');
  });
});

describe('codeModeEvidence', () => {
  it('reads the is-on line from a recorded start (mechanics M63)', () => {
    expect(codeModeEvidence(ON.head)).toEqual({ on: true });
  });

  it("reads Claude's reason from a recorded start without Code Mode, across the line wrap (mechanics M71)", () => {
    expect(codeModeEvidence(OFF.head)).toEqual({
      off: "Code Mode (experimental) isn't available: it needs settings that Claude Code downloads from Anthropic, and this session doesn't download them (DISABLE_TELEMETRY, DO_NOT_TRACK, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC or CLAUDE_CODE_DISABLE_FEATURE_FLAGS turns that off). Starting with the ordinary tools.",
    });
  });

  it('reads nothing from a dialog before the start, which shows a start prompt (mechanics M70)', () => {
    expect(codeModeEvidence(TRUST.head)).toBeNull();
    expect(showsStartPrompt(TRUST.text)).toBe(true);
    expect(showsStartPrompt(ON.text)).toBe(false);
  });

  it('reads cursor moves as the spaces they skip, and takes the first of the two lines when output quotes the other later', () => {
    expect(codeModeEvidence('Code\u001b[1CMode (experimental)\u001b[2Cis on')).toEqual({ on: true });
    expect(codeModeEvidence(`${ON.head}\r\n● Quoting: Code Mode (experimental) isn't available: x`)).toEqual({ on: true });
  });

  it('reads the refusal without the warning sign and split by escape sequences', () => {
    expect(codeModeEvidence("\u001b[33mCode Mode (experimental) isn't\u001b[0m\r\n available: for now it only works directly")).toEqual({ off: "Code Mode (experimental) isn't available: for now it only works directly" });
  });
});

/** A holder whose answers the test sets; it fails on a call it was not set up for. */
class FakeHolder implements HolderAccess {
  spawned: SpawnRequest[] = [];
  killed: string[] = [];
  screens = new Map<string, { head: string; text: string }>();
  entries: SessionEntry[] = [];
  failSpawn: string | null = null;
  failKill: string | null = null;

  spawn(request: SpawnRequest): Promise<{ session: string; pid: number }> {
    if (this.failSpawn !== null) {
      return Promise.reject(new Error(this.failSpawn));
    }

    this.spawned.push(request);
    this.entries.push(entry(request.session));

    return Promise.resolve({ session: request.session, pid: 100 });
  }

  list(): Promise<SessionEntry[]> {
    return Promise.resolve(this.entries);
  }

  kill(session: string): Promise<number | null> {
    if (this.failKill !== null) {
      return Promise.reject(new Error(this.failKill));
    }

    const found = this.entries.find((one) => one.session === session && one.exitedAt === null);

    if (found === undefined) {
      return Promise.reject(new Error(`No session ${session} is held.`));
    }

    this.killed.push(session);
    found.exitedAt = 1;
    found.exitCode = 1;

    return Promise.resolve(1);
  }

  screen(session: string): Promise<{ head: string; text: string }> {
    const screen = this.screens.get(session);

    return screen === undefined ? Promise.reject(new Error(`No screen for ${session}`)) : Promise.resolve(screen);
  }
}

function entry(session: string, exited = false): SessionEntry {
  return { session, label: 'l', pid: 100, cwd: 'D:/work', startedAt: 0, lastInputAt: null, lastOutputAt: null, exitedAt: exited ? 5 : null, exitCode: exited ? 3 : null, clients: 0, memoryBytes: null };
}

const ACTION: StartAction = {
  type: 'start-session',
  sessionId: 'sb-1',
  workItemId: 1,
  kind: 'task',
  provider: 'claude',
  cwd: 'D:/work',
  prompt: 'Do it',
  contract: 'Contract',
  name: 'Switchboard · #1',
  permissionMode: 'auto',
  model: 'haiku',
  nativeSessionId: NATIVE,
  launchId: LAUNCH,
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sb-1', workItemId: 1, kind: 'task', provider: 'claude', nativeSessionId: NATIVE, shortId: NATIVE.slice(0, 8), cwd: 'D:/work', state: 'running', stateAt: 0,
    stateDetail: null, outcome: null, outcomeDetail: null, startedAt: 0, endedAt: null, released: false, releasing: false, question: null, reports: [],
    retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null, codeMode: true, launchId: LAUNCH, ...overrides,
  };
}

let home: string;
let clock: number;
let holder: FakeHolder;
let lookup: HolderLookup;
let hooks: boolean;
let onSleep: ((now: number) => void) | null;
let roster: Array<{ sessionId: string; pid?: number }>;

function marker(sessionId: string, fields: Record<string, unknown>): void {
  mkdirSync(join(home, 'activity'), { recursive: true });
  writeFileSync(join(home, 'activity', `${sessionId}.json`), JSON.stringify({ v: 1, sessionId, at: clock, notificationType: null, source: null, toolName: null, backgroundTasks: 0, error: null, errorMessage: null, ...fields }));
}

function runner(): CodeModeRunner {
  return new CodeModeRunner({
    claudePath: () => 'claude',
    home,
    hooks: () => hooks,
    holder: () => Promise.resolve(lookup),
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      onSleep?.(clock);

      return Promise.resolve();
    },
    newId: () => 'new-id',
    roster: () => Promise.resolve(roster),
    readTimeoutMs: 20,
    environment: { PATH: 'C:/bin' },
    platform: 'linux',
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'code-mode-'));
  clock = 1_000;
  holder = new FakeHolder();
  lookup = { holder };
  hooks = true;
  onSleep = null;
  roster = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('CodeModeRunner.start', () => {
  it('spawns claude in the holder and starts once the output shows Code Mode on and a marker of the launch exists', async () => {
    holder.screens.set('sb-1', { head: '', text: '' });
    onSleep = (now) => {
      if (now >= 3_000) {
        holder.screens.set('sb-1', ON);
        marker(NATIVE, { event: 'UserPromptSubmit', launch: LAUNCH });
      }
    };

    expect(await runner().start(ACTION)).toEqual({ shortId: NATIVE.slice(0, 8), nativeSessionId: NATIVE, launchId: LAUNCH });
    expect(holder.spawned).toEqual([
      {
        session: 'sb-1',
        label: `Switchboard · #1 ${NATIVE}`,
        file: 'claude',
        args: codeModeStartArgs(ACTION, NATIVE),
        cwd: 'D:/work',
        env: { PATH: 'C:/bin', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', SWITCHBOARD_LAUNCH: LAUNCH },
        cols: 120,
        rows: 40,
      },
    ]);
    expect(holder.killed).toEqual([]);
  });

  it("fails with Claude's reason and ends the process when Claude starts without Code Mode", async () => {
    holder.screens.set('sb-1', OFF);

    const result = await runner().start(ACTION);

    expect(result).toEqual({ error: expect.stringMatching(/^Code Mode \(experimental\) isn't available: it needs settings/) as unknown });
    expect(holder.killed).toEqual(['sb-1']);
  });

  it('fails a start whose marker arrives without the is-on line, after one more look', async () => {
    holder.screens.set('sb-1', { head: 'Claude Code v2.1.327\r\n', text: '' });
    marker(NATIVE, { event: 'SessionStart', source: 'startup', launch: LAUNCH });

    expect(await runner().start(ACTION)).toEqual({ error: 'Claude started the session without Code Mode: its output has no "Code Mode (experimental) is on" line.' });
    expect(clock).toBe(2_000);
    expect(holder.killed).toEqual(['sb-1']);
  });

  it('ignores a marker of an older launch or another session, and starts waiting on a prompt after the start-prompt wait', async () => {
    holder.screens.set('sb-1', { head: ON.head, text: '' });
    marker(NATIVE, { event: 'Stop', launch: 'older' });
    marker('other', { event: 'Stop', launch: LAUNCH });

    expect(await runner().start(ACTION)).toEqual({ shortId: NATIVE.slice(0, 8), nativeSessionId: NATIVE, launchId: LAUNCH, startPrompt: true });
    expect(clock).toBe(21_000);
  });

  it('starts waiting on a prompt at once when a dialog shows, such as folder trust (mechanics M70)', async () => {
    holder.screens.set('sb-1', TRUST);

    expect(await runner().start(ACTION)).toEqual({ shortId: NATIVE.slice(0, 8), nativeSessionId: NATIVE, launchId: LAUNCH, startPrompt: true });
    expect(clock).toBe(1_000);
  });

  it("fails a process that exits before the session starts with the screen's last lines", async () => {
    holder.screens.set('sb-1', { head: '', text: 'Claude Code v2.1.327\n\nError: something broke\n\n' });
    holder.spawn = (request) => {
      holder.spawned.push(request);
      holder.entries.push(entry(request.session, true));

      return Promise.resolve({ session: request.session, pid: 100 });
    };

    expect(await runner().start(ACTION)).toEqual({ error: 'Claude exited with code 3 before the session started: Claude Code v2.1.327\nError: something broke' });
  });

  it('refuses a start with hooks off, and spawns nothing (PRD R93)', async () => {
    hooks = false;

    expect(await runner().start(ACTION)).toEqual({ error: HOOKS_REQUIRED });
    expect(holder.spawned).toEqual([]);
  });

  it('looks again after a holder read fails, and ends the process when the deadline passes without an answer', async () => {
    let reads = 0;

    holder.screen = () => (++reads <= 2 ? Promise.reject(new Error('The terminal holder closed the connection.')) : Promise.resolve(TRUST));
    expect(await runner().start(ACTION)).toMatchObject({ startPrompt: true });
    expect(reads).toBe(3);

    holder.screen = () => Promise.reject(new Error('The terminal holder closed the connection.'));
    holder.entries = [];
    clock = 1_000;
    expect(await runner().start(ACTION)).toEqual({ error: 'The session did not start within 60 seconds: The terminal holder closed the connection.' });
    expect(holder.killed).toEqual(['sb-1']);
  });

  it('counts a holder request that never answers as failed, and ends the process at the deadline', async () => {
    holder.screen = () => new Promise(() => undefined);

    expect(await runner().start(ACTION)).toEqual({ error: 'The session did not start within 60 seconds: The terminal holder did not answer within 0.02 seconds.' });
    expect(holder.killed).toEqual(['sb-1']);
  });

  it('says so when ending a refused start fails too', async () => {
    holder.screens.set('sb-1', OFF);
    holder.failKill = 'Access is denied.';

    expect(await runner().start(ACTION)).toEqual({ error: expect.stringMatching(/Starting with the ordinary tools\. Ending it failed too: Access is denied\.$/) as unknown });
  });

  it('fails with the reason when the holder cannot start or refuses the spawn', async () => {
    lookup = { error: 'The terminal holder did not write its record within 10 seconds; see C:/h/holder.log.' };
    expect(await runner().start(ACTION)).toEqual({ error: 'The terminal holder did not write its record within 10 seconds; see C:/h/holder.log.' });

    lookup = { holder };
    holder.failSpawn = 'claude could not be started: File not found';
    expect(await runner().start(ACTION)).toEqual({ error: 'claude could not be started: File not found' });
  });

  it('generates the session ID and launch when the action names none', async () => {
    holder.screens.set('sb-1', ON);
    marker('new-id', { event: 'UserPromptSubmit', launch: 'new-id' });

    const { nativeSessionId: _native, launchId: _launch, ...action } = ACTION;

    expect(await runner().start(action)).toEqual({ shortId: 'new-id', nativeSessionId: 'new-id', launchId: 'new-id' });
  });
});

describe('CodeModeRunner.observe', () => {
  it('lists held sessions with the state of their own launch\'s marker, and leaves out exited and unheld ones', async () => {
    holder.entries = [entry('sb-1'), entry('sb-2', true)];
    marker(NATIVE, { event: 'Stop', launch: LAUNCH });

    expect(await runner().observe([session(), session({ id: 'sb-2' }), session({ id: 'sb-3' })])).toEqual({ sessions: [{ sessionId: 'sb-1', state: 'idle', detail: null, interactive: false }], forks: [] });
  });

  it('keeps the last state when no marker of the launch exists, and reads a promptless resume as idle (mechanics M68)', async () => {
    holder.entries = [entry('sb-1')];
    marker(NATIVE, { event: 'Stop', launch: 'older' });

    expect(await runner().observe([session({ state: 'waiting', stateDetail: PERMISSION_PROMPT })])).toMatchObject({ sessions: [{ state: 'waiting', detail: PERMISSION_PROMPT }] });

    marker(NATIVE, { event: 'SessionStart', source: 'resume', launch: LAUNCH });
    expect(await runner().observe([session()])).toMatchObject({ sessions: [{ state: 'idle', detail: null }] });
  });

  it('reads a fresh start as running and leaves the state as it was after a compaction (mechanics M65)', async () => {
    holder.entries = [entry('sb-1')];
    marker(NATIVE, { event: 'SessionStart', source: 'startup', launch: LAUNCH });
    expect(await runner().observe([session({ state: 'starting' })])).toMatchObject({ sessions: [{ state: 'running' }] });

    marker(NATIVE, { event: 'SessionStart', source: 'compact', launch: LAUNCH });
    expect(await runner().observe([session({ state: 'idle' })])).toMatchObject({ sessions: [{ state: 'idle' }] });
  });

  it('takes no resumed ID as a change while the session\'s own marker remains, as for a nested claude -p --resume', async () => {
    holder.entries = [entry('sb-1')];
    marker(NATIVE, { event: 'PostToolBatch', launch: LAUNCH });
    marker('resumed-elsewhere', { event: 'SessionStart', source: 'resume', launch: LAUNCH, startSource: 'resume' });

    expect(await runner().observe([session()])).toMatchObject({ forks: [] });
  });

  it('keeps a session waiting on its start prompt when its screen cannot be read', async () => {
    holder.entries = [entry('sb-1')];
    marker(NATIVE, { event: 'SessionStart', source: 'startup', launch: LAUNCH });

    expect(await runner().observe([session({ state: 'waiting', stateDetail: START_PROMPT })])).toMatchObject({ sessions: [{ state: 'waiting', detail: START_PROMPT }] });
    expect(holder.killed).toEqual([]);
  });

  it('reports an ID change in the terminal as a fork, but not a nested claude -p run (mechanics M73, M77)', async () => {
    holder.entries = [entry('sb-1')];
    marker('nested', { event: 'Stop', launch: LAUNCH, startSource: null });

    expect(await runner().observe([session()])).toMatchObject({ forks: [] });

    marker('cleared-id', { event: 'UserPromptSubmit', launch: LAUNCH, startSource: 'clear' });
    // Not followed until the roster lists the held process with the new ID.
    expect(await runner().observe([session()])).toMatchObject({ forks: [] });

    roster = [{ sessionId: 'cleared-id', pid: 100 }];
    expect((await runner().observe([session()]) as { forks: unknown[] }).forks).toEqual([{ sessionId: 'sb-1', nativeSessionId: 'cleared-id', shortId: 'cleared-', state: 'running', detail: null }]);
  });

  it('follows the ID the roster lists for the held process when a nested resumed run left a marker too', async () => {
    holder.entries = [entry('sb-1')];
    marker('nested-resumed', { event: 'Stop', launch: LAUNCH, startSource: 'resume' });
    marker('cleared-id', { event: 'SessionStart', source: 'clear', launch: LAUNCH, startSource: 'clear' });
    roster = [{ sessionId: 'nested-resumed' }, { sessionId: 'cleared-id', pid: 100 }];

    expect((await runner().observe([session()]) as { forks: Array<{ nativeSessionId: string }> }).forks.map((fork) => fork.nativeSessionId)).toEqual(['cleared-id']);
  });

  it('fails and ends a session that started on a prompt when its first marker comes without Code Mode', async () => {
    holder.entries = [entry('sb-1')];
    holder.screens.set('sb-1', { head: 'no banner', text: '' });
    marker(NATIVE, { event: 'SessionStart', source: 'startup', launch: LAUNCH });

    expect(await runner().observe([session({ state: 'waiting', stateDetail: START_PROMPT })])).toMatchObject({ sessions: [{ state: 'failed', detail: expect.stringContaining('without Code Mode') as unknown }] });
    expect(holder.killed).toEqual(['sb-1']);

    holder.entries = [entry('sb-1')];
    holder.screens.set('sb-1', ON);
    expect(await runner().observe([session({ state: 'waiting', stateDetail: START_PROMPT })])).toMatchObject({ sessions: [{ state: 'running', detail: null }] });
  });

  it('reports a gone holder and a failed read apart', async () => {
    lookup = { gone: true };
    expect(await runner().observe([session()])).toEqual({ sessions: [], forks: [], gone: true });

    lookup = { error: 'The terminal holder did not answer.' };
    expect(await runner().observe([session()])).toEqual({ error: 'The terminal holder did not answer.' });

    lookup = { holder };
    holder.list = () => Promise.reject(new Error('The terminal holder closed the connection.'));
    expect(await runner().observe([session()])).toEqual({ error: 'The terminal holder closed the connection.' });
  });

  it('reads markers of its sessions\' own launches only, and none with hooks off', () => {
    marker(NATIVE, { event: 'PermissionRequest', toolName: 'Bash', launch: LAUNCH, at: 42 });
    marker('other', { event: 'Stop', launch: 'x' });

    expect([...runner().markers([session()])]).toEqual([[NATIVE, { at: 42, cwd: null, observed: { state: 'waiting', detail: PERMISSION_PROMPT }, recheck: false }]]);
    expect(runner().markers([session({ launchId: 'other' })]).size).toBe(0);

    hooks = false;
    expect(runner().markers([session()]).size).toBe(0);
  });
});

describe('CodeModeRunner stop, resume and reconcile', () => {
  it('stops by killing the session in the holder; an unheld session or a gone holder has stopped already', async () => {
    holder.entries = [entry('sb-1')];
    expect(await runner().isBackground({ sessionId: 'sb-1', shortId: null })).toBe(true);
    expect(await runner().stop({ sessionId: 'sb-1', shortId: null }, 'operator')).toBeNull();
    expect(holder.killed).toEqual(['sb-1']);
    expect(await runner().isBackground({ sessionId: 'sb-1', shortId: null })).toBe(false);
    expect(await runner().stop({ sessionId: 'sb-9', shortId: null }, 'operator')).toBeNull();

    holder.entries = [entry('sb-1')];
    holder.failKill = 'Session sb-1 did not exit within 15 seconds.';
    expect(await runner().stop({ sessionId: 'sb-1', shortId: null }, 'operator')).toEqual({ error: 'Session sb-1 did not exit within 15 seconds.' });

    lookup = { gone: true };
    expect(await runner().stop({ sessionId: 'sb-1', shortId: null }, 'operator')).toBeNull();
    expect(await runner().isBackground({ sessionId: 'sb-1', shortId: null })).toBe(false);
  });

  it('resumes an ended session in the holder with a new launch and no prompt', async () => {
    expect(await runner().resumeHeld(session(), 'auto', 'haiku', 'label')).toEqual({ launchId: 'new-id' });
    expect(holder.spawned[0]).toMatchObject({ session: 'sb-1', label: 'label', args: codeModeResumeArgs(NATIVE, 'auto', 'haiku'), env: { SWITCHBOARD_LAUNCH: 'new-id' } });
    expect(await runner().resumeHeld(session({ nativeSessionId: null }), 'auto', null, 'label')).toEqual({ error: 'The session never started, so it cannot be resumed.' });
  });

  it('settles sessions a stopped hub left starting with the same check', async () => {
    holder.entries = [entry('sb-1'), entry('sb-2'), entry('sb-4'), entry('sb-6')];
    holder.screens.set('sb-1', ON);
    holder.screens.set('sb-2', OFF);
    holder.screens.set('sb-4', { head: '', text: '' });
    holder.screens.set('sb-6', { head: 'no banner', text: '' });
    marker(NATIVE, { event: 'Stop', launch: LAUNCH });
    marker('six', { event: 'Stop', launch: LAUNCH });
    clock = 5_000;

    expect(
      await runner().reconcile([
        session({ state: 'starting' }),
        session({ id: 'sb-2', state: 'starting' }),
        session({ id: 'sb-3', state: 'starting' }),
        session({ id: 'sb-4', state: 'starting', nativeSessionId: 'other' }),
        session({ id: 'sb-5', state: 'starting', nativeSessionId: null }),
        session({ id: 'sb-6', state: 'starting', nativeSessionId: 'six' }),
      ]),
    ).toEqual([
      { sessionId: 'sb-1', started: { shortId: NATIVE.slice(0, 8), nativeSessionId: NATIVE } },
      { sessionId: 'sb-2', failed: expect.stringMatching(/^Code Mode \(experimental\) isn't available/) as unknown },
      { sessionId: 'sb-3', failed: 'The hub stopped while the session was starting.' },
      { sessionId: 'sb-4', pending: 'The session is still starting.' },
      { sessionId: 'sb-5', failed: 'The hub stopped while the session was starting.' },
      { sessionId: 'sb-6', failed: 'Claude started the session without Code Mode: its output has no "Code Mode (experimental) is on" line.' },
    ]);
    expect(holder.killed).toEqual(['sb-2', 'sb-6']);
  });

  it('fails starting sessions when the holder is gone, and waits when it does not answer', async () => {
    lookup = { gone: true };
    expect(await runner().reconcile([session({ state: 'starting' })])).toEqual([{ sessionId: 'sb-1', failed: 'The hub stopped while the session was starting.' }]);

    lookup = { error: 'The terminal holder did not answer.' };
    expect(await runner().reconcile([session({ state: 'starting' })])).toEqual([{ sessionId: 'sb-1', pending: 'The terminal holder did not answer.' }]);
  });
});
