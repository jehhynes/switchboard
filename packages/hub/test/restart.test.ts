import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOf } from '../src/bundle.js';
import { HubRestart, installedBuild, READY_MESSAGE, startSuccessor } from '../src/restart.js';
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
    return { cancel: () => calls.push('cancel') };
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
      handOver: async () => void calls.push('handOver'),
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
        return { cancel: () => hub.calls.push('cancel') };
      },
    });
    await restart.check();

    expect(hub.calls).toEqual(['successor', 'cancel']);
    expect(hub.lines.at(-1)).toBe('hub restart onto build b2 waits: a message is being sent');

    hub.set({ quiet: null, successor: async () => (hub.calls.push('successor'), { cancel: () => hub.calls.push('cancel') }) });
    await restart.check();

    expect(hub.calls).toEqual(['successor', 'cancel', 'successor', 'handOver']);
  });

  it('runs one restart at a time', async () => {
    const hub = fake();
    const restart = new HubRestart(hub.deps);
    let ready: (successor: Successor) => void = () => {};

    hub.set({ successor: () => (hub.calls.push('successor'), new Promise((done) => (ready = done))) });

    const first = restart.check();

    await restart.check();
    ready({ cancel: () => hub.calls.push('cancel') });
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
