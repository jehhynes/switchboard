import { parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { Store } from '@switchboard/core';
import { dockView } from './dock.js';
import { buildSnapshot } from './snapshot.js';
import type { SnapshotInputs } from './snapshot.js';

/** Data the hub gives the snapshot worker when it starts it. */
export interface SnapshotWorkerData {
  kind: 'snapshot';
  /** The store's database, which the worker opens read-only. */
  db: string;
  /** The folder of the item windows' workspace files, which the list view names. */
  windows: string;
}

export interface SnapshotRequest {
  id: number;
  inputs: SnapshotInputs;
}

/** The snapshot and the list view (`dockView`) as JSON, which the main thread parses once, or why the build failed. */
export type SnapshotReply = { id: number; snapshot: string; dock: string } | { id: number; error: string };

/** Answers each request on the port with a snapshot built from a read-only store and the inputs it carries. */
export function serveSnapshots(port: Pick<MessagePort, 'on' | 'postMessage'>, data: SnapshotWorkerData): void {
  let store: Store | null = null;

  port.on('message', (request: SnapshotRequest) => {
    try {
      store ??= Store.openReadOnly(data.db);

      const reader = store;
      // One read transaction, so a commit on the main thread between two queries cannot mix two states.
      const snapshot = reader.readTransaction(() => buildSnapshot(reader, request.inputs));

      port.postMessage({ id: request.id, snapshot: JSON.stringify(snapshot), dock: JSON.stringify(dockView(snapshot, request.inputs.now, data.windows)) } satisfies SnapshotReply);
    } catch (error) {
      port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies SnapshotReply);
    }
  });
}

/** Whether this thread is the hub's snapshot worker, which the hub bundle runs as its own worker script. */
export function isSnapshotWorker(): boolean {
  return parentPort !== null && (workerData as Partial<SnapshotWorkerData> | null)?.kind === 'snapshot';
}

/** The snapshot worker's entry. */
export function runSnapshotWorker(): void {
  serveSnapshots(parentPort!, workerData as SnapshotWorkerData);
}
