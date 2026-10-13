import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failureMessage, lastErrorLine, parseRunLog } from '../src/log.js';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('parseRunLog', () => {
  it('reads the thread, the turn start and a completed turn, skipping the warning items', () => {
    expect(parseRunLog(fixture('exec-completed.jsonl'))).toEqual({ threadId: '01a128b1-5384-7b62-a7be-64a4b4c611a9', end: { state: 'idle' } });
  });

  it('reads a failed turn with the API error message unwrapped', () => {
    expect(parseRunLog(fixture('exec-failed.jsonl')).end).toEqual({ state: 'failed', message: "The 'no-such-model' model is not supported when using Codex with a ChatGPT account." });
  });

  it('reads a run in progress and skips a partial last line', () => {
    expect(parseRunLog('{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.started"}\n{"type":"turn.compl')).toEqual({ threadId: 't1', end: null });
    expect(parseRunLog('')).toEqual({ threadId: null, end: null });
    expect(parseRunLog('[1]\n{"type":"turn.failed","error":"no message"}').end).toEqual({ state: 'failed', message: 'unknown error' });
  });
});

describe('failureMessage', () => {
  it('keeps a message that is not the API error JSON', () => {
    expect(failureMessage('stream disconnected')).toBe('stream disconnected');
    expect(failureMessage('{"error":{"message":""}}')).toBe('{"error":{"message":""}}');
  });
});

describe('lastErrorLine', () => {
  it("gives Codex's refusal, not its stdin notice", () => {
    expect(lastErrorLine(fixture('exec-norepo.err'))).toBe('Not inside a trusted directory and --skip-git-repo-check was not specified.');
    expect(lastErrorLine('Reading additional input from stdin...\n')).toBeNull();
  });
});
