import { realpathSync } from 'node:fs';
import * as vscode from 'vscode';
import type { HubRecord } from '@switchboard/core';
import { executableDirOnPath } from '@switchboard/core';
import type { DockRow, Snapshot } from '@switchboard/hub';
import { dockView, postToHub, windowsDir, writeWorkspaceFile } from '@switchboard/hub';
import { openUrlOf } from './search.js';
import { reuseFilter } from './tabs.js';
import type { KeyState } from './terminalKeys.js';
import { TerminalKeys } from './terminalKeys.js';
import type { HubState } from './state.js';

const ACTION_TIMEOUT_MS = 10_000;

/** A command the dock left for this window, run by the extension's handler (PRD R71). */
export type WindowCommand = { type: string; [key: string]: unknown };

/** Sends an operator event to the hub and shows a refusal. Returns the hub's answer, or null when it did not answer. */
export async function act(record: HubRecord | null, action: unknown): Promise<{ status: number; error: string | null } | null> {
  const reply = record === null ? null : await postToHub(record, '/action', action, ACTION_TIMEOUT_MS);

  if (reply === null) {
    void vscode.window.showErrorMessage('Switchboard: the hub did not answer.');
  } else if (reply.status !== 200) {
    void vscode.window.showWarningMessage(`Switchboard: ${reply.error ?? `the hub answered ${reply.status}.`}`);
  }

  return reply;
}

/** Opens an http(s) URL in the browser and anything else, a reported file path, in VS Code (PRD R52). */
export async function openLink(target: string): Promise<void> {
  if (/^https?:\/\//i.test(target)) {
    await vscode.env.openExternal(vscode.Uri.parse(target));
  } else {
    await openFile(target, () => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target)));
  }
}

/**
 * Opens a reported file: Markdown, such as a report's draft, in VS Code's Markdown preview editor, and anything else with `other`. A missing
 * Markdown file fails with its path instead of opening an empty preview.
 */
async function openFile(path: string, other: () => Thenable<unknown>): Promise<void> {
  const uri = vscode.Uri.file(path);

  if (!/\.(md|markdown)$/i.test(path)) {
    await other();
    return;
  }

  await vscode.workspace.fs.stat(uri);
  // The preview editor shows the file in its own tab, which Toggle Preview turns into the text editor in place, so editing adds no second tab.
  await vscode.commands.executeCommand('vscode.openWith', uri, 'vscode.markdown.preview.editor', { preview: false });
}

/**
 * Opens an item window's tab (PRD R72): an http(s) URL in VS Code's integrated browser, reusing a tab already on it, and a file as `openLink` does,
 * any but Markdown in a pinned editor, which the next tab does not replace. The Simple Browser is not used, because it shows one page at a time.
 */
export async function openTab(target: string): Promise<void> {
  if (!/^https?:\/\//i.test(target)) {
    await openFile(target, () => vscode.window.showTextDocument(vscode.Uri.file(target), { preview: false }));
    return;
  }

  try {
    await vscode.commands.executeCommand('workbench.action.browser.open', { url: target, reuseUrlFilter: reuseFilter(target) });
  } catch (error) {
    throw new Error(`VS Code's integrated browser did not open ${target}: ${(error as Error).message}`);
  }
}

/**
 * Terminals this window opened sessions in, by `attach:` or `resume:` and the Claude or Codex session ID, so an attach left open is not shown for
 * a resume, or by `code:` and the Switchboard session ID for a Code Mode session's attach terminal.
 */
const terminals = new TerminalKeys<vscode.Terminal>(() => vscode.window.terminals);

/** Gives the terminals this window opened the workspace state that keeps them across an extension host restart. */
export function setTerminalState(state: KeyState): void {
  terminals.setState(state);
}

/** The agents a session can run in; the hub names one with each session (PRD R22). */
export type Provider = 'claude' | 'codex';

/** A provider from a hub message; an older hub names none, and its sessions are Claude's. */
export function providerOf(value: unknown): Provider {
  return value === 'codex' ? 'codex' : 'claude';
}

/**
 * A `terminal` window command (PRD R28). `executable` is the agent's CLI from `sessions.claudePath` or `sessions.codexPath`, or for a Code Mode
 * session `sessions.nodePath`, which runs `args`, `["<home>/hub.js", "attach", <Switchboard session ID>]` (PRD R95).
 */
export interface TerminalCommand {
  /** The Claude or Codex session ID, or a Code Mode session's Switchboard session ID. */
  sessionId: string;
  cwd: string;
  /** The ticket key. */
  name: string;
  shortId: string | null;
  active: boolean;
  provider: Provider;
  executable: string | null;
  args: string[] | null;
  codeMode: boolean;
}

/** The terminal command of a window command the hub sent. */
export function terminalCommandOf(command: Record<string, unknown>): TerminalCommand {
  const args = command['args'];

  return {
    sessionId: String(command['sessionId']),
    cwd: String(command['cwd']),
    name: String(command['name']),
    shortId: typeof command['shortId'] === 'string' ? command['shortId'] : null,
    active: command['active'] === true,
    provider: providerOf(command['provider']),
    executable: typeof command['executable'] === 'string' && command['executable'] !== '' ? command['executable'] : null,
    args: Array.isArray(args) && args.every((arg) => typeof arg === 'string') ? args : null,
    codeMode: command['codeMode'] === true,
  };
}

/**
 * Open in terminal (PRD R28): shows the terminal this window already opened the session in while it runs, else opens `claude attach <short ID>`
 * for a Claude session in its background process, or `claude --resume <session ID>` or `codex resume <thread ID>` in its directory. A session
 * `active` elsewhere, such as in a VS Code tab, opens there instead, because resuming a live session starts a copy (mechanics M18). Closing an
 * attach leaves the session running (M7, M9). A hub that sends no `executable` leaves the bare name to the window's PATH. A Code Mode session
 * opens in its attach terminal instead (`openAttachTerminal`).
 */
export async function openTerminal(record: HubRecord | null, command: TerminalCommand): Promise<void> {
  if (command.codeMode) {
    await openAttachTerminal(command);
    return;
  }

  const { sessionId, cwd, name, shortId, active, provider } = command;
  const key = `${shortId === null ? 'resume' : 'attach'}:${sessionId}`;

  await terminals.serial(key, async () => {
    const existing = await terminals.find(key);

    if (existing !== undefined) {
      existing.show();
      return;
    }

    // The hub handed this window the command, so a session of its folder opens here; one of another folder goes through the hub's open.
    if (active) {
      if (here(cwd)) {
        await showSession(sessionId, provider);
      } else {
        await openSession(record, sessionId, cwd, provider);
      }

      return;
    }

    const args = provider === 'codex' ? ['resume', sessionId] : shortId === null ? ['--resume', sessionId] : ['attach', shortId];

    show(key, name, command.executable ?? provider, args, cwd);
  });
}

/**
 * A Code Mode session's attach terminal (PRD R95), in every state: runs the hub's `executable` with `args` directly, with no shell, keyed by the
 * Switchboard session ID, which `/clear`, `/branch` and `/resume` leave unchanged. The attach client stays running after its session ends and
 * offers Enter to resume it, so a terminal this window opened that still runs is shown. Never the Claude view, which refuses Code Mode.
 */
function openAttachTerminal(command: TerminalCommand): Promise<void> {
  const { sessionId, executable, args } = command;

  if (executable === null || args === null) {
    throw new Error(`The hub sent no attach command for Code Mode session ${sessionId}.`);
  }

  const key = `code:${sessionId}`;

  return terminals.serial(key, async () => {
    const existing = await terminals.find(key);

    if (existing !== undefined) {
      existing.show();
      return;
    }

    show(key, command.name, executable, args, command.cwd);
  });
}

/** Opens and shows a terminal that runs `executable` with `args`, named by the ticket key, and keeps it under `key`. */
function show(key: string, name: string, executable: string, args: string[], cwd: string): void {
  // npm's launcher runs `node` from PATH, and nvm installs it beside the agent's CLI.
  const env = executableDirOnPath(executable);
  const terminal = vscode.window.createTerminal({ name: `Switchboard · ${name}`, shellPath: executable, shellArgs: args, cwd, ...(Object.keys(env).length > 0 ? { env } : {}) });

  void terminals.keep(key, terminal);
  terminal.show();
}

function samePath(a: string, b: string): boolean {
  const normal = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

  return normal(a) === normal(b);
}

/**
 * Opens a session where Claude's `claudeCode.preferredLocation` puts it. primaryEditor.open always uses a tab; editor.open with
 * `honor-preferred-location` uses the sidebar unless a tab already holds the session, and writes no preference (GC M6, M63).
 */
async function showInClaude(sessionId: string): Promise<void> {
  if (vscode.workspace.getConfiguration('claudeCode').get('preferredLocation') === 'sidebar') {
    await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId, undefined, undefined, undefined, undefined, { programmatic: 'honor-preferred-location' });
  } else {
    await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
  }
}

/** Opens the sidebar in this window; Codex does not acknowledge when its history loads (mechanics M43). */
async function showInCodex(threadId: string): Promise<void> {
  const extension = vscode.extensions.getExtension('openai.chatgpt');

  if (extension === undefined) {
    throw new Error('Install or enable the Codex extension to open this session.');
  }

  await extension.activate();
  const uri = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://openai.chatgpt/local/${threadId}`));

  await vscode.commands.executeCommand('vscode.open', uri);
}

/** Opens the session in the view of its provider. */
export function showSession(sessionId: string, provider: Provider): Promise<void> {
  return provider === 'codex' ? showInCodex(sessionId) : showInClaude(sessionId);
}

/** Starts a new Claude session in an editor tab without changing `claudeCode.preferredLocation` (PRD R75, mechanics M29). */
export async function newClaudeTab(): Promise<void> {
  try {
    await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, undefined, undefined, undefined, undefined, { programmatic: 'pin-to-panel' });
  } catch (error) {
    void vscode.window.showErrorMessage(`Switchboard: could not open a Claude tab: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resumes or focuses a session in its provider's view, from a History link (PRD R59). Claude's tab lists only sessions of its window's first folder,
 * and opening another session there starts an empty one (GC M6, M7, M52); a Codex thread opens in any window, but runs in the window of its folder
 * as Claude's do. A session from another folder is therefore left with the hub as a pending open for its own window, which the hub names and this
 * window opens, and which claims it.
 */
export async function openSession(
  record: HubRecord | null,
  sessionId: string,
  cwd: string,
  provider: Provider = 'claude',
  run: (command: WindowCommand) => Promise<unknown> = async () => {},
): Promise<'opened' | 'other-folder' | 'refused'> {
  // The hub answers the session's own window, which claims the open, even for a session of this window's folder, since another work item can share
  // it, as Support's do (architecture.md § Window scope).
  const destination = await leave(record, sessionId, cwd);

  if (destination === null || record === null) {
    return 'refused';
  }

  if (destination.here) {
    return (await claim(record, run)).answered ? 'opened' : 'refused';
  }

  await openFolder(destination.workspace);
  return 'other-folder';
}

/**
 * Opens a Code Mode session's attach terminal from a History link (PRD R59, R95). The session is left with the hub as a pending open, which the
 * hub's `/claim` turns into the attach terminal command with `sessions.nodePath`: this window claims it at once when it has the session's folder,
 * and runs it with `run`; otherwise the window of that folder claims it when it comes forward.
 */
export async function openAttach(record: HubRecord | null, sessionId: string, cwd: string, run: (command: WindowCommand) => Promise<unknown>): Promise<'opened' | 'other-folder' | 'refused'> {
  const destination = await leave(record, sessionId, cwd);

  if (destination === null || record === null) {
    return 'refused';
  }

  // The hub names the window the open waits for: this one for its own conversations, else the session's own window, an item window's workspace
  // file or a folder window's folder (architecture.md § Window scope).
  if (destination.here) {
    if (!(await claim(record, run)).answered) {
      void vscode.window.showErrorMessage('Switchboard: the hub did not answer.');
      return 'refused';
    }

    return 'opened';
  }

  await openFolder(destination.workspace);
  return 'other-folder';
}

/** Whether `cwd` is this window's first folder. */
function here(cwd: string): boolean {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  return folder !== undefined && samePath(folder, cwd);
}

/**
 * Leaves the session with the hub for its destination window, which the hub answers: its workspace file or folder, and whether it is this window;
 * null, after saying why, when the hub refused or did not answer.
 */
async function leave(record: HubRecord | null, sessionId: string, cwd: string): Promise<{ workspace: string; here: boolean } | null> {
  const reply = record === null ? null : await postToHub(record, '/open', { sessionId, cwd, ...(windowKey === null ? {} : { window: windowKey }) }, ACTION_TIMEOUT_MS);
  const body = reply?.body as { workspace?: unknown; here?: unknown } | null | undefined;
  const workspace = body?.workspace;

  if (reply?.status !== 200 || typeof workspace !== 'string') {
    void vscode.window.showErrorMessage(`Switchboard: ${reply?.error ?? 'the hub did not answer.'}`);
    return null;
  }

  // A hub older than folder windows says nothing of `here`; then only this window's own workspace file is here.
  const mine = workspaceFile();

  return { workspace, here: body?.here === true || (body?.here === undefined && mine !== null && samePath(mine, workspace)) };
}

/** Opens a folder's or a workspace file's window; VS Code focuses a window that already has it instead of opening another. */
async function openFolder(path: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path), { forceNewWindow: true });
}

/** This window's `.code-workspace` file, or null for a folder window. */
export function workspaceFile(): string | null {
  return vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : null;
}

/** This window's folder when it is a folder window, opened on one plain folder with no workspace file; null otherwise (architecture.md § Window scope). */
export function windowFolder(): string | null {
  const folders = vscode.workspace.workspaceFolders ?? [];

  return vscode.workspace.workspaceFile === undefined && folders.length === 1 && folders[0]!.uri.scheme === 'file' ? folders[0]!.uri.fsPath : null;
}

/** Whether two paths name one folder, through links and, on Windows and macOS, in any case, as the hub binds a folder window. */
function sameFolder(a: string, b: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync.native(path);
    } catch {
      return path;
    }
  };

  return process.platform === 'linux' ? real(a).replace(/(.)\/+$/, '$1') === real(b).replace(/(.)\/+$/, '$1') : samePath(real(a), real(b));
}

/** Opens a session another window or the dock left for this window, and runs the dock's commands for it. Runs when the window connects or gains focus. */
export async function claimOpen(record: HubRecord, run: (command: WindowCommand) => Promise<unknown> = async () => {}, workspace: string | null = workspaceFile()): Promise<string | null> {
  return (await claim(record, run, workspace)).sessionId;
}

/** `claimOpen`, which also says whether the hub answered the claim. */
/** The key the hub gave this window in its stream's hello, which a claim names so the hub lets this window alone read what it claimed. */
let windowKey: string | null = null;

export function setWindowKey(key: string | null): void {
  windowKey = key;
}

async function claim(record: HubRecord, run: (command: WindowCommand) => Promise<unknown>, workspace: string | null = workspaceFile()): Promise<{ answered: boolean; sessionId: string | null }> {
  // A window with no folder claims only the dock's commands for any window.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  // Only the focused window takes the dock's commands for any window, so a window reconnecting in the background does not (PRD R71).
  const reply = await postToHub(record, '/claim', { folder, workspace, focused: vscode.window.state.focused, ...(windowKey === null ? {} : { window: windowKey }) }, ACTION_TIMEOUT_MS);
  const body = reply?.body as { sessionId?: unknown; provider?: unknown; commands?: unknown } | null | undefined;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : null;
  const commands = Array.isArray(body?.commands) ? (body.commands as WindowCommand[]) : [];
  const runEach = async (list: WindowCommand[]) => {
    for (const command of list) {
      await run(command).catch((error: unknown) => void vscode.window.showErrorMessage(`Switchboard: ${String(error)}`));
    }
  };

  // The window's tabs open before the session, so a session in an editor tab ends up in front (PRD R72).
  await runEach(commands.filter((command) => command.type === 'openTabs'));

  // The hub has already handed over the commands, so a session that fails to open does not keep them from running.
  if (sessionId !== null) {
    await showSession(sessionId, providerOf(body?.provider)).then(undefined, (error: unknown) => void vscode.window.showErrorMessage(`Switchboard: ${String(error)}`));
  }

  // Commands the dock left for this window: Open Changes, History and Open report (PRD R71).
  await runEach(commands.filter((command) => command.type !== 'openTabs'));

  return { answered: reply?.status === 200, sessionId };
}

/** How long Open in Claude or Codex waits for the hub to report the stopped session ended; a stop itself times out at 15 seconds. */
const OPEN_QUESTION_WAIT_MS = 20_000;

export interface OpenContext {
  record: HubRecord | null;
  state: HubState;
  /** The folder holding `.switchboard`, where the item windows' workspace files are. */
  home: string;
  /** Runs a claimed command, for a row whose item window is this window. */
  run: (command: WindowCommand) => Promise<unknown>;
  /** How long Open in Claude or Codex waits for the session to stop. */
  waitMs?: number;
  /** The hub the window is connected to now, read after a wait. */
  current?: () => HubRecord | null;
}

/**
 * What a row's click did: its item window came forward (`window`, or `here` when it is this window), its ticket opened, the dock took it
 * (`dock`), or why not. A click another click replaced is `replaced`, and a second click on the row being opened is `ignored`.
 */
export type OpenResult = 'window' | 'here' | 'url' | 'dock' | 'nothing' | 'refused' | 'timeout' | 'failed' | 'replaced' | 'ignored';

function rowOf(snapshot: Snapshot, key: string, home: string): DockRow | null {
  return (
    dockView(snapshot, Date.now(), windowsDir(home))
      .groups.flatMap((group) => group.rows)
      .find((row) => row.key === key) ?? null
  );
}

/**
 * Runs a row's click as the dock does (PRD R71), for a notification's Open and Open in Switchboard (PRD R65, R69): Open in Claude's or Codex's
 * stop first, then the session left for the item window, which VS Code brings to the front or opens. VS Code may bring its own window forward,
 * because it holds the foreground, where Windows would refuse the dock (mechanics M26). A row with no item window opens its ticket.
 */
export async function openRow(context: OpenContext, key: string, given?: DockRow): Promise<OpenResult> {
  // As in the dock, a click on another row replaces the one under way, and a second click on the same row is ignored.
  if (running?.key === key) {
    return 'ignored';
  }

  const mine = { key };

  running = mine;

  try {
    return await click(context, key, () => running !== mine, given);
  } finally {
    if (running === mine) {
      running = null;
    }
  }
}

/** The row click under way in this window. */
let running: { key: string } | null = null;

/** Open in Claude's or Codex's stops under way by session ID, so a later click on the same question waits for the stop already sent instead of sending another. */
const stopping = new Map<string, Promise<'stopped' | 'refused' | 'timeout'>>();

/** Asks the hub to stop a waiting session, then waits for a snapshot in which it ended (PRD R70). */
async function stop(context: OpenContext, workItemId: number, sessionId: string): Promise<'stopped' | 'refused' | 'timeout'> {
  const reply = await act(context.record, { type: 'open-question', workItemId, nativeSessionId: sessionId });

  if (reply?.status !== 200) {
    return 'refused';
  }

  const ended = (next: Snapshot) => next.workItems.some((item) => item.id === workItemId && item.sessions.some((session) => session.nativeSessionId === sessionId && session.state === 'ended'));

  return (await context.state.until(ended, context.waitMs ?? OPEN_QUESTION_WAIT_MS)) === null ? 'timeout' : 'stopped';
}

/** The click itself; `replaced` says when a later click took over, so this one makes no further request or switch. */
async function click(context: OpenContext, key: string, replaced: () => boolean, given?: DockRow): Promise<OpenResult> {
  const snapshot = context.state.current();
  const row = given ?? (snapshot === null ? null : rowOf(snapshot, key, context.home));

  if (row === null) {
    return 'nothing';
  }

  // With `dock.openVSCode: review`, a row that opens a terminal or nothing is the dock's to run, since only the dock opens terminals (PRD R71).
  if (row.open?.type === 'terminal' || row.open?.type === 'select') {
    const sent = context.record === null ? null : await postToHub(context.record, '/dock/click', { rowKey: key }, ACTION_TIMEOUT_MS);

    if (sent?.status === 202) {
      return 'dock';
    }

    void vscode.window.showErrorMessage(`Switchboard: ${sent?.error ?? 'the hub did not answer.'}`);
    return 'refused';
  }

  if (row.open?.type === 'url' && snapshot?.openVSCode === 'review') {
    await openLink(row.open.url);
    return 'url';
  }

  if (row.window === null) {
    if (row.open?.type !== 'url') {
      return 'nothing';
    }

    await openLink(row.open.url);
    return 'url';
  }

  // A hosted conversation's window is its host's, whose file the host's primary work item writes, or a folder window, which has no file
  // (architecture.md § Hosted conversations).
  if (row.window.hosted !== true) {
    try {
      writeWorkspaceFile(row.window);
    } catch (error) {
      void vscode.window.showErrorMessage(`Switchboard: the workspace file for ${row.window.name} could not be written: ${(error as Error).message}`);
      return 'failed';
    }
  }

  // As the dock's click: a hosted conversation becomes its host window's selection, so the window shows it when it comes forward.
  if (context.record !== null && row.window.hosted === true) {
    await postToHub(context.record, '/dock/select', { rowKey: key }, ACTION_TIMEOUT_MS);
  }

  let open = row.open;

  if (open?.type === 'question') {
    const { workItemId, sessionId, cwd, provider } = open;
    let stopped = stopping.get(sessionId);

    if (stopped === undefined) {
      stopped = stop(context, workItemId, sessionId).finally(() => stopping.delete(sessionId));
      stopping.set(sessionId, stopped);
    }

    const result = await stopped;

    if (replaced()) {
      return 'replaced';
    }

    // Only the click still under way says the session did not stop.
    if (result === 'timeout') {
      void vscode.window.showWarningMessage(`Switchboard: the session did not stop within ${(context.waitMs ?? OPEN_QUESTION_WAIT_MS) / 1000} seconds, so it was not opened in ${provider === 'codex' ? 'Codex' : 'Claude'}.`);
    }

    if (result !== 'stopped') {
      return result;
    }

    open = { type: 'session', sessionId, cwd, provider };
  }

  if (open?.type === 'session') {
    const left = context.record === null ? null : await postToHub(context.record, '/open', { sessionId: open.sessionId, cwd: open.cwd, workspace: row.window.file ?? row.window.folder ?? null }, ACTION_TIMEOUT_MS);

    if (replaced()) {
      return 'replaced';
    }

    if (left?.status !== 200) {
      void vscode.window.showErrorMessage('Switchboard: the hub did not answer.');
      return 'refused';
    }
  }

  // A folder destination is reached only by a folder window on that folder, never by an item window that holds it (architecture.md § Dock).
  const destination = row.window.file ?? row.window.folder ?? null;
  const here = row.window.file !== null ? workspaceFile() : windowFolder();

  if (destination === null) {
    return 'nothing';
  }

  // This window is the destination: it claims at once, because it does not gain focus again.
  if (here !== null && (row.window.file !== null ? samePath(here, destination) : sameFolder(here, destination))) {
    if (context.record !== null) {
      await claimOpen(context.record, context.run);
    }

    return 'here';
  }

  // VS Code focuses the window that has the file or folder open, or opens one; the window claims the session when it gains focus.
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destination), { forceNewWindow: true });
  return 'window';
}

/**
 * Open in Switchboard (PRD R69): `vscode://switchboard.switchboard/open?url=<ticket url>` runs the click of the row of the work item or pool ticket
 * with that URL, or a link to it. This window sees only its own work item, so it asks the hub for that one row, then runs its click itself,
 * because the dock today only calls SetForegroundWindow on an open item window, which Windows refuses a process without the latest input
 * (mechanics M26). A question's stop waits for a snapshot this window cannot see, so that row's click runs in the dock. Resolves to the row's key, or null.
 */
/** How long a URI that arrives before the window's first state waits for it. */
const URI_STATE_WAIT_MS = 15_000;

export async function openUri(context: OpenContext, uri: vscode.Uri): Promise<string | null> {
  const url = openUrlOf(uri.path, uri.query);

  if (url === null) {
    void vscode.window.showWarningMessage(`Switchboard cannot open ${uri.toString(true)}.`);
    return null;
  }

  // A URI can arrive before the window connects, such as one that started VS Code: it waits for the hub's first state, then asks the hub it has.
  await context.state.first(URI_STATE_WAIT_MS);

  const record = context.current?.() ?? context.record;
  const found = record === null ? null : await postToHub(record, '/open-url', { url }, ACTION_TIMEOUT_MS);

  if (found?.status === 404) {
    void vscode.window.showInformationMessage(`Switchboard has no work item for ${url}`);
    return null;
  }

  const row = found?.status === 200 ? (found.body as { row?: DockRow }).row : undefined;

  if (row === undefined) {
    void vscode.window.showErrorMessage(`Switchboard: ${found?.error ?? 'the hub did not answer.'}`);
    return null;
  }

  if (row.open?.type === 'question') {
    const sent = await postToHub(record!, '/dock/click', { rowKey: row.key }, ACTION_TIMEOUT_MS);

    if (sent?.status !== 202) {
      void vscode.window.showErrorMessage(`Switchboard: ${sent?.error ?? 'the hub did not answer.'}`);
    }

    return row.key;
  }

  // The click runs against the hub the row came from, which may have replaced the one the context named.
  void openRow({ ...context, record }, row.key, row);
  return row.key;
}
