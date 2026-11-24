import { Worker } from 'node:worker_threads';
import type { DockView } from './dock.js';
import type { Snapshot, SnapshotInputs } from './snapshot.js';
import type { SnapshotReply, SnapshotRequest, SnapshotWorkerData } from './snapshotWorker.js';

/** A build: the snapshot, the list view built from it, and how long the main thread waited for it. */
export interface Built {
  snapshot: Snapshot;
  dock: DockView;
  ms: number;
}

export interface SnapshotBuilderOptions {
  /** The runtime's inputs, read when each build starts, so a build reflects every change before it. */
  inputs(): SnapshotInputs;
  /** Builds on the main thread, when there is no worker script or the worker failed. */
  inThread(inputs: SnapshotInputs): { snapshot: Snapshot; dock: DockView };
  /** Called with each finished build, which a window then gets whole. */
  onBuilt(built: Built): void;
  /** The worker's script and data; null builds on the main thread. */
  worker: { script: string; data: SnapshotWorkerData } | null;
  now(): number;
  log(line: string): void;
}

/**
 * Builds the snapshot in a worker thread, one build at a time, so the main thread stays free for conversation events and the store's reads never
 * block it (architecture.md § Hub lifecycle). A change during a build asks for one more build after it. A worker that fails is replaced by
 * builds on the main thread, logged once.
 */
export class SnapshotBuilder {
  #worker: Worker | null = null;
  #building = false;
  /** A change came that no published build reflects yet. */
  #dirty = false;
  /** A change came since the latest build began, published or built on demand. */
  #stale = false;
  #nextId = 1;
  #latest: Built | null = null;
  #closed = false;
  #failed = false;
  /** Builds the worker has not answered, by request ID; a worker that fails settles them on the main thread. */
  readonly #pending = new Map<number, { inputs: SnapshotInputs; resolve: (built: Omit<Built, 'ms'>) => void; reject: (error: Error) => void }>();

  constructor(private readonly options: SnapshotBuilderOptions) {
    if (options.worker !== null) {
      this.#start(options.worker);
    }
  }

  /** Whether builds run on the main thread. */
  get inThread(): boolean {
    return this.#worker === null;
  }

  /** The latest build, or null before the first. */
  latest(): Built | null {
    return this.#latest;
  }

  /** Whether a change came since the latest build began. */
  get dirty(): boolean {
    return this.#stale || this.#latest === null;
  }

  /** Builds now on the main thread and publishes it, for callers that need a current view before the next build lands. */
  buildNow(): Built {
    const started = this.options.now();
    const built = { ...this.options.inThread(this.options.inputs()), ms: 0 };

    built.ms = this.options.now() - started;
    this.#stale = false;
    this.#latest = built;

    return built;
  }

  /** Asks for a build; builds that are asked for during one run once after it. */
  schedule(): void {
    if (this.#closed) {
      return;
    }

    this.#dirty = true;
    this.#stale = true;

    if (!this.#building) {
      this.#building = true;
      setImmediate(() => void this.#run());
    }
  }

  /** Stops building; resolves once the worker has ended and so closed its read-only store. */
  async close(): Promise<void> {
    const worker = this.#worker;

    this.#closed = true;
    this.#worker = null;
    await worker?.terminate();
  }

  async #run(): Promise<void> {
    while (this.#dirty && !this.#closed) {
      this.#dirty = false;
      this.#stale = false;

      const started = this.options.now();
      let built: Omit<Built, 'ms'>;

      try {
        built = await this.#build(this.options.inputs());
      } catch (error) {
        this.options.log(`snapshot build failed: ${String(error)}`);
        continue;
      }

      if (this.#closed) {
        break;
      }

      this.#latest = { ...built, ms: this.options.now() - started };
      this.options.onBuilt(this.#latest);
    }

    this.#building = false;
  }

  #build(inputs: SnapshotInputs): Promise<Omit<Built, 'ms'>> {
    const worker = this.#worker;

    if (worker === null) {
      return Promise.resolve(this.options.inThread(inputs));
    }

    const id = this.#nextId++;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { inputs, resolve, reject });
      worker.postMessage({ id, inputs } satisfies SnapshotRequest);
    });
  }

  #reply(reply: SnapshotReply): void {
    const pending = this.#pending.get(reply.id);

    if (pending === undefined) {
      return;
    }

    this.#pending.delete(reply.id);

    if ('error' in reply) {
      pending.reject(new Error(reply.error));
    } else {
      pending.resolve({ snapshot: JSON.parse(reply.snapshot) as Snapshot, dock: JSON.parse(reply.dock) as DockView });
    }
  }

  #start(worker: { script: string; data: SnapshotWorkerData }): void {
    try {
      this.#worker = new Worker(worker.script, { workerData: worker.data });
      this.#worker.unref();
      this.#worker.on('message', (reply: SnapshotReply) => this.#reply(reply));
      this.#worker.on('error', (error) => this.#fail(error));
      this.#worker.on('exit', (code) => {
        if (!this.#closed) {
          this.#fail(new Error(`it exited with code ${code}`));
        }
      });
    } catch (error) {
      this.#fail(error as Error);
    }
  }

  #fail(error: Error): void {
    if (!this.#failed) {
      this.#failed = true;
      this.options.log(`snapshot worker failed, building on the main thread: ${error.message}`);
    }

    void this.#worker?.terminate();
    this.#worker = null;

    // Builds the worker took and will not answer are built here, so the next build is not held back.
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);

      try {
        pending.resolve(this.options.inThread(pending.inputs));
      } catch (failed) {
        pending.reject(failed as Error);
      }
    }
  }
}
