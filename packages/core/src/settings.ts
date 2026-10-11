/** Claude Code's `--permission-mode` choices. */
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The modes a background Codex session can finish in; the others need a person to approve each action (mechanics M31). */
export const CODEX_PERMISSION_MODES = ['auto', 'plan', 'dontAsk', 'bypassPermissions'] as const satisfies readonly PermissionMode[];

export type CodexPermissionMode = (typeof CODEX_PERMISSION_MODES)[number];

/** The agents a session can run in (PRD R22). */
export const PROVIDERS = ['claude', 'codex'] as const;

export type Provider = (typeof PROVIDERS)[number];

export function isCodexPermissionMode(mode: string): mode is CodexPermissionMode {
  return (CODEX_PERMISSION_MODES as readonly string[]).includes(mode);
}

/** Codex's session defaults; `sessions.permissionMode` and `sessions.model` are Claude's. */
export interface CodexSettings {
  permissionMode: CodexPermissionMode;
  /** Empty means Codex's default model. */
  model: string;
}

export interface SessionSettings {
  /** The agent playbook sessions run in unless the playbook names its own. */
  provider: Provider;
  concurrency: number;
  /** Claude's default mode. */
  permissionMode: PermissionMode;
  /** Empty means Claude's default model. */
  model: string;
  codex: CodexSettings;
  installHooks: boolean;
  /** Ask each finished Claude session what slowed it down, for the friction-review skill (PRD R55). */
  debriefs: boolean;
}

export interface TriageSettings {
  model: string;
  concurrency: number;
  timeoutSeconds: number;
}

/** Fields every source has. The source plugin validates its own keys in `options`. */
export interface SourceSettings {
  pollIntervalSeconds: number;
  repoRoot: string;
  triagePlaybook: string;
  setupPrompt: string;
  /** Limits triage to this namespace's task playbooks; empty offers them all. */
  namespace: string;
  options: Record<string, unknown>;
}

export interface Settings {
  sessions: SessionSettings;
  triage: TriageSettings;
  sources: Record<string, SourceSettings>;
}

export const DEFAULT_SETTINGS: Settings = {
  // Commands in Codex's sandbox cannot use the operator's credentials, such as gh's, so Codex sessions default to no sandbox (mechanics M31).
  sessions: { provider: 'claude', concurrency: 2, permissionMode: 'auto', model: '', codex: { permissionMode: 'bypassPermissions', model: '' }, installHooks: true, debriefs: false },
  triage: { model: '', concurrency: 2, timeoutSeconds: 180 },
  sources: {},
};

/** The repos an ad-hoc prompt or a task report can run in: each source's repo root, the first being the default. */
export function repoRoots(settings: Settings): string[] {
  return [...new Set(Object.values(settings.sources).map((source) => source.repoRoot).filter((root) => root !== ''))];
}

const SOURCE_DEFAULTS = { pollIntervalSeconds: 300, repoRoot: '', triagePlaybook: '', setupPrompt: '', namespace: '' };

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

  /** A string from a fixed list. */
  choice<T extends string>(section: Json, key: string, path: string, choices: readonly T[], fallback: T): T {
    const value = this.string(section, key, path, fallback);

    if (!(choices as readonly string[]).includes(value)) {
      this.errors.push(`${path}.${key} must be one of ${choices.join(', ')}.`);
      return fallback;
    }

    return value as T;
  }
}

/** Parses `settings.json`. Any error outside `playbooks` rejects the whole file, so the hub keeps the last valid settings (PRD R42). */
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
  read.unknown(root, ['sessions', 'triage', 'sources', 'playbooks'], 'settings');
  // Each playbook is checked on its own by `parsePlaybooks`, so an invalid one is left out rather than rejecting the file.
  read.section(root, 'playbooks', 'playbooks');

  const sessionsIn = read.section(root, 'sessions', 'sessions');
  const defaults = DEFAULT_SETTINGS;
  read.unknown(sessionsIn, ['provider', 'concurrency', 'permissionMode', 'model', 'codex', 'installHooks', 'debriefs'], 'sessions');
  const codexIn = read.section(sessionsIn, 'codex', 'sessions.codex');
  read.unknown(codexIn, ['permissionMode', 'model'], 'sessions.codex');
  const sessions: SessionSettings = {
    provider: read.choice(sessionsIn, 'provider', 'sessions', PROVIDERS, defaults.sessions.provider),
    concurrency: read.integer(sessionsIn, 'concurrency', 'sessions', defaults.sessions.concurrency, 1, 10),
    permissionMode: read.choice(sessionsIn, 'permissionMode', 'sessions', PERMISSION_MODES, defaults.sessions.permissionMode),
    model: read.string(sessionsIn, 'model', 'sessions', defaults.sessions.model),
    codex: {
      permissionMode: read.choice(codexIn, 'permissionMode', 'sessions.codex', CODEX_PERMISSION_MODES, defaults.sessions.codex.permissionMode),
      model: read.string(codexIn, 'model', 'sessions.codex', defaults.sessions.codex.model),
    },
    installHooks: read.boolean(sessionsIn, 'installHooks', 'sessions', defaults.sessions.installHooks),
    debriefs: read.boolean(sessionsIn, 'debriefs', 'sessions', defaults.sessions.debriefs),
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
    const { enabled, pollIntervalSeconds, repoRoot, triagePlaybook, setupPrompt, namespace, ...options } = sourceIn;
    const common = { pollIntervalSeconds, repoRoot, triagePlaybook, setupPrompt, namespace };

    if (enabled !== undefined) {
      read.errors.push(`${path}.enabled is not a setting; turn a source on and off in the dock's header.`);
    }

    sources[name] = {
      pollIntervalSeconds: read.integer(common, 'pollIntervalSeconds', path, SOURCE_DEFAULTS.pollIntervalSeconds, 10),
      repoRoot: read.string(common, 'repoRoot', path, SOURCE_DEFAULTS.repoRoot),
      triagePlaybook: read.string(common, 'triagePlaybook', path, SOURCE_DEFAULTS.triagePlaybook),
      setupPrompt: read.string(common, 'setupPrompt', path, SOURCE_DEFAULTS.setupPrompt),
      namespace: read.string(common, 'namespace', path, SOURCE_DEFAULTS.namespace),
      options,
    };
  }

  return read.errors.length > 0 ? { errors: read.errors } : { settings: { sessions, triage, sources } };
}
