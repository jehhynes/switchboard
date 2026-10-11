import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodexMarker } from '../src/hooks.js';
import type { AttemptLog } from '../src/log.js';
import type { RunRecord } from '../src/records.js';
import { readTail, reduce, turnEndOf } from '../src/reducer.js';
import type { ReducerInput } from '../src/reducer.js';

const ROLLOUT = readFileSync(join(import.meta.dirname, 'fixtures', 'rollout-failed.jsonl'), 'utf8');
const FAILED_TURN = '01a128bc-0ea9-7db2-b40c-05026520c232';

const RUN = { pid: 10, created: '100' };
const PANEL = { pid: 20, created: '200' };

const record = (patch: Partial<RunRecord> = {}): RunRecord => ({
  v: 1,
  sessionId: 's1',
  cwd: 'D:/git/widgets',
  mode: 'bypassPermissions',
  model: null,
  contract: 'c',
  threadId: 't1',
  attempt: 1,
  attemptAt: 1_000,
  process: RUN,
  previous: null,
  reply: null,
  ...patch,
});

const RUNNING: AttemptLog = { threadId: 't1', turnStarted: true, end: null };
const COMPLETED: AttemptLog = { threadId: 't1', turnStarted: true, end: { state: 'idle' } };
const FAILED: AttemptLog = { threadId: 't1', turnStarted: true, end: { state: 'failed', message: 'boom' } };

const marker = (patch: Partial<CodexMarker> = {}): CodexMarker => ({ sessionId: 't1', event: 'UserPromptSubmit', at: 2_000, source: null, toolName: null, turnId: 'u1', transcriptPath: 'r', ...PANEL, ...patch });

const input = (patch: Partial<ReducerInput> = {}): ReducerInput => ({
  released: false,
  question: null,
  record: record(),
  log: RUNNING,
  attemptAlive: true,
  marker: null,
  markerOwnerAlive: false,
  rolloutEnd: () => null,
  ...patch,
});

const listed = (state: string, detail: string | null = null, interactive = false, acknowledge: string | null = null) => ({ listed: true, state, detail, interactive, acknowledge });

describe('reduce: background runs', () => {
  it('runs while the attempt lives, and gives the turn end once the log holds it, even while the process exits', () => {
    expect(reduce(input())).toEqual(listed('running'));
    expect(reduce(input({ log: COMPLETED }))).toEqual(listed('idle'));
    expect(reduce(input({ log: FAILED }))).toEqual(listed('failed', 'boom'));
  });

  it('delivers a turn end first seen after the process exited, until the session is released', () => {
    expect(reduce(input({ attemptAlive: false, log: COMPLETED }))).toEqual(listed('idle'));
    expect(reduce(input({ attemptAlive: false, log: FAILED }))).toEqual(listed('failed', 'boom'));
    expect(reduce(input({ attemptAlive: false, log: COMPLETED, released: true }))).toEqual({ listed: false });
  });

  it('ends a session whose process is gone without a turn end', () => {
    expect(reduce(input({ attemptAlive: false }))).toEqual({ listed: false });
  });
});

describe('reduce: the operator resumed the thread elsewhere', () => {
  it('takes a live other process that wrote since the attempt began as interactive, whatever released says', () => {
    expect(reduce(input({ marker: marker(), markerOwnerAlive: true, attemptAlive: false, log: COMPLETED }))).toEqual(listed('running', null, true));
    expect(reduce(input({ marker: marker({ event: 'Stop' }), markerOwnerAlive: true, released: true, attemptAlive: false }))).toEqual(listed('idle', null, true));
    expect(reduce(input({ marker: marker({ event: 'PermissionRequest' }), markerOwnerAlive: true }))).toEqual(listed('waiting', null, true));
    expect(reduce(input({ marker: marker({ event: 'SessionStart', source: 'resume' }), markerOwnerAlive: true }))).toEqual(listed('idle', null, true));
  });

  it('ends a running marker by the rollout, so a failed turn is not left running', () => {
    expect(reduce(input({ marker: marker(), markerOwnerAlive: true, rolloutEnd: () => ({ state: 'failed', message: 'quota' }) }))).toEqual(listed('failed', 'quota', true));
    expect(reduce(input({ marker: marker(), markerOwnerAlive: true, rolloutEnd: () => ({ state: 'idle' }) }))).toEqual(listed('idle', null, true));
  });

  it("ignores the run's own marker, an older marker and a dead writer", () => {
    expect(reduce(input({ marker: marker({ ...RUN }), markerOwnerAlive: true }))).toEqual(listed('running'));
    expect(reduce(input({ marker: marker({ at: 999 }), markerOwnerAlive: true }))).toEqual(listed('running'));
    expect(reduce(input({ marker: marker(), markerOwnerAlive: false }))).toEqual(listed('running'));
  });

  it('takes the operator over a pending question', () => {
    expect(reduce(input({ question: 'q1', attemptAlive: false, log: COMPLETED, marker: marker(), markerOwnerAlive: true }))).toEqual(listed('running', null, true));
  });
});

describe('reduce: questions', () => {
  it('waits once the reporting turn has ended, and not before', () => {
    expect(reduce(input({ question: 'q1' }))).toEqual(listed('running'));
    expect(reduce(input({ question: 'q1', log: COMPLETED }))).toEqual(listed('waiting'));
    expect(reduce(input({ question: 'q1', log: COMPLETED, attemptAlive: false, released: true }))).toEqual(listed('waiting'));
    expect(reduce(input({ question: 'q1', attemptAlive: false }))).toEqual(listed('waiting'));
  });

  it('keeps waiting through a reply that is reserved, spawning, failed or gone', () => {
    const reserved = record({ reply: { questionId: 'q1', attempt: 2, state: 'reserved' } });
    const spawning = record({ attempt: 2, reply: { questionId: 'q1', attempt: 2, state: 'spawned' } });
    const failed = record({ attempt: 2, reply: { questionId: 'q1', attempt: 2, state: 'failed' } });

    expect(reduce(input({ question: 'q1', record: reserved, log: COMPLETED }))).toEqual(listed('waiting'));
    expect(reduce(input({ question: 'q1', record: spawning, log: { threadId: null, turnStarted: false, end: null } }))).toEqual(listed('waiting'));
    expect(reduce(input({ question: 'q1', record: failed, attemptAlive: false, log: { threadId: null, turnStarted: false, end: null } }))).toEqual(listed('waiting'));
  });

  it("acknowledges a reply whose turn started, and then follows that attempt's state", () => {
    const spawned = record({ attempt: 2, reply: { questionId: 'q1', attempt: 2, state: 'spawned' } });

    expect(reduce(input({ question: 'q1', record: spawned }))).toEqual(listed('running', null, false, 'q1'));
    expect(reduce(input({ question: 'q1', record: spawned, log: COMPLETED, attemptAlive: false }))).toEqual(listed('idle', null, false, 'q1'));
    // A reply for an earlier question does not answer this one.
    expect(reduce(input({ question: 'q2', record: spawned, log: COMPLETED }))).toEqual(listed('waiting'));
  });
});

describe('turnEndOf and readTail', () => {
  it("reads the failed turn's error from a recorded rollout, and nothing for another turn", () => {
    expect(turnEndOf(ROLLOUT, FAILED_TURN)).toEqual({ state: 'failed', message: "The 'no-such-model' model is not supported when using Codex with a ChatGPT account." });
    expect(turnEndOf(ROLLOUT, 'other')).toBeNull();
  });

  it('reads a started turn as running, an aborted one and a clean completion as ended', () => {
    const line = (payload: object) => JSON.stringify({ type: 'event_msg', payload });

    expect(turnEndOf([line({ type: 'task_started', turn_id: 'u1' })].join('\n'), 'u1')).toBeNull();
    expect(turnEndOf(['garbage', line({ type: 'turn_aborted', turn_id: 'u1' })].join('\n'), 'u1')).toEqual({ state: 'idle' });
    expect(turnEndOf(line({ type: 'task_complete', turn_id: 'u1', error: null }), 'u1')).toEqual({ state: 'idle' });
  });

  it('reads the end of a file and nothing from a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchboard-tail-'));

    try {
      writeFileSync(join(dir, 'r.jsonl'), 'abcdef');
      expect(readTail(join(dir, 'r.jsonl'), 3)).toBe('def');
      expect(readTail(join(dir, 'missing.jsonl'))).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
