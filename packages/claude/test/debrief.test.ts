import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseSubagents, debriefArgs, debriefRange, findTranscript, readDebriefOutput, runDebrief, scopeOf, subagentLines } from '../src/debrief.js';
import type { DebriefInput } from '../src/debrief.js';
import type { Exec, ExecOptions, ExecResult } from '../src/exec.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const recorded = JSON.parse(readFileSync(join(fixtures, 'debrief-transcript.json'), 'utf8')) as { main: unknown[]; subagents: unknown[][] };
const output = JSON.parse(readFileSync(join(fixtures, 'debrief-output.json'), 'utf8')) as unknown[];

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';
const LAST = '521d9a6b-dc37-4bcd-85b0-109a91761741';
/** A main message near the end of the recorded transcript. */
const LATE = 'e5719fe4-5f98-4623-846d-71128e75dc99';
/** The recorded harness notice that follows it. */
const NOTICE = '<task-notification>[redacted]</task-notification>';
const FORK = '11111111-2222-4333-8444-555555555555';
/** The recorded subagent 0's last record is at 21:01:38; subagent 1's is before 20:00. */
const NOW = Date.parse('2026-09-30T21:30:00.000Z');

const lines = (records: readonly unknown[]): string => records.map((record) => JSON.stringify(record)).join('\n');
const main = lines(recorded.main);
const subagents = recorded.subagents.map(lines);
const DELEGATED = '0190a000-0000-7000-8000-000000000001';
/** The first main message after the subagent's agent-delegate calls. */
const AFTER_DELEGATE = '42f51437-ede1-4246-897a-79fc326fc9f8';

describe('the transcript range a debrief covers', () => {
  it('counts every main-transcript tool call and the skills in first-use order', () => {
    expect(debriefRange(main, subagents, SESSION, null)).toEqual({
      throughMessageUuid: LAST,
      toolCalls: 187,
      skills: ['skill-a', 'skill-b', 'skill-c', 'skill-d', 'skill-e', 'skill-f', 'skill-g'],
      delegated: [DELEGATED],
      fromPrompt: null,
    });
  });

  it('starts after the last debriefed message, and names the start by its first message', () => {
    expect(debriefRange(main, subagents, SESSION, LATE)).toEqual({ throughMessageUuid: LAST, toolCalls: 16, skills: ['skill-f', 'skill-g'], delegated: [DELEGATED], fromPrompt: NOTICE });
    expect(debriefRange(main, subagents, SESSION, LAST)).toEqual({ throughMessageUuid: LAST, toolCalls: 0, skills: [], delegated: [], fromPrompt: null });
  });

  // Derived: the recorded session has no typed prompt after its first command, so one is appended here.
  it('skips inserted context and tool results when naming the start, and clips the opening to 200 characters', () => {
    const typed = `  ${'Merge the base first. '.repeat(12)}`;
    const after = [
      { type: 'user', uuid: 'meta-1', sessionId: SESSION, isMeta: true, message: { content: [{ type: 'text', text: 'Base directory for this skill' }] } },
      { type: 'user', uuid: 'result-1', sessionId: SESSION, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] } },
      { type: 'user', uuid: 'typed-1', sessionId: SESSION, message: { content: typed } },
    ];

    expect(debriefRange(`${main}\n${lines(after)}`, subagents, SESSION, LAST)?.fromPrompt).toBe(typed.trimStart().slice(0, 200));
  });

  it('takes delegated threads from subagent records written after the start, and from no other tool', () => {
    expect(debriefRange(main, subagents, SESSION, AFTER_DELEGATE)?.delegated).toEqual([]);
    expect(debriefRange(main, [], SESSION, null)?.delegated).toEqual([]);
  });

  it('reads the whole transcript when the last debriefed message is gone', () => {
    expect(debriefRange(main, subagents, SESSION, 'ffffffff-0000-4000-8000-000000000000')?.toolCalls).toBe(187);
  });

  it('ignores subagent records, records of another session, and a line still being written', () => {
    const extra = [
      { type: 'assistant', uuid: 'side-1', sessionId: SESSION, isSidechain: true, message: { content: [{ type: 'tool_use', id: 'toolu_side', name: 'Bash', input: {} }] } },
      { type: 'assistant', uuid: 'other-1', sessionId: 'b2c3d4e5-0000-4000-8000-000000000002', message: { content: [{ type: 'tool_use', id: 'toolu_other', name: 'Bash', input: {} }] } },
    ];

    expect(debriefRange(`${main}\n${lines(extra)}\n{"type":"assistant","uuid":"cut`, subagents, SESSION, null)).toMatchObject({ throughMessageUuid: LAST, toolCalls: 187 });
  });

  it('has no range for a transcript with no messages', () => {
    expect(debriefRange('{"type":"ai-title","aiTitle":"x"}\n', [], SESSION, null)).toBeNull();
  });

  it('fills the scope from the range start', () => {
    expect(scopeOf({ throughMessageUuid: LAST, toolCalls: 1, skills: [], delegated: [], fromPrompt: null })).toBe('the whole conversation');
    expect(scopeOf({ throughMessageUuid: LAST, toolCalls: 1, skills: [], delegated: [], fromPrompt: 'Ship it' })).toBe('the work after the user message that begins "Ship it"');
  });
});

describe('the answer a debrief fork prints', () => {
  const result = (over: Record<string, unknown>): unknown => ({ type: 'result', subtype: 'success', is_error: false, ...over });
  const entry = { what: 'init-worktree failed', source: 'skill:init-worktree', workaround: 'Removed the binding', cost: '6 tool calls', evidence: 'appcmd error', fix: 'Remove it' };

  it('reads the recorded stream events: the friction and the cache use', () => {
    expect(readDebriefOutput(output)).toEqual({ friction: [], cache: { read: 27702, created: 26129, costUsd: 0.4357966 } });
  });

  it('takes a single result object, a bare array, and JSON in a code fence, and keeps each item as answered', () => {
    expect(readDebriefOutput(result({ result: JSON.stringify({ friction: [entry] }) }))).toEqual({ friction: [entry], cache: null });
    expect(readDebriefOutput(result({ result: `\`\`\`json\n${JSON.stringify([entry])}\n\`\`\`` }))).toEqual({ friction: [entry], cache: null });
    expect(readDebriefOutput(result({ result: '[]', usage: null }))).toEqual({ friction: [], cache: null });
  });

  // Derived from the recorded result event: a fork waiting on subagents prints an interim note, the answer, and an empty result (GC M64).
  it('takes the last result that is the friction JSON, and the cost of the last result', () => {
    const base = output.at(-1) as Record<string, unknown>;
    const interim = { ...base, result: 'Still waiting for the report from subagent a1.' };
    const answer = { ...base, result: JSON.stringify({ friction: [entry] }) };
    const trailing = { ...base, result: '', total_cost_usd: 1.1, usage: { cache_read_input_tokens: 30, cache_creation_input_tokens: 7 } };

    expect(readDebriefOutput([interim, answer, trailing])).toEqual({ friction: [entry], cache: { read: 30, created: 7, costUsd: 1.1 } });
    expect(readDebriefOutput([interim, trailing])).toEqual({ error: 'The debrief answer was not the friction JSON: Still waiting for the report from subagent a1.' });
  });

  it('refuses an unfinished turn, an item with a blank or missing field, and output with no result', () => {
    expect(readDebriefOutput(result({ subtype: 'error_max_turns', is_error: true }))).toEqual({ error: 'Claude did not finish the debrief (error_max_turns).' });

    for (const field of ['what', 'source', 'workaround', 'cost', 'evidence']) {
      const { [field]: _dropped, ...missing } = entry as Record<string, string>;

      expect(readDebriefOutput(result({ result: JSON.stringify({ friction: [{ ...entry, [field]: ' ' }] }) }))).toHaveProperty('error');
      expect(readDebriefOutput(result({ result: JSON.stringify({ friction: [entry, missing] }) }))).toHaveProperty('error');
    }

    expect(readDebriefOutput([{ type: 'system', subtype: 'init' }])).toEqual({ error: 'Claude returned no debrief result.' });
    expect(readDebriefOutput(result({ result: { friction: [] } }))).toEqual({ error: 'The debrief answer was not the friction JSON: ' });
  });
});

describe('on disk', () => {
  let root: string;
  let projects: string;
  let project: string;
  let agents: string;
  const meta = (agentType: string | null, description: string): string => JSON.stringify({ ...(agentType === null ? {} : { agentType }), description });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'switchboard-debrief-')).replaceAll('\\', '/');
    projects = `${root}/projects`;
    project = `${projects}/D--work-42-example`;
    agents = `${project}/${SESSION}/subagents`;
    mkdirSync(agents, { recursive: true });
    writeFileSync(`${project}/${SESSION}.jsonl`, main);
    // Derived: the recorded skeleton keeps no meta files, so each subagent's type and description are set here.
    const files: Record<string, string> = {
      'agent-a1.jsonl': lines(recorded.subagents[0]!),
      'agent-a1.meta.json': meta('general-purpose', 'Finder: tests'),
      'agent-b2.jsonl': lines(recorded.subagents[0]!),
      'agent-b2.meta.json': meta('Explore', 'Find the callers'),
      'agent-c3.jsonl': lines(recorded.subagents[0]!),
      'agent-c3.meta.json': meta('codex', 'Finder: correctness'),
      'agent-d4.jsonl': lines(recorded.subagents[1]!),
      'agent-d4.meta.json': meta('general-purpose', 'Early research'),
      'agent-e5.jsonl': lines(recorded.subagents[0]!),
      'agent-e5.meta.json': meta(null, 'No type'),
    };

    for (const [name, text] of Object.entries(files)) {
      writeFileSync(`${agents}/${name}`, text);
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the transcript by the project slug, ignoring case, with its write time', () => {
    utimesSync(`${project}/${SESSION}.jsonl`, 1_790_000_000, 1_790_000_000);

    expect(findTranscript(projects, 'D:\\work\\42-example', SESSION)).toEqual({ path: `${project}/${SESSION}.jsonl`, writtenAt: 1_790_000_000_000 });
    expect(findTranscript(projects, 'd:\\work\\42-example', SESSION)?.path).toBe(`${project}/${SESSION}.jsonl`);
    expect(findTranscript(projects, 'D:\\work\\other', SESSION)).toBeNull();
    expect(findTranscript(`${root}/missing`, 'D:\\work\\42-example', SESSION)).toBeNull();
  });

  it('offers a resumable subagent written within the cache window, and leaves out codex, Explore, untyped and older ones', () => {
    expect(chooseSubagents(agents, {}, NOW).map((choice) => [choice.agentId, choice.description, choice.scope])).toEqual([['a1', 'Finder: tests', 'all of your work in this conversation']]);
    expect(chooseSubagents(agents, {}, Date.parse('2026-09-30T21:56:38.906Z'))).toEqual([]);
    expect(subagentLines(chooseSubagents(agents, {}, NOW))).toBe('- `a1` (Finder: tests): all of your work in this conversation');
    expect(subagentLines([])).toBe('none');
  });

  // Derived: the recorded subagent has no message after its tool results, so the later work is appended here.
  it('asks a subagent debriefed before only about the work after its next message, and skips one with none', () => {
    const since = { a1: '2026-09-30T21:05:00.000Z' };

    expect(chooseSubagents(agents, since, NOW)).toEqual([]);

    const later = { type: 'user', uuid: 'later-1', timestamp: '2026-09-30T21:11:00.000Z', message: { content: 'Recheck the fix.' } };
    writeFileSync(`${agents}/agent-a1.jsonl`, `${lines(recorded.subagents[0]!)}\n${JSON.stringify(later)}`);

    expect(chooseSubagents(agents, since, NOW)[0]?.scope).toBe('the work after the message that begins "Recheck the fix."');
  });

  it('builds the fork arguments, which pass nothing that changes the prompt prefix', () => {
    expect(debriefArgs(SESSION, FORK)).toEqual(['-p', '--resume', SESSION, '--fork-session', '--session-id', FORK, '--no-session-persistence', '--output-format', 'json']);
  });

  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '', missing: false, timedOut: false });

  function input(over: Partial<DebriefInput> = {}): DebriefInput {
    return {
      claudePath: 'claude',
      sessionId: SESSION,
      forkId: FORK,
      cwd: 'D:/work/42-example',
      transcript: `${project}/${SESSION}.jsonl`,
      prompt: 'Ask: {{subagents}} $&',
      subagentsDebriefed: {},
      now: NOW,
      timeoutMs: 600_000,
      ...over,
    };
  }

  it('runs the fork in the session directory with the prompt on stdin and the debrief variable, and copies the offered subagents only while it runs', async () => {
    const calls: { file: string; args: string[]; options: ExecOptions; copied: string[] }[] = [];
    const exec: Exec = async (file, args, options) => {
      calls.push({ file, args, options, copied: readdirSync(`${project}/${FORK}/subagents`).sort() });
      return ok(JSON.stringify(output));
    };

    expect(await runDebrief(input(), exec)).toEqual({ friction: [], cache: { read: 27702, created: 26129, costUsd: 0.4357966 }, subagents: ['a1'] });
    expect(calls).toEqual([
      {
        file: 'claude',
        args: debriefArgs(SESSION, FORK),
        options: { cwd: 'D:/work/42-example', stdin: 'Ask: - `a1` (Finder: tests): all of your work in this conversation $&', timeoutMs: 600_000, env: { FRICTION_DEBRIEF: '1' } },
        copied: ['agent-a1.jsonl', 'agent-a1.meta.json'],
      },
    ]);
    expect(readdirSync(project).sort()).toEqual([SESSION, `${SESSION}.jsonl`]);
  });

  it('removes the copy when the fork fails, and reports the failure', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '', stderr: 'Session not found', missing: false, timedOut: false });

    expect(await runDebrief(input(), exec)).toEqual({ error: 'Claude could not run the debrief: Session not found' });
    expect(await runDebrief(input(), async () => ok('not json'))).toEqual({ error: 'The debrief output is not JSON.' });
    expect(await runDebrief(input(), async () => ok(JSON.stringify([{ type: 'result', result: 'No friction.' }])))).toEqual({ error: 'The debrief answer was not the friction JSON: No friction.' });
    expect(readdirSync(project).sort()).toEqual([SESSION, `${SESSION}.jsonl`]);
  });

  it('does not run when the subagents cannot be copied, and never copies over the session itself', async () => {
    const runs: string[][] = [];
    const exec: Exec = async (_file, args) => {
      runs.push(args);
      return ok(JSON.stringify(output));
    };

    writeFileSync(`${project}/${FORK}`, 'a file where the fork directory goes');

    expect(await runDebrief(input(), exec)).toMatchObject({ error: expect.stringContaining('could not be copied for the debrief') });
    expect(runs).toEqual([]);

    expect(await runDebrief(input({ forkId: SESSION, prompt: '{{subagents}}' }), exec)).toMatchObject({ subagents: [] });
    expect(runs).toHaveLength(1);
    expect(readdirSync(agents)).toHaveLength(10);
  });
});
