import type { PaneModel } from '../paneModel.js';
import { morph } from './morph.js';
import { clickMessage, renderPane } from './paneRender.js';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** How often the pane reports its size, because a window resize that leaves the side bar alone fires no event in it (mechanics M61). */
export const SIZE_MS = 250;

/**
 * Wires the Switchboard pane: renders each model the extension sends and posts clicks back (PRD R92), and posts its width, which is the
 * primary side bar's, and the window's `outerWidth` when it resizes and every `SIZE_MS` (PRD R91). `innerWidth` counts a scrollbar, so the
 * width does not change when the content starts or stops scrolling.
 */
export function startPane(root: HTMLElement, vscode: VsCodeApi): void {
  const size = () => vscode.postMessage({ type: 'size', inner: window.innerWidth, outer: window.outerWidth, dpr: window.devicePixelRatio });

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(size).observe(document.documentElement);
  }

  setInterval(size, SIZE_MS);
  window.addEventListener('message', (event: MessageEvent<{ type: string; model?: PaneModel }>) => {
    if (event.data.type === 'model' && event.data.model !== undefined) {
      // In place, so a focused button keeps its focus across the model each state sends.
      morph(root, renderPane(event.data.model));
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
