import { describe, expect, it } from 'vitest';
import { browserCommand, launchEnvironment, launcher } from '../src/launch.js';

describe('launcher (architecture.md § Web page)', () => {
  it("opens a URL in the default browser with each system's opener, the URL one argument and no shell", () => {
    expect(browserCommand('https://x.test/?a=1&b=2', 'win32')).toEqual({ file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'https://x.test/?a=1&b=2'] });
    expect(browserCommand('https://x.test/', 'darwin')).toEqual({ file: 'open', args: ['https://x.test/'] });
    expect(browserCommand('https://x.test/', 'linux')).toEqual({ file: 'xdg-open', args: ['https://x.test/'] });
  });

  it('starts a program without the Electron and VS Code variables, and refuses a URL that is not http or https', () => {
    const runs: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const launch = launcher((file, args, env) => runs.push({ file, args, env }), 'linux', { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '7' });

    launch.openUrl('https://x.test/#switchboard-tab');
    expect(runs).toEqual([{ file: 'xdg-open', args: ['https://x.test/#switchboard-tab'], env: { PATH: '/bin' } }]);
    expect(() => launch.openUrl('javascript:alert(1)')).toThrow('Only an http or https URL opens.');
    expect(() => launch.openUrl('file:///etc/passwd')).toThrow();
    expect(runs).toHaveLength(1);
    expect(launchEnvironment({ Electron_X: '1', vscode_y: '2', HOME: '/h' })).toEqual({ HOME: '/h' });
  });
});
