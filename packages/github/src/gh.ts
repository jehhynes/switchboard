import { execFile } from 'node:child_process';

export type GhResult = { json: unknown } | { error: string };

/** Runs `gh api graphql` with string and integer variables; `signal` stops gh, answering an error. */
export type Gh = (query: string, variables: Record<string, string | number>, signal?: AbortSignal) => Promise<GhResult>;

const TIMEOUT_MS = 30_000;

/** Turns gh's failure output into the message the panel shows. */
export function ghError(ghPath: string, code: string | number | null | undefined, killed: boolean, stderr: string): string {
  if (code === 'ENOENT') {
    return `The GitHub CLI was not found at ${ghPath}. Install it or set ghPath in the source's settings.`;
  }

  if (/gh auth login|Bad credentials|HTTP 401|requires authentication/i.test(stderr)) {
    return 'The GitHub CLI is not signed in. Run gh auth login.';
  }

  if (killed) {
    return `GitHub did not answer within ${TIMEOUT_MS / 1000} seconds.`;
  }

  return stderr.trim() || `gh exited with code ${String(code)}.`;
}

/** `-f` sends a string; `-F` sends a number as a number. */
export function ghArgs(query: string, variables: Record<string, string | number>): string[] {
  const args = ['api', 'graphql', '-f', `query=${query}`];

  for (const [name, value] of Object.entries(variables)) {
    args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`);
  }

  return args;
}

export function spawnGh(ghPath: string): Gh {
  return (query, variables, signal) =>
    new Promise((resolve) => {
      execFile(ghPath, ghArgs(query, variables), { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) }, (error, stdout, stderr) => {
        if (signal?.aborted === true) {
          resolve({ error: 'Stopped before GitHub answered.' });
          return;
        }

        if (error !== null) {
          resolve({ error: ghError(ghPath, error.code, error.killed === true, stderr) });
          return;
        }

        try {
          resolve({ json: JSON.parse(stdout) });
        } catch {
          resolve({ error: 'gh returned output that is not JSON.' });
        }
      });
    });
}
