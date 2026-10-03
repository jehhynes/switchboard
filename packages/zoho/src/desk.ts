import { execFile } from 'node:child_process';
import type { ZohoConfig } from './config.js';

export type DeskResult = { json: unknown } | { empty: true } | { error: string };

/** One authorized GET against the Desk API, path relative to the API base. */
export type DeskGet = (path: string) => Promise<DeskResult>;

/** Runs the token command and returns the token it prints. */
export type TokenSource = () => Promise<{ token: string } | { error: string }>;

const TOKEN_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Desk access tokens last an hour; refresh before that. */
const TOKEN_LIFETIME_MS = 50 * 60_000;

/** Runs `tokenCommand` through bash, so `~` and the operator's runner script work as written. The token is never logged. */
export function commandToken(command: string): TokenSource {
  return () =>
    new Promise((resolve) => {
      execFile('bash', ['-c', command], { timeout: TOKEN_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
        const token = stdout.trim();

        if (error !== null || token === '') {
          resolve({ error: `The Zoho token command failed: ${stderr.trim() || error?.message || 'it printed nothing'}` });
          return;
        }

        resolve({ token });
      });
    });
}

/** Read-only Desk client: GET only, a cached token, and one token refresh on 401. */
export function deskClient(config: ZohoConfig, tokens: TokenSource, now: () => number = Date.now): DeskGet {
  let cached: { token: string; until: number } | null = null;

  const token = async (fresh: boolean): Promise<{ token: string } | { error: string }> => {
    if (!fresh && cached !== null && now() < cached.until) {
      return { token: cached.token };
    }

    const result = await tokens();

    if ('token' in result) {
      cached = { token: result.token, until: now() + TOKEN_LIFETIME_MS };
    }

    return result;
  };

  return async (path) => {
    for (const fresh of [false, true]) {
      const auth = await token(fresh);

      if ('error' in auth) {
        return auth;
      }

      let response: Response;

      try {
        response = await fetch(config.apiBase + path, {
          headers: { Authorization: `Zoho-oauthtoken ${auth.token}`, orgId: config.orgId },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        return { error: `Zoho Desk could not be reached: ${(error as Error).message}` };
      }

      if (response.status === 401) {
        if (!fresh) {
          continue;
        }

        return { error: 'Zoho Desk refused the access token.' };
      }

      if (response.status === 204) {
        return { empty: true };
      }

      if (!response.ok) {
        return { error: response.status === 429 ? 'Zoho Desk rate-limited the read.' : `Zoho Desk answered HTTP ${response.status} for ${path.split('?')[0]}.` };
      }

      try {
        return { json: await response.json() };
      } catch {
        return { error: 'Zoho Desk returned output that is not JSON.' };
      }
    }

    return { error: 'Zoho Desk refused the access token.' };
  };
}
