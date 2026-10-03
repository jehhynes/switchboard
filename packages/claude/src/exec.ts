import { spawn } from 'node:child_process';

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
}

/** Runs a CLI without a shell, so a prompt's leading slash command reaches it unchanged. */
export type Exec = (file: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

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
    const child = spawn(file, args, { cwd: options.cwd, env: cliEnvironment(process.env), windowsHide: true });
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

/** The message for a failed run: the CLI's own error output when it gave one. */
export function failureOf(file: string, result: ExecResult, timeoutMs: number): string {
  if (result.missing) {
    return `${file} was not found. Install Claude Code or set its path.`;
  }

  if (result.timedOut) {
    return `${file} did not finish within ${timeoutMs / 1000} seconds.`;
  }

  return result.stderr.trim() || result.stdout.trim() || `${file} exited with code ${String(result.code)}.`;
}
