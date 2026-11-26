import { describe, expect, it } from 'vitest';
import { spawnExec } from '../src/exec.js';

describe('spawnExec', () => {
  it('passes stdin and arguments without a shell, and returns the exit code and output', async () => {
    const result = await spawnExec(process.execPath, ['-e', 'process.stdin.pipe(process.stdout); console.error(process.argv[1])', '/slash arg'], { stdin: 'from stdin', timeoutMs: 10_000 });

    expect(result).toEqual({ code: 0, stdout: 'from stdin', stderr: '/slash arg\n', missing: false, timedOut: false });
  });

  it('adds the variables it is given to the environment', async () => {
    const result = await spawnExec(process.execPath, ['-e', 'process.stdout.write(process.env.FRICTION_DEBRIEF ?? "unset")'], { timeoutMs: 10_000, env: { FRICTION_DEBRIEF: '1' } });

    expect(result.stdout).toBe('1');
  });

  it('reports a missing executable and a timeout', async () => {
    expect(await spawnExec('D:/no/such/claude.exe', [], { timeoutMs: 10_000 })).toMatchObject({ code: null, missing: true });
    expect(await spawnExec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 })).toMatchObject({ timedOut: true });
  });
});
