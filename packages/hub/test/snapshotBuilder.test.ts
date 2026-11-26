import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dockView } from '../src/dock.js';
import { buildSnapshot } from '../src/snapshot.js';
import { SnapshotBuilder } from '../src/snapshotBuilder.js';
import type { Built } from '../src/snapshotBuilder.js';
import { inputs, storeWithItem, T0, until } from './snapshotFixtures.js';


let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snapshot-builder-'));
});

afterEach(() => {
  // Windows can hold a file just closed for a moment longer, as its scanner reads it.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});


describe('SnapshotBuilder', () => {
  it('builds once for changes that come together, and again for a change during a build', async () => {
    const store = storeWithItem(':memory:');
    const built: Built[] = [];
    let reads = 0;
    const builder = new SnapshotBuilder({
      inputs: () => (reads++, inputs()),
      inThread: (given) => ({ snapshot: buildSnapshot(store, given), dock: dockView(buildSnapshot(store, given), given.now, 'C:/w') }),
      onBuilt: (one) => {
        built.push(one);

        if (built.length === 1) {
          builder.schedule();
        }
      },
      worker: null,
      now: () => T0,
      log: () => undefined,
    });

    expect(builder.inThread).toBe(true);
    builder.schedule();
    builder.schedule();
    builder.schedule();
    await until(() => built.length === 2);
    await new Promise((done) => setTimeout(done, 50));
    expect(built).toHaveLength(2);
    expect(reads).toBe(2);
    expect(built[0]!.snapshot.workItems.map((item) => item.ticket.title)).toEqual(['Built in a worker']);
    expect(builder.latest()).toBe(built[1]);
    await builder.close();
  });

  it('builds on the main thread once its worker fails, and says so once', async () => {
    const store = storeWithItem(':memory:');
    const built: Built[] = [];
    const logs: string[] = [];
    const builder = new SnapshotBuilder({
      inputs,
      inThread: (given) => ({ snapshot: buildSnapshot(store, given), dock: dockView(buildSnapshot(store, given), given.now, 'C:/w') }),
      onBuilt: (one) => built.push(one),
      worker: { script: join(dir, 'missing.js'), data: { kind: 'snapshot', db: join(dir, 'missing.db'), windows: 'C:/w' } },
      now: Date.now,
      log: (line) => logs.push(line),
    });

    builder.schedule();
    await until(() => built.length === 1);
    builder.schedule();
    await until(() => built.length === 2);
    expect(builder.inThread).toBe(true);
    expect(logs).toEqual([expect.stringMatching(/^snapshot worker failed, building on the main thread: /)]);
    await builder.close();
  });

  it('builds on the main thread a build a worker took and never answered, when the worker exits', async () => {
    const store = storeWithItem(':memory:');
    const script = join(dir, 'exits.cjs');
    const built: Built[] = [];

    // A worker that takes the request and exits without an answer.
    writeFileSync(script, "require('node:worker_threads').parentPort.on('message', () => process.exit(3));");

    const builder = new SnapshotBuilder({
      inputs,
      inThread: (given) => ({ snapshot: buildSnapshot(store, given), dock: dockView(buildSnapshot(store, given), given.now, 'C:/w') }),
      onBuilt: (one) => built.push(one),
      worker: { script, data: { kind: 'snapshot', db: join(dir, 'x.db'), windows: 'C:/w' } },
      now: Date.now,
      log: () => undefined,
    });

    builder.schedule();
    await until(() => built.length === 1);
    expect(built[0]!.snapshot.workItems).toHaveLength(1);
    builder.schedule();
    await until(() => built.length === 2);
    await builder.close();
  });
});
