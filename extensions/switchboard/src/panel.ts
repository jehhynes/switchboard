import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { HubRecord } from '@switchboard/core';
import type { Snapshot } from '@switchboard/hub';
import { postToHub } from '@switchboard/hub';
import { needsBadge } from './badge.js';
import { rowFor, searchEntries } from './search.js';
import type { RowTarget, SearchEntry } from './search.js';
import { snoozeChoices } from './snooze.js';

const ACTION_TIMEOUT_MS = 10_000;

/** The Switchboard view: shows the hub's state and passes the operator's clicks to the `switchboard.*` commands. */
export class WorkItemsView implements vscode.WebviewViewProvider {
  static readonly id = 'switchboard.workItems';

  private view: vscode.WebviewView | undefined;
  private latest: string | null = null;
  /** Whether the view's script has sent `ready`; a message posted before then can be lost. */
  private ready = false;
  /** The latest `select` made before the view's script was ready, sent after the state on `ready`. */
  private pendingSelect: { type: 'select'; row: string; open: boolean } | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** The latest `state` event from the hub, as its JSON text. */
  update(state: string): void {
    this.latest = state;
    this.showBadge();
    void this.view?.webview.postMessage({ type: 'state', snapshot: JSON.parse(state) });
  }

  state(): unknown {
    return this.latest === null ? null : JSON.parse(this.latest);
  }

  /** The activity bar badge, or null before VS Code resolves the view. */
  badge(): vscode.ViewBadge | undefined | null {
    return this.view === undefined ? null : this.view.badge;
  }

  /** Counts the Needs you work items on the view's badge, which VS Code shows on the activity bar icon (PRD R64). */
  private showBadge(): void {
    if (this.view !== undefined) {
      this.view.badge = this.latest === null ? undefined : needsBadge(JSON.parse(this.latest) as Snapshot);
    }
  }

  /**
   * Shows the view, then has the panel open the row's group, select, scroll to and focus the row, and run its click action
   * unless `revealOnly` (PRD R63). False when the latest state has no row for the target.
   */
  async reveal(target: RowTarget, options: { revealOnly?: boolean } = {}): Promise<boolean> {
    const snapshot = this.state() as Snapshot | null;
    const row = snapshot === null ? null : rowFor(snapshot, target);

    if (row === null) {
      return false;
    }

    await vscode.commands.executeCommand(`${WorkItemsView.id}.focus`);

    const message = { type: 'select' as const, row, open: options.revealOnly !== true };

    if (this.view !== undefined && this.ready) {
      void this.view.webview.postMessage(message);
    } else {
      this.pendingSelect = message;
    }

    return true;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;

    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const nonce = randomBytes(16).toString('hex');
    const csp = `default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; font-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';`;

    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'codicons', 'codicon.css')).toString()}">
<link rel="stylesheet" href="${view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css')).toString()}">
</head><body><div id="root"><p class="empty">Connecting to the Switchboard hub…</p></div>
<script nonce="${nonce}" src="${view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString()}"></script></body></html>`;

    view.webview.onDidReceiveMessage((message: { type: string; [key: string]: unknown }) => void this.receive(message));
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
    this.showBadge();
  }

  private async receive(message: { type: string; [key: string]: unknown }): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        if (this.latest !== null) {
          this.update(this.latest);
        }

        if (this.pendingSelect !== null) {
          void this.view?.webview.postMessage(this.pendingSelect);
          this.pendingSelect = null;
        }
        return;
      case 'action':
        await vscode.commands.executeCommand('switchboard.action', message['action']);
        return;
      case 'copy':
        await copyPaste(message['pastes'] as PasteChoice[]);
        return;
      default:
        await runOpen(message);
    }
  }
}

/** Runs a row's open or editor action (`openAction`, `editorAction`), from the panel or a toast. */
export async function runOpen(message: { type: string; [key: string]: unknown }): Promise<void> {
  switch (message.type) {
    case 'attach':
      await vscode.commands.executeCommand('switchboard.attach', message['shortId'], message['name']);
      return;
    case 'resume':
      await vscode.commands.executeCommand('switchboard.resume', message['sessionId'], message['cwd'], message['name'], message['active']);
      return;
    case 'open':
      await vscode.commands.executeCommand('switchboard.open', message['sessionId'], message['cwd']);
      return;
    case 'openFolder':
      await vscode.commands.executeCommand('switchboard.openWorktree', String(message['path']));
      return;
    case 'openUrl':
      await vscode.commands.executeCommand('switchboard.openLink', String(message['url']));
      return;
  }
}

const REVEAL_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('eye'), tooltip: 'Show in the panel' };

/**
 * Go to Work Item: a quick pick of every row the panel shows, matched on title, key, playbook, group and branch. Accepting an
 * entry reveals its row and runs its click action; the entry's eye button only reveals it (PRD R63). Resolves to the chosen
 * row's target, or null when dismissed.
 */
export function goTo(view: WorkItemsView): Promise<RowTarget | null> {
  const snapshot = view.state() as Snapshot | null;
  const pick = vscode.window.createQuickPick<SearchEntry & vscode.QuickPickItem>();

  pick.title = 'Switchboard: go to work item';
  pick.placeholder = 'Title, key, playbook, group or branch';
  pick.matchOnDescription = true;
  pick.matchOnDetail = true;
  pick.items = (snapshot === null ? [] : searchEntries(snapshot)).map((entry) => ({ ...entry, buttons: [REVEAL_BUTTON] }));

  return new Promise((done) => {
    let chosen: RowTarget | null = null;
    const choose = (target: RowTarget, revealOnly: boolean) => {
      chosen = target;
      pick.hide();
      void view.reveal(target, { revealOnly });
    };

    pick.onDidAccept(() => {
      const item = pick.selectedItems[0];

      if (item !== undefined) {
        choose(item.target, false);
      }
    });
    pick.onDidTriggerItemButton((event) => choose(event.item.target, true));
    pick.onDidHide(() => {
      pick.dispose();
      done(chosen);
    });
    pick.show();
  });
}

export interface PasteChoice {
  label: string;
  file: string;
}

const COPIED_MESSAGE_MS = 5_000;

/**
 * Puts a paste's file on the clipboard, asking which one when there are several (PRD R60). Trailing whitespace is dropped, so the
 * pasted text ends where the draft does. Returns the copied label, or null when nothing was copied.
 */
export async function copyPaste(pastes: readonly PasteChoice[]): Promise<string | null> {
  const paste =
    pastes.length === 1
      ? pastes[0]
      : (await vscode.window.showQuickPick(pastes.map((entry) => ({ label: entry.label, description: entry.file, paste: entry })), { title: 'Switchboard: copy' }))?.paste;

  if (paste === undefined) {
    return null;
  }

  let text: string;

  try {
    text = await readFile(paste.file, 'utf8');
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';

    void vscode.window.showWarningMessage(`Switchboard: ${paste.label} was not copied: ${missing ? `${paste.file} does not exist` : (error as Error).message}.`);
    return null;
  }

  await vscode.env.clipboard.writeText(text.replace(/^﻿/, '').trimEnd());
  vscode.window.setStatusBarMessage(`Copied ${paste.label}`, COPIED_MESSAGE_MS);

  return paste.label;
}

/** Opens an http(s) URL in the browser and anything else, a reported file path, in VS Code (PRD R52). */
export async function openLink(target: string): Promise<void> {
  if (/^https?:\/\//i.test(target)) {
    await vscode.env.openExternal(vscode.Uri.parse(target));
  } else {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
  }
}

/** Opens a worktree in its own window; VS Code focuses a window that already has it. */
export async function openWorktree(path: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path), { forceNewWindow: true });
}

/** Runs a panel action: a snooze without a wake time asks for one first; everything else goes to the hub. */
export async function dispatch(record: HubRecord | null, action: unknown): Promise<{ status: number; error: string | null } | null> {
  if (typeof action === 'object' && action !== null && (action as { type?: unknown }).type === 'snooze' && !('until' in action)) {
    return snooze(record, Number((action as { ticketId: unknown }).ticketId));
  }

  return act(record, action);
}

/** Asks how long to snooze the ticket, then snoozes it; null when the operator picked nothing (PRD R49). */
export async function snooze(record: HubRecord | null, ticketId: number, now: () => Date = () => new Date()): Promise<{ status: number; error: string | null } | null> {
  const choice = await vscode.window.showQuickPick(snoozeChoices(now()), { title: 'Switchboard: snooze until', placeHolder: 'Days wake at 6am; weeks on a Monday at 6am' });

  return choice === undefined ? null : act(record, { type: 'snooze', ticketId, until: choice.until });
}

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

/** A terminal attached to a background session. Closing it detaches; the session keeps running (GC M33, M45). */
export function attach(shortId: string, name: string): vscode.Terminal {
  const terminal = vscode.window.createTerminal({ name: `Switchboard · ${name}`, shellPath: 'claude', shellArgs: ['attach', shortId] });

  terminal.show();

  return terminal;
}

/** Terminals this window resumed sessions in, by session ID. */
const resumed = new Map<string, vscode.Terminal>();

/**
 * Shows a session in a terminal: the terminal this window already resumed it in, else a new `claude --resume` in its directory.
 * A session active elsewhere, such as in a VS Code tab, opens there instead, because a second resume of a live session is refused.
 */
export async function resume(record: HubRecord | null, sessionId: string, cwd: string, name: string, active: boolean): Promise<void> {
  const existing = resumed.get(sessionId);

  if (existing !== undefined && existing.exitStatus === undefined && vscode.window.terminals.includes(existing)) {
    existing.show();
    return;
  }

  if (active) {
    await openSession(record, sessionId, cwd);
    return;
  }

  const terminal = vscode.window.createTerminal({ name: `Switchboard · ${name}`, shellPath: 'claude', shellArgs: ['--resume', sessionId], cwd });

  resumed.set(sessionId, terminal);
  terminal.show();
}

function samePath(a: string, b: string): boolean {
  const normal = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

  return normal(a) === normal(b);
}

/**
 * Resumes or focuses a session in a Claude Code tab. Claude's tab lists only sessions of its window's first folder, and
 * opening another session there starts an empty one (GC M6, M7, M52). A session from another folder is therefore left with
 * the hub as a pending open, and that folder is opened in its own window, which claims it.
 */
export async function openSession(record: HubRecord | null, sessionId: string, cwd: string): Promise<'opened' | 'other-folder'> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (folder !== undefined && samePath(folder, cwd)) {
    await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);
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

/** Opens a session another window left for this window's folder. Runs when the window connects to the hub or gains focus. */
export async function claimOpen(record: HubRecord): Promise<string | null> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const reply = folder === undefined ? null : await postToHub(record, '/claim', { folder }, ACTION_TIMEOUT_MS);
  const sessionId = (reply?.body as { sessionId?: unknown } | null | undefined)?.sessionId;

  if (typeof sessionId !== 'string') {
    return null;
  }

  await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId);

  return sessionId;
}

/** Asks for a repo, when there is more than one, and a prompt, then starts an ad-hoc session (PRD R4). */
export async function startAdhoc(record: HubRecord | null, snapshot: Snapshot | null): Promise<void> {
  const repos = snapshot?.repoRoots ?? [];

  if (repos.length === 0) {
    void vscode.window.showWarningMessage('Switchboard: set a repoRoot on a source to start an ad-hoc session.');
    return;
  }

  const repoRoot = repos.length === 1 ? repos[0] : await vscode.window.showQuickPick(repos, { title: 'Switchboard: repo for the ad-hoc session' });

  if (repoRoot === undefined) {
    return;
  }

  const prompt = await vscode.window.showInputBox({ title: 'Switchboard: ad-hoc session', prompt: `Runs in ${repoRoot}`, placeHolder: 'Prompt for a new session', ignoreFocusOut: true });

  if (prompt !== undefined && prompt.trim() !== '') {
    await act(record, { type: 'adhoc', prompt, repoRoot });
  }
}

/** Turns a source on or off, such as the Support sources outside a Support week, and shows a refusal (PRD R3). Returns the hub's answer. */
export async function setSource(record: HubRecord | null, name: string, enabled: boolean): Promise<{ status: number; error: string | null } | null> {
  const reply = record === null ? null : await postToHub(record, '/sources', { name, enabled }, ACTION_TIMEOUT_MS);

  if (reply?.status !== 200) {
    void vscode.window.showWarningMessage(`Switchboard: ${reply?.error ?? 'the hub did not answer.'}`);
  }

  return reply;
}
