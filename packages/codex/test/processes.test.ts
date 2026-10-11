import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exec, ExecResult } from '@switchboard/core';
import { findTagged, killTree, pidAlive, queryProcesses, runTag, sameProcess, spawnDetached } from '../src/processes.js';

const CIM = readFileSync(join(import.meta.dirname, 'fixtures', 'cim-tagged.json'), 'utf8');
const ran = (patch: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...patch });

describe('sameProcess and runTag', () => {
  it('needs the PID and the creation time to match', () => {
    expect(sameProcess({ pid: 1, created: '5' }, { pid: 1, created: '5' })).toBe(true);
    expect(sameProcess({ pid: 1, created: '5' }, { pid: 1, created: '6' })).toBe(false);
    expect(sameProcess(null, { pid: 1, created: '5' })).toBe(false);
    expect(runTag('s1', 2)).toBe('s1-2');
  });
});

describe('queryProcesses', () => {
  it('asks once for every PID and maps the answer by PID', async () => {
    const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: `[${CIM}]` }));
    const found = await queryProcesses(exec, [66532, 66532, 0, 7]);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![2]!.timeoutMs).toBe(15_000);
    expect(exec.mock.calls[0]![1].at(-1)).toContain('ProcessId=66532 OR ProcessId=7');
    expect(found).toEqual(new Map([[66532, JSON.parse(CIM)]]));
  });

  it('asks nothing for no PIDs, and reports a failed or unreadable query', async () => {
    const exec = vi.fn<Exec>();

    expect(await queryProcesses(exec, [])).toEqual(new Map());
    expect(exec).not.toHaveBeenCalled();
    expect(await queryProcesses(vi.fn<Exec>().mockResolvedValue(ran({ code: 1, stderr: 'denied' })), [1])).toEqual({ error: 'denied' });
    expect(await queryProcesses(vi.fn<Exec>().mockResolvedValue(ran({ code: 1 })), [1])).toEqual({ error: 'The process query exited with code 1.' });
    expect(await queryProcesses(vi.fn<Exec>().mockResolvedValue(ran({ stdout: 'oops' })), [1])).toEqual({ error: 'The process query returned output that is not JSON.' });
    expect(await queryProcesses(vi.fn<Exec>().mockResolvedValue(ran({ stdout: '{}' })), [1])).toEqual({ error: 'The process query returned an unexpected answer.' });
  });
});

describe('findTagged', () => {
  it('finds the process whose command line carries exactly the tag', async () => {
    const recorded = JSON.parse(CIM) as { commandLine: string };
    const longer = { ...recorded, pid: 9, commandLine: recorded.commandLine.replace('sbtest42-1', 'sbtest42-10') };
    const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: JSON.stringify([recorded, longer]) }));

    expect(await findTagged(exec, 'sbtest42-1')).toEqual({ pid: 66532, created: '134361595707620230' });
    expect(exec.mock.calls[0]![1].at(-1)).toContain("CommandLine LIKE '%switchboard_run=%sbtest42-1%'");
  });

  it('finds none, refuses two and refuses a tag that is not plain', async () => {
    const recorded = JSON.parse(CIM) as object;

    expect(await findTagged(vi.fn<Exec>().mockResolvedValue(ran({ stdout: '[]' })), 's1-1')).toBeNull();
    expect(await findTagged(vi.fn<Exec>().mockResolvedValue(ran({ stdout: JSON.stringify([recorded, { ...recorded, pid: 2 }]) })), 'sbtest42-1')).toEqual({ error: '2 Codex processes carry the run tag sbtest42-1.' });
    expect(await findTagged(vi.fn<Exec>(), "s1'1")).toEqual({ error: "Invalid run tag s1'1." });
    expect(await findTagged(vi.fn<Exec>().mockResolvedValue(ran({ code: 1, stderr: 'x' })), 's1-1')).toEqual({ error: 'x' });
  });
});

describe('killTree and pidAlive', () => {
  it('ends the tree, counts a missing process as ended and reports another failure', async () => {
    const exec = vi.fn<Exec>().mockResolvedValueOnce(ran({})).mockResolvedValueOnce(ran({ code: 128 })).mockResolvedValueOnce(ran({ code: 1, stderr: 'Access denied' }));

    expect(await killTree(exec, 5)).toBeNull();
    expect(exec).toHaveBeenCalledWith('taskkill', ['/pid', '5', '/T', '/F'], expect.anything());
    expect(await killTree(exec, 5)).toBeNull();
    expect(await killTree(exec, 5)).toEqual({ error: 'Access denied' });
  });

  it('tells a live PID from one with no process', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 30)).toBe(false);
  });
});

describe('spawnDetached', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'switchboard-spawn-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts a process with its output in files and the arguments unchanged', async () => {
    const stdout = join(dir, 'out.jsonl');
    const stderr = join(dir, 'err.txt');
    const spawned = await spawnDetached(process.execPath, ['-e', 'console.log(process.argv[1]); console.error(process.env.SPAWN_TEST)', '/gc-plan "1"'], { cwd: dir, stdout, stderr, env: { SPAWN_TEST: 'yes' } });

    expect(spawned.error).toBeNull();
    expect(spawned.pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(readFileSync(stderr, 'utf8').trim()).toBe('yes'));
    expect(readFileSync(stdout, 'utf8').trim()).toBe('/gc-plan "1"');
  });

  it('reports a missing executable', async () => {
    const spawned = await spawnDetached(join(dir, 'missing.exe'), [], { cwd: dir, stdout: join(dir, 'o'), stderr: join(dir, 'e') });

    expect(spawned).toEqual({ pid: null, error: expect.stringContaining('ENOENT') });
    expect(existsSync(join(dir, 'o'))).toBe(true);
  });
});
