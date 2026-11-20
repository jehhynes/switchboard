import type { ConversationState } from '../conversationModel.js';
import { EMPTY_CONVERSATION } from '../conversationModel.js';
import { ago, renderConversation, replyText, TABS } from './conversationRender.js';
import { statusLine } from '../conversationModel.js';
import type { ConversationMessage, SendTarget, Tab } from './conversationRender.js';
import { startComposerExtras } from './composerExtras.js';
import type { ExtrasReply } from './composerExtras.js';

interface VsCodeApi {
  postMessage(message: ConversationMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * What the page keeps while hidden, since it is not retained, and over a reload: its open folds, whether it was scrolled to the end, the tab
 * shown, and the composer's draft with the slash command chosen for it.
 */
interface PageState {
  open: string[];
  scroll: number | null;
  tab?: Tab;
  draft?: string;
  command?: string | null;
}

/** How long a copy button shows its check. */
const COPIED_MS = 2_000;
/** How long an unread reply or status must be visible in a focused window before it counts as seen (architecture.md § Unread). */
export const SEEN_MS = 1_000;
/** How often the page checks again while an unread item is on its way to seen, so one hidden and shown again in between starts over. */
const SEEN_CHECK_MS = 250;
/** How long a status that replaced the one before is marked New once the Status tab shows it, unless the operator opens it first. */
export const STATUS_NEW_MS = 60_000;
/** How often the ages of the status and the artifacts are redrawn. */
const STATUS_AGE_MS = 30_000;
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
function startComposer(host: HTMLElement, vscode: VsCodeApi): { update(state: ConversationState): void; sent(id: number, error: string | null): void; unsent(text: string, error: string): void; receive(reply: ExtrasReply): void } {
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
    extras.changed();
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
    vscode.postMessage({ type: 'send', id: sending, text: input.value, target: target!, ...(extras.command(input.value) ? { command: true as const } : {}) });
  };
  const extras = startComposerExtras(host, input, host.querySelector<HTMLElement>('.composer-controls')!, vscode, () => {
    grow();
    refresh();
  }, (text) => showError(text));

  input.addEventListener('input', () => {
    grow();
    refresh();
  });
  error.querySelector('button.dismiss')!.addEventListener('click', () => {
    showError(null);
    input.focus();
  });
  input.addEventListener('keydown', (event) => {
    if (extras.keydown(event)) {
      return;
    }

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
      extras.update(state);
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
        extras.sent(true);
      } else {
        showError(refusal);
        extras.sent(false);
      }

      putBack();
    },
    unsent: (text, why) => {
      returned.push({ text, error: why });

      if (sending === null) {
        putBack();
      }
    },
    receive: (reply) => extras.receive(reply),
  };
}

/** Wires the Conversation view's page: draws each state the extension sends, keeps folds and the scroll position, and posts clicks back. */
export function startConversation(root: HTMLElement, live: HTMLElement, vscode: VsCodeApi, composerHost?: HTMLElement): void {
  const composer = composerHost === undefined ? null : startComposer(composerHost, vscode);
  const saved = vscode.getState() as Partial<PageState> | null;
  const open = new Set(saved?.open ?? []);
  let state: ConversationState = EMPTY_CONVERSATION;
  let tab: Tab = TABS.some((one) => one.tab === saved?.tab) ? saved!.tab! : 'conversation';
  // The artifacts new or changed since they were last opened in the workspace, which the extension keeps.
  let unopened = new Set<string>();
  let shownIds = new Set<string>();
  let restore = saved?.scroll ?? null;
  let focused: string | null = null;
  // New items arrived below the part the operator is reading, until they scroll to the end.
  let unseenBelow = false;
  // Copy buttons waiting for the extension to say it wrote the clipboard.
  const copies = new Map<number, HTMLElement>();
  let nextCopy = 1;
  // The status the Status tab last had, and until when a status that replaced it is marked New: Infinity until the tab shows it.
  let shownStatus: { sessionId: string | null; id: string; markdown: string } | null = null;
  // Whether this VS Code window has the focus, which the extension says; unread items count as seen only then.
  let windowFocused = false;
  // Unread items visible since when, and those already reported seen, for the session the page shows.
  const visibleSince = new Map<string, number>();
  const reported = new Set<string>();
  let reportedFor: string | null = null;
  let seenTimer: ReturnType<typeof setTimeout> | undefined;
  let wasConnected = false;
  // The timeline's size changes without a window resize when a fold opens or the composer grows.
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => checkSeen()) : null;
  /**
   * The unread items on screen, only in the tab shown: the status on the Status tab, and the replies at least half in the timeline's viewport, or
   * filling half of it. None while the window has no focus or the page is hidden.
   */
  const visibleUnread = (): string[] => {
    const scroller = root.querySelector<HTMLElement>('.scroll');

    if (!windowFocused || document.visibilityState === 'hidden') {
      return [];
    }

    const view = scroller?.getBoundingClientRect();

    return [...root.querySelectorAll<HTMLElement>('[data-unread]')]
      .filter((element) => {
        if (scroller === null || view === undefined || !scroller.contains(element)) {
          return true;
        }

        const box = element.getBoundingClientRect();
        const shown = Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top);

        return shown > 0 && shown >= Math.min(box.height, view.height) / 2;
      })
      .map((element) => element.dataset['unread']!)
      .filter((id) => !reported.has(id));
  };
  /** Reports each unread item that stayed visible for `SEEN_MS`, each once, and checks again when the next one is due. */
  const checkSeen = (): void => {
    clearTimeout(seenTimer);

    const target = state.scope === null || state.session === null ? null : { scopeGen: state.scope.scopeGen, sessionId: state.session.id };
    const key = target === null ? null : `${target.scopeGen} ${target.sessionId}`;

    if (key !== reportedFor) {
      reportedFor = key;
      reported.clear();
      visibleSince.clear();
    }

    if (target === null || !root.isConnected) {
      return;
    }

    const now = Date.now();
    const visible = new Set(visibleUnread());

    for (const id of [...visibleSince.keys()].filter((one) => !visible.has(one))) {
      visibleSince.delete(id);
    }

    for (const id of visible) {
      if (!visibleSince.has(id)) {
        visibleSince.set(id, now);
      }
    }

    const due = [...visibleSince].filter(([, since]) => now - since >= SEEN_MS).map(([id]) => id);

    if (due.length > 0) {
      for (const id of due) {
        visibleSince.delete(id);
        reported.add(id);
      }

      vscode.postMessage({ type: 'seen', ids: due, target });
    }

    // While an unread item is on the page of a focused window, a layout change can show or hide it without an event, so it is checked again.
    const waiting = windowFocused && [...root.querySelectorAll<HTMLElement>('[data-unread]')].some((element) => !reported.has(element.dataset['unread']!));

    if (visibleSince.size > 0 || waiting) {
      seenTimer = setTimeout(checkSeen, visibleSince.size === 0 ? SEEN_CHECK_MS : Math.min(SEEN_CHECK_MS, Math.max(0, SEEN_MS - (now - Math.min(...visibleSince.values())))));
    }
  };
  let freshUntil = 0;
  let freshTimer: ReturnType<typeof setTimeout> | undefined;
  const seenStatus = (): void => {
    if (freshUntil !== 0) {
      freshUntil = 0;
      clearTimeout(freshTimer);

      if (root.isConnected) {
        draw();
      }
    }
  };
  // A New status's minute starts once the Status tab shows it, so one that came while another tab was shown is still New there.
  const startFreshClock = (): void => {
    if (freshUntil !== Infinity || tab !== 'status' || document.visibilityState === 'hidden') {
      return;
    }

    freshUntil = Date.now() + STATUS_NEW_MS;
    freshTimer = setTimeout(() => {
      freshUntil = 0;

      if (root.isConnected) {
        draw();
      }
    }, STATUS_NEW_MS);
  };
  // A status that replaces the one the page had for the same session is New for a while; a first status after the stage is too.
  const noteStatus = (): void => {
    const status = state.status;
    const sessionId = state.scope?.sessionId ?? null;

    if (status !== null && !status.fallback && shownStatus !== null && shownStatus.sessionId === sessionId && (shownStatus.id !== status.id || shownStatus.markdown !== status.markdown)) {
      freshUntil = Infinity;
      clearTimeout(freshTimer);
      live.textContent = `New status: ${statusLine(status.markdown)}`;
    } else if (status === null || shownStatus?.sessionId !== sessionId) {
      freshUntil = 0;
      clearTimeout(freshTimer);
    }

    shownStatus = status === null ? null : { sessionId, id: status.id, markdown: status.markdown };
  };

  // The ages of the status and the artifacts, redrawn while the page is shown; a page taken off the document stops.
  const tickAges = (): void => {
    if (!root.isConnected) {
      return;
    }

    for (const age of root.querySelectorAll<HTMLElement>('.age')) {
      age.textContent = ago(Number(age.dataset['at']), Date.now());
    }

    setTimeout(tickAges, STATUS_AGE_MS);
  };

  setTimeout(tickAges, STATUS_AGE_MS);

  const save = (): void => {
    const scroller = root.querySelector<HTMLElement>('.scroll');

    // Off the Conversation tab, the scroll position it had is kept until it is shown again. The composer keeps its draft in the same state.
    const scroll = scroller === null ? restore : atEnd(scroller) ? null : scroller.scrollTop;

    vscode.setState({ ...((vscode.getState() as object | null) ?? {}), open: [...open], scroll, tab } satisfies PageState);
  };
  const atEnd = (scroller: HTMLElement): boolean => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;

  // The tab and scope the page last drew, so a redraw of the same Status or Artifacts tab keeps its scroll position.
  let drawn: string | null = null;
  /** A focused tab or button outside the timeline, found again after a redraw by its tab, action and path. */
  const focusKey = (element: Element | null): { tab?: string | undefined; action?: string | undefined; path?: string | undefined } | null => {
    if (!(element instanceof HTMLElement) || !root.contains(element) || element.closest('.timeline') !== null) {
      return null;
    }

    return element.dataset['tab'] !== undefined ? { tab: element.dataset['tab'] } : element.dataset['action'] !== undefined ? { action: element.dataset['action'], path: element.dataset['path'] } : null;
  };

  const draw = (): void => {
    const before = root.querySelector<HTMLElement>('.scroll');
    // A redraw puts the focus back on the item it was on only while the timeline had it, never taking it from the composer.
    const timelineFocused = root.contains(document.activeElement);
    const refocus = focusKey(document.activeElement);
    const wasAtEnd = before === null || atEnd(before);
    const top = before?.scrollTop ?? 0;
    const panelTop = root.querySelector<HTMLElement>('.panel')?.scrollTop ?? 0;
    const view = `${tab} ${state.scope?.scopeGen ?? ''} ${state.scope?.sessionId ?? ''}`;
    const ids = new Set(state.items.map((item) => item.id));
    const added = state.items.filter((item) => !shownIds.has(item.id));

    // Items that come while another tab is shown, with the conversation scrolled up, are below where the operator was reading.
    if (before === null && restore !== null && added.length > 0 && shownIds.size > 0) {
      unseenBelow = true;
    }

    startFreshClock();
    root.innerHTML = renderConversation(state, open, Date.now(), freshUntil > Date.now(), { tab, unopened });
    // The composer belongs to the Conversation tab.
    document.body.dataset['tab'] = tab;

    const panel = root.querySelector<HTMLElement>('.panel');

    if (panel !== null && drawn === view) {
      panel.scrollTop = panelTop;
    }

    drawn = view;

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
      }

      if (unseenBelow && !atEnd(scroller)) {
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

      resized?.disconnect();
      resized?.observe(scroller);
      scroller.addEventListener('scroll', () => {
        if (atEnd(scroller)) {
          unseenBelow = false;
          root.querySelector('.pill')?.remove();
        }

        save();
        checkSeen();
      });
    }

    // New replies are read out by a screen reader once.
    const spoken = added.filter((item) => item.type === 'reply' && item.kind === 'reply' && shownIds.size > 0);

    if (spoken.length > 0) {
      live.textContent = spoken.map((item) => (item.type === 'reply' ? item.opening : '')).join(' ');
    }

    shownIds = ids;

    if (refocus !== null) {
      [...root.querySelectorAll<HTMLElement>('[data-tab], [data-action]')].find((element) => focusKey(element) !== null && element.dataset['tab'] === refocus.tab && element.dataset['action'] === refocus.action && element.dataset['path'] === refocus.path)?.focus();
    } else if (focused !== null && timelineFocused) {
      root.querySelector<HTMLElement>(`li[data-id="${CSS.escape(focused)}"]`)?.focus();
    }

    checkSeen();
  };

  /** Shows a tab, keeping the conversation's scroll position for when it is shown again. */
  const selectTab = (next: Tab): void => {
    if (next === tab) {
      return;
    }

    const scroller = root.querySelector<HTMLElement>('.scroll');

    if (scroller !== null) {
      restore = atEnd(scroller) ? null : scroller.scrollTop;
    }

    tab = next;
    focused = null;
    draw();
    save();
    root.querySelector<HTMLElement>(`[role="tab"][data-tab="${tab}"]`)?.focus();
  };

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const tabButton = target.closest<HTMLElement>('[role="tab"]');

    if (tabButton !== null) {
      selectTab(tabButton.dataset['tab'] as Tab);
      return;
    }

    const link = target.closest<HTMLElement>('a[data-href]');

    if (link !== null) {
      event.preventDefault();
      vscode.postMessage({ type: 'open', href: link.dataset['href'] ?? '' });
      return;
    }

    const button = target.closest<HTMLElement>('[data-action]');
    const action = button?.dataset['action'];

    if (action === 'terminal' || action === 'earlier' || action === 'statuses') {
      vscode.postMessage({ type: action });
    } else if (action === 'artifact') {
      vscode.postMessage({ type: 'artifact', path: button!.dataset['path'] ?? '' });
    } else if (action === 'status-open') {
      seenStatus();
      vscode.postMessage({ type: 'status-open' });
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
        checkSeen();
      }
    },
    true,
  );

  // The tab strip is one tab stop, as VS Code's: Left and Right move to the tab before or after, Home and End to the first or last.
  root.addEventListener('keydown', (event) => {
    const current = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
    const keys: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -TABS.length, End: TABS.length };

    if (current === null || keys[event.key] === undefined) {
      return;
    }

    const index = TABS.findIndex((one) => one.tab === current.dataset['tab']);

    event.preventDefault();
    selectTab(TABS[Math.max(0, Math.min(TABS.length - 1, index + keys[event.key]!))]!.tab);
  });

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
      // An artifact's row opens it.
      if (current.dataset['path'] !== undefined) {
        vscode.postMessage({ type: 'artifact', path: current.dataset['path'] });
        event.preventDefault();
        return;
      }

      const fold = current.querySelector<HTMLDetailsElement>('details');

      if (fold !== null) {
        fold.open = !fold.open;
        event.preventDefault();
      }
    }
  });

  window.addEventListener('resize', checkSeen);
  document.addEventListener('visibilitychange', () => {
    // A New status that came while the page was hidden starts its minute once the page shows it.
    startFreshClock();
    checkSeen();
  });

  window.addEventListener('message', (event: MessageEvent<{ type: 'state'; state: ConversationState; unopened?: string[] } | { type: 'focus'; focused: boolean } | { type: 'seen-failed'; ids: string[] } | { type: 'sent'; id: number; error: string | null } | { type: 'copied'; id: number; ok: boolean } | { type: 'unsent'; returned: Array<{ text: string; error: string }> } | ExtrasReply>) => {
    if (event.data.type === 'files' || event.data.type === 'commands' || event.data.type === 'mentions' || event.data.type === 'image') {
      composer?.receive(event.data);
    } else if (event.data.type === 'focus') {
      windowFocused = event.data.focused;
      checkSeen();
    } else if (event.data.type === 'seen-failed') {
      // The hub did not take them, so they are reported again once they have been visible for another second.
      for (const id of event.data.ids) {
        reported.delete(id);
      }

      checkSeen();
    } else if (event.data.type === 'state') {
      state = event.data.state;
      unopened = new Set(event.data.unopened ?? []);

      // A reconnect starts from the hub's state: items reported while the stream was down are reported again if still unread.
      if (state.connected && !wasConnected) {
        reported.clear();
      }

      wasConnected = state.connected;
      noteStatus();
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
