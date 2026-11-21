import { applyEvent, commandQuery, EMPTY, mentionOf, mentionQuery, pageTitle, selectedEntry, selectedRow, sentTexts, shortTitle, withEarlier } from './model.js';
import { snoozeChoices } from '@switchboard/core/snooze';
import type { PageState } from './model.js';
import { escape, renderMarkdown } from './markdown.js';
import { answerText, artifactUrl, complete, firstSnoozeDay, renderEndedNote, renderMicButton, markdownBody, newView, parseQuestions, renderArtifacts, renderArtifactView, renderHeader, renderList, renderSheet, renderSideSwitch, renderStatus, renderTabs, renderTimeline, renderVoice, snoozeDateUntil, TABS, consoleNote, SIDE_TABS } from './render.js';
import type { CardDraft, SideTab, Tab, View } from './render.js';
import type { ConsoleOptions, MountedConsole } from './console.js';
import type { ItemView, ScreenPrompt } from './types.js';
import { morph } from './morph.js';
import { listHeader } from './listHeader.js';
import { reconnector } from './reconnect.js';
import { fitPills } from './fit.js';
import { overlayScrollbars } from './scrollbars.js';

/** The stream's event types the page reads. */
export const EVENTS = ['hello', 'list', 'scope', 'conversations', 'session', 'message', 'reply', 'status', 'artifact', 'unread', 'voice', 'settings', 'progress', 'words', 'draft'];
/** How long an unread reply or status must be visible on a focused page before it counts as seen (architecture.md § Unread). */
export const SEEN_MS = 1_000;
const SEEN_CHECK_MS = 250;
const COMPOSER_MAX_PX = 200;
/** How long the composer says a message sent from the Status or Artifacts tab went. */
export const SENT_NOTE_MS = 4_000;
/** How often the page reads the prompt a session waits on in its terminal while it waits. */
export const PROMPT_POLL_MS = 1_000;
/** How long the box's draft waits before the hub hears it, as in the Conversation view. */
export const COMPOSER_DRAFT_MS = 300;
/** The widths the sashes allow for the work items and the conversation, in pixels, their arrow-key step, and where the page keeps them. */
export const SIDE_MIN = 200;
export const SIDE_MAX = 600;
export const CHAT_MIN = 480;
export const CHAT_MAX = 1600;
const SASH_STEP = 16;
/** A pill shrunk to its icon: its 1 px borders, 6 px padding each side and a 12 px codicon; and the space between line 2's items. */
const COMPACT_PILL = 26;
const PILL_GAP = 6;
const SIDE_WIDTH = 'switchboard.sideWidth';
/** The conversation's text sizes, as shares of the theme's, and where the page keeps the one chosen. */
export const TEXT_SCALES = [0.85, 0.9, 1, 1.1, 1.25, 1.5];
const TEXT_SCALE = 'switchboard.textScale';
/** Where the page keeps Show message details. */
const DETAILS = 'switchboard.messageDetails';

/** The next text size up (1) or down (-1) from `scale`, staying at the ends. */
export function stepScale(scale: number, step: 1 | -1): number {
  const at = TEXT_SCALES.indexOf(scale);

  return TEXT_SCALES[Math.max(0, Math.min(TEXT_SCALES.length - 1, (at === -1 ? TEXT_SCALES.indexOf(1) : at) + step))]!;
}
const CHAT_WIDTH = 'switchboard.chatWidth';
/** From this width Status and Artifacts are a column beside the conversation rather than tabs. */
export const WIDE_QUERY = '(min-width: 1200px)';
/** Where the page keeps which side columns are shown. */
const LAYOUT = 'switchboard.layout';
/** Where the page keeps each work item's draft, over a reload. */
const DRAFTS = 'switchboard.drafts';
/** Where the page keeps each work item's attached files, over a reload. */
const ATTACHMENTS = 'switchboard.attachments';
/** The largest file the composer attaches, the hub's limit and the Conversation view's for a pasted image. */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
/** The most files one message carries. */
export const MAX_ATTACHMENTS = 10;

export interface PageDeps {
  fetch: typeof fetch;
  EventSource: new (url: string) => EventSource;
  now(): number;
  /** Loads Mermaid's script on first use; resolves false when the hub has none. */
  loadMermaid?(): Promise<boolean>;
  /** Loads the console's script and styles on first use; resolves null when they cannot load. */
  loadConsole?(): Promise<ConsoleModule | null>;
  /** The build of the hub that served the page, from its `switchboard-build` meta tag, and how to reload, for a hub that restarts. */
  build?: string | null;
  reload?(): void;
}

type Answer = { status: number; body: Record<string, unknown> };

/** What the console's script, `console.js`, offers once loaded (architecture.md § Web page). */
export interface ConsoleModule {
  mount(host: HTMLElement, options: ConsoleOptions): MountedConsole;
}

/**
 * The web page (architecture.md § Web page): the list of work items on the left; the selected one's conversation, status and artifacts tabs and
 * the composer on the right. Everything it shows comes from its own conversation stream, bound to the work item it selected.
 */
export function startPage(root: HTMLElement, deps: PageDeps): { state(): PageState; close(): void } {
  root.innerHTML =
    '<aside class="side"><div class="side-head"></div><div id="list"></div><div id="list-sheet"></div></aside>' +
    `<div class="sash side-sash" role="separator" aria-orientation="vertical" aria-label="Work items width" aria-controls="list" tabindex="0" aria-valuemin="${SIDE_MIN}" aria-valuemax="${SIDE_MAX}" title="Drag to resize; double-click to reset"></div>` +
    '<main class="main"><div id="head"></div><div id="panel" class="scroll"></div><div id="note"></div><div id="composer" hidden></div></main>' +
    `<div class="sash chat-sash" role="separator" aria-orientation="vertical" aria-label="Conversation width" aria-controls="panel" tabindex="0" aria-valuemin="${CHAT_MIN}" aria-valuemax="${CHAT_MAX}" title="Drag to resize; double-click to reset"></div>` +
    '<aside id="detail" class="detail" aria-label="Status and artifacts"><div class="detail-head"></div><div class="detail-body scroll"></div></aside><div id="sheet"></div><div class="live" aria-live="polite"></div>';

  const list = root.querySelector<HTMLElement>('#list')!;
  const head = root.querySelector<HTMLElement>('#head')!;
  const panel = root.querySelector<HTMLElement>('#panel')!;
  const composerHost = root.querySelector<HTMLElement>('#composer')!;
  const note = root.querySelector<HTMLElement>('#note')!;
  const sheetHost = root.querySelector<HTMLElement>('#sheet')!;
  const detailHead = root.querySelector<HTMLElement>('#detail .detail-head')!;
  const detailBody = root.querySelector<HTMLElement>('#detail .detail-body')!;
  // On a wide screen Status and Artifacts leave the tabs for a column of their own beside the conversation (architecture.md § Web page).
  const wideQuery = typeof window.matchMedia === 'function' ? window.matchMedia(WIDE_QUERY) : null;
  // Each side column can be hidden on a wide screen, remembered in local storage; with the right one hidden, Status and Artifacts are tabs again.
  const layout = ((): { list: boolean; detail: boolean } => {
    try {
      const kept = JSON.parse(localStorage.getItem(LAYOUT) ?? '{}') as { list?: unknown; detail?: unknown };

      return { list: kept.list !== false, detail: kept.detail !== false };
    } catch {
      return { list: true, detail: true };
    }
  })();
  const toggleSide = (side: 'list' | 'detail'): void => {
    layout[side] = !layout[side];
    localStorage.setItem(LAYOUT, JSON.stringify(layout));
    draw();
  };
  const wideScreen = (): boolean => wideQuery?.matches === true;
  const wide = (): boolean => wideScreen() && layout.detail;

  // The work items' and the conversation's widths (architecture.md § Web page), each set on a sash: the work items' on their edge, the
  // conversation's between it and the Status and Artifacts column, which takes the rest of the width.
  resizer(root, root.querySelector<HTMLElement>('.side-sash')!, root.querySelector<HTMLElement>('.side')!, { property: '--side-width', key: SIDE_WIDTH, min: SIDE_MIN, max: SIDE_MAX });
  resizer(root, root.querySelector<HTMLElement>('.chat-sash')!, root.querySelector<HTMLElement>('.main')!, { property: '--chat-width', key: CHAT_WIDTH, min: CHAT_MIN, max: CHAT_MAX });
  // Line 2's pills shrink to their icons when a row is too narrow, as the dock's do: one pass over every row once a frame at most, after a
  // redraw of the list or a change of its width, which reads every width before it changes any class, so the layout is computed once.
  let fitting = false;
  const fitLines = (): void => {
    if (fitting) {
      return;
    }

    fitting = true;
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (run: () => void) => setTimeout(run, 0))(() => {
      fitting = false;

      const lines = [...list.querySelectorAll<HTMLElement>('.row-line:not(.row-details)')];

      for (const line of lines) {
        line.querySelectorAll('.pill.compact, .pill.omitted').forEach((pill) => pill.classList.remove('compact', 'omitted'));
      }

      const plans = lines.map((line) => {
        const pills = [...line.querySelectorAll<HTMLElement>('.pill')];
        const playbook = line.querySelector<HTMLElement>('.playbook');
        const others = [...line.children].filter((child) => child !== playbook && !child.classList.contains('pill') && !child.classList.contains('row-links')).map((child) => (child as HTMLElement).offsetWidth);

        return { pills, fit: fitPills(line.clientWidth, others, playbook?.scrollWidth ?? 0, pills.map((pill) => ({ width: pill.offsetWidth, compact: COMPACT_PILL, returned: pill.classList.contains('returned') })), PILL_GAP) };
      });

      for (const { pills, fit } of plans) {
        pills.forEach((pill, index) => fit[index] !== 'full' && pill.classList.add(fit[index]!));
      }
    });
  };
  const listWidth = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitLines()) : null;
  const stopScrollbars = overlayScrollbars(root);
  /** The conversation's text size, a share of the theme's (--chat-scale), kept in local storage and set before the first draw. */
  const setTextScale = (scale: number, keep = true): void => {
    view.textScale = scale;
    root.style.setProperty('--chat-scale', String(scale));

    if (keep) {
      try {
        if (scale === 1) {
          localStorage.removeItem(TEXT_SCALE);
        } else {
          localStorage.setItem(TEXT_SCALE, String(scale));
        }
      } catch {
        // A page without local storage keeps the size until it reloads.
      }

      draw();
    }
  };

  listWidth?.observe(list);
  /** The tab the conversation's pane shows: always the conversation while Status and Artifacts have their own column. */
  const mainTab = (): Tab => (wide() ? 'conversation' : view.tab);

  wideQuery?.addEventListener?.('change', () => draw());
  let state: PageState = EMPTY;
  const view: View = newView();

  try {
    view.details = localStorage.getItem(DETAILS) === '1';
  } catch {
    // Off without local storage.
  }

  setTextScale(((): number => {
    try {
      const kept = Number(localStorage.getItem(TEXT_SCALE));

      return TEXT_SCALES.includes(kept) ? kept : 1;
    } catch {
      return 1;
    }
  })(), false);
  /** A select refused while no conversation was shown, which the list shows until the next select. */
  let listError: string | null = null;
  let wanted: number | null = Number(/^#w=(\d+)$/.exec(location.hash)?.[1] ?? NaN) || null;
  let expired = false;
  let opId = 0;
  const newOp = (): string => `${deps.now().toString(36)}-${(++opId).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const post = async (name: string, body: Record<string, unknown>): Promise<Answer> => {
    try {
      const response = await deps.fetch(`/v1/conversation/${name}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ window: state.key, opId: newOp(), ...body }) });

      expired ||= response.status === 401;
      return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
    } catch (error) {
      return { status: 0, body: { error: `Switchboard did not answer: ${String(error)}` } };
    }
  };
  // The list's header: the dock header's source icons, search and More Actions (architecture.md § Web page).
  const header = listHeader(root.querySelector<HTMLElement>('.side-head')!, list, root.querySelector<HTMLElement>('#list-sheet')!, { post: (name, body) => post(name, body), redraw: () => draw(), select: (workItemId) => void select(workItemId), now: () => deps.now() });
  /** A command for the conversation the page shows, refused by the hub when the page has moved on since. */
  const command = (name: string, body: Record<string, unknown> = {}): Promise<Answer> => post(name, { scopeGen: state.scope?.scopeGen ?? -1, ...body });

  // ---- The composer ----
  composerHost.innerHTML =
    '<div class="composer-sent" role="status" hidden><span class="codicon codicon-check" aria-hidden="true"></span><span>Sent. Its reply shows on the Conversation tab.</span></div>' +
    '<div class="composer-error" role="alert" hidden><span class="composer-error-text"></span><button class="dismiss" type="button" aria-label="Dismiss"><span class="codicon codicon-close"></span></button></div>' +
    '<div class="composer"><div class="glass composer-menu" role="listbox" hidden></div><div class="attachments" role="list" aria-label="Attached files" hidden></div><div class="composer-input"><div class="live-mirror"><span class="mirror-text" aria-hidden="true"></span><span class="live-words" aria-live="polite" hidden></span></div><textarea rows="1" aria-label="Message"></textarea></div><div class="composer-footer"><div class="composer-controls">' +
    '<button class="composer-tool attach" type="button" title="Attach files…" aria-label="Attach files"><span class="codicon codicon-add" aria-hidden="true"></span></button><input class="attach-input" type="file" multiple hidden tabindex="-1" aria-hidden="true">' +
    '<button class="composer-tool slash" type="button" title="Show slash commands (/)" aria-label="Show slash commands"><span class="slash-glyph">/</span></button></div><div class="voice-controls"></div>' +
    '<span class="composer-mic"></span><button class="send" type="button" title="Send (Enter)" aria-label="Send" disabled><span class="codicon codicon-arrow-up"></span></button></div></div>';

  const input = composerHost.querySelector('textarea')!;
  const send = composerHost.querySelector<HTMLButtonElement>('button.send')!;
  const errorBox = composerHost.querySelector<HTMLElement>('.composer-error')!;
  const menu = composerHost.querySelector<HTMLElement>('.composer-menu')!;
  const voiceControls = composerHost.querySelector<HTMLElement>('.voice-controls')!;
  const micSlot = composerHost.querySelector<HTMLElement>('.composer-mic')!;
  const liveWords = composerHost.querySelector<HTMLElement>('.live-words')!;
  const mirror = composerHost.querySelector<HTMLElement>('.live-mirror')!;
  const mirrorText = composerHost.querySelector<HTMLElement>('.mirror-text')!;
  const attachButton = composerHost.querySelector<HTMLButtonElement>('button.attach')!;
  const attachInput = composerHost.querySelector<HTMLInputElement>('input.attach-input')!;
  const chips = composerHost.querySelector<HTMLElement>('.attachments')!;
  // Document listeners end with the page.
  const listening = new AbortController();
  // The draft the hub last sent for dictation, per session, so a newer one replaces it in the box but never text typed over it, and one that came
  // while a message was being sent, which fills the box once the send answered.
  const hubDrafts = new Map<string, string>();
  let heldDraft: { sessionId: string; text: string } | null = null;
  const takeHubDraft = (sessionId: string, text: string): void => {
    const before = hubDrafts.get(sessionId) ?? '';

    hubDrafts.set(sessionId, text);

    if (sessionId !== state.session?.id) {
      return;
    }

    if (sending) {
      heldDraft = { sessionId, text };
      return;
    }

    if (input.value === '' || input.value === before) {
      input.value = text;
      keepDraft();
      grow();
      refresh();
    }
  };
  let sending = false;
  let draftOf: number | null = null;
  let chosen: string | null = null;
  let walk: { index: number; draft: string } | null = null;
  // Why a message of another work item was not sent, shown when the composer shows that work item again.
  const errors = new Map<number, string>();
  // The messages this page sent, by ID, and not-sent events whose send had not answered yet, so a late refusal finds its text.
  const mine = new Set<string>();
  const unsent = new Map<string, { text: string; error: string; workItemId: number | null }>();
  // Returns that arrived while the composer was sending, put back once it answered.
  const held: Array<{ text: string; error: string; workItemId: number | null }> = [];
  let menuOpen: { kind: 'files'; start: number; items: Array<{ path: string; dir: boolean }> } | { kind: 'commands'; items: Array<{ name: string; description: string }> } | null = null;
  let active = 0;
  let asked = 0;

  const drafts = (): Record<string, string> => {
    try {
      return JSON.parse(localStorage.getItem(DRAFTS) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  };
  const keepDraft = (): void => {
    if (draftOf === null || sending) {
      return;
    }

    const all = drafts();

    if (input.value === '') {
      delete all[draftOf];
    } else {
      all[draftOf] = input.value;
    }

    localStorage.setItem(DRAFTS, JSON.stringify(all));
  };

  // ---- Attached files (architecture.md § Web page) ----
  // Each work item's files, as chips above the box until its next message names them; `path` is null while the hub takes the file.
  type Attached = { id: number; name: string; path: string | null; image: boolean; abort: AbortController | null };
  const attached = new Map<number, Attached[]>();
  let attachedId = 0;
  const keptAttachments = (): Record<string, Array<{ name: string; path: string; image: boolean }>> => {
    try {
      const kept = JSON.parse(localStorage.getItem(ATTACHMENTS) ?? '{}') as unknown;

      return typeof kept === 'object' && kept !== null ? (kept as Record<string, Array<{ name: string; path: string; image: boolean }>>) : {};
    } catch {
      return {};
    }
  };
  const attachedTo = (workItemId: number): Attached[] => {
    let list = attached.get(workItemId);

    if (list === undefined) {
      const kept = keptAttachments()[workItemId];

      list = (Array.isArray(kept) ? kept : [])
        .filter((one) => typeof one?.name === 'string' && typeof one.path === 'string')
        .map((one) => ({ id: ++attachedId, name: one.name, path: one.path, image: one.image === true, abort: null }));
      attached.set(workItemId, list);
    }

    return list;
  };
  const keepAttachments = (workItemId: number): void => {
    const all = keptAttachments();
    const ready = attachedTo(workItemId).flatMap((one) => (one.path === null ? [] : [{ name: one.name, path: one.path, image: one.image }]));

    if (ready.length === 0) {
      delete all[workItemId];
    } else {
      all[workItemId] = ready;
    }

    localStorage.setItem(ATTACHMENTS, JSON.stringify(all));
  };
  const shownAttachments = (): Attached[] => (draftOf === null ? [] : attachedTo(draftOf));
  const uploading = (): boolean => shownAttachments().some((one) => one.path === null);
  const drawAttachments = (): void => {
    const list = shownAttachments();

    chips.hidden = list.length === 0;
    chips.innerHTML = list
      .map((one) => {
        const icon = one.path === null ? 'loading codicon-modifier-spin' : one.image ? 'file-media' : 'file';

        return (
          `<span class="attachment" role="listitem" data-attachment="${one.id}" title="${escape(one.path === null ? `Attaching ${one.name}…` : one.name)}">` +
          `<span class="codicon codicon-${icon}" aria-hidden="true"></span><span class="attachment-name">${escape(one.name)}</span>` +
          `<button type="button" class="attachment-remove" data-remove="${one.id}" aria-label="Remove ${escape(one.name)}"><span class="codicon codicon-close" aria-hidden="true"></span></button></span>`
        );
      })
      .join('');
  };
  /** Whether the composer takes files now: a conversation shown whose session can take a message. */
  const canAttach = (): boolean => draftOf !== null && state.key !== null && state.scope !== null && state.connected && state.session?.conversation === 'full';
  /** Sends one file to the hub for the work item it was attached to, and puts its path on its chip, or drops the chip and says why. */
  const upload = async (workItemId: number, key: string, scopeGen: number, file: File, entry: Attached): Promise<void> => {
    let error: string | null = null;

    try {
      const response = await deps.fetch(`/v1/conversation/upload?window=${encodeURIComponent(key)}&scopeGen=${scopeGen}&name=${encodeURIComponent(entry.name)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': file.type === '' ? 'application/octet-stream' : file.type },
        body: file,
        signal: entry.abort!.signal,
      });
      const body = (await response.json().catch(() => ({}))) as { path?: unknown; image?: unknown; error?: unknown };

      expired ||= response.status === 401;

      if (response.ok && typeof body.path === 'string') {
        entry.path = body.path;
        entry.image = body.image === true;
      } else {
        error = String(body.error ?? `${entry.name} was not attached (status ${response.status}).`);
      }
    } catch (failure) {
      // A chip removed while its file was sent ends its request.
      if (entry.abort?.signal.aborted === true) {
        return;
      }

      error = `${entry.name} was not attached: Switchboard did not answer (${String(failure)}).`;
    }

    entry.abort = null;

    const list = attachedTo(workItemId);

    if (!list.includes(entry)) {
      return;
    }

    if (error !== null) {
      list.splice(list.indexOf(entry), 1);

      if (workItemId === draftOf) {
        showError(error);
      } else {
        errors.set(workItemId, error);
      }
    }

    keepAttachments(workItemId);

    if (workItemId === draftOf) {
      drawAttachments();
      refresh();
    }
  };
  /** Attaches files picked, pasted or dropped to the shown work item: each sent to the hub, at most 10 MB and 10 files to a message. */
  const attachFiles = (files: readonly File[]): void => {
    if (!canAttach() || files.length === 0) {
      return;
    }

    const workItemId = draftOf!;
    const list = attachedTo(workItemId);
    const refused: string[] = [];

    for (const file of files) {
      const name = file.name === '' ? 'Pasted file' : file.name;

      if (list.length >= MAX_ATTACHMENTS) {
        refused.push(`A message takes at most ${MAX_ATTACHMENTS} files.`);
        break;
      }

      if (file.size === 0 || file.size > MAX_ATTACH_BYTES) {
        refused.push(file.size === 0 ? `${name} is empty.` : `${name} is larger than 10 MB.`);
        continue;
      }

      const entry: Attached = { id: ++attachedId, name, path: null, image: file.type.startsWith('image/'), abort: new AbortController() };

      list.push(entry);
      void upload(workItemId, state.key!, state.scope!.scopeGen, file, entry);
    }

    if (refused.length > 0) {
      showError(refused.join(' '));
    }

    drawAttachments();
    refresh();
  };
  const sentNote = composerHost.querySelector<HTMLElement>('.composer-sent')!;
  let sentTimer: ReturnType<typeof setTimeout> | undefined;
  /** A message sent from another tab leaves that tab shown, with a short line that it went. */
  const confirmSent = (): void => {
    clearTimeout(sentTimer);
    sentNote.hidden = mainTab() === 'conversation';

    if (!sentNote.hidden) {
      sentTimer = setTimeout(() => void (sentNote.hidden = true), SENT_NOTE_MS);
    }
  };
  const showError = (text: string | null): void => {
    errorBox.querySelector('.composer-error-text')!.textContent = text ?? '';
    errorBox.hidden = text === null;
  };
  /** Live words show dimmed right after the box's text, on its line, from a copy of the text laid out under the box (architecture.md § Web page). */
  const syncLive = (): void => {
    const shown = !liveWords.hidden;

    mirrorText.textContent = shown ? input.value : '';
    liveWords.dataset['lead'] = shown && input.value !== '' && !/\s$/.test(input.value) ? ' ' : '';
    composerHost.classList.toggle('live-showing', shown);
  };
  const grow = (): void => {
    syncLive();
    input.style.paddingBottom = '';
    input.style.height = 'auto';

    // Live words that wrap past the text add their height below it, so the box's scroll range and the copy's match at any height.
    const extra = liveWords.hidden ? 0 : Math.max(0, mirror.scrollHeight - input.scrollHeight);

    if (extra > 0) {
      input.style.paddingBottom = `${10 + extra}px`;
    }

    input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_PX)}px`;
    mirror.scrollTop = input.scrollTop;
  };
  /** New live words scroll into view at the end of the box. */
  const showLive = (): void => {
    grow();

    if (!liveWords.hidden) {
      input.scrollTop = input.scrollHeight;
      mirror.scrollTop = input.scrollTop;
    }
  };
  const canSend = (): boolean => state.connected && state.session?.conversation === 'full' && !sending && !uploading() && (input.value.trim() !== '' || shownAttachments().length > 0);
  const refresh = (): void => {
    send.disabled = !canSend();
  };
  const closeMenu = (): void => {
    menuOpen = null;
    menu.hidden = true;
    menu.replaceChildren();
  };
  const drawMenu = (): void => {
    if (menuOpen === null) {
      closeMenu();
      return;
    }

    menu.innerHTML =
      menuOpen.items.length === 0
        ? `<div class="menu-empty">${menuOpen.kind === 'files' ? 'No matching files' : 'No matching commands'}</div>`
        : menuOpen.kind === 'files'
          ? menuOpen.items.map((item, index) => `<div class="menu-item${index === active ? ' active' : ''}" role="option" data-index="${index}"><span class="codicon codicon-${item.dir ? 'folder' : 'file'}"></span><span class="menu-name">${escape(item.path)}</span></div>`).join('')
          : menuOpen.items.map((item, index) => `<div class="menu-item command${index === active ? ' active' : ''}" role="option" data-index="${index}"><span class="menu-label">/${escape(item.name)}</span>${item.description === '' ? '' : `<span class="menu-description">${escape(item.description)}</span>`}</div>`).join('');
    menu.hidden = false;
  };
  /** The `@` picker and the `/` list follow the text before the caret. */
  const follow = async (): Promise<void> => {
    const before = input.value.slice(0, input.selectionStart);
    const mention = mentionQuery(before);
    const slash = commandQuery(before);
    const ask = ++asked;
    const shown = state.scope?.scopeGen;
    const current = (): boolean => ask === asked && shown === state.scope?.scopeGen;

    if (mention !== null && state.key !== null) {
      const response = await deps.fetch(`/v1/conversation/files?window=${encodeURIComponent(state.key)}&q=${encodeURIComponent(mention.query)}`, { credentials: 'same-origin' }).catch(() => null);
      const files = response?.ok === true ? (((await response.json()) as { files?: Array<{ path: string; dir: boolean }> }).files ?? []) : [];

      if (current()) {
        menuOpen = { kind: 'files', start: mention.start, items: files };
        active = 0;
        drawMenu();
      }
    } else if (slash !== null && state.session !== null) {
      const answer = await command('commands', { sessionId: state.session.id });
      const commands = ((answer.body['commands'] as Array<{ name: string; description: string }> | undefined) ?? []).filter((one) => one.name.toLowerCase().includes(slash.toLowerCase()));

      if (current()) {
        menuOpen = { kind: 'commands', items: commands.sort((a, b) => Number(!a.name.toLowerCase().startsWith(slash.toLowerCase())) - Number(!b.name.toLowerCase().startsWith(slash.toLowerCase()))) };
        active = 0;
        drawMenu();
      }
    } else {
      closeMenu();
    }
  };
  const choose = (index: number): void => {
    const open = menuOpen;

    if (open === null || open.items[index] === undefined) {
      return;
    }

    if (open.kind === 'files') {
      const mention = mentionOf(open.items[index].path);

      if (mention !== null) {
        input.setRangeText(`${mention} `, open.start, input.selectionEnd, 'end');
      }
    } else {
      chosen = `/${open.items[index].name}`;
      input.value = `${chosen} `;
      input.setSelectionRange(input.value.length, input.value.length);
    }

    closeMenu();
    input.focus();
    grow();
    refresh();
    keepDraft();
  };
  const submit = async (): Promise<void> => {
    if (!canSend() || state.scope === null || state.session === null) {
      return;
    }

    // Attached files go as mentions after the text, as the Conversation view puts a picked file's mention in the box.
    const files = shownAttachments().slice();
    const typed = input.value;
    const mentions = files.flatMap((one) => mentionOf(one.path!.replaceAll('\\', '/')) ?? []);
    const text = mentions.length === 0 ? typed : typed.trim() === '' ? mentions.join(' ') : `${typed.replace(/\s+$/, '')} ${mentions.join(' ')}`;
    const asCommand = chosen !== null && (text.trim() === chosen || text.startsWith(`${chosen} `)) && !text.trim().includes('\n');
    const target = { sessionId: state.session.id, launch: state.session.launch };
    const from = draftOf;

    sending = true;
    input.readOnly = true;
    composerHost.classList.add('sending');
    refresh();

    const sent = command('send', { ...target, text, ...(asCommand ? { command: true } : {}) });

    // Sending hands the box back to the voice, so dictation resumes, as in the Conversation view (architecture.md § Dictation).
    if (state.voice?.here === true && state.voice.mic !== undefined && !['off', 'idle-off', 'unavailable'].includes(state.voice.mic) && document.activeElement === input) {
      input.blur();
    }

    const answer = await sent;

    sending = false;
    const dictated = heldDraft;

    heldDraft = null;
    input.readOnly = false;
    composerHost.classList.remove('sending');

    const id = (answer.body['message'] as { id?: string } | undefined)?.id ?? null;
    const late = id === null ? undefined : unsent.get(id);

    if (answer.status === 200 && late === undefined) {
      if (id !== null) {
        mine.add(id);
      }

      if (from === draftOf) {
        input.value = dictated !== null && dictated.sessionId === target.sessionId ? dictated.text : '';
        chosen = null;
        showError(null);
        confirmSent();
      }

      const all = drafts();

      if (from !== null) {
        delete all[from];
        localStorage.setItem(DRAFTS, JSON.stringify(all));
        // Files attached while it was sent stay for the next message.
        attached.set(from, attachedTo(from).filter((one) => !files.includes(one)));
        keepAttachments(from);
      }

      keepDraft();
      drawAttachments();
    } else if (late !== undefined) {
      // Refused before its send answered: the text stays where it was typed, with why.
      unsent.delete(id!);

      if (from === draftOf) {
        showError(late.error);
      } else {
        // Its files stay attached, so only the typed text goes back.
        giveBack(from, typed, late.error);
      }
    } else if (from === draftOf) {
      showError(String(answer.body['error'] ?? `Not sent (status ${answer.status}).`));
    } else {
      giveBack(from, '', String(answer.body['error'] ?? `Not sent (status ${answer.status}).`));
    }

    for (const one of held.splice(0)) {
      giveBack(one.workItemId, one.text, one.error);
    }

    walk = null;
    grow();
    refresh();
  };
  /** Puts a message's text that was not sent back in its own work item's draft, below what is there, with why. */
  const giveBack = (workItemId: number | null, text: string, error: string): void => {
    const below = (draft: string): string => (text === '' ? draft : draft.trim() === '' ? text : `${draft.replace(/\n+$/, '')}\n\n${text}`);

    if (workItemId === null || workItemId === draftOf) {
      if (sending) {
        held.push({ text, error, workItemId });
        return;
      }

      input.value = below(input.value);
      showError(error);
      keepDraft();
      grow();
      refresh();
      return;
    }

    const all = drafts();
    const draft = below(all[workItemId] ?? '');

    if (draft !== '') {
      all[workItemId] = draft;
    }

    localStorage.setItem(DRAFTS, JSON.stringify(all));
    errors.set(workItemId, error);
  };

  input.addEventListener('scroll', () => void (mirror.scrollTop = input.scrollTop));
  input.addEventListener('input', () => {
    walk = null;
    grow();
    refresh();
    keepDraft();
    void follow();
  });
  input.addEventListener('keydown', (event) => {
    if (menuOpen !== null && menuOpen.items.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      active = (active + (event.key === 'ArrowDown' ? 1 : menuOpen.items.length - 1)) % menuOpen.items.length;
      drawMenu();
      event.preventDefault();
      return;
    }

    if (menuOpen !== null && (event.key === 'Enter' || event.key === 'Tab') && menuOpen.items.length > 0) {
      choose(active);
      event.preventDefault();
      return;
    }

    if (event.key === 'Escape') {
      if (menuOpen !== null) {
        closeMenu();
      } else if (state.voice?.here === true && state.voice.speaking !== null) {
        void command('stop-speaking');
      }

      return;
    }

    // Up and Down at the box's first and last lines walk the session's earlier messages, and give the draft back after the newest.
    if ((event.key === 'ArrowUp' && !input.value.slice(0, input.selectionStart).includes('\n')) || (event.key === 'ArrowDown' && walk !== null && !input.value.slice(input.selectionEnd).includes('\n'))) {
      const texts = sentTexts(state.items);
      const index = walk === null ? texts.length - 1 : walk.index + (event.key === 'ArrowUp' ? -1 : 1);

      if (event.key === 'ArrowUp' && (texts.length === 0 || index < 0)) {
        return;
      }

      walk ??= { index, draft: input.value };

      if (index >= texts.length) {
        input.value = walk.draft;
        walk = null;
      } else {
        walk.index = index;
        input.value = texts[index]!;
      }

      event.preventDefault();
      grow();
      refresh();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });
  menu.addEventListener('mousedown', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');

    if (row !== null) {
      event.preventDefault();
      choose(Number(row.dataset['index']));
    }
  });
  send.addEventListener('click', () => void submit());
  errorBox.querySelector('button.dismiss')!.addEventListener('click', () => showError(null));
  // The + button opens the browser's file picker, which a phone offers its camera and photos in too.
  attachButton.addEventListener('click', () => {
    if (canAttach()) {
      attachInput.click();
    }
  });
  attachInput.addEventListener('change', () => {
    attachFiles([...(attachInput.files ?? [])]);
    attachInput.value = '';
  });
  chips.addEventListener('click', (event) => {
    const id = Number((event.target as HTMLElement).closest<HTMLElement>('[data-remove]')?.dataset['remove'] ?? NaN);
    const list = shownAttachments();
    const entry = list.find((one) => one.id === id);

    if (entry === undefined || draftOf === null) {
      return;
    }

    entry.abort?.abort();
    list.splice(list.indexOf(entry), 1);
    keepAttachments(draftOf);
    drawAttachments();
    refresh();
    input.focus();
  });
  // Files pasted with no text beside them are attached; text pasted with a picture, as from a web page, stays text, as in the Conversation view.
  input.addEventListener('paste', (event) => {
    const data = event.clipboardData;
    const files = [...(data?.files ?? [])];

    if (data === null || files.length === 0 || [...data.types].includes('text/plain')) {
      return;
    }

    event.preventDefault();
    attachFiles(files);
  });
  // Files dragged onto the page from the computer are attached; a drop the composer cannot take is still kept from opening the file in the tab.
  const carriesFiles = (event: DragEvent): boolean => [...(event.dataTransfer?.types ?? [])].includes('Files');

  document.addEventListener(
    'dragover',
    (event) => {
      if (!carriesFiles(event)) {
        return;
      }

      event.preventDefault();
      composerHost.classList.toggle('drop-target', canAttach());

      if (event.dataTransfer !== null) {
        event.dataTransfer.dropEffect = canAttach() ? 'copy' : 'none';
      }
    },
    { signal: listening.signal },
  );
  document.addEventListener(
    'dragleave',
    (event) => {
      if (event.relatedTarget === null) {
        composerHost.classList.remove('drop-target');
      }
    },
    { signal: listening.signal },
  );
  document.addEventListener(
    'drop',
    (event) => {
      composerHost.classList.remove('drop-target');

      if (!carriesFiles(event)) {
        return;
      }

      event.preventDefault();
      attachFiles([...(event.dataTransfer?.files ?? [])]);
    },
    { signal: listening.signal },
  );
  composerHost.querySelector('button.slash')!.addEventListener('click', () => {
    if (input.value === '' && !input.disabled) {
      input.value = '/';
      input.focus();
      input.setSelectionRange(1, 1);
      void follow();
    }
  });
  voiceControls.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-voice]');
    const which = button?.dataset['voice'];

    if (which === 'speak-replies') {
      void command('speak-replies', { on: button!.getAttribute('aria-pressed') !== 'true' });
    } else if (which === 'stop') {
      void command('stop-speaking');
    } else if (which === 'talk-here') {
      void command('talk-here').then((answer) => answer.status === 200 || showError(String(answer.body['error'] ?? 'The voice did not move here.')));
    }
  });

  micSlot.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-voice="mic"]');

    if (button !== null) {
      void command('mic', { on: button.dataset['on'] === 'true' }).then((answer) => answer.status === 200 || showError(String(answer.body['error'] ?? 'The mic did not change.')));
    }
  });
  // The box's focus and draft, for the focus rule of dictation, as the Conversation view tells the hub (architecture.md § Dictation).
  let composerTimer: ReturnType<typeof setTimeout> | undefined;
  const tellHub = (): void => {
    clearTimeout(composerTimer);

    if (state.scope !== null && state.voice?.enabled === true) {
      void command('composer', { focused: document.activeElement === input, draft: sending ? '' : input.value });
    }
  };

  input.addEventListener('focus', tellHub);
  input.addEventListener('blur', tellHub);
  input.addEventListener('input', () => {
    clearTimeout(composerTimer);
    composerTimer = setTimeout(tellHub, COMPOSER_DRAFT_MS);
  });

  /** The composer follows the selected work item: its own draft, enabled only for a session it can talk to. */
  const updateComposer = (): void => {
    const id = state.scope?.workItemId ?? null;

    if (id !== draftOf) {
      draftOf = id;
      // Live words belong to the conversation they were heard for; its clearing event may never reach this one.
      liveWords.textContent = '';
      liveWords.hidden = true;
      input.value = id === null ? '' : (drafts()[id] ?? '');
      chosen = null;
      walk = null;
      showError(id === null ? null : (errors.get(id) ?? null));
      closeMenu();
      drawAttachments();

      if (id !== null) {
        errors.delete(id);
      }
    }

    const full = state.connected && state.session?.conversation === 'full';

    // On every tab, so the operator can type and dictate from the status or the artifacts too.
    composerHost.hidden = state.scope === null;
    input.disabled = !full;
    attachButton.disabled = !full;
    input.placeholder = full
      ? `Message ${shortTitle(selectedEntry(state)?.title ?? state.scope?.title ?? '')}…`
      : state.session?.state === 'ended' && state.session.conversation !== 'none'
        ? 'Resume the session to send a message.'
        : (state.session?.reason ?? (state.connected ? 'No session has started yet.' : 'Connecting to Switchboard…'));
    // The same controls as the Conversation view's, acting on this computer's voice process (architecture.md § Web page).
    morph(voiceControls, renderVoice(state.voice, full));
    morph(micSlot, full ? renderMicButton(state.voice) : '');
    grow();
    refresh();
  };

  // ---- Drawing ----
  let mermaidRun: Promise<boolean> | null = null;
  const drawDiagrams = (within: HTMLElement): void => {
    const diagrams = within.querySelectorAll<HTMLElement>('pre.mermaid');

    if (diagrams.length === 0 || deps.loadMermaid === undefined) {
      return;
    }

    mermaidRun ??= deps.loadMermaid();
    void mermaidRun.then((loaded) => {
      const mermaid = (globalThis as { mermaid?: { run(options: { nodes: ArrayLike<HTMLElement> }): Promise<void> } }).mermaid;

      if (loaded && mermaid !== undefined) {
        void mermaid.run({ nodes: diagrams }).catch(() => undefined);
      }
    });
  };
  /**
   * Draws an open Markdown artifact as claude-collab's viewer does: its text fetched by the page key, without its front matter, whose kind and
   * title the head shows; its relative pictures from its folder; a relative link to another artifact opening that one in place, and to another
   * file in the folder opening the file in a new tab; Mermaid included. `top` is the scroll position to keep when a new version replaces it.
   */
  const fillArtifact = async (path: string, top = 0): Promise<void> => {
    const doc = root.querySelector<HTMLElement>('.artifact-doc');

    if (doc === null || state.key === null) {
      return;
    }

    const key = state.key;
    const response = await deps.fetch(artifactUrl(key, path), { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
    const text = response?.ok === true ? await response.text() : null;
    const folder = path.split('/').slice(0, -1);
    /** A relative target's path in the artifact folder, or null for one outside it. */
    const inFolder = (target: string): string | null => {
      const parts = [...folder];
      let decoded: string;

      try {
        decoded = decodeURIComponent(target.split(/[?#]/)[0]!);
      } catch {
        return null;
      }

      for (const part of decoded.split('/')) {
        if (part === '..') {
          return null;
        }

        if (part !== '.' && part !== '') {
          parts.push(part);
        }
      }

      return parts.length < 2 ? null : parts.join('/');
    };
    const base = (src: string): string | null => {
      const file = inFolder(src);

      return file === null ? null : artifactUrl(key, file);
    };
    const link = (href: string): string | null => {
      const file = href.startsWith('#') ? null : inFolder(href);

      if (file === null) {
        return null;
      }

      return state.artifacts.some((one) => one.path === file)
        ? `href="${escape(artifactUrl(key, file))}" data-action="artifact" data-path="${escape(file)}"`
        : `href="${escape(artifactUrl(key, file))}" target="_blank" rel="noopener noreferrer"`;
    };

    if (view.artifact === path && root.contains(doc)) {
      doc.innerHTML = text === null ? '<p class="empty">This artifact could not be read.</p>' : renderMarkdown(markdownBody(text), base, link);
      doc.scrollTop = top;
      drawDiagrams(doc);
    }
  };
  /** Opens the shown Markdown artifact, as drawn, in a window of its own, with the page's styles and without its buttons. */
  const artifactWindow = (): void => {
    const shown = root.querySelector<HTMLElement>('.artifact-view');
    const doc = shown?.querySelector<HTMLElement>('.artifact-doc');

    if (shown === null || shown === undefined || doc === null || doc === undefined) {
      return;
    }

    const copy = doc.cloneNode(true) as HTMLElement;

    copy.querySelectorAll('.copy').forEach((button) => button.remove());
    // A blob: document has no base for the page's own paths, so its pictures and links name the hub in full.
    copy.querySelectorAll<HTMLElement>('[src^="/"], [href^="/"]').forEach((node) => {
      for (const name of ['src', 'href']) {
        const value = node.getAttribute(name);

        if (value?.startsWith('/') === true && !value.startsWith('//')) {
          node.setAttribute(name, `${location.origin}${value}`);
        }
      }

      node.removeAttribute('data-action');
    });

    const badge = shown.querySelector('.artifact-badge')?.outerHTML ?? '';
    const title = shown.querySelector('.artifact-title')?.textContent ?? '';
    const styles = ['theme.css', 'codicon.css', 'page.css'].map((name) => `<link rel="stylesheet" href="${location.origin}/page/${name}">`).join('');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title>${styles}</head><body class="artifact-window"><div class="artifact-view"><div class="artifact-head">${badge}<span class="artifact-title">${escape(title)}</span></div>${copy.outerHTML}</div></body></html>`;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));

    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  // Whether the conversation follows its end, set by the operator's own scrolling, and where the page itself last scrolled it, as in the Conversation view.
  let pinned = true;
  let ownTop = 0;
  /** What the panel last showed: its tab and conversation; another starts at its top, or at its end for a conversation. */
  let shown: string | null = null;
  /** Where the conversation was when another tab was shown. */
  let left: { conversation: string; pinned: boolean; top: number } | null = null;
  /** Keeps where the conversation is when the page moves from it to another tab, by a tab or an artifact's row. */
  const leaving = (next: Tab): void => {
    if (mainTab() === 'conversation' && next !== 'conversation' && state.scope !== null && !wide()) {
      left = { conversation: `${state.scope.scopeGen} ${state.session?.id ?? ''}`, pinned, top: panel.scrollTop };
    }
  };
  const atEnd = (): boolean => panel.scrollHeight - panel.scrollTop - panel.clientHeight < 24;
  const followEnd = (): void => {
    if (mainTab() === 'conversation' && state.scope !== null && pinned && panel.scrollTop < panel.scrollHeight - panel.clientHeight - 1) {
      panel.scrollTop = panel.scrollHeight;
      ownTop = panel.scrollTop;
    }
  };

  panel.addEventListener('scroll', () => {
    if (mainTab() !== 'conversation') {
      return;
    }

    if (atEnd()) {
      pinned = true;
    } else if (Math.abs(panel.scrollTop - ownTop) > 1) {
      pinned = false;
    }
  });

  // The panel shrinks when the composer or a banner grows, and its content grows when a fold opens or a picture loads.
  const resized =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          followEnd();
        })
      : null;

  resized?.observe(panel);

  /** Draws the state by changing only what differs (`morph`), so the focus, a selection, the scroll position and open menus stay. */
  const draw = (): void => {
    // On a narrow screen the list and the conversation are each a full-width view (page.css); the list shows until a work item is opened.
    root.classList.toggle('listing', view.list || wanted === null);
    document.title = pageTitle(state.groups);
    header.draw(state.header, state.groups);
    // A search shows only the rows that match, in every group, open (PRD R63).
    const listed = header.list(state.groups);
    morph(sheetHost, renderSheet(view.sheet, view.acting));
    morph(list, expired ? '<p class="empty">This page\'s link is no longer valid. Open a new one with Switchboard: Open Web Page in VS Code, or hub.js web.</p>' : (listError === null ? '' : `<p class="list-error" role="alert">${escape(listError)}</p>`) + renderList(listed.groups, state.scope?.workItemId ?? null, view.collapsed, listed.filtering) + header.end(listed.groups));
    fitLines();

    // An ended session's note sits just above the composer on every tab, with Resume, as in the Conversation view; the page resumes it in the
    // terminal holder, or a Codex thread in its daemon, without a terminal.
    morph(note, renderEndedNote(state.session, resuming));

    const side = wide() && state.scope !== null;

    root.classList.toggle('wide', side);
    root.classList.toggle('list-hidden', !layout.list && state.scope !== null);

    if (!side) {
      morph(detailHead, '');
      morph(detailBody, '');
    }

    if (state.scope === null) {
      morph(head, '');
      morph(panel, `<p class="empty">${state.connected ? 'Choose a work item on the left.' : 'Connecting to Switchboard…'}</p>`);
      shown = null;
      updateComposer();
      return;
    }

    morph(head, renderHeader(state, view, { list: layout.list, detail: wideScreen() ? layout.detail : null }) + (side ? '' : renderTabs(view, state)));

    const artifact = view.artifact === null ? undefined : state.artifacts.find((one) => one.path === view.artifact);
    const now = deps.now();
    /** Draws the Status or Artifacts tab, or an open artifact, into a pane; an open artifact stays as it is, so a frame or a video is not reloaded. */
    const drawTab = (pane: HTMLElement, tab: Tab): void => {
      pane.classList.toggle('console-pane', tab === 'console');

      // A console's terminal is its own; another tab starts from an empty pane rather than morph its nodes.
      if (tab !== 'console' && pane.querySelector(':scope > .console') !== null) {
        pane.innerHTML = '';
      }

      if (tab === 'console') {
        drawConsole(pane);
      } else if (tab === 'artifacts' && artifact !== undefined && state.key !== null) {
        const open = pane.querySelector<HTMLElement>('.artifact-view');

        // A new version replaces the one shown, and a Markdown artifact keeps the reader's place.
        if (open?.dataset['artifact'] !== artifact.path || open.dataset['version'] !== String(artifact.updatedAt)) {
          const top = open?.dataset['artifact'] === artifact.path ? (open.querySelector<HTMLElement>('.artifact-doc')?.scrollTop ?? 0) : 0;

          pane.innerHTML = renderArtifactView(state.key, artifact);
          void fillArtifact(artifact.path, top);
        }
      } else {
        morph(pane, tab === 'status' ? renderStatus(state, view, now) : tab === 'artifacts' ? renderArtifacts(state, now) : renderTimeline(state, view));
        drawDiagrams(pane);
      }

      pane.classList.toggle('framed', tab === 'artifacts' && artifact !== undefined);
    };

    drawTab(panel, mainTab());

    if (side) {
      morph(detailHead, renderSideSwitch(view.side, state));
      drawTab(detailBody, view.side);
    }
    // The composer first, so the conversation is scrolled against its final height.
    updateComposer();

    const conversation = `${state.scope.scopeGen} ${state.session?.id ?? ''}`;
    const showing = `${mainTab()} ${conversation}`;

    if (showing !== shown) {
      shown = showing;

      // The conversation comes back where the operator left it, while it is the same conversation; another tab or conversation starts afresh.
      const kept = mainTab() === 'conversation' && left !== null && left.conversation === conversation ? left : null;

      pinned = kept?.pinned ?? true;
      panel.scrollTop = mainTab() !== 'conversation' ? 0 : kept !== null && !kept.pinned ? kept.top : panel.scrollHeight;
      ownTop = panel.scrollTop;

      if (mainTab() === 'conversation') {
        left = null;
      }
    }

    const timelineList = panel.querySelector('.timeline');

    if (timelineList !== null) {
      resized?.observe(timelineList);
    }

    followEnd();
    checkSeen();
    dropConsoles();
  };

  // ---- The console ----
  // Each mounted console by its host, ended once its host leaves the page.
  const consoles = new Map<HTMLElement, MountedConsole>();
  let consoleLoad: Promise<ConsoleModule | null> | null = null;
  const dropConsoles = (): void => {
    for (const [host, mounted] of consoles) {
      if (!root.contains(host)) {
        consoles.delete(host);
        mounted.dispose();
      }
    }
  };
  /** Draws the Console tab: the selected conversation's held session, mounted once per page key, scope generation, session and launch (architecture.md § Web page). */
  function drawConsole(pane: HTMLElement): void {
    const session = state.session;
    const why = consoleNote(session);

    if (why !== null || session === null || state.key === null) {
      morph(pane, `<p class="empty">${escape(why ?? 'Connecting to Switchboard…')}</p>`);
      return;
    }

    // The hub ends a console when the page's scope generation, session or launch changes, so the page mounts a new one then.
    const id = `${state.key} ${state.scope?.scopeGen ?? ''} ${session.id} ${session.launch ?? ''}`;
    const shownConsole = pane.querySelector<HTMLElement>(':scope > .console');

    if (shownConsole?.dataset['console'] === id) {
      return;
    }

    pane.innerHTML = `<div class="console" data-console="${escape(id)}"><p class="empty">Loading the console…</p></div>`;
    dropConsoles();

    const host = pane.firstElementChild as HTMLElement;
    const key = state.key;
    const sessionId = session.id;
    const launch = session.launch;

    consoleLoad ??= deps.loadConsole?.() ?? Promise.resolve(null);
    void consoleLoad.then((module) => {
      if (!root.contains(host)) {
        return;
      }

      if (module === null) {
        host.innerHTML = '<p class="empty">The console could not be loaded. Reload the page to try again.</p>';
        consoleLoad = null;
        return;
      }

      host.innerHTML = '';
      consoles.set(
        host,
        module.mount(host, {
          url: `/v1/conversation/console?window=${encodeURIComponent(key)}&sessionId=${encodeURIComponent(sessionId)}`,
          EventSource: deps.EventSource,
          type: async (data, size) => {
            const answer = await command('console-input', { sessionId, launch, data, ...size });

            return answer.status === 200 ? null : String(answer.body['error'] ?? `Switchboard answered ${answer.status}.`);
          },
          copy: (text) => void navigator.clipboard?.writeText(text).catch(() => undefined),
        }),
      );
    });
  }

  // ---- Seen ----
  const visibleSince = new Map<string, number>();
  const reported = new Set<string>();
  let seenFor: string | null = null;
  const focusedVisible = (): boolean => document.visibilityState !== 'hidden' && document.hasFocus();
  const checkSeen = (): void => {
    const key = state.scope === null || state.session === null ? null : `${state.scope.scopeGen} ${state.session.id}`;

    if (key !== seenFor) {
      seenFor = key;
      reported.clear();
      visibleSince.clear();
    }

    if (key === null || !focusedVisible()) {
      visibleSince.clear();
      return;
    }

    // The conversation's pane, and on a wide screen the Status and Artifacts column beside it.
    const visible = [panel, ...(wide() ? [detailBody] : [])]
      .flatMap((pane) => {
        const box = pane.getBoundingClientRect();

        return [...pane.querySelectorAll<HTMLElement>('[data-unread]')].filter((element) => {
          const rect = element.getBoundingClientRect();
          const shown = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);

          return box.height === 0 || (shown > 0 && shown >= Math.min(rect.height, box.height) / 2);
        });
      })
      .map((element) => element.dataset['unread']!)
      .filter((id) => !reported.has(id));
    const now = deps.now();

    for (const id of [...visibleSince.keys()].filter((id) => !visible.includes(id))) {
      visibleSince.delete(id);
    }

    const due: string[] = [];

    for (const id of visible) {
      const since = visibleSince.get(id) ?? now;

      visibleSince.set(id, since);

      if (now - since >= SEEN_MS) {
        due.push(id);
      }
    }

    if (due.length > 0 && state.session !== null) {
      for (const id of due) {
        reported.add(id);
        visibleSince.delete(id);
      }

      void command('seen', { sessionId: state.session.id, ids: due }).then((answer) => {
        if (answer.status !== 200) {
          for (const id of due) {
            reported.delete(id);
          }
        }
      });
    }
  };
  const seenTimer = setInterval(checkSeen, SEEN_CHECK_MS);

  // ---- Focus: a focused, visible page counts as a focused window for the voice ----
  let focusSent: boolean | null = null;
  const reportFocus = (force = false): void => {
    const focused = focusedVisible();

    if (state.key !== null && (force || focused !== focusSent)) {
      focusSent = focused;
      void post('page-focus', { focused });
    }

    checkSeen();
  };

  window.addEventListener('focus', () => reportFocus());
  window.addEventListener('blur', () => reportFocus());
  document.addEventListener('visibilitychange', () => reportFocus());

  // ---- Selecting ----
  const select = async (workItemId: number): Promise<void> => {
    wanted = workItemId;
    listError = null;
    view.list = false;
    view.picker = false;
    view.actions = false;
    view.sheet = null;
    view.providers = null;
    newFrom = null;
    view.artifact = null;
    history.replaceState(null, '', `#w=${workItemId}`);

    if (state.scope?.workItemId === workItemId && !selectInFlight) {
      acked = workItemId;
      draw();
      return;
    }

    reconcile();
    // A narrow screen leaves the list at once; the conversation follows with the select's scope.
    draw();
  };
  // One select at a time; the latest work item asked for wins, whatever order the answers and scope events come in.
  let selectInFlight = false;
  let acked: number | null = null;
  const reconcile = (): void => {
    if (wanted === null || selectInFlight || state.key === null || acked === wanted) {
      return;
    }

    const asked = wanted;
    const key = state.key;

    selectInFlight = true;
    void post('select', { workItemId: asked }).then((answer) => {
      selectInFlight = false;

      if (key !== state.key) {
        return;
      }

      if (answer.status === 200) {
        acked = asked;
      } else if (wanted === asked) {
        const error = String(answer.body['error'] ?? 'The work item could not be opened.');

        wanted = state.scope?.workItemId ?? null;
        acked = wanted;
        history.replaceState(null, '', wanted === null ? '#' : `#w=${wanted}`);

        // With no conversation shown, the composer that holds errors is hidden, so the refusal shows over the list, which a phone shows again.
        if (wanted === null) {
          listError = error;
          view.list = true;
        } else {
          showError(error);
        }

        draw();
      }

      reconcile();
    });
  };

  // ---- Cards ----
  const cardQuestions = (key: string): ReturnType<typeof parseQuestions> => {
    const [kind, ...rest] = key.split(':');
    const id = rest.join(':');
    const markdown = kind === 'status' ? (state.status?.id === id ? state.status.markdown : '') : (state.items.find((item): item is Extract<ItemView, { type: 'reply' }> => item.id === id && item.type === 'reply')?.opening ?? '');

    return markdown === '' ? [] : parseQuestions(markdown);
  };
  const cardDraft = (key: string): CardDraft => {
    let draft = view.cards.get(key);

    if (draft === undefined) {
      draft = { choices: new Map(), sent: null, sending: false, error: null };
      view.cards.set(key, draft);
    }

    return draft;
  };
  const submitCard = async (key: string): Promise<void> => {
    const draft = cardDraft(key);
    const questions = cardQuestions(key);

    if (!complete(questions, draft.choices) || draft.sending || state.session === null || state.session.conversation !== 'full') {
      return;
    }

    draft.sending = true;
    draft.sent = answerText(questions, draft.choices);
    draft.error = null;
    draw();

    const answer = await command('send', { sessionId: state.session.id, launch: state.session.launch, text: draft.sent });
    const id = (answer.body['message'] as { id?: string } | undefined)?.id ?? null;
    const late = id === null ? undefined : unsent.get(id);

    draft.sending = false;

    if (answer.status !== 200 || late !== undefined) {
      draft.sent = null;
      draft.error = late?.error ?? String(answer.body['error'] ?? 'Not sent.');
      unsent.delete(id ?? '');
    } else {
      draft.sentId = id;
    }

    draw();
  };

  // ---- Clicks ----
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const sideTab = target.closest<HTMLElement>('[data-side]')?.dataset['side'];

    if (SIDE_TABS.includes(sideTab as SideTab)) {
      view.side = sideTab as SideTab;
      view.artifact = sideTab === 'artifacts' ? view.artifact : null;
      draw();
      return;
    }

    const tab = target.closest<HTMLElement>('[data-tab]')?.dataset['tab'] as Tab | undefined;

    if (tab !== undefined && TABS.some((one) => one.tab === tab)) {
      leaving(tab);
      view.tab = tab;
      view.artifact = tab === 'artifacts' ? view.artifact : null;
      draw();
      return;
    }

    const button = target.closest<HTMLElement>('[data-action]');
    const action = button?.dataset['action'];

    switch (action) {
      case 'select':
        void select(Number(button!.dataset['workItem']));
        break;
      case 'back':
        view.list = true;
        draw();
        list.querySelector<HTMLElement>('.row.selected')?.focus();
        break;
      case 'group': {
        const group = button!.dataset['group']!;

        if (!view.collapsed.delete(group)) {
          view.collapsed.add(group);
        }

        draw();
        break;
      }
      case 'toggle-list':
        toggleSide('list');
        break;
      case 'toggle-detail':
        toggleSide('detail');
        break;
      case 'new-conversation':
        void newConversation();
        break;
      case 'new-provider':
        view.providers = null;
        void createConversation(button!.dataset['provider'] ?? '');
        break;
      case 'picker':
        view.providers = null;
        view.picker = !view.picker;
        // One header menu at a time.
        view.personas = null;
        view.actions = false;
        view.textMenu = false;
        draw();
        break;
      case 'persona':
        view.actions = false;
        view.textMenu = false;
        void choosePersona();
        break;
      case 'actions':
        view.actions = !view.actions;
        view.picker = false;
        view.personas = null;
        view.textMenu = false;
        draw();
        break;
      case 'row-action':
        chooseAction(button!.dataset['rowAction'] ?? '');
        break;
      case 'row-paste':
        void copyPaste(button!.dataset['label'] ?? '');
        break;
      case 'sheet-cancel':
        // A press on the sheet itself is not one on its backdrop.
        if (!button!.classList.contains('sheet-backdrop') || target === button) {
          view.sheet = null;
          draw();
        }

        break;
      case 'sheet-go':
        void sheetGo();
        break;
      case 'resume':
        void resume();
        break;
      case 'prompt-key':
        void pressPromptKey(button!.dataset['promptKey'] ?? '');
        break;
      case 'persona-pick':
        view.personas = null;
        draw();

        if (state.session !== null) {
          void command('persona', { sessionId: state.session.id, personaId: button!.dataset['persona'] || null }).then((answer) => answer.status === 200 || showError(String(answer.body['error'] ?? 'The persona was not pinned.')));
        }

        break;
      case 'earlier':
        void earlier();
        break;
      case 'more': {
        const key = `more:${button!.dataset['reply']}`;

        if (!view.open.delete(key)) {
          view.open.add(key);
        }

        draw();
        break;
      }
      case 'artifact':
        // A link to another artifact in a Markdown artifact opens it in place, unless asked for a new tab.
        if (button!.tagName === 'A') {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) {
            break;
          }

          event.preventDefault();
        }

        leaving('artifacts');

        if (wide()) {
          view.side = 'artifacts';
        } else {
          view.tab = 'artifacts';
        }

        view.artifact = button!.dataset['path'] ?? null;
        draw();
        break;
      case 'close-artifact':
        view.artifact = null;
        draw();
        break;
      case 'artifact-window':
        artifactWindow();
        break;
      case 'text-menu':
        view.textMenu = !view.textMenu;
        // One header menu at a time.
        view.providers = null;
        view.picker = false;
        view.personas = null;
        view.actions = false;
        draw();
        break;
      case 'text-smaller':
      case 'text-larger':
        setTextScale(stepScale(view.textScale, action === 'text-larger' ? 1 : -1));
        break;
      case 'text-reset':
        setTextScale(1);
        break;
      case 'toggle-details':
        view.details = !view.details;

        try {
          if (view.details) {
            localStorage.setItem(DETAILS, '1');
          } else {
            localStorage.removeItem(DETAILS);
          }
        } catch {
          // A page without local storage keeps the choice until it reloads.
        }

        draw();
        break;
      case 'pick': {
        const key = button!.dataset['card']!;
        const index = Number(button!.dataset['question']);
        const letter = button!.dataset['letter']!;
        const draft = cardDraft(key);
        const choice = draft.choices.get(index) ?? { letters: [], other: '' };
        const multi = cardQuestions(key)[index]?.multi === true;
        const picked = choice.letters.includes(letter);

        draft.choices.set(index, multi ? { ...choice, letters: picked ? choice.letters.filter((one) => one !== letter) : [...choice.letters, letter] } : { letters: picked ? [] : [letter], other: picked ? choice.other : '' });
        draw();
        break;
      }
      case 'answer':
        void submitCard(button!.dataset['card']!);
        break;
      case 'request-option':
        view.requestValues.set(button!.dataset['field']!, button!.dataset['value']!);
        draw();
        break;
      case 'request-decision':
      case 'request-answer':
        void answerRequest(button!.dataset['request']!, action === 'request-decision' ? button!.dataset['decision']! : null);
        break;
      case 'copy-code':
      case 'copy-reply': {
        const id = button!.closest<HTMLElement>('li[data-id]')?.dataset['id'];
        const reply = state.items.find((item) => item.id === id && item.type === 'reply');
        const text = action === 'copy-code' ? (button!.parentElement?.querySelector('pre')?.textContent ?? '').replace(/\n$/, '') : reply?.type === 'reply' ? reply.opening : null;

        if (text !== null) {
          void navigator.clipboard?.writeText(text);
        }

        break;
      }
      default:
        if (view.picker && target.closest('.header') === null) {
          view.picker = false;
          draw();
        }
    }
  });
  root.addEventListener('toggle', (event) => {
    const fold = event.target as HTMLDetailsElement;
    const id = fold.dataset?.['fold'];

    if (id !== undefined) {
      if (fold.open) {
        view.open.add(id);
      } else {
        view.open.delete(id);
      }
    }
  }, true);
  root.addEventListener('input', (event) => {
    const field = event.target as HTMLInputElement;

    if (field.classList?.contains('request-field')) {
      view.requestValues.set(field.dataset['field']!, field.value);
      return;
    }

    if (!field.classList?.contains('question-other')) {
      return;
    }

    const key = field.dataset['card']!;
    const index = Number(field.dataset['question']);
    const draft = cardDraft(key);
    const choice = draft.choices.get(index) ?? { letters: [], other: '' };
    const single = cardQuestions(key)[index]?.multi !== true;

    draft.choices.set(index, { letters: single && field.value.trim() !== '' ? [] : choice.letters, other: field.value });

    const submit = [...root.querySelectorAll<HTMLButtonElement>('.question-submit')].find((one) => one.dataset['card'] === key) ?? null;

    if (submit !== null) {
      submit.disabled = !complete(cardQuestions(key), draft.choices);
    }
  });
  // The dropdown closes on a press outside the header and on Escape, which gives the focus back to its button.
  document.addEventListener('pointerdown', (event) => {
    if ((view.picker || view.personas !== null || view.actions || view.providers !== null || view.textMenu) && !(event.target instanceof Node && head.querySelector('.header')?.contains(event.target) === true)) {
      view.providers = null;
      view.picker = false;
      view.personas = null;
      view.actions = false;
      view.textMenu = false;
      draw();
    }
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && view.sheet !== null) {
      view.sheet = null;
      draw();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && (view.picker || view.personas !== null || view.actions || view.providers !== null || view.textMenu)) {
      const opener = view.picker || view.providers !== null ? 'button.picker' : view.actions ? 'button.actions' : view.textMenu ? 'button.text-size' : 'button.persona';

      view.providers = null;

      view.picker = false;
      view.personas = null;
      view.actions = false;
      view.textMenu = false;
      draw();
      head.querySelector<HTMLElement>(opener)?.focus();
      event.stopImmediatePropagation();
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (view.picker || view.personas !== null || view.actions || view.providers !== null || view.textMenu)) {
      // Up and Down move between a header menu's rows, as in a VS Code menu.
      const rows = [...head.querySelectorAll<HTMLElement>('.header .menu .menu-row')];
      const at = rows.indexOf(document.activeElement as HTMLElement);

      if (rows.length > 0) {
        rows[at === -1 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]!.focus();
        event.preventDefault();
      }
    }
  });
  // Ctrl+= and Ctrl+- make the conversation's text larger or smaller, Ctrl+0 resets it, in place of the browser's zoom.
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
      return;
    }

    const step = event.key === '=' || event.key === '+' ? 1 : event.key === '-' || event.key === '_' ? -1 : event.key === '0' ? 0 : null;

    if (step !== null) {
      event.preventDefault();
      setTextScale(step === 0 ? 1 : stepScale(view.textScale, step));
    }
  });
  // Ctrl+B shows or hides the work items, Ctrl+Alt+B the Status and Artifacts column, as VS Code's side bars.
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    // Not while typing, where the browser or the operator may use the keys.
    const typing = target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

    if (event.ctrlKey && !event.shiftKey && !event.metaKey && !typing && event.key.toLowerCase() === 'b' && state.scope !== null) {
      event.preventDefault();
      toggleSide(event.altKey ? 'detail' : 'list');
    }
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (event.target as HTMLElement) !== input && state.voice?.here === true && state.voice.speaking !== null) {
      void command('stop-speaking');
    }
  });

  /** Answers a Codex request: a permission with its decision, questions with every answer given; the hub checks it is still pending. */
  const answerRequest = async (requestId: string, decision: string | null): Promise<void> => {
    const request = state.session?.requests?.find((one) => one.id === requestId);

    if (request === undefined || state.session === null) {
      return;
    }

    let answer: unknown = decision;

    if (decision === null) {
      const answers: Record<string, string> = {};

      for (const question of request.questions) {
        const value = view.requestValues.get(`${request.id}:${question.id}`)?.trim() ?? '';

        if (value === '') {
          showError(`Answer "${question.question}" first.`);
          return;
        }

        answers[question.id] = value;
      }

      answer = answers;
    }

    const reply = await command('answer', { sessionId: state.session.id, requestId, answer });

    if (reply.status !== 200) {
      showError(String(reply.body['error'] ?? 'Codex did not confirm the answer. Check its terminal.'));
    }
  };

  // ---- New conversation… (architecture.md § Web page) ----
  /** The dropdown's New conversation…: straight away with one provider installed, else the providers to pick from, the default first. */
  /** The conversation New conversation… was chosen in, whose folder the new one runs in; another selection since drops the choice. */
  let newFrom: { key: string | null; scopeGen: number; workItemId: number | null } | null = null;
  const newConversation = async (): Promise<void> => {
    view.picker = false;
    view.providers = { items: null, error: null };
    newFrom = { key: state.key, scopeGen: state.scope?.scopeGen ?? -1, workItemId: wanted };
    draw();

    const from = newFrom;
    const answer = await post('providers', {});
    const installed = (answer.body['installed'] as string[] | undefined) ?? [];
    const preferred = String(answer.body['defaultProvider'] ?? 'claude');

    if (view.providers === null || newFrom !== from || from.key !== state.key || from.scopeGen !== (state.scope?.scopeGen ?? -1)) {
      return;
    }

    if (answer.status !== 200 || installed.length === 0) {
      view.providers = { items: null, error: answer.status === 200 ? 'Neither Claude nor Codex is installed.' : String(answer.body['error'] ?? 'Switchboard did not answer.') };
    } else if (installed.length === 1) {
      view.providers = null;
      void createConversation(installed[0]!);
    } else {
      const names: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

      view.providers = { items: [...installed].sort((a, b) => Number(b === preferred) - Number(a === preferred)).map((provider) => ({ provider, name: names[provider] ?? provider, default: provider === preferred })), error: null };
    }

    draw();
    head.querySelector<HTMLElement>('.conversation-menu .menu-row')?.focus();
  };
  /** Makes the conversation in the shown conversation's folder, then opens it in the page. */
  const createConversation = async (provider: string): Promise<void> => {
    const from = newFrom;

    newFrom = null;
    draw();

    if (from === null || from.key !== state.key) {
      return;
    }

    // With the scope generation of the conversation it was chosen in, so the hub refuses it after another selection.
    const answer = await post('page-conversation', { scopeGen: from.scopeGen, provider });

    if (answer.status === 200 && typeof answer.body['workItemId'] === 'number') {
      showError(null);

      // Opened only while the operator is still on the conversation it was made from; the list shows it either way.
      if (wanted === from.workItemId && state.key === from.key) {
        void select(answer.body['workItemId']);
      }
    } else {
      showError(String(answer.body['error'] ?? 'The conversation was not made.'));
    }
  };

  // ---- Prompts in the terminal (architecture.md § Web page) ----
  /** Whether the session shown waits on a permission prompt or a question in its terminal, which the page reads from its screen. */
  const promptWanted = (): boolean => state.session !== null && state.session.state === 'waiting' && (state.session.waitingFor === 'question' || state.session.waitingFor === 'permission') && state.session.provider !== 'codex' && document.visibilityState !== 'hidden';
  let promptAsking = false;
  const readPrompt = async (): Promise<void> => {
    if (!promptWanted() || promptAsking || state.session === null) {
      if (!promptWanted() && view.prompt !== null && !view.prompt.sending) {
        view.prompt = null;
        draw();
      }

      return;
    }

    const sessionId = state.session.id;

    promptAsking = true;

    const answer = await command('prompt', { sessionId });

    promptAsking = false;

    if (state.session?.id !== sessionId) {
      return;
    }

    const prompt = answer.status === 200 ? ((answer.body['prompt'] as ScreenPrompt | null | undefined) ?? null) : null;

    if (JSON.stringify(prompt) !== JSON.stringify(view.prompt?.prompt ?? null) || view.prompt?.sessionId !== sessionId) {
      view.prompt = { sessionId, prompt, sending: view.prompt?.sending === true && view.prompt.sessionId === sessionId };
      draw();
    }
  };
  const promptTimer = setInterval(() => void readPrompt(), PROMPT_POLL_MS);
  /** Presses one key of the prompt shown; the hub checks again that the screen shows that prompt. */
  const pressPromptKey = async (key: string): Promise<void> => {
    const shown = view.prompt;

    if (shown?.prompt == null || shown.sending || state.session === null) {
      return;
    }

    shown.sending = true;
    draw();

    const answer = await command('prompt-key', { sessionId: state.session.id, launch: state.session.launch, prompt: shown.prompt.id, key });

    shown.sending = false;
    showError(answer.status === 200 ? null : String(answer.body['error'] ?? `The key was not sent (status ${answer.status}).`));
    draw();
    void readPrompt();
  };

  // ---- Resume (architecture.md § Web page) ----
  let resuming = false;
  const resume = async (): Promise<void> => {
    if (state.session === null || state.session.state !== 'ended' || resuming) {
      return;
    }

    resuming = true;
    draw();

    const answer = await command('resume', { sessionId: state.session.id });

    resuming = false;
    showError(answer.status === 200 ? null : String(answer.body['error'] ?? `The session did not resume (status ${answer.status}).`));
    draw();
  };

  // ---- Row actions (architecture.md § Web page) ----
  /** A control of the header's actions: Snooze… opens its choices, one that asks first its question, any other runs at once. */
  const chooseAction = (type: string): void => {
    const row = selectedRow(state);
    const action = row?.actions?.find((one) => one.action === type);

    view.actions = false;

    if (row === null || action === undefined || view.acting) {
      draw();
      return;
    }

    if (action.action === 'snooze') {
      view.sheet = { kind: 'snooze', workItemId: row.workItemId, title: row.title, choices: snoozeChoices(new Date(deps.now())), picked: '0', date: '', comment: '' };
    } else if (action.confirm !== null) {
      view.sheet = { kind: 'confirm', workItemId: row.workItemId, action };
    } else {
      void runAction(row.workItemId, action.action, {});
    }

    draw();
  };
  /** Runs a row action on the selected work item; the hub checks again that its row still offers it. */
  const runAction = async (workItemId: number, action: string, extra: Record<string, unknown>): Promise<void> => {
    view.acting = true;
    draw();

    const answer = await command('row-action', { workItemId, action, ...extra });

    view.acting = false;
    view.sheet = null;
    showError(answer.status === 200 ? null : String(answer.body['error'] ?? `Not done (status ${answer.status}).`));
    draw();
  };
  const sheetGo = async (): Promise<void> => {
    const sheet = view.sheet;

    if (sheet === null || view.acting) {
      return;
    }

    if (sheet.kind === 'confirm') {
      await runAction(sheet.workItemId, sheet.action.action, {});
    } else if (sheet.kind === 'snooze') {
      const picked = sheet.picked;
      const until = picked === 'date' ? snoozeDateUntil(sheet.date, sheet.choices) : (sheet.choices[Number(picked)]?.until ?? null);
      const first = firstSnoozeDay(sheet.choices);

      if (picked === 'date' && (until === null || first === null || sheet.date < first)) {
        sheetHost.querySelector<HTMLInputElement>('.snooze-date')?.focus();
        return;
      }

      const comment = sheet.comment.trim();

      await runAction(sheet.workItemId, 'snooze', { until, ...(comment === '' ? {} : { comment }) });
    } else {
      view.sheet = null;
      draw();
    }
  };
  /** Copy <draft>: the hub reads the drafted file as it is now; the clipboard takes it, or a sheet shows it to copy by hand. */
  const copyPaste = async (label: string): Promise<void> => {
    const row = selectedRow(state);

    view.actions = false;
    draw();

    if (row === null) {
      return;
    }

    const answer = await command('row-paste', { workItemId: row.workItemId, label });

    if (answer.status !== 200) {
      showError(String(answer.body['error'] ?? `${label} could not be read.`));
      return;
    }

    const text = String(answer.body['text'] ?? '');
    const copied = await (navigator.clipboard?.writeText(text).then(() => true, () => false) ?? Promise.resolve(false));

    if (!copied) {
      view.sheet = { kind: 'text', title: `Copy ${label}`, text };
      draw();
    } else {
      showError(null);
    }
  };

  // The Snooze sheet keeps what the operator chose in the view, so a redraw while it is open changes nothing of it.
  const keepSheet = (event: Event): void => {
    const field = event.target as HTMLInputElement | HTMLTextAreaElement;
    const sheet = view.sheet;

    if (sheet?.kind !== 'snooze') {
      return;
    }

    if (field.name === 'snooze') {
      sheet.picked = field.value;
    } else if (field.classList.contains('snooze-date')) {
      sheet.date = field.value;
      // Picking a date chooses On, as in the dock's dialog.
      sheet.picked = field.value === '' ? sheet.picked : 'date';
      draw();
    } else if (field.classList.contains('snooze-comment')) {
      sheet.comment = field.value;
    }
  };

  sheetHost.addEventListener('input', keepSheet);
  sheetHost.addEventListener('change', keepSheet);

  const earlier = async (): Promise<void> => {
    const oldest = state.items[0];

    if (state.session === null) {
      return;
    }

    const shown = `${state.key} ${state.scope?.scopeGen} ${state.session.id}`;
    const answer = await command('history', { sessionId: state.session.id, before: oldest?.id ?? null });

    // A page that moved on meanwhile never takes another conversation's history.
    if (answer.status === 200 && shown === `${state.key} ${state.scope?.scopeGen} ${state.session?.id}`) {
      state = withEarlier(state, answer.body['items'] as ItemView[], answer.body['more'] === true);
      draw();
    }
  };

  /** The header's persona button: the roster in a menu under the header, as the dropdown is, and pinning one to the session. */
  const choosePersona = async (): Promise<void> => {
    if (view.personas !== null) {
      view.personas = null;
      draw();
      return;
    }

    view.picker = false;
    view.personas = { items: null, error: null };
    draw();

    const shown = state.scope?.scopeGen;
    const answer = await command('personas');

    if (view.personas === null || shown !== state.scope?.scopeGen) {
      return;
    }

    view.personas = answer.status === 200 ? { items: (answer.body['personas'] as Array<{ id: string; name: string }> | undefined) ?? [], error: null } : { items: null, error: String(answer.body['error'] ?? 'Switchboard did not answer.') };

    if (view.personas.items?.length === 0) {
      view.personas = { items: null, error: 'No personas. Add them to voice.personas in settings.json, with voice.enabled on.' };
    }

    draw();
  };

  // ---- The stream ----
  const source = new deps.EventSource('/v1/conversation/events?page=1');

  for (const type of EVENTS) {
    source.addEventListener(type, (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { type: string } & Record<string, unknown>;
      const keyBefore = state.key;

      state = applyEvent(state, data);

      if (type === 'hello') {
        expired = false;

        // A new stream has a new key, unbound: the page selects its work item again.
        if (state.key !== keyBefore) {
          focusSent = null;
          reportFocus(true);
        }

        if (state.key !== keyBefore) {
          acked = null;
          selectInFlight = false;
        }

        reconcile();
      }

      // Dictation (architecture.md § Dictation): live words show dimmed after the box's text; the hub's draft fills the box unless the operator typed over it.
      if (type === 'words') {
        liveWords.textContent = String(data['text'] ?? '');
        liveWords.hidden = liveWords.textContent === '';
        showLive();
      } else if (type === 'draft' && typeof data['sessionId'] === 'string') {
        takeHubDraft(data['sessionId'], String(data['text'] ?? ''));
      }

      // A message this page sent that was not sent: a card's answer goes back to its card, any other text to its own work item's draft.
      if (type === 'message' && (data['message'] as { delivery?: string }).delivery === 'not-sent') {
        const message = data['message'] as Extract<ItemView, { type: 'message' }>;
        const error = message.error ?? 'Not sent.';
        const card = [...view.cards.values()].find((one) => one.sentId === message.id);

        if (card !== undefined) {
          card.sent = null;
          card.sentId = null;
          card.error = error;
        } else if (mine.delete(message.id) || data['giveBack'] === true) {
          giveBack(message.workItemId, message.text, error);
        } else {
          // Its send may not have answered yet.
          unsent.set(message.id, { text: message.text, error, workItemId: message.workItemId });

          for (const old of [...unsent.keys()].slice(0, -50)) {
            unsent.delete(old);
          }
        }
      }

      draw();

      if (type === 'session' || type === 'hello') {
        void readPrompt();
      }
    });
  }

  const lost = reconnector({ fetch: (url, init) => deps.fetch(url, init), setTimeout: (run, ms) => setTimeout(run, ms), reload: deps.reload ?? (() => location.reload()), build: deps.build ?? null });

  source.addEventListener('error', () => {
    state = { ...state, connected: false };
    lost(source);
    // A stream refused for its cookie does not come back: the page needs a new link.
    void deps.fetch('/v1/page/list', { credentials: 'same-origin' }).then((response) => {
      expired = response.status === 401;
      draw();
    }, () => draw());
  });

  draw();

  return {
    state: () => state,
    close: () => {
      clearInterval(seenTimer);
      clearInterval(promptTimer);
      listening.abort();
      listWidth?.disconnect();
      stopScrollbars();
      header.close();
      source.close();

      for (const mounted of consoles.values()) {
        mounted.dispose();
      }

      consoles.clear();
    },
  };
}

/** Loads the console's script and xterm.js's styles from the hub, the first time a console shows; null when the script cannot load. */
export function loadConsole(): Promise<ConsoleModule | null> {
  return new Promise((resolve) => {
    const styles = document.createElement('link');
    const script = document.createElement('script');

    styles.rel = 'stylesheet';
    styles.href = '/page/xterm.css';
    script.src = '/page/console.js';
    script.onload = () => resolve((globalThis as { switchboardConsole?: ConsoleModule }).switchboardConsole ?? null);
    script.onerror = () => resolve(null);
    document.head.append(styles, script);
  });
}

/** Loads Mermaid from the hub once, for diagrams in replies, statuses and artifacts; false when the hub has none. */
export function loadMermaid(): Promise<boolean> {
  return new Promise((resolve) => {
    const script = document.createElement('script');

    script.src = '/page/mermaid.min.js';
    script.onload = () => {
      const mermaid = (globalThis as { mermaid?: { initialize(options: object): void } }).mermaid;

      mermaid?.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
      resolve(mermaid !== undefined);
    };
    script.onerror = () => resolve(false);
    document.head.append(script);
  });
}

/**
 * A sash that sets a pane's width (architecture.md § Web page): dragged, or with Left and Right (`SASH_STEP`, four times that with Shift), Home
 * and End while it has the focus; the width goes into a CSS property on the root, kept in local storage under `key` and set before the page
 * is first drawn, so the page does not jump. A double-click returns to the default and forgets it.
 */
function resizer(root: HTMLElement, sash: HTMLElement, pane: HTMLElement, { property, key, min, max }: { property: string; key: string; min: number; max: number }): void {
  /** The width set, or null for the default. */
  let width: number | null = null;
  /** The pane's width as drawn, without its border, which the page's width can hold below the width set. */
  const drawn = (): number => pane.clientWidth || (width ?? pane.getBoundingClientRect().width);
  const set = (next: number | null, keep: boolean): void => {
    width = next === null ? null : Math.round(Math.min(max, Math.max(min, next)));

    if (width === null) {
      root.style.removeProperty(property);
      sash.removeAttribute('aria-valuenow');
    } else {
      root.style.setProperty(property, `${width}px`);
      sash.setAttribute('aria-valuenow', String(pane.clientWidth || width));
    }

    if (keep) {
      try {
        if (width === null) {
          localStorage.removeItem(key);
        } else {
          localStorage.setItem(key, String(width));
        }
      } catch {
        // A page without local storage keeps the width until it reloads.
      }
    }
  };

  set(((): number | null => {
    try {
      const kept = Number(localStorage.getItem(key));

      return Number.isFinite(kept) && kept > 0 ? kept : null;
    } catch {
      return null;
    }
  })(), false);
  sash.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    sash.focus({ preventScroll: true });
    sash.setPointerCapture?.(event.pointerId);
    sash.classList.add('dragging');
    root.classList.add('resizing');

    const left = pane.getBoundingClientRect().left;
    const move = (next: PointerEvent): void => set(next.clientX - left, false);
    const end = (): void => {
      sash.removeEventListener('pointermove', move);
      sash.removeEventListener('pointerup', end);
      sash.removeEventListener('pointercancel', end);
      sash.classList.remove('dragging');
      root.classList.remove('resizing');
      set(drawn(), true);
    };

    sash.addEventListener('pointermove', move);
    sash.addEventListener('pointerup', end);
    sash.addEventListener('pointercancel', end);
  });
  sash.addEventListener('dblclick', () => set(null, true));
  sash.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? SASH_STEP * 4 : SASH_STEP;
    const now = drawn();
    const next = { ArrowLeft: now - step, ArrowRight: now + step, Home: min, End: max }[event.key];

    if (next !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      set(next, true);
    }
  });
}
