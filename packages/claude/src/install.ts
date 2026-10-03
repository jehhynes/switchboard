import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_SOURCE, planHooks } from './hooks.js';
import type { Marker } from './hooks.js';

/** Claude's settings file: under CLAUDE_CONFIG_DIR when the operator set it, else `~/.claude`. */
export function claudeSettingsPath(home: string, env: NodeJS.ProcessEnv): string {
  return join(env['CLAUDE_CONFIG_DIR'] || join(home, '.claude'), 'settings.json');
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

/** Windows refuses a rename over a file another process has open, as Claude sessions often have settings.json (mechanics M8). */
const RENAME_ATTEMPTS = 10;
const RENAME_WAIT_MS = 100;

function writeAtomically(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;

  writeFileSync(tmp, text);

  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (error) {
      if (attempt === RENAME_ATTEMPTS || (error as NodeJS.ErrnoException).code !== 'EPERM') {
        rmSync(tmp, { force: true });
        throw error;
      }

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_WAIT_MS);
    }
  }
}

/** Writes `<switchboard home>/hook.mjs` and adds its entries to Claude's settings. Returns why settings were left alone, or null. */
export function installHooks(switchboardHome: string, settingsPath: string): string | null {
  const hookPath = join(switchboardHome, 'hook.mjs').replaceAll('\\', '/');

  mkdirSync(switchboardHome, { recursive: true });

  if (readText(hookPath) !== HOOK_SOURCE) {
    writeAtomically(hookPath, HOOK_SOURCE);
  }

  const plan = planHooks(readText(settingsPath), hookPath);

  if ('error' in plan) {
    return plan.error;
  }

  if ('text' in plan) {
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeAtomically(settingsPath, plan.text);
  }

  return null;
}

/** Hook markers by native session ID. An unreadable marker is skipped; the next hook event rewrites it. */
export function readMarkers(switchboardHome: string): Map<string, Marker> {
  const dir = join(switchboardHome, 'activity');
  const markers = new Map<string, Marker>();
  let files: string[];

  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.json'));
  } catch {
    return markers;
  }

  for (const file of files) {
    try {
      const marker = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Marker;
      markers.set(marker.sessionId, marker);
    } catch {
      continue;
    }
  }

  return markers;
}
