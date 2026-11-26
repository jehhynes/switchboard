import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTRACT_HOOK_SOURCE, CONTRACT_HOOK_WAIT_MS, contractHookSource, HOOK_SOURCE } from '../src/hooks.js';

/** The test's environment without the variables the hook reads, so a run inside a Switchboard session's terminal, which sets SWITCHBOARD_LAUNCH, gives the same result. */
const HOOK_ENV: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['SWITCHBOARD_LAUNCH', 'FRICTION_DEBRIEF'].includes(name.toUpperCase())));

describe('hook writer', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switchboard-hook-'));
    writeFileSync(join(dir, 'hook.mjs'), HOOK_SOURCE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(payload: unknown, env: NodeJS.ProcessEnv = HOOK_ENV): { status: number | null; stdout: string } {
    const result = spawnSync(process.execPath, [join(dir, 'hook.mjs')], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', env });

    return { status: result.status, stdout: result.stdout };
  }

  const markerPath = () => join(dir, 'activity', 'abc-123.json');

  it("carries a permission request's tool to the permission_prompt notification that replaces its marker (mechanics M57)", () => {
    const written = () => JSON.parse(readFileSync(markerPath(), 'utf8'));

    run({ session_id: 'abc-123', hook_event_name: 'PermissionRequest', tool_name: 'PowerShell' });
    expect(written()).toMatchObject({ event: 'PermissionRequest', toolName: 'PowerShell', promptTool: 'PowerShell' });
    run({ session_id: 'abc-123', hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    expect(written()).toMatchObject({ event: 'Notification', toolName: null, promptTool: 'PowerShell' });
    run({ session_id: 'abc-123', hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    expect(written().promptTool).toBe('PowerShell');

    // A permission request written before the writer recorded promptTool still gives its tool.
    writeFileSync(markerPath(), JSON.stringify({ v: 1, sessionId: 'abc-123', event: 'PermissionRequest', at: 1, toolName: 'Bash' }));
    run({ session_id: 'abc-123', hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    expect(written().promptTool).toBe('Bash');

    // A notification after any other event, or with no marker, carries none.
    run({ session_id: 'abc-123', hook_event_name: 'PostToolBatch' });
    expect(written().promptTool).toBeNull();
    run({ session_id: 'abc-123', hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    expect(written().promptTool).toBeNull();
    run({ session_id: 'abc-123', hook_event_name: 'SessionEnd' });
    run({ session_id: 'abc-123', hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    expect(written().promptTool).toBeNull();
  });

  it("records a Code Mode process's launch, and keeps a clear, fork or resume start source across later events of the session ID (mechanics M73, M77)", () => {
    const written = () => JSON.parse(readFileSync(markerPath(), 'utf8'));
    const held = { ...HOOK_ENV, SWITCHBOARD_LAUNCH: 'launch-1' };

    run({ session_id: 'abc-123', hook_event_name: 'SessionStart', source: 'startup' }, held);
    expect(written()).toMatchObject({ event: 'SessionStart', launch: 'launch-1', startSource: null });
    run({ session_id: 'abc-123', hook_event_name: 'SessionStart', source: 'clear' }, held);
    run({ session_id: 'abc-123', hook_event_name: 'UserPromptSubmit' }, held);
    run({ session_id: 'abc-123', hook_event_name: 'Stop' }, held);
    expect(written()).toMatchObject({ event: 'Stop', launch: 'launch-1', startSource: 'clear' });

    // Compaction keeps the session ID, so it keeps how the ID began.
    run({ session_id: 'abc-123', hook_event_name: 'SessionStart', source: 'compact' }, held);
    expect(written()).toMatchObject({ event: 'SessionStart', source: 'compact', startSource: 'clear' });
    run({ session_id: 'abc-123', hook_event_name: 'SessionStart', source: 'startup' }, held);
    expect(written()).toMatchObject({ startSource: null });

    for (const source of ['fork', 'resume']) {
      run({ session_id: 'abc-123', hook_event_name: 'SessionStart', source }, held);
      run({ session_id: 'abc-123', hook_event_name: 'PostToolBatch' }, held);
      expect(written()).toMatchObject({ event: 'PostToolBatch', startSource: source });
    }
  });

  it('records no launch or start source for a session without SWITCHBOARD_LAUNCH', () => {
    const env = { ...HOOK_ENV };

    delete env['SWITCHBOARD_LAUNCH'];
    run({ session_id: 'abc-123', hook_event_name: 'SessionStart', source: 'clear' }, env);
    run({ session_id: 'abc-123', hook_event_name: 'Stop' }, { ...env, SWITCHBOARD_LAUNCH: '' });

    const marker = JSON.parse(readFileSync(markerPath(), 'utf8'));

    expect('launch' in marker).toBe(false);
    expect('startSource' in marker).toBe(false);
  });

  it('writes no marker for a debrief fork', () => {
    expect(run({ session_id: 'abc-123', hook_event_name: 'Stop' }, { ...HOOK_ENV, FRICTION_DEBRIEF: '1' })).toEqual({ status: 0, stdout: '' });
    expect(existsSync(markerPath())).toBe(false);

    run({ session_id: 'abc-123', hook_event_name: 'Stop' }, { ...HOOK_ENV, FRICTION_DEBRIEF: '' });
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
      cwd: 'D:/x',
      notificationType: null,
      source: null,
      toolName: null,
      promptTool: null,
      backgroundTasks: 0,
      backgroundTypes: [],
      error: 'rate_limit',
      errorMessage: 'x'.repeat(500),
    });

    run({ session_id: 'abc-123', agent_id: 'sub', hook_event_name: 'PostToolBatch' });
    expect(JSON.parse(readFileSync(markerPath(), 'utf8')).event).toBe('StopFailure');

    run({ session_id: 'abc-123', hook_event_name: 'Stop', background_tasks: [{}, {}] });
    expect(JSON.parse(readFileSync(markerPath(), 'utf8'))).toMatchObject({ event: 'Stop', backgroundTasks: 2, backgroundTypes: ['unknown', 'unknown'], error: null, errorMessage: null });

    // As Claude Code 2.1.330 lists them (mechanics M124).
    run({ session_id: 'abc-123', hook_event_name: 'Stop', background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'sleeper', agent_type: 'general-purpose' }, { id: 'b1', type: 'shell', status: 'running', description: 'Sleep', command: 'sleep 25' }] });
    expect(JSON.parse(readFileSync(markerPath(), 'utf8'))).toMatchObject({ event: 'Stop', backgroundTasks: 2, backgroundTypes: ['subagent', 'shell'] });

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
    expect(requests).toEqual([{ authorization: 'Bearer t0k', path: '/contract', body: { nativeSessionId: 'native-1', source: 'compact' } }]);
  });

  it('asks for what a resume restores, naming the source, and prints it', async () => {
    reply = { status: 200, body: { contract: 'Rules' } };
    const result = await run({ ...compact, source: 'resume' });

    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Rules' } });
    expect(requests).toEqual([{ authorization: 'Bearer t0k', path: '/contract', body: { nativeSessionId: 'native-1', source: 'resume' } }]);
  });

  it('prints nothing and exits 0 for another session, a subagent, bad input, or a hub that is gone', async () => {
    reply = { status: 404, body: { error: 'No Switchboard session has this Claude session ID.' } };
    expect(await run(compact)).toEqual({ status: 0, stdout: '' });

    reply = { status: 200, body: { contract: 'C' } };
    expect(await run({ ...compact, agent_id: 'sub' })).toEqual({ status: 0, stdout: '' });
    // Codex runs the hook on every SessionStart, having no matcher (mechanics M31).
    expect(await run({ ...compact, source: 'startup' })).toEqual({ status: 0, stdout: '' });
    expect(await run({ ...compact, source: 'clear' })).toEqual({ status: 0, stdout: '' });
    expect(await run('not json')).toEqual({ status: 0, stdout: '' });
    expect(requests).toHaveLength(1);

    await new Promise((done) => server.close(done));
    expect(await run(compact)).toEqual({ status: 0, stdout: '' });
    server.listen(0, '127.0.0.1');

    rmSync(join(dir, 'hub.json'));
    expect(await run(compact)).toEqual({ status: 0, stdout: '' });
  });

  it("stops waiting for a hub that does not answer before Claude's 10-second hook timeout", async () => {
    // The installed hook waits 5 seconds; this run waits 300 ms, so the test does not sit out the real wait.
    expect(CONTRACT_HOOK_WAIT_MS).toBe(5_000);
    expect(CONTRACT_HOOK_SOURCE).toContain('signal: AbortSignal.timeout(5000),');
    writeFileSync(join(dir, 'contract.mjs'), contractHookSource(300));
    reply = null;
    const started = Date.now();

    expect(await run(compact)).toEqual({ status: 0, stdout: '' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(requests).toHaveLength(1);
  });
});
