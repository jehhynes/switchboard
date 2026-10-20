import * as vscode from 'vscode';
import type { HubRecord } from '@switchboard/core';
import { executableDirOnPath } from '@switchboard/core';
import type { DockRow, Snapshot } from '@switchboard/hub';
import { dockView, postToHub, windowsDir, writeWorkspaceFile } from '@switchboard/hub';
import { openUrlOf, rowFor, targetForUrl } from './search.js';
import { reuseFilter } from './tabs.js';
import type { RowTarget } from './search.js';
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

/** Terminals this window opened sessions in, by `attach:` or `resume:` and session ID, so an attach left open is not shown for a resume. */
const terminals = new Map<string, vscode.Terminal>();

/** The agents a session can run in; the hub names one with each session (PRD R22). */
export type Provider = 'claude' | 'codex';

/** A provider from a hub message; an older hub names none, and its sessions are Claude's. */
export function providerOf(value: unknown): Provider {
  return value === 'codex' ? 'codex' : 'claude';
}

/**
 * Open in terminal (PRD R28): shows the terminal this window already opened the session in while it runs, else opens `claude attach <short ID>`
 * for a Claude session in its background process, or `claude --resume <session ID>` or `codex resume <thread ID>` in its directory. A session
 * `active` elsewhere, such as in a VS Code tab, opens there instead, because resuming a live session starts a copy (mechanics M18). Closing an
 * attach leaves the session running (M7, M9). `executable` is the agent's CLI from `sessions.claudePath` or `sessions.codexPath`; a hub that sends
 * none leaves the bare name to the window's PATH.
 */
export async function openTerminal(record: HubRecord | null, sessionId: string, cwd: string, name: string, shortId: string | null, active: boolean, provider: Provider = 'claude', executable: string = provider): Promise<void> {
  const key = `${shortId === null ? 'resume' : 'attach'}:${sessionId}`;
  const existing = terminals.get(key);

  if (existing !== undefined && existing.exitStatus === undefined && vscode.window.terminals.includes(existing)) {
    existing.show();
    return;
  }

  if (active) {
    await openSession(record, sessionId, cwd, provider);
    return;
  }

  const args = provider === 'codex' ? ['resume', sessionId] : shortId === null ? ['--resume', sessionId] : ['attach', shortId];
  // npm's launcher runs `node` from PATH, and nvm installs it beside the agent's CLI.
  const env = executableDirOnPath(executable);
  const terminal = vscode.window.createTerminal({ name: `Switchboard · ${name}`, shellPath: executable, shellArgs: args, cwd, ...(Object.keys(env).length > 0 ? { env } : {}) });

  terminals.set(key, terminal);
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
 * as Claude's do. A session from another folder is therefore left with the hub as a pending open, and that folder is opened in its own window,
 * which claims it.
 */
export async function openSession(record: HubRecord | null, sessionId: string, cwd: string, provider: Provider = 'claude'): Promise<'opened' | 'other-folder'> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (folder !== undefined && samePath(folder, cwd)) {
    await showSession(sessionId, provider);
    return 'opened';
  }

  if (record === null || (await postToHub(record, '/open', { sessionId, cwd }, ACTION_TIMEOUT_MS))?.status !== 200) {
    void vscode.window.showErrorMessage('Switchboard: the hub did not answer.');
  } else {
    // VS Code focuses a window that already has the folder instead of opening another.
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(cwd), { forceNewWindow: true });
  }

  return 'other-folder';
}

/** This window's `.code-workspace` file, or null for a folder window. */
export function workspaceFile(): string | null {
  return vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : null;
}

/** Opens a session another window or the dock left for this window, and runs the dock's commands for it. Runs when the window connects or gains focus. */
export async function claimOpen(record: HubRecord, run: (command: WindowCommand) => Promise<unknown> = async () => {}): Promise<string | null> {
  // A window with no folder claims only the dock's commands for any window.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  // Only the focused window takes the dock's commands for any window, so a window reconnecting in the background does not (PRD R71).
  const reply = await postToHub(record, '/claim', { folder, workspace: workspaceFile(), focused: vscode.window.state.focused }, ACTION_TIMEOUT_MS);
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

  return sessionId;
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
}

/**
 * What a row's click did: its item window came forward (`window`, or `here` when it is this window), its ticket opened, or why not. A click
 * another click replaced is `replaced`, and a second click on the row being opened is `ignored`.
 */
export type OpenResult = 'window' | 'here' | 'url' | 'nothing' | 'refused' | 'timeout' | 'failed' | 'replaced' | 'ignored';

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
export async function openRow(context: OpenContext, key: string): Promise<OpenResult> {
  // As in the dock, a click on another row replaces the one under way, and a second click on the same row is ignored.
  if (running?.key === key) {
    return 'ignored';
  }

  const mine = { key };

  running = mine;

  try {
    return await click(context, key, () => running !== mine);
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
async function click(context: OpenContext, key: string, replaced: () => boolean): Promise<OpenResult> {
  const snapshot = context.state.current();
  const row = snapshot === null ? null : rowOf(snapshot, key, context.home);

  if (row === null) {
    return 'nothing';
  }

  if (row.window === null) {
    if (row.open?.type !== 'url') {
      return 'nothing';
    }

    await openLink(row.open.url);
    return 'url';
  }

  try {
    writeWorkspaceFile(row.window);
  } catch (error) {
    void vscode.window.showErrorMessage(`Switchboard: the workspace file for ${row.window.name} could not be written: ${(error as Error).message}`);
    return 'failed';
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
    const left = context.record === null ? null : await postToHub(context.record, '/open', { sessionId: open.sessionId, cwd: open.cwd, workspace: row.window.file }, ACTION_TIMEOUT_MS);

    if (replaced()) {
      return 'replaced';
    }

    if (left?.status !== 200) {
      void vscode.window.showErrorMessage('Switchboard: the hub did not answer.');
      return 'refused';
    }
  }

  // This window is the item window: it claims at once, because it does not gain focus again.
  const here = workspaceFile();

  if (here !== null && samePath(here, row.window.file)) {
    if (context.record !== null) {
      await claimOpen(context.record, context.run);
    }

    return 'here';
  }

  // VS Code focuses the window that has the file open, or opens one; the window claims the session when it gains focus.
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(row.window.file), { forceNewWindow: true });
  return 'window';
}

/** Runs the click of the row that shows a work item, or its ticket's row when it is snoozed (PRD R49, R65). */
export async function openTarget(context: OpenContext, target: RowTarget): Promise<OpenResult> {
  const snapshot = context.state.current();
  const key = snapshot === null ? null : rowFor(snapshot, target);

  return key === null ? 'nothing' : openRow(context, key);
}

/** How long a URI that arrives before the hub's first state, such as one that started VS Code, waits for it. */
const URI_STATE_WAIT_MS = 15_000;

/**
 * Open in Switchboard (PRD R69): `vscode://switchboard.switchboard/open?url=<ticket url>` runs the click of the row of the work item or pool ticket
 * with that URL, or a link to it. Resolves to the row's key, or null.
 */
export async function openUri(context: OpenContext, uri: vscode.Uri, waitMs = URI_STATE_WAIT_MS): Promise<string | null> {
  const url = openUrlOf(uri.path, uri.query);

  if (url === null) {
    void vscode.window.showWarningMessage(`Switchboard cannot open ${uri.toString(true)}.`);
    return null;
  }

  const snapshot = await context.state.first(waitMs);

  if (snapshot === null) {
    void vscode.window.showErrorMessage('Switchboard: the hub did not answer.');
    return null;
  }

  const target = targetForUrl(snapshot, url);
  const key = target === null ? null : rowFor(snapshot, target);

  if (key === null) {
    void vscode.window.showInformationMessage(`Switchboard has no work item for ${url}`);
    return null;
  }

  void openRow(context, key);
  return key;
}
