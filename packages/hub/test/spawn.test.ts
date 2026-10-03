import { describe, expect, it } from 'vitest';
import { spawnEnvironment } from '../src/spawn.js';

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
