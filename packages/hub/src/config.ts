import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ADHOC_SOURCE,
  DEFAULT_SETTINGS,
  homeRepo,
  parsePlaybook,
  parsePlaybooks,
  parseSettings,
  SCHEDULE_SOURCE,
  TEMPLATE_VARIABLES,
  templateError,
  TRIAGE_VARIABLES,
} from '@switchboard/core';
import type { Playbook, PlaybookError, Provider, Settings } from '@switchboard/core';
import { parseForumConfig } from '@switchboard/forum';
import { parseGithubConfig } from '@switchboard/github';
import { parseZohoConfig } from '@switchboard/zoho';

export interface Config {
  settings: Settings;
  /** Why settings.json was rejected; the previous settings and playbooks stay in force (PRD R42). */
  settingsError: string | null;
  playbooks: Map<string, Playbook>;
  /** The playbooks left out, each invalid on its own. */
  playbookErrors: PlaybookError[];
}

/** The source plugins, which a source names by its `kind` or, without one, its key under `sources`. */
export const SOURCE_KINDS = ['github', 'zoho', 'forum'] as const;

export function settingsPath(configDir: string): string {
  return join(configDir, 'settings.json');
}

/** Why a source's own keys are invalid, or null. */
export function sourceOptionsError(name: string, kind: string, options: Record<string, unknown>): string | null {
  const parsed =
    kind === 'github'
      ? parseGithubConfig(options, name)
      : kind === 'zoho'
        ? parseZohoConfig(options, name)
        : kind === 'forum'
          ? parseForumConfig(options, name)
          : { error: `sources.${name}: ${noKind(kind)}` };

  return 'error' in parsed ? parsed.error : null;
}

/**
 * Errors between sources, which reject the file whole (PRD R42): only a GitHub source may be named apart from its kind, because Support volume
 * recording finds Zoho and Forum tickets by source name; no source may take another kind's name; and no two GitHub sources may read one project
 * board, including a source that is off, because an issue would then belong to both.
 */
export function sourcesErrors(settings: Settings, recorded: Readonly<Record<string, string>> = {}): string[] {
  const errors: string[] = [];
  const boards = new Map<string, string>();
  const labels = new Map<string, string>();
  const names = new Set([...Object.keys(settings.sources), 'gh', ADHOC_SOURCE, SCHEDULE_SOURCE]);

  for (const [name, source] of Object.entries(settings.sources)) {
    const path = `sources.${name}`;

    if (source.kind !== name && (SOURCE_KINDS as readonly string[]).includes(name)) {
      errors.push(`${path}: ${name} is a source kind, so a source of kind ${source.kind} needs another name.`);
    } else if (source.kind !== name && (SOURCE_KINDS as readonly string[]).includes(source.kind) && source.kind !== 'github') {
      errors.push(`${path}.kind: only a GitHub source may be named apart from its kind.`);
    }

    const project = source.kind === 'github' ? (source.options['project'] as { owner?: unknown; number?: unknown } | undefined) : undefined;

    const home = homeRepo(source);

    // Bare keys mean the home repository, so it cannot change under stored tickets (PRD R44).
    if (recorded[name] !== undefined && home !== '' && home !== recorded[name]) {
      errors.push(`${path}.repo cannot change from ${recorded[name]} while the source has tickets; add another source for ${home}.`);
    }

    const sourceLabels = source.kind === 'github' ? source.options['labels'] : undefined;

    for (const [repo, label] of typeof sourceLabels === 'object' && sourceLabels !== null ? Object.entries(sourceLabels) : []) {
      if (typeof label !== 'string') {
        continue;
      }

      if (names.has(label)) {
        errors.push(`${path}.labels.${repo}: ${label} names a source.`);
      } else if (labels.has(label) && labels.get(label) !== repo.toLowerCase()) {
        errors.push(`${path}.labels.${repo}: ${label} already labels ${labels.get(label)}.`);
      } else {
        labels.set(label, repo.toLowerCase());
      }
    }

    if (typeof project?.owner === 'string' && typeof project.number === 'number') {
      const board = `${project.owner.toLowerCase()}/${project.number}`;
      const other = boards.get(board);

      if (other === undefined) {
        boards.set(board, name);
      } else {
        errors.push(`${path}.project: sources.${other} already reads project ${board}.`);
      }
    }
  }

  return errors;
}

/** Why a source has no plugin. */
export function noKind(kind: string): string {
  return `Switchboard has no source kind ${kind}.`;
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

const changed = (file: string) => `${file} changed on disk after the editor read it. Discard your changes and open Settings again to load it.`;

/**
 * Every error the hub would report for these settings: the file's own, which reject it whole (PRD R42), then the keys of each source
 * in `enabled`, which disable that source, unknown variables in `setupPrompt`, and each playbook's, as `playbooks.<name>: <error>`,
 * which leave that playbook out. Unknown template variables are included because the hub finds them only when rendering fails.
 */
export function checkSettings(value: unknown, enabled: ReadonlySet<string>, recorded: Readonly<Record<string, string>> = {}): string[] {
  const parsed = parseSettings(JSON.stringify(value));

  if ('errors' in parsed) {
    return parsed.errors;
  }

  const errors = sourcesErrors(parsed.settings, recorded);

  for (const [name, source] of Object.entries(parsed.settings.sources)) {
    const setupError = templateError(source.setupPrompt);

    if (setupError !== null) {
      errors.push(`sources.${name}.setupPrompt: ${setupError}`);
    }

    const error = enabled.has(name) && name !== ADHOC_SOURCE ? sourceOptionsError(name, source.kind, source.options) : null;

    if (error !== null) {
      errors.push(error);
    }
  }

  const playbooks = (value as { playbooks?: Record<string, unknown> }).playbooks ?? {};

  for (const [name, entry] of Object.entries(playbooks)) {
    errors.push(...playbookErrors(name, entry, parsed.settings.sessions.provider).map((error) => `playbooks.${name}: ${error}`));
  }

  const loaded = parsePlaybooks(playbooks, parsed.settings.sessions.provider).playbooks;

  // A run of a playbook that is missing or needs a worktree would fail, because a schedule has no source to set one up (PRD R82).
  for (const [name, schedule] of Object.entries(parsed.settings.schedules)) {
    const playbook = loaded.get(schedule.playbook);

    if (playbook?.kind !== 'task') {
      errors.push(`schedules.${name}.playbook names no task playbook: ${schedule.playbook}.`);
    } else if (playbook.requiresWorktree) {
      errors.push(`schedules.${name}.playbook names ${schedule.playbook}, which needs a worktree that a schedule cannot set up.`);
    }
  }

  return errors;
}

/** A playbook entry's parse error and its unknown template variable, so the operator sees both at once. */
function playbookErrors(name: string, entry: unknown, defaultProvider: Provider): string[] {
  const parsed = parsePlaybook(name, entry, defaultProvider);
  const errors = 'error' in parsed ? [parsed.error] : [];
  const fields = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
  const template = fields['template'];

  if (typeof template === 'string') {
    const unknown = templateError(template, fields['kind'] === 'triage' ? TRIAGE_VARIABLES : TEMPLATE_VARIABLES);

    if (unknown !== null) {
      errors.push(unknown);
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

/** Reads settings.json for the settings editor, valid or not. */
export function readConfigFile(configDir: string): SettingsFile {
  const path = settingsPath(configDir);
  const text = readText(path);
  const file: SettingsFile = { path, version: fileVersion(text), value: {}, error: null };

  if (text === null) {
    return file;
  }

  try {
    return { ...file, value: JSON.parse(text) };
  } catch (error) {
    return { ...file, value: null, error: `settings.json is not valid JSON: ${(error as Error).message}` };
  }
}

/** A save's refusal, or the version of the text it wrote, so the editor can keep editing over it. */
export type SaveResult = { errors: string[]; version: string | null };

/** Writes settings.json as formatted JSON. Refuses when the file changed since `version` was read, or with the errors of {@link checkSettings}. */
export function saveSettings(configDir: string, value: unknown, version: string | null, enabled: ReadonlySet<string>, recorded: Readonly<Record<string, string>> = {}): SaveResult {
  const path = settingsPath(configDir);

  if (fileVersion(readText(path)) !== version) {
    return { errors: [changed('settings.json')], version: null };
  }

  const errors = checkSettings(value, enabled, recorded);

  if (errors.length > 0) {
    return { errors, version: null };
  }

  const text = `${JSON.stringify(value, null, 2)}\n`;

  writeAtomic(path, text);
  return { errors: [], version: fileVersion(text) };
}

/**
 * Reads settings.json. A missing file means the defaults and no playbooks; an invalid one keeps `previous` (PRD R42). `recorded` holds the
 * home repository each source's tickets record, which the file may not change.
 */
export function loadConfig(
  configDir: string,
  previous: Config = { settings: DEFAULT_SETTINGS, settingsError: null, playbooks: new Map(), playbookErrors: [] },
  recorded: Readonly<Record<string, string>> = {},
): Config {
  let text: string;

  try {
    text = readFileSync(settingsPath(configDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { settings: DEFAULT_SETTINGS, settingsError: null, playbooks: new Map(), playbookErrors: [] };
    }

    return { ...previous, settingsError: `settings.json could not be read: ${(error as Error).message}` };
  }

  const parsed = parseSettings(text);

  const rejected = 'errors' in parsed ? parsed.errors : sourcesErrors(parsed.settings, recorded);

  if ('errors' in parsed || rejected.length > 0) {
    return { ...previous, settingsError: rejected.join(' ') };
  }

  const { playbooks, errors } = parsePlaybooks((JSON.parse(text) as { playbooks?: unknown }).playbooks, parsed.settings.sessions.provider);

  return { settings: parsed.settings, settingsError: null, playbooks, playbookErrors: errors };
}
