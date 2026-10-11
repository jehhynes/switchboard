import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { LiveState } from '@switchboard/core';
import { codexMarkerState } from './hooks.js';
import type { CodexMarker } from './hooks.js';
import { failureMessage } from './log.js';
import type { AttemptLog } from './log.js';
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
  /** The question the session reported and waits on, by ID, or null. */
  question: string | null;
  record: RunRecord;
  /** The current attempt's log. */
  log: AttemptLog;
  /** Whether the current attempt's process, as the record names it, is alive. */
  attemptAlive: boolean;
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
      /** The question whose reply has started, which the runtime acknowledges before it applies the state. */
      acknowledge: string | null;
    };

function markerIdentity(marker: CodexMarker): ProcessIdentity | null {
  return marker.pid === null || marker.created === null ? null : { pid: marker.pid, created: marker.created };
}

function ended(log: AttemptLog): { state: LiveState; detail: string | null } | null {
  if (log.end === null) {
    return null;
  }

  return log.end.state === 'failed' ? { state: 'failed', detail: log.end.message } : { state: 'idle', detail: null };
}

/**
 * The one place that decides a Codex session's liveness and state, for the roster read and the marker pass alike, so the two never
 * disagree (mechanics M31):
 * 1. A live process other than the current attempt's that wrote a marker since the attempt started is the operator's: interactive.
 * 2. A question whose turn has ended keeps the session waiting until a reply for it starts its turn.
 * 3. A live attempt runs until its log holds the turn's end.
 * 4. A turn end is delivered once, before the session ends: listed until released.
 * 5. Otherwise the process is gone without a turn end, and the session has ended.
 */
export function reduce(input: ReducerInput): Reduced {
  const { record, log, marker } = input;
  const listed = (state: LiveState, detail: string | null, interactive = false, acknowledge: string | null = null): Reduced => ({ listed: true, state, detail, interactive, acknowledge });

  if (marker !== null && marker.at >= record.attemptAt && input.markerOwnerAlive && !sameProcess(markerIdentity(marker), record.process)) {
    const state = codexMarkerState(marker) ?? 'idle';
    const end = state === 'running' ? input.rolloutEnd(marker) : null;

    return end === null ? listed(state, null, true) : end.state === 'failed' ? listed('failed', end.message, true) : listed('idle', null, true);
  }

  let acknowledge: string | null = null;

  if (input.question !== null) {
    const reply = record.reply?.questionId === input.question ? record.reply : null;
    const replyStarted = reply !== null && reply.state === 'spawned' && reply.attempt === record.attempt && log.turnStarted;

    if (replyStarted) {
      acknowledge = input.question;
    } else if (reply !== null || log.end !== null || !input.attemptAlive) {
      // The reporting turn has ended, and no reply has started a turn: reserved, spawning, failed or gone.
      return listed('waiting', null);
    }
  }

  const end = ended(log);

  if (input.attemptAlive) {
    return end === null ? listed('running', null, false, acknowledge) : listed(end.state, end.detail, false, acknowledge);
  }

  if (end !== null && !input.released) {
    return listed(end.state, end.detail, false, acknowledge);
  }

  return { listed: false };
}
