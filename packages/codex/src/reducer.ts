import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { LiveState } from '@switchboard/core';
import { codexMarkerState } from './hooks.js';
import type { CodexMarker } from './hooks.js';
import { failureMessage } from './log.js';
import type { RunLog } from './log.js';
import { sameProcess } from './processes.js';
import type { ProcessIdentity } from './processes.js';
import type { RunRecord } from './records.js';

/** How much of a rollout's end the reducer reads for the marker's turn (GC M55). */
export const ROLLOUT_TAIL_BYTES = 64 * 1024;

export type TurnEnd = { state: 'idle' } | { state: 'failed'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * How the turn ended, from the rollout's tail, or null while it runs. Codex fires no hook for a turn that fails on an API error;
 * its `task_complete` carries the error, and `turn_aborted` marks an interrupted turn (GC M55).
 */
export function turnEndOf(tail: string, turnId: string): TurnEnd | null {
  const lines = tail.split('\n');

  for (let index = lines.length - 1; index >= 0; index--) {
    let record: unknown;

    try {
      record = JSON.parse(lines[index]!);
    } catch {
      continue;
    }

    const payload = isRecord(record) && record['type'] === 'event_msg' && isRecord(record['payload']) ? record['payload'] : null;

    if (payload === null || payload['turn_id'] !== turnId) {
      continue;
    }

    switch (payload['type']) {
      case 'task_started':
        return null;
      case 'turn_aborted':
        return { state: 'idle' };
      case 'task_complete': {
        const error = payload['error'];

        return isRecord(error) && typeof error['message'] === 'string' ? { state: 'failed', message: failureMessage(error['message']) } : { state: 'idle' };
      }
    }
  }

  return null;
}

/** The last bytes of a file, or empty when it cannot be read. */
export function readTail(path: string, bytes = ROLLOUT_TAIL_BYTES): string {
  let fd: number;

  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }

  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);

    readSync(fd, buffer, 0, length, size - length);

    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

export interface ReducerInput {
  released: boolean;
  /** Whether the session reported a question it waits on. */
  question: boolean;
  record: RunRecord;
  /** The run's log. */
  log: RunLog;
  /** Whether the run's process, as the record names it, is alive. */
  runAlive: boolean;
  marker: CodexMarker | null;
  /** Whether the process the marker names is alive and is that process. */
  markerOwnerAlive: boolean;
  /** The rollout's end for the marker's turn, read only when the marker says the turn runs. */
  rolloutEnd(marker: CodexMarker): TurnEnd | null;
}

export type Reduced =
  | { listed: false }
  | {
      listed: true;
      state: LiveState;
      detail: string | null;
      interactive: boolean;
    };

function markerIdentity(marker: CodexMarker): ProcessIdentity | null {
  return marker.pid === null || marker.created === null ? null : { pid: marker.pid, created: marker.created };
}

function ended(log: RunLog): { state: LiveState; detail: string | null } | null {
  if (log.end === null) {
    return null;
  }

  return log.end.state === 'failed' ? { state: 'failed', detail: log.end.message } : { state: 'idle', detail: null };
}

/**
 * The one place that decides a Codex session's liveness and state, for the roster read and the marker pass alike, so the two never
 * disagree (mechanics M31):
 * 1. A live process other than the run's that wrote a marker since the run started is the operator's: interactive.
 * 2. A question whose turn has ended keeps the session waiting.
 * 3. A live run is running until its log holds the turn's end.
 * 4. A turn end is delivered once, before the session ends: listed until released.
 * 5. Otherwise the process is gone without a turn end, and the session has ended.
 */
export function reduce(input: ReducerInput): Reduced {
  const { record, log, marker } = input;
  const listed = (state: LiveState, detail: string | null, interactive = false): Reduced => ({ listed: true, state, detail, interactive });

  if (marker !== null && marker.at >= record.spawnedAt && input.markerOwnerAlive && !sameProcess(markerIdentity(marker), record.process)) {
    const state = codexMarkerState(marker) ?? 'idle';
    const end = state === 'running' ? input.rolloutEnd(marker) : null;

    return end === null ? listed(state, null, true) : end.state === 'failed' ? listed('failed', end.message, true) : listed('idle', null, true);
  }

  // The reporting turn has ended or its process is gone.
  if (input.question && (log.end !== null || !input.runAlive)) {
    return listed('waiting', null);
  }

  const end = ended(log);

  if (input.runAlive) {
    return end === null ? listed('running', null) : listed(end.state, end.detail);
  }

  if (end !== null && !input.released) {
    return listed(end.state, end.detail);
  }

  return { listed: false };
}
