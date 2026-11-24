import { describe, expect, it } from 'vitest';
import { dropColourOverrides, spawnEnvironment } from '../src/spawn.js';

describe('dropColourOverrides', () => {
  it('removes NO_COLOR and FORCE_COLOR in any case and keeps the rest', () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:/bin', NO_COLOR: '1', force_color: '0', NO_COLORS: 'kept', TERM: 'xterm-256color' };

    dropColourOverrides(env);
    expect(env).toEqual({ PATH: 'C:/bin', NO_COLORS: 'kept', TERM: 'xterm-256color' });
  });
});

describe('spawnEnvironment', () => {
  it('drops VS Code and Electron variables and runs Electron as Node, leaving the input unchanged', () => {
    const input = {
      PATH: 'C:/bin',
      VSCODE_PID: '1',
      VSCODE_IPC_HOOK: 'pipe',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      NODE_OPTIONS: '--inspect',
      USERPROFILE: 'C:/Users/someone',
    };

    expect(spawnEnvironment(input)).toEqual({ PATH: 'C:/bin', USERPROFILE: 'C:/Users/someone', ELECTRON_RUN_AS_NODE: '1' });
    expect(input.VSCODE_PID).toBe('1');
  });
});
