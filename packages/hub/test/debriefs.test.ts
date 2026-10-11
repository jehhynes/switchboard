import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec, ExecResult, RosterEntry } from '@switchboard/claude';
import type { Session } from '@switchboard/core';
import { Debriefs, readDebriefState } from '../src/debriefs.js';
import type { DebriefDeps } from '../src/debriefs.js';
import { tempHome, until } from './helpers.js';

const NATIVE = 'aaaaaaaa-0000-4000-8000-000000000001';
const MINUTE = 60_000;
/** The transcript's last write. */
const WRITTEN = Date.parse('2026-10-06T12:00:00.000Z');
const CWD = 'D:/work/42-example';

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '', missing: false, timedOut: false });
const friction = { what: 'gh failed', source: 'tool:gh', workaround: 'Retried', cost: '3 tool calls', evidence: 'HTTP 502' };
const answer = (items: unknown[] = [friction]) => ok(JSON.stringify([{ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ friction: items }), total_cost_usd: 0.05, usage: { cache_read_input_tokens: 900, cache_creation_input_tokens: 10 } }]));

/** A transcript with a typed prompt, then `calls` tool calls, ending at message `through`. */
function transcript(calls: number, through = 'msg-last', start = 0, sessionId = NATIVE): string {
  const records: object[] = [{ type: 'user', uuid: `prompt-${start}`, sessionId, message: { content: `Task ${start}` } }];

  for (let index = start; index < start + calls; index++) {
    records.push({ type: 'assistant', uuid: `call-${index}`, sessionId, message: { content: [{ type: 'tool_use', id: `toolu_${index}`, name: index === start ? 'Skill' : 'Bash', input: index === start ? { skill: 'gc-plan' } : {} }] } });
  }

  records.push({ type: 'assistant', uuid: through, sessionId, message: { content: [{ type: 'text', text: 'Done.' }] } });

  return records.map((record) => JSON.stringify(record)).join('\n');
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    workItemId: 1,
    kind: 'task',
    provider: 'claude',
    nativeSessionId: NATIVE,
    shortId: 'aaaaaaaa',
    cwd: CWD,
    state: 'ended',
    stateAt: WRITTEN,
    stateDetail: null,
    outcome: 'done',
    outcomeDetail: null,
    startedAt: WRITTEN - 30 * MINUTE,
    endedAt: WRITTEN,
    released: true, releasing: false,
    reports: [],
    ...over,
  };
}

describe('Debriefs', () => {
  let home: ReturnType<typeof tempHome>;
  let root: string;
  let dir: string;
  let transcriptPath: string;
  let now: number;
  let enabled: boolean;
  let done: number[];
  let sessions: Session[];
  let roster: RosterEntry[] | { error: string };
  let forks: { args: string[]; stdin: string | undefined }[];
  let codexCalls: { args: string[]; env: Record<string, string> | undefined }[];
  let codexReply: () => ExecResult;
  let reply: () => ExecResult | Promise<ExecResult>;
  let logs: string[];

  beforeEach(() => {
    home = tempHome();
    root = home.home.replaceAll('\\', '/');
    dir = `${root}/.wip/debrief`;
    transcriptPath = `${root}/projects/D--work-42-example/${NATIVE}.jsonl`;
    mkdirSync(`${root}/projects/D--work-42-example`, { recursive: true });
    mkdirSync(`${root}/skills/friction-review`, { recursive: true });
    writeFileSync(`${root}/skills/friction-review/prompt.md`, 'Report friction in {{scope}}. Subagents: {{subagents}}');
    writeTranscript(transcript(10));
    now = WRITTEN + 45 * MINUTE;
    enabled = true;
    done = [];
    sessions = [session()];
    roster = [];
    forks = [];
    codexCalls = [];
    codexReply = () => ok(JSON.stringify({ friction: [friction] }));
    mkdirSync(`${root}/tools/agent-delegate`, { recursive: true });
    writeFileSync(`${root}/tools/agent-delegate/debrief.mjs`, '');
    reply = () => answer();
    logs = [];
  });

  afterEach(() => {
    home.remove();
  });

  function writeTranscript(text: string, at = WRITTEN): void {
    writeFileSync(transcriptPath, text);
    utimesSync(transcriptPath, at / 1000, at / 1000);
  }

  const exec: Exec = async (file, args, options) => {
    if (file === 'node') {
      codexCalls.push({ args, env: options.env });
      return codexReply();
    }

    if (args[0] !== '-p') {
      throw new Error(`unexpected call ${args.join(' ')}`);
    }

    forks.push({ args, stdin: options.stdin });

    return reply();
  };

  function debriefs(): Debriefs {
    let ids = 0;
    const deps: DebriefDeps = {
      dir,
      promptPath: `${root}/skills/friction-review/prompt.md`,
      projectsDir: `${root}/projects`,
      claudePath: 'claude',
      codexScript: `${root}/tools/agent-delegate/debrief.mjs`,
      nodePath: 'node',
      exec,
      enabled: () => enabled,
      sessions: () => sessions,
      workItemDone: (id) => done.includes(id),
      roster: async () => ('error' in roster ? roster : { entries: roster }),
      now: () => now,
      newId: () => `fork-${++ids}`,
      log: (line) => logs.push(line),
    };

    return new Debriefs(deps);
  }

  const logLines = (): Record<string, unknown>[] =>
    readFileSync(`${dir}/log/2026-10.jsonl`, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it('forks a session 45 minutes after its last turn, logs the answer, and records the range so a restarted hub does not repeat it', async () => {
    await debriefs().scan();

    expect(forks).toEqual([{ args: ['-p', '--resume', NATIVE, '--fork-session', '--session-id', 'fork-1', '--no-session-persistence', '--output-format', 'json'], stdin: 'Report friction in the whole conversation. Subagents: none' }]);
    expect(logLines()).toEqual([
      {
        v: 1,
        at: new Date(now).toISOString(),
        provider: 'claude',
        sessionId: NATIVE,
        parentSessionId: null,
        cwd: CWD,
        fromMessageUuid: null,
        throughMessageUuid: 'msg-last',
        skills: ['gc-plan'],
        toolCalls: 10,
        cache: { read: 900, created: 10, costUsd: 0.05 },
        friction: [friction],
        startedAt: new Date(now).toISOString(),
        subagents: [],
        delegated: [],
      },
    ]);
    expect(readDebriefState(dir)?.sessions[NATIVE]).toEqual({ throughMessageUuid: 'msg-last', debriefedAt: new Date(now).toISOString(), attempts: 0, lastError: null, attemptedAt: null, attemptedThrough: null });

    now += MINUTE;
    await debriefs().scan();

    expect(forks).toHaveLength(1);
  });

  it('asks only about the work after the last debrief once there is enough of it', async () => {
    await debriefs().scan();
    // The operator resumed the session; it ended again 5 minutes later.
    sessions = [session({ endedAt: now + 5 * MINUTE })];
    writeTranscript(`${transcript(10)}\n${transcript(9, 'msg-second', 100)}`, now + 5 * MINUTE);
    now += 50 * MINUTE;
    await debriefs().scan();

    expect(forks).toHaveLength(1);

    writeTranscript(`${transcript(10)}\n${transcript(10, 'msg-second', 100)}`, now - 45 * MINUTE);
    await debriefs().scan();

    expect(forks.map((fork) => fork.stdin)).toEqual(['Report friction in the whole conversation. Subagents: none', 'Report friction in the work after the user message that begins "Task 100". Subagents: none']);
    expect(logLines().map((line) => [line['fromMessageUuid'], line['throughMessageUuid'], line['toolCalls']])).toEqual([
      [null, 'msg-last', 10],
      ['msg-last', 'msg-second', 10],
    ]);
  });

  it('debriefs the sessions of a done work item without waiting, until the hour is past', async () => {
    sessions = [session({ workItemId: 2, endedAt: WRITTEN })];
    now = WRITTEN + MINUTE;
    await debriefs().scan();

    expect(forks).toEqual([]);

    done = [2];
    await debriefs().scan();

    expect(forks).toHaveLength(1);

    writeTranscript(`${transcript(10)}\n${transcript(10, 'msg-second', 100)}`);
    sessions = [session({ workItemId: 2, endedAt: WRITTEN })];
    now = WRITTEN + 60 * MINUTE;
    await debriefs().scan();

    expect(forks).toHaveLength(1);
  });

  it('waits 45 minutes, skips a session past the hour, and needs 10 tool calls', async () => {
    now = WRITTEN + 45 * MINUTE - 1;
    await debriefs().scan();
    now = WRITTEN + 60 * MINUTE;
    await debriefs().scan();
    now = WRITTEN + 50 * MINUTE;
    writeTranscript(transcript(9));
    await debriefs().scan();

    expect(forks).toEqual([]);
  });

  it("debriefs only Switchboard's finished Claude sessions", async () => {
    for (const other of [
      session({ state: 'running', endedAt: null }),
      session({ state: 'waiting', endedAt: null }),
      session({ provider: 'codex' }),
      session({ nativeSessionId: null }),
      session({ endedAt: now - 60 * MINUTE }),
    ]) {
      sessions = [other];
      await debriefs().scan();
    }

    expect(forks).toEqual([]);

    sessions = [session({ state: 'idle', endedAt: null })];
    await debriefs().scan();

    expect(forks).toHaveLength(1);
  });

  it('skips a session the roster shows working, and forks one it shows idle', async () => {
    const entry = { id: 'aaaaaaaa', sessionId: NATIVE, pid: 7, kind: 'background', cwd: CWD };

    roster = [{ ...entry, state: 'working' }];
    await debriefs().scan();

    expect(forks).toEqual([]);

    roster = [{ ...entry, state: 'done' }];
    await debriefs().scan();

    expect(forks).toHaveLength(1);
  });

  it('forks nothing when the roster cannot be read, the setting is off, the prompt is missing or the state is unreadable', async () => {
    roster = { error: 'claude agents failed' };
    await debriefs().scan();
    roster = [];
    enabled = false;
    await debriefs().scan();
    enabled = true;
    rmSync(`${root}/skills/friction-review/prompt.md`);
    await debriefs().scan();
    writeFileSync(`${root}/skills/friction-review/prompt.md`, '{{scope}}');
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/state.json`, '{"v": 2}');
    await debriefs().scan();

    expect(forks).toEqual([]);
    expect(logs).toEqual([
      'debrief: the roster could not be read: claude agents failed',
      `debrief: no prompt at ${root}/skills/friction-review/prompt.md, so no session is debriefed`,
      `debrief: ${dir}/state.json cannot be read; debriefs wait until it can`,
    ]);
  });

  it('reports a failed debrief and does not retry it, but asks again once there is new work', async () => {
    reply = () => ({ code: 1, stdout: '', stderr: 'Session not found', missing: false, timedOut: false });
    const runner = debriefs();

    for (const minutes of [45, 50, 59]) {
      now = WRITTEN + minutes * MINUTE;
      await runner.scan();
    }

    expect(forks).toHaveLength(1);
    expect(logs).toContain(`debrief: ${NATIVE} failed: Claude could not run the debrief: Session not found`);
    expect(readDebriefState(dir)?.sessions[NATIVE]).toEqual({
      throughMessageUuid: null,
      debriefedAt: null,
      attempts: 1,
      lastError: 'Claude could not run the debrief: Session not found',
      attemptedAt: new Date(WRITTEN + 45 * MINUTE).toISOString(),
      attemptedThrough: 'msg-last',
    });

    reply = () => answer();
    sessions = [session({ endedAt: now - 45 * MINUTE })];
    writeTranscript(transcript(11, 'msg-more'), now - 45 * MINUTE);
    await runner.scan();

    expect(forks).toHaveLength(2);
    expect(logLines().map((line) => [line['fromMessageUuid'], line['throughMessageUuid']])).toEqual([[null, 'msg-more']]);
  });

  it('holds an answer it cannot write and forks nothing more until it is written', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/log`, 'not a directory');
    const runner = debriefs();

    await runner.scan();

    const other = 'bbbbbbbb-0000-4000-8000-000000000002';
    const otherPath = `${root}/projects/D--work-42-example/${other}.jsonl`;

    writeFileSync(otherPath, transcript(10, 'msg-other', 0, other));
    utimesSync(otherPath, WRITTEN / 1000, WRITTEN / 1000);
    sessions = [session(), session({ id: 's2', nativeSessionId: other })];
    await runner.scan();

    expect(forks).toHaveLength(1);
    expect(readDebriefState(dir)?.sessions).toEqual({});

    rmSync(`${dir}/log`);
    await runner.scan();

    expect(forks.map((fork) => fork.args[2])).toEqual([NATIVE, other]);
    expect(logLines().map((line) => line['sessionId'])).toEqual([NATIVE, other]);
    expect(readDebriefState(dir)?.sessions[NATIVE]?.throughMessageUuid).toBe('msg-last');
  });

  it("keeps Ground Control's state, and does not debrief again a range it covered", async () => {
    const gc = {
      v: 1,
      sessions: { [NATIVE]: { throughMessageUuid: 'msg-last', debriefedAt: '2026-10-01T00:00:00.000Z', attempts: 0, lastError: null, attemptedAt: null, attemptedThrough: null } },
      codex: { thread: { parentSessionId: NATIVE, pending: false } },
      subagents: { [`${NATIVE}/a1`]: '2026-10-01T00:00:00.000Z' },
    };

    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/state.json`, JSON.stringify(gc));
    await debriefs().scan();

    expect(forks).toEqual([]);

    writeTranscript(`${transcript(10)}\n${transcript(10, 'msg-second', 100)}`);
    await debriefs().scan();

    expect(forks).toHaveLength(1);
    expect(readDebriefState(dir)).toMatchObject({ codex: gc.codex, subagents: gc.subagents, sessions: { [NATIVE]: { throughMessageUuid: 'msg-second' } } });
  });

  it('keeps what another writer stored during a fork, and starts a fresh line after a log line cut short', async () => {
    mkdirSync(`${dir}/log`, { recursive: true });
    writeFileSync(`${dir}/log/2026-10.jsonl`, '{"v":1,"cut');
    writeFileSync(`${dir}/state.json`, JSON.stringify({ v: 1, sessions: { [NATIVE]: null }, codex: {}, subagents: {} }));
    reply = () => {
      writeFileSync(`${dir}/state.json`, JSON.stringify({ v: 1, sessions: { other: { throughMessageUuid: 'x' } }, codex: { thread: { pending: false } }, subagents: {} }));
      return answer();
    };

    await debriefs().scan();

    expect(forks).toHaveLength(1);
    expect(readFileSync(`${dir}/log/2026-10.jsonl`, 'utf8').split('\n')[0]).toBe('{"v":1,"cut');
    expect(JSON.parse(readFileSync(`${dir}/log/2026-10.jsonl`, 'utf8').split('\n')[1]!)).toMatchObject({ sessionId: NATIVE, throughMessageUuid: 'msg-last' });
    expect(readDebriefState(dir)).toMatchObject({ sessions: { other: { throughMessageUuid: 'x' }, [NATIVE]: { throughMessageUuid: 'msg-last' } }, codex: { thread: { pending: false } } });
  });

  it('does not fork when the cache expires or the setting goes off while the roster is read', async () => {
    const runner = new Debriefs({
      dir,
      promptPath: `${root}/skills/friction-review/prompt.md`,
      projectsDir: `${root}/projects`,
      claudePath: 'claude',
      codexScript: `${root}/tools/agent-delegate/debrief.mjs`,
      nodePath: 'node',
      exec,
      enabled: () => enabled,
      sessions: () => sessions,
      workItemDone: (id) => done.includes(id),
      roster: async () => {
        if (now === WRITTEN + 59 * MINUTE) {
          now = WRITTEN + 60 * MINUTE;
        } else {
          enabled = false;
        }

        return { entries: [] };
      },
      now: () => now,
      newId: () => 'fork',
      log: (line) => logs.push(line),
    });

    now = WRITTEN + 59 * MINUTE;
    await runner.scan();
    now = WRITTEN + 50 * MINUTE;
    await runner.scan();

    expect(forks).toEqual([]);
    expect(enabled).toBe(false);
  });

  it('records a fork that throws as a failed debrief and does not retry it, and logs a scan that fails otherwise', async () => {
    reply = () => {
      throw new Error('spawn broke');
    };

    await debriefs().scan();
    now += MINUTE;
    await debriefs().scan();

    expect(forks).toHaveLength(1);
    expect(logs).toContain(`debrief: ${NATIVE} failed: The debrief failed: Error: spawn broke`);
    expect(readDebriefState(dir)?.sessions[NATIVE]?.lastError).toBe('The debrief failed: Error: spawn broke');

    const broken = new Debriefs({
      dir, promptPath: `${root}/skills/friction-review/prompt.md`, projectsDir: `${root}/projects`, claudePath: 'claude', codexScript: '', nodePath: 'node', exec, enabled: () => true,
      sessions: () => {
        throw new Error('store closed');
      },
      workItemDone: () => false, roster: async () => ({ entries: [] }), now: () => now, newId: () => 'fork', log: (line) => logs.push(line),
    });

    await expect(broken.scan()).resolves.toBeUndefined();
    expect(logs.at(-1)).toBe('debrief: the scan failed: Error: store closed');
  });

  /** A transcript whose session delegated `thread` to Codex through agent-delegate. */
  function delegating(thread: string, through = 'msg-last'): string {
    const call = { type: 'assistant', uuid: 'delegate-call', sessionId: NATIVE, message: { content: [{ type: 'tool_use', id: 'toolu_d', name: 'mcp__agent-delegate__delegate', input: {} }] } };
    const result = { type: 'user', uuid: 'delegate-result', sessionId: NATIVE, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_d', content: [{ type: 'text', text: `{"session_id": "${thread}"}` }] }] } };

    return `${transcript(10, 'msg-mid')}\n${JSON.stringify(call)}\n${JSON.stringify(result)}\n${JSON.stringify({ type: 'assistant', uuid: through, sessionId: NATIVE, message: { content: [{ type: 'text', text: 'Done.' }] } })}`;
  }

  /** `delegating('thread-1')`, then 10 more tool calls and a follow-up to the same thread. */
  function followedUp(): string {
    const call = { type: 'assistant', uuid: 'msg-third', sessionId: NATIVE, message: { content: [{ type: 'tool_use', id: 'toolu_d2', name: 'mcp__agent-delegate__follow_up', input: {} }] } };
    const result = { type: 'user', uuid: 'msg-fourth', sessionId: NATIVE, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_d2', content: '{"session_id": "thread-1"}' }] } };

    return `${delegating('thread-1')}\n${transcript(10, 'msg-second', 100)}\n${JSON.stringify(call)}\n${JSON.stringify(result)}`;
  }

  it('asks each Codex thread the session delegated to after the session, and only about its turns since its last debrief', async () => {
    writeTranscript(delegating('thread-1'));
    await debriefs().scan();

    expect(codexCalls).toEqual([{ args: [`${root}/tools/agent-delegate/debrief.mjs`, 'thread-1', '--prompt', `${root}/skills/friction-review/prompt.md`], env: { ELECTRON_RUN_AS_NODE: '1', FRICTION_DEBRIEF: '1' } }]);
    expect(logLines()[0]).toMatchObject({ provider: 'claude', delegated: ['thread-1'] });
    expect(logLines()[1]).toEqual({
      v: 1, at: new Date(now).toISOString(), provider: 'codex', sessionId: 'thread-1', parentSessionId: NATIVE, cwd: CWD,
      fromMessageUuid: null, throughMessageUuid: null, skills: null, toolCalls: null, cache: null, friction: [friction],
    });
    expect(readDebriefState(dir)?.codex['thread-1']).toEqual({ parentSessionId: NATIVE, cwd: CWD, debriefedAt: new Date(now).toISOString(), lastError: null, pending: false, attempts: 0, attemptedAt: null });

    const first = new Date(now).toISOString();

    writeTranscript(followedUp());
    now += MINUTE;
    await debriefs().scan();

    expect(codexCalls[1]?.args.slice(-2)).toEqual(['--since', first]);
  });

  it('records a thread with nothing new without a line, and reports a failed one without retrying it', async () => {
    writeTranscript(delegating('thread-1'));
    codexReply = () => ({ code: 3, stdout: '', stderr: '', missing: false, timedOut: false });
    await debriefs().scan();

    expect(logLines().map((line) => line['provider'])).toEqual(['claude']);
    expect(readDebriefState(dir)?.codex['thread-1']).toMatchObject({ lastError: null, debriefedAt: null });

    writeTranscript(followedUp());
    codexReply = () => ({ code: 1, stdout: '', stderr: 'A delegated turn is running on this thread', missing: false, timedOut: false });
    now += MINUTE;
    await debriefs().scan();
    now += MINUTE;
    await debriefs().scan();

    expect(codexCalls).toHaveLength(2);
    expect(logs).toContain('debrief: Codex thread thread-1 failed: A delegated turn is running on this thread');
    expect(readDebriefState(dir)?.codex['thread-1']).toMatchObject({ lastError: 'A delegated turn is running on this thread', attempts: 1 });
  });

  it('asks the threads of a debrief whose write was held once it is written, and threads a stopped hub left pending', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/log`, 'not a directory');
    writeTranscript(delegating('thread-1'));
    const runner = debriefs();

    await runner.scan();

    expect(codexCalls).toEqual([]);

    rmSync(`${dir}/log`);
    await runner.scan();

    expect(forks).toHaveLength(1);
    expect(codexCalls.map((call) => call.args[1])).toEqual(['thread-1']);
    expect(readDebriefState(dir)?.codex['thread-1']).toMatchObject({ pending: false });

    const state = readDebriefState(dir)!;
    writeFileSync(`${dir}/state.json`, JSON.stringify({ ...state, codex: { ...state.codex, 'thread-2': { parentSessionId: NATIVE, cwd: CWD, debriefedAt: null, lastError: null, pending: true, attempts: 0, attemptedAt: null } } }));
    await debriefs().scan();

    expect(codexCalls.map((call) => call.args[1])).toEqual(['thread-1', 'thread-2']);
    expect(forks).toHaveLength(1);
  });

  it("forks nothing while a pending thread's answer cannot be written", async () => {
    mkdirSync(`${dir}/log`, { recursive: true });
    writeFileSync(`${dir}/state.json`, JSON.stringify({ v: 1, sessions: {}, codex: { 'thread-0': { parentSessionId: 'p', cwd: CWD, debriefedAt: null, lastError: null, pending: true, attempts: 0, attemptedAt: null } }, subagents: {} }));
    rmSync(`${dir}/log`, { recursive: true });
    writeFileSync(`${dir}/log`, 'not a directory');
    const runner = debriefs();

    await runner.scan();

    expect(codexCalls.map((call) => call.args[1])).toEqual(['thread-0']);
    expect(forks).toEqual([]);

    rmSync(`${dir}/log`);
    await runner.scan();

    expect(codexCalls.map((call) => call.args[1])).toEqual(['thread-0']);
    expect(forks).toHaveLength(1);
    expect(logLines().map((line) => line['sessionId'])).toEqual(['thread-0', NATIVE]);
  });

  it('skips Codex threads when the command is missing', async () => {
    rmSync(`${root}/tools/agent-delegate/debrief.mjs`);
    writeTranscript(delegating('thread-1'));
    await debriefs().scan();

    expect(forks).toHaveLength(1);
    expect(codexCalls).toEqual([]);
    expect(logs).toContain(`debrief: no Codex debrief command at ${root}/tools/agent-delegate/debrief.mjs, so delegated Codex threads are not debriefed`);
  });

  it('runs one scan at a time and counts as running while a fork runs', async () => {
    let finish: (result: ExecResult) => void = () => {};
    reply = () => new Promise((done) => (finish = done));
    const runner = debriefs();
    const scan = runner.scan();

    await until(() => (forks.length > 0 ? true : null));

    expect(runner.running()).toBe(true);

    await runner.scan();
    finish(answer([]));
    await scan;

    expect(runner.running()).toBe(false);
    expect(forks).toHaveLength(1);
    expect(logLines()[0]?.['friction']).toEqual([]);
  });
});
