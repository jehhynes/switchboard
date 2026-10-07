import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ADHOC_SOURCE,
  DEFAULT_SETTINGS,
  formatPlaybook,
  isPlaybookName,
  listPlaybookFiles,
  loadPlaybooks,
  parsePlaybook,
  parsePlaybookFile,
  parseSettings,
  TEMPLATE_VARIABLES,
  templateError,
  TRIAGE_VARIABLES,
} from '@switchboard/core';
import type { Playbook, PlaybookError, PlaybookFields, Settings } from '@switchboard/core';
import { parseForumConfig } from '@switchboard/forum';
import { parseGithubConfig } from '@switchboard/github';
import { parseZohoConfig } from '@switchboard/zoho';

export interface Config {
  settings: Settings;
  /** Why settings.json was rejected; the previous settings stay in force (PRD R42). */
  settingsError: string | null;
  playbooks: Map<string, Playbook>;
  playbookErrors: PlaybookError[];
}

/** The sources Switchboard has, by their key under `sources`. */
export const SOURCE_KINDS = ['github', 'zoho', 'forum'] as const;

export function settingsPath(configDir: string): string {
  return join(configDir, 'settings.json');
}

export function playbooksDir(configDir: string): string {
  return join(configDir, 'playbooks');
}

/** Why a source's own keys are invalid, or null. */
export function sourceOptionsError(name: string, options: Record<string, unknown>): string | null {
  const parsed =
    name === 'github' ? parseGithubConfig(options) : name === 'zoho' ? parseZohoConfig(options) : name === 'forum' ? parseForumConfig(options) : { error: `sources.${name}: Switchboard has no source named ${name}.` };

  return 'error' in parsed ? parsed.error : null;
}

/** A hash of a file's text, so a save can refuse to overwrite a change made since it was read. Null for a missing file. */
export function fileVersion(text: string | null): string | null {
  return text === null ? null : createHash('sha256').update(text).digest('hex');
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

/** Writes through a temporary file, so the hub's reload never reads a half-written file. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

const changed = (file: string) => `${file} changed on disk after the editor read it. Reload to see the change.`;

/**
 * Turns a configured source on or off in settings.json, which the hub then reloads. The file is rewritten as formatted JSON.
 * Returns why it could not, or null.
 */
export function setSourceEnabled(configDir: string, name: string, enabled: boolean): string | null {
  const path = settingsPath(configDir);
  let settings: { sources?: Record<string, Record<string, unknown>> };

  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return `settings.json could not be read: ${(error as Error).message}`;
  }

  const source = settings.sources?.[name];

  if (source === undefined) {
    return `settings.json has no source named ${name}.`;
  }

  source['enabled'] = enabled;
  writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);

  return null;
}

/**
 * Every error the hub would report for these settings: the file's own, which reject it whole (PRD R42), then each enabled
 * source's keys, which disable that source, and unknown variables in `setupPrompt` and `pickPrompt`.
 */
export function checkSettings(value: unknown): string[] {
  const parsed = parseSettings(JSON.stringify(value));

  if ('errors' in parsed) {
    return parsed.errors;
  }

  const errors: string[] = [];

  for (const [name, source] of Object.entries(parsed.settings.sources)) {
    for (const key of ['setupPrompt', 'pickPrompt'] as const) {
      const error = templateError(source[key]);

      if (error !== null) {
        errors.push(`sources.${name}.${key}: ${error}`);
      }
    }

    const error = source.enabled && name !== ADHOC_SOURCE ? sourceOptionsError(name, source.options) : null;

    if (error !== null) {
      errors.push(error);
    }
  }

  return errors;
}

export interface SettingsFile {
  path: string;
  version: string | null;
  /** The parsed JSON, `{}` for a missing file, or null when the file is not JSON. */
  value: unknown;
  /** Why the file cannot be edited as JSON. */
  error: string | null;
}

export interface PlaybookFileView {
  name: string;
  path: string;
  version: string;
  /** Null when the file is invalid. */
  playbook: PlaybookFields | null;
  error: string | null;
}

export interface ConfigFiles {
  settings: SettingsFile;
  playbooks: PlaybookFileView[];
}

/** Reads settings.json and every playbook file, valid or not, for the settings editor. */
export function readConfigFiles(configDir: string): ConfigFiles {
  const path = settingsPath(configDir);
  const text = readText(path);
  let settings: SettingsFile = { path, version: fileVersion(text), value: {}, error: null };

  if (text !== null) {
    try {
      settings.value = JSON.parse(text);
    } catch (error) {
      settings = { ...settings, value: null, error: `settings.json is not valid JSON: ${(error as Error).message}` };
    }
  }

  const playbooks = listPlaybookFiles(playbooksDir(configDir)).flatMap((file): PlaybookFileView[] => {
    const content = readText(file.path);

    if (content === null) {
      return [];
    }

    const result = parsePlaybookFile(file, content);
    const version = fileVersion(content)!;

    if ('error' in result) {
      return [{ name: file.name, path: file.path, version, playbook: null, error: result.error }];
    }

    const { name: _name, ...playbook } = result.playbook;

    return [{ name: file.name, path: file.path, version, playbook, error: null }];
  });

  return { settings, playbooks };
}

/** Writes settings.json as formatted JSON. Refuses when the file changed since `version` was read, or with the errors of {@link checkSettings}. */
export function saveSettings(configDir: string, value: unknown, version: string | null): string[] {
  const path = settingsPath(configDir);

  if (fileVersion(readText(path)) !== version) {
    return [changed('settings.json')];
  }

  const errors = checkSettings(value);

  if (errors.length === 0) {
    writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  return errors;
}

function playbookPath(configDir: string, name: string): string {
  const [namespace = '', base = ''] = name.split(':');

  return join(playbooksDir(configDir), namespace, `${base}.md`);
}

/**
 * Writes a playbook. `version` null creates it, and refuses when the file exists. Refuses when the file changed since
 * `version` was read, or when the hub would leave the playbook out.
 */
export function savePlaybook(configDir: string, name: string, playbook: PlaybookFields, version: string | null): string[] {
  if (!isPlaybookName(name)) {
    return ['The name must be namespace:name, in lowercase letters, digits and hyphens.'];
  }

  const path = playbookPath(configDir, name);
  const current = fileVersion(readText(path));

  if (current !== version) {
    return [version === null ? `A playbook named ${name} already exists.` : changed(name)];
  }

  const checked = checkPlaybook(name, playbook);

  if ('text' in checked) {
    writeAtomic(path, checked.text);
  }

  return 'errors' in checked ? checked.errors : [];
}

/** The file text for a playbook, or every error the hub would report for it, including unknown template variables. */
export function checkPlaybook(name: string, playbook: PlaybookFields): { text: string } | { errors: string[] } {
  const formatted = formatPlaybook(playbook);

  if ('error' in formatted) {
    return { errors: [formatted.error] };
  }

  const parsed = parsePlaybook(name, formatted.text);
  const errors = 'error' in parsed ? [parsed.error] : [];
  const unknown = templateError(playbook.template, playbook.kind === 'triage' ? TRIAGE_VARIABLES : TEMPLATE_VARIABLES);

  if (unknown !== null) {
    errors.push(unknown);
  }

  return errors.length > 0 ? { errors } : formatted;
}

/** Deletes a playbook file, unless it changed since `version` was read. */
export function deletePlaybook(configDir: string, name: string, version: string): string[] {
  const file = listPlaybookFiles(playbooksDir(configDir)).find((entry) => entry.name === name);

  if (file === undefined || fileVersion(readText(file.path)) !== version) {
    return [changed(name)];
  }

  rmSync(file.path);

  return [];
}

/** Reads settings and playbooks. A missing settings file means the defaults; an invalid one keeps `previous`. */
export function loadConfig(configDir: string, previous: Settings = DEFAULT_SETTINGS): Config {
  let settings = previous;
  let settingsError: string | null = null;
  let text: string | null = null;

  try {
    text = readFileSync(settingsPath(configDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      settingsError = `settings.json could not be read: ${(error as Error).message}`;
    }
  }

  if (text !== null) {
    const parsed = parseSettings(text);

    if ('settings' in parsed) {
      settings = parsed.settings;
    } else {
      settingsError = parsed.errors.join(' ');
    }
  } else if (settingsError === null) {
    settings = DEFAULT_SETTINGS;
  }

  const { playbooks, errors } = loadPlaybooks(playbooksDir(configDir));

  return { settings, settingsError, playbooks, playbookErrors: errors };
}
