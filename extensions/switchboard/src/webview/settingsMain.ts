import type { PlaybookFields } from '@switchboard/core';
import {
  EMPTY_PLAYBOOK,
  applyPlaybookField,
  newNameError,
  newPlaybookName,
  playbookDirty,
  playbookFile,
  playbookValue,
  readField,
  samePlaybook,
  renderEditor,
  renderNav,
  renderPage,
  setAt,
  settingsDirty,
  settingsValue,
} from './settings.js';
import type { EditorConfig, EditorState, FieldKind, PageId } from './settings.js';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Messages from the extension. */
export type EditorMessage =
  | { type: 'config'; config: EditorConfig }
  | { type: 'checked'; target: string; seq: number; errors: string[] }
  | { type: 'saved'; target: string }
  | { type: 'refused'; target: string; errors: string[] }
  | { type: 'deleted'; name: string };

const CHECK_DELAY_MS = 250;

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Wires the settings editor: renders the files the extension sends, keeps unsaved drafts, and checks them as they change. */
export function startSettings(root: HTMLElement, vscode: VsCodeApi, delay = CHECK_DELAY_MS): void {
  let state: EditorState | null = null;
  let seq = 0;
  const latest = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** `settings`, a playbook name, or `new`: what the current page checks and saves. */
  const target = (s: EditorState): string | null => (s.page === 'new-playbook' ? 'new' : s.page.startsWith('playbook:') ? s.page.slice('playbook:'.length) : s.page === 'general' || s.page.startsWith('source:') ? 'settings' : null);

  const check = (s: EditorState) => {
    const what = target(s);
    const next = ++seq;

    if (what === 'settings') {
      const value = settingsValue(s);

      if (value !== null) {
        latest.set('settings', next);
        vscode.postMessage({ type: 'check', target: 'settings', seq: next, settings: value });
      }
    } else if (what !== null) {
      const playbook = what === 'new' ? s.newPlaybook.playbook : playbookValue(s, what);
      const name = what === 'new' ? newPlaybookName(s.newPlaybook) : what;

      if (playbook !== null) {
        latest.set(what, next);
        vscode.postMessage({ type: 'check', target: what, seq: next, name, playbook });
      }
    }
  };

  // A draft keeps the version it started from, even null for a missing file, so a save never overwrites a later change.
  const draftVersion = (s: EditorState) => (s.settingsDraft === null ? s.config.settings.version : s.settingsDraft.version);

  const saveSettings = (s: EditorState) => {
    if (s.settingsDraft !== null) {
      vscode.postMessage({ type: 'save-settings', value: s.settingsDraft.value, version: s.settingsDraft.version });
    }
  };

  const savePlaybook = (s: EditorState, name: string) => {
    const draft = s.playbookDrafts.get(name);

    if (draft !== undefined) {
      // A file deleted on disk is created again.
      vscode.postMessage({ type: 'save-playbook', name, playbook: draft.playbook, version: playbookFile(s, name) === null ? null : draft.version });
    }
  };

  const checkSoon = (s: EditorState) => {
    clearTimeout(timer);
    timer = setTimeout(() => check(s), delay);
  };

  // A full redraw replaces the inputs, so focus and the caret return to the same field.
  const draw = () => {
    if (state === null) {
      return;
    }

    const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
    const id = active?.id ?? '';
    const caret = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? ([active.selectionStart, active.selectionEnd] as const) : null;

    root.innerHTML = renderEditor(state);

    const again = id === '' ? null : root.querySelector<HTMLElement>(`[id="${id}"]`);

    again?.focus();

    if (caret !== null && (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement) && again.type !== 'checkbox') {
      again.setSelectionRange(caret[0], caret[1]);
    }
  };

  // While typing, only the navigation, buttons, notes and errors are redrawn, so the inputs keep focus and the caret.
  const patch = () => {
    if (state === null) {
      return;
    }

    const nav = root.querySelector('nav');
    const main = root.querySelector('main');

    if (nav === null || main === null) {
      draw();
      return;
    }

    const fresh = document.createElement('main');

    fresh.innerHTML = renderPage(state);
    nav.outerHTML = renderNav(state);

    for (const selector of ['header .buttons', '.page-errors', '.changed']) {
      const now = main.querySelector(selector);
      const next = fresh.querySelector(selector);

      if (now !== null && next !== null) {
        now.innerHTML = next.innerHTML;
      } else if (now !== null) {
        now.remove();
      } else if (next !== null) {
        main.querySelector('header')?.after(next);
      }
    }

    for (const errors of main.querySelectorAll<HTMLElement>('[data-errors-for]')) {
      const next = fresh.querySelector<HTMLElement>(`[data-errors-for="${errors.dataset['errorsFor']}"]`);

      errors.innerHTML = next?.innerHTML ?? '';
      errors.closest('.field')?.classList.toggle('invalid', errors.innerHTML !== '');
    }
  };

  const go = (s: EditorState, page: PageId) => {
    s.page = page;
    draw();
    root.querySelector('main')?.scrollTo?.(0, 0);
    check(s);
  };

  const receive = (message: EditorMessage) => {
    if (message.type === 'config') {
      const config = message.config;

      if (state === null) {
        state = { config, page: 'general', settingsDraft: null, playbookDrafts: new Map(), newPlaybook: { namespace: '', name: '', playbook: { ...EMPTY_PLAYBOOK }, touched: false }, settingsErrors: [], playbookErrors: new Map(), refusals: new Map() };
      } else {
        state.config = config;

        // A draft that now matches its file is saved. A draft whose file was deleted or broken on disk is kept, so no edit is lost.
        if (state.settingsDraft !== null && sameJson(state.settingsDraft.value, config.settings.value)) {
          state.settingsDraft = null;
        }

        for (const [name, draft] of state.playbookDrafts) {
          const file = playbookFile(state, name);

          if (file !== null && samePlaybook(draft.playbook, file.playbook)) {
            state.playbookDrafts.delete(name);
          }
        }
      }

      draw();
      check(state);
      return;
    }

    if (state === null) {
      return;
    }

    switch (message.type) {
      case 'checked':
        if (latest.get(message.target) === message.seq) {
          if (message.target === 'settings') {
            state.settingsErrors = message.errors;
          } else {
            state.playbookErrors.set(message.target, message.errors);
          }

          patch();
        }
        return;
      case 'refused':
        state.refusals.set(message.target, message.errors);
        patch();
        return;
      case 'saved':
        state.refusals.delete(message.target);

        if (message.target === 'new') {
          const name = newPlaybookName(state.newPlaybook);

          state.newPlaybook = { namespace: '', name: '', playbook: { ...EMPTY_PLAYBOOK }, touched: false };
          state.playbookErrors.delete('new');
          go(state, `playbook:${name}`);
        }
        return;
      case 'deleted':
        state.refusals.delete(message.name);
        state.playbookDrafts.delete(message.name);
        state.playbookErrors.delete(message.name);

        if (state.page === `playbook:${message.name}`) {
          go(state, 'general');
        }
        return;
    }
  };

  window.addEventListener('message', (event: MessageEvent<EditorMessage>) => receive(event.data));

  const edit = (element: HTMLElement) => {
    if (state === null) {
      return;
    }

    const s = state;
    const input = element as HTMLInputElement;
    const what = target(s);
    const field = element.dataset['field'];
    const fresh = element.dataset['new'];

    if (fresh === 'namespace' || fresh === 'name') {
      s.newPlaybook = { ...s.newPlaybook, [fresh]: input.value };
    } else if (field === undefined || what === null) {
      return;
    } else if (what === 'settings') {
      const value = settingsValue(s);

      if (value === null) {
        return;
      }

      s.settingsDraft = { value: setAt(value, field, readField(element.dataset['kind'] as FieldKind, input, element.dataset['keepEmpty'] !== undefined)), version: draftVersion(s) };
    } else if (what === 'new') {
      s.newPlaybook = { ...s.newPlaybook, playbook: applyPlaybookField(s.newPlaybook.playbook, field, input) };
    } else {
      const file = playbookFile(s, what);
      const current = playbookValue(s, what);
      const draft = s.playbookDrafts.get(what);

      if (current === null || (draft === undefined && file === null)) {
        return;
      }

      s.playbookDrafts.set(what, { playbook: applyPlaybookField(current, field, input), version: draft?.version ?? file!.version });
    }

    s.refusals.delete(fresh === undefined ? (what ?? '') : 'new');

    // The kind decides which playbook fields show.
    if (field === 'kind') {
      draw();
    } else {
      patch();
    }

    checkSoon(s);
  };

  root.addEventListener('input', (event) => edit(event.target as HTMLElement));
  root.addEventListener('change', (event) => {
    const element = event.target as HTMLElement;

    // Text inputs already reported each keystroke.
    if (element.matches('select, input[type="checkbox"]')) {
      edit(element);
    }
  });

  root.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-command]');

    if (button === null || state === null) {
      return;
    }

    const s = state;
    const arg = button.dataset['arg'] ?? '';
    const what = target(s);

    // A save, create or delete answers with its own result; a check still pending must not replace a refusal.
    if (['save', 'save-all', 'create', 'delete'].includes(button.dataset['command'] ?? '')) {
      clearTimeout(timer);
    }

    switch (button.dataset['command']) {
      case 'navigate':
        go(s, arg as PageId);
        return;
      case 'add-source': {
        const value = settingsValue(s);

        if (value !== null) {
          s.settingsDraft = { value: setAt(value, `sources.${arg}`, { enabled: false }), version: draftVersion(s) };
          go(s, `source:${arg}`);
        }
        return;
      }
      case 'remove-source': {
        const value = settingsValue(s);

        if (value !== null) {
          s.settingsDraft = { value: setAt(value, `sources.${arg}`, undefined), version: draftVersion(s) };
          go(s, 'general');
        }
        return;
      }
      case 'revert':
        s.refusals.delete(what ?? '');

        if (what === 'settings') {
          s.settingsDraft = null;
        } else if (what !== null) {
          s.playbookDrafts.delete(what);
        }

        draw();
        check(s);
        return;
      case 'save':
        if (what === 'settings') {
          saveSettings(s);
        } else if (what !== null && what !== 'new') {
          savePlaybook(s, what);
        }
        return;
      case 'save-all':
        if (settingsDirty(s)) {
          saveSettings(s);
        }

        for (const name of [...s.playbookDrafts.keys()].filter((name) => playbookDirty(s, name))) {
          savePlaybook(s, name);
        }
        return;
      case 'create': {
        const error = newNameError(s);

        if (error !== null) {
          s.newPlaybook = { ...s.newPlaybook, touched: true };
          patch();
        } else {
          vscode.postMessage({ type: 'create-playbook', name: newPlaybookName(s.newPlaybook), playbook: s.newPlaybook.playbook satisfies PlaybookFields });
        }
        return;
      }
      case 'delete': {
        const file = what === null ? null : playbookFile(s, what);

        if (file !== null) {
          vscode.postMessage({ type: 'delete-playbook', name: file.name, version: file.version });
        }
        return;
      }
      case 'open-file':
        vscode.postMessage({ type: 'open-file', path: arg });
        return;
    }
  });

  vscode.postMessage({ type: 'ready' });
}

if (typeof acquireVsCodeApi === 'function') {
  startSettings(document.getElementById('root')!, acquireVsCodeApi());
}
