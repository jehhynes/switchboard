import { describe, expect, it } from 'vitest';
import type { HolderAccess, HolderLookup } from '@switchboard/claude';
import type { Session } from '@switchboard/core';
import type { SessionEntry, SpawnRequest } from '@switchboard/holder';
import { CodexTerminals, NO_FIRST_TURN, controlSocket, noCodexTerminal } from '../src/codexTerminal.js';

const codex = (patch: Partial<Session> = {}): Session =>
  ({ id: 's1', workItemId: 1, kind: 'task', execution: 'app-server', codeMode: false, nativeSessionId: 'thread-1', launchId: 'L1', state: 'idle', released: false, releasing: false, cwd: 'D:/git/widgets', ...patch }) as unknown as Session;

const entry = (session: string, exited = false): SessionEntry =>
  ({ session, label: 'l', pid: 7, cwd: 'D:/git/widgets', startedAt: 0, lastInputAt: null, lastOutputAt: null, exitedAt: exited ? 1 : null, exitCode: exited ? 0 : null, clients: 0, memoryBytes: null }) as SessionEntry;

function setup() {
  const sessions = new Map<string, Session>([['s1', codex()]]);
  const entries: SessionEntry[] = [];
  const calls: string[] = [];
  const spawns: SpawnRequest[] = [];
  const logs: string[] = [];
  let lookup: HolderLookup | null = null;
  let turns = true;
  let spawnGate: Promise<void> = Promise.resolve();
  let onSpawn = (): void => undefined;
  let killError: string | null = null;
  const ends = new Map<string, Promise<void>>();
  const holder: HolderAccess = {
    spawn: async (request) => {
      calls.push(`spawn ${request.session}`);
      spawns.push(request);
      onSpawn();
      await spawnGate;
      entries.splice(0, entries.length, ...entries.filter((one) => one.session !== request.session), entry(request.session));
      return { session: request.session, pid: 7 };
    },
    list: async () => entries.map((one) => ({ ...one })),
    kill: async (session) => {
      if (killError !== null) {
        throw new Error(killError);
      }

      calls.push(`kill ${session}`);
      entries.splice(0, entries.length, ...entries.map((one) => (one.session === session ? entry(session, true) : one)));
      return 0;
    },
    screen: async () => ({ head: '', text: '' }),
  };
  const terminals = new CodexTerminals({
    holder: async (start) => {
      calls.push(`holder ${start}`);
      return lookup ?? { holder };
    },
    session: (id) => sessions.get(id) ?? null,
    label: (session) => `switchboard · ad-hoc · adhoc 1 ${session.nativeSessionId}`,
    codexPath: () => '/Codex/bin/codex',
    codexHome: 'D:\\cxh',
    env: { EXTRA: '1' },
    hasTurns: async () => turns,
    ending: (id) => ends.get(id),
    log: (line) => logs.push(line),
    environment: { PATH: 'C:/bin', VSCODE_PID: '1', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', HOME: 'C:/Users/me' },
    platform: 'win32',
  });

  return {
    terminals,
    sessions,
    entries,
    calls,
    spawns,
    logs,
    ends,
    lookup: (value: HolderLookup | null) => (lookup = value),
    noTurns: () => (turns = false),
    failKill: (why: string | null) => (killError = why),
    holdSpawn: () => {
      let open = (): void => undefined;
      let started = (): void => undefined;
      const spawned = new Promise<void>((done) => (started = done));

      spawnGate = new Promise((done) => (open = done));
      onSpawn = () => started();
      return { open: () => open(), spawned };
    },
  };
}

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe('Codex terminals in the holder', () => {
  it("starts Codex's terminal app on the session's thread once, inline and on the daemon's control socket, under the Switchboard session ID", async () => {
    const t = setup();

    await t.terminals.ensure('s1');
    await t.terminals.ensure('s1');
    expect(t.calls).toEqual(['holder true', 'spawn s1', 'holder true']);

    const [spawn] = t.spawns;

    expect(spawn).toMatchObject({
      session: 's1',
      label: 'switchboard · ad-hoc · adhoc 1 thread-1',
      file: '/Codex/bin/codex.exe',
      args: ['resume', '--no-alt-screen', '--remote', 'unix://D:/cxh/app-server-control/app-server-control.sock', 'thread-1'],
      cwd: 'D:/git/widgets',
    });
    expect(spawn!.env).toMatchObject({ CODEX_HOME: 'D:\\cxh', TERM: 'xterm-256color', EXTRA: '1', HOME: 'C:/Users/me' });
    expect(spawn!.env['PATH']!.startsWith('/Codex/bin')).toBe(true);
    expect(Object.keys(spawn!.env).filter((name) => /^(VSCODE_|ELECTRON_|NODE_OPTIONS)/.test(name))).toEqual([]);
    expect(controlSocket('C:\\Users\\me\\.codex')).toBe('unix://C:/Users/me/.codex/app-server-control/app-server-control.sock');
  });

  it('starts a new terminal in place of one that exited, as after Ctrl+C at its idle prompt', async () => {
    const t = setup();

    t.entries.push(entry('s1', true));
    await t.terminals.ensure('s1');
    expect(t.calls).toEqual(['holder true', 'spawn s1']);
    expect(t.entries).toEqual([entry('s1')]);
  });

  it('refuses a session with no thread, an ended or released one, a thread with no turn yet, and a holder that does not start', async () => {
    const t = setup();

    t.sessions.set('s1', codex({ nativeSessionId: null }));
    await expect(t.terminals.ensure('s1')).rejects.toThrow('This session has no Codex thread.');
    t.sessions.set('s1', codex({ execution: null, codeMode: true }));
    await expect(t.terminals.ensure('s1')).rejects.toThrow('This session has no Codex thread.');
    t.sessions.set('s1', codex({ state: 'ended' }));
    await expect(t.terminals.ensure('s1')).rejects.toThrow('The session has ended. Resume it to send a message.');
    t.sessions.set('s1', codex({ releasing: true }));
    await expect(t.terminals.ensure('s1')).rejects.toThrow('The session has ended.');
    await expect(t.terminals.ensure('s2')).rejects.toThrow('The session is gone.');
    expect(t.calls).toEqual([]);

    t.sessions.set('s1', codex());
    t.noTurns();
    await expect(t.terminals.ensure('s1')).rejects.toThrow(NO_FIRST_TURN);
    t.lookup({ error: 'The terminal holder did not start: see holder.log' });
    await expect(t.terminals.ensure('s1')).rejects.toThrow('The terminal holder did not start: see holder.log');
    expect(t.spawns).toEqual([]);
    expect(noCodexTerminal(codex())).toBeNull();
  });

  it('ends a live terminal, and leaves alone a holder that is gone, an exited terminal and one the holder no longer holds', async () => {
    const t = setup();

    await t.terminals.end('s1');
    t.entries.push(entry('s1'));
    await t.terminals.end('s1');
    await t.terminals.end('s1');
    expect(t.calls).toEqual(['holder false', 'holder false', 'kill s1', 'holder false']);
    expect(t.logs).toEqual(['session s1: ended its Codex terminal']);

    t.lookup({ gone: true });
    await t.terminals.end('s1');
    t.lookup(null);
    t.entries.splice(0, 1, entry('s1'));
    t.failKill('No session s1 is held.');
    await t.terminals.end('s1');
    expect(t.terminals.unended('s1')).toBe(false);
    t.failKill('The terminal holder did not answer within 5 seconds.');
    await t.terminals.end('s1');
    expect(t.logs.slice(1)).toEqual(['session s1: ending its Codex terminal failed, so it may still run: The terminal holder did not answer within 5 seconds.']);
    // A failed end is remembered until one succeeds, so a later holder read can end the terminal again.
    expect(t.terminals.unended('s1')).toBe(true);
    t.lookup({ error: 'The terminal holder closed the connection.' });
    await t.terminals.end('s1');
    expect(t.terminals.unended('s1')).toBe(true);
    t.lookup(null);
    t.failKill(null);
    await t.terminals.end('s1');
    expect(t.terminals.unended('s1')).toBe(false);
  });

  it('runs an end asked for during a start after it, so the terminal the start made ends', async () => {
    const t = setup();
    const gate = t.holdSpawn();
    const ensured = t.terminals.ensure('s1');

    await gate.spawned;

    const ended = t.terminals.end('s1');

    await tick();
    expect(t.calls).toEqual(['holder true', 'spawn s1']);
    gate.open();
    await ensured;
    await ended;
    expect(t.calls).toEqual(['holder true', 'spawn s1', 'holder false', 'kill s1']);
    expect(t.entries).toEqual([entry('s1', true)]);
  });

  it('waits for an end of the session in progress, then refuses the session it ended', async () => {
    const t = setup();
    let finish = (): void => undefined;

    t.ends.set('s1', new Promise((done) => (finish = done)));

    const ensured = t.terminals.ensure('s1');

    await tick();
    expect(t.calls).toEqual([]);
    t.sessions.set('s1', codex({ state: 'ended', released: true }));
    t.ends.delete('s1');
    finish();
    await expect(ensured).rejects.toThrow('The session has ended.');
    expect(t.spawns).toEqual([]);
  });

  it('ends the terminal it started when the session ended or was resumed under another launch meanwhile', async () => {
    const t = setup();
    const gate = t.holdSpawn();
    const ensured = t.terminals.ensure('s1');

    await gate.spawned;
    t.sessions.set('s1', codex({ launchId: 'L2' }));
    gate.open();
    await expect(ensured).rejects.toThrow('The session was resumed; open the console again.');
    expect(t.calls).toEqual(['holder true', 'spawn s1', 'holder false', 'kill s1']);
  });
});
