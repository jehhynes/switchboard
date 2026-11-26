import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dockView } from '../src/dock.js';
import { buildSnapshot } from '../src/snapshot.js';
import { SnapshotBuilder } from '../src/snapshotBuilder.js';
import type { Built } from '../src/snapshotBuilder.js';
import { inputs, storeWithItem, T0, until } from './snapshotFixtures.js';

const WORKER = resolve(import.meta.dirname, '../dist/snapshotWorkerMain.js');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snapshot-builder-'));
});

afterEach(() => {
  // Windows can hold a file just closed for a moment longer, as its scanner reads it.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('SnapshotBuilder', () => {
  it('builds in a worker thread from a read-only store the same snapshot and dock view the main thread would', async () => {
    const path = join(dir, 'switchboard.db');
    const store = storeWithItem(path);
    const built: Built[] = [];
    const logs: string[] = [];
    const builder = new SnapshotBuilder({
      inputs,
      inThread: () => {
        throw new Error('built on the main thread');
      },
      onBuilt: (one) => built.push(one),
      worker: { script: WORKER, data: { kind: 'snapshot', db: path, windows: 'C:/w' } },
      now: Date.now,
      log: (line) => logs.push(line),
    });

    expect(builder.inThread).toBe(false);
    builder.schedule();
    await until(() => built.length === 1);
    expect(built[0]!.snapshot).toEqual(JSON.parse(JSON.stringify(buildSnapshot(store, inputs()))));
    expect(built[0]!.dock).toEqual(JSON.parse(JSON.stringify(dockView(buildSnapshot(store, inputs()), T0, 'C:/w'))));
    // What the worker read, as the store holds it.
    expect(built[0]!.snapshot.workItems.map((item) => [item.id, item.ticket.title, item.status])).toEqual([[1, 'Built in a worker', 'running']]);
    expect(built[0]!.dock.groups.flatMap((group) => group.rows).map((row) => [row.key, row.title])).toEqual([['item:1', 'Built in a worker']]);
    expect(logs).toEqual([]);
    await builder.close();
    store.close();
  });

  it('answers an unreadable store with the error, which the main thread logs, and builds on demand on the main thread', async () => {
    const store = storeWithItem(':memory:');
    const logs: string[] = [];
    const builder = new SnapshotBuilder({
      inputs,
      inThread: (given) => ({ snapshot: buildSnapshot(store, given), dock: dockView(buildSnapshot(store, given), given.now, 'C:/w') }),
      onBuilt: () => undefined,
      worker: { script: WORKER, data: { kind: 'snapshot', db: join(dir, 'absent', 'x.db'), windows: 'C:/w' } },
      now: Date.now,
      log: (line) => logs.push(line),
    });

    expect(builder.buildNow().snapshot.workItems).toHaveLength(1);
    expect(builder.dirty).toBe(false);

    builder.schedule();
    await until(() => logs.length > 0);
    expect(logs[0]).toMatch(/^snapshot build failed: /);

    await builder.close();
  });
});
