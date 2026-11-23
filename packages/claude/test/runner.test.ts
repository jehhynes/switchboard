import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Exec, ExecResult } from '../src/exec.js';
import type { Marker } from '../src/hooks.js';
import { entryFor, observe, observeForks, readRoster, rosterState } from '../src/runner.js';
import { PERMISSION_PROMPT } from '@switchboard/core';
import type { RosterEntry } from '../src/runner.js';

const AGENTS = readFileSync(join(import.meta.dirname, 'fixtures', 'agents.json'), 'utf8');
const ENTRIES = JSON.parse(AGENTS) as RosterEntry[];

const ran = (patch: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...patch });

/** Answers each call in turn and fails on an unexpected call. */
function fakeExec(...answers: ExecResult[]) {
  return vi.fn<Exec>(async () => {
    const answer = answers.shift();

    if (answer === undefined) {
      throw new Error('unexpected exec call');
    }

    return answer;
  });
}

describe('roster', () => {
  it('reads entries and fails on a CLI error or bad output', async () => {
    expect(await readRoster('claude', fakeExec(ran({ stdout: AGENTS })))).toEqual({ entries: ENTRIES });
    expect(await readRoster('claude', fakeExec(ran({ code: 1, stderr: 'no' })))).toEqual({ error: 'no' });
    expect(await readRoster('claude', fakeExec(ran({ stdout: '{}' })))).toEqual({ error: 'claude agents returned an unexpected response.' });
    expect(await readRoster('claude', fakeExec(ran({ stdout: 'x' })))).toEqual({ error: 'claude agents returned output that is not JSON.' });
  });

  it('matches by short ID and maps roster states', () => {
    expect(entryFor(ENTRIES, 'a54bd2e6')?.pid).toBe(8292);
    expect(entryFor(ENTRIES, 'ffffffff')).toBeUndefined();
    expect(['working', 'blocked', 'done', 'stopped', undefined].map((state) => rosterState({ sessionId: 'x', kind: 'background', cwd: '', ...(state === undefined ? {} : { state }) }))).toEqual([
      'running',
      'waiting',
      'idle',
      'idle',
      'running',
    ]);
    expect(['idle', 'busy', 'waiting'].map((status) => rosterState({ sessionId: 'x', kind: 'interactive', cwd: '', status }))).toEqual(['idle', 'running', 'waiting']);
  });

  it('observes sessions an interactive entry with a process holds, preferring the hook marker, and never a background entry (PRD R93)', () => {
    const marker = (event: string): Marker => ({ sessionId: '', event, notificationType: null, source: null, toolName: null, backgroundTasks: 0, error: null, errorMessage: null });
    const tab = ENTRIES.find((entry) => entry.sessionId.startsWith('3e065e9f'))!;
    const sessions = [
      { id: 's-gone', shortId: '45503b04' },
      { id: 's-background', shortId: 'a54bd2e6' },
      { id: 's-unstarted', shortId: null },
      { id: 's-missing', shortId: 'ffffffff' },
      { id: 's-tab', shortId: '3e065e9f' },
    ];

    expect(ENTRIES.find((entry) => entry.sessionId.startsWith('a54bd2e6'))).toMatchObject({ kind: 'background', pid: 8292 });
    expect(observe(ENTRIES, sessions, new Map())).toEqual([{ sessionId: 's-tab', state: 'running', detail: null, interactive: true }]);
    expect(observe(ENTRIES, sessions, new Map([[tab.sessionId, marker('Stop')]]))).toEqual([{ sessionId: 's-tab', state: 'idle', detail: null, interactive: true }]);
  });

  it('takes a permission prompt from the hook marker of a session in a tab', () => {
    const entry = { sessionId: '1a2b3c4d-0000', pid: 5, kind: 'interactive', cwd: '', status: 'busy' };
    const session = { id: 's1', shortId: '1a2b3c4d' };
    const notification: Marker = { sessionId: entry.sessionId, event: 'Notification', notificationType: 'permission_prompt', source: null, toolName: null, backgroundTasks: 0, error: null, errorMessage: null };
    const markers = (marker: Marker) => new Map([[entry.sessionId, marker]]);

    expect(observe([entry], [session], markers({ ...notification, event: 'PermissionRequest', notificationType: null, toolName: 'PowerShell' }))).toEqual([{ sessionId: 's1', state: 'waiting', detail: PERMISSION_PROMPT, interactive: true }]);
    expect(observe([entry], [session], markers({ ...notification, promptTool: 'PowerShell' }))).toEqual([{ sessionId: 's1', state: 'waiting', detail: PERMISSION_PROMPT, interactive: true }]);
    expect(observe([entry], [session], markers({ ...notification, promptTool: null }))).toEqual([{ sessionId: 's1', state: 'waiting', detail: null, interactive: true }]);
    expect(observe([entry], [session], markers({ ...notification, event: 'PostToolBatch', notificationType: null }))).toEqual([{ sessionId: 's1', state: 'running', detail: null, interactive: true }]);
  });

  it('observes a resumed tab as idle until its first turn, though the roster lists it as busy', () => {
    const tab = ENTRIES.find((entry) => entry.sessionId.startsWith('3e065e9f'))!;
    const marker = (event: string, source: string | null): Marker => ({ sessionId: tab.sessionId, event, notificationType: null, source, toolName: null, backgroundTasks: 0, error: null, errorMessage: null });
    const sessions = [{ id: 's-tab', shortId: '3e065e9f' }];

    expect(observe(ENTRIES, sessions, new Map([[tab.sessionId, marker('SessionStart', 'resume')]]))).toEqual([{ sessionId: 's-tab', state: 'idle', detail: null, interactive: true }]);
    expect(observe(ENTRIES, sessions, new Map([[tab.sessionId, marker('SessionStart', 'compact')]]))).toMatchObject([{ state: 'running' }]);
    expect(observe(ENTRIES, sessions, new Map([[tab.sessionId, marker('UserPromptSubmit', null)]]))).toMatchObject([{ state: 'running' }]);
  });

  it("observes each fork with its own marker's state, else the roster's, and names it by its ID", () => {
    const fork: RosterEntry = { pid: 9, cwd: 'D:/git/widgets', kind: 'interactive', sessionId: '9e8d7c6b-0000-4000-8000-000000000002', status: 'idle' };
    const marker: Marker = { sessionId: fork.sessionId, event: 'UserPromptSubmit', notificationType: null, source: null, toolName: null, backgroundTasks: 0, error: null, errorMessage: null };
    const forks = new Map([['s1', fork]]);

    expect(observeForks(forks, new Map())).toEqual([{ sessionId: 's1', nativeSessionId: fork.sessionId, shortId: '9e8d7c6b', state: 'idle', detail: null }]);
    expect(observeForks(forks, new Map([[fork.sessionId, marker]]))).toMatchObject([{ state: 'running' }]);
    // A fork whose permission request's marker a notification replaced keeps the permission detail (mechanics M57).
    expect(observeForks(forks, new Map([[fork.sessionId, { ...marker, event: 'Notification', notificationType: 'permission_prompt', promptTool: 'Bash' }]]))).toMatchObject([{ state: 'waiting', detail: PERMISSION_PROMPT }]);
  });
});

