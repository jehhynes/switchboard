import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { switchboardHome } from './paths.js';

/** The hub's own settings file, `<home>/.switchboard/config.json`, which names the config folder (architecture.md § Config folder). */
export function hubConfigPath(home: string): string {
  return join(switchboardHome(home), 'config.json');
}

/** The config folder config.json names: null when there is no file, else the folder or why the file cannot be used. */
export function readHubConfig(home: string): { dir: string } | { error: string } | null {
  const path = hubConfigPath(home);
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : { error: `${path} cannot be read: ${String(error)}` };
  }

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return { error: `${path} is not valid JSON` };
  }

  const configDir = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)['configDir'] : undefined;

  if (typeof configDir !== 'string' || !isAbsolute(configDir)) {
    return { error: `${path} must name configDir, an absolute path` };
  }

  return { dir: resolve(configDir) };
}

/** Writes the config folder into config.json, keeping any other keys, through a temporary file so a reader never sees half a file. */
export function writeHubConfig(home: string, configDir: string): void {
  const path = hubConfigPath(home);
  let kept: Record<string, unknown> = {};

  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      kept = value as Record<string, unknown>;
    }
  } catch {
    // No file, or one that cannot be used: it is replaced.
  }

  mkdirSync(dirname(path), { recursive: true });

  const temporary = `${path}.${process.pid}.tmp`;

  writeFileSync(temporary, `${JSON.stringify({ ...kept, configDir: resolve(configDir) }, null, 2)}\n`);
  renameSync(temporary, path);
}
