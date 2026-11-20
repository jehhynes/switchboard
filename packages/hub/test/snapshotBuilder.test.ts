import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, Store } from '@switchboard/core';
import { dockView } from '../src/dock.js';
import { buildSnapshot } from '../src/snapshot.js';
import type { SnapshotInputs } from '../src/snapshot.js';
import { SnapshotBuilder } from '../src/snapshotBuilder.js';
import type { Built } from '../src/snapshotBuilder.js';

const WORKER = resolve(import.meta.dirname, '../dist/snapshotWorkerMain.js');
const T0 = Date.UTC(2026, 10, 19, 12);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'snapshot-builder-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const inputs = (): SnapshotInputs => ({
  settings: DEFAULT_SETTINGS,
  playbooks: [],
  settingsError: null,
  playbookErrors: [],
  enabled: [],
  sources: [],
  held: [],
  guarded: [],
  nodeError: null,
  hookErrors: { claude: null, codex: null },
  sourceErrors: {},
  sourceNotes: {},
  now: T0,
  configDir: 'C:/cfg',
});

function storeWithItem(path: string): Store {
  const store = Store.open(path);
  const ticket = store.insertTicket({ source: 'adhoc', sourceKey: '1', ref: '#1', sourceId: null, title: 'Built in a worker', url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' } as never);

  store.insertWorkItem({ ticketId: ticket.id, playbook: null, status: 'running', createdAt: T0 } as never);

  return store;
}

const until = async (test: () => boolean): Promise<void> => {
  for (const deadline = Date.now() + 10_000; !test(); ) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }

    await new Promise((done) => setTimeout(done, 20));
  }
};

describe('buildSnapshot', () => {
  it("counts the unread replies and status of a work item's latest Code Mode session, and none for another session", () => {
    const store = storeWithItem(':memory:');
    const session = (id: string, codeMode: boolean) =>
      store.insertSession({ id, workItemId: 1, kind: 'task', provider: 'claude', nativeSessionId: null, shortId: null, cwd: 'D:/w', state: 'running', stateAt: T0, stateDetail: null, outcome: null, outcomeDetail: null, startedAt: T0, endedAt: null, released: false, releasing: false, question: null, reports: [], retiredIds: [], pendingFork: null, external: false, move: null, movedAt: null, codeMode } as never);
    const reply = (id: string, sessionId: string) =>
      store.addReply({ id, sessionId, workItemId: 1, at: T0, kind: 'reply', answers: null, opening: id, source: 'transcript', replaces: null, rewrittenBy: null, withdrawn: false, transcriptUuid: null });

    session('old', true);
    reply('r-old', 'old');
    expect(buildSnapshot(store, inputs()).workItems[0]!.unread).toBe(1);

    // Only the latest session counts; an earlier one's replies are not in the window's view.
    session('new', true);
    reply('r1', 'new');
    reply('r2', 'new');
    store.setStatus({ id: 'st1', sessionId: 'new', workItemId: 1, replyId: 'r2', at: T0, markdown: 'x' });
    expect(buildSnapshot(store, inputs()).workItems[0]!.unread).toBe(3);
    store.markSeen('new', ['r1', 'st1'], T0);
    expect(buildSnapshot(store, inputs()).workItems[0]!.unread).toBe(1);
    expect(dockView(buildSnapshot(store, inputs()), T0, 'C:/w').groups.flatMap((group) => group.rows).find((row) => row.key === 'item:1')?.unread).toBe(1);

    // A background session has no conversation.
    session('background', false);
    expect(buildSnapshot(store, inputs()).workItems[0]!.unread).toBe(0);
  });
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
    builder.close();
  });

  it.runIf(existsSync(WORKER))('builds in a worker thread from a read-only store the same snapshot and dock view the main thread would', async () => {
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
    expect(logs).toEqual([]);
    builder.close();
    store.close();
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
    builder.close();
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
    builder.close();
  });

  it('answers an unreadable store with the error, which the main thread logs, and builds on demand on the main thread', async () => {
    const store = storeWithItem(':memory:');
    const logs: string[] = [];
    const builder = new SnapshotBuilder({
      inputs,
      inThread: (given) => ({ snapshot: buildSnapshot(store, given), dock: dockView(buildSnapshot(store, given), given.now, 'C:/w') }),
      onBuilt: () => undefined,
      worker: existsSync(WORKER) ? { script: WORKER, data: { kind: 'snapshot', db: join(dir, 'absent', 'x.db'), windows: 'C:/w' } } : null,
      now: Date.now,
      log: (line) => logs.push(line),
    });

    expect(builder.buildNow().snapshot.workItems).toHaveLength(1);
    expect(builder.dirty).toBe(false);

    if (existsSync(WORKER)) {
      builder.schedule();
      await until(() => logs.length > 0);
      expect(logs[0]).toMatch(/^snapshot build failed: /);
    }

    builder.close();
  });
});
