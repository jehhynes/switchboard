import type { Snapshot } from '@switchboard/hub';
import { renderPanel } from './render.js';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const CLIPPED = '.title, .playbook-name, .key, .stage, .approval, .note';
const FOCUSABLE = 'button, a[href]';

/** A button by its tooltip, which names its verb, or a link by its target. */
function controlKey(element: HTMLElement): string {
  return element.matches('a') ? `a ${element.getAttribute('href')}` : `button ${element.title}`;
}

/** Wires the panel: renders each state the extension sends, and posts the operator's clicks back. */
export function startPanel(root: HTMLElement, vscode: VsCodeApi, now: () => number = Date.now): void {
  let snapshot: Snapshot | null = null;
  const groups = new Map<string, boolean>();
  let selected: string | null = null;

  // A redraw replaces the rows, so the focused row, or the same button or link in it, gets focus back; a control that is gone leaves focus on its row.
  const draw = () => {
    if (snapshot !== null) {
      const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
      const row = active?.closest<HTMLElement>('[data-row]')?.dataset['row'];
      const control = active?.matches(FOCUSABLE) ? controlKey(active) : null;

      root.innerHTML = renderPanel(snapshot, now(), { groups, selected });
      if (row !== undefined) {
        const next = root.querySelector<HTMLElement>(`[data-row="${row}"]`);
        const same = control === null ? undefined : [...(next?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find((element) => controlKey(element) === control);

        (same ?? next)?.focus();
      }
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

  // Clipped text shows in full in a tooltip; text that fits has none, because it would repeat what is shown. A span cut at its cap already carries the whole text.
  root.addEventListener('mouseover', (event) => {
    const text = (event.target as HTMLElement).closest<HTMLElement>(CLIPPED);

    if (text !== null && !text.hasAttribute('data-full')) {
      if (text.scrollWidth > text.clientWidth) {
        text.title = text.textContent ?? '';
      } else {
        text.removeAttribute('title');
      }
    }
  });

  // A click, a right-click or keyboard focus selects the row, so focus and selection look the same.
  const select = (target: HTMLElement) => {
    const row = target.closest<HTMLElement>('[data-row]');

    if (row !== null && row.dataset['row'] !== selected) {
      selected = row.dataset['row']!;
      root.querySelector('.item.selected')?.classList.remove('selected');
      row.classList.add('selected');
    }
  };

  // A click elsewhere in a row, or Enter on it, runs the row's open action; with Ctrl (Cmd on macOS), its editor action when it has one.
  const open = (target: HTMLElement, editor: boolean) => {
    const row = target.closest<HTMLElement>('[data-row]');
    const action = (editor ? row?.dataset['openEditor'] : undefined) ?? row?.dataset['open'];

    if (action !== undefined) {
      vscode.postMessage(JSON.parse(action));
    }
  };

  root.addEventListener('focusin', (event) => select(event.target as HTMLElement));
  root.addEventListener('contextmenu', (event) => select(event.target as HTMLElement));

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const control = target.closest<HTMLElement>('button.control');
    const link = target.closest<HTMLAnchorElement>('a[href]');

    select(target);

    if (control?.dataset['message'] !== undefined) {
      event.preventDefault();
      vscode.postMessage(JSON.parse(control.dataset['message']));
    } else if (link !== null) {
      // VS Code's webview host also opens every clicked anchor (mechanics M16); stopping the event here keeps it to one open.
      event.preventDefault();
      event.stopPropagation();
      vscode.postMessage({ type: 'openUrl', url: link.getAttribute('href') });
    } else if (target.closest('button') === null) {
      open(target, event.ctrlKey || event.metaKey);
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.target as HTMLElement).matches('[data-row]')) {
      event.preventDefault();
      open(event.target as HTMLElement, event.ctrlKey || event.metaKey);
    }
  });

  vscode.postMessage({ type: 'ready' });
}

if (typeof acquireVsCodeApi === 'function') {
  startPanel(document.getElementById('root')!, acquireVsCodeApi());
}
