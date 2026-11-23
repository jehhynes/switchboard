import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearStopped, holdSupervisorLock, HubSupervisor, readStopped, restartDelay, SUPERVISE_GRACE_MS, SUPERVISE_STABLE_MS, stopSupervisor, stoppedPath, supervisorAddress, supervisorTokenPath, writeStopped } from '../src/supervise.js';
import type { StoppedRecord, SuperviseDeps } from '../src/supervise.js';
import { answers, switchboardHome } from '@switchboard/core';
import { tempHome, until } from './helpers.js';

/** A hub lock, handover and stop record that `script` sets for each time, on a clock each check moves on by a second. */
interface World {
  locked: boolean;
  handover: boolean;
  stopped: StoppedRecord | null;
  starts: number[];
  lines: string[];
}

/** Runs a supervisor for `forMs` of simulated time; `script` sets the world before each check. */
async function simulate(forMs: number, script: (state: World, now: number) => void, deps: Partial<SuperviseDeps> = {}): Promise<World> {
  const state: World = { locked: false, handover: false, stopped: null, starts: [], lines: [] };
  let clock = 0;
  const supervisor: HubSupervisor = new HubSupervisor({
    hubLocked: async () => (script(state, clock), state.locked),
    handover: () => state.handover,
    stopped: () => state.stopped,
    start: () => {
      state.starts.push(clock);
      return null;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;

      if (clock >= forMs) {
        supervisor.stop();
      }
    },
    log: (line) => state.lines.push(line),
    checkMs: 1_000,
    ...deps,
  });

  await supervisor.run();

  return state;
}

describe('HubSupervisor', () => {
  it('leaves the first start to the login start for the grace period, then starts a hub once and none while one holds the lock', async () => {
    const state = await simulate(60_000, (world, now) => (world.locked = world.starts.length > 0 && now > world.starts[0]!));

    expect(state.starts).toEqual([SUPERVISE_GRACE_MS]);
    expect(state.lines).toEqual(['no hub is running; starting one']);
  });

  it('starts no hub during the grace period once one has been seen, and starts one again at once when it has gone', async () => {
    const state = await simulate(4_000, (world, now) => (world.locked = now < 3_000));

    expect(state.starts).toEqual([3_000]);
    expect(state.lines).toEqual(['the hub stopped without hub.js --stop; starting it again (start 1 since it last ran steadily)']);
  });

  it('never starts a hub while any process holds the lock or a restart hands over, nor after a deliberate stop, until another start has taken the lock', async () => {
    const state = await simulate(100_000, (world, now) => {
      world.locked = now < 1_000 || (now >= 80_000 && now < 81_000);
      world.handover = now >= 1_000 && now < 10_000;
      // Taking the lock clears the record.
      world.stopped = now >= 10_000 && now < 80_000 ? { pid: 42, at: 0, reason: 'a client asked it to stop' } : null;
    });

    // That hub never takes the lock in this script, so it is started again after the wait.
    expect(state.starts).toEqual([81_000, 91_000]);
    // Each reason is logged once.
    expect(state.lines.slice(0, 2)).toEqual(['the hub is handing over to a new build; waiting for the new hub', 'the hub (pid 42) was stopped on purpose (a client asked it to stop); not starting it until something else does']);
  });

  it('waits longer before each start while the hub keeps failing, and starts at once again after it ran steadily', async () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(restartDelay)).toEqual([0, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);

    // Each started hub fails before it takes the lock, until the lock is taken at 1,000 seconds and held for the steady time.
    const steadyFrom = 1_000_000;
    const state = await simulate(steadyFrom + SUPERVISE_STABLE_MS + 5_000, (world, now) => (world.locked = now < 1_000 || (now >= steadyFrom && now < steadyFrom + SUPERVISE_STABLE_MS)));
    const failing = state.starts.filter((at) => at < steadyFrom);
    const gaps = failing.slice(1).map((at, index) => at - failing[index]!);

    expect(gaps).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    expect(state.lines).toContain('the hub is not running; starting it again 20 seconds after the last start');
    expect(state.starts.filter((at) => at >= steadyFrom)).toEqual([steadyFrom + SUPERVISE_STABLE_MS]);
  });

  it('logs why a hub could not start and counts it as a start', async () => {
    const state = await simulate(20_000, () => {}, { start: () => 'no hub is installed in /x/hub.js', graceMs: 0 });

    expect(state.lines[0]).toBe('could not start the hub: no hub is installed in /x/hub.js');
    expect(state.lines.filter((line) => line.startsWith('could not start'))).toHaveLength(2);
  });

  it('ends when stopped while it waits', async () => {
    let wake: (() => void) | null = null;
    const supervisor = new HubSupervisor({ hubLocked: async () => true, handover: () => false, stopped: () => null, start: () => null, now: () => 0, sleep: () => new Promise<void>((done) => (wake = done)), log: () => {} });
    const finished = supervisor.run();

    await until(() => wake);
    supervisor.stop();
    // The sleep never ends by itself.
    await finished;
  });
});

describe('stop record and supervisor lock', () => {
  let home: string;
  let remove: () => void;

  beforeEach(() => {
    ({ home, remove } = tempHome());
  });

  afterEach(() => remove());

  it('reads back a stop record, ignores a malformed one, and clears it', () => {
    mkdirSync(switchboardHome(home), { recursive: true });
    expect(readStopped(home)).toBeNull();
    writeFileSync(stoppedPath(home), '{"pid":"x"}');
    expect(readStopped(home)).toBeNull();
    writeStopped(home, 'received SIGTERM', 123);
    expect(readStopped(home)).toEqual({ pid: process.pid, at: 123, reason: 'received SIGTERM' });
    clearStopped(home);
    expect(existsSync(stoppedPath(home))).toBe(false);
  });

  it('holds one supervisor lock per home, which a stop line ends, and says when none runs', async () => {
    let asked = 0;
    const lock = await holdSupervisorLock(home, () => {
      asked += 1;
      lock!.close();
    });

    expect(lock).not.toBeNull();
    expect(await holdSupervisorLock(home, () => {})).toBeNull();
    expect(await answers(supervisorAddress(home))).toBe(true);
    // A connection that sends no stop line, such as the lock check, or a stop line without the token, which another account could send, stops nothing.
    await new Promise<void>((done) => {
      const socket = createConnection(supervisorAddress(home), () => socket.write('stop\n'));

      socket.on('error', () => done());
      socket.on('close', () => done());
    });
    expect(asked).toBe(0);
    expect(readFileSync(supervisorTokenPath(home), 'utf8')).toMatch(/^[0-9a-f]{48}$/);
    expect(await stopSupervisor(home)).toBe(true);
    expect(asked).toBe(1);
    expect(await stopSupervisor(home)).toBe(false);
  });

  it('names a pipe beside the hub lock on Windows and an abstract socket, which no file outlives, on Linux, one per home', () => {
    expect(supervisorAddress('C:\\Users\\me', 'win32')).toMatch(/^\\\\\.\\pipe\\switchboard-[0-9a-f]{16}-supervisor$/);
    expect(supervisorAddress('/home/me', 'linux')).toMatch(/^\0switchboard-supervisor-[0-9a-f]{16}$/);
    expect(supervisorAddress('/home/other', 'linux')).not.toBe(supervisorAddress('/home/me', 'linux'));
  });

  it('leaves one supervisor holding the lock when several start at once', async () => {
    const locks = await Promise.all(Array.from({ length: 8 }, () => holdSupervisorLock(home, () => {})));
    const held = locks.filter((one) => one !== null);

    try {
      expect(held).toHaveLength(1);
    } finally {
      held.forEach((one) => one!.close());
    }
  });

  it('fails when the supervisor does not stop in time', async () => {
    const lock = await holdSupervisorLock(home, () => {});

    try {
      await expect(stopSupervisor(home, 300)).rejects.toThrow(`the supervisor on ${supervisorAddress(home)} did not stop within 0.3 seconds`);
    } finally {
      lock!.close();
    }
  });
});
