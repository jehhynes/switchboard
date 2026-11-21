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
 * width does not change when the content starts or stops scrolling. Answers a function that stops its timer, observer and listeners.
 */
export function startPane(root: HTMLElement, vscode: VsCodeApi): () => void {
  const size = () => vscode.postMessage({ type: 'size', inner: window.innerWidth, outer: window.outerWidth, dpr: window.devicePixelRatio });

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(size) : null;
  const timer = setInterval(size, SIZE_MS);
  const received = (event: MessageEvent<{ type: string; model?: PaneModel }>): void => {
    if (event.data.type === 'model' && event.data.model !== undefined) {
      // In place, so a focused button keeps its focus across the model each state sends.
      morph(root, renderPane(event.data.model));
    }
  };
  const clicked = (event: Event): void => {
    const message = clickMessage(event.target as Element | null);

    if (message !== null) {
      vscode.postMessage(message);
    }
  };

  observer?.observe(document.documentElement);
  window.addEventListener('message', received);
  root.addEventListener('click', clicked);
  vscode.postMessage({ type: 'ready' });

  return () => {
    clearInterval(timer);
    observer?.disconnect();
    window.removeEventListener('message', received);
    root.removeEventListener('click', clicked);
  };
}

if (typeof acquireVsCodeApi === 'function') {
  startPane(document.getElementById('root')!, acquireVsCodeApi());
}
