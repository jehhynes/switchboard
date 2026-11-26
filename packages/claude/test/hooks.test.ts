import { describe, expect, it } from 'vitest';
import { BACKGROUND_DETAIL, HOOK_EVENTS, markerState, planHooks } from '../src/hooks.js';
import type { Marker } from '../src/hooks.js';
import { PERMISSION_PROMPT } from '@switchboard/core';

const HOOK = 'C:/Users/me/.switchboard/hook.mjs';
const ENTRY = { type: 'command', command: 'node', args: [HOOK], async: true, timeout: 5 };
const CONTRACT_HOOK = 'C:/Users/me/.switchboard/contract.mjs';
const CONTRACT_ENTRY = { type: 'command', command: 'node', args: [CONTRACT_HOOK], timeout: 10 };

describe('planHooks', () => {
  it('adds one entry per event to missing settings, and the synchronous contract hook after compaction', () => {
    const plan = planHooks(null, HOOK, CONTRACT_HOOK, 'node');
    const hooks = JSON.parse((plan as { text: string }).text).hooks;

    expect(Object.keys(hooks)).toEqual(HOOK_EVENTS.map(([event]) => event));
    expect(hooks.Stop).toEqual([{ hooks: [ENTRY] }]);
    expect(hooks.SessionStart).toEqual([{ hooks: [ENTRY] }, { matcher: 'compact|resume', hooks: [CONTRACT_ENTRY] }]);
    expect(hooks.PreToolUse).toEqual([{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [ENTRY] }]);
  });

  it("keeps other settings and entries, including Ground Control's, and is unchanged once installed", () => {
    const gc = { hooks: [{ type: 'command', command: 'node', args: ['C:/Users/me/.ground-control/hook.mjs'], async: true, timeout: 5 }] };
    const existing = JSON.stringify({ model: 'opus', hooks: { Stop: [gc], PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] }] } });
    const first = planHooks(existing, HOOK, CONTRACT_HOOK, 'node') as { text: string };
    const settings = JSON.parse(first.text);

    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop).toEqual([gc, { hooks: [ENTRY] }]);
    expect(settings.hooks.PostToolUse).toEqual([{ matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] }, { matcher: 'AskUserQuestion|ExitPlanMode', hooks: [ENTRY] }]);
    expect(planHooks(first.text, HOOK, CONTRACT_HOOK, 'node')).toEqual({ unchanged: true });
  });

  it('adds only the missing entries', () => {
    const partial = { hooks: { Stop: [{ hooks: [ENTRY] }] } };
    const settings = JSON.parse((planHooks(JSON.stringify(partial), HOOK, CONTRACT_HOOK, 'node') as { text: string }).text);

    expect(settings.hooks.Stop).toEqual([{ hooks: [ENTRY] }]);
    expect(settings.hooks.SessionEnd).toEqual([{ hooks: [ENTRY] }]);

    // Settings written before the contract hook existed get it, once.
    const older = { hooks: Object.fromEntries(HOOK_EVENTS.map(([event, matcher]) => [event, [matcher === null ? { hooks: [ENTRY] } : { matcher, hooks: [ENTRY] }]])) };
    const upgraded = planHooks(JSON.stringify(older), HOOK, CONTRACT_HOOK, 'node') as { text: string };

    expect(JSON.parse(upgraded.text).hooks.SessionStart).toEqual([{ hooks: [ENTRY] }, { matcher: 'compact|resume', hooks: [CONTRACT_ENTRY] }]);
    expect(planHooks(upgraded.text, HOOK, CONTRACT_HOOK, 'node')).toEqual({ unchanged: true });

    // A contract hook installed for compaction only also runs after a resume; another entry of its group keeps running after compaction only.
    const other = { type: 'command', command: 'fmt' };
    const compactOnly = { hooks: { ...older.hooks, SessionStart: [{ hooks: [ENTRY] }, { matcher: 'compact', hooks: [CONTRACT_ENTRY, other] }] } };
    const rematched = planHooks(JSON.stringify(compactOnly), HOOK, CONTRACT_HOOK, 'node') as { text: string };

    expect(JSON.parse(rematched.text).hooks.SessionStart).toEqual([{ hooks: [ENTRY] }, { matcher: 'compact', hooks: [other] }, { matcher: 'compact|resume', hooks: [CONTRACT_ENTRY] }]);
    expect(planHooks(rematched.text, HOOK, CONTRACT_HOOK, 'node')).toEqual({ unchanged: true });

    const alone = { hooks: { ...older.hooks, SessionStart: [{ hooks: [ENTRY] }, { matcher: 'compact', hooks: [CONTRACT_ENTRY] }] } };

    expect(JSON.parse((planHooks(JSON.stringify(alone), HOOK, CONTRACT_HOOK, 'node') as { text: string }).text).hooks.SessionStart).toEqual([{ hooks: [ENTRY] }, { matcher: 'compact|resume', hooks: [CONTRACT_ENTRY] }]);
  });

  it("gives Switchboard's entries a new sessions.nodePath in place, keeping the other entries and keys", () => {
    const node = '/home/me/.nvm/versions/node/v24.18.0/bin/node';
    const gc = { type: 'command', command: 'node', args: ['C:/Users/me/.ground-control/hook.mjs'] };
    const installed = JSON.parse((planHooks(null, HOOK, CONTRACT_HOOK, 'node') as { text: string }).text);
    installed.hooks.Stop = [{ hooks: [gc, { ...ENTRY, extra: 1 }] }];

    const moved = planHooks(JSON.stringify(installed), HOOK, CONTRACT_HOOK, node) as { text: string };
    const hooks = JSON.parse(moved.text).hooks;

    expect(hooks.Stop).toEqual([{ hooks: [gc, { ...ENTRY, extra: 1, command: node }] }]);
    expect(hooks.SessionStart).toEqual([{ hooks: [{ ...ENTRY, command: node }] }, { matcher: 'compact|resume', hooks: [{ ...CONTRACT_ENTRY, command: node }] }]);
    expect(JSON.stringify(hooks)).not.toContain('"command":"node","args":["C:/Users/me/.switchboard');
    expect(planHooks(moved.text, HOOK, CONTRACT_HOOK, node)).toEqual({ unchanged: true });
  });

  it("leaves the operator's entries that name Switchboard's script but do not run it with Node.js alone, and adds its own", () => {
    const check = { type: 'command', command: 'sha256sum', args: [HOOK] };
    const wrapped = { type: 'command', command: 'node', args: [HOOK, '--trace'] };
    const settings = JSON.parse((planHooks(JSON.stringify({ hooks: { Stop: [{ hooks: [check] }, { hooks: [wrapped] }] } }), HOOK, CONTRACT_HOOK, 'node') as { text: string }).text);

    expect(settings.hooks.Stop).toEqual([{ hooks: [check] }, { hooks: [wrapped] }, { hooks: [ENTRY] }]);
  });

  it('removes the entries of another Switchboard home whose hub is gone, and keeps those of a running hub and of Ground Control', () => {
    const gone = 'C:/Temp/sb-live-home-a/.switchboard';
    const live = 'D:/acceptance/.switchboard';
    const entry = (script: string) => ({ type: 'command', command: 'node', args: [script], async: true, timeout: 5 });
    const gc = entry('C:/Users/me/.ground-control/hook.mjs');
    const existing = {
      hooks: {
        Stop: [{ hooks: [gc] }, { hooks: [entry(`${gone}/hook.mjs`)] }, { hooks: [entry(`${live}/hook.mjs`)] }],
        SessionStart: [{ matcher: 'compact', hooks: [entry(`${gone}/contract.mjs`)] }],
        Setup: [{ hooks: [entry(`${gone}/hook.mjs`)] }],
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }, entry(`${gone}/hook.mjs`)] }],
      },
    };
    const asked: string[] = [];
    const plan = planHooks(JSON.stringify(existing), HOOK, CONTRACT_HOOK, 'node', (home) => (asked.push(home), home !== live)) as { text: string };
    const hooks = JSON.parse(plan.text).hooks;

    expect(hooks.Stop).toEqual([{ hooks: [gc] }, { hooks: [entry(`${live}/hook.mjs`)] }, { hooks: [ENTRY] }]);
    expect(hooks.SessionStart).toEqual([{ hooks: [ENTRY] }, { matcher: 'compact|resume', hooks: [CONTRACT_ENTRY] }]);
    expect(hooks.Setup).toBeUndefined();
    expect(hooks.PostToolUse).toEqual([{ matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] }, { matcher: 'AskUserQuestion|ExitPlanMode', hooks: [ENTRY] }]);
    // This hub's own home and Ground Control's are never checked.
    expect([...new Set(asked)].sort()).toEqual([live, gone].sort());
    expect(planHooks(plan.text, HOOK, CONTRACT_HOOK, 'node', (home) => home !== live)).toEqual({ unchanged: true });
  });

  it('refuses malformed settings', () => {
    expect(planHooks('{ "hooks": ', HOOK, CONTRACT_HOOK, 'node')).toEqual({ error: 'Claude settings.json is not valid JSON, so Switchboard did not add its hooks.' });
    expect(planHooks('{ "hooks": [] }', HOOK, CONTRACT_HOOK, 'node')).toEqual({ error: 'Claude settings.json has an unexpected shape, so Switchboard did not add its hooks.' });
    expect(planHooks('{ "hooks": { "Stop": {} } }', HOOK, CONTRACT_HOOK, 'node')).toEqual({ error: 'Claude settings.json has an unexpected hooks.Stop, so Switchboard did not add its hooks.' });
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
    [{ event: 'PermissionRequest', toolName: 'PowerShell' }, { state: 'waiting', detail: PERMISSION_PROMPT }],
    [{ event: 'PermissionRequest', toolName: 'AskUserQuestion' }, { state: 'waiting', detail: null }],
    [{ event: 'PermissionRequest', toolName: 'ExitPlanMode' }, { state: 'waiting', detail: null }],
    [{ event: 'Elicitation' }, { state: 'waiting', detail: null }],
    [{ event: 'PreToolUse', toolName: 'AskUserQuestion' }, { state: 'waiting', detail: null }],
    [{ event: 'PreToolUse', toolName: 'Bash' }, null],
    [{ event: 'Notification', notificationType: 'permission_prompt', promptTool: null }, { state: 'waiting', detail: null }],
    [{ event: 'Notification', notificationType: 'worker_permission_prompt' }, { state: 'waiting', detail: PERMISSION_PROMPT }],
    [{ event: 'Notification', notificationType: 'agent_needs_input' }, { state: 'waiting', detail: null }],
    [{ event: 'Notification', notificationType: 'idle_prompt' }, null],
    [{ event: 'Stop' }, { state: 'idle', detail: null }],
    [{ event: 'Stop', backgroundTasks: 2 }, { state: 'running', detail: BACKGROUND_DETAIL }],
    [{ event: 'Stop', backgroundTasks: 4, backgroundTypes: ['subagent', 'shell', 'subagent', 'code'] }, { state: 'running', detail: `${BACKGROUND_DETAIL}: 2 agents, 1 shell, 1 other task` }],
    [{ event: 'Stop', backgroundTasks: 0, backgroundTypes: [] }, { state: 'idle', detail: null }],
    [{ event: 'StopFailure', error: 'rate_limit', errorMessage: 'API Error' }, { state: 'failed', detail: 'rate_limit: API Error' }],
    [{ event: 'StopFailure', errorMessage: 'API Error' }, { state: 'failed', detail: 'API Error' }],
    [{ event: 'SessionEnd' }, null],
  ])('maps %j', (patch, expected) => {
    expect(markerState(marker(patch))).toEqual(expected);
  });

  // Claude notifies `permission_prompt` about 5 seconds after the permission request of a question as well as of a tool call (mechanics M57).
  it("gives a permission_prompt notification the detail of the permission request's tool it carries", () => {
    const notification = (promptTool?: string | null) => markerState(marker({ event: 'Notification', notificationType: 'permission_prompt', ...(promptTool === undefined ? {} : { promptTool }) }));

    expect(notification('PowerShell')).toEqual({ state: 'waiting', detail: PERMISSION_PROMPT });
    expect(notification('AskUserQuestion')).toEqual({ state: 'waiting', detail: null });
    expect(notification(null)).toEqual({ state: 'waiting', detail: null });
    // A marker written before the writer recorded the tool says nothing, so a waiting permission prompt keeps the roster's detail.
    expect(notification()).toBeNull();
  });
});
