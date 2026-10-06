import { describe, expect, it } from 'vitest';
import { cliEnvironment, failureOf, spawnExec } from '../src/exec.js';

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

describe('cliEnvironment', () => {
  it('leaves out VS Code and Electron variables', () => {
    expect(cliEnvironment({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '2', NODE_OPTIONS: '--x', CLAUDE_CONFIG_DIR: 'c' })).toEqual({ PATH: 'p', CLAUDE_CONFIG_DIR: 'c' });
  });
});

describe('failureOf', () => {
  it('prefers stderr, then stdout, then the exit code', () => {
    const base = { code: 1, stdout: '', stderr: '', missing: false, timedOut: false };

    expect(failureOf('claude', { ...base, stderr: ' err ' }, 1000)).toBe('err');
    expect(failureOf('claude', { ...base, stdout: 'out' }, 1000)).toBe('out');
    expect(failureOf('claude', base, 1000)).toBe('claude exited with code 1.');
  });
});
