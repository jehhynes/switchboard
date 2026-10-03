import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HubRecord } from '@switchboard/core';
import { postToHub } from '@switchboard/hub';

const ACTION_TIMEOUT_MS = 10_000;

/** The Switchboard view: shows the hub's state and passes the operator's clicks to the `switchboard.*` commands. */
export class WorkItemsView implements vscode.WebviewViewProvider {
  static readonly id = 'switchboard.workItems';

  private view: vscode.WebviewView | undefined;
  private latest: string | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** The latest `state` event from the hub, as its JSON text. */
  update(state: string): void {
    this.latest = state;
    void this.view?.webview.postMessage({ type: 'state', snapshot: JSON.parse(state) });
  }

  state(): unknown {
    return this.latest === null ? null : JSON.parse(this.latest);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

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
    view.onDidDispose(() => (this.view = undefined));
  }

  private async receive(message: { type: string; [key: string]: unknown }): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (this.latest !== null) {
          this.update(this.latest);
        }
        return;
      case 'action':
        await vscode.commands.executeCommand('switchboard.action', message['action']);
        return;
      case 'attach':
        await vscode.commands.executeCommand('switchboard.attach', message['shortId'], message['name']);
        return;
      case 'open':
        await vscode.commands.executeCommand('switchboard.open', message['sessionId'], message['cwd']);
        return;
      case 'openUrl':
        await vscode.commands.executeCommand('switchboard.openLink', String(message['url']));
        return;
    }
  }
}

/** Opens an http(s) URL in the browser and anything else, a reported file path, in VS Code (PRD R52). */
export async function openLink(target: string): Promise<void> {
  if (/^https?:\/\//i.test(target)) {
    await vscode.env.openExternal(vscode.Uri.parse(target));
  } else {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
  }
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
