// The snapshot worker as a script of its own, for the tsc build; the hub bundle runs itself as the worker instead.
import { runSnapshotWorker } from './snapshotWorker.js';

runSnapshotWorker();
