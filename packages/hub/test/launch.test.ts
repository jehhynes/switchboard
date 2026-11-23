import { describe, expect, it } from 'vitest';
import { browserCommand, codeExecutable, launchEnvironment, launcher } from '../src/launch.js';

describe('launcher (architecture.md § Web page)', () => {
  it('opens the dock terminal app with literal attach arguments and without session markers', async () => {
    const runs: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run = (file: string, args: string[], env: NodeJS.ProcessEnv) => { runs.push({ file, args, env }); };
    const terminal = { provider: 'claude' as const, sessionId: 's7', cwd: 'D:/scratch & work', name: 'sb:gh 7', title: 'Switchboard · gh 7', args: ['D:/home/hub.js', 'attach', 's7'], executable: 'D:\\node\\node.exe', active: false, handoff: null, codeMode: true as const };
    await launcher(run, 'win32', { Path: 'C:\\Windows', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'outer', CLAUDE_CODE_MESSAGING_X: 'x', VSCODE_PID: '7', CLAUDE_CODE_USE_BEDROCK: '1' }).openTerminal!(terminal);
    expect(runs).toEqual([{ file: 'wt.exe', args: ['-w', 'new', '--title', 'Switchboard · gh 7', '--suppressApplicationTitle', '-d', 'D:/scratch & work', '--', 'D:\\node\\node.exe', 'D:/home/hub.js', 'attach', 's7'], env: { Path: 'D:\\node;C:\\Windows', CLAUDE_CODE_USE_BEDROCK: '1' } }]);
    runs.length = 0;
    await launcher(run, 'linux', { PATH: '/usr/bin' }).openTerminal!({ ...terminal, cwd: '/scratch & work', executable: '/opt/node/bin/node', args: ['/home/test/hub.js', 'attach', 's7'] });
    expect(runs).toEqual([{ file: 'ptyxis', args: ['--new-window', '-T', 'Switchboard · gh 7', '-d', '/scratch & work', '--', '/opt/node/bin/node', '/home/test/hub.js', 'attach', 's7'], env: { PATH: '/opt/node/bin:/usr/bin' } }]);
    await expect(launcher(run, 'darwin').openTerminal!(terminal)).rejects.toThrow('The terminal app is supported on Windows and Linux only.');
    await expect(launcher(() => { throw new Error('not installed'); }, 'win32').openTerminal!(terminal)).rejects.toThrow('not installed');
    expect(runs).toHaveLength(1);
  });
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

  it('escapes wt subcommand delimiters in every argument, keeping them literal in Ptyxis', async () => {
    const runs: string[][] = [];
    const run = (_file: string, args: string[]) => { runs.push(args); };
    const terminal = { provider: 'claude' as const, sessionId: 's', name: 'sb:s', title: 'Title; new-tab cmd', cwd: 'D:/work;folder', executable: 'node;folder/node.exe', args: ['hub;file.js', 'attach', 's;7', 'already\\;escaped'], handoff: null, active: false };
    await launcher(run, 'win32', {}).openTerminal!(terminal);
    expect(runs[0]).toEqual(['-w', 'new', '--title', 'Title\\; new-tab cmd', '--suppressApplicationTitle', '-d', 'D:/work\\;folder', '--', 'node\\;folder/node.exe', 'hub\\;file.js', 'attach', 's\\;7', 'already\\\\;escaped']);
    await launcher(run, 'linux', {}).openTerminal!(terminal);
    expect(runs[1]).toEqual(['--new-window', '-T', 'Title; new-tab cmd', '-d', 'D:/work;folder', '--', 'node;folder/node.exe', 'hub;file.js', 'attach', 's;7', 'already\\;escaped']);
    expect(runs).toHaveLength(2);
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

    // Open in VS Code at a changed file's line opens that file in the same window.
    runs.length = 0;
    launcher((file, args, env) => runs.push({ file, args, env }), 'linux', { PATH: '/snap/bin' }, has('/snap/bin/code')).openCode('/w/sb.code-workspace', { path: '/wt/src/a.ts', line: 12 });
    expect(runs[0]!.args).toEqual(['/w/sb.code-workspace', '--goto', '/wt/src/a.ts:12']);
  });
});
