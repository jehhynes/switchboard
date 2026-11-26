import { describe, expect, it } from 'vitest';
import { codexHookCommands, codexMarkerState, parseCodexMarker, planCodexHooks } from '../src/hooks.js';
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
    const theirs = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node other.js', timeout: 10 }] }] }, other: true };
    const plan = planCodexHooks(`\uFEFF${JSON.stringify(theirs)}`, HOOK, CONTRACT, 'node') as { text: string };
    const hooks = ours(plan.text);

    expect(hooks.hooks['Stop']).toEqual([theirs.hooks.Stop[0], { hooks: [{ type: 'command', command: `node "${HOOK}"`, timeout: 5 }] }]);
    expect((JSON.parse(plan.text) as { other: boolean }).other).toBe(true);
    expect(planCodexHooks(plan.text, HOOK, CONTRACT, 'node')).toEqual({ unchanged: true });
  });

  it('replaces an earlier Switchboard entry with other settings in its place', () => {
    const old = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${HOOK}"`, async: true, timeout: 5 }] }, { hooks: [{ type: 'command', command: 'node other.js' }] }] } };
    const hooks = ours((planCodexHooks(JSON.stringify(old), HOOK, CONTRACT, 'node') as { text: string }).text).hooks;

    expect(hooks['Stop']).toEqual([{ hooks: [{ type: 'command', command: `node "${HOOK}"`, timeout: 5 }] }, { hooks: [{ type: 'command', command: 'node other.js' }] }]);
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

  it('removes the entries of another Switchboard home whose hub is gone, and keeps those of a home whose hub runs', () => {
    const gone = 'C:/Temp/sb-live-home-a/.switchboard';
    const live = 'D:/acceptance/.switchboard';
    const entry = (home: string, script: string) => ({ type: 'command', command: `node "${home}/${script}"`, timeout: 5 });
    const other = { type: 'command', command: 'node other.js' };
    const file = {
      hooks: {
        Stop: [{ hooks: [other] }, { hooks: [entry(gone, 'codex-hook.mjs')] }, { hooks: [entry(live, 'codex-hook.mjs')] }],
        SessionStart: [{ hooks: [entry(gone, 'codex-hook.mjs')] }, { hooks: [entry(gone, 'contract.mjs')] }],
        Interrupt: [{ hooks: [entry(gone, 'codex-hook.mjs')] }],
        PreToolUse: [{ matcher: 'x', hooks: [other, entry(gone, 'codex-hook.mjs')] }],
        // Not a Switchboard home: the script's folder is not named .switchboard.
        PostToolUse: [{ hooks: [entry('C:/tools', 'codex-hook.mjs')] }],
      },
    };
    const asked: string[] = [];
    const plan = planCodexHooks(JSON.stringify(file), HOOK, CONTRACT, 'node', (home) => (asked.push(home), home === gone)) as { text: string };
    const hooks = ours(plan.text).hooks;
    const own = (timeout = 5) => ({ hooks: [{ type: 'command', command: `node "${HOOK}"`, timeout }] });

    expect(hooks['Stop']).toEqual([{ hooks: [other] }, { hooks: [entry(live, 'codex-hook.mjs')] }, own()]);
    expect(hooks['SessionStart']).toEqual([own(), { hooks: [{ type: 'command', command: `node "${CONTRACT}"`, timeout: 10 }] }]);
    expect(hooks['Interrupt']).toBeUndefined();
    expect(hooks['PreToolUse']).toEqual([{ matcher: 'x', hooks: [other] }, own()]);
    expect(hooks['PostToolUse']).toEqual([{ hooks: [entry('C:/tools', 'codex-hook.mjs')] }, own()]);
    // This hub's own home is never checked.
    expect([...new Set(asked)].sort()).toEqual([live, gone].sort());
    expect(planCodexHooks(plan.text, HOOK, CONTRACT, 'node', (home) => home === gone)).toEqual({ unchanged: true });
  });

  it('leaves a file it cannot read as hooks alone', () => {
    expect(planCodexHooks('{ not json', HOOK, CONTRACT, 'node')).toEqual({ error: 'Codex hooks.json is not valid JSON, so Switchboard left it alone.' });
    expect(planCodexHooks('[]', HOOK, CONTRACT, 'node')).toEqual({ error: 'Codex hooks.json is not a JSON object, so Switchboard left it alone.' });
    expect(planCodexHooks('{"hooks": 3}', HOOK, CONTRACT, 'node')).toEqual({ error: 'The hooks entry of Codex hooks.json is not an object, so Switchboard left it alone.' });
    expect(planCodexHooks('{"hooks": {"Stop": {}}}', HOOK, CONTRACT, 'node')).toEqual({ error: 'The Stop entry of Codex hooks.json is not a list, so Switchboard left it alone.' });
  });
});
