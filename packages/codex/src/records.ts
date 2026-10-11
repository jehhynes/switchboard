import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexPermissionMode } from '@switchboard/core';
import type { ProcessIdentity } from './processes.js';

/** An answer being sent to a waiting session: reserved before its process exists, then spawned, or failed (mechanics M31). */
export interface ReplyState {
  questionId: string;
  attempt: number;
  state: 'reserved' | 'spawned' | 'failed';
}

/**
 * What the hub keeps about one Codex session's runs, in `<switchboard home>/codex/<session id>.json`. Each start or reply is an
 * attempt with its own log, so a later attempt never reads an earlier attempt's events.
 */
export interface RunRecord {
  v: 1;
  sessionId: string;
  cwd: string;
  mode: CodexPermissionMode;
  model: string | null;
  /** The report contract, passed again with every resume, because a compaction rebuilds the developer instructions from config. */
  contract: string;
  threadId: string | null;
  attempt: number;
  /** When the current attempt was spawned; a hook marker older than it is from an earlier process. */
  attemptAt: number;
  /** The current attempt's process; null between the record and the spawn, or when the spawn failed. */
  process: ProcessIdentity | null;
  /** The attempt before the current one, while its process may still be exiting. */
  previous: ProcessIdentity | null;
  reply: ReplyState | null;
}

export function codexDir(home: string): string {
  return join(home, 'codex');
}

export function recordPath(home: string, sessionId: string): string {
  return join(codexDir(home), `${sessionId}.json`);
}

/** The stdout and stderr files of one attempt. */
export function attemptFiles(home: string, sessionId: string, attempt: number): { stdout: string; stderr: string } {
  const base = join(codexDir(home), `${sessionId}-${attempt}`);

  return { stdout: `${base}.jsonl`, stderr: `${base}.err` };
}

export function readRecord(home: string, sessionId: string): RunRecord | null {
  try {
    const record = JSON.parse(readFileSync(recordPath(home, sessionId), 'utf8')) as RunRecord;

    return record.v === 1 ? record : null;
  } catch {
    return null;
  }
}

/** Writes the record through a temporary file, so a reader never sees half of it. */
export function writeRecord(home: string, record: RunRecord): void {
  const path = recordPath(home, record.sessionId);
  const tmp = `${path}.${process.pid}.tmp`;

  mkdirSync(codexDir(home), { recursive: true });
  writeFileSync(tmp, JSON.stringify(record));

  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
