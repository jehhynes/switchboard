import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_HOOK_SOURCE, codexHookCommands, codexMarkerState, parseCodexMarker, planCodexHooks } from '../src/hooks.js';
import type { CodexMarker } from '../src/hooks.js';

const HOOK = 'C:/Users/operator/.switchboard/codex-hook.mjs';
const CONTRACT = 'C:/Users/operator/.switchboard/contract.mjs';

const marker = (patch: Partial<CodexMarker>): CodexMarker => ({ sessionId: 't1', event: null, at: 1, source: null, toolName: null, turnId: null, transcriptPath: null, pid: null, created: null, ...patch });

describe('codexMarkerState', () => {
  it('maps each hook event to the state it gives', () => {
    expect(['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].map((event) => codexMarkerState(marker({ event })))).toEqual(['running', 'running', 'running']);
    expect(codexMarkerState(marker({ event: 'SessionStart', source: 'compact' }))).toBe('running');
    expect(codexMarkerState(marker({ event: 'SessionStart', source: 'resume' }))).toBeNull();
    expect(codexMarkerState(marker({ event: 'PermissionRequest' }))).toBe('waiting');
    expect(codexMarkerState(marker({ event: 'Stop' }))).toBe('idle');
    expect(codexMarkerState(marker({ event: 'Interrupt' }))).toBeNull();
  });
});

describe('parseCodexMarker', () => {
  it("reads a Codex marker and leaves out Claude's markers and broken files", () => {
    const text = JSON.stringify({ v: 1, provider: 'codex', sessionId: 't1', event: 'Stop', at: 5, source: null, toolName: null, turnId: 'u1', transcriptPath: 'r.jsonl', pid: 7, created: '99' });

    expect(parseCodexMarker(text)).toEqual(marker({ event: 'Stop', at: 5, turnId: 'u1', transcriptPath: 'r.jsonl', pid: 7, created: '99' }));
    expect(parseCodexMarker(JSON.stringify({ v: 1, sessionId: 't1', event: 'Stop', at: 5 }))).toBeNull();
    expect(parseCodexMarker('{"provider":')).toBeNull();
    expect(parseCodexMarker(JSON.stringify({ provider: 'codex', sessionId: 't1' }))).toBeNull();
  });
});

describe('planCodexHooks', () => {
  const ours = (text: string) => JSON.parse(text) as { hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]> };

  it('adds synchronous entries for each event and the contract hook on SessionStart', () => {
    const plan = planCodexHooks(null, HOOK, CONTRACT, 'node');

    expect('text' in plan).toBe(true);
    const hooks = ours((plan as { text: string }).text).hooks;

    expect(Object.keys(hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SessionEnd']);
    expect(hooks['SessionStart']).toEqual([{ hooks: [{ type: 'command', command: `node "${HOOK}"`, timeout: 5 }] }, { hooks: [{ type: 'command', command: `node "${CONTRACT}"`, timeout: 10 }] }]);
    expect(hooks['SessionEnd']).toEqual([{ hooks: [{ type: 'command', command: `node "${HOOK}"`, timeout: 3 }] }]);
    expect(JSON.stringify(hooks)).not.toContain('async');
  });

  it("keeps the operator's hooks before Switchboard's and reports a file that is complete", () => {
    const theirs = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node support.js', timeout: 10 }] }] }, other: true };
    const plan = planCodexHooks(`\uFEFF${JSON.stringify(theirs)}`, HOOK, CONTRACT, 'node') as { text: string };
    const hooks = ours(plan.text);

    expect(hooks.hooks['Stop']).toEqual([theirs.hooks.Stop[0], { hooks: [{ type: 'command', command: `node "${HOOK}"`, timeout: 5 }] }]);
    expect((JSON.parse(plan.text) as { other: boolean }).other).toBe(true);
    expect(planCodexHooks(plan.text, HOOK, CONTRACT, 'node')).toEqual({ unchanged: true });
  });

  it('replaces an earlier Switchboard entry with other settings in its place', () => {
    const old = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${HOOK}"`, async: true, timeout: 5 }] }, { hooks: [{ type: 'command', command: 'node support.js' }] }] } };
    const hooks = ours((planCodexHooks(JSON.stringify(old), HOOK, CONTRACT, 'node') as { text: string }).text).hooks;

    expect(hooks['Stop']).toEqual([{ hooks: [{ type: 'command', command: `node "${HOOK}"`, timeout: 5 }] }, { hooks: [{ type: 'command', command: 'node support.js' }] }]);
  });

  it("updates only Switchboard's entry in a group it shares, keeping the other entries and the group's settings", () => {
    const shared = { hooks: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'node other.js' }, { type: 'command', command: `node "${HOOK}"`, timeout: 9 }] }] } };
    const hooks = ours((planCodexHooks(JSON.stringify(shared), HOOK, CONTRACT, 'node') as { text: string }).text).hooks;

    expect(hooks['Stop']).toEqual([{ matcher: 'x', hooks: [{ type: 'command', command: 'node other.js' }, { type: 'command', command: `node "${HOOK}"`, timeout: 5 }] }]);
  });

  it('gives an entry of Switchboard\'s a new sessions.nodePath in place, and adds no second entry', () => {
    const node = 'C:/nodejs/node.exe';
    const installed = (planCodexHooks(null, HOOK, CONTRACT, 'node') as { text: string }).text;
    const moved = planCodexHooks(installed, HOOK, CONTRACT, node) as { text: string };
    const hooks = ours(moved.text).hooks;

    expect(codexHookCommands(HOOK, CONTRACT, node)).toEqual({ hook: `${node} "${HOOK}"`, contract: `${node} "${CONTRACT}"` });
    expect(hooks['SessionStart']).toEqual([{ hooks: [{ type: 'command', command: `${node} "${HOOK}"`, timeout: 5 }] }, { hooks: [{ type: 'command', command: `${node} "${CONTRACT}"`, timeout: 10 }] }]);
    expect(hooks['Stop']).toHaveLength(1);
    expect(planCodexHooks(moved.text, HOOK, CONTRACT, node)).toEqual({ unchanged: true });
  });

  it("leaves the operator's entries that name Switchboard's script but do not run it with Node.js, and adds its own", () => {
    const check = { type: 'command', command: `sha256sum "${HOOK}"` };
    const shell = { type: 'command', command: `bash -c node "${HOOK}"` };
    const hooks = ours((planCodexHooks(JSON.stringify({ hooks: { Stop: [{ hooks: [check] }, { hooks: [shell] }] } }), HOOK, CONTRACT, 'node') as { text: string }).text).hooks;

    expect(hooks['Stop']).toEqual([{ hooks: [check] }, { hooks: [shell] }, { hooks: [{ type: 'command', command: `node "${HOOK}"`, timeout: 5 }] }]);
  });

  it('leaves a file it cannot read as hooks alone', () => {
    expect(planCodexHooks('{ not json', HOOK, CONTRACT, 'node')).toEqual({ error: 'Codex hooks.json is not valid JSON, so Switchboard left it alone.' });
    expect(planCodexHooks('[]', HOOK, CONTRACT, 'node')).toEqual({ error: 'Codex hooks.json is not a JSON object, so Switchboard left it alone.' });
    expect(planCodexHooks('{"hooks": 3}', HOOK, CONTRACT, 'node')).toEqual({ error: 'The hooks entry of Codex hooks.json is not an object, so Switchboard left it alone.' });
    expect(planCodexHooks('{"hooks": {"Stop": {}}}', HOOK, CONTRACT, 'node')).toEqual({ error: 'The Stop entry of Codex hooks.json is not a list, so Switchboard left it alone.' });
  });
});

describe('the hook script', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switchboard-codex-hook-'));
    writeFileSync(join(dir, 'codex-hook.mjs'), CODEX_HOOK_SOURCE);
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
    symlinkSync('/bin/sh', join(dir, 'codex'));
    writeFileSync(join(dir, 'payload.json'), JSON.stringify({ session_id: 't1', hook_event_name: 'UserPromptSubmit' }));
    const shell = spawn(join(dir, 'codex'), ['-c', `"${process.execPath}" codex-hook.mjs < payload.json; true`], { cwd: dir, stdio: 'ignore' });
    const created = await new Promise<string>((done) => shell.once('spawn', () => done(readFileSync(`/proc/${shell.pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[19]!)));

    expect(await new Promise((done) => shell.once('exit', done))).toBe(0);
    expect(read()).toMatchObject({ event: 'UserPromptSubmit', pid: shell.pid, created });
  });

  it('writes nothing for a debrief fork, a malformed ID or a payload that is not JSON, and still exits 0', () => {
    expect(run({ session_id: 't1', hook_event_name: 'Stop' }, { FRICTION_DEBRIEF: '1' }).status).toBe(0);
    expect(run({ session_id: '../t1', hook_event_name: 'Stop' }).status).toBe(0);
    expect(spawnSync(process.execPath, [join(dir, 'codex-hook.mjs')], { input: 'not json', encoding: 'utf8' }).status).toBe(0);
    expect(existsSync(join(dir, 'activity'))).toBe(false);
  });
});
