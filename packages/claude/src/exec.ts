import { existsSync } from 'node:fs';
import type { ExecResult } from '@switchboard/core';
import { executableDirOnPath } from '@switchboard/core';

export { cliEnvironment, spawnExec } from '@switchboard/core';
export type { Exec, ExecOptions, ExecResult } from '@switchboard/core';

/** The message for a Claude Code CLI the hub could not find. */
export function claudeNotFound(claudePath: string): string {
  return `Claude Code was not found at ${claudePath}. Install it or set sessions.claudePath.`;
}

/**
 * The message for a failed run: the CLI's own error output when it gave one. `cwd` is the run's working directory, whose absence also fails
 * with ENOENT; `notFound` names a missing executable that is not Claude Code.
 */
export function failureOf(file: string, result: ExecResult, timeoutMs: number, options: { cwd?: string; notFound?: string } = {}): string {
  if (result.missing) {
    return options.cwd !== undefined && !existsSync(options.cwd) ? `The directory ${options.cwd} was not found.` : (options.notFound ?? claudeNotFound(file));
  }

  if (result.timedOut) {
    return `${file} did not finish within ${timeoutMs / 1000} seconds.`;
  }

  return result.stderr.trim() || resultText(result.stdout) || result.stdout.trim() || `${file} exited with code ${String(result.code)}.`;
}

/**
 * The `result` text of `--output-format json` output, a result object or, with `--verbose`, an array ending in one, so a failed run such as one
 * at the usage limit shows Claude's message rather than the JSON. Null when the output is not such JSON.
 */
function resultText(stdout: string): string | null {
  let output: unknown;

  try {
    output = JSON.parse(stdout);
  } catch {
    return null;
  }

  const messages: unknown[] = Array.isArray(output) ? output : [output];
  const message = messages.reverse().find((entry) => (entry as { type?: unknown } | null)?.type === 'result') as { result?: unknown } | undefined;
  const text = message?.result;

  return typeof text === 'string' && text.trim() !== '' ? text.trim() : null;
}

/** The variables every Claude Code run gets: an absolute `sessions.claudePath`'s directory first on PATH. */
export function claudeEnvironment(claudePath: string): Record<string, string> {
  return executableDirOnPath(claudePath);
}
