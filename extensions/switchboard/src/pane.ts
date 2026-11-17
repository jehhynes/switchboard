import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { PaneModel } from './paneModel.js';
import type { PaneMessage } from './webview/paneRender.js';

/** The pane's views: one in the Explorer, one in Source Control, so it shows in either (PRD R92). */
export const PANE_VIEWS = ['switchboard.pane', 'switchboard.paneScm'] as const;

/**
 * The Switchboard pane (PRD R92): a webview view in the Explorer and in Source Control that shows this window's work items. `model` gives what
 * to show; `handle` runs a click.
 */
export class Pane implements vscode.WebviewViewProvider {
  private readonly views = new Map<string, vscode.WebviewView>();
  /** The model each view last rendered, by view ID, for the real-host tests. */
  private readonly shownModels = new Map<string, PaneModel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly model: () => PaneModel,
    private readonly handle: (message: PaneMessage) => Promise<unknown>,
  ) {}

  register(): vscode.Disposable {
    return vscode.Disposable.from(...PANE_VIEWS.map((id) => vscode.window.registerWebviewViewProvider(id, this, { webviewOptions: { retainContextWhenHidden: true } })));
  }

  /** The model changed: every view renders it. */
  changed(): void {
    for (const view of this.views.values()) {
      this.send(view);
    }
  }

  /** What each resolved view last rendered, by view ID. */
  shown(): Record<string, PaneModel> {
    return Object.fromEntries(this.shownModels);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const nonce = randomBytes(16).toString('hex');
    const csp = `default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; font-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';`;
    const uri = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(dist, file)).toString();

    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('codicons/codicon.css')}"><link rel="stylesheet" href="${uri('pane.css')}">
</head><body><div id="root"></div><script nonce="${nonce}" src="${uri('pane.js')}"></script></body></html>`;
    view.webview.onDidReceiveMessage((message: PaneMessage) => {
      if (message.type === 'ready') {
        this.send(view);
      } else {
        void this.handle(message).catch((error: unknown) => void vscode.window.showErrorMessage(`Switchboard: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    view.onDidDispose(() => {
      this.views.delete(view.viewType);
      this.shownModels.delete(view.viewType);
    });
    this.views.set(view.viewType, view);
  }

  private send(view: vscode.WebviewView): void {
    const model = this.model();

    this.shownModels.set(view.viewType, model);
    void view.webview.postMessage({ type: 'model', model });
  }
}
