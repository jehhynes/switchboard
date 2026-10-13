import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Roles by lowercased login, because GitHub logins are case-insensitive. */
export type Roles = Map<string, string[]>;

export type RolesResult = { roles: Roles } | { error: string };

/** Reads `{login: {roles: string[]}}`, such as the sb-handoff skill's roster.json. An entry without a roles list is left out. */
export function parseRoles(text: string): RolesResult {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return { error: 'is not JSON' };
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { error: 'is not an object of logins' };
  }

  const roles: Roles = new Map();

  for (const [login, entry] of Object.entries(json)) {
    const list = (entry as { roles?: unknown } | null)?.roles;

    if (Array.isArray(list) && list.length > 0 && list.every((role) => typeof role === 'string' && role !== '')) {
      roles.set(login.toLowerCase(), list as string[]);
    }
  }

  return { roles };
}

/** Reads the roles file on each call, so an edit applies to the next triage. A leading `~` is the profile directory. */
export async function readRolesFile(path: string, profile: string): Promise<RolesResult> {
  const expanded = path === '~' || /^~[\\/]/.test(path) ? join(profile, path.slice(1)) : path;
  let text: string;

  try {
    text = await readFile(expanded, 'utf8');
  } catch (error) {
    return { error: `Roles file ${expanded} could not be read: ${(error as NodeJS.ErrnoException).code ?? String(error)}.` };
  }

  const parsed = parseRoles(text);

  return 'error' in parsed ? { error: `Roles file ${expanded} ${parsed.error}.` } : parsed;
}
