import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecResult } from '../src/exec.js';
import { copyFrom, parentPids, resumeArgs, tabCandidates } from '../src/runner.js';
import type { RosterEntry } from '../src/runner.js';
import { ClaudeRunner } from '../src/sessionRunner.js';

const ran = (patch: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...patch });
const ROSTER = readFileSync(join(import.meta.dirname, 'fixtures', 'agents-all-tab.json'), 'utf8');
const ENTRIES = JSON.parse(ROSTER) as RosterEntry[];
const TAB = 'switchboard · ad-hoc · adhoc 1';
const NATIVE = 'fece8d4c-6de5-4f07-b545-690af18d7bf9';

/** A `/proc` folder whose processes have the given parents. */
function proc(parents: Record<number, number>): string {
  const root = mkdtempSync(join(tmpdir(), 'switchboard-proc-'));

  for (const [pid, parent] of Object.entries(parents)) {
    mkdirSync(join(root, pid));
    writeFileSync(join(root, pid, 'stat'), `${pid} (claude (tab)) S ${parent} ${pid} ${pid} 0 -1 4194560`);
  }

  return root;
}

function runner(answer: (args: string[]) => ExecResult, calls: { args: string[]; cwd?: string }[] = [], root = '/nonexistent'): ClaudeRunner {
  return new ClaudeRunner({
    claudePath: () => 'claude',
    exec: async (_file, args, options) => {
      calls.push({ args, ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) });
      return answer(args);
    },
    sleep: async () => {},
    now: () => 0,
    home: '/home/operator/.switchboard',
    claudeSettings: '/home/operator/.claude/settings.json',
    hooks: () => false,
    processTable: { platform: 'linux', proc: root },
    nodePath: () => 'node',
  });
}

describe('Continue in Background in the Claude runner (PRD R89)', () => {
  it('finds the tab’s session by its name among live interactive entries, with its earlier background job', () => {
    expect(tabCandidates(ENTRIES, TAB)).toEqual([{ nativeSessionId: NATIVE, pid: 2422900, background: true }]);
  });

  it('matches a label the tab cut short with … by its start, so every live session it may name is a candidate', () => {
    // The Claude tab cuts a long name, as `switchboard · ad-hoc · a…` (live acceptance, 2026-11-03).
    const other = { ...ENTRIES[1]!, pid: 5, sessionId: '0f1e2d3c-0000-4000-8000-000000000001', name: 'switchboard · ad-hoc · adhoc 2' };

    expect(tabCandidates([...ENTRIES, other], 'switchboard · ad-hoc · a…')).toEqual([
      { nativeSessionId: NATIVE, pid: 2422900, background: true },
      { nativeSessionId: other.sessionId, pid: 5, background: false },
    ]);
    // Without the …, the label is the whole name.
    expect(tabCandidates(ENTRIES, 'switchboard · ad-hoc · a')).toEqual([]);
  });

  it('lists no tab for a name no live tab has, and marks a session that never ran in the background', () => {
    expect(tabCandidates(ENTRIES, 'Untitled')).toEqual([]);
    // A background process with this name is not a tab.
    expect(tabCandidates(ENTRIES, 'switchboard · dev:develop · github 7')).toEqual([]);
    // A registered session (PRD R81) has no background job.
    expect(tabCandidates(ENTRIES, 'Register skill live check')).toEqual([{ nativeSessionId: '9273f594-1111-4222-8333-444455556666', pid: 2434342, background: false }]);
    // A tab that has ended leaves only the background job.
    expect(tabCandidates(ENTRIES.filter((entry) => entry.kind === 'background'), TAB)).toEqual([]);
  });

  it('resumes with no flag but the prompt, and reads a copy from the output', () => {
    expect(resumeArgs(NATIVE, 'Continue.')).toEqual(['--bg', '--resume', NATIVE, 'Continue.']);
    expect(copyFrom('note: session fece8d4c is open in another Claude Code process, so this started a copy as c00ce27c. The original conversation is unchanged.\nbackgrounded · c00ce27c')).toBe('c00ce27c');
    expect(copyFrom('note: woke session fece8d4c with its saved options (--permission-mode, -n, --model).\nbackgrounded · fece8d4c · switchboard · ad-hoc · adhoc 1')).toBeNull();
  });

  it('reads the full roster for a tab, runs the resume in the session’s directory, and confirms a background entry with a process', async () => {
    const calls: { args: string[]; cwd?: string }[] = [];
    const root = proc({ 2422900: 2420928 });
    const claude = runner((args) => (args[0] === 'agents' ? ran({ stdout: ROSTER }) : ran({ stdout: 'note: woke session fece8d4c with its saved options (--permission-mode, -n, --model).\nbackgrounded · fece8d4c · x' })), calls, root);

    // Only a process whose parent is the window's extension host is its tab.
    expect(await claude.tab(TAB, 2420928)).toEqual({ candidates: [{ nativeSessionId: NATIVE, pid: 2422900, background: true }] });
    expect(await claude.tab(TAB, 1234)).toEqual({ candidates: [] });
    expect(calls[0]!.args).toEqual(['agents', '--json', '--all']);
    calls.length = 1;
    rmSync(root, { recursive: true, force: true });

    expect(await claude.resume(NATIVE, 'Continue.', '/home/operator/git/mech')).toEqual({ copy: null });
    expect(calls[1]).toEqual({ args: ['--bg', '--resume', NATIVE, 'Continue.'], cwd: '/home/operator/git/mech' });

    // The tab's entry and the stopped job are not the background process; another session's process is not this one.
    expect(await claude.background(NATIVE)).toBeNull();
    expect(await claude.background('1370ab66-2f5a-4c76-b5dd-5de16139ea60')).toEqual({ shortId: '1370ab66' });
    expect(calls[2]!.args).toEqual(['agents', '--json']);
  });

  it('answers the CLI’s failure and a failed roster read', async () => {
    const claude = runner((args) => (args[0] === 'agents' ? ran({ code: 1, stderr: 'boom' }) : ran({ code: 1, stderr: 'No conversation found with session ID: x' })));

    expect(await claude.tab(TAB, 1)).toHaveProperty('error');
    expect(await claude.background(NATIVE)).toHaveProperty('error');
    expect(await claude.resume(NATIVE, 'Continue.', '/home/operator/git/mech')).toEqual({ error: expect.stringContaining('No conversation found with session ID: x') });
  });

  it('reads parent PIDs from /proc, skipping a gone process, and from Windows CIM', async () => {
    const root = proc({ 10: 4, 11: 4 });

    expect(await parentPids(async () => ran({}), [10, 11, 12], { platform: 'linux', proc: root })).toEqual(new Map([[10, 4], [11, 4]]));
    rmSync(root, { recursive: true, force: true });

    const queries: string[][] = [];
    const cim = async (_file: string, args: string[]) => (queries.push(args), ran({ stdout: '[{"pid":10,"parent":4},{"pid":11,"parent":5}]' }));

    expect(await parentPids(cim, [10, 11], { platform: 'win32' })).toEqual(new Map([[10, 4], [11, 5]]));
    expect(queries[0]!.at(-1)).toContain('-Filter "ProcessId=10 OR ProcessId=11"');
    expect(await parentPids(async () => ran({ code: 1, stderr: 'Access denied' }), [10], { platform: 'win32' })).toEqual({ error: 'Access denied' });
    expect(await parentPids(cim, [], { platform: 'win32' })).toEqual(new Map());
  });
});
