import type { PaneModel } from '../paneModel.js';
import { clickMessage, renderPane } from './paneRender.js';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Wires the Switchboard pane: renders each model the extension sends and posts clicks back (PRD R92). */
export function startPane(root: HTMLElement, vscode: VsCodeApi): void {
  window.addEventListener('message', (event: MessageEvent<{ type: string; model?: PaneModel }>) => {
    if (event.data.type === 'model' && event.data.model !== undefined) {
      root.innerHTML = renderPane(event.data.model);
    }
  });
  root.addEventListener('click', (event) => {
    const message = clickMessage(event.target as Element | null);

    if (message !== null) {
      vscode.postMessage(message);
    }
  });
  vscode.postMessage({ type: 'ready' });
}

if (typeof acquireVsCodeApi === 'function') {
  startPane(document.getElementById('root')!, acquireVsCodeApi());
}
