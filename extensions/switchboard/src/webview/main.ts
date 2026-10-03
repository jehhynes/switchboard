import type { Snapshot } from '@switchboard/hub';
import { renderPanel } from './render.js';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Wires the panel: renders each state the extension sends, and posts the operator's clicks back. */
export function startPanel(root: HTMLElement, vscode: VsCodeApi, now: () => number = Date.now): void {
  let snapshot: Snapshot | null = null;
  const expanded = new Set<number>();
  const groups = new Map<string, boolean>();
  let menu: string | null = null;

  const draw = () => {
    if (snapshot !== null) {
      root.innerHTML = renderPanel(snapshot, now(), { expanded, groups, menu });
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
      const id = Number(target.dataset['item']);

      if (group !== undefined) {
        groups.set(group, target.open);
      } else if (id > 0) {
        if (target.open) {
          expanded.add(id);
        } else {
          expanded.delete(id);
        }
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

    if (control !== null) {
      event.preventDefault();
      vscode.postMessage(JSON.parse(control.dataset['message']!));
    } else if (link !== null) {
      event.preventDefault();
      vscode.postMessage({ type: 'openUrl', url: link.getAttribute('href') });
    } else if (target.closest('.menu') !== null) {
      // A click inside the menu, such as on its playbook list, keeps it open.
      event.preventDefault();
      return;
    }

    // Removing the menu instead of redrawing keeps the clicked row or group heading, so its own toggle still applies.
    if (menu !== null) {
      menu = null;
      root.querySelector('.menu')?.remove();
    }
  });

  root.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement;

    if (select.classList.contains('playbook') && select.value !== '') {
      vscode.postMessage({ type: 'action', action: { type: 'change-playbook', workItemId: Number(select.dataset['item']), playbook: select.value } });
      menu = null;
      draw();
    }
  });

  vscode.postMessage({ type: 'ready' });
}

if (typeof acquireVsCodeApi === 'function') {
  startPanel(document.getElementById('root')!, acquireVsCodeApi());
}
