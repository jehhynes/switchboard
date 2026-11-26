import { spawn } from 'node:child_process';
import { posix, win32 } from 'node:path';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The executable was not found. */
  missing: boolean;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  stdin?: string;
  timeoutMs: number;
  /** Variables added to the CLI environment. */
  env?: Record<string, string>;
}

/** Runs a CLI without a shell, so a prompt's leading slash command reaches it unchanged. */
export type Exec = (file: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

/**
 * Puts an absolute executable path's directory first on PATH, because an npm launcher runs `node` from PATH and nvm installs `node` beside it.
 * Keeps the environment's own spelling of PATH, such as Windows' `Path`. A bare name adds nothing. `platform` gives the path rules.
 */
export function executableDirOnPath(executable: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const path = platform === 'win32' ? win32 : posix;

  if (!path.isAbsolute(executable)) {
    return {};
  }

  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key];

  return { [key]: current ? `${path.dirname(executable)}${path.delimiter}${current}` : path.dirname(executable) };
}

/** Leaves out VS Code window and build variables, so the CLI and the sessions it starts do not target a VS Code window (GC M26, M49). */
export function cliEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('ELECTRON_') && !key.startsWith('VSCODE_') && key !== 'NODE_OPTIONS') {
      result[key] = value;
    }
  }

  return result;
}

export const spawnExec: Exec = (file, args, options) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options.cwd, env: { ...cliEnvironment(process.env), ...options.env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message, missing: error.code === 'ENOENT', timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, missing: false, timedOut });
    });
    // Stdin avoids the Windows 32,767-character command-line limit for long input (GC M31).
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin ?? '');
  });
