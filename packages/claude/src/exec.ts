import type { ExecResult } from '@switchboard/core';

export { cliEnvironment, spawnExec } from '@switchboard/core';
export type { Exec, ExecOptions, ExecResult } from '@switchboard/core';

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
