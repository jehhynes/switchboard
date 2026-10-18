import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exec, ExecResult } from '@switchboard/core';
import { codexDebriefRange, codexScopeOf, findRollout, runCodexDebrief } from '../src/debrief.js';

const ran = (patch: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...patch });
const line = (type: string, payload: object) => JSON.stringify({ type, payload });
const started = (id: string) => line('event_msg', { type: 'task_started', turn_id: id });
const completed = (id: string) => line('event_msg', { type: 'task_complete', turn_id: id });
const user = (text: string) => line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const tool = (type = 'function_call') => line('response_item', { type });

describe('findRollout', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'switchboard-rollout-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("finds the thread's rollout by its name in the day folders, and nothing for another thread or no sessions folder", () => {
    expect(findRollout(home, 't-1')).toBeNull();

    for (const day of ['2026/10/05', '2026/10/06']) {
      mkdirSync(join(home, 'sessions', day), { recursive: true });
    }

    writeFileSync(join(home, 'sessions', '2026/10/05', 'rollout-2026-10-05T10-00-00-t-1.jsonl'), '{}');
    writeFileSync(join(home, 'sessions', '2026/10/06', 'rollout-2026-10-06T10-00-00-t-2.jsonl'), '{}');

    expect(findRollout(home, 't-1')).toMatchObject({ path: join(home, 'sessions', '2026/10/05', 'rollout-2026-10-05T10-00-00-t-1.jsonl'), writtenAt: expect.any(Number) });
    expect(findRollout(home, 't-3')).toBeNull();
  });
});

describe('codexDebriefRange', () => {
  const text = [
    line('session_meta', { id: 't-1' }),
    started('u1'),
    user('# AGENTS.md instructions\nRead them.'),
    user('Plan it'),
    tool(),
    tool('custom_tool_call'),
    tool('local_shell_call'),
    tool('function_call_output'),
    completed('u1'),
    started('u2'),
    user('<environment_context>x</environment_context>'),
    user('Build   it\nnow'),
    tool(),
    completed('u2'),
    started('u3'),
    tool(),
    'not json',
  ].join('\n');

  it('counts tool calls through the last completed turn, and names a later range by its first prompt', () => {
    const whole = codexDebriefRange(text, null)!;

    expect(whole).toEqual({ throughTurnId: 'u2', toolCalls: 4, fromPrompt: null });
    expect(codexScopeOf(whole)).toBe('the whole conversation');
    const later = codexDebriefRange(text, 'u1')!;

    expect(later).toEqual({ throughTurnId: 'u2', toolCalls: 1, fromPrompt: 'Build it now' });
    expect(codexScopeOf(later)).toBe('the work after the user message that begins "Build it now"');
  });

  it('skips the context Codex adds as user messages, such as the panel\'s, in a recorded thread resumed in the VS Code panel', () => {
    const recorded = readFileSync(join(import.meta.dirname, 'fixtures', 'rollout-panel.jsonl'), 'utf8');

    expect(codexDebriefRange(recorded, null)).toEqual({ throughTurnId: '01a128b8-4713-7cb2-a9f0-e82528f2d986', toolCalls: 0, fromPrompt: null });
    expect(codexDebriefRange(recorded, '01a128b3-82ff-7a01-b252-4d9284626149')).toMatchObject({ fromPrompt: 'Reply with exactly: panel-ok' });
    expect(codexDebriefRange(recorded, '01a128b3-1d05-7370-8563-2f54295b7e61')).toMatchObject({ fromPrompt: 'Reply with exactly: ok' });
  });

  it("keeps an operator's prompt that is wrapped in a tag of its own", () => {
    const wrapped = [started('u1'), user('Plan'), completed('u1'), started('u2'), user('<task>Fix the failing tests</task>'), tool(), completed('u2')].join('\n');

    expect(codexDebriefRange(wrapped, 'u1')).toMatchObject({ throughTurnId: 'u2', fromPrompt: '<task>Fix the failing tests</task>' });
  });

  it('takes the whole thread when the last debriefed turn is not in it, and nothing when no turn after it has completed', () => {
    expect(codexDebriefRange(text, 'gone')).toMatchObject({ throughTurnId: 'u2', fromPrompt: null });
    expect(codexDebriefRange(text, 'u2')).toBeNull();
    expect(codexDebriefRange('', null)).toBeNull();
  });
});

describe('runCodexDebrief', () => {
  const input = { codexPath: 'codex', threadId: 't-1', cwd: 'D:/w', prompt: 'Report friction.', env: { FRICTION_DEBRIEF: '1' }, timeoutMs: 1000 };
  const answer = (text: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });

  it('forks with the prompt on stdin and gives its last message', async () => {
    const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: [answer('Thinking.'), answer('{"friction":[]}'), '{"type":"turn.completed"}'].join('\n') }));

    expect(await runCodexDebrief(input, exec)).toEqual({ text: '{"friction":[]}' });
    expect(exec).toHaveBeenCalledWith('codex', ['exec', 'fork', '--json', '--ephemeral', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', 't-1', '-'], { cwd: 'D:/w', stdin: 'Report friction.', env: { FRICTION_DEBRIEF: '1' }, timeoutMs: 1000 });
  });

  it("runs an absolute Codex path with its directory first on PATH, for the node an nvm install keeps beside it", async () => {
    const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: answer('{"friction":[]}') }));
    const codexPath = join(tmpdir(), 'nvm', 'bin', 'codex');

    await runCodexDebrief({ ...input, codexPath }, exec);

    const env = exec.mock.calls[0]![2].env!;
    const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')!;
    expect(env[key]!.split(delimiter)[0]).toBe(join(tmpdir(), 'nvm', 'bin'));
    expect(env['FRICTION_DEBRIEF']).toBe('1');
  });

  it("reports a missing CLI, a timeout, a failed turn, Codex's refusal and a fork with no answer", async () => {
    const run = (result: ExecResult) => runCodexDebrief(input, vi.fn<Exec>().mockResolvedValue(result));

    expect(await runCodexDebrief({ ...input, cwd: tmpdir() }, vi.fn<Exec>().mockResolvedValue(ran({ missing: true, code: null })))).toEqual({
      error: 'Codex was not found at codex. Install it or set sessions.codexPath.',
    });
    const gone = join(tmpdir(), 'switchboard-no-such-dir');
    expect(await runCodexDebrief({ ...input, cwd: gone }, vi.fn<Exec>().mockResolvedValue(ran({ missing: true, code: null })))).toEqual({ error: `The session's directory ${gone} was not found.` });
    expect(await run(ran({ timedOut: true }))).toEqual({ error: 'The Codex debrief did not finish within 1 seconds.' });
    expect(await run(ran({ code: 1, stdout: '{"type":"turn.failed","error":{"message":"quota"}}' }))).toEqual({ error: 'quota' });
    expect(await run(ran({ code: 1, stderr: 'No thread t-1.\n' }))).toEqual({ error: 'No thread t-1.' });
    expect(await run(ran({ stdout: '[1]' }))).toEqual({ error: 'codex exec fork exited with code 0 and no answer.' });
  });
});
