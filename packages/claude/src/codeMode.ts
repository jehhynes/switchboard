import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ARTIFACTS_ENV, artifactsDir, PERMISSION_MODES, START_PROMPT } from '@switchboard/core';
import type { LiveState, StopReason, MarkerReading, ObservedFork, ObservedSession, PermissionMode, Reconciled, Session, SessionRunner, SessionTarget, StartAction, StartResult } from '@switchboard/core';
import { killTree, processTable } from '@switchboard/holder';
import type { ProcessRow, SessionEntry, SpawnRequest } from '@switchboard/holder';
import { executableDirOnPath } from '@switchboard/core';
import { markerState } from './hooks.js';
import type { Marker } from './hooks.js';
import { readMarkers } from './install.js';
import { claudeNotFound, failureOf } from './exec.js';
import { conversationRules } from './conversationRules.js';

/** The line Claude prints under its banner when Code Mode is on, the start's positive evidence (mechanics M63). */
export const CODE_MODE_ON = 'Code Mode (experimental) is on';
/** The start of the line Claude prints when it starts without Code Mode, followed by the reason (mechanics M64, M71). */
export const CODE_MODE_OFF = "Code Mode (experimental) isn't available:";
/** The direct Anthropic API, which Code Mode requires in place of a gateway (mechanics M64). */
export const DIRECT_API = 'https://api.anthropic.com';
/** How long a start waits for the evidence and its first marker. */
export const CODE_MODE_START_MS = 60_000;
/** A live process with no marker of its launch after this long waits on a prompt in its terminal (mechanics M70). */
export const START_PROMPT_MS = 20_000;
/** A held session with no terminal attached and no input for this long after its turn ended is ended (PRD R95); opening it resumes it at once. */
export const CODE_MODE_IDLE_MS = 60 * 60_000;
const POLL_MS = 1_000;
const COLS = 120;
const ROWS = 40;

export const HOOKS_REQUIRED = 'Claude sessions need sessions.installHooks.';
/** The credential variables only Code Mode must drop (mechanics M64). */
const CREDENTIALS = /^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_CUSTOM_HEADERS|ANTHROPIC_API_KEY)$/i;
/** The variable that turns Code Mode on (mechanics M63). */
const CODE_MODE_VARIABLE = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE';

/**
 * Removed from the hub's environment: VS Code's runtime, Node.js options, credentials (mechanics M64), and the markers a parent Claude session
 * leaves, which make a child think it is a subprocess, as claude-collab's list does. Other `CLAUDE_CODE_*` settings pass through.
 * `NO_COLOR` and `FORCE_COLOR` go too: a Claude session's Bash tool sets `NO_COLOR=1`, so a hub started from one passes it on, and Claude Code
 * without colour draws its suggested prompt as plain text, which typing then reads as a draft (mechanics M149).
 */
const REMOVED =
  /^(ELECTRON_.*|VSCODE_.*|NODE_OPTIONS|CLAUDECODE|CLAUDE_PID|CLAUDE_AGENT_SDK_VERSION|CLAUDE_EFFORT|AI_AGENT|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|ENTRYPOINT|EXECPATH|SSE_PORT|SESSION_ATTENDED|MESSAGING_\w+|EMIT_STARTUP_TIMING|STARTUP_FAILURE_RESULTS|ENABLE_SDK_FILE_CHECKPOINTING|QUESTION_PREVIEW_FORMAT|ENABLE_TASKS|NO_FLICKER)|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_CUSTOM_HEADERS|ANTHROPIC_API_KEY|NO_COLOR|FORCE_COLOR)$/i;

/**
 * The environment of a Code Mode session's process, from the hub's: Code Mode on, the direct API, the launch, the work item's artifact folder
 * (`CLAUDE_ARTIFACTS_DIR`), `TERM` for the holder's xterm, and an absolute `sessions.claudePath`'s folder first on PATH. `CLAUDE_CONFIG_DIR` passes through as for background
 * sessions. A held session without Code Mode (`codeMode` false) gets neither Code Mode nor the direct API and keeps the credential variables, so
 * it runs as the operator's own `claude` does (PRD R81).
 */
export function codeModeEnvironment(base: NodeJS.ProcessEnv, launchId: string, claudePath: string, artifacts: string, codeMode = true): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && (!REMOVED.test(name) || (!codeMode && CREDENTIALS.test(name))) && (codeMode || name.toUpperCase() !== CODE_MODE_VARIABLE)) {
      env[name] = value;
    }
  }

  const mode = codeMode ? { [CODE_MODE_VARIABLE]: '1', ANTHROPIC_BASE_URL: DIRECT_API } : {};

  // The holder emulates an xterm; without TERM, as under VS Code on Windows, Claude Code draws its prompt as ">" and its warnings in ASCII.
  return { ...env, ...executableDirOnPath(claudePath, env), ...mode, TERM: 'xterm-256color', SWITCHBOARD_LAUNCH: launchId, [ARTIFACTS_ENV]: artifacts };
}

/**
 * Sections of the system prompt the VS Code extension appends to its Claude panel, copied word for word from its `extension.js`, version
 * 2.1.327, so a Code Mode session writes as the panel does: file references as relative Markdown links, and text between tool calls kept
 * visible in Focus view. The panel's "User Selection Context" and "Who you are writing for" sections are left out.
 */
export const PANEL_PROMPT = `## Code References in Text
IMPORTANT: When referencing files or code locations, use markdown link syntax to make them clickable:
- For files: [filename.ts](src/filename.ts)
- For specific lines: [filename.ts:42](src/filename.ts#L42)
- For a range of lines: [filename.ts:42-51](src/filename.ts#L42-L51)
- For folders: [src/utils/](src/utils/)
Unless explicitly asked for by the user, DO NOT USE backtickets \` or HTML tags like code for file references - always use markdown [text](link) format.
The URL links should be relative paths from the root of  the user's workspace.

## Focus view in this editor
This section applies only while a section titled "Focus mode" appears earlier in this prompt; if there is none, ignore this section. That section describes the terminal's Focus view and does not apply here, and neither does guidance above that text between tool calls may not be shown to the user, or that you should close with a recap that stands on its own. In this editor's Focus view, tool calls, tool results, and thinking are collapsed into expandable summary rows, and every text message you write stays visible in order, including text between tool calls, so the user can see it. Brief updates between tool calls are fine. Do not repeat what you already said in your final message; if the tool calls since your last text message did not change what you said, a brief closing note is enough. Still end each turn with a text message, even a short one, rather than ending on a tool call. If you are running as a subagent, ignore this section. Only your final message is returned to your caller, so put everything it needs there.`;

/**
 * Switchboard's own section after the panel's: VS Code's terminal makes a relative path clickable only when it starts with "./" (mechanics
 * M83). Its own heading keeps it out of the Focus view section, which tells the session to ignore that section outside Focus view.
 */
export const LINK_PROMPT = `## Links in this terminal
Start each relative file link target with "./", as in [filename.ts:42](./src/filename.ts#L42), so VS Code's terminal makes it clickable.`;

/**
 * The panel's sections, then Switchboard's link section and the conversation rules, appended to every Code Mode start and resume, and the
 * persona's tone section last when the session has one (architecture.md § Personas).
 */
export function codeModePrompt(artifacts: string, voice = false, tone: string | null = null): string {
  return `${PANEL_PROMPT}\n\n${LINK_PROMPT}\n\n${conversationRules(artifacts, voice)}${tone === null ? '' : `\n\n${tone}`}`;
}

/**
 * `--settings` overrides user settings, so a gateway or credential there cannot apply; empty strings remove the credential variables, so the
 * session uses the subscription sign-in (mechanics M64). `viewMode: "focus"` starts the terminal in Focus view and adds the CLI's "Focus mode"
 * prompt section, which the panel's Focus view section requires. `tui: "default"` keeps the classic renderer, whose finished output scrolls into
 * the scrollback the screen copy reads, over a user setting of `fullscreen` (architecture.md § Conversation). A held session without Code Mode
 * keeps the operator's API settings, gateway and credentials included.
 */
export function codeModeSettings(codeMode = true): string {
  const view = { viewMode: 'focus', tui: 'default' };

  return JSON.stringify(codeMode ? { env: { ANTHROPIC_BASE_URL: DIRECT_API, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_CUSTOM_HEADERS: '' }, ...view } : view);
}

/**
 * An interactive `claude` with a known session ID; the prompt is one argument and runs as the first turn (mechanics M63). An empty prompt is left
 * out, so the session waits for the operator's first message (mechanics M87). `codeMode` false starts it without Code Mode, with the operator's
 * own API settings (mechanics M148).
 */
export function codeModeStartArgs(
  action: Pick<StartAction, 'permissionMode' | 'name' | 'model' | 'contract' | 'prompt' | 'cwd' | 'workItemId' | 'tone'>,
  nativeSessionId: string,
  voice = false,
  codeMode = true,
): string[] {
  return [
    '--session-id',
    nativeSessionId,
    '--permission-mode',
    action.permissionMode,
    ...(action.name === '' ? [] : ['-n', action.name]),
    ...(action.model === null ? [] : ['--model', action.model]),
    '--append-system-prompt',
    `${action.contract}\n\n${codeModePrompt(artifactsDir(action.cwd, action.workItemId), voice, action.tone ?? null)}`,
    '--settings',
    codeModeSettings(codeMode),
    ...(action.prompt === '' ? [] : [action.prompt]),
  ];
}

/**
 * A promptless resume, which reads as idle until the operator types (mechanics M68). Claude resends the start's system prompt until a
 * compaction, which renders it again from this process's flags (mechanics M30), so the resume appends `codeModePrompt`; the contract hook
 * restores the contract after a compaction. A registered session's start had no contract in its system prompt, so `held.contract` puts it
 * first, and `held.codeMode` false resumes one that ran without Code Mode (PRD R81).
 */
export function codeModeResumeArgs(
  nativeSessionId: string,
  permissionMode: PermissionMode,
  model: string | null,
  artifacts: string,
  voice = false,
  tone: string | null = null,
  held: { codeMode?: boolean; contract?: string } = {},
): string[] {
  const prompt = codeModePrompt(artifacts, voice, tone);

  return [
    '--resume',
    nativeSessionId,
    '--permission-mode',
    permissionMode,
    ...(model === null ? [] : ['--model', model]),
    '--append-system-prompt',
    held.contract === undefined ? prompt : `${held.contract}\n\n${prompt}`,
    '--settings',
    codeModeSettings(held.codeMode ?? true),
  ];
}

/** How a registered session last ran, from its transcript (mechanics M117); null fields were not recorded. */
export interface TranscriptLaunch {
  codeMode: boolean;
  permissionMode: PermissionMode | null;
  model: string | null;
}

/**
 * Reads a transcript's text from its end: Code Mode from the last `repl-mode` line, which only a Code Mode session writes, the mode of the last
 * `permission-mode` line or user line that has one, with Claude's older `default` read as `manual`, and the last assistant line's model, skipping Claude's own
 * `<synthetic>` notes (mechanics M117).
 */
export function transcriptLaunch(text: string): TranscriptLaunch {
  const lines = text.split('\n');
  let codeMode: boolean | null = null;
  let permissionMode: PermissionMode | null | undefined;
  let model: string | null | undefined;

  for (let index = lines.length - 1; index >= 0 && (codeMode === null || permissionMode === undefined || model === undefined); index--) {
    const line = lines[index]!;
    const kind =
      /^\{"type":"(repl-mode|permission-mode)"/.exec(line)?.[1] ??
      (permissionMode === undefined && line.includes('"type":"user"') && line.includes('"permissionMode"') ? 'user' : null) ??
      (model === undefined && line.includes('"type":"assistant"') ? 'assistant' : null);

    if (kind === null) {
      continue;
    }

    let entry: Record<string, unknown>;

    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (kind === 'repl-mode' && codeMode === null && typeof entry['replMode'] === 'boolean') {
      codeMode = entry['replMode'];
    } else if ((kind === 'permission-mode' || (kind === 'user' && entry['type'] === 'user')) && permissionMode === undefined && typeof entry['permissionMode'] === 'string') {
      const mode = entry['permissionMode'] === 'default' ? 'manual' : entry['permissionMode'];

      permissionMode = (PERMISSION_MODES as readonly string[]).includes(mode) ? (mode as PermissionMode) : null;
    } else if (kind === 'assistant' && entry['type'] === 'assistant') {
      const named = (entry['message'] as { model?: unknown } | undefined)?.model;

      if (typeof named === 'string' && named !== '' && named !== '<synthetic>') {
        model = named;
      }
    }
  }

  return { codeMode: codeMode ?? false, permissionMode: permissionMode ?? null, model: model ?? null };
}

/**
 * How much of a transcript's end `readTranscriptLaunch` reads. A Code Mode session writes a `repl-mode` line with each mode line, thousands in a
 * long transcript (mechanics M117), and a transcript can grow to hundreds of megabytes, which read whole would hold up the hub.
 */
export const LAUNCH_TAIL_BYTES = 8 * 1024 * 1024;

/** The start of the lines a Code Mode session writes, and of one that says it is on (mechanics M117). */
const REPL_MODE = Buffer.from('{"type":"repl-mode"');
const REPL_MODE_ON = Buffer.from('{"type":"repl-mode","replMode":true');

/** Whether a file's first `end` bytes hold `bytes`, read from the end in chunks. */
function holdsBefore(fd: number, end: number, bytes: Buffer): boolean {
  const chunk = Buffer.alloc(LAUNCH_TAIL_BYTES + bytes.length);

  for (let to = end; to > 0; ) {
    const from = Math.max(0, to - LAUNCH_TAIL_BYTES);
    // Each chunk overlaps the one after it, so a match across their boundary is found.
    const length = Math.min(to + bytes.length, end) - from;

    readSync(fd, chunk, 0, length, from);

    if (chunk.subarray(0, length).includes(bytes)) {
      return true;
    }

    to = from;
  }

  return false;
}

/** `transcriptLaunch` of the end of the transcript at `path`, with Code Mode also from any earlier line, or null when it cannot be read. */
export function readTranscriptLaunch(path: string, tailBytes = LAUNCH_TAIL_BYTES): TranscriptLaunch | null {
  let fd: number;

  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }

  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);

    readSync(fd, buffer, 0, length, size - length);

    // A line the tail cuts does not parse, and is passed over.
    const launch = transcriptLaunch(buffer.toString('utf8'));

    // A turn can write more than the tail after the last mode line: with none in the tail, the rest is searched for a Code Mode line as bytes,
    // without parsing it.
    if (!buffer.includes(REPL_MODE) && size > length) {
      // Up to the tail's start and a little into it, for a line the tail cuts.
      launch.codeMode = holdsBefore(fd, Math.min(size, size - length + REPL_MODE_ON.length), REPL_MODE_ON);
    }

    return launch;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Makes a work item's artifact folder, so the Artifacts view can watch it from the start, with a `.gitignore` that ignores everything in it, so
 * an artifact is never committed with the worktree's work. A folder that cannot be made fails nothing: the session makes it when it writes.
 */
export function makeArtifactsDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.gitignore'), '*\n', { flag: 'wx' });
  } catch {
    // Made before, or not writable.
  }
}

/** The file the pseudo-terminal runs: Windows looks for `claude.exe` when the path names no extension. */
export function claudeFile(claudePath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && !/\.[A-Za-z0-9]+$/.test(claudePath.split(/[\\/]/).pop() ?? '') ? `${claudePath}.exe` : claudePath;
}

/**
 * Terminal output as text: cursor moves forward or to a column as spacing, other escape sequences removed, and runs of whitespace, including line
 * ends, as one space, so a line wrapped at the terminal's width reads whole.
 */
export function plainText(output: string): string {
  return output
    .replace(/\u001b\[(\d*)[CG]/g, (_match, count: string) => ' '.repeat(Math.min(Number(count || '1'), 200)))
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[()][A-Za-z0-9]/g, '')
    .replace(/\u001b./g, '')
    .replace(/\s+/g, ' ');
}

/** What the start of a session's output says about Code Mode: on, off with Claude's reason, or nothing yet. */
export function codeModeEvidence(head: string): { on: true } | { off: string } | null {
  const text = plainText(head);
  const off = text.indexOf(CODE_MODE_OFF);
  const on = text.indexOf(CODE_MODE_ON);

  // The first of the two is Claude's own line under the banner; a later one may be output quoting it.
  if (off !== -1 && (on === -1 || off < on)) {
    const rest = text.slice(off);
    const end = rest.indexOf('Starting with the ordinary tools.');

    return { off: (end === -1 ? rest.slice(0, 400) : rest.slice(0, end + 'Starting with the ordinary tools.'.length)).trim() };
  }

  return on === -1 ? null : { on: true };
}

/** A dialog Claude shows before the session starts, such as folder trust or the first Code Mode confirmation (mechanics M70). */
export function showsStartPrompt(screen: string): boolean {
  return /Enter to confirm/.test(screen);
}

/** The screen's last non-empty lines, which say why a process exited. */
function lastLines(screen: string, count = 5): string {
  return screen
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-count)
    .join('\n');
}

/** The holder calls the runner makes; `HolderClient` provides them. */
export interface HolderAccess {
  spawn(request: SpawnRequest): Promise<{ session: string; pid: number }>;
  list(): Promise<SessionEntry[]>;
  kill(session: string): Promise<number | null>;
  screen(session: string): Promise<{ head: string; text: string }>;
}

/** `gone`: no holder holds the lock, so every session it held has ended (PRD R94). */
export type HolderLookup = { holder: HolderAccess } | { gone: true } | { error: string };

export interface CodeModeRunnerDeps {
  /** Read at each use, so a change to `sessions.claudePath` applies to the next start. */
  claudePath(): string;
  /** The Switchboard home, which holds the activity markers. */
  home: string;
  /** Whether hook markers are written (`sessions.installHooks`); held sessions need them (PRD R93). */
  hooks(): boolean;
  /** The running holder; with `start`, one is started when none runs. */
  holder(start: boolean): Promise<HolderLookup>;
  now(): number;
  sleep(ms: number): Promise<void>;
  newId?(): string;
  /**
   * The roster's live entries, which confirm a held process's new session ID after `/clear`, `/branch` or `/resume` (mechanics M67); without
   * it no ID change is followed.
   */
  roster?(): Promise<Array<{ sessionId: string; pid?: number }> | { error: string }>;
  /** How long one holder request may take before it counts as failed; 5 seconds by default. */
  readTimeoutMs?: number;
  /** The environment a session's is built from; the hub's by default. */
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The idle limit; `CODE_MODE_IDLE_MS` by default, shorter for tests and live acceptance. */
  idleMs?: number;
  /** The process table, which the resume guard reads; `processTable` by default. */
  processes?(): Promise<ProcessRow[] | { error: string }>;
  /** Ends a process and its descendants; `killTree` by default. */
  killTree?(pid: number): Promise<{ error: string } | null>;
  /** Whether Claude keeps a transcript of the session, which a resume needs; a session is resumed whenever this is left out (mechanics M87). */
  transcriptExists?(cwd: string, nativeSessionId: string): boolean;
  /** Makes a work item's artifact folder before its session starts; `makeArtifactsDir` by default. */
  makeArtifactsDir?(dir: string): void;
  /** Whether the conversation rules carry the spoken-reply section (`voice.enabled`), read at each start and resume; off when left out. */
  voice?(): boolean;
  /** A session's tone section as the settings have it now, read at each resume; a start takes its action's (architecture.md § Personas). */
  tone?(sessionId: string): string | null;
}

/** The members of a tree the table lists with the same pid and creation time, so a reused pid does not match. */
function matching(tree: Array<{ pid: number; created: string }>, rows: ProcessRow[]): Array<{ pid: number; created: string }> {
  return tree.filter((member) => member.created !== '' && rows.some((row) => row.pid === member.pid && row.created === member.created));
}

/** Whether a creation time is not after another; an unreadable one counts as earlier, as `treeOf` reads them. */
function notAfter(created: string, other: string): boolean {
  try {
    return created === '' || other === '' || BigInt(created) <= BigInt(other);
  } catch {
    return true;
  }
}

/**
 * The member to end first: one with no other running member above it, where a parent counts only when it was created before its child, since
 * Windows keeps a dead parent's pid as the parent of its children; else the earliest created, so a round always ends one.
 */
function topmost(running: Array<{ pid: number; created: string }>, rows: ProcessRow[]): { pid: number; created: string } | undefined {
  const pids = new Set(running.map((member) => member.pid));
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const top = running.find((member) => {
    const seen = new Set<number>();

    for (let row = byPid.get(member.pid); row !== undefined && !seen.has(row.pid); ) {
      seen.add(row.pid);

      const parent = byPid.get(row.ppid);

      if (parent === undefined || parent.pid === row.pid || !notAfter(parent.created, row.created)) {
        return true;
      }

      if (pids.has(parent.pid)) {
        return false;
      }

      row = parent;
    }

    return true;
  });

  return top ?? [...running].sort((a, b) => (a.created === b.created ? 0 : notAfter(a.created, b.created) ? -1 : 1))[0];
}

/** Waits for a holder request at most `ms`, so an unanswered one counts as failed. */
function bounded<T>(request: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([request, new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(`The terminal holder did not answer within ${ms / 1000} seconds.`)), ms)))]).finally(() => clearTimeout(timer));
}

/** Kills a session, returning what to add to a failure's message when that fails too, since Claude may still run. */
async function end(holder: HolderAccess, session: string, ms: number): Promise<string> {
  return bounded(holder.kill(session), ms).then(
    () => '',
    (error: Error) => ` Ending it failed too: ${error.message}`,
  );
}

/** The session's marker: one of its current session ID and launch. */
function ownMarker(markers: ReadonlyMap<string, Marker>, session: Pick<Session, 'nativeSessionId' | 'launchId'>): Marker | undefined {
  const marker = session.nativeSessionId === null ? undefined : markers.get(session.nativeSessionId);

  return marker !== undefined && session.launchId != null && marker.launch === session.launchId ? marker : undefined;
}

/**
 * A marker's state for a held process. A start runs its prompt; a resume, `/clear` or `/branch` waits for input (mechanics M68, M73); a
 * compaction says nothing, because a manual `/compact` ends with no Stop while an automatic one runs mid-turn (mechanics M65). A start with no
 * prompt waits for input too (mechanics M87).
 */
export function heldState(marker: Marker, promptless = false): { state: LiveState; detail: string | null } | null {
  if (marker.event !== 'SessionStart') {
    return markerState(marker);
  }

  return marker.source === 'startup' ? { state: promptless ? 'idle' : 'running', detail: null } : marker.source === 'compact' ? null : { state: 'idle', detail: null };
}

/**
 * When a held session's idle time starts (PRD R95): its start, its last input, and the time of its marker when that marker is a turn end.
 * Output counts only without such a marker, as with hooks off or after a compaction, because an idle Claude repaints its status line on its
 * own, such as for its update check, often enough that no observed idle session reached the limit (mechanics M161).
 */
export function heldIdleSince(entry: Pick<SessionEntry, 'startedAt' | 'lastInputAt' | 'lastOutputAt'>, marker: Marker | undefined, promptless = false): number {
  const state = marker === undefined ? null : heldState(marker, promptless)?.state;
  const since = Math.max(entry.startedAt, entry.lastInputAt ?? 0);

  return (state === 'idle' || state === 'failed') && marker?.at !== undefined ? Math.max(since, marker.at) : Math.max(since, entry.lastOutputAt ?? 0);
}

/** Code Mode sessions, held in the terminal holder (architecture.md § Code Mode sessions). */
export class CodeModeRunner implements SessionRunner {
  constructor(private readonly deps: CodeModeRunnerDeps) {}

  private readMs(): number {
    return this.deps.readTimeoutMs ?? 5_000;
  }

  private newId(): string {
    return this.deps.newId?.() ?? randomUUID();
  }

  private markerMap(): Map<string, Marker> {
    return this.deps.hooks() ? readMarkers(this.deps.home) : new Map();
  }

  async start(action: StartAction): Promise<StartResult> {
    if (!this.deps.hooks()) {
      return { error: HOOKS_REQUIRED };
    }

    const nativeSessionId = action.nativeSessionId ?? this.newId();
    const launchId = action.launchId ?? this.newId();
    const codeMode = action.withoutCodeMode !== true;
    const args = codeModeStartArgs(action, nativeSessionId, this.deps.voice?.() === true, codeMode);
    const spawned = await this.spawn(action.sessionId, `${action.name} ${nativeSessionId}`, args, action.cwd, launchId, artifactsDir(action.cwd, action.workItemId), codeMode);

    if ('error' in spawned) {
      return spawned;
    }

    return this.check(spawned.holder, action.sessionId, nativeSessionId, launchId, this.deps.now(), codeMode);
  }

  newLaunchId(): string {
    return this.newId();
  }

  /**
   * Resumes an ended session in the holder with a new launch; the session keeps the mode, model and permission mode it started with. A session
   * started with no prompt that ended before its first message has no transcript, which `claude --resume` refuses, so with `fresh`, its contract
   * and name, it starts again under its session ID with no prompt (mechanics M87). A registered session's `contract` goes first in the appended
   * prompt, and one that ran without Code Mode (`withoutCodeMode`) resumes without it (PRD R81).
   */
  async resumeHeld(
    session: Pick<Session, 'id' | 'nativeSessionId' | 'cwd' | 'workItemId' | 'withoutCodeMode'>,
    permissionMode: PermissionMode,
    model: string | null,
    label: string,
    launch?: string,
    fresh?: { contract: string; name: string },
    contract?: string,
  ): Promise<{ launchId: string } | { error: string }> {
    if (session.nativeSessionId === null) {
      return { error: 'The session never started, so it cannot be resumed.' };
    }

    const launchId = launch ?? this.newId();
    const artifacts = artifactsDir(session.cwd, session.workItemId);
    const again = fresh !== undefined && this.deps.transcriptExists?.(session.cwd, session.nativeSessionId) === false;
    const codeMode = session.withoutCodeMode !== true;
    const tone = this.deps.tone?.(session.id) ?? null;
    const args = again
      ? codeModeStartArgs({ permissionMode, name: fresh.name, model, contract: fresh.contract, prompt: '', cwd: session.cwd, workItemId: session.workItemId, ...(tone === null ? {} : { tone }) }, session.nativeSessionId, this.deps.voice?.() === true, codeMode)
      : codeModeResumeArgs(session.nativeSessionId, permissionMode, model, artifacts, this.deps.voice?.() === true, tone, { codeMode, ...(contract === undefined ? {} : { contract }) });
    const spawned = await this.spawn(session.id, label, args, session.cwd, launchId, artifacts, codeMode);

    return 'error' in spawned ? spawned : { launchId };
  }

  private async spawn(session: string, label: string, args: string[], cwd: string, launchId: string, artifacts: string, codeMode = true): Promise<{ holder: HolderAccess } | { error: string }> {
    const found = await this.deps.holder(true);

    if (!('holder' in found)) {
      return { error: 'error' in found ? found.error : 'The terminal holder did not start.' };
    }

    const claudePath = this.deps.claudePath();
    const file = claudeFile(claudePath, this.deps.platform);

    if (isAbsolute(file) && !existsSync(file)) {
      return { error: claudeNotFound(claudePath) };
    }

    (this.deps.makeArtifactsDir ?? makeArtifactsDir)(artifacts);

    try {
      await found.holder.spawn({ session, label, file, args, cwd, env: codeModeEnvironment(this.deps.environment ?? process.env, launchId, claudePath, artifacts, codeMode), cols: COLS, rows: ROWS });
    } catch (error) {
      return { error: (error as Error).message };
    }

    return found;
  }

  /**
   * The start check (architecture.md § Code Mode sessions): Claude's refusal line, or a marker of the launch without the `is on` line, fails
   * the start and ends the process; an exit fails it with the screen's last lines; a dialog on screen, or no marker past the start-prompt wait,
   * starts it waiting on that prompt. A session without Code Mode (`codeMode` false) has no line to look for, so its launch's first marker
   * starts it (mechanics M148).
   */
  private async check(holder: HolderAccess, sessionId: string, nativeSessionId: string, launchId: string, startedAt: number, codeMode: boolean): Promise<StartResult> {
    let markedAt: number | null = null;
    let unread: string | null = null;

    for (;;) {
      const verdict = await this.verdict(holder, sessionId, { nativeSessionId, launchId }, startedAt, markedAt, codeMode);

      if (verdict !== null && 'marked' in verdict) {
        markedAt ??= this.deps.now();
      } else if (verdict !== null && 'unread' in verdict) {
        // A holder read that failed says nothing about the session; it is tried again until the deadline.
        unread = verdict.unread;
      } else if (verdict !== null) {
        return 'error' in verdict ? verdict : { shortId: nativeSessionId.slice(0, 8), nativeSessionId, launchId, ...(verdict.startPrompt ? { startPrompt: true as const } : {}) };
      }

      if (this.deps.now() - startedAt >= CODE_MODE_START_MS) {
        const ended = await end(holder, sessionId, this.readMs());

        return { error: `The session did not start within ${CODE_MODE_START_MS / 1000} seconds${unread === null ? '.' : `: ${unread}`}${ended}` };
      }

      await this.deps.sleep(POLL_MS);
    }
  }

  /** One look at a starting session; null to look again, `marked` when a marker came before the evidence, which gets one more look. */
  private async verdict(
    holder: HolderAccess,
    sessionId: string,
    session: { nativeSessionId: string; launchId: string },
    startedAt: number,
    markedAt: number | null,
    codeMode: boolean,
  ): Promise<{ error: string } | { startPrompt: boolean } | { marked: true } | { unread: string } | null> {
    let screen: { head: string; text: string };
    let entry: SessionEntry | undefined;

    try {
      entry = (await bounded(holder.list(), this.readMs())).find((one) => one.session === sessionId);
      screen = entry === undefined ? { head: '', text: '' } : await bounded(holder.screen(sessionId), this.readMs());
    } catch (error) {
      return { unread: (error as Error).message };
    }

    const evidence = codeMode ? codeModeEvidence(screen.head) : null;

    if (evidence !== null && 'off' in evidence) {
      return { error: `${evidence.off}${await end(holder, sessionId, this.readMs())}` };
    }

    if (entry === undefined || entry.exitedAt !== null) {
      const lines = lastLines(screen.text);

      if (entry !== undefined && /execvp\(3\) failed[\s\S]*No such file or directory/.test(lines)) {
        return { error: failureOf(this.deps.claudePath(), { code: entry.exitCode, stdout: '', stderr: lines, missing: true, timedOut: false }, this.readMs(), { cwd: entry.cwd }) };
      }

      return { error: `Claude exited with code ${String(entry?.exitCode ?? null)} before the session started${lines === '' ? '.' : `: ${lines}`}` };
    }

    const marked = ownMarker(this.markerMap(), session) !== undefined;

    if (marked && (evidence !== null || !codeMode)) {
      return { startPrompt: false };
    }

    if (marked) {
      // The banner is drawn before the first hook runs; one more look covers output still on its way.
      if (markedAt !== null && this.deps.now() - markedAt >= POLL_MS) {
        return { error: `Claude started the session without Code Mode: its output has no "${CODE_MODE_ON}" line.${await end(holder, sessionId, this.readMs())}` };
      }

      return { marked: true };
    }

    return showsStartPrompt(screen.text) || this.deps.now() - startedAt >= START_PROMPT_MS ? { startPrompt: true } : null;
  }

  /**
   * Liveness from the holder's list, state from markers of the current launch; a session the holder no longer holds live has ended. A launch's
   * SessionStart with source clear, fork or resume under another session ID is the held process changing its ID (mechanics M73), reported as a
   * fork. A Code Mode session started waiting on a prompt is checked for Code Mode when its first marker arrives.
   */
  async observe(sessions: Session[]): Promise<{ sessions: ObservedSession[]; forks: ObservedFork[]; gone?: true; idle: string[]; idleSince?: Record<string, number> } | { error: string }> {
    const found = await this.deps.holder(false);

    if ('gone' in found) {
      return { sessions: [], forks: [], gone: true, idle: [] };
    }

    if ('error' in found) {
      return found;
    }

    let entries: SessionEntry[];

    try {
      entries = await found.holder.list();
    } catch (error) {
      return { error: (error as Error).message };
    }

    const markers = this.markerMap();
    const observed: ObservedSession[] = [];
    const forks: ObservedFork[] = [];
    const idle: string[] = [];
    const idleSinces: Record<string, number> = {};
    const now = this.deps.now();

    for (const session of sessions) {
      const entry = entries.find((one) => one.session === session.id);

      if (entry === undefined || entry.exitedAt !== null) {
        continue;
      }

      const tree = entry.tree === undefined ? {} : { tree: entry.tree };

      const marker = ownMarker(markers, session);
      // Read with this roster's markers, so a turn that ended during the read starts its idle time now rather than from an older state.
      const idleSince = heldIdleSince(entry, marker, session.promptless === true);

      idleSinces[session.id] = idleSince;

      if (entry.clients === 0 && now - idleSince >= (this.deps.idleMs ?? CODE_MODE_IDLE_MS)) {
        idle.push(session.id);
      }

      // The old ID's marker goes with its SessionEnd; while it stays, another ID with the launch is a nested run, such as `claude -p --resume`.
      const candidates =
        marker === undefined
          ? [...markers.values()].filter((other) => other.launch === session.launchId && session.launchId != null && other.sessionId !== session.nativeSessionId && ['clear', 'fork', 'resume'].includes(other.startSource ?? ''))
          : [];
      const moved = candidates.length === 0 ? undefined : await this.confirmed(candidates, entry);

      if (moved !== undefined) {
        forks.push({ sessionId: session.id, nativeSessionId: moved.sessionId, shortId: moved.sessionId.slice(0, 8), ...(heldState(moved, session.promptless === true) ?? { state: 'running', detail: null }) });
      }

      if (marker !== undefined && session.stateDetail === START_PROMPT && session.withoutCodeMode !== true) {
        const screen = await found.holder.screen(session.id).catch(() => null);
        const evidence = screen === null ? null : codeModeEvidence(screen.head);

        // A failed read is no evidence either way; the next observation looks again.
        if (screen === null) {
          observed.push({ sessionId: session.id, state: session.state === 'starting' || session.state === 'ended' ? 'waiting' : session.state, detail: session.stateDetail, interactive: false, ...tree });
          continue;
        }

        if (evidence === null || 'off' in evidence) {
          const ended = await end(found.holder, session.id, this.readMs());

          observed.push({ sessionId: session.id, state: 'failed', detail: `${evidence === null ? `Claude started the session without Code Mode: its output has no "${CODE_MODE_ON}" line.` : evidence.off}${ended}`, ...tree });
          continue;
        }
      }

      const state = marker === undefined ? null : heldState(marker, session.promptless === true);

      observed.push({ sessionId: session.id, ...(state ?? { state: session.state === 'starting' || session.state === 'ended' ? 'running' : session.state, detail: session.stateDetail }), interactive: false, ...tree });
    }

    return { sessions: observed, forks, idle, idleSince: idleSinces };
  }

  /**
   * The candidate the roster lists for the held process, which a nested run with the same launch is not (mechanics M67, M77). No roster, or one
   * that lists none, follows no change; the next observation asks again.
   */
  private async confirmed(candidates: Marker[], entry: SessionEntry): Promise<Marker | undefined> {
    const roster = await this.deps.roster?.().catch((error: Error) => ({ error: error.message }));

    if (roster === undefined || !Array.isArray(roster)) {
      return undefined;
    }

    const pids = new Set([entry.pid, ...(entry.tree ?? []).map((member) => member.pid)]);
    const held = new Set(roster.filter((one) => one.pid !== undefined && pids.has(one.pid)).map((one) => one.sessionId));

    return candidates.find((candidate) => held.has(candidate.sessionId));
  }

  /** The session whose held process, or a nested run of it, wrote the native session's marker under its launch, or null. */
  heldBy(nativeSessionId: string, sessions: Session[]): Session | null {
    // Read whatever the hooks setting, since a held session can change its ID before hooks are turned off.
    const launch = readMarkers(this.deps.home).get(nativeSessionId)?.launch;

    return launch == null ? null : (sessions.find((session) => session.codeMode === true && session.launchId === launch) ?? null);
  }

  markers(sessions: Session[]): Map<string, MarkerReading> {
    const readings = new Map<string, MarkerReading>();
    const markers = this.markerMap();

    for (const session of sessions) {
      const marker = ownMarker(markers, session);

      if (marker !== undefined) {
        readings.set(marker.sessionId, { at: marker.at ?? 0, cwd: marker.cwd ?? null, observed: heldState(marker, session.promptless === true), recheck: false, ...(marker.event === 'SessionStart' && marker.source === 'compact' ? { compacted: true as const } : {}) });
      }
    }

    return readings;
  }

  /** The terminals attached to the held session and its last input; none when the holder does not hold it live. */
  async heldActivity(sessionId: string): Promise<{ clients: number; lastInputAt: number | null; lastOutputAt: number | null } | { error: string }> {
    const found = await this.deps.holder(false);

    if ('gone' in found) {
      return { clients: 0, lastInputAt: null, lastOutputAt: null };
    }

    if ('error' in found) {
      return found;
    }

    try {
      const entry = (await bounded(found.holder.list(), this.readMs())).find((one) => one.session === sessionId && one.exitedAt === null);

      return { clients: entry?.clients ?? 0, lastInputAt: entry?.lastInputAt ?? null, lastOutputAt: entry?.lastOutputAt ?? null };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  /** A Code Mode session runs in Switchboard's own process while the holder holds it live. */
  async isBackground(target: SessionTarget): Promise<boolean> {
    const found = await this.deps.holder(false);

    if (!('holder' in found)) {
      return false;
    }

    try {
      return (await found.holder.list()).some((entry) => entry.session === target.sessionId && entry.exitedAt === null);
    } catch {
      return false;
    }
  }

  /** The members of a session's last process tree still running: a pid listed with the same creation time, so a reused pid does not match (PRD R95). */
  async leftovers(tree: Array<{ pid: number; created: string }>): Promise<Array<{ pid: number; created: string }> | { error: string }> {
    if (tree.length === 0) {
      return [];
    }

    const rows = await (this.deps.processes ?? processTable)();

    if (!Array.isArray(rows)) {
      return { error: `The process table could not be read: ${rows.error}` };
    }

    return matching(tree, rows);
  }

  /**
   * Ends the session's process tree in the holder; a session the holder does not hold has ended already. With `lastTree`, ends instead each process of
   * that tree that still runs.
   */
  async stop(target: SessionTarget, _reason?: StopReason): Promise<{ error: string } | null> {
    if (target.lastTree !== undefined) {
      return this.endLeftovers(target.lastTree);
    }

    const found = await this.deps.holder(false);

    if ('gone' in found) {
      return null;
    }

    if ('error' in found) {
      return found;
    }

    try {
      await found.holder.kill(target.sessionId);

      return null;
    } catch (error) {
      const message = (error as Error).message;

      return message === `No session ${target.sessionId} is held.` ? null : { error: message };
    }
  }

  private async endLeftovers(tree: Array<{ pid: number; created: string }>): Promise<{ error: string } | null> {
    const failures: Array<{ pid: number; error: string }> = [];
    const tried = new Set<number>();
    const failed = (error: string | null): { error: string } | null => {
      const ended = failures.length === 0 ? null : `${failures.length === 1 ? 'Process' : 'Processes'} ${failures.map((failure) => failure.pid).join(', ')} could not be ended: ${failures[0]!.error}`;

      return error === null && ended === null ? null : { error: [error, ended].filter((part) => part !== null).join(' ') };
    };

    // Each round reads the table and ends one member still running, with its tree, so every kill follows a read that checked its pid; a kill
    // can take long enough for another member to exit and its pid to be reused.
    for (let round = 0; round <= tree.length; round++) {
      const rows = await (this.deps.processes ?? processTable)();

      if (!Array.isArray(rows)) {
        return failed(`The process table could not be read: ${rows.error}`);
      }

      const running = matching(tree, rows).filter((member) => !tried.has(member.pid));
      const member = topmost(running, rows);

      if (member === undefined) {
        return failed(null);
      }

      tried.add(member.pid);

      const failure = await (this.deps.killTree ?? ((pid: number) => killTree(pid, this.deps.platform)))(member.pid);

      if (failure !== null) {
        failures.push({ pid: member.pid, error: failure.error });
      }
    }

    return failed(null);
  }

  /** A session a stopped hub left starting is checked once with the holder; one it no longer holds failed to start (PRD R43). */
  async reconcile(sessions: Session[]): Promise<Reconciled[]> {
    const found = await this.deps.holder(false);

    return Promise.all(
      sessions.map(async (session): Promise<Reconciled> => {
        if (!('holder' in found)) {
          return 'error' in found ? { sessionId: session.id, pending: found.error } : { sessionId: session.id, failed: 'The hub stopped while the session was starting.' };
        }

        const held = await found.holder.list().then((entries) => entries.some((one) => one.session === session.id), () => null);

        if (held === null) {
          return { sessionId: session.id, pending: 'The terminal holder did not answer.' };
        }

        if (!held || session.nativeSessionId === null || session.launchId == null) {
          return { sessionId: session.id, failed: 'The hub stopped while the session was starting.' };
        }

        // The banner came long before a restarted hub looks, so a marker without the evidence fails at once.
        const verdict = await this.verdict(found.holder, session.id, { nativeSessionId: session.nativeSessionId, launchId: session.launchId }, session.startedAt, session.startedAt - POLL_MS, session.withoutCodeMode !== true);

        if (verdict !== null && 'unread' in verdict) {
          return { sessionId: session.id, pending: verdict.unread };
        }

        if (verdict === null || 'marked' in verdict) {
          return { sessionId: session.id, pending: 'The session is still starting.' };
        }

        if ('error' in verdict) {
          return { sessionId: session.id, failed: verdict.error };
        }

        return { sessionId: session.id, started: { shortId: session.nativeSessionId.slice(0, 8), nativeSessionId: session.nativeSessionId, ...(verdict.startPrompt ? { startPrompt: true as const } : {}) } };
      }),
    );
  }

  /** The Claude runner installs the hooks both runners read. */
  installHooks(): Promise<string | null> {
    return Promise.resolve(null);
  }
}
