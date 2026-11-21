import { spawn } from 'node:child_process';

/** What the hub starts on this computer for the web page (architecture.md § Web page); each throws when it cannot start. */
export interface Launcher {
  /** Opens an http or https URL in the default browser. */
  openUrl(url: string): void;
}

/** How a launcher starts a program: detached, with no shell, so no argument is read by one. */
export type Start = (file: string, args: string[], env: NodeJS.ProcessEnv) => void;

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

/** The launcher that starts real programs; `run` replaces how in tests. */
export function launcher(run: Start = start, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Launcher {
  return {
    openUrl(url) {
      if (!/^https?:\/\//i.test(url)) {
        throw new Error('Only an http or https URL opens.');
      }

      const { file, args } = browserCommand(url, platform);

      run(file, args, launchEnvironment(env));
    },
  };
}
