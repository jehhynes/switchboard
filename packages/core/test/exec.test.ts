import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliEnvironment, executableDirOnPath } from '../src/exec.js';

describe('cliEnvironment', () => {
  it('leaves out VS Code and Electron variables', () => {
    expect(cliEnvironment({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '2', NODE_OPTIONS: '--x', CLAUDE_CONFIG_DIR: 'c' })).toEqual({ PATH: 'p', CLAUDE_CONFIG_DIR: 'c' });
  });
});

describe('executableDirOnPath', () => {
  it('leaves a bare name to PATH and puts an absolute path\'s directory first, keeping the spelling of PATH', () => {
    const bin = join(tmpdir(), 'nvm', 'bin');

    expect(executableDirOnPath('codex', { PATH: '/usr/bin' })).toEqual({});
    expect(executableDirOnPath(join(bin, 'codex'), { PATH: '/usr/bin' })).toEqual({ PATH: `${bin}${delimiter}/usr/bin` });
    expect(executableDirOnPath(join(bin, 'codex'), { Path: 'C:\\Windows' })).toEqual({ Path: `${bin}${delimiter}C:\\Windows` });
    expect(executableDirOnPath(join(bin, 'codex'), {})).toEqual({ PATH: bin });
  });

  it("reads the path by the platform's rules", () => {
    expect(executableDirOnPath('C:/Codex/bin/codex.exe', { Path: 'C:\\Windows' }, 'win32')).toEqual({ Path: 'C:/Codex/bin;C:\\Windows' });
    expect(executableDirOnPath('C:/Codex/bin/codex.exe', { PATH: '/usr/bin' }, 'linux')).toEqual({});
    expect(executableDirOnPath('/opt/codex/bin/codex', { PATH: '/usr/bin' }, 'linux')).toEqual({ PATH: '/opt/codex/bin:/usr/bin' });
  });
});
