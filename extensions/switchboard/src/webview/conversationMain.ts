import type { ConversationState } from '../conversationModel.js';
import { EMPTY_CONVERSATION } from '../conversationModel.js';
import { renderConversation } from './conversationRender.js';
import type { ConversationMessage } from './conversationRender.js';

interface VsCodeApi {
  postMessage(message: ConversationMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** What the page keeps while hidden, since it is not retained: its open folds and whether it was scrolled to the end. */
interface PageState {
  open: string[];
  scroll: number | null;
}

/** Wires the Conversation view's page: draws each state the extension sends, keeps folds and the scroll position, and posts clicks back. */
export function startConversation(root: HTMLElement, live: HTMLElement, vscode: VsCodeApi): void {
  const saved = vscode.getState() as Partial<PageState> | null;
  const open = new Set(saved?.open ?? []);
  let state: ConversationState = EMPTY_CONVERSATION;
  let shownIds = new Set<string>();
  let restore = saved?.scroll ?? null;
  let focused: string | null = null;
  // New items arrived below the part the operator is reading, until they scroll to the end.
  let unseenBelow = false;

  const save = (): void => {
    const scroller = root.querySelector<HTMLElement>('.scroll');

    vscode.setState({ open: [...open], scroll: scroller === null || atEnd(scroller) ? null : scroller.scrollTop } satisfies PageState);
  };
  const atEnd = (scroller: HTMLElement): boolean => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;

  const draw = (): void => {
    const before = root.querySelector<HTMLElement>('.scroll');
    const wasAtEnd = before === null || atEnd(before);
    const top = before?.scrollTop ?? 0;
    const ids = new Set(state.items.map((item) => item.id));
    const added = state.items.filter((item) => !shownIds.has(item.id));

    root.innerHTML = renderConversation(state, open);

    const scroller = root.querySelector<HTMLElement>('.scroll');

    if (scroller !== null) {
      if (restore !== null) {
        scroller.scrollTop = restore;
        restore = null;
      } else if (wasAtEnd) {
        scroller.scrollTop = scroller.scrollHeight;
      } else {
        scroller.scrollTop = top;

        if (added.length > 0 && shownIds.size > 0) {
          unseenBelow = true;
        }

        if (unseenBelow) {
          const pill = document.createElement('button');

          pill.className = 'pill';
          pill.textContent = 'New messages';
          pill.addEventListener('click', () => {
            scroller.scrollTop = scroller.scrollHeight;
            unseenBelow = false;
            pill.remove();
          });
          root.appendChild(pill);
        }
      }

      scroller.addEventListener('scroll', () => {
        if (atEnd(scroller)) {
          unseenBelow = false;
          root.querySelector('.pill')?.remove();
        }

        save();
      });
    }

    // New replies are read out by a screen reader once.
    const spoken = added.filter((item) => item.type === 'reply' && item.kind === 'reply' && shownIds.size > 0);

    if (spoken.length > 0) {
      live.textContent = spoken.map((item) => (item.type === 'reply' ? item.opening : '')).join(' ');
    }

    shownIds = ids;

    if (focused !== null) {
      root.querySelector<HTMLElement>(`li[data-id="${CSS.escape(focused)}"]`)?.focus();
    }
  };

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const link = target.closest<HTMLElement>('a[data-href]');

    if (link !== null) {
      event.preventDefault();
      vscode.postMessage({ type: 'open', href: link.dataset['href'] ?? '' });
      return;
    }

    const action = target.closest<HTMLElement>('[data-action]')?.dataset['action'];

    if (action === 'terminal' || action === 'earlier') {
      vscode.postMessage({ type: action });
    }
  });

  root.addEventListener(
    'toggle',
    (event) => {
      const fold = event.target as HTMLDetailsElement;
      const id = fold.dataset['fold'];

      if (id !== undefined) {
        if (fold.open) {
          open.add(id);
        } else {
          open.delete(id);
        }

        save();
      }
    },
    true,
  );

  // The timeline is one tab stop; Up and Down move between items, Enter or Space toggles an item's first fold.
  root.addEventListener('keydown', (event) => {
    const list = root.querySelector<HTMLElement>('.timeline');
    const items = [...(list?.querySelectorAll<HTMLElement>(':scope > li[data-id]') ?? [])];
    const current = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.timeline > li[data-id]') ?? null;

    if (items.length === 0 || (document.activeElement !== list && current === null)) {
      return;
    }

    const index = current === null ? -1 : items.indexOf(current);
    const move = (to: number): void => {
      const next = items[Math.max(0, Math.min(items.length - 1, to))]!;

      focused = next.dataset['id'] ?? null;
      next.focus();
      event.preventDefault();
    };

    if (event.key === 'ArrowDown') {
      move(index + 1);
    } else if (event.key === 'ArrowUp') {
      move(index === -1 ? items.length - 1 : index - 1);
    } else if ((event.key === 'Enter' || event.key === ' ') && current !== null) {
      const fold = current.querySelector<HTMLDetailsElement>('details');

      if (fold !== null) {
        fold.open = !fold.open;
        event.preventDefault();
      }
    }
  });

  window.addEventListener('message', (event: MessageEvent<{ type: 'state'; state: ConversationState }>) => {
    if (event.data.type === 'state') {
      state = event.data.state;
      draw();
    }
  });

  draw();
  vscode.postMessage({ type: 'ready' });
}

if (typeof acquireVsCodeApi === 'function') {
  startConversation(document.getElementById('root')!, document.getElementById('live')!, acquireVsCodeApi());
}
