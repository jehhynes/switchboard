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

/** Weekday names in `Date.getDay()` order. */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export const SCHEDULE_PERIODS = ['day', 'week', 'month'] as const;

export type SchedulePeriod = (typeof SCHEDULE_PERIODS)[number];

/** A playbook that runs on a calendar or by hand, with no ticket from a source (PRD R82). */
export interface ScheduleSettings {
  playbook: string;
  /** The directory its sessions run in. */
  repoRoot: string;
  /** Null when it runs only by hand. */
  every: SchedulePeriod | null;
  /** A weekly schedule's weekday or a monthly one's day of the month, 1 to 31; null otherwise. */
  day: Weekday | number | null;
  /** Local time of day in minutes after midnight; null when it runs only by hand. */
  at: number | null;
}

export interface Settings {
  sessions: SessionSettings;
  triage: TriageSettings;
  sources: Record<string, SourceSettings>;
  schedules: Record<string, ScheduleSettings>;
}

export const DEFAULT_SETTINGS: Settings = {
  // Commands in Codex's sandbox cannot use the operator's credentials, such as gh's, so Codex sessions default to no sandbox (mechanics M31).
  sessions: { provider: 'claude', concurrency: 2, permissionMode: 'auto', model: '', codex: { permissionMode: 'bypassPermissions', model: '' }, installHooks: true, debriefs: false },
  triage: { model: '', concurrency: 2, timeoutSeconds: 180 },
  sources: {},
  schedules: {},
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
  read.unknown(root, ['sessions', 'triage', 'sources', 'schedules', 'playbooks'], 'settings');
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

  const schedulesIn = read.section(root, 'schedules', 'schedules');
  const schedules: Record<string, ScheduleSettings> = {};

  for (const name of Object.keys(schedulesIn)) {
    const path = `schedules.${name}`;

    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      read.errors.push(`${path}: a schedule's name must be lowercase letters, digits and hyphens.`);
      continue;
    }

    schedules[name] = parseSchedule(read, read.section(schedulesIn, name, path), path);
  }

  return read.errors.length > 0 ? { errors: read.errors } : { settings: { sessions, triage, sources, schedules } };
}

function parseSchedule(read: Reader, entry: Json, path: string): ScheduleSettings {
  read.unknown(entry, ['playbook', 'repoRoot', 'every', 'day', 'at'], path);

  const playbook = read.string(entry, 'playbook', path, '');
  const repoRoot = read.string(entry, 'repoRoot', path, '');
  const every = entry['every'] === undefined ? null : read.choice(entry, 'every', path, SCHEDULE_PERIODS, 'day');
  let day: Weekday | number | null = null;
  let at: number | null = null;

  if (playbook === '') {
    read.errors.push(`${path}.playbook must name a task playbook.`);
  }

  if (repoRoot === '') {
    read.errors.push(`${path}.repoRoot must be set.`);
  }

  if (every === 'week') {
    // Listed from Monday, so the error names the days in the order people read a week.
    day = read.choice(entry, 'day', path, [...WEEKDAYS.slice(1), WEEKDAYS[0]], 'mon');

    if (entry['day'] === undefined) {
      read.errors.push(`${path}.day must be one of mon, tue, wed, thu, fri, sat, sun.`);
    }
  } else if (every === 'month') {
    day = read.integer(entry, 'day', path, 1, 1, 31);

    if (entry['day'] === undefined) {
      read.errors.push(`${path}.day must be a whole number from 1 to 31.`);
    }
  } else if (entry['day'] !== undefined) {
    read.errors.push(`${path}.day applies only to a weekly or monthly schedule.`);
  }

  if (every === null) {
    if (entry['at'] !== undefined) {
      read.errors.push(`${path}.at applies only with every.`);
    }
  } else {
    const match = typeof entry['at'] === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(entry['at']) : null;

    if (match === null) {
      read.errors.push(`${path}.at must be a time from 00:00 to 23:59, such as 09:00.`);
    } else {
      at = Number(match[1]) * 60 + Number(match[2]);
    }
  }

  return { playbook, repoRoot, every, day, at };
}
