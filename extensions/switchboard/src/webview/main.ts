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
  let showDone = false;

  const draw = () => {
    if (snapshot === null) {
      return;
    }

    // Keep a half-typed prompt and the chosen repo across redraws.
    const form = root.querySelector<HTMLFormElement>('form.adhoc');
    const textarea = form?.querySelector('textarea');
    const prompt = textarea?.value ?? '';
    const typing = textarea !== undefined && textarea !== null && document.activeElement === textarea;
    const [start, end] = [textarea?.selectionStart ?? 0, textarea?.selectionEnd ?? 0];
    const repo = form?.querySelector('select')?.value;

    root.innerHTML = renderPanel(snapshot, now(), expanded, showDone);

    const next = root.querySelector<HTMLFormElement>('form.adhoc')!.querySelector('textarea')!;
    next.value = prompt;

    if (typing) {
      next.focus();
      next.setSelectionRange(start, end);
    }

    if (repo !== undefined && repo !== '') {
      root.querySelector<HTMLFormElement>('form.adhoc')!.querySelector('select')!.value = repo;
    }
  };

  window.addEventListener('message', (event: MessageEvent<{ type: string; snapshot?: Snapshot }>) => {
    if (event.data.type === 'state' && event.data.snapshot !== undefined) {
      snapshot = event.data.snapshot;
      draw();
    }
  });

  root.addEventListener('toggle', (event) => {
    const target = event.target as HTMLDetailsElement;
    const id = Number(target.dataset['item']);

    if (target.classList.contains('done')) {
      showDone = target.open;
    } else if (id > 0) {
      if (target.open) {
        expanded.add(id);
      } else {
        expanded.delete(id);
      }
    }
  }, true);

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const control = target.closest<HTMLElement>('button.control');
    const link = target.closest<HTMLAnchorElement>('a[href]');

    if (control !== null) {
      event.preventDefault();
      vscode.postMessage(JSON.parse(control.dataset['message']!));
    } else if (link !== null) {
      event.preventDefault();
      vscode.postMessage({ type: 'openUrl', url: link.getAttribute('href') });
    }
  });

  root.addEventListener('change', (event) => {
    const select = event.target as HTMLSelectElement;

    if (select.classList.contains('playbook') && select.value !== '') {
      vscode.postMessage({ type: 'action', action: { type: 'change-playbook', workItemId: Number(select.dataset['item']), playbook: select.value } });
    }
  });

  root.addEventListener('submit', (event) => {
    event.preventDefault();

    const form = event.target as HTMLFormElement;
    const textarea = form.querySelector('textarea')!;
    const prompt = textarea.value;

    if (prompt.trim() !== '') {
      vscode.postMessage({ type: 'action', action: { type: 'adhoc', prompt, repoRoot: form.querySelector('select')!.value } });
      textarea.value = '';
    }
  });

  vscode.postMessage({ type: 'ready' });
}

if (typeof acquireVsCodeApi === 'function') {
  startPanel(document.getElementById('root')!, acquireVsCodeApi());
}
