import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ptyFactory } from '../src/nodePty.js';
import type { NodePtyModule } from '../src/nodePty.js';
import type { Pty } from '../src/host.js';

const OPTIONS = { cwd: 'D:/work', env: { A: '1' }, cols: 100, rows: 30 };

/** A node-pty terminal as the factory reads it: `pid`, `onExit`, and node-pty 1.2's agent output socket when `starting`. */
function fakePty(pid: number, starting: boolean) {
  const freed: string[] = [];
  const outSocket = Object.assign(new EventEmitter(), { destroy: () => freed.push('outSocket') });
  const inSocket = { destroy: () => freed.push('inSocket') };
  const exits = new Set<(exit: { exitCode: number }) => void>();
  const pty = {
    pid,
    onData: () => undefined,
    onExit: (listener: (exit: { exitCode: number }) => void) => (exits.add(listener), { dispose: () => exits.delete(listener) }),
    write: () => undefined,
    resize: () => undefined,
    ...(starting ? { _agent: { outSocket, _inSocket: inSocket, kill: () => freed.push('kill') } } : {}),
  };

  return { pty, outSocket, exits, freed, exit: (exitCode: number) => exits.forEach((listener) => listener({ exitCode })) };
}

function module(pty: unknown, calls: unknown[][] = []): NodePtyModule {
  return { spawn: (...args: unknown[]) => (calls.push(args), pty as Pty) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ptyFactory', () => {
  it('spawns with xterm-256color and the given size, folder and environment, and returns a started terminal at once', () => {
    const { pty } = fakePty(1234, false);
    const calls: unknown[][] = [];

    expect(ptyFactory(module(pty, calls))('claude', ['--x'], OPTIONS)).toBe(pty);
    expect(calls).toEqual([['claude', ['--x'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: 'D:/work', env: { A: '1' } }]]);
  });

  it('waits for node-pty 1.2 to start the program, then answers with its process ID and stops listening for an early exit', async () => {
    const fake = fakePty(0, true);
    const started = ptyFactory(module(fake.pty))('claude', [], OPTIONS);

    expect(started).toBeInstanceOf(Promise);
    fake.pty.pid = 4321;
    fake.outSocket.emit('ready_datapipe');
    expect((await started).pid).toBe(4321);
    expect(fake.exits.size).toBe(0);
  });

  it('refuses a program that ends before it starts with its exit code', async () => {
    const fake = fakePty(0, true);
    const started = ptyFactory(module(fake.pty))('claude', [], OPTIONS);

    fake.exit(267);
    await expect(started).rejects.toThrow('The program ended before it started (code 267).');
  });

  it('refuses a start that gives no process ID', async () => {
    const fake = fakePty(0, true);
    const started = ptyFactory(module(fake.pty))('claude', [], OPTIONS);

    fake.outSocket.emit('ready_datapipe');
    await expect(started).rejects.toThrow('node-pty started the program without a process ID.');
  });

  it('throws for a terminal with no process ID and no output socket to wait on', () => {
    expect(() => ptyFactory(module(fakePty(0, false).pty))('claude', [], OPTIONS)).toThrow('node-pty gave no process ID and no way to wait for one.');
  });

  it('throws the load error when node-pty could not be loaded', () => {
    expect(() => ptyFactory(new Error('Cannot find module conpty.node'))('claude', [], OPTIONS)).toThrow('Cannot find module conpty.node');
  });

  it("fails the start of a program whose output pipe fails before it connects, frees its terminal, and keeps the error from the process", async () => {
    const fake = fakePty(0, true);
    const started = ptyFactory(module(fake.pty))('claude', [], OPTIONS);

    // An error event with no listener would throw here.
    fake.outSocket.emit('error', new Error('pipe broken'));
    await expect(started).rejects.toThrow('Its output pipe failed: pipe broken');
    expect(fake.freed).toEqual(['kill', 'inSocket', 'outSocket']);
    expect(fake.exits.size).toBe(0);
    // A later ready or error changes nothing.
    fake.pty.pid = 99;
    fake.outSocket.emit('ready_datapipe');
    fake.outSocket.emit('error', new Error('again'));
    expect(fake.freed).toEqual(['kill', 'inSocket', 'outSocket']);
  });

  it("keeps an error of a started program's output pipe from the process, leaving it to node-pty's own listener", async () => {
    const fake = fakePty(0, true);
    const started = ptyFactory(module(fake.pty))('claude', [], OPTIONS);

    fake.pty.pid = 4321;
    fake.outSocket.emit('ready_datapipe');
    await started;
    expect(() => fake.outSocket.emit('error', new Error('late'))).not.toThrow();
    expect(fake.freed).toEqual([]);
  });

  it('fails the start of a program that never connects its output within the start time, frees its terminal, and lets it go', async () => {
    vi.useFakeTimers();

    const fake = fakePty(0, true);
    const started = ptyFactory(module(fake.pty), 15_000)('claude', [], OPTIONS);
    const outcome = Promise.resolve(started).then(
      () => 'started',
      (error: Error) => error.message,
    );

    await vi.advanceTimersByTimeAsync(14_999);
    expect(fake.freed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe('The program did not start within 15 seconds.');
    expect(fake.freed).toEqual(['kill', 'inSocket', 'outSocket']);
    expect(fake.exits.size).toBe(0);
  });

  it('frees the terminal of a program that ends before it starts, and of one started without a process ID', async () => {
    const ended = fakePty(0, true);
    const first = ptyFactory(module(ended.pty))('claude', [], OPTIONS);

    ended.exit(267);
    await expect(first).rejects.toThrow('(code 267)');
    expect(ended.freed).toEqual(['kill', 'inSocket', 'outSocket']);

    const nameless = fakePty(0, true);
    const second = ptyFactory(module(nameless.pty))('claude', [], OPTIONS);

    nameless.outSocket.emit('ready_datapipe');
    await expect(second).rejects.toThrow('without a process ID');
    expect(nameless.freed).toEqual(['kill', 'inSocket', 'outSocket']);
  });
});
