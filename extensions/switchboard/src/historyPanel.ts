import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HubRecord } from '@switchboard/core';
import { postToHub } from '@switchboard/hub';

const TIMEOUT_MS = 10_000;
/** Stream states arrive on every change; an open History reads the hub at most this often. */
const REFRESH_MS = 1_000;

/** A row's History message: the ticket, and its key, such as `gh 18941`, for the tab title. */
export interface HistoryMessage {
  ticketId: number;
  key: string;
}

type Incoming = { type: 'ready' } | { type: 'shown'; revision: string } | { type: 'open'; action: { type: string; [key: string]: unknown } };

interface Tab {
  ticketId: number;
  key: string;
  panel: vscode.WebviewPanel;
  /** The revision last sent to the page; null until a read succeeds. */
  revision: string | null;
  /** The revision the page reported it rendered. */
  shown: string | null;
  /** A change arrived while the tab was hidden, or its last read failed. */
  stale: boolean;
  /** Why the last read failed, or null. */
  error: string | null;
  timer: NodeJS.Timeout | undefined;
}

/**
 * History tabs (PRD R59), one per ticket: a webview that shows the ticket's activity log and follows it live. A tab reads the hub when it
 * opens, when the stream reports a change while it is visible, and when it is shown again after a change; VS Code restores tabs after a reload.
 */
export class HistoryPanels implements vscode.WebviewPanelSerializer {
  static readonly viewType = 'switchboard.history';

  private readonly tabs = new Map<number, Tab>();
  /** The hub whose stream last said hello; used while the keeper has no current hub. */
  private greeted: HubRecord | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly hub: () => HubRecord | null,
    /** The window key the hub gave this window, which a History read names, since a window reads only its own tickets' History. */
    private readonly windowKey: () => string | null,
    /** Opens what an entry links: a session, a worktree, a URL or a file. */
    private readonly openLink: (action: { type: string; [key: string]: unknown }) => Promise<unknown>,
  ) {}

  register(): vscode.Disposable {
    return vscode.Disposable.from(vscode.window.registerWebviewPanelSerializer(HistoryPanels.viewType, this), { dispose: () => this.dispose() });
  }

  /** Opens the ticket's History, or shows its open tab and reads it again. */
  open(message: HistoryMessage): vscode.WebviewPanel {
    const open = this.tabs.get(message.ticketId);

    if (open !== undefined) {
      open.panel.reveal();
      void this.read(open);
      return open.panel;
    }

    const panel = vscode.window.createWebviewPanel(HistoryPanels.viewType, `${message.key} History`, vscode.ViewColumn.Active, this.options());

    this.adopt(panel, message);

    return panel;
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const saved = state as Partial<HistoryMessage> | undefined;

    if (typeof saved?.ticketId !== 'number') {
      panel.dispose();
      return;
    }

    panel.webview.options = this.options();
    this.adopt(panel, { ticketId: saved.ticketId, key: saved.key ?? panel.title.replace(/ History$/, '') });
  }

  /** The stream reported a change: visible tabs read the hub soon, hidden ones when next shown. */
  changed(): void {
    for (const tab of this.tabs.values()) {
      if (!tab.panel.visible) {
        tab.stale = true;
      } else if (tab.timer === undefined) {
        tab.timer = setTimeout(() => {
          tab.timer = undefined;
          void this.read(tab);
        }, REFRESH_MS);
      }
    }
  }

  /** Reads again every tab whose read failed, such as one restored before the window reached a hub. Runs on the stream's `hello`. */
  connected(record: HubRecord): void {
    this.greeted = record;

    for (const tab of this.tabs.values()) {
      if (tab.revision === null) {
        void this.read(tab);
      }
    }
  }

  /** What each open tab shows, for the real-host tests. */
  shown(): { ticketId: number; title: string; shown: string | null; error: string | null }[] {
    return [...this.tabs.values()].map((tab) => ({ ticketId: tab.ticketId, title: tab.panel.title, shown: tab.shown, error: tab.error }));
  }

  /** Restores a tab as VS Code does after a reload, for the real-host tests: a new panel of this view type with the page's saved state. */
  restore(state: unknown): Promise<void> {
    return this.deserializeWebviewPanel(vscode.window.createWebviewPanel(HistoryPanels.viewType, 'restored', vscode.ViewColumn.Active), state);
  }

  private dispose(): void {
    for (const tab of [...this.tabs.values()]) {
      tab.panel.dispose();
    }
  }

  private options(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')], retainContextWhenHidden: true, enableFindWidget: true };
  }

  private adopt(panel: vscode.WebviewPanel, message: HistoryMessage): void {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const nonce = randomBytes(16).toString('hex');
    const csp = `default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';`;
    const uri = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, file)).toString();
    const tab: Tab = { ...message, panel, revision: null, shown: null, stale: false, error: null, timer: undefined };

    panel.title = `${message.key} History`;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, 'media', 'switchboard-light.svg'),
      dark: vscode.Uri.joinPath(this.extensionUri, 'media', 'switchboard-dark.svg'),
    };
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('codicons/codicon.css')}"><link rel="stylesheet" href="${uri('history.css')}">
</head><body><div id="root"></div><script nonce="${nonce}">window.switchboardHistory = ${JSON.stringify(message)};</script><script nonce="${nonce}" src="${uri('history.js')}"></script></body></html>`;
    panel.webview.onDidReceiveMessage((incoming: Incoming) => {
      if (incoming.type === 'ready') {
        // The page shows nothing yet, so it gets the full history.
        tab.revision = null;
        void this.read(tab);
      } else if (incoming.type === 'shown') {
        tab.shown = incoming.revision;
      } else if (incoming.type === 'open') {
        void this.openLink(incoming.action);
      }
    });
    panel.onDidChangeViewState(() => {
      if (panel.visible && tab.stale) {
        void this.read(tab);
      }
    });
    panel.onDidDispose(() => {
      clearTimeout(tab.timer);
      this.tabs.delete(tab.ticketId);
    });

    this.tabs.set(tab.ticketId, tab);
  }

  /** Reads the ticket's history from the hub and sends it to the page, unless the page already shows that revision. */
  private async read(tab: Tab): Promise<void> {
    tab.stale = false;

    const record = this.hub() ?? this.greeted;
    const window = this.windowKey();
    const reply = record === null || window === null ? null : await postToHub(record, '/history', { window, ticketId: tab.ticketId, ...(tab.revision === null ? {} : { revision: tab.revision }) }, TIMEOUT_MS);

    if (!this.tabs.has(tab.ticketId)) {
      return;
    }

    if (reply?.status === 409 && tab.revision === null) {
      // The hub does not know the ticket, so there is nothing to show.
      void vscode.window.showWarningMessage(`Switchboard: ${reply.error ?? `Unknown ticket ${tab.ticketId}.`}`);
      tab.panel.dispose();
      return;
    }

    if (reply === null || reply.status !== 200) {
      tab.stale = true;
      tab.error = reply === null ? 'Switchboard: the hub did not answer.' : `Switchboard: ${reply.error ?? `the hub answered ${reply.status}.`}`;

      // A page already showing a history keeps it; a restored page with nothing yet says why.
      if (tab.revision === null) {
        void tab.panel.webview.postMessage({ type: 'error', message: tab.error });
      }

      return;
    }

    tab.error = null;

    const body = reply.body as { unchanged?: boolean; revision?: string };

    if (body.unchanged === true) {
      return;
    }

    tab.revision = body.revision ?? null;
    void tab.panel.webview.postMessage({ type: 'history', history: body });
  }
}
