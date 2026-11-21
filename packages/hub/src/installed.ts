import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { PROVIDERS } from '@switchboard/core';
import type { Provider } from '@switchboard/core';

/**
 * Whether `command` names a file the hub can run: a path as given, or a bare name found on `PATH`, on Windows with each `PATHEXT`
 * extension too.
 */
export async function onPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const windows = platform === 'win32';
  const extensions = windows ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const bare = !isAbsolute(command) && !/[\\/]/.test(command);
  const dirs = bare ? (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean) : [''];

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = (dir === '' ? command : join(dir, command)) + extension;

      try {
        await access(candidate, windows ? constants.F_OK : constants.X_OK);

        if ((await stat(candidate)).isFile()) {
          return true;
        }
      } catch {
        // Not here; try the next candidate.
      }
    }
  }

  return false;
}

/** The providers whose CLI the hub finds, from `sessions.claudePath` and `sessions.codexPath`, in `PROVIDERS` order. */
export async function installedProviders(paths: { claudePath: string; codexPath: string }, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Promise<Provider[]> {
  const found = await Promise.all(PROVIDERS.map((provider) => onPath(provider === 'claude' ? paths.claudePath : paths.codexPath, env, platform)));

  return PROVIDERS.filter((_, index) => found[index]);
}
