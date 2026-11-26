import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_HOOK_SOURCE } from '../src/hooks.js';

describe('the hook script', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switchboard-codex-hook-'));
    writeFileSync(join(dir, 'codex-hook.mjs'), CODEX_HOOK_SOURCE);
    // The run record of Switchboard's session on thread t1, as writeRecord leaves it.
    mkdirSync(join(dir, 'codex'));
    writeFileSync(join(dir, 'codex', 's1.json'), JSON.stringify({ v: 2, sessionId: 's1', threadId: 't1' }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (payload: unknown, env: Record<string, string> = {}) => spawnSync(process.execPath, [join(dir, 'codex-hook.mjs')], { input: JSON.stringify(payload), env: { ...process.env, ...env }, encoding: 'utf8' });
  const read = () => JSON.parse(readFileSync(join(dir, 'activity', 't1.json'), 'utf8')) as Record<string, unknown>;

  it('writes the marker, keeps the process it found for the turn, prints nothing and removes the marker at the end', () => {
    const first = run({ session_id: 't1', hook_event_name: 'UserPromptSubmit', turn_id: 'u1', transcript_path: 'r.jsonl' });

    expect(first.status).toBe(0);
    expect(first.stdout).toBe('');
    expect(read()).toMatchObject({ v: 1, provider: 'codex', sessionId: 't1', event: 'UserPromptSubmit', turnId: 'u1', transcriptPath: 'r.jsonl' });

    // A later event of the turn keeps the recorded process instead of walking the process tree again.
    mkdirSync(join(dir, 'activity'), { recursive: true });
    writeFileSync(join(dir, 'activity', 't1.json'), JSON.stringify({ ...read(), pid: 4242, created: '777' }));
    run({ session_id: 't1', hook_event_name: 'Stop', turn_id: 'u1' });
    expect(read()).toMatchObject({ event: 'Stop', pid: 4242, created: '777' });

    run({ session_id: 't1', hook_event_name: 'SessionEnd' });
    expect(existsSync(join(dir, 'activity', 't1.json'))).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('records the nearest ancestor named codex with its /proc start time', async () => {
    // A shell started as `codex` is named codex, and runs the hook as its child because a command follows it.
    // In bin/, since codex/ holds the run records.
    mkdirSync(join(dir, 'bin'));
    symlinkSync('/bin/sh', join(dir, 'bin', 'codex'));
    writeFileSync(join(dir, 'payload.json'), JSON.stringify({ session_id: 't1', hook_event_name: 'UserPromptSubmit' }));
    const shell = spawn(join(dir, 'bin', 'codex'),['-c', `"${process.execPath}" codex-hook.mjs < payload.json; true`], { cwd: dir, stdio: 'ignore' });
    const created = await new Promise<string>((done) => shell.once('spawn', () => done(readFileSync(`/proc/${shell.pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[19]!)));

    expect(await new Promise((done) => shell.once('exit', done))).toBe(0);
    expect(read()).toMatchObject({ event: 'UserPromptSubmit', pid: shell.pid, created });
  });

  it("writes nothing for a thread no run record names, such as another tool's Codex session", () => {
    // The thread's run log names it too, but only a record counts.
    writeFileSync(join(dir, 'codex', 's2.jsonl'), '{"type":"thread.started","thread_id":"t2"}\n"threadId":"t2"\n');

    expect(run({ session_id: 't2', hook_event_name: 'UserPromptSubmit', turn_id: 'u1' }).status).toBe(0);
    expect(run({ session_id: 't2', hook_event_name: 'Stop', turn_id: 'u1' }).status).toBe(0);
    expect(existsSync(join(dir, 'activity'))).toBe(false);

    rmSync(join(dir, 'codex'), { recursive: true });
    expect(run({ session_id: 't1', hook_event_name: 'Stop', turn_id: 'u1' }).status).toBe(0);
    expect(existsSync(join(dir, 'activity'))).toBe(false);
  });

  it('writes nothing for a debrief fork, a malformed ID or a payload that is not JSON, and still exits 0', () => {
    expect(run({ session_id: 't1', hook_event_name: 'Stop' }, { FRICTION_DEBRIEF: '1' }).status).toBe(0);
    expect(run({ session_id: '../t1', hook_event_name: 'Stop' }).status).toBe(0);
    expect(spawnSync(process.execPath, [join(dir, 'codex-hook.mjs')], { input: 'not json', encoding: 'utf8' }).status).toBe(0);
    expect(existsSync(join(dir, 'activity'))).toBe(false);
  });
});
