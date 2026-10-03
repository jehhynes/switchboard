import type { Snapshot } from '@switchboard/hub';
import { renderPanel } from './render.js';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Wires the panel: renders each state the extension sends, and posts the operator's clicks back. */
export function startPanel(root: HTMLElement, vscode: VsCodeApi, now: () => number = Date.now): void {
  let snapshot: Snapshot | null = null;
  const groups = new Map<string, boolean>();
  let menu: string | null = null;

  const draw = () => {
    if (snapshot !== null) {
      root.innerHTML = renderPanel(snapshot, now(), { groups, menu });
    }
  };

  window.addEventListener('message', (event: MessageEvent<{ type: string; snapshot?: Snapshot }>) => {
    if (event.data.type === 'state' && event.data.snapshot !== undefined) {
      snapshot = event.data.snapshot;
      draw();
    }
  });

  root.addEventListener(
    'toggle',
    (event) => {
      const target = event.target as HTMLDetailsElement;
      const group = target.dataset['group'];

      if (group !== undefined) {
        groups.set(group, target.open);
      }
    },
    true,
  );

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const more = target.closest<HTMLElement>('button.more-button');
    const control = target.closest<HTMLElement>('button.control');
    const link = target.closest<HTMLAnchorElement>('a[href]');

    if (more !== null) {
      event.preventDefault();
      menu = menu === more.dataset['menu'] ? null : more.dataset['menu']!;
      draw();
      return;
    }

    if (control?.dataset['message'] !== undefined) {
      event.preventDefault();
      vscode.postMessage(JSON.parse(control.dataset['message']));
    } else if (link !== null) {
      event.preventDefault();
      vscode.postMessage({ type: 'openUrl', url: link.getAttribute('href') });
    }

    // Removing the menu instead of redrawing keeps the clicked group heading, so its own toggle still applies.
    if (menu !== null) {
      menu = null;
      root.querySelector('.menu')?.remove();
    }
  });

  vscode.postMessage({ type: 'ready' });
}

if (typeof acquireVsCodeApi === 'function') {
  startPanel(document.getElementById('root')!, acquireVsCodeApi());
}
