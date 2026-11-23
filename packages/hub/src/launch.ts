import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { DockTerminal } from './dock.js';

/** What the hub starts on this computer for the web page (architecture.md § Web page); each throws when it cannot start. */
export interface Launcher {
  /** Opens an http or https URL in the default browser. */
  openUrl(url: string): void;
  /** Opens a workspace file or a folder in VS Code, which brings forward the window already on it, and in it `goto`'s file at its line when given. */
  openCode(target: string, goto?: { path: string; line: number | null }): void;
  /** Opens the held session's attach client in the dock's terminal app. */
  openTerminal?(terminal: DockTerminal): void | Promise<void>;
}

/** How a launcher starts a program: detached, with no shell, so no argument is read by one. */
export type Start = (file: string, args: string[], env: NodeJS.ProcessEnv) => void;

/** Waits for the terminal app to start, so a missing program returns its error to the page. */
const startTerminal = (file: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', env, shell: false });
  child.once('spawn', () => resolve());
  child.once('error', reject);
  child.unref();
});

const start: Start = (file, args, env) => {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', env, shell: false });

  // A program that cannot start fails after spawn returns; the launcher has already answered.
  child.on('error', () => {});
  child.unref();
};

/**
 * The command that opens a URL in the default browser: `url.dll`'s handler on Windows, which takes the URL as one argument and runs no shell
 * (`start` would read `&` in a query), `open` on macOS and `xdg-open` elsewhere.
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'win32') {
    return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }

  return { file: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] };
}

/** The environment a launched program gets: the hub's, without the Electron and VS Code variables that would make VS Code run as Node. */
export function launchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(ELECTRON_|VSCODE_)/i.test(name)));
}

/**
 * The VS Code the dock starts (`VsCodeInstall`): on Windows `Code.exe` beside the `bin\code.cmd` found on PATH, else in the per-user install
 * folder; elsewhere `code` on PATH. Throws when there is none.
 */
export function codeExecutable(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): string {
  const path = platform === 'win32' ? win32 : posix;
  const folders = (env['PATH'] ?? env['Path'] ?? '').split(platform === 'win32' ? ';' : ':').filter((folder) => folder !== '');

  if (platform !== 'win32') {
    const found = folders.map((folder) => path.join(folder, 'code')).find(exists);

    if (found === undefined) {
      throw new Error('code was not found on PATH.');
    }

    return found;
  }

  const onPath = folders.map((folder) => path.join(folder, 'code.cmd')).find(exists);
  const candidates = [onPath === undefined ? null : path.resolve(path.dirname(onPath), '..', 'Code.exe'), env['LOCALAPPDATA'] === undefined ? null : path.join(env['LOCALAPPDATA'], 'Programs', 'Microsoft VS Code', 'Code.exe')];
  const found = candidates.find((candidate): candidate is string => candidate !== null && exists(candidate));

  if (found === undefined) {
    throw new Error('Code.exe was not found beside code on PATH.');
  }

  return found;
}

/** The launcher that starts real programs; `run` replaces how in tests. */
export function launcher(run: Start = start, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): Launcher {
  return {
    async openTerminal(terminal) {
      if (platform !== 'win32' && platform !== 'linux') throw new Error('The terminal app is supported on Windows and Linux only.');
      const executable = terminal.executable ?? terminal.provider;
      const path = platform === 'win32' ? win32 : posix;
      const clean = Object.fromEntries(Object.entries(launchEnvironment(env)).filter(([name]) => !/^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|ENTRYPOINT|EXECPATH|SSE_PORT|SESSION_ATTENDED))$/i.test(name) && !/^CLAUDE_CODE_MESSAGING_/i.test(name)));
      if (path.isAbsolute(executable)) {
        const key = Object.keys(clean).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
        clean[key] = [path.dirname(executable), clean[key]].filter(Boolean).join(platform === 'win32' ? ';' : ':');
      }
      const args = platform === 'win32'
        ? ['-w', 'new', '--title', terminal.title, '--suppressApplicationTitle', '-d', terminal.cwd, '--']
        : ['--new-window', '-T', terminal.title, '-d', terminal.cwd, '--'];
      const app = platform === 'win32' ? 'wt.exe' : 'ptyxis';
      // wt splits every argument at unescaped semicolons, even without a shell.
      const command = [...args, executable, ...terminal.args].map((arg) => platform === 'win32' ? arg.replaceAll(';', '\\;') : arg);
      if (run === start) await startTerminal(app, command, clean);
      else run(app, command, clean);
    },
    openCode(target, goto) {
      const at = goto === undefined ? [] : ['--goto', goto.line === null ? goto.path : `${goto.path}:${goto.line}`];

      run(codeExecutable(platform, env, exists), [target, ...at], launchEnvironment(env));
    },
    openUrl(url) {
      if (!/^https?:\/\//i.test(url)) {
        throw new Error('Only an http or https URL opens.');
      }

      const { file, args } = browserCommand(url, platform);

      run(file, args, launchEnvironment(env));
    },
  };
}
