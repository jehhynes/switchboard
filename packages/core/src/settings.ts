import { ADHOC_SOURCE } from './flow.js';
import { SCHEDULE_SOURCE } from './schedule.js';

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
  /** The Claude Code CLI the hub and Open in terminal run; a bare name is looked up on the hub's or the item window's PATH. */
  claudePath: string;
  /** The Codex CLI the hub and Open in terminal run; a bare name is looked up on the hub's or the item window's PATH. */
  codexPath: string;
  /** The Node.js that Switchboard's hooks and session reports run; a bare name is looked up on the running agent's PATH. */
  nodePath: string;
  codex: CodexSettings;
  installHooks: boolean;
  /** Ask each finished Claude session what slowed it down, for the friction-review skill (PRD R55). */
  debriefs: boolean;
  /** Start new Claude sessions in Code Mode in the terminal holder (PRD R93); experimental, off by default. */
  codeMode: boolean;
}

export interface TriageSettings {
  model: string;
  concurrency: number;
  timeoutSeconds: number;
}

/** Fields every source has. The source plugin validates its own keys in `options`. */
export interface SourceSettings {
  /** The plugin, such as `github`; the source's name when not set, so one plugin can read several sources (PRD R3). */
  kind: string;
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

/** Where a dock row opens its work (PRD R71): `always` in its VS Code item window, `review` in a terminal until it is `awaiting-approval` or `finished`. */
export const OPEN_VSCODE = ['always', 'review'] as const;

export type OpenVSCode = (typeof OPEN_VSCODE)[number];

/**
 * Where the dock's Open in terminal runs with `dock.openVSCode: always` (PRD R28): `vscode` in the item window, `app` in the terminal app,
 * `auto` in the item window while it is open and otherwise in the terminal app. With `review` it always runs in the terminal app.
 */
export const OPEN_TERMINAL = ['vscode', 'app', 'auto'] as const;

export type OpenTerminal = (typeof OPEN_TERMINAL)[number];

/** Where a dock row's click opens its work item (PRD R71): `vscode` as `dock.openVSCode` says, `web` in the installed web page; Alt-click opens the other. */
export const OPEN_IN = ['vscode', 'web'] as const;

export type OpenIn = (typeof OPEN_IN)[number];

export interface DockSettings {
  openVSCode: OpenVSCode;
  openTerminal: OpenTerminal;
  openIn: OpenIn;
}

/**
 * Which surface raises needs-you alerts (PRD R65), so one event alerts once: `auto` the installed web page while one is open, else the dock;
 * `web` any open web page, the installed one first, else the dock; `dock` the dock.
 */
export const ALERT_SURFACES = ['auto', 'web', 'dock'] as const;

export type AlertSurface = (typeof ALERT_SURFACES)[number];

export interface AlertSettings {
  surface: AlertSurface;
}

/** How the web page's diff viewer lays out a file's sides: side by side, stacked, or side by side from 900 px and stacked under it. */
export const DIFF_LAYOUTS = ['auto', 'split', 'stacked'] as const;

export type DiffLayoutSetting = (typeof DIFF_LAYOUTS)[number];

/** Whether the diff viewer wraps long lines: always, never, or only while `auto` layout stacks the sides. */
export const DIFF_WRAPS = ['auto', 'on', 'off'] as const;

export type DiffWrapSetting = (typeof DIFF_WRAPS)[number];

/** The settings a VS Code window's view and the web page read, in a stream's `hello` and its `settings` event. */
export interface ViewSettings {
  iframeBrowser?: boolean;
  briefReplies: boolean;
  /** The inverse of `briefReplies`, for a VS Code window that still runs an extension build from before Brief replies, until it reloads. */
  expandReplies: boolean;
  diffLayout: DiffLayoutSetting;
  diffWrap: DiffWrapSetting;
}

/** The web page (architecture.md § Web page). */
export interface WebSettings {
  /** The port the hub serves the page on, read at hub start, so an installed page keeps its address; 0 serves it only on the hub's own port. */
  port: number;
  /** GitHub iframe proof of concept; off by default. */
  iframeBrowser: boolean;
  /**
   * Names the page also answers as when a request comes through a local HTTPS proxy, `tailscale serve` (architecture.md § Remote access), such as
   * `pc.tailnet.ts.net`; read at hub start. Empty by default, so the page answers only on this computer.
   */
  remoteHosts: string[];
  /** The `Tailscale-User-Login` values a remote request must carry, such as the operator's Tailscale login; read at hub start. */
  remoteLogins: string[];
  /** At hub start, adds this machine's Tailscale name to `remoteHosts` and its owner's login to `remoteLogins`, from `tailscale status --json`. */
  tailscale: boolean;
  /** The diff viewer's layout on every page (PRD R118); `auto` by default. */
  diffLayout: DiffLayoutSetting;
  /** The diff viewer's line wrapping on every page; `auto` by default. */
  diffWrap: DiffWrapSetting;
}

/** A DNS name with at least two labels, lowercase, that is not an IP address: the form a remote host takes. */
export const REMOTE_HOST = /^(?=.{1,253}$)(?!\d+(\.\d+)*$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The voices of OpenAI's realtime speech models (voice-design § 4.8); OpenAI recommends marin and cedar. */
export const TTS_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'] as const;

export type TtsVoice = (typeof TTS_VOICES)[number];

/** The speaking styles the voice process reads with; `none` adds no delivery of its own. */
export const SPEECH_STYLES = ['none', 'pair', 'upbeat', 'deadpan', 'expressive'] as const;

export type SpeechStyle = (typeof SPEECH_STYLES)[number];

/** Speech speed, 1 the voice's own pace (OpenAI's realtime `speed`). */
export const SPEECH_SPEED = { min: 0.25, max: 1.5 } as const;

/**
 * A persona (architecture.md § Personas): a name, a personality and a voice with its speaking style. The personality sets the speaking style's
 * delivery and the tone section of a Code Mode session's prompt; `id` names it in `playbookPersonas`, a pin and the store.
 */
export interface Persona {
  id: string;
  name: string;
  voice: TtsVoice;
  style: SpeechStyle;
  /** How the persona sounds and writes, in a few words or sentences; empty for none. */
  personality: string;
}

/** A persona's longest name and personality. */
export const PERSONA_NAME_MAX = 40;
export const PERSONALITY_MAX = 600;
/** The longest name an alert calls the operator by. */
export const OPERATOR_NAME_MAX = 40;

/** How dictation listens while the voice plays (architecture.md § Dictation). */
export const DUPLEX_MODES = ['auto', 'full', 'half'] as const;

export type DuplexMode = (typeof DUPLEX_MODES)[number];

/** Speech out (architecture.md § Voice): machine-wide, off by default. */
export interface VoiceSettings {
  /** The central voice setting: no voice process, no spoken replies and no voice controls while off. */
  enabled: boolean;
  /** The TTS voice. */
  voice: TtsVoice;
  style: SpeechStyle;
  speed: number;
  /** Tag spoken messages `[expressive]`, so Claude writes a tone line, and read with it. */
  expressive: boolean;
  /** Show a reply's primary response first, its details behind Show more (focused mode); off, every reply shows whole. */
  briefReplies: boolean;
  /** Minutes with the focus outside every scoped window after which the voice drops its target. */
  awayMinutes: number;
  /** Play a short sound when a work item other than the voice target's starts needing the operator. */
  needsYouSound: boolean;
  /** The playback device, a case-insensitive part of its name; null for the system default. */
  outputDevice: string | null;
  /** Minutes of silence after which capture stops even with the voice here; 0 never stops it. */
  micIdleMinutes: number;
  /** The end-of-message pause in milliseconds, which turn detection shortens when the words look finished. */
  endPauseMs: number;
  /** The capture device, a case-insensitive part of its name; null for the system default. */
  inputDevice: string | null;
  /** On capture with no echo cancellation, how long after the voice stops playing listening resumes, in milliseconds. */
  halfDuplexTailMs: number;
  /**
   * Whether dictation listens while the voice plays, on this computer and over Remote Desktop: `auto` decides from the capture's echo
   * cancellation, `full` always listens, so talking over a reply stops it, and `half` never does.
   */
  duplex: { local: DuplexMode; remote: DuplexMode };
  /** The voice check's least match score against the enrolled voiceprint, from 0 to 1 (voice-design decision 27). */
  matchThreshold: number;
  /** The multiple of the enrolled voice's p90 pitch below which a voiced frame counts as low. */
  pitchLowFactor: number;
  /** The least share of low frames a piece needs to pass the pitch check. */
  pitchMinLowShare: number;
  /** The room hold: after the voice check hears a voice that is not the operator's, dictated turns stay in the composer unsent for a while. */
  roomHold: boolean;
  /** How long the room hold lasts after the latest voice that is not the operator's, in seconds. */
  roomHoldSeconds: number;
  /** The persona roster; empty, the default, leaves every session with `voice` and `style` and no tone section. */
  personas: Persona[];
  /** A persona ID by playbook name, which that playbook's sessions take unless one is pinned. */
  playbookPersonas: Record<string, string>;
  /** Spoken alerts (architecture.md § Spoken alerts): the voice calls the operator when a session that is not the voice target needs them. */
  spokenAlerts: boolean;
  /** Which events alert: a turn finished, a question waits, a permission prompt waits. */
  alertOn: { finished: boolean; question: boolean; permission: boolean };
  /** How long the voice listens for an answer after an alert, in seconds. */
  alertAnswerSeconds: number;
  /** The name an alert calls the operator by, as in "Hey Alex?"; empty says only "Hey?". */
  operatorName: string;
}

export interface Settings {
  sessions: SessionSettings;
  triage: TriageSettings;
  sources: Record<string, SourceSettings>;
  schedules: Record<string, ScheduleSettings>;
  dock: DockSettings;
  alerts: AlertSettings;
  voice: VoiceSettings;
  web: WebSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  // Commands in Codex's sandbox cannot use the operator's credentials, such as gh's, so Codex sessions default to no sandbox (mechanics M31).
  sessions: { provider: 'claude', concurrency: 2, permissionMode: 'auto', model: '', claudePath: 'claude', codexPath: 'codex', nodePath: 'node', codex: { permissionMode: 'bypassPermissions', model: '' }, installHooks: true, debriefs: false, codeMode: false },
  triage: { model: '', concurrency: 2, timeoutSeconds: 180 },
  sources: {},
  schedules: {},
  dock: { openVSCode: 'always', openTerminal: 'vscode', openIn: 'vscode' },
  alerts: { surface: 'auto' },
  voice: { enabled: false, voice: 'marin', style: 'none', speed: 1, expressive: false, briefReplies: false, awayMinutes: 2, needsYouSound: true, outputDevice: null, micIdleMinutes: 10, endPauseMs: 3000, inputDevice: null, halfDuplexTailMs: 800, duplex: { local: 'auto', remote: 'auto' }, matchThreshold: 0.6, pitchLowFactor: 1.22, pitchMinLowShare: 0.2, roomHold: true, roomHoldSeconds: 60, personas: [], playbookPersonas: {}, spokenAlerts: true, alertOn: { finished: true, question: true, permission: true }, alertAnswerSeconds: 10, operatorName: '' },
  web: { port: 47616, iframeBrowser: false, remoteHosts: [], remoteLogins: [], tailscale: false, diffLayout: 'auto', diffWrap: 'auto' },
};

/** A source's or schedule's name: it keys tickets in the store and History. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

const SOURCE_DEFAULTS = { kind: '', pollIntervalSeconds: 300, repoRoot: '', triagePlaybook: '', setupPrompt: '', namespace: '' };

export type SettingsResult = { settings: Settings } | { errors: string[] };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The name `sessions.nodePath` must end with, after any directory. */
export const NODE_NAME = /(^|\/)node(\.exe)?$/i;

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

  /** A number within a range, whole or not. */
  number(section: Json, key: string, path: string, fallback: number, min: number, max: number): number {
    const value = section[key];

    if (value === undefined) {
      return fallback;
    }

    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      this.errors.push(`${path}.${key} must be a number from ${min} to ${max}.`);
      return fallback;
    }

    return value;
  }

  /** A list of strings, each matching `pattern` once lowercased, without repeats; `what` names one in the error. */
  names(section: Json, key: string, path: string, pattern: RegExp, what: string): string[] {
    const value = section[key];

    if (value === undefined) {
      return [];
    }

    if (!Array.isArray(value) || value.some((one) => typeof one !== 'string' || !pattern.test(one.trim().toLowerCase()))) {
      this.errors.push(`${path}.${key} must be a list of ${what}.`);
      return [];
    }

    return [...new Set(value.map((one: string) => one.trim().toLowerCase()))];
  }

  /** A non-empty string, or null. */
  optionalName(section: Json, key: string, path: string): string | null {
    const value = section[key];

    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string' || value.trim() === '') {
      this.errors.push(`${path}.${key} must be a device name or null.`);
      return null;
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

  /**
   * A Node.js executable that hook commands and the report command name as their first word, run by bash, PowerShell or cmd. Those shells
   * agree only on a word with no whitespace, quotes or shell characters, written with forward slashes, so a path is refused otherwise and its
   * backslashes are turned to slashes. Its name must be `node` or `node.exe`, which is how Switchboard tells its own hook entries apart.
   */
  nodePath(section: Json, key: string, path: string, fallback: string): string {
    const value = this.path(section, key, path, fallback).replaceAll('\\', '/');

    if (!/^[A-Za-z0-9_.:/+-]+$/.test(value) || !NODE_NAME.test(value)) {
      this.errors.push(`${path}.${key} must be a path to node or node.exe with no spaces or shell characters.`);
      return fallback;
    }

    return value;
  }

  /** A non-empty string naming an executable. */
  path(section: Json, key: string, path: string, fallback: string): string {
    const value = section[key];

    if (value === undefined) {
      return fallback;
    }

    if (typeof value !== 'string' || value === '') {
      this.errors.push(`${path}.${key} must be a path.`);
      return fallback;
    }

    return value;
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
  read.unknown(root, ['sessions', 'triage', 'sources', 'schedules', 'dock', 'alerts', 'voice', 'web', 'playbooks'], 'settings');
  // Each playbook is checked on its own by `parsePlaybooks`, so an invalid one is left out rather than rejecting the file.
  read.section(root, 'playbooks', 'playbooks');

  const sessionsIn = read.section(root, 'sessions', 'sessions');
  const defaults = DEFAULT_SETTINGS;
  read.unknown(sessionsIn, ['provider', 'concurrency', 'permissionMode', 'model', 'claudePath', 'codexPath', 'nodePath', 'codex', 'installHooks', 'debriefs', 'codeMode'], 'sessions');
  const codexIn = read.section(sessionsIn, 'codex', 'sessions.codex');
  read.unknown(codexIn, ['permissionMode', 'model'], 'sessions.codex');
  const sessions: SessionSettings = {
    provider: read.choice(sessionsIn, 'provider', 'sessions', PROVIDERS, defaults.sessions.provider),
    concurrency: read.integer(sessionsIn, 'concurrency', 'sessions', defaults.sessions.concurrency, 1, 10),
    permissionMode: read.choice(sessionsIn, 'permissionMode', 'sessions', PERMISSION_MODES, defaults.sessions.permissionMode),
    model: read.string(sessionsIn, 'model', 'sessions', defaults.sessions.model),
    claudePath: read.path(sessionsIn, 'claudePath', 'sessions', defaults.sessions.claudePath),
    codexPath: read.path(sessionsIn, 'codexPath', 'sessions', defaults.sessions.codexPath),
    nodePath: read.nodePath(sessionsIn, 'nodePath', 'sessions', defaults.sessions.nodePath),
    codex: {
      permissionMode: read.choice(codexIn, 'permissionMode', 'sessions.codex', CODEX_PERMISSION_MODES, defaults.sessions.codex.permissionMode),
      model: read.string(codexIn, 'model', 'sessions.codex', defaults.sessions.codex.model),
    },
    installHooks: read.boolean(sessionsIn, 'installHooks', 'sessions', defaults.sessions.installHooks),
    debriefs: read.boolean(sessionsIn, 'debriefs', 'sessions', defaults.sessions.debriefs),
    codeMode: read.boolean(sessionsIn, 'codeMode', 'sessions', defaults.sessions.codeMode),
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
    const { enabled, kind, pollIntervalSeconds, repoRoot, triagePlaybook, setupPrompt, namespace, ...options } = sourceIn;
    const common = { kind, pollIntervalSeconds, repoRoot, triagePlaybook, setupPrompt, namespace };

    if (!NAME.test(name)) {
      read.errors.push(`${path}: a source's name must be lowercase letters, digits and hyphens.`);
    } else if (name === SCHEDULE_SOURCE) {
      read.errors.push(`${path}: schedules are set under schedules.`);
    } else if (name === ADHOC_SOURCE && kind !== undefined) {
      read.errors.push(`${path}.kind is not a setting; adhoc holds only the ad-hoc repo root.`);
    }

    if (enabled !== undefined) {
      read.errors.push(`${path}.enabled is not a setting; turn a source on and off in the dock's header.`);
    }

    const root = read.string(common, 'repoRoot', path, SOURCE_DEFAULTS.repoRoot);
    const rootError = name === ADHOC_SOURCE ? literalRootError(root) : patternError(root);

    if (rootError !== null) {
      read.errors.push(`${path}.repoRoot ${rootError}`);
    }

    sources[name] = {
      kind: read.string(common, 'kind', path, SOURCE_DEFAULTS.kind) || name,
      pollIntervalSeconds: read.integer(common, 'pollIntervalSeconds', path, SOURCE_DEFAULTS.pollIntervalSeconds, 10),
      repoRoot: root,
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

    if (!NAME.test(name)) {
      read.errors.push(`${path}: a schedule's name must be lowercase letters, digits and hyphens.`);
      continue;
    }

    schedules[name] = parseSchedule(read, read.section(schedulesIn, name, path), path);
  }

  const dockIn = read.section(root, 'dock', 'dock');
  read.unknown(dockIn, ['openVSCode', 'openTerminal', 'openIn'], 'dock');
  const dock: DockSettings = {
    openVSCode: read.choice(dockIn, 'openVSCode', 'dock', OPEN_VSCODE, defaults.dock.openVSCode),
    openTerminal: read.choice(dockIn, 'openTerminal', 'dock', OPEN_TERMINAL, defaults.dock.openTerminal),
    openIn: read.choice(dockIn, 'openIn', 'dock', OPEN_IN, defaults.dock.openIn),
  };

  const alertsIn = read.section(root, 'alerts', 'alerts');
  read.unknown(alertsIn, ['surface'], 'alerts');
  const alerts: AlertSettings = { surface: read.choice(alertsIn, 'surface', 'alerts', ALERT_SURFACES, defaults.alerts.surface) };

  const voiceIn = read.section(root, 'voice', 'voice');
  read.unknown(voiceIn, ['enabled', 'voice', 'style', 'speed', 'expressive', 'briefReplies', 'expandReplies', 'awayMinutes', 'needsYouSound', 'outputDevice', 'micIdleMinutes', 'endPauseMs', 'inputDevice', 'halfDuplexTailMs', 'duplex', 'matchThreshold', 'pitchLowFactor', 'pitchMinLowShare', 'roomHold', 'roomHoldSeconds', 'personas', 'playbookPersonas', 'spokenAlerts', 'alertOn', 'alertAnswerSeconds', 'operatorName'], 'voice');
  const duplexIn = read.section(voiceIn, 'duplex', 'voice.duplex');
  read.unknown(duplexIn, ['local', 'remote'], 'voice.duplex');
  const alertOnIn = read.section(voiceIn, 'alertOn', 'voice.alertOn');
  read.unknown(alertOnIn, ['finished', 'question', 'permission'], 'voice.alertOn');
  const operatorName = read.string(voiceIn, 'operatorName', 'voice', defaults.voice.operatorName).trim();

  if (operatorName.length > OPERATOR_NAME_MAX) {
    read.errors.push(`voice.operatorName must be at most ${OPERATOR_NAME_MAX} characters.`);
  }

  const voice: VoiceSettings = {
    enabled: read.boolean(voiceIn, 'enabled', 'voice', defaults.voice.enabled),
    voice: read.choice(voiceIn, 'voice', 'voice', TTS_VOICES, defaults.voice.voice),
    style: read.choice(voiceIn, 'style', 'voice', SPEECH_STYLES, defaults.voice.style),
    speed: read.number(voiceIn, 'speed', 'voice', defaults.voice.speed, SPEECH_SPEED.min, SPEECH_SPEED.max),
    expressive: read.boolean(voiceIn, 'expressive', 'voice', defaults.voice.expressive),
    // voice.expandReplies, which Brief replies replaced, still counts as its inverse in a file with no voice.briefReplies.
    briefReplies: read.boolean(voiceIn, 'briefReplies', 'voice', !read.boolean(voiceIn, 'expandReplies', 'voice', !defaults.voice.briefReplies)),
    awayMinutes: read.integer(voiceIn, 'awayMinutes', 'voice', defaults.voice.awayMinutes, 1, 1440),
    needsYouSound: read.boolean(voiceIn, 'needsYouSound', 'voice', defaults.voice.needsYouSound),
    outputDevice: read.optionalName(voiceIn, 'outputDevice', 'voice'),
    micIdleMinutes: read.integer(voiceIn, 'micIdleMinutes', 'voice', defaults.voice.micIdleMinutes, 0, 1440),
    endPauseMs: read.integer(voiceIn, 'endPauseMs', 'voice', defaults.voice.endPauseMs, 500, 20_000),
    inputDevice: read.optionalName(voiceIn, 'inputDevice', 'voice'),
    halfDuplexTailMs: read.integer(voiceIn, 'halfDuplexTailMs', 'voice', defaults.voice.halfDuplexTailMs, 0, 5000),
    duplex: {
      local: read.choice(duplexIn, 'local', 'voice.duplex', DUPLEX_MODES, defaults.voice.duplex.local),
      remote: read.choice(duplexIn, 'remote', 'voice.duplex', DUPLEX_MODES, defaults.voice.duplex.remote),
    },
    matchThreshold: read.number(voiceIn, 'matchThreshold', 'voice', defaults.voice.matchThreshold, 0, 1),
    pitchLowFactor: read.number(voiceIn, 'pitchLowFactor', 'voice', defaults.voice.pitchLowFactor, 1, 3),
    pitchMinLowShare: read.number(voiceIn, 'pitchMinLowShare', 'voice', defaults.voice.pitchMinLowShare, 0, 1),
    roomHold: read.boolean(voiceIn, 'roomHold', 'voice', defaults.voice.roomHold),
    roomHoldSeconds: read.integer(voiceIn, 'roomHoldSeconds', 'voice', defaults.voice.roomHoldSeconds, 1, 3600),
    personas: [],
    playbookPersonas: {},
    spokenAlerts: read.boolean(voiceIn, 'spokenAlerts', 'voice', defaults.voice.spokenAlerts),
    alertOn: {
      finished: read.boolean(alertOnIn, 'finished', 'voice.alertOn', defaults.voice.alertOn.finished),
      question: read.boolean(alertOnIn, 'question', 'voice.alertOn', defaults.voice.alertOn.question),
      permission: read.boolean(alertOnIn, 'permission', 'voice.alertOn', defaults.voice.alertOn.permission),
    },
    alertAnswerSeconds: read.integer(voiceIn, 'alertAnswerSeconds', 'voice', defaults.voice.alertAnswerSeconds, 3, 60),
    operatorName,
  };

  voice.personas = parsePersonas(read, voiceIn['personas'], voice);
  voice.playbookPersonas = parsePlaybookPersonas(read, voiceIn['playbookPersonas'], voice.personas);

  const webIn = read.section(root, 'web', 'web');
  read.unknown(webIn, ['port', 'chromePane', 'iframeBrowser', 'remoteHosts', 'remoteLogins', 'tailscale', 'diffLayout', 'diffWrap'], 'web');
  const web: WebSettings = {
    port: read.integer(webIn, 'port', 'web', defaults.web.port, 0, 65535),
    iframeBrowser: read.boolean(webIn, 'iframeBrowser', 'web', defaults.web.iframeBrowser),
    remoteHosts: read.names(webIn, 'remoteHosts', 'web', REMOTE_HOST, 'host names such as pc.tailnet.ts.net, without a port'),
    remoteLogins: read.names(webIn, 'remoteLogins', 'web', /^[^\s,;]+$/, 'logins without spaces'),
    tailscale: read.boolean(webIn, 'tailscale', 'web', defaults.web.tailscale),
    diffLayout: read.choice(webIn, 'diffLayout', 'web', DIFF_LAYOUTS, defaults.web.diffLayout),
    diffWrap: read.choice(webIn, 'diffWrap', 'web', DIFF_WRAPS, defaults.web.diffWrap),
  };

  return read.errors.length > 0 ? { errors: read.errors } : { settings: { sessions, triage, sources, schedules, dock, alerts, voice, web } };
}

/** `voice.personas`: each persona's ID unique, its voice and style defaulting to the section's. */
function parsePersonas(read: Reader, value: unknown, voice: Pick<VoiceSettings, 'voice' | 'style'>): Persona[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    read.errors.push('voice.personas must be a list.');
    return [];
  }

  const personas: Persona[] = [];

  value.forEach((entry: unknown, index) => {
    const path = `voice.personas[${index}]`;

    if (!isObject(entry)) {
      read.errors.push(`${path} must be an object.`);
      return;
    }

    read.unknown(entry, ['id', 'name', 'voice', 'style', 'personality'], path);

    const id = read.string(entry, 'id', path, '');
    const name = read.string(entry, 'name', path, '').trim();
    const personality = read.string(entry, 'personality', path, '').trim();

    if (!NAME.test(id)) {
      read.errors.push(`${path}.id must be lowercase letters, digits and hyphens.`);
    } else if (personas.some((other) => other.id === id)) {
      read.errors.push(`${path}.id ${id} is used by another persona.`);
    }

    if (name === '' || name.length > PERSONA_NAME_MAX) {
      read.errors.push(`${path}.name must be 1 to ${PERSONA_NAME_MAX} characters.`);
    }

    if (personality.length > PERSONALITY_MAX) {
      read.errors.push(`${path}.personality must be at most ${PERSONALITY_MAX} characters.`);
    }

    personas.push({ id, name, voice: read.choice(entry, 'voice', path, TTS_VOICES, voice.voice), style: read.choice(entry, 'style', path, SPEECH_STYLES, voice.style), personality });
  });

  return personas;
}

/** `voice.playbookPersonas`: playbook names to IDs of the roster's personas. Playbooks are read on their own, so a name is not checked. */
function parsePlaybookPersonas(read: Reader, value: unknown, personas: readonly Persona[]): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  if (!isObject(value)) {
    read.errors.push('voice.playbookPersonas must be an object.');
    return {};
  }

  const assigned: Record<string, string> = {};

  for (const [playbook, id] of Object.entries(value)) {
    if (typeof id !== 'string' || !personas.some((persona) => persona.id === id)) {
      read.errors.push(`voice.playbookPersonas.${playbook} must name a persona in voice.personas.`);
      continue;
    }

    assigned[playbook] = id;
  }

  return assigned;
}

/** Why a source's repo root is not a usable pattern: `{name}` and `{owner}` each at most once, and `{owner}` only with `{name}` (PRD R16). */
function patternError(root: string): string | null {
  const count = (part: string) => root.split(part).length - 1;

  if (count('{name}') > 1 || count('{owner}') > 1) {
    return 'may hold {name} and {owner} at most once each.';
  }

  return count('{owner}') === 1 && count('{name}') === 0 ? 'holds {owner} without {name}.' : null;
}

/** Why a root that names one folder holds a pattern's placeholder. */
function literalRootError(root: string): string | null {
  return /\{(name|owner)\}/.test(root) ? 'names one folder and cannot hold {name} or {owner}.' : null;
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

  if (literalRootError(repoRoot) !== null) {
    read.errors.push(`${path}.repoRoot ${literalRootError(repoRoot)}`);
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
