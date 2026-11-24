import { readFileSync, statSync } from 'node:fs';
import { join, posix, resolve, win32 } from 'node:path';
import { hubConfigPath, readHubConfig, resolveConfigDir, switchboardHome, writeHubConfig } from '@switchboard/core';

/**
 * Parses JSON with comments and trailing commas, as VS Code's settings.json allows; null when it is not that. Commas and comment marks
 * inside strings are kept.
 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let pendingComma = '';

  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    const next = text[i + 1];

    if (c === '"') {
      let end = i + 1;

      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }

      out += pendingComma + text.slice(i, end + 1);
      pendingComma = '';
      i = end + 1;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);

      i = end < 0 ? text.length : end + 2;
    } else if (c === ',') {
      out += pendingComma;
      pendingComma = ',';
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      // A comma right before a closing bracket is a trailing comma, which is dropped.
      out += (c === '}' || c === ']' ? '' : pendingComma) + c;
      pendingComma = '';
      i++;
    }
  }

  try {
    return JSON.parse(out + pendingComma);
  } catch {
    return null;
  }
}

export interface ConfigFolderDeps {
  /** The directory holding `.switchboard`, resolved. */
  home: string;
  /** The user's own home: only its Switchboard home imports from the environment's VS Code settings, so a test home never reads the operator's. */
  osHome: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase() : posix.resolve(a) === posix.resolve(b);
}

/**
 * VS Code's user settings.json for the home: under `%APPDATA%` on Windows, `~/Library/Application Support` on macOS and `$XDG_CONFIG_HOME` or
 * `~/.config` elsewhere. The environment's folders count only for the user's own home; another home uses the defaults under itself.
 */
export function vscodeSettingsPath(deps: ConfigFolderDeps): string {
  const own = samePath(deps.home, deps.osHome, deps.platform);
  const path = deps.platform === 'win32' ? win32 : posix;
  const base =
    deps.platform === 'win32'
      ? (own ? deps.env['APPDATA'] : undefined) || path.join(deps.home, 'AppData', 'Roaming')
      : deps.platform === 'darwin'
        ? path.join(deps.home, 'Library', 'Application Support')
        : (own ? deps.env['XDG_CONFIG_HOME'] : undefined) || path.join(deps.home, '.config');

  return path.join(base, 'Code', 'User', 'settings.json');
}

/** Where a config folder came from: config.json, the `--config` flag, the running hub, VS Code's setting, or the default. */
export type ConfigSource = 'file' | 'flag' | 'hub' | 'vscode' | 'default';

export type LoadedConfigFolder = { dir: string; source: ConfigSource; notices: string[] } | { error: string };

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The config folder the hub uses (architecture.md § Config folder). config.json wins, so a `--config` that differs is ignored with a notice; a
 * config.json that cannot be used is an error, so the hub never falls back to a folder without the operator's playbooks. Without config.json the
 * folder is imported once, from `--config`, the running hub's folder (which a login entry or an earlier start chose), VS Code's `switchboard.configDir` (read only), else the Switchboard home,
 * and written to config.json unless \`persist\` is false, as for a dry run.
 */
export function loadConfigFolder(deps: ConfigFolderDeps, flag: string | null, options: { persist?: boolean; running?: string | null } = {}): LoadedConfigFolder {
  const persist = options.persist ?? true;
  const file = readHubConfig(deps.home);
  const notices: string[] = [];

  if (file !== null && 'error' in file) {
    return { error: `${file.error}; fix it, or run hub.js config set configDir <folder>` };
  }

  if (file !== null) {
    if (flag && resolve(flag) !== file.dir) {
      notices.push(`--config=${flag} is ignored: ${hubConfigPath(deps.home)} names ${file.dir}; hub.js config set configDir <folder> changes it.`);
    }

    return { dir: file.dir, source: 'file', notices };
  }

  const found = ((): { dir: string; source: ConfigSource } => {
    if (flag) {
      return { dir: resolve(flag), source: 'flag' };
    }

    if (options.running) {
      return { dir: resolve(options.running), source: 'hub' };
    }

    const settingsPath = vscodeSettingsPath(deps);
    const text = readText(settingsPath);

    if (text !== null) {
      const settings = parseJsonc(text);
      const value = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>)['switchboard.configDir'] : undefined;

      if (settings === null) {
        notices.push(`${settingsPath} could not be read as JSON, so switchboard.configDir was not imported.`);
      } else if (typeof value === 'string' && value.trim() !== '') {
        const resolved = resolveConfigDir(value, deps.home, deps.home);

        if ('dir' in resolved) {
          return { dir: resolved.dir, source: 'vscode' };
        }

        notices.push(`${resolved.error}, so it was not imported.`);
      }
    }

    return { dir: resolve(switchboardHome(deps.home)), source: 'default' };
  })();

  try {
    if (persist) {
      writeHubConfig(deps.home, found.dir);
    }
  } catch (error) {
    notices.push(`${hubConfigPath(deps.home)} could not be written, so the config folder is imported again at the next start: ${String(error)}`);
  }

  return { ...found, notices };
}

const SOURCES: Record<ConfigSource, string> = {
  file: 'from config.json',
  flag: 'imported from --config',
  hub: 'imported from the running hub',
  vscode: "imported from VS Code's switchboard.configDir",
  default: 'the Switchboard home, since nothing named another',
};

export const CONFIG_USAGE = 'Usage: hub.js config [get configDir | set configDir <folder>]\n';

export interface ConfigCli extends ConfigFolderDeps {
  /** The running hub's config folder, or null when none answers. */
  running(): Promise<string | null>;
  /** `hub.js restart`: restarts the running hub, so it reads config.json again, and answers its exit code. */
  restart(): Promise<number>;
  out(text: string): void;
  err(text: string): void;
}

/**
 * `hub.js config`: shows the config folder, prints it alone with `get configDir`, or sets it with `set configDir <folder>` and restarts a running
 * hub that reads another folder (architecture.md § Config folder). Exit codes: 0 done, 1 usage or refused, 3 config.json could not be used or
 * written, or as `hub.js restart`.
 */
export async function runConfig(rest: readonly string[], cli: ConfigCli): Promise<number> {
  const [verb, key, value, ...extra] = rest;
  const known = verb === undefined || (verb === 'get' && key === 'configDir' && value === undefined) || (verb === 'set' && key === 'configDir' && value !== undefined && value.trim() !== '' && extra.length === 0);

  if (!known) {
    cli.err(CONFIG_USAGE);
    return 1;
  }

  if (verb === 'set') {
    const resolved = resolveConfigDir(value!, cli.home, cli.home, 'configDir');

    if ('error' in resolved) {
      cli.err(`Refused: ${resolved.error}.\n`);
      return 1;
    }

    let folder: boolean;

    try {
      folder = statSync(resolved.dir).isDirectory();
    } catch {
      cli.err(`Refused: ${resolved.dir} does not exist. Create it, with settings.json in it, first.\n`);
      return 1;
    }

    if (!folder) {
      cli.err(`Refused: ${resolved.dir} is not a folder.\n`);
      return 1;
    }

    try {
      writeHubConfig(cli.home, resolved.dir);
    } catch (error) {
      cli.err(`${hubConfigPath(cli.home)} could not be written: ${String(error)}\n`);
      return 3;
    }

    cli.out(`The config folder is now ${resolved.dir}.\n`);

    const running = await cli.running();

    if (running === null) {
      cli.out('The hub reads it when it starts.\n');
      return 0;
    }

    if (running === resolved.dir) {
      return 0;
    }

    return cli.restart();
  }

  const running = await cli.running();
  const loaded = loadConfigFolder(cli, null, { running });

  if ('error' in loaded) {
    cli.err(`${loaded.error}.\n`);
    return 3;
  }

  for (const notice of loaded.notices) {
    cli.err(`${notice}\n`);
  }

  if (verb === 'get') {
    cli.out(`${loaded.dir}\n`);
    return 0;
  }

  cli.out(`configDir: ${loaded.dir} (${SOURCES[loaded.source]}, ${hubConfigPath(cli.home)})\n`);

  if (running !== null && running !== loaded.dir) {
    cli.out(`The running hub reads ${running}; hub.js restart moves it to ${loaded.dir}.\n`);
  }

  return 0;
}
