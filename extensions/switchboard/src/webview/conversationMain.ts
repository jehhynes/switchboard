import type { ConversationState } from '../conversationModel.js';
import { EMPTY_CONVERSATION } from '../conversationModel.js';
import { renderConversation, replyText } from './conversationRender.js';
import type { ConversationMessage, SendTarget } from './conversationRender.js';

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

/** How long a copy button shows its check. */
const COPIED_MS = 2_000;
/** The tallest the composer grows before it scrolls, as Claude Code's. */
const COMPOSER_MAX_PX = 200;
/** The longest title the placeholder names before it is cut. */
const PLACEHOLDER_TITLE_CHARS = 40;

/** The work item's title for the placeholder: without leading tags such as "[Feedback]", cut at a word to fit one line. */
export function shortTitle(title: string): string {
  const bare = title.replace(/^(\s*\[[^\]]*\])+\s*/, '').trim() || title.trim();

  if (bare.length <= PLACEHOLDER_TITLE_CHARS) {
    return bare;
  }

  const cut = bare.slice(0, PLACEHOLDER_TITLE_CHARS + 1);
  const space = cut.lastIndexOf(' ');

  return (space > PLACEHOLDER_TITLE_CHARS / 2 ? cut.slice(0, space) : cut.slice(0, PLACEHOLDER_TITLE_CHARS)).trimEnd();
}

/**
 * The composer (architecture.md § Conversation view): a box that grows with its text, Enter to send and Shift+Enter for a new line. It is
 * enabled only for a session the view can talk to, keeps its text until the hub took the message, takes back the text of a message that was
 * not sent, and shows why above the box until dismissed.
 */
function startComposer(host: HTMLElement, vscode: VsCodeApi): { update(state: ConversationState): void; sent(id: number, error: string | null): void; unsent(text: string, error: string): void } {
  // As Claude Code's input: the text area over a footer, whose left side is kept for the controls later slices add. Why a message did not go
  // shows above it until dismissed.
  host.innerHTML =
    '<div class="composer-error" role="alert" hidden><span class="composer-error-text"></span>' +
    '<button class="dismiss" type="button" title="Dismiss" aria-label="Dismiss"><span class="codicon codicon-close" aria-hidden="true"></span></button></div>' +
    '<div class="composer"><textarea rows="1" aria-label="Message"></textarea><div class="composer-footer"><div class="composer-controls"></div>' +
    '<button class="send" type="button" title="Send (Enter)" aria-label="Send" disabled><span class="codicon codicon-arrow-up" aria-hidden="true"></span></button></div></div>';

  const input = host.querySelector('textarea')!;
  const send = host.querySelector<HTMLButtonElement>('button.send')!;
  const error = host.querySelector<HTMLElement>('.composer-error')!;
  const errorText = host.querySelector<HTMLElement>('.composer-error-text')!;
  // Messages that were not sent while another was being sent, put back once the box is writable.
  const returned: Array<{ text: string; error: string }> = [];
  const showError = (text: string | null): void => {
    errorText.textContent = text ?? '';
    error.hidden = text === null;
  };
  const putBack = (): void => {
    for (const one of returned.splice(0)) {
      // Below a draft, after a blank line.
      input.value = input.value.trim() === '' ? one.text : `${input.value.replace(/\n+$/, '')}\n\n${one.text}`;
      showError(one.error);
    }

    grow();
    refresh();
  };
  let enabled = false;
  let target: SendTarget | null = null;
  let sending: number | null = null;
  let next = 1;
  const grow = (): void => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_PX)}px`;
  };
  const canSend = (): boolean => enabled && target !== null && sending === null && input.value.trim() !== '';
  const refresh = (): void => {
    send.disabled = !canSend();
  };
  const submit = (): void => {
    if (!canSend()) {
      return;
    }

    sending = next++;
    input.readOnly = true;
    host.classList.add('sending');
    refresh();
    vscode.postMessage({ type: 'send', id: sending, text: input.value, target: target! });
  };

  input.addEventListener('input', () => {
    grow();
    refresh();
  });
  error.querySelector('button.dismiss')!.addEventListener('click', () => {
    showError(null);
    input.focus();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
      return;
    }

    event.preventDefault();
    submit();
  });
  send.addEventListener('click', () => {
    submit();
    input.focus();
  });

  return {
    update: (state) => {
      enabled = state.connected && state.session?.conversation === 'full';
      target = state.scope === null || state.session === null ? null : { scopeGen: state.scope.scopeGen, sessionId: state.session.id, launch: state.session.launch };
      host.hidden = state.scope === null;
      input.disabled = !enabled;
      input.placeholder = enabled ? `Message ${shortTitle(state.scope?.title ?? '')}…` : (state.session?.reason ?? (state.connected ? 'No session has started yet.' : 'Connecting to Switchboard…'));
      refresh();
    },
    sent: (id, refusal) => {
      if (id !== sending) {
        return;
      }

      sending = null;
      input.readOnly = false;
      host.classList.remove('sending');

      if (refusal === null) {
        input.value = '';
        grow();
        showError(null);
      } else {
        showError(refusal);
      }

      putBack();
    },
    unsent: (text, why) => {
      returned.push({ text, error: why });

      if (sending === null) {
        putBack();
      }
    },
  };
}

/** Wires the Conversation view's page: draws each state the extension sends, keeps folds and the scroll position, and posts clicks back. */
export function startConversation(root: HTMLElement, live: HTMLElement, vscode: VsCodeApi, composerHost?: HTMLElement): void {
  const composer = composerHost === undefined ? null : startComposer(composerHost, vscode);
  const saved = vscode.getState() as Partial<PageState> | null;
  const open = new Set(saved?.open ?? []);
  let state: ConversationState = EMPTY_CONVERSATION;
  let shownIds = new Set<string>();
  let restore = saved?.scroll ?? null;
  let focused: string | null = null;
  // New items arrived below the part the operator is reading, until they scroll to the end.
  let unseenBelow = false;
  // Copy buttons waiting for the extension to say it wrote the clipboard.
  const copies = new Map<number, HTMLElement>();
  let nextCopy = 1;

  const save = (): void => {
    const scroller = root.querySelector<HTMLElement>('.scroll');

    vscode.setState({ open: [...open], scroll: scroller === null || atEnd(scroller) ? null : scroller.scrollTop } satisfies PageState);
  };
  const atEnd = (scroller: HTMLElement): boolean => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;

  const draw = (): void => {
    const before = root.querySelector<HTMLElement>('.scroll');
    // A redraw puts the focus back on the item it was on only while the timeline had it, never taking it from the composer.
    const timelineFocused = root.contains(document.activeElement);
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

    if (focused !== null && timelineFocused) {
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

    const button = target.closest<HTMLElement>('[data-action]');
    const action = button?.dataset['action'];

    if (action === 'terminal' || action === 'earlier') {
      vscode.postMessage({ type: action });
    } else if (action === 'copy-code' || action === 'copy-reply') {
      // A code block's text as written, without the newline that ends every block; a reply's Markdown from the state, not from the page.
      const id = button!.closest<HTMLElement>('li[data-id]')?.dataset['id'];
      const reply = state.items.find((item) => item.id === id && item.type === 'reply');
      const text = action === 'copy-code' ? (button!.parentElement?.querySelector('pre')?.textContent ?? '').replace(/\n$/, '') : reply?.type === 'reply' ? replyText(reply) : null;

      if (text !== null) {
        const copy = nextCopy++;

        copies.set(copy, button!);
        vscode.postMessage({ type: 'copy', id: copy, text });
      }
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
    } else if ((event.key === 'Enter' || event.key === ' ') && current !== null && (event.target as HTMLElement).closest('button, a') === null) {
      const fold = current.querySelector<HTMLDetailsElement>('details');

      if (fold !== null) {
        fold.open = !fold.open;
        event.preventDefault();
      }
    }
  });

  window.addEventListener('message', (event: MessageEvent<{ type: 'state'; state: ConversationState } | { type: 'sent'; id: number; error: string | null } | { type: 'copied'; id: number; ok: boolean } | { type: 'unsent'; returned: Array<{ text: string; error: string }> }>) => {
    if (event.data.type === 'state') {
      state = event.data.state;
      draw();
      composer?.update(state);
    } else if (event.data.type === 'sent') {
      composer?.sent(event.data.id, event.data.error);
    } else if (event.data.type === 'unsent') {
      for (const one of event.data.returned) {
        composer?.unsent(one.text, one.error);
      }
    } else if (event.data.type === 'copied') {
      const button = copies.get(event.data.id);

      copies.delete(event.data.id);

      // As Claude Code's: a check in place of the copy icon for 2 seconds; a redraw in between draws the copy icon again.
      if (button !== undefined && event.data.ok) {
        const icon = button.querySelector('.codicon');
        const title = button.title;

        icon?.classList.replace('codicon-copy', 'codicon-check');
        button.title = 'Copied';
        live.textContent = 'Copied';
        setTimeout(() => {
          icon?.classList.replace('codicon-check', 'codicon-copy');
          button.title = title;
        }, COPIED_MS);
      }
    }
  });

  draw();
  composer?.update(state);
  vscode.postMessage({ type: 'ready' });
}

if (typeof acquireVsCodeApi === 'function') {
  startConversation(document.getElementById('root')!, document.getElementById('live')!, acquireVsCodeApi(), document.getElementById('composer')!);
}
