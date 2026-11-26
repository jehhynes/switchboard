import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySampler, killTree, procTable, treeOf, windowsTable } from '../src/processes.js';
import type { ProcessRow, RunFile } from '../src/processes.js';
import { until } from './fakes.js';

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const row = (pid: number, ppid: number, created: string, memoryBytes: number): ProcessRow => ({ pid, ppid, created, memoryBytes });

/** Answers only the expected command, and fails the test on any other. */
function fakeRun(answer: { code: number | null; stdout?: string; stderr?: string }, expected: string, calls: Array<[string, string[]]> = []): RunFile {
  return (file, args) => {
    calls.push([file, args]);

    if (file !== expected) {
      throw new Error(`Unexpected command ${file}`);
    }

    return Promise.resolve({ code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' });
  };
}

describe('treeOf', () => {
  it('returns the root and its descendants, and skips a child listed under a reused parent pid', () => {
    const rows = [row(10, 1, '100', 5), row(11, 10, '110', 7), row(12, 11, '120', 11), row(13, 10, '50', 1000), row(20, 1, '130', 3)];

    expect(treeOf(rows, 10).map((one) => one.pid)).toEqual([10, 11, 12]);
    expect(treeOf(rows, 99)).toEqual([]);
  });
});

describe('windowsTable', () => {
  it('reads the CIM rows from Windows PowerShell', async () => {
    const calls: Array<[string, string[]]> = [];
    const rows = await windowsTable(fakeRun({ code: 0, stdout: '[[4,0,"",100],[500,4,"133700000000000000",2048],"junk"]' }, 'powershell', calls));

    expect(rows).toEqual([row(4, 0, '', 100), row(500, 4, '133700000000000000', 2048)]);
    expect(calls[0]![0]).toBe('powershell');
    expect(calls[0]![1].slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
  });

  it.each([
    [{ code: 1, stderr: 'Access denied' }, 'Access denied'],
    [{ code: 2 }, 'The process query exited with code 2.'],
    [{ code: 0, stdout: '{"a":1}' }, 'The process query returned an unexpected answer.'],
    [{ code: 0, stdout: 'not json' }, 'The process query returned output that is not JSON.'],
  ])('returns the error of a failed query', async (answer, error) => {
    expect(await windowsTable(fakeRun(answer, 'powershell'))).toEqual({ error });
  });
});

describe('procTable', () => {
  it('reads parent, start time and resident memory, skipping zombies and unreadable entries', () => {
    const proc = mkdtempSync(join(tmpdir(), 'proc-'));

    temps.push(proc);

    const add = (pid: number, stat: string, statm: string) => {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), 'stat'), stat);
      writeFileSync(join(proc, String(pid), 'statm'), statm);
    };
    const fields = (state: string, ppid: number, start: number) => [state, ppid, ...Array<number>(17).fill(0), start, 0].join(' ');

    add(100, `100 (claude (main)) ${fields('S', 1, 5000)}`, '1000 250 10 1 0 100 0');
    add(101, `101 (sh) ${fields('Z', 100, 5001)}`, '0 0 0 0 0 0 0');
    mkdirSync(join(proc, '102'));
    mkdirSync(join(proc, 'self'));

    expect(procTable(proc)).toEqual([row(100, 1, '5000', 250 * 4096)]);
    expect(procTable(join(proc, 'missing'))).toMatchObject({ error: expect.stringContaining('could not be read') as unknown });
  });
});

describe('killTree', () => {
  it('runs taskkill on the tree on Windows and counts a process that is gone as ended', async () => {
    const calls: Array<[string, string[]]> = [];

    expect(await killTree(42, 'win32', fakeRun({ code: 0 }, 'taskkill', calls))).toBeNull();
    expect(calls).toEqual([['taskkill', ['/pid', '42', '/T', '/F']]]);
    expect(await killTree(42, 'win32', fakeRun({ code: 128 }, 'taskkill'))).toBeNull();
    expect(await killTree(42, 'win32', fakeRun({ code: 1, stderr: 'Access is denied.' }, 'taskkill'))).toEqual({ error: 'Access is denied.' });
  });

  it('signals each member of the tree elsewhere, skipping a member whose pid another process took since the scan', async () => {
    const proc = mkdtempSync(join(tmpdir(), 'proc-'));

    temps.push(proc);

    const fields = (ppid: number, start: number) => ['S', ppid, ...Array<number>(17).fill(0), start, 0].join(' ');
    const add = (pid: number, ppid: number, start: number) => {
      mkdirSync(join(proc, String(pid)), { recursive: true });
      writeFileSync(join(proc, String(pid), 'stat'), `${pid} (p) ${fields(ppid, start)}`);
      writeFileSync(join(proc, String(pid), 'statm'), '1 1 0 0 0 0 0');
    };

    add(10, 1, 100);
    add(11, 10, 110);
    add(12, 11, 120);
    add(20, 1, 130);

    const signalled: number[] = [];
    const signal = (pid: number) => {
      signalled.push(pid);

      // Ending 10 lets 11 exit, and a new process takes PID 11 before it is signalled.
      if (pid === 10) {
        add(11, 1, 999);
      }
    };

    expect(await killTree(10, 'linux', fakeRun({ code: 0 }, 'none'), signal, proc)).toBeNull();
    expect(signalled).toEqual([10, 12]);
  });

  it('reports a signal it may not send, and ignores a process already gone', async () => {
    const proc = mkdtempSync(join(tmpdir(), 'proc-'));

    temps.push(proc);
    mkdirSync(join(proc, '10'));
    writeFileSync(join(proc, '10', 'stat'), `10 (p) ${['S', 1, ...Array<number>(17).fill(0), 100, 0].join(' ')}`);
    writeFileSync(join(proc, '10', 'statm'), '1 1 0 0 0 0 0');

    const failing = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };

    expect(await killTree(10, 'linux', fakeRun({ code: 0 }, 'none'), failing('ESRCH'), proc)).toBeNull();
    expect(await killTree(10, 'linux', fakeRun({ code: 0 }, 'none'), failing('EPERM'), proc)).toEqual({ error: 'Process 10 could not be ended: EPERM' });
    expect(await killTree(10, 'linux', fakeRun({ code: 0 }, 'none'), failing('EPERM'), join(proc, 'missing'))).toMatchObject({ error: expect.stringContaining('could not be read') as unknown });
  });
});

describe('MemorySampler', () => {
  it('sums each tree from the last read and keeps it for list', async () => {
    let reads = 0;
    const sampler = new MemorySampler(() => [10, 30], () => {
      reads++;

      return Promise.resolve([row(10, 1, '100', 5), row(11, 10, '110', 7), row(20, 1, '130', 3)]);
    });

    expect(sampler.memory([10])).toEqual(new Map());
    await sampler.sample();
    expect(reads).toBe(1);
    expect(sampler.memory([10, 30])).toEqual(new Map([[10, 12]]));
    expect(sampler.tree(10)).toEqual([{ pid: 10, created: '100' }, { pid: 11, created: '110' }]);
  });

  it('reads nothing with no live session, and keeps the last values when a read fails', async () => {
    const errors: string[] = [];
    let answer: ProcessRow[] | { error: string } = [row(10, 1, '100', 5)];
    let pids: number[] = [];
    const sampler = new MemorySampler(() => pids, () => Promise.resolve(answer), 30_000, (error) => errors.push(error));

    await sampler.sample();
    expect(errors).toEqual([]);
    pids = [10];
    await sampler.sample();
    answer = { error: 'no table' };
    await sampler.sample();
    expect(errors).toEqual(['no table']);
    expect(sampler.memory([10])).toEqual(new Map([[10, 5]]));
  });

  it('reads again once a read ends when a sample was asked for during it, with the pids of then, and only once', async () => {
    const reads: Array<{ pids: number[]; done: (rows: ProcessRow[]) => void }> = [];
    let pids = [10];
    const sampler = new MemorySampler(() => pids, () => new Promise<ProcessRow[]>((done) => reads.push({ pids: [...pids], done })));
    const first = sampler.sample();

    // A session held while the first read runs, and two asks for it.
    pids = [10, 20];
    void sampler.sample();
    void sampler.sample();
    expect(reads).toHaveLength(1);
    reads[0]!.done([row(10, 1, '100', 5)]);
    await first;
    await until(() => expect(reads).toHaveLength(2));
    expect(reads[1]!.pids).toEqual([10, 20]);
    reads[1]!.done([row(10, 1, '100', 5), row(20, 1, '120', 4)]);
    await until(() => expect(sampler.tree(20)).toEqual([{ pid: 20, created: '120' }]));
    expect(reads).toHaveLength(2);
  });
});
