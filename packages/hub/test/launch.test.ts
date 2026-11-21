import { describe, expect, it } from 'vitest';
import { browserCommand, codeExecutable, launchEnvironment, launcher } from '../src/launch.js';

describe('launcher (architecture.md § Web page)', () => {
  it("opens a URL in the default browser with each system's opener, the URL one argument and no shell", () => {
    expect(browserCommand('https://x.test/?a=1&b=2', 'win32')).toEqual({ file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'https://x.test/?a=1&b=2'] });
    expect(browserCommand('https://x.test/', 'darwin')).toEqual({ file: 'open', args: ['https://x.test/'] });
    expect(browserCommand('https://x.test/', 'linux')).toEqual({ file: 'xdg-open', args: ['https://x.test/'] });
  });

  it('starts a program without the Electron and VS Code variables, and refuses a URL that is not http or https', () => {
    const runs: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const launch = launcher((file, args, env) => runs.push({ file, args, env }), 'linux', { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '7' });

    launch.openUrl('https://x.test/a?b=1#c');
    expect(runs).toEqual([{ file: 'xdg-open', args: ['https://x.test/a?b=1#c'], env: { PATH: '/bin' } }]);
    expect(() => launch.openUrl('javascript:alert(1)')).toThrow('Only an http or https URL opens.');
    expect(() => launch.openUrl('file:///etc/passwd')).toThrow();
    expect(runs).toHaveLength(1);
    expect(launchEnvironment({ Electron_X: '1', vscode_y: '2', HOME: '/h' })).toEqual({ HOME: '/h' });
  });

  it('finds VS Code as the dock does: Code.exe beside code.cmd on PATH, else the per-user install, else code on PATH elsewhere', () => {
    const env = { PATH: 'C:\\Windows;C:\\VS Code\\bin', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
    const has = (...paths: string[]) => (path: string) => paths.includes(path);

    expect(codeExecutable('win32', env, has('C:\\VS Code\\bin\\code.cmd', 'C:\\VS Code\\Code.exe'))).toBe('C:\\VS Code\\Code.exe');
    expect(codeExecutable('win32', env, has('C:\\Users\\a\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'))).toBe('C:\\Users\\a\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe');
    expect(() => codeExecutable('win32', env, has())).toThrow('Code.exe was not found beside code on PATH.');
    expect(codeExecutable('linux', { PATH: '/usr/bin:/snap/bin' }, has('/snap/bin/code'))).toBe('/snap/bin/code');
    expect(() => codeExecutable('linux', { PATH: '/usr/bin' }, has())).toThrow('code was not found on PATH.');

    const runs: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];

    launcher((file, args, env) => runs.push({ file, args, env }), 'linux', { PATH: '/snap/bin', ELECTRON_RUN_AS_NODE: '1' }, has('/snap/bin/code')).openCode('/w/sb.code-workspace');
    expect(runs).toEqual([{ file: '/snap/bin/code', args: ['/w/sb.code-workspace'], env: { PATH: '/snap/bin' } }]);
  });
});
