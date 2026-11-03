import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecResult } from '../src/exec.js';
import { copyFrom, NEVER_BACKGROUND, NOT_SWITCHBOARD, resumeArgs, tabSession } from '../src/runner.js';
import type { RosterEntry } from '../src/runner.js';
import { ClaudeRunner } from '../src/sessionRunner.js';

const ran = (patch: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...patch });
const ROSTER = readFileSync(join(import.meta.dirname, 'fixtures', 'agents-all-tab.json'), 'utf8');
const ENTRIES = JSON.parse(ROSTER) as RosterEntry[];
const TAB = 'switchboard · ad-hoc · adhoc 1';
const NATIVE = 'fece8d4c-6de5-4f07-b545-690af18d7bf9';

function runner(answer: (args: string[]) => ExecResult, calls: { args: string[]; cwd?: string }[] = []): ClaudeRunner {
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
    nodePath: () => 'node',
  });
}

describe('Continue in Background in the Claude runner (PRD R89)', () => {
  it('finds the tab’s session by its name among live interactive entries, with its earlier background job', () => {
    expect(tabSession(ENTRIES, TAB)).toEqual({ nativeSessionId: NATIVE, pid: 2422900 });
  });

  it('refuses a name no live tab has, a session that never ran in the background, and a name two live sessions share', () => {
    expect(tabSession(ENTRIES, 'Untitled')).toEqual({ refused: NOT_SWITCHBOARD });
    // A background process with this name is not a tab.
    expect(tabSession(ENTRIES, 'switchboard · dev:develop · github 7')).toEqual({ refused: NOT_SWITCHBOARD });
    // A registered session (PRD R81) has no background job.
    expect(tabSession(ENTRIES, 'Register skill live check')).toEqual({ refused: NEVER_BACKGROUND });
    // A tab that has ended leaves only the background job.
    expect(tabSession(ENTRIES.filter((entry) => entry.kind === 'background'), TAB)).toEqual({ refused: NOT_SWITCHBOARD });

    const twice = [...ENTRIES, { ...ENTRIES[1]!, pid: 5, sessionId: '0f1e2d3c-0000-4000-8000-000000000001' }];
    expect(tabSession(twice, TAB)).toEqual({ refused: `Several running Claude sessions are named "${TAB}", so Switchboard cannot tell which one this tab holds.` });
  });

  it('resumes with no flag but the prompt, and reads a copy from the output', () => {
    expect(resumeArgs(NATIVE, 'Continue.')).toEqual(['--bg', '--resume', NATIVE, 'Continue.']);
    expect(copyFrom('note: session fece8d4c is open in another Claude Code process, so this started a copy as c00ce27c. The original conversation is unchanged.\nbackgrounded · c00ce27c')).toBe('c00ce27c');
    expect(copyFrom('note: woke session fece8d4c with its saved options (--permission-mode, -n, --model).\nbackgrounded · fece8d4c · switchboard · ad-hoc · adhoc 1')).toBeNull();
  });

  it('reads the full roster for a tab, runs the resume in the session’s directory, and confirms a background entry with a process', async () => {
    const calls: { args: string[]; cwd?: string }[] = [];
    const claude = runner((args) => (args[0] === 'agents' ? ran({ stdout: ROSTER }) : ran({ stdout: 'note: woke session fece8d4c with its saved options (--permission-mode, -n, --model).\nbackgrounded · fece8d4c · x' })), calls);

    expect(await claude.tab(TAB)).toEqual({ nativeSessionId: NATIVE, pid: 2422900 });
    expect(calls[0]!.args).toEqual(['agents', '--json', '--all']);

    expect(await claude.resume(NATIVE, 'Continue.', '/home/operator/git/mech')).toEqual({ copy: null });
    expect(calls[1]).toEqual({ args: ['--bg', '--resume', NATIVE, 'Continue.'], cwd: '/home/operator/git/mech' });

    // The tab's entry and the stopped job are not the background process; another session's process is not this one.
    expect(await claude.background(NATIVE)).toBeNull();
    expect(await claude.background('1370ab66-2f5a-4c76-b5dd-5de16139ea60')).toEqual({ shortId: '1370ab66' });
    expect(calls[2]!.args).toEqual(['agents', '--json']);
  });

  it('answers the CLI’s failure and a failed roster read', async () => {
    const claude = runner((args) => (args[0] === 'agents' ? ran({ code: 1, stderr: 'boom' }) : ran({ code: 1, stderr: 'No conversation found with session ID: x' })));

    expect(await claude.tab(TAB)).toHaveProperty('error');
    expect(await claude.background(NATIVE)).toHaveProperty('error');
    expect(await claude.resume(NATIVE, 'Continue.', '/home/operator/git/mech')).toEqual({ error: expect.stringContaining('No conversation found with session ID: x') });
  });
});
