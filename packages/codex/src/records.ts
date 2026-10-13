import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexPermissionMode } from '@switchboard/core';
import type { ProcessIdentity } from './processes.js';

/** The run record's format; a record of another version is not read, so its session ends at the next roster read. */
export const RUN_RECORD_VERSION = 2;

/** What the hub keeps about one Codex session's run, in `<switchboard home>/codex/<session id>.json`. */
export interface RunRecord {
  v: typeof RUN_RECORD_VERSION;
  sessionId: string;
  cwd: string;
  mode: CodexPermissionMode;
  model: string | null;
  /** The report contract, passed as developer instructions, because a compaction rebuilds them from config. */
  contract: string;
  threadId: string | null;
  /** When the run was spawned; a hook marker older than it is from an earlier process. */
  spawnedAt: number;
  /** The run's process; null between the record and the spawn, or when the spawn failed. */
  process: ProcessIdentity | null;
}

export function codexDir(home: string): string {
  return join(home, 'codex');
}

export function recordPath(home: string, sessionId: string): string {
  return join(codexDir(home), `${sessionId}.json`);
}

/** The stdout and stderr files of the session's run. */
export function runFiles(home: string, sessionId: string): { stdout: string; stderr: string } {
  const base = join(codexDir(home), sessionId);

  return { stdout: `${base}.jsonl`, stderr: `${base}.err` };
}

export function readRecord(home: string, sessionId: string): RunRecord | null {
  try {
    const record = JSON.parse(readFileSync(recordPath(home, sessionId), 'utf8')) as RunRecord;

    return record.v === RUN_RECORD_VERSION ? record : null;
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
