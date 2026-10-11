import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTRACT_HOOK_SOURCE, CONTRACT_HOOK_WAIT_MS, HOOK_EVENTS, HOOK_SOURCE, markerState, planHooks } from '../src/hooks.js';
import type { Marker } from '../src/hooks.js';

const HOOK = 'C:/Users/me/.switchboard/hook.mjs';
const ENTRY = { type: 'command', command: 'node', args: [HOOK], async: true, timeout: 5 };
const CONTRACT_HOOK = 'C:/Users/me/.switchboard/contract.mjs';
const CONTRACT_ENTRY = { type: 'command', command: 'node', args: [CONTRACT_HOOK], timeout: 10 };

describe('planHooks', () => {
  it('adds one entry per event to missing settings, and the synchronous contract hook after compaction', () => {
    const plan = planHooks(null, HOOK, CONTRACT_HOOK);
    const hooks = JSON.parse((plan as { text: string }).text).hooks;

    expect(Object.keys(hooks)).toEqual(HOOK_EVENTS.map(([event]) => event));
    expect(hooks.Stop).toEqual([{ hooks: [ENTRY] }]);
    expect(hooks.SessionStart).toEqual([{ hooks: [ENTRY] }, { matcher: 'compact', hooks: [CONTRACT_ENTRY] }]);
    expect(hooks.PreToolUse).toEqual([{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [ENTRY] }]);
  });

  it("keeps other settings and entries, including Ground Control's, and is unchanged once installed", () => {
    const gc = { hooks: [{ type: 'command', command: 'node', args: ['C:/Users/me/.ground-control/hook.mjs'], async: true, timeout: 5 }] };
    const existing = JSON.stringify({ model: 'opus', hooks: { Stop: [gc], PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] }] } });
    const first = planHooks(existing, HOOK, CONTRACT_HOOK) as { text: string };
    const settings = JSON.parse(first.text);

    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop).toEqual([gc, { hooks: [ENTRY] }]);
    expect(settings.hooks.PostToolUse).toEqual([{ matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] }, { matcher: 'AskUserQuestion|ExitPlanMode', hooks: [ENTRY] }]);
    expect(planHooks(first.text, HOOK, CONTRACT_HOOK)).toEqual({ unchanged: true });
  });

  it('adds only the missing entries', () => {
    const partial = { hooks: { Stop: [{ hooks: [ENTRY] }] } };
    const settings = JSON.parse((planHooks(JSON.stringify(partial), HOOK, CONTRACT_HOOK) as { text: string }).text);

    expect(settings.hooks.Stop).toEqual([{ hooks: [ENTRY] }]);
    expect(settings.hooks.SessionEnd).toEqual([{ hooks: [ENTRY] }]);

    // Settings written before the contract hook existed get it, once.
    const older = { hooks: Object.fromEntries(HOOK_EVENTS.map(([event, matcher]) => [event, [matcher === null ? { hooks: [ENTRY] } : { matcher, hooks: [ENTRY] }]])) };
    const upgraded = planHooks(JSON.stringify(older), HOOK, CONTRACT_HOOK) as { text: string };

    expect(JSON.parse(upgraded.text).hooks.SessionStart).toEqual([{ hooks: [ENTRY] }, { matcher: 'compact', hooks: [CONTRACT_ENTRY] }]);
    expect(planHooks(upgraded.text, HOOK, CONTRACT_HOOK)).toEqual({ unchanged: true });
  });

  it('refuses malformed settings', () => {
    expect(planHooks('{ "hooks": ', HOOK, CONTRACT_HOOK)).toEqual({ error: 'Claude settings.json is not valid JSON, so Switchboard did not add its hooks.' });
    expect(planHooks('{ "hooks": [] }', HOOK, CONTRACT_HOOK)).toEqual({ error: 'Claude settings.json has an unexpected shape, so Switchboard did not add its hooks.' });
    expect(planHooks('{ "hooks": { "Stop": {} } }', HOOK, CONTRACT_HOOK)).toEqual({ error: 'Claude settings.json has an unexpected hooks.Stop, so Switchboard did not add its hooks.' });
  });
});

describe('markerState', () => {
  const marker = (patch: Partial<Marker>): Marker => ({ sessionId: 's', event: null, notificationType: null, source: null, toolName: null, backgroundTasks: 0, error: null, errorMessage: null, ...patch });

  it.each([
    [{ event: 'UserPromptSubmit' }, { state: 'running', detail: null }],
    [{ event: 'PostToolBatch' }, { state: 'running', detail: null }],
    [{ event: 'PostToolUse', toolName: 'AskUserQuestion' }, { state: 'running', detail: null }],
    [{ event: 'PostToolUseFailure', toolName: 'ExitPlanMode' }, { state: 'running', detail: null }],
    [{ event: 'PostToolUse', toolName: 'Bash' }, null],
    [{ event: 'PermissionDenied' }, { state: 'running', detail: null }],
    [{ event: 'SessionStart', source: 'compact' }, { state: 'running', detail: null }],
    [{ event: 'SessionStart', source: 'startup' }, null],
    [{ event: 'PermissionRequest' }, { state: 'waiting', detail: null }],
    [{ event: 'Elicitation' }, { state: 'waiting', detail: null }],
    [{ event: 'PreToolUse', toolName: 'AskUserQuestion' }, { state: 'waiting', detail: null }],
    [{ event: 'PreToolUse', toolName: 'Bash' }, null],
    [{ event: 'Notification', notificationType: 'permission_prompt' }, { state: 'waiting', detail: null }],
    [{ event: 'Notification', notificationType: 'idle_prompt' }, null],
    [{ event: 'Stop' }, { state: 'idle', detail: null }],
    [{ event: 'Stop', backgroundTasks: 2 }, { state: 'running', detail: null }],
    [{ event: 'StopFailure', error: 'rate_limit', errorMessage: 'API Error' }, { state: 'failed', detail: 'rate_limit' }],
    [{ event: 'StopFailure', errorMessage: 'API Error' }, { state: 'failed', detail: 'API Error' }],
    [{ event: 'SessionEnd' }, null],
  ])('maps %j', (patch, expected) => {
    expect(markerState(marker(patch))).toEqual(expected);
  });
});

describe('hook writer', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switchboard-hook-'));
    writeFileSync(join(dir, 'hook.mjs'), HOOK_SOURCE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(payload: unknown, env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string } {
    const result = spawnSync(process.execPath, [join(dir, 'hook.mjs')], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', env });

    return { status: result.status, stdout: result.stdout };
  }

  const markerPath = () => join(dir, 'activity', 'abc-123.json');

  it('writes no marker for a debrief fork', () => {
    expect(run({ session_id: 'abc-123', hook_event_name: 'Stop' }, { ...process.env, FRICTION_DEBRIEF: '1' })).toEqual({ status: 0, stdout: '' });
    expect(existsSync(markerPath())).toBe(false);

    run({ session_id: 'abc-123', hook_event_name: 'Stop' }, { ...process.env, FRICTION_DEBRIEF: '' });
    expect(existsSync(markerPath())).toBe(true);
  });

  it('writes a marker, ignores subagent events, deletes it on SessionEnd, and always exits 0 silently', () => {
    expect(run({ session_id: 'abc-123', hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'x'.repeat(600), cwd: 'D:/x' })).toEqual({ status: 0, stdout: '' });

    const marker = JSON.parse(readFileSync(markerPath(), 'utf8'));
    expect(marker).toEqual({
      v: 1,
      sessionId: 'abc-123',
      event: 'StopFailure',
      at: expect.any(Number),
      notificationType: null,
      source: null,
      toolName: null,
      backgroundTasks: 0,
      error: 'rate_limit',
      errorMessage: 'x'.repeat(500),
    });

    run({ session_id: 'abc-123', agent_id: 'sub', hook_event_name: 'PostToolBatch' });
    expect(JSON.parse(readFileSync(markerPath(), 'utf8')).event).toBe('StopFailure');

    run({ session_id: 'abc-123', hook_event_name: 'Stop', background_tasks: [{}, {}] });
    expect(JSON.parse(readFileSync(markerPath(), 'utf8'))).toMatchObject({ event: 'Stop', backgroundTasks: 2, error: null, errorMessage: null });

    expect(run({ session_id: 'abc-123', hook_event_name: 'SessionEnd' })).toEqual({ status: 0, stdout: '' });
    expect(existsSync(markerPath())).toBe(false);

    expect(run('not json')).toEqual({ status: 0, stdout: '' });
    expect(run({ session_id: '../escape', hook_event_name: 'Stop' })).toEqual({ status: 0, stdout: '' });
    expect(existsSync(join(dir, 'escape.json'))).toBe(false);
  });
});

describe('contract hook', () => {
  let dir: string;
  let server: Server;
  let port: number;
  let requests: { authorization: string | undefined; path: string | undefined; body: unknown }[];
  // null holds the request open without an answer.
  let reply: { status: number; body: unknown } | null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'switchboard-contract-'));
    writeFileSync(join(dir, 'contract.mjs'), CONTRACT_HOOK_SOURCE);
    requests = [];
    reply = { status: 200, body: { contract: 'Report to Switchboard with these commands:\n- R stage s1 <stage>' } };
    server = createServer((request, response) => {
      let text = '';

      request.on('data', (chunk: Buffer) => (text += chunk.toString()));
      request.on('end', () => {
        requests.push({ authorization: request.headers.authorization, path: request.url, body: JSON.parse(text) });

        if (reply === null) {
          return;
        }

        response.writeHead(reply.status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
    writeFileSync(join(dir, 'hub.json'), JSON.stringify({ port, token: 't0k' }));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  });

  // Asynchronous, so the loopback server in this process can answer.
  function run(payload: unknown): Promise<{ status: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [join(dir, 'contract.mjs')]);
      let stdout = '';

      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.on('close', (status) => resolve({ status, stdout }));
      child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  }

  const compact = { session_id: 'native-1', hook_event_name: 'SessionStart', source: 'compact' };

  it("prints the hub's contract for the session as SessionStart context", async () => {
    const result = await run(compact);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Report to Switchboard with these commands:\n- R stage s1 <stage>' } });
    expect(requests).toEqual([{ authorization: 'Bearer t0k', path: '/contract', body: { nativeSessionId: 'native-1' } }]);
  });

  it('prints nothing and exits 0 for another session, a subagent, bad input, or a hub that is gone', async () => {
    reply = { status: 404, body: { error: 'No Switchboard session has this Claude session ID.' } };
    expect(await run(compact)).toEqual({ status: 0, stdout: '' });

    reply = { status: 200, body: { contract: 'C' } };
    expect(await run({ ...compact, agent_id: 'sub' })).toEqual({ status: 0, stdout: '' });
    expect(await run('not json')).toEqual({ status: 0, stdout: '' });
    expect(requests).toHaveLength(1);

    await new Promise((done) => server.close(done));
    expect(await run(compact)).toEqual({ status: 0, stdout: '' });
    server.listen(0, '127.0.0.1');

    rmSync(join(dir, 'hub.json'));
    expect(await run(compact)).toEqual({ status: 0, stdout: '' });
  });

  it("stops waiting for a hub that does not answer before Claude's 10-second hook timeout", async () => {
    reply = null;
    const started = Date.now();

    expect(await run(compact)).toEqual({ status: 0, stdout: '' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(CONTRACT_HOOK_WAIT_MS - 100);
    expect(Date.now() - started).toBeLessThan(9_000);
  }, 15_000);
});
