import type { TicketHistory } from '@switchboard/core';
import { historyView } from './historyModel.js';
import { EMPTY_UI, renderHistory } from './historyRender.js';
import type { HistoryUi } from './historyRender.js';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Redraws this often so running sessions' times stay current. */
const TICK_MS = 30_000;

/** What the page keeps across reloads: the ticket it shows, for restoring the tab, and the operator's filters and open sections. */
interface PageState {
  ticketId: number;
  key: string;
  ui: HistoryUi;
}

type Incoming = { type: 'history'; history: TicketHistory } | { type: 'error'; message: string };

/** Wires the History page: renders each history the extension sends, keeps the operator's view settings, and posts open requests back. */
export function startHistory(root: HTMLElement, vscode: VsCodeApi, now: () => number = Date.now): void {
  const saved = vscode.getState() as Partial<PageState> | null;
  const page = (window as { switchboardHistory?: { ticketId: number; key: string } }).switchboardHistory;

  // The ticket and key restore the tab after a reload.
  if (page !== undefined) {
    vscode.setState({ ...saved, ...page });
  }

  let ui: HistoryUi = { ...EMPTY_UI, ...saved?.ui };
  let history: TicketHistory | null = null;
  let error: string | null = null;

  const save = () => vscode.setState({ ...(vscode.getState() as object | null), ui });

  const draw = () => {
    if (error !== null) {
      root.innerHTML = `<p class="error"><span class="codicon codicon-error"></span>${error.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)}</p>`;
      return;
    }

    if (history === null) {
      return;
    }

    const search = root.querySelector<HTMLInputElement>('#search');
    const focused = search !== null && document.activeElement === search ? [search.selectionStart, search.selectionEnd] : null;
    const scroll = window.scrollY;

    root.innerHTML = renderHistory(historyView(history, now()), ui);
    if (scroll > 0) {
      window.scrollTo(0, scroll);
    }

    if (focused !== null) {
      const next = root.querySelector<HTMLInputElement>('#search')!;
      next.focus();
      next.setSelectionRange(focused[0] ?? null, focused[1] ?? null);
    }
  };

  window.addEventListener('message', (event: MessageEvent<Incoming>) => {
    if (event.data.type === 'history') {
      history = event.data.history;
      error = null;
    } else if (event.data.type === 'error') {
      error = event.data.message;
    }

    draw();

    // Tells the extension which revision the page now shows.
    if (event.data.type === 'history') {
      vscode.postMessage({ type: 'shown', revision: event.data.history.revision });
    }
  });

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const open = target.closest<HTMLElement>('[data-open]');
    const chip = target.closest<HTMLElement>('[data-category]');
    const all = target.closest<HTMLElement>('[data-all]');

    if (open !== null) {
      vscode.postMessage({ type: 'open', action: JSON.parse(open.dataset['open']!) as unknown });
    } else if (chip !== null) {
      const category = chip.dataset['category'] as HistoryUi['hidden'][number];
      ui = { ...ui, hidden: ui.hidden.includes(category) ? ui.hidden.filter((entry) => entry !== category) : [...ui.hidden, category] };
      save();
      draw();
    } else if (all !== null) {
      const sections = Object.fromEntries([...root.querySelectorAll<HTMLElement>('[data-section]')].map((section) => [section.dataset['section']!, all.dataset['all'] === 'open']));
      ui = { ...ui, sections };
      save();
      draw();
    }
  });

  // A section or run toggled by the operator stays as they left it across redraws.
  root.addEventListener(
    'toggle',
    (event) => {
      const details = event.target as HTMLDetailsElement;
      const section = details.dataset['section'];
      const run = details.dataset['run'];

      if (section !== undefined && ui.sections[section] !== details.open) {
        ui = { ...ui, sections: { ...ui.sections, [section]: details.open } };
        save();
      } else if (run !== undefined && ui.runs.includes(run) !== details.open) {
        ui = { ...ui, runs: details.open ? [...ui.runs, run] : ui.runs.filter((entry) => entry !== run) };
        save();
      }
    },
    true,
  );

  root.addEventListener('input', (event) => {
    if ((event.target as HTMLElement).id === 'search') {
      ui = { ...ui, query: (event.target as HTMLInputElement).value };
      save();
      draw();
    }
  });

  setInterval(draw, TICK_MS);
  vscode.postMessage({ type: 'ready' });
}

if (typeof acquireVsCodeApi === 'function') {
  startHistory(document.getElementById('root')!, acquireVsCodeApi());
}
