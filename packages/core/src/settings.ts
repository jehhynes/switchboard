/** Claude Code's `--permission-mode` choices. */
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface SessionSettings {
  concurrency: number;
  permissionMode: PermissionMode;
  /** Empty means Claude's default model. */
  model: string;
  installHooks: boolean;
}

export interface TriageSettings {
  model: string;
  concurrency: number;
  timeoutSeconds: number;
}

/** Fields every source has. The source plugin validates its own keys in `options`. */
export interface SourceSettings {
  enabled: boolean;
  pollIntervalSeconds: number;
  repoRoot: string;
  triagePlaybook: string;
  setupPrompt: string;
  options: Record<string, unknown>;
}

export interface Settings {
  sessions: SessionSettings;
  triage: TriageSettings;
  sources: Record<string, SourceSettings>;
}

export const DEFAULT_SETTINGS: Settings = {
  sessions: { concurrency: 2, permissionMode: 'auto', model: '', installHooks: true },
  triage: { model: '', concurrency: 2, timeoutSeconds: 180 },
  sources: {},
};

const SOURCE_DEFAULTS = { enabled: false, pollIntervalSeconds: 300, repoRoot: '', triagePlaybook: '', setupPrompt: '' };

export type SettingsResult = { settings: Settings } | { errors: string[] };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Reader {
  readonly errors: string[] = [];

  section(parent: Json, key: string, path: string): Json {
    const value = parent[key];

    if (value === undefined) {
      return {};
    }

    if (!isObject(value)) {
      this.errors.push(`${path} must be an object.`);
      return {};
    }

    return value;
  }

  unknown(section: Json, known: readonly string[], path: string): void {
    for (const key of Object.keys(section)) {
      if (!known.includes(key)) {
        this.errors.push(`${path}.${key} is not a setting.`);
      }
    }
  }

  integer(section: Json, key: string, path: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
    const value = section[key];

    if (value === undefined) {
      return fallback;
    }

    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      this.errors.push(max === Number.MAX_SAFE_INTEGER ? `${path}.${key} must be a whole number of at least ${min}.` : `${path}.${key} must be a whole number from ${min} to ${max}.`);
      return fallback;
    }

    return value;
  }

  string(section: Json, key: string, path: string, fallback: string): string {
    const value = section[key];

    if (value === undefined) {
      return fallback;
    }

    if (typeof value !== 'string') {
      this.errors.push(`${path}.${key} must be a string.`);
      return fallback;
    }

    return value;
  }

  boolean(section: Json, key: string, path: string, fallback: boolean): boolean {
    const value = section[key];

    if (value === undefined) {
      return fallback;
    }

    if (typeof value !== 'boolean') {
      this.errors.push(`${path}.${key} must be true or false.`);
      return fallback;
    }

    return value;
  }

  permissionMode(section: Json, key: string, path: string, fallback: PermissionMode): PermissionMode {
    const value = this.string(section, key, path, fallback);

    if (!(PERMISSION_MODES as readonly string[]).includes(value)) {
      this.errors.push(`${path}.${key} must be one of ${PERMISSION_MODES.join(', ')}.`);
      return fallback;
    }

    return value as PermissionMode;
  }
}

/** Parses `settings.json`. Any error rejects the whole file, so the hub keeps the last valid settings (PRD R42). */
export function parseSettings(text: string): SettingsResult {
  let root: unknown;

  try {
    root = JSON.parse(text);
  } catch (error) {
    return { errors: [`settings.json is not valid JSON: ${(error as Error).message}`] };
  }

  if (!isObject(root)) {
    return { errors: ['settings.json must contain an object.'] };
  }

  const read = new Reader();
  read.unknown(root, ['sessions', 'triage', 'sources'], 'settings');

  const sessionsIn = read.section(root, 'sessions', 'sessions');
  const defaults = DEFAULT_SETTINGS;
  read.unknown(sessionsIn, ['concurrency', 'permissionMode', 'model', 'installHooks'], 'sessions');
  const sessions: SessionSettings = {
    concurrency: read.integer(sessionsIn, 'concurrency', 'sessions', defaults.sessions.concurrency, 1, 4),
    permissionMode: read.permissionMode(sessionsIn, 'permissionMode', 'sessions', defaults.sessions.permissionMode),
    model: read.string(sessionsIn, 'model', 'sessions', defaults.sessions.model),
    installHooks: read.boolean(sessionsIn, 'installHooks', 'sessions', defaults.sessions.installHooks),
  };

  const triageIn = read.section(root, 'triage', 'triage');
  read.unknown(triageIn, ['model', 'concurrency', 'timeoutSeconds'], 'triage');
  const triage: TriageSettings = {
    model: read.string(triageIn, 'model', 'triage', defaults.triage.model),
    concurrency: read.integer(triageIn, 'concurrency', 'triage', defaults.triage.concurrency, 1),
    timeoutSeconds: read.integer(triageIn, 'timeoutSeconds', 'triage', defaults.triage.timeoutSeconds, 1),
  };

  const sourcesIn = read.section(root, 'sources', 'sources');
  const sources: Record<string, SourceSettings> = {};

  for (const name of Object.keys(sourcesIn)) {
    const path = `sources.${name}`;
    const sourceIn = read.section(sourcesIn, name, path);
    const { enabled, pollIntervalSeconds, repoRoot, triagePlaybook, setupPrompt, ...options } = sourceIn;
    const common = { enabled, pollIntervalSeconds, repoRoot, triagePlaybook, setupPrompt };

    sources[name] = {
      enabled: read.boolean(common, 'enabled', path, SOURCE_DEFAULTS.enabled),
      pollIntervalSeconds: read.integer(common, 'pollIntervalSeconds', path, SOURCE_DEFAULTS.pollIntervalSeconds, 10),
      repoRoot: read.string(common, 'repoRoot', path, SOURCE_DEFAULTS.repoRoot),
      triagePlaybook: read.string(common, 'triagePlaybook', path, SOURCE_DEFAULTS.triagePlaybook),
      setupPrompt: read.string(common, 'setupPrompt', path, SOURCE_DEFAULTS.setupPrompt),
      options,
    };
  }

  return read.errors.length > 0 ? { errors: read.errors } : { settings: { sessions, triage, sources } };
}
