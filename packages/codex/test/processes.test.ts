import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exec, ExecResult } from '@switchboard/core';
import { findTagged, isCodex, killTree, pidAlive, queryProcesses, runTag, sameProcess, spawnDetached } from '../src/processes.js';

const CIM = readFileSync(join(import.meta.dirname, 'fixtures', 'cim-tagged.json'), 'utf8');
const WINDOWS = { platform: 'win32' } as const;
const LINUX = { platform: 'linux', proc: join(import.meta.dirname, 'fixtures', 'proc') } as const;
const ran = (patch: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...patch });

describe('sameProcess and runTag', () => {
  it('needs the PID and the creation time to match', () => {
    expect(sameProcess({ pid: 1, created: '5' }, { pid: 1, created: '5' })).toBe(true);
    expect(sameProcess({ pid: 1, created: '5' }, { pid: 1, created: '6' })).toBe(false);
    expect(sameProcess(null, { pid: 1, created: '5' })).toBe(false);
    expect(runTag('s1')).toBe('s1');
  });
});

describe('queryProcesses', () => {
  it('asks once for every PID and maps the answer by PID', async () => {
    const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: `[${CIM}]` }));
    const found = await queryProcesses(exec, [66532, 66532, 0, 7], WINDOWS);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![2]!.timeoutMs).toBe(15_000);
    expect(exec.mock.calls[0]![1].at(-1)).toContain('ProcessId=66532 OR ProcessId=7');
    expect(found).toEqual(new Map([[66532, JSON.parse(CIM)]]));
  });

  it('asks nothing for no PIDs, and reports a failed or unreadable query', async () => {
    const exec = vi.fn<Exec>();

    expect(await queryProcesses(exec, [], WINDOWS)).toEqual(new Map());
    expect(exec).not.toHaveBeenCalled();
    expect(await queryProcesses(vi.fn<Exec>().mockResolvedValue(ran({ code: 1, stderr: 'denied' })), [1], WINDOWS)).toEqual({ error: 'denied' });
    expect(await queryProcesses(vi.fn<Exec>().mockResolvedValue(ran({ code: 1 })), [1], WINDOWS)).toEqual({ error: 'The process query exited with code 1.' });
    expect(await queryProcesses(vi.fn<Exec>().mockResolvedValue(ran({ stdout: 'oops' })), [1], WINDOWS)).toEqual({ error: 'The process query returned output that is not JSON.' });
    expect(await queryProcesses(vi.fn<Exec>().mockResolvedValue(ran({ stdout: '{}' })), [1], WINDOWS)).toEqual({ error: 'The process query returned an unexpected answer.' });
  });
});

describe('findTagged', () => {
  it('finds the process whose command line carries exactly the tag', async () => {
    const recorded = JSON.parse(CIM) as { commandLine: string };
    const longer = { ...recorded, pid: 9, commandLine: recorded.commandLine.replace('sbtest42-1', 'sbtest42-10') };
    const exec = vi.fn<Exec>().mockResolvedValue(ran({ stdout: JSON.stringify([recorded, longer]) }));

    expect(await findTagged(exec, 'sbtest42-1', WINDOWS)).toEqual({ pid: 66532, created: '134361595707620230' });
    expect(exec.mock.calls[0]![1].at(-1)).toContain("CommandLine LIKE '%switchboard_run=%sbtest42-1%'");
  });

  it('finds none, refuses two and refuses a tag that is not plain', async () => {
    const recorded = JSON.parse(CIM) as object;

    expect(await findTagged(vi.fn<Exec>().mockResolvedValue(ran({ stdout: '[]' })), 's1', WINDOWS)).toBeNull();
    expect(await findTagged(vi.fn<Exec>().mockResolvedValue(ran({ stdout: JSON.stringify([recorded, { ...recorded, pid: 2 }]) })), 'sbtest42-1', WINDOWS)).toEqual({ error: '2 Codex processes carry the run tag sbtest42-1.' });
    expect(await findTagged(vi.fn<Exec>(), "s1'1", WINDOWS)).toEqual({ error: "Invalid run tag s1'1." });
    expect(await findTagged(vi.fn<Exec>().mockResolvedValue(ran({ code: 1, stderr: 'x' })), 's1', WINDOWS)).toEqual({ error: 'x' });
  });
});

describe('the Linux process table', () => {
  const unexpected = vi.fn<Exec>(async () => {
    throw new Error('unexpected exec');
  });
  const launcher = { pid: 1223833, created: '52195984', name: 'MainThread', commandLine: 'node /home/operator/.nvm/versions/node/v24.18.0/bin/codex app-server -c switchboard_run="sbtest42-1"' };

  it('reads each live PID from /proc, leaving out a missing process and a zombie, without running a command', async () => {
    const found = await queryProcesses(unexpected, [1223833, 1223850, 7], LINUX);

    expect(found).toEqual(new Map([[1223833, launcher]]));
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("finds Codex itself by its tag, not npm's launcher that carries the same tag, and refuses an unreadable /proc", async () => {
    expect(await findTagged(unexpected, 'sbtest42-1', LINUX)).toEqual({ pid: 1223843, created: '52195987' });
    expect(await findTagged(unexpected, 'sbtest42', LINUX)).toBeNull();
    expect(await findTagged(unexpected, 'sbtest42-1', { platform: 'linux', proc: join(import.meta.dirname, 'missing') })).toEqual({ error: expect.stringContaining('could not be read') });
    expect(isCodex('codex')).toBe(true);
    expect(isCodex('Codex.exe')).toBe(true);
    expect(isCodex('MainThread')).toBe(false);
    expect(isCodex('codex-linux')).toBe(false);
  });

  it('ends the tree found in /proc, but not a member whose PID another process took after the scan, nor a zombie', async () => {
    const proc = mkdtempSync(join(tmpdir(), 'switchboard-proc-'));

    try {
      cpSync(LINUX.proc, proc, { recursive: true });
      const signaled: number[] = [];
      const table = { platform: 'linux', proc, signal: (pid: number) => signaled.push(pid) } as const;

      expect(await killTree(unexpected, 1223833, table)).toBeNull();
      expect(signaled).toEqual([1223833, 1223843]);

      signaled.length = 0;
      const reused = (pid: number) => {
        signaled.push(pid);
        // The child exits once its launcher is ended, and a new process starts with its PID.
        writeFileSync(join(proc, '1223843', 'stat'), readFileSync(join(proc, '1223843', 'stat'), 'utf8').replace(' 52195987 ', ' 52199999 '));
      };

      expect(await killTree(unexpected, 1223833, { ...table, signal: reused })).toBeNull();
      expect(signaled).toEqual([1223833]);

      signaled.length = 0;
      expect(await killTree(unexpected, 7, table)).toBeNull();
      expect(signaled).toEqual([]);
    } finally {
      rmSync(proc, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('ends a process and its child, and counts a process that is gone as ended', async () => {
    const parent = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const child = Number.parseInt(await new Promise<string>((done) => parent.stdout.once('data', (data: Buffer) => done(data.toString()))), 10);

    expect(pidAlive(child)).toBe(true);
    expect(await killTree(unexpected, parent.pid!)).toBeNull();
    await vi.waitFor(() => expect([pidAlive(parent.pid!), pidAlive(child)]).toEqual([false, false]));
    expect(await killTree(unexpected, parent.pid!)).toBeNull();
    expect(unexpected).not.toHaveBeenCalled();
  });
});

describe('killTree and pidAlive', () => {
  it('ends the tree, counts a missing process as ended and reports another failure', async () => {
    const exec = vi.fn<Exec>().mockResolvedValueOnce(ran({})).mockResolvedValueOnce(ran({ code: 128 })).mockResolvedValueOnce(ran({ code: 1, stderr: 'Access denied' }));

    expect(await killTree(exec, 5, WINDOWS)).toBeNull();
    expect(exec).toHaveBeenCalledWith('taskkill', ['/pid', '5', '/T', '/F'], expect.anything());
    expect(await killTree(exec, 5, WINDOWS)).toBeNull();
    expect(await killTree(exec, 5, WINDOWS)).toEqual({ error: 'Access denied' });
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
    const spawned = await spawnDetached(process.execPath, ['-e', 'console.log(process.argv[1]); console.error(process.env.SPAWN_TEST)', '/sb-plan "1"'], { cwd: dir, stdout, stderr, env: { SPAWN_TEST: 'yes' } });

    expect(spawned.error).toBeNull();
    expect(spawned.pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(readFileSync(stderr, 'utf8').trim()).toBe('yes'));
    expect(readFileSync(stdout, 'utf8').trim()).toBe('/sb-plan "1"');
  });

  it('reports a missing executable', async () => {
    const spawned = await spawnDetached(join(dir, 'missing.exe'), [], { cwd: dir, stdout: join(dir, 'o'), stderr: join(dir, 'e') });

    expect(spawned).toEqual({ pid: null, error: expect.stringContaining('ENOENT') });
    expect(existsSync(join(dir, 'o'))).toBe(true);
  });
});
