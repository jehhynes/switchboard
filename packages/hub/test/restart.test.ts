import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOf } from '../src/bundle.js';
import { clearHandover, handoverPath, HubRestart, installedBuild, pendingHandover, READY_MESSAGE, startSuccessor, TAKEOVER_WAIT_MS, writeHandover } from '../src/restart.js';
import type { RestartDeps, Successor } from '../src/restart.js';
import { tempHome, until } from './helpers.js';

let home: string;
let remove: () => void;

beforeEach(() => {
  ({ home, remove } = tempHome());
});

afterEach(() => {
  remove();
});

interface Fake {
  deps: RestartDeps;
  lines: string[];
  calls: string[];
  set(values: { installed?: string | null; quiet?: string | null; successor?: () => Promise<Successor | { error: string }> }): void;
}

function fake(): Fake {
  const lines: string[] = [];
  const calls: string[] = [];
  let installed: string | null = 'b2';
  let quiet: string | null = null;
  let successor = async (): Promise<Successor | { error: string }> => {
    calls.push('successor');
    return { pid: 42, cancel: () => calls.push('cancel') };
  };

  return {
    lines,
    calls,
    set: (values) => {
      installed = values.installed === undefined ? installed : values.installed;
      quiet = values.quiet === undefined ? quiet : values.quiet;
      successor = values.successor ?? successor;
    },
    deps: {
      build: 'b1',
      installed: () => installed,
      quiet: () => quiet,
      successor: () => successor(),
      handOver: async (successor) => void calls.push(successor.pid === 42 ? 'handOver' : `handOver to ${successor.pid}`),
      log: (line) => lines.push(line),
    },
  };
}

describe('HubRestart', () => {
  it('does nothing while no bundle is installed or the installed build is its own', async () => {
    const hub = fake();
    const restart = new HubRestart(hub.deps);

    hub.set({ installed: null });
    await restart.check();
    hub.set({ installed: 'b1' });
    await restart.check();

    expect(hub.calls).toEqual([]);
    expect(hub.lines).toEqual([]);
  });

  it('waits while the hub is not quiet, logging each reason once, then starts the successor and hands over', async () => {
    const hub = fake();
    const restart = new HubRestart(hub.deps);

    hub.set({ quiet: 'a session is starting' });
    await restart.check();
    await restart.check();
    hub.set({ quiet: 'a request is being answered' });
    await restart.check();

    expect(hub.calls).toEqual([]);

    hub.set({ quiet: null });
    await restart.check();

    expect(hub.calls).toEqual(['successor', 'handOver']);
    expect(hub.lines).toEqual([
      'hub restart onto build b2 waits: a session is starting',
      'hub restart onto build b2 waits: a request is being answered',
      'restarting the hub from build b1 onto build b2, which is installed',
    ]);

    // Handed over: later checks start nothing.
    await restart.check();
    expect(hub.calls).toEqual(['successor', 'handOver']);
  });

  it('keeps running when the successor does not start, and tries again only for another installed build', async () => {
    const hub = fake();
    const restart = new HubRestart(hub.deps);

    hub.set({ successor: async () => (hub.calls.push('successor'), { error: 'the new hub exited (code 1) before it was ready' }) });
    await restart.check();
    await restart.check();

    expect(hub.calls).toEqual(['successor']);
    expect(hub.lines.at(-1)).toBe('hub restart failed: the new hub exited (code 1) before it was ready; this hub keeps running');

    hub.set({ installed: 'b3' });
    await restart.check();

    expect(hub.calls).toEqual(['successor', 'successor']);
  });

  it('ends the successor and waits again when work started while it loaded', async () => {
    const hub = fake();
    const restart = new HubRestart(hub.deps);

    hub.set({
      successor: async () => {
        hub.calls.push('successor');
        hub.set({ quiet: 'a message is being sent' });
        return { pid: 42, cancel: () => hub.calls.push('cancel') };
      },
    });
    await restart.check();

    expect(hub.calls).toEqual(['successor', 'cancel']);
    expect(hub.lines.at(-1)).toBe('hub restart onto build b2 waits: a message is being sent');

    hub.set({ quiet: null, successor: async () => (hub.calls.push('successor'), { pid: 42, cancel: () => hub.calls.push('cancel') }) });
    await restart.check();

    expect(hub.calls).toEqual(['successor', 'cancel', 'successor', 'handOver']);
  });

  it('restarts when asked even onto its own build, answering what it waits for, and refuses with no bundle installed or once handed over', async () => {
    const hub = fake();
    const restart = new HubRestart(hub.deps);

    hub.set({ installed: null });
    expect(restart.request()).toEqual({ refused: 'No hub bundle is installed.' });

    hub.set({ installed: 'b1', quiet: 'a triage is running' });
    expect(restart.request()).toEqual({ installed: 'b1', waiting: 'a triage is running' });
    await restart.check();
    expect(hub.calls).toEqual([]);

    hub.set({ quiet: null });
    await restart.check();

    expect(hub.calls).toEqual(['successor', 'handOver']);
    expect(hub.lines).toEqual(['hub restart asked by hub.js restart', 'hub restart onto build b1 waits: a triage is running', 'restarting the hub from build b1 onto build b1, asked by hub.js restart']);
    expect(restart.request()).toEqual({ refused: 'The hub is already restarting.' });
  });

  it('runs one restart at a time', async () => {
    const hub = fake();
    const restart = new HubRestart(hub.deps);
    let ready: (successor: Successor) => void = () => {};

    hub.set({ successor: () => (hub.calls.push('successor'), new Promise((done) => (ready = done))) });

    const first = restart.check();

    await restart.check();
    ready({ pid: 42, cancel: () => hub.calls.push('cancel') });
    await first;

    expect(hub.calls).toEqual(['successor', 'handOver']);
  });
});

describe('installedBuild', () => {
  it('reads the installed bundle\'s build, null while it is missing, and again after it changes', () => {
    const bundle = join(home, '.switchboard', 'hub.js');
    const read = installedBuild(bundle);

    expect(read()).toBeNull();

    mkdirSync(join(home, '.switchboard'));
    writeFileSync(bundle, 'one');
    expect(read()).toBe(buildOf(bundle));

    const first = read();

    appendFileSync(bundle, ' two');
    expect(read()).toBe(buildOf(bundle));
    expect(read()).not.toBe(first);
  });
});

describe('startSuccessor', () => {
  const script = (body: string): string => {
    const path = join(home, 'successor.cjs');

    writeFileSync(path, body);
    return path;
  };

  it('starts the bundle with this hub\'s arguments and --takeover, and resolves once it reports ready', async () => {
    const argsFile = join(home, 'args.json');
    const bundle = script(`require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2))); process.send(${JSON.stringify(READY_MESSAGE)}, () => process.disconnect()); setTimeout(() => {}, 20000);`);
    const started = await startSuccessor({ execPath: process.execPath, bundle, args: ['--home=x', '--takeover=1'], env: process.env, logPath: join(home, 'hub.log') });

    expect('cancel' in started).toBe(true);
    expect(JSON.parse(readFileSync(argsFile, 'utf8'))).toEqual(['--home=x', `--takeover=${process.pid}`]);
    (started as Successor).cancel();
  });

  it('answers why when the successor exits before it is ready, or does not report in time', async () => {
    const crashing = script("process.stdout.write('broken bundle\\n'); process.exit(3);");
    const log = join(home, 'hub.log');

    expect(await startSuccessor({ execPath: process.execPath, bundle: crashing, args: [], env: process.env, logPath: log })).toEqual({ error: 'the new hub exited (code 3) before it was ready' });
    await until(() => (readFileSync(log, 'utf8').includes('broken bundle') ? true : null));

    const silent = script('setTimeout(() => {}, 20000);');

    expect(await startSuccessor({ execPath: process.execPath, bundle: silent, args: [], env: process.env, logPath: log, readyMs: 300 })).toEqual({ error: 'the new hub did not report ready within 0.3 seconds' });
  });
});

describe('handover', () => {
  it('names a successor while its handover is fresh and its process runs, and is removed only by that successor', () => {
    const at = 1_000_000;

    expect(pendingHandover(home, () => true, at)).toBeNull();

    mkdirSync(join(home, '.switchboard'));
    writeHandover(home, 4242, at);

    expect(pendingHandover(home, () => true, at + 1000)).toEqual({ pid: 4242 });
    expect(pendingHandover(home, () => false, at + 1000)).toBeNull();
    expect(pendingHandover(home, () => true, at + TAKEOVER_WAIT_MS)).toBeNull();

    // The check uses the real clock; a handover written now is fresh.
    writeHandover(home, 4242);
    clearHandover(home, 99);
    expect(readFileSync(handoverPath(home), 'utf8')).toContain('4242');
    clearHandover(home, 4242);
    expect(() => readFileSync(handoverPath(home), 'utf8')).toThrow();
  });
});
