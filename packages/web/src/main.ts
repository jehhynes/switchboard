import { applyEvent, commandQuery, EMPTY, mentionOf, mentionQuery, pageTitle, rowLink, selectedRow, sentTexts, tabUrl, withEarlier } from './model.js';
import { snoozeChoices } from '@switchboard/core/snooze';
import type { PageState } from './model.js';
import { MENU_MAX_WIDTH, placeMenus } from '@switchboard/conversation/menuPlace';
import { escape, renderMarkdown, webLink } from './markdown.js';
import { ARTIFACTS_SEEN, artifactShow, artifactTabsFit, artifactUrl, openArtifactsSeen, parseArtifactsSeen, unreadArtifacts, textArtifactHtml, bandOpen, browserNote, BROWSER_MIN_WIDTH, closedArtifacts, paneLink, collapsedGroups, firstSnoozeDay, GROUPS_KEY, inputReady, renderMicButton, markdownBody, newView, rowKey, renderVoice, snoozeDateUntil, TABS, consoleNote, hasConsole, SIDE_TABS } from './render.js';
import type { CardDraft, PaneView, SideTab, Tab, View } from './render.js';
import type { ConsoleOptions, MountedConsole } from './console.js';
import { LIGHT_SCHEME } from './console.js';
import type { ArtifactView, ItemView, PageRow, ScreenPrompt } from '@switchboard/protocol';
import { mount, unmount } from './island.js';
import type { ComponentChild, VNode } from 'preact';
import { renderList, renderListPane } from './list.js';
import { rowDrag } from './reorder.js';
import type { DragView } from './reorder.js';
import { menuRows, renderHeader, renderMaximize, renderSideSwitch, renderTabs } from './header.js';
import { CHAT_MIN, chatNeed, fitLayout, isPhone, sideLimit, sideWidth, type Layout } from './layout.js';
import { pageLedger, renderTimeline } from './timeline.js';
import { cardSteps, currentStep, draftAnswers, moveStep, pickLetter, setOther } from '@switchboard/conversation/questions';
import type { CardDraft as SharedDraft, LedgerCard } from '@switchboard/conversation/questions';
import { cardKeyAction, isAnswerMessage, questionsWaiting } from '@switchboard/conversation/questionCard';
import { renderArtifacts, renderArtifactView, renderEmpty, renderStatus } from './side.js';
import { renderPersonaDialog } from './personas.js';
import { renderSheet } from './sheet.js';
import { renderComposer, renderComposerMenu, renderEndedNote, renderFrame, renderShared } from './composer.js';
import { listHeader } from './listHeader.js';
import { PhoneVoice } from './phoneVoice.js';
import { MicStart } from '@switchboard/conversation/voiceControls';
import { browserBackPreview, swipeBack } from './swipeBack.js';
import { settings } from './settings.js';
import { attachments, drawChips } from './attachments.js';
import type { Attached } from './attachments.js';
import { reconnector } from './reconnect.js';
import { renderContextMeter } from '@switchboard/conversation/contextMeter';
import type { ContextMenuState } from '@switchboard/conversation/contextMeter';
import { EMPTY_HISTORY_UI, renderHistory } from './history.js';
import type { HistoryOpen, HistoryUi } from './history.js';
import type { HistoryCategory, HistoryView } from '@switchboard/protocol';
import { askForNotifications, notificationsAllowed, notifyNeeds, playChime } from './alerts.js';
import { ChangesController, changesTab } from './changes.js';
import { LocalFilesController, localTabs } from './localFiles.js';
import type { DiffModule } from './diff/types.js';
import { useFileIcons } from './fileIcons.js';
import type { NeedsItem } from './alerts.js';

/** The stream's event types the page reads. */
/** How long after a single-choice pick the card moves to the next question (design open choice 4). */
export const ADVANCE_MS = 200;
/** How long typing in a card's Other field pauses before the hub hears it. */
export const OTHER_SETTLE_MS = 400;

export const EVENTS = ['tabs', 'hello', 'list', 'scope', 'conversations', 'session', 'message', 'reply', 'status', 'artifact', 'unread', 'voice', 'settings', 'progress', 'words', 'draft', 'questions', 'pane', 'needs', 'show', 'config', 'viewed'];
/** How long the page's title holds the marker the dock finds its window by after a `show` (architecture.md § Dock). */
export const SHOW_MARKER_MS = 5_000;
/** How often the page wakes the Chrome extension while the Chrome pane is on and no extension is connected. */
export const PANE_WAKE_MS = 30_000;
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
/** The conversation's sash sets it from `CHAT_MIN` (layout.ts) up; a narrower width lets the list and the column fit a narrower page. */
export { CHAT_MIN };
export const CHAT_MAX = 1600;
const SASH_STEP = 16;
/** How far right a touch from the page's left edge must move, more across than down, to show the drawer. */
export const SWIPE_OPEN = 40;
const SIDE_WIDTH = 'switchboard.sideWidth';
/** Where this device keeps the list unpinned, in the drawer: '1', under the key an earlier page kept the list hidden by its sash. */
const LIST_UNPINNED = 'switchboard.listCollapsed';
/** Where the page keeps Show message details. */
const DETAILS = 'switchboard.messageDetails';
/** A paired device's own Expand replies, '1' or '0'; this computer's page keeps it in settings.json instead. */
const EXPAND = 'switchboard.expandReplies';
/** Where an earlier page kept the conversation's text size, which is now fixed; removed on load. */
const OLD_TEXT_SCALE = 'switchboard.textScale';
const CHAT_WIDTH = 'switchboard.chatWidth';
/**
 * The drawer's timing, as the dock's auto-hide: a pointer resting on the sliver this long shows it, and a drawer shown that way hides once
 * nothing has kept it open for `DRAWER_HIDE_MS`, checked every `DRAWER_TICK_MS`.
 */
export const DRAWER_REVEAL_MS = 500;
export const DRAWER_HIDE_MS = 400;
const DRAWER_TICK_MS = 100;
/** How often an open History reads the hub again, so its times stay current, and how soon after a list change. */
export const HISTORY_REFRESH_MS = 30_000;
/** How long the Chrome pane stays hidden after the page's last floating layer closes, so a quick close and open does not flicker it. */
export const PANE_SHOW_DELAY_MS = 100;
const HISTORY_CHANGE_MS = 1_000;
/** The mark on the history entry a phone's conversation adds over the list, so the browser's back returns to the list (architecture.md § Web page). */
const CONVERSATION_ENTRY = 'switchboardConversation';
/** Where the page keeps each work item's draft, over a reload. */
const DRAFTS = 'switchboard.drafts';

export interface PageDeps {
  fetch: typeof fetch;
  EventSource: new (url: string) => EventSource;
  now(): number;
  /** Loads Mermaid's script on first use; resolves false when the hub has none. */
  loadMermaid?(): Promise<boolean>;
  /** Loads the console's script and styles on first use; resolves null when they cannot load. */
  loadConsole?(): Promise<ConsoleModule | null>;
  /** Loads the diff viewer's modules on first use; resolves null when they cannot load. */
  loadDiff?(): Promise<DiffModule | null>;
  /** The build of the hub that served the page, from its `switchboard-build` meta tag, and how to reload, for a hub that restarts. */
  build?: string | null;
  reload?(): void;
  /** Opens a link in a new browser tab; `window.open` without an opener or referrer when left out. */
  openUrl?(url: string): void;
  /** Whether the page is this computer's, which may pair devices; read from the address's host name when left out. */
  local?: boolean;
  /** Whether the page runs as the installed app, whose links the hub opens in the default browser; read from `display-mode` when left out. */
  standalone?(): boolean;
  /**
   * Sends a message to the Chrome extension with that ID (`chrome.runtime.sendMessage`, which `externally_connectable` allows); resolves its
   * answer, or null when the browser has no such extension. Read from `chrome.runtime` when left out.
   */
  toExtension?(extensionId: string, message: Record<string, unknown>): Promise<unknown>;
  /** Runs a draw before the next repaint; `requestAnimationFrame` when left out. */
  frame?(run: () => void): void;
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
  // A root that held a page before starts empty.
  unmount(root);
  root.replaceChildren();
  mount(root, renderFrame({ min: SIDE_MIN, max: SIDE_MAX }, { min: CHAT_MIN, max: CHAT_MAX }));

  const list = root.querySelector<HTMLElement>('#list')!;
  const head = root.querySelector<HTMLElement>('#head')!;
  const panel = root.querySelector<HTMLElement>('#panel')!;
  const composerHost = root.querySelector<HTMLElement>('#composer')!;
  const note = root.querySelector<HTMLElement>('#note')!;
  const sheetHost = root.querySelector<HTMLElement>('#sheet')!;
  // The persona dialog over the whole page, as Settings is.
  const personaHost = root.appendChild(document.createElement('div'));
  let personaCovers = false;
  // The scope generation the persona dialog opened for, and each opening's number, so a late roster answer fills only the dialog that asked.
  let personaScope: number | null = null;
  let personaAsks = 0;
  const detailHead = root.querySelector<HTMLElement>('#detail .detail-head')!;
  const detailBody = root.querySelector<HTMLElement>('#detail .detail-body')!;
  const historyHost = root.querySelector<HTMLElement>('#history')!;
  // The open work item takes the room first (layout.ts): the list is a column while the operator keeps it pinned, and a drawer otherwise;
  // Status and Artifacts are a column only while they and the conversation fit, and tabs otherwise. A layout choice an earlier page kept is
  // dropped.
  localStorage.removeItem('switchboard.layout');
  let layout: Layout | null = null;
  const wide = (): boolean => layout?.wide === true;
  // The installed page, as Chrome opens it from its own window; only it reports a column for the Chrome pane (architecture.md § Web page).
  const standalone = (): boolean => deps.standalone?.() ?? (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);

  // The work items' and the conversation's widths (architecture.md § Web page), each set on a sash: the work items' on their edge, or on the
  // open drawer's, the conversation's between it and the Status and Artifacts column, which takes the rest of the width. A drag only sets a
  // width: the list's sash stops where the conversation, and the column while it shows, keep what they need, and only the list's pin button
  // makes it a drawer.
  let listPinned = ((): boolean => {
    try {
      return localStorage.getItem(LIST_UNPINNED) !== '1';
    } catch {
      return true;
    }
  })();
  /** Pins the list as a column, or unpins it into the drawer, keeping the choice on this device; the focus stays on the pin, or goes to the button that shows a list it hid. */
  const pinList = (pin: boolean): void => {
    listPinned = pin;

    try {
      if (pin) {
        localStorage.removeItem(LIST_UNPINNED);
      } else {
        localStorage.setItem(LIST_UNPINNED, '1');
      }
    } catch {
      // A page without local storage keeps the choice until it reloads.
    }

    relayout();
    draw();

    if (drawerMode() && view.drawer === null) {
      head.querySelector<HTMLElement>('.list-toggle')?.focus();
    } else {
      root.querySelector<HTMLElement>('.side-head .list-pin')?.focus();
    }
  };
  /**
   * Whether the Status and Artifacts column covers the whole page, list and conversation too, for a wide artifact or diff; until restored,
   * the column folds into tabs or the page reloads. Kept nowhere.
   */
  let panelMaximized = false;
  /** Maximizes the column or restores it, the focus staying on the button, which the draw moves with the strip. */
  const maximizePanel = (on: boolean): void => {
    panelMaximized = on && wide();
    root.classList.toggle('maximized', panelMaximized);
    draw();
    detailHead.querySelector<HTMLElement>('.panel-max')?.focus();
  };
  const sideSash = resizer(root, [root.querySelector<HTMLElement>('.side-sash')!, root.querySelector<HTMLElement>('.drawer-sash')!], root.querySelector<HTMLElement>('.side')!, {
    property: '--side-width',
    key: SIDE_WIDTH,
    min: SIDE_MIN,
    max: SIDE_MAX,
    limit: () => (layout?.list === true ? sideLimit(window.innerWidth, wide(), chatNeed(chatSash.width())) : SIDE_MAX),
    changed: () => {
      if (relayout()) {
        draw();
      }
    },
  });
  // The conversation's width counts in the layout too (chatNeed): narrowed, it can bring the column back.
  const chatSash = resizer(root, root.querySelector<HTMLElement>('.chat-sash')!, root.querySelector<HTMLElement>('.main')!, {
    property: '--chat-width',
    key: CHAT_WIDTH,
    min: CHAT_MIN,
    max: CHAT_MAX,
    changed: () => {
      if (relayout()) {
        draw();
      }
    },
  });
  /** Whether the last layout was the phone's (`isPhone`), which the document's `phone` class gives page.css and settings.css. */
  let phone = false;
  /**
   * Works out the columns again from the phone's layout, the page's width, the list's and the conversation's kept widths and the list's pin,
   * and sets the classes; true when they changed.
   */
  const relayout = (): boolean => {
    const nextPhone = isPhone();
    const next = fitLayout(window.innerWidth, sideWidth(sideSash.width(), window.innerWidth), layout, chatNeed(chatSash.width()), listPinned, nextPhone);
    const changed = layout === null || next.list !== layout.list || next.wide !== layout.wide || nextPhone !== phone;

    layout = next;
    phone = nextPhone;
    document.documentElement.classList.toggle('phone', phone);
    // Outside the phone's layout, an unpinned list is a drawer (page.css), shown only with a work item open.
    root.classList.toggle('drawers', !phone && !next.list);

    // The Status and Artifacts column is maximized only while it is a column.
    panelMaximized &&= next.wide;
    root.classList.toggle('maximized', panelMaximized);

    return changed;
  };

  relayout();
  /** Whether the Browser tab shows: on the installed page while the Chrome pane is on (PRD R113). */
  /** Whether this page can drive the browser pane: only a page on this computer posts its area (`pane-rect` is a local command). */
  const paneLocal = (): boolean => deps.local ?? ['127.0.0.1', 'localhost'].includes(location.hostname);
  const browserTab = (): boolean => view.pane?.enabled === true && standalone() && paneLocal();
  /** Whether this page's browser pane is paired and running, so it shows the links and the list's pills are labels. */
  const paneWorks = (): boolean => browserTab() && view.pane?.extension === 'paired' && view.pane.error === null;
  /** The work item whose conversation's web links this page opened in the Chrome pane (`pane-open`), which then has links to show too. */
  let paneOpened: number | null = null;
  /** Whether the open work item has links the Chrome pane can show: its own, or a web link of its conversation opened there. */
  const itemLinks = (): boolean => {
    const row = selectedRow(state);

    return (row !== null && (paneLink(row.url) || row.links.some((link) => paneLink(link.url)))) || (paneOpened !== null && paneOpened === state.scope?.workItemId);
  };
  /** Whether the Browser tab shows: the pane on for this page, and links of the open work item to show; the operator's Status or Browser choice stays. */
  const showBrowser = (): boolean => browserTab() && itemLinks();
  /** Whether the Console tab shows: an active session, not ended, that the terminal holder may hold; otherwise its console would be blank, so there is no tab. */
  const showConsole = (): boolean => hasConsole(state.session);
  /** The tab the conversation's pane shows: always the conversation while Status and Artifacts have their own column, and never a Browser tab that is gone. */
  const mainTab = (): Tab => (wide() || (view.tab === 'browser' && !showBrowser()) || (view.tab === 'artifacts' && openArtifact() === null) || (view.tab === 'diff' && !changes.view.tab) || (view.tab === 'file' && localFiles.shown() === null) ? 'conversation' : view.tab === 'console' && !showConsole() ? 'status' : view.tab);
  /** The work item whose tabs were last chosen on its opening, and whether the operator has chosen a tab since. */
  let openedItem: number | null = null;
  let tabChosen = false;
  /** Whether the opening tabs were chosen knowing the pane's state; until then the pane's first event chooses them again. */
  let paneKnown = false;
  /**
   * The tabs a work item opens on: Browser when it has no session yet, as an unstarted one or a pool ticket, and links the paired Chrome pane can
   * show, since its ticket is all there is to see; otherwise Status in the column and the conversation on a narrower page. Nothing is kept from
   * the work item before; within one, the operator's choice stays.
   */
  /** The open work item's tabs as the hub keeps them for every device (`page-tabs`), or null before any was chosen. */
  let savedTabs: { workItemId: number; tab: string | null; closed: Array<{ path: string; updatedAt: number }> } | null = null;
  /** Which artifacts this device has opened (`ArtifactsSeen`), read again when another of its pages keeps a change. */
  const readArtifactsSeen = (): ReturnType<typeof parseArtifactsSeen> | null => {
    try {
      return parseArtifactsSeen(localStorage.getItem(ARTIFACTS_SEEN));
    } catch {
      // Without local storage the page keeps them for itself.
      return null;
    }
  };
  let artifactsSeen = readArtifactsSeen() ?? {};
  /**
   * Keeps artifacts of the open work item opened on this device, added to what its other pages kept since, so two pages opening different ones
   * keep both.
   */
  const artifactsOpened = (paths: readonly string[]): void => {
    const workItemId = state.scope?.workItemId;

    if (workItemId == null) {
      return;
    }

    const kept = readArtifactsSeen() ?? artifactsSeen;
    const next = openArtifactsSeen(kept, workItemId, paths);

    artifactsSeen = next ?? kept;

    if (next !== null) {
      try {
        localStorage.setItem(ARTIFACTS_SEEN, JSON.stringify(next));
      } catch {
        // Kept for this page only.
      }
    }
  };
  /** The artifacts whose tabs are closed for the open work item. */
  const closedNow = (): Set<string> => closedArtifacts(state.artifacts, savedTabs?.workItemId === state.scope?.workItemId ? (savedTabs?.closed ?? []) : []);
  /** Whether a work item opens on Browser: no session yet, as an unstarted one or a pool ticket, and links the paired Chrome pane can show. */
  /** Whether the Browser tab has something to show: the paired Chrome pane, and links of the work item it can open. */
  const browserUseful = (): boolean => {
    const row = selectedRow(state);

    return browserTab() && view.pane?.extension === 'paired' && row !== null && itemLinks();
  };
  const browserFirst = (): boolean => browserUseful() && state.session === null;
  /** The tab every work item opens on, Status or Browser, as the operator last chose it on any device; null before any choice. */
  let openOn: 'status' | 'browser' | null = null;
  /**
   * The tabs a work item opens on: Console or an artifact kept for it while it still applies; otherwise Browser when the paired pane has links of
   * the work item to show and the operator last chose Browser, or the work item has no status report yet, or before any choice when it also has no
   * session yet; otherwise Status. That is the column's tab; where the column folds into the conversation's tabs, the work item opens on the
   * Conversation tab.
   */
  const openTabs = (): void => {
    const saved = savedTabs?.workItemId === state.scope?.workItemId ? savedTabs?.tab : null;
    const path = saved?.startsWith('artifact:') === true ? saved.slice('artifact:'.length) : null;
    const kept: Tab | null = saved === 'console' && showConsole() ? 'console' : path !== null && state.artifacts.some((one) => one.path === path) && !closedNow().has(path) ? 'artifacts' : null;
    // A work item with no status report yet, its stage at most on Status, opens on Browser whatever was chosen before.
    const reported = state.status !== null && !state.status.fallback;
    const browser = openOn === 'browser' || !reported ? browserUseful() : openOn === null && browserFirst();
    const chosen: Tab = kept ?? (browser ? 'browser' : 'status');

    view.side = chosen as SideTab;
    view.tab = !wide() || chosen === 'status' ? 'conversation' : chosen;
    view.artifact = chosen === 'artifacts' ? path : null;
    paneKnown = view.pane !== null || !paneLocal();
  };
  /**
   * Keeps the operator's choice in the hub, for every device: Status or Browser as the tab every work item opens on, and Console or an artifact for
   * the open work item.
   */
  const saveTab = (): void => {
    const workItemId = state.scope?.workItemId ?? null;
    const shown = wide() ? sideTab() : mainTab();

    // The Changes tab or a file tab lasts as long as the page shows the work item, so it is not kept.
    if (workItemId === null || shown === 'conversation' || shown === 'diff' || shown === 'file') {
      return;
    }

    if (shown === 'status' || shown === 'browser') {
      openOn = shown;
      savedTabs = { workItemId, tab: null, closed: savedTabs?.workItemId === workItemId ? savedTabs.closed : [] };
      void post('page-tabs', { workItemId, tab: null, openOn: shown });
      return;
    }

    const tab = shown === 'artifacts' ? `artifact:${openArtifact() ?? ''}` : shown;

    savedTabs = { workItemId, tab, closed: savedTabs?.workItemId === workItemId ? savedTabs.closed : [] };
    void post('page-tabs', { workItemId, tab });
  };
  /** Closes or opens again an artifact's tab for the open work item, in the hub, for every device. */
  const setClosed = (path: string, closed: boolean): void => {
    const workItemId = state.scope?.workItemId ?? null;
    const artifact = state.artifacts.find((one) => one.path === path);

    if (workItemId === null || artifact === undefined) {
      return;
    }

    const kept = (savedTabs?.workItemId === workItemId ? savedTabs.closed : []).filter((one) => one.path !== path);
    const next = closed ? [...kept, { path, updatedAt: artifact.updatedAt }] : kept;

    savedTabs = { workItemId, tab: savedTabs?.workItemId === workItemId ? savedTabs.tab : null, closed: next };
    // One artifact at a time, so two devices closing different tabs do not overwrite each other.
    void post('page-tabs', closed ? { workItemId, close: { path, updatedAt: artifact.updatedAt } } : { workItemId, reopen: path });
  };
  /** What the column right of the conversation shows: Status in place of a Browser tab that is gone. */
  const sideTab = (): SideTab => ((view.side === 'browser' && !showBrowser()) || (view.side === 'console' && !showConsole()) || (view.side === 'artifacts' && openArtifact() === null) || (view.side === 'diff' && !changes.view.tab) || (view.side === 'file' && localFiles.shown() === null) ? 'status' : view.side);
  /** The artifact whose tab is chosen, while the work item still has it; artifacts have no list of their own, only a tab each and a menu. */
  function openArtifact(): string | null {
    return view.artifact !== null && state.artifacts.some((one) => one.path === view.artifact) ? view.artifact : null;
  }
  /**
   * Chooses a tab of the column or of the conversation. Browser is one choice in both layouts, so a page that crosses the wide breakpoint keeps
   * the Chrome pane; another tab chosen in one layout leaves Browser in the other.
   */
  const chooseTab = (tab: Tab): void => {
    tabChosen = true;
    // The pane follows the tab: its state is sent again, whatever was sent before.
    forcePane = true;

    if (tab === 'browser') {
      view.side = 'browser';
      view.tab = 'browser';
    } else if (wide()) {
      view.side = tab === 'conversation' ? view.side : tab;
      view.tab = view.tab === 'browser' ? 'conversation' : view.tab;
    } else {
      view.tab = tab;
      // A tab of the column chosen here is the column's choice too; Conversation leaves the column's choice, but Browser.
      view.side = tab !== 'conversation' ? tab : view.side === 'browser' ? 'status' : view.side;
    }
  };
  /**
   * Shows what an answer links to, a card or the message that answered it (PRD R103): on the tab that holds it when no tab shown does, scrolled
   * into view and flashed for a moment.
   */
  const showLinked = (tab: Tab, find: () => HTMLElement | null): void => {
    if (find() === null) {
      leaving(tab);
      chooseTab(tab);
      view.artifact = null;
      draw();
      saveTab();
    }

    const target = find();

    if (target !== null) {
      target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      flash(target);
    }
  };
  /** Whether a web link can open in the Chrome pane: it runs for this computer's installed page, paired and not stopped. */
  const paneReady = (): boolean => {
    // The Browser tab's area must be wide enough for the pane, or the link would wait unseen; it opens in a new browser tab instead.
    const area = (wide() ? detailBody : panel).getBoundingClientRect().width;

    return paneWorks() && state.scope !== null && state.key !== null && area >= BROWSER_MIN_WIDTH;
  };
  /**
   * Opens a web link of the conversation in the Chrome pane (`pane-open`, architecture.md § Pane state) and shows the Browser tab, where the
   * pane's window lies; the link opens in a new browser tab instead when the hub refuses it.
   */
  const openInPane = (url: string): void => {
    const workItemId = state.scope?.workItemId ?? null;

    paneOpened = workItemId;
    leaving('browser');
    chooseTab('browser');
    draw();
    saveTab();
    void post('pane-open', { url }).then((answer) => {
      if (answer.status !== 200) {
        paneOpened = null;
        (deps.openUrl ?? ((one: string) => void window.open(one, '_blank', 'noopener,noreferrer')))(url);
        draw();
      }
    });
  };
  /** Reports the Browser tab's area to the hub after each draw, once the pane's report is set up below; sent again after a tab change. */
  let reportBrowser = (): void => {};
  /** Whether the pane is hidden for a floating layer of the page, set up with the pane's report below. */
  let paneHidden = (): boolean => false;
  let forcePane = false;

  let state: PageState = EMPTY;
  const view: View = newView();
  // The Changes list, its menu and the session state it was last drawn at, so a turn's end reads it again (architecture.md § Web page).
  const changes = new ChangesController({
    fetch: (...args) => deps.fetch(...args),
    key: () => state.key,
    draw: () => draw(),
    showDiff: () => {
      leaving('diff');
      chooseTab('diff');
      draw();
    },
    loadDiff: () => deps.loadDiff?.() ?? Promise.resolve(null),
    takePane: (pane) => takePane(pane),
    command: (name, body) => command(name, body),
    workItemId: () => state.scope?.workItemId ?? null,
    diffSettings: () => ({ layout: state.diffLayout, wrap: state.diffWrap }),
  });
  let changesSession: string | null = null;
  // Local file links' tabs (architecture.md § Web page); the hub decides what a paired device may read (architecture.md § Remote access).
  const localFiles = new LocalFilesController({
    fetch: (...args) => deps.fetch(...args),
    key: () => state.key,
    draw: () => draw(),
    show: () => {
      leaving('file');
      chooseTab('file');
      draw();
    },
    closed: () => {
      chooseTab(wide() ? 'status' : 'conversation');
      draw();
    },
    loadDiff: () => deps.loadDiff?.() ?? Promise.resolve(null),
    takePane: (pane) => takePane(pane),
    drawPane: (pane, tree) => drawPane(pane, tree),
    drawDiagrams: (pane) => drawDiagrams(pane),
  });
  // File type icons, whose mapping loads the first time a list draws one (architecture.md § Web page).
  const dropFileIcons = useFileIcons({ fetch: (...args) => deps.fetch(...args), loaded: () => draw() });

  // The groups the operator opened or closed on an earlier load, as the dock keeps them across runs.
  view.collapsed = collapsedGroups(localStorage.getItem(GROUPS_KEY));

  try {
    view.details = localStorage.getItem(DETAILS) === '1';
    localStorage.removeItem(OLD_TEXT_SCALE);
  } catch {
    // Off without local storage.
  }

  /** A select refused while no conversation was shown, or a refused drag of a row, which the list shows until the next select. */
  let listError: string | null = null;
  /** A drag of a Ready for review row under way (reorder.ts), which the list draws. */
  let dragView: DragView | null = null;
  let wanted: number | null = Number(/^#w=(\d+)$/.exec(location.hash)?.[1] ?? NaN) || null;

  // A reload keeps the entry's mark, but the list's entry before it belonged to the page before the reload; Back then stays in this page.
  if (conversationEntry(history.state)) {
    history.replaceState(null, '');
  }
  /** The marker of the dock's latest `show`, in the title until the dock has found this window. */
  let showMarker: string | null = null;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let opId = 0;
  const newOp = (): string => `${deps.now().toString(36)}-${(++opId).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const post = async (name: string, body: Record<string, unknown>, keepalive = false): Promise<Answer> => {
    try {
      const response = await deps.fetch(`/v1/conversation/${name}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ window: state.key, opId: newOp(), ...body }), ...(keepalive ? { keepalive } : {}) });

      expired ||= response.status === 401;
      return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
    } catch (error) {
      return { status: 0, body: { error: `Switchboard did not answer: ${String(error)}` } };
    }
  };
  // The list's header: the dock header's source icons, search and More Actions (architecture.md § Web page).
  // Settings over the whole page, as the dock's Settings window (architecture.md § Web page); it reads settings.json again when the page comes back.
  const settingsHost = root.appendChild(document.createElement('div'));
  const settingsPane = settings(settingsHost, { post: (name, body) => post(name, body), closed: () => root.querySelector<HTMLElement>('.more-actions')?.focus() });

  window.addEventListener('focus', () => void settingsPane.reload());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void settingsPane.reload());
  const local = deps.local ?? ['127.0.0.1', 'localhost'].includes(location.hostname);


  // A paired device may not change settings.json (architecture.md § Remote access), so its Expand replies is its own, following
  // voice.expandReplies until it is first toggled there.
  if (!local) {
    try {
      const kept = localStorage.getItem(EXPAND);

      view.expandReplies = kept === '1' ? true : kept === '0' ? false : null;
    } catch {
      // Follows voice.expandReplies without local storage.
    }
  }
  /**
   * The value Expand replies was last clicked to, until the hub's `settings` event or a refusal, so a quick second click reverses the
   * first, and the value of the save in flight; saves go one at a time, so a later click's value is the one the file keeps.
   */
  let expandAsked: boolean | null = null;
  let expandSending: boolean | null = null;
  const sendExpand = async (): Promise<void> => {
    let on = expandAsked!;

    for (;;) {
      expandSending = on;
      const answer = await post('expand-replies', { on });

      expandSending = null;

      if (answer.status !== 200) {
        expandAsked = expandAsked === on ? null : expandAsked;
        showError(String(answer.body['error'] ?? `Expand replies did not change (status ${answer.status}).`));
      }

      if (expandAsked === null || expandAsked === on) {
        return;
      }

      on = expandAsked;
    }
  };
  // Each Mic on tap on a paired device and each leaving of the conversation is counted, so a mic still opening when the page left is not turned
  // on, and a late answer to an older tap leaves a newer tap's mic alone.
  let micTaps = 0;
  let micLeaves = 0;
  let micOpening = false;
  // The mic button shows starting from a Mic on tap until the voice view confirms it, and the tap's error if it failed.
  const micStart = new MicStart(() => draw());
  let micScope: number | null | undefined;
  // A Mic on tap's steps, as milliseconds from the tap, sent to the hub log once its start ends (architecture.md § Dictation).
  let micTiming: { at: number; steps: Array<{ step: string; ms: number }> } | null = null;
  const micStep = (step: string, at = deps.now()): void => {
    if (micTiming !== null && micTiming.steps.length < 11) {
      micTiming.steps.push({ step, ms: Math.max(0, Math.round(at - micTiming.at)) });
    }
  };
  const micTimed = (outcome: string): void => {
    const timing = micTiming;

    micTiming = null;

    if (timing !== null) {
      void post('mic-timing', { steps: timing.steps, outcome });
    }
  };
  // Voice on this phone, on a paired device's page (architecture.md § Remote access).
  const phoneVoice = local
    ? null
    : new PhoneVoice({ key: () => state.key, post: (name, body) => post(name, body), fetch: (url) => deps.fetch(url, { credentials: 'same-origin' }).then((response) => response.arrayBuffer?.()), changed: () => draw(), now: () => deps.now() });
  const header = listHeader(root.querySelector<HTMLElement>('.side-head')!, list, root.querySelector<HTMLElement>('#list-sheet')!, {
    post: (name, body) => post(name, body),
    redraw: () => draw(),
    select: (workItemId) => void select(workItemId),
    now: () => deps.now(),
    local,
    openSettings: () => settingsPane.open(),
    reload: () => (deps.reload ?? (() => location.reload()))(),
    // The pin shows only where it changes the list: with no work item open, or while History shows, the list is a column either way.
    pinned: () => (pinWorks() ? listPinned : undefined),
    ...(phoneVoice === null ? {} : { phoneVoice: { state: () => phoneVoice.state, error: () => phoneVoice.error, toggle: () => (phoneVoice.state === 'off' ? phoneVoice.start() : phoneVoice.stop()) } }),
  });
  /** A command for the conversation the page shows, refused by the hub when the page has moved on since. */
  const command = (name: string, body: Record<string, unknown> = {}): Promise<Answer> => post(name, { scopeGen: state.scope?.scopeGen ?? -1, ...body });

  // ---- The composer ----
  mount(composerHost, renderComposer());

  const input = composerHost.querySelector('textarea')!;
  const send = composerHost.querySelector<HTMLButtonElement>('button.send')!;
  const errorBox = composerHost.querySelector<HTMLElement>('.composer-error')!;
  const menu = composerHost.querySelector<HTMLElement>('.composer-menu')!;
  const voiceControls = composerHost.querySelector<HTMLElement>('.voice-controls')!;
  const micSlot = composerHost.querySelector<HTMLElement>('.composer-mic')!;
  const contextSlot = composerHost.querySelector<HTMLElement>('.context-meter')!;
  const liveWords = composerHost.querySelector<HTMLElement>('.live-words')!;
  const mirror = composerHost.querySelector<HTMLElement>('.live-mirror')!;
  const mirrorText = composerHost.querySelector<HTMLElement>('.mirror-text')!;
  const attachButton = composerHost.querySelector<HTMLButtonElement>('button.attach')!;
  const attachInput = composerHost.querySelector<HTMLInputElement>('input.attach-input')!;
  const chips = composerHost.querySelector<HTMLElement>('.attachments')!;
  // Document listeners end with the page.
  const listening = new AbortController();
  // A drag of a Ready for review row moves it, as the dock's (PRD R73); its drop line redraws before the next repaint.
  const reorder = rowDrag(list, {
    changed: (drag) => {
      dragView = drag;
      drawSoon();
    },
    drop: (workItemId, after) => void moveRow(workItemId, after),
    signal: listening.signal,
  });

  // Another of this device's pages opened an artifact.
  window.addEventListener(
    'storage',
    (event) => {
      if (event.key === ARTIFACTS_SEEN) {
        artifactsSeen = readArtifactsSeen() ?? artifactsSeen;
        draw();
      }
    },
    { signal: listening.signal },
  );
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
  const attachedFiles = attachments({
    fetch: (...args) => deps.fetch(...args),
    shown: () => draftOf,
    refused: (workItemId, error) => (workItemId === draftOf ? showError(error) : void errors.set(workItemId, error)),
    changed: () => {
      drawAttachments();
      refresh();
    },
    expired: () => void (expired = true),
  });
  const shownAttachments = (): Attached[] => (draftOf === null ? [] : attachedFiles.of(draftOf));
  const uploading = (): boolean => shownAttachments().some((one) => one.path === null);
  /** A chip's remove button drops its file and ends its upload. */
  const removeAttachment = (id: number): void => {
    if (draftOf === null || !attachedFiles.remove(draftOf, id)) {
      return;
    }

    drawAttachments();
    refresh();
    input.focus();
  };
  const drawAttachments = (): void => drawChips(chips, shownAttachments(), removeAttachment);
  /** Whether the composer takes files now: a conversation shown whose session can take a message. */
  const canAttach = (): boolean => draftOf !== null && state.key !== null && state.scope !== null && state.connected && state.session?.conversation === 'full';
  /** Attaches files picked, pasted or dropped to the shown work item. */
  const attachFiles = (files: readonly File[]): void => {
    if (!canAttach() || files.length === 0) {
      return;
    }

    const refused = attachedFiles.add(draftOf!, state.key!, state.scope!.scopeGen, files);

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
    mount(menu, null);
  };
  const drawMenu = (): void => {
    if (menuOpen === null) {
      closeMenu();
      return;
    }

    mount(menu, renderComposerMenu(menuOpen, active));
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

    toEnd();

    // Sending hands the box back to the voice, so dictation resumes, as in the Conversation view (architecture.md § Dictation).
    if (state.voice?.here === true && !['off', 'idle-off', 'unavailable'].includes(state.voice.mic) && document.activeElement === input) {
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
        attachedFiles.sent(from, files);
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

    if (button === null) {
      return;
    }

    const on = button.dataset['on'] === 'true';
    let attempt = 0;

    const timing = on ? { at: deps.now(), steps: [] } : null;

    if (on) {
      attempt = micStart.start();
      micTiming = timing;
    } else {
      micStart.clear();
      micTiming = null;
    }

    const failed = (error: string): void => {
      // A refusal answered after a later tap or Mic off is not shown.
      if (on && !micStart.fail(error, attempt)) {
        return;
      }

      if (on) {
        micTimed(`failed: ${error}`);
      }

      draw();
      showError(error);
    };
    const refused = (answer: Answer): void => void (answer.status === 200 || failed(String(answer.body['error'] ?? 'The mic did not change.')));

    // On a paired device the mic is this phone's (PRD R119): its tap opens the phone's microphone, taking the voice here first.
    if (phoneVoice !== null) {
      if (!on) {
        // A Mic on still opening is dropped.
        micTaps++;
        micOpening = false;
        phoneVoice.micOff();
        void command('mic', { on: false }).then(refused);
        return;
      }

      const tap = ++micTaps;
      const leaves = micLeaves;

      micOpening = true;
      void phoneVoice.micOn((step, at) => tap === micTaps && micStep(step, at)).then(async (error) => {
        // A newer tap owns the mic now.
        if (tap !== micTaps) {
          return;
        }

        // The page left the conversation while the mic opened: it stays off.
        if (leaves !== micLeaves) {
          phoneVoice.micOff();
          return;
        }

        // The voice ended with nothing to say, as when a hidden page loses it or the operator turns voice or the mic off: the mic is off.
        if (error === '') {
          micOpening = false;
          micStart.clear();
          micTiming = null;
          draw();
          return;
        }

        if (error !== null) {
          micOpening = false;
          failed(error);
          return;
        }

        micStep('mic on sent');

        const answer = await command('mic', { on: true });

        if (tap !== micTaps) {
          return;
        }

        micStep('hub answered');
        micOpening = false;

        if (leaves !== micLeaves) {
          // Left while Mic on was answered: off again, after it, so the hub ends with the mic off.
          if (answer.status === 200) {
            phoneVoice.micOff();
            void command('mic', { on: false });
          }

          return;
        }

        if (answer.status !== 200) {
          phoneVoice.micOff();
        }

        refused(answer);
      });
      // After micOn, so the microphone and the audio start in the tap, as iOS needs.
      draw();
      return;
    }

    void command('mic', { on }).then((answer) => {
      if (answer.status === 200 && timing !== null && micTiming === timing) {
        micStep('hub answered');
      }

      refused(answer);
    });
    draw();
  });
  // The context meter's menu (architecture.md § Context meter): closed, open, or asking to confirm Compact, which sends /compact as a chosen
  // slash command to the session the page shows, leaving the box's draft alone.
  let contextMenu: ContextMenuState = 'closed';
  const drawContext = (): void => {
    const full = state.connected && state.session?.conversation === 'full';

    if (!full && contextMenu === 'confirm') {
      contextMenu = 'open';
    }

    mount(contextSlot, state.session === null ? null : renderShared(renderContextMeter(state.session.context, contextMenu, full)));
  };
  const setContextMenu = (menu: ContextMenuState, focus: string | null = null): void => {
    contextMenu = menu;
    drawContext();

    if (focus !== null) {
      contextSlot.querySelector<HTMLElement>(`[data-context="${focus}"]`)?.focus();
    }
  };
  const compact = async (): Promise<void> => {
    const session = state.session;

    setContextMenu('closed', 'toggle');

    if (session === null || session.conversation !== 'full' || !state.connected) {
      return;
    }

    const from = draftOf;
    const answer = await command('send', { sessionId: session.id, launch: session.launch, text: '/compact', command: true });
    const why = String(answer.body['error'] ?? 'The session did not take /compact.');

    // A refusal shows above the box of the conversation it was sent from, now or when it is selected again.
    if (answer.status !== 200 && from === draftOf) {
      showError(why);
    } else if (answer.status !== 200 && from !== null) {
      errors.set(from, why);
    }
  };

  // A click in the meter can redraw the element it hit, which then is no longer in the slot when the click reaches the document.
  let slotClick: Event | null = null;

  contextSlot.addEventListener('click', (event) => {
    slotClick = event;
    const which = (event.target as HTMLElement).closest<HTMLElement>('[data-context]')?.dataset['context'];

    if (which === 'toggle') {
      setContextMenu(contextMenu === 'closed' ? 'open' : 'closed');
    } else if (which === 'compact') {
      setContextMenu('confirm', 'compact-confirm');
    } else if (which === 'cancel') {
      setContextMenu('open', 'compact');
    } else if (which === 'compact-confirm') {
      void compact();
    }
  });
  contextSlot.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && contextMenu !== 'closed') {
      event.stopPropagation();
      setContextMenu('closed', 'toggle');
    }
  });
  document.addEventListener(
    'click',
    (event) => {
      if (contextMenu !== 'closed' && event !== slotClick && !contextSlot.contains(event.target as Node)) {
        setContextMenu('closed');
      }
    },
    { signal: listening.signal },
  );

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
      contextMenu = 'closed';
      drawAttachments();

      if (id !== null) {
        errors.delete(id);
      }
    }

    const full = state.connected && state.session?.conversation === 'full';

    // On every tab, so the operator can type and dictate from the status or the artifacts too, but on a short screen (page.css).
    composerHost.hidden = state.scope === null;
    input.disabled = !full;
    attachButton.disabled = !full;
    input.placeholder = full
      ? 'Message…'
      : state.session?.state === 'ended' && state.session.conversation !== 'none'
        ? 'Resume the session to send a message.'
        : (state.session?.reason ?? (state.connected ? 'No session has started yet.' : 'Connecting to Switchboard…'));
    // The same controls as the Conversation view's, acting on this computer's voice process (architecture.md § Web page).
    mount(voiceControls, renderShared(renderVoice(state.voice, full)));
    // On a paired device the mic shows while the voice is elsewhere too, off: its tap takes the voice to this phone (PRD R119).
    const micView = phoneVoice !== null && state.voice?.enabled === true && !state.voice.here ? { ...state.voice, here: true, mic: 'off' as const, error: null } : state.voice;

    // While voice is on, a paired device keeps the audio worklet in its cache, so a Mic on tap does not wait to fetch it.
    if (state.voice?.enabled === true) {
      phoneVoice?.preload();
    }

    // A start or its failure belongs to the conversation it was tapped in.
    if (state.scope?.workItemId !== micScope) {
      micScope = state.scope?.workItemId;
      micStart.clear();
      micTiming = null;
    }

    if (micView?.here === true) {
      micStart.view(micView.mic);
    }

    // The start ended: confirmed by the voice view, or failed with why.
    if (micTiming !== null && micStart.pending !== 'starting') {
      micStep('voice confirmed');
      micTimed(micStart.pending === null ? (micView?.mic ?? 'off') : `failed: ${micStart.pending.error}`);
    }

    mount(micSlot, full ? renderShared(renderMicButton(micView, micStart.pending)) : null);
    // The hub's mic turned off while the voice is here, as by Mic off in another of this phone's views: the phone's microphone is released too.
    if (state.voice?.here === true) {
      phoneVoice?.viewMic(state.voice.mic);
    }
    drawContext();
    grow();
    refresh();
  };

  // ---- Drawing ----
  let mermaidRun: Promise<boolean> | null = null;
  /** Each diagram's source, kept from before Mermaid replaced it with its drawing, so a change of scheme can draw it again. */
  const diagramSources = new WeakMap<HTMLElement, string>();
  const drawDiagrams = (within: HTMLElement): void => {
    const diagrams = within.querySelectorAll<HTMLElement>('pre.mermaid');

    if (diagrams.length === 0 || deps.loadMermaid === undefined) {
      return;
    }

    for (const node of diagrams) {
      if (!node.hasAttribute('data-processed')) {
        diagramSources.set(node, node.textContent ?? '');
      }
    }

    mermaidRun ??= deps.loadMermaid();
    void mermaidRun.then((loaded) => {
      const mermaid = (globalThis as { mermaid?: { run(options: { nodes: ArrayLike<HTMLElement> }): Promise<void> } }).mermaid;

      if (loaded && mermaid !== undefined) {
        void mermaid.run({ nodes: diagrams }).catch(() => undefined);
      }
    });
  };
  // Mermaid bakes its theme's colours into each drawing, so when the operating system's scheme changes the diagrams shown are drawn again from
  // their sources in the new scheme's theme.
  const schemeQuery = typeof window.matchMedia === 'function' ? window.matchMedia(LIGHT_SCHEME) : null;

  schemeQuery?.addEventListener?.(
    'change',
    () =>
      void mermaidRun?.then((loaded) => {
        const mermaid = (globalThis as { mermaid?: { initialize(options: object): void; run(options: { nodes: ArrayLike<HTMLElement> }): Promise<void> } }).mermaid;

        if (!loaded || mermaid === undefined) {
          return;
        }

        mermaid.initialize(mermaidOptions());

        const drawn = [...root.querySelectorAll<HTMLElement>('pre.mermaid[data-processed]')].filter((node) => diagramSources.has(node));

        for (const node of drawn) {
          node.removeAttribute('data-processed');
          node.textContent = diagramSources.get(node)!;
        }

        if (drawn.length > 0) {
          void mermaid.run({ nodes: drawn }).catch(() => undefined);
        }
      }),
    { signal: listening.signal },
  );
  /** Each open Markdown artifact's drawn HTML by its path and version (null when it could not be read, undefined while it loads), and where it scrolls to once drawn. */
  const artifactDocs = new Map<string, { updatedAt: number; html: string | null | undefined; top: number | null }>();
  /** An open artifact's key in `artifactDocs`: the page key, the selection's work item and `scopeGen`, and the path, so another work item's artifact of the same path and time is never shown. */
  const docKey = (path: string): string => `${state.key ?? ''} ${state.scope?.workItemId ?? ''} ${state.scope?.scopeGen ?? ''} ${path}`;
  /**
   * Draws an open Markdown artifact as claude-collab's viewer does: its text fetched by the page key, without its front matter, whose kind and
   * title the head shows; its relative pictures from its folder; a relative link to another artifact opening that one in place, and to another
   * file in the folder opening the file in a new tab; Mermaid included. Only an artifact's latest version is kept (`artifactDocs`), with `top`,
   * the scroll position to keep when it replaces the version shown, which the next draw restores; an answer for a version replaced since is dropped.
   */
  const fillArtifact = async (artifact: ArtifactView, top: number): Promise<void> => {
    if (state.key === null) {
      return;
    }

    const key = state.key;
    const path = artifact.path;
    const kept = docKey(path);
    const entry = { updatedAt: artifact.updatedAt, html: undefined as string | null | undefined, top };

    artifactDocs.set(kept, entry);
    const response = await deps.fetch(artifactUrl(key, path), { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
    const text = response?.ok === true ? await response.text() : null;
    const folder = path.split('/').slice(0, -1);
    /** A relative target's path in the artifact folder, or null for one outside it. */
    const inFolder = (target: string): string | null => {
      const parts = [...folder];
      let decoded: string;

      // A scheme, a drive or a rooted path names no artifact: such a link opens in a file tab.
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('\\')) {
        return null;
      }

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

    if (artifactDocs.get(kept) !== entry) {
      return;
    }

    entry.html = text === null ? null : artifactShow(artifact) === 'text' ? textArtifactHtml(text, artifact.ext.toLowerCase().replace(/^\./, '') || path.slice(path.lastIndexOf('.') + 1).toLowerCase()) : renderMarkdown(markdownBody(text), base, link);

    if (view.artifact === path) {
      draw();
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

    // The window's document is built from nodes, so the title and the copied Markdown go in as they are, escaped by the serializer.
    const page = document.implementation.createHTMLDocument(shown.querySelector('.artifact-title')?.textContent ?? '');
    const meta = (attributes: Record<string, string>): void => {
      const node = page.createElement('meta');

      Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
      page.head.append(node);
    };

    page.documentElement.lang = 'en';
    meta({ charset: 'utf-8' });
    // At the device's width, so a phone draws it at the page's text size rather than zoomed out.
    meta({ name: 'viewport', content: 'width=device-width, initial-scale=1' });
    meta({ name: 'referrer', content: 'no-referrer' });

    for (const name of ['theme.css', 'codicon.css', 'page.css']) {
      const link = page.createElement('link');

      link.rel = 'stylesheet';
      link.href = `${location.origin}/page/${name}`;
      page.head.append(link);
    }

    const view = page.createElement('div');
    const head = page.createElement('div');
    const title = page.createElement('span');

    page.body.className = 'artifact-window';
    view.className = 'artifact-view';
    head.className = 'artifact-head';
    title.className = 'artifact-title';
    title.textContent = page.title;
    head.append(...[shown.querySelector('.artifact-badge')?.cloneNode(true)].filter((node): node is Node => node !== undefined), title);
    view.append(head, page.importNode(copy, true));
    page.body.append(view);

    const html = `<!doctype html>${page.documentElement.outerHTML}`;
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
  /** A send brings the conversation to its end, wherever the operator had scrolled, and keeps it there for the sent message, the turn row and the reply. */
  const toEnd = (): void => {
    pinned = true;
    followEnd();
  };

  /**
   * Shows the questions-waiting chip over the composer while the newest card that can be answered is not in view, as when the asides after it
   * pushed it up or another tab is shown (PRD R103).
   */
  const showWaiting = (): void => {
    const chip = composerHost.querySelector<HTMLElement>('.question-waiting')!;
    // Every open question of the conversation counts, from the hub, which reads back past the items the page holds; the chip goes to the oldest.
    const ledger = pageLedger(state);
    const count = state.questions?.open ?? ledger.open.length;
    const key = state.questions?.oldest ?? (ledger.open.length === 0 ? null : (ledger.questions.get(ledger.open[0]!)?.card ?? null));

    // Questions the page cannot answer, while the composer could not send, have no chip.
    if (key === null || count === 0 || !state.connected || state.session?.conversation !== 'full') {
      chip.hidden = true;
      return;
    }

    const shown = questionsWaiting(count);

    if (chip.dataset['targetCard'] !== key || chip.innerHTML !== shown) {
      chip.dataset['targetCard'] = key;
      chip.innerHTML = shown;
    }

    const card = [...document.querySelectorAll<HTMLElement>('.question-card')].find((one) => one.dataset['cardKey'] === key);

    chip.hidden = card !== undefined && inView(card, panel);
  };

  panel.addEventListener('scroll', showWaiting);
  window.addEventListener('resize', showWaiting, { signal: listening.signal });
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

  /** The pool ticket row whose menu is open, with the menu's rows, while the list still has that row. */
  const poolMenu = (): { row: string; rows: VNode[] } | null => {
    const row = view.rowMenu === null ? undefined : state.groups.flatMap((group) => group.rows).find((one) => rowKey(one) === view.rowMenu);

    return row === undefined ? null : { row: rowKey(row), rows: menuRows(row, view) };
  };
  // A pane holds Preact's tree, or what the page draws into it itself: an open artifact or a console, whose frame, media and terminal must not be
  // redrawn. Each hand-over empties it first.
  const preactPanes = new WeakSet<HTMLElement>();
  const drawPane = (pane: HTMLElement, tree: ComponentChild): void => {
    if (!preactPanes.has(pane)) {
      pane.replaceChildren();
      preactPanes.add(pane);
    }

    mount(pane, tree);
  };
  const takePane = (pane: HTMLElement): void => {
    if (preactPanes.delete(pane)) {
      unmount(pane);
    }
  };
  // ---- The work items' drawer (architecture.md § Web page), shown and hidden as the dock's auto-hide ----
  const drawer = root.querySelector<HTMLElement>('.side')!;
  const sliver = root.querySelector<HTMLElement>('.sliver')!;
  // Under a drawer opened by its button or a key, a backdrop takes the press outside it, so the press closes the drawer and does nothing else.
  const backdrop = root.querySelector<HTMLElement>('.drawer-backdrop')!;
  /** Whether the list's pin changes it: only while a work item's conversation shows; with none open, or while History, opened from the list, shows, it is a column either way. */
  const pinWorks = (): boolean => !(view.list || wanted === null) && shownHistory === null;
  /** Whether the list is a drawer: outside the phone's layout, unpinned, while a work item's conversation is open. */
  const drawerMode = (): boolean => root.classList.contains('drawers') && pinWorks();
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let drawerTick: ReturnType<typeof setInterval> | null = null;
  let overDrawer = false;
  let idleMs = 0;
  const cancelReveal = (): void => {
    if (revealTimer !== null) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
  };
  /** Forgets the drawer without drawing. */
  const dropDrawer = (): void => {
    view.drawer = null;
    cancelReveal();

    if (drawerTick !== null) {
      clearInterval(drawerTick);
      drawerTick = null;
    }
  };
  const closeDrawer = (): void => {
    if (view.drawer === null) {
      return;
    }

    const inside = drawer.contains(document.activeElement);

    dropDrawer();
    draw();

    // The focus leaves the hidden list for the button that opens it.
    if (inside) {
      head.querySelector<HTMLElement>('.list-toggle')?.focus();
    }
  };
  /** What keeps a drawer shown by the pointer open, as the dock's `HideDelay`: the pointer over it, a menu or sheet of the list, or typing in its search box. */
  const drawerKept = (): boolean => {
    const focused = document.activeElement;

    return overDrawer || root.classList.contains('resizing') || view.rowMenu !== null || view.sheet !== null || drawer.querySelector('.menu, .sheet-backdrop') !== null || ((focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) && drawer.contains(focused));
  };
  const openDrawer = (how: 'open' | 'hover'): void => {
    if (!drawerMode()) {
      return;
    }

    dropDrawer();
    view.drawer = how;
    overDrawer = how === 'hover';
    idleMs = 0;

    if (how === 'hover') {
      drawerTick = setInterval(() => {
        idleMs = drawerKept() ? 0 : idleMs + DRAWER_TICK_MS;

        if (idleMs >= DRAWER_HIDE_MS) {
          closeDrawer();
        }
      }, DRAWER_TICK_MS);
    }

    draw();

    // Opened by its button, the drawer takes the focus, on the open work item's row.
    if (how === 'open') {
      (list.querySelector<HTMLElement>('.row.selected') ?? list.querySelector<HTMLElement>('.row'))?.focus();
    }
  };

  // A pointer resting on the sliver shows the drawer; touch has no hover, and uses the header's button.
  sliver.addEventListener('pointerenter', (event) => {
    if ((event as PointerEvent).pointerType === 'touch') {
      return;
    }

    cancelReveal();
    revealTimer = setTimeout(() => {
      revealTimer = null;
      openDrawer('hover');
    }, DRAWER_REVEAL_MS);
  });
  sliver.addEventListener('pointerleave', cancelReveal);
  // A touch swiping right from the page's left edge, on the sliver's wider touch area (page.css), shows the drawer as its button does.
  let swipe: { id: number; x: number; y: number } | null = null;

  sliver.addEventListener('pointerdown', (event) => {
    swipe = event.pointerType === 'touch' && drawerMode() && view.drawer === null ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
    if (swipe !== null) {
      sliver.setPointerCapture?.(event.pointerId);
    }
  });
  sliver.addEventListener('pointermove', (event) => {
    if (swipe === null || swipe.id !== event.pointerId) {
      return;
    }

    const across = event.clientX - swipe.x;
    const down = Math.abs(event.clientY - swipe.y);

    if (across >= SWIPE_OPEN && across > down) {
      swipe = null;
      openDrawer('open');
    } else if (down >= SWIPE_OPEN) {
      swipe = null;
    }
  });
  for (const type of ['pointerup', 'pointercancel']) {
    sliver.addEventListener(type, () => {
      swipe = null;
    });
  }
  drawer.addEventListener('pointerenter', () => {
    overDrawer = true;
  });
  drawer.addEventListener('pointerleave', () => {
    overDrawer = false;
  });
  // A press outside the drawer and its sheets hides it; the button toggles it itself.
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (view.drawer !== null && event.target instanceof Node && event.target !== backdrop && !drawer.contains(event.target) && !sheetHost.contains(event.target) && head.querySelector('.list-toggle')?.contains(event.target) !== true) {
        closeDrawer();
      }
    },
    { signal: listening.signal },
  );

  backdrop.addEventListener('click', () => closeDrawer());

  /**
   * Draws the hidden list's sliver, as the dock's `SliverBars`: each row's coloured stripe at its height, cut to the list's view and left out
   * under a pinned group heading; once a frame at most.
   */
  let sliverQueued = false;
  const fitSliver = (): void => {
    if (sliverQueued) {
      return;
    }

    sliverQueued = true;
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (run: () => void) => setTimeout(run, 0))(() => {
      sliverQueued = false;

      if (!drawerMode() || view.drawer !== null) {
        sliver.replaceChildren();
        return;
      }

      const box = list.getBoundingClientRect();
      const heads = [...list.querySelectorAll('.group-head')].map((one) => one.getBoundingClientRect());
      const bars: HTMLElement[] = [];

      for (const row of list.querySelectorAll<HTMLElement>('.row[class*="stripe-"]')) {
        const stripe = [...row.classList].find((name) => name.startsWith('stripe-'))!;
        const at = row.getBoundingClientRect();
        // The stripe's own ends (page.css .row::before): 8 px in, the selected row's the full height.
        const inset = row.classList.contains('selected') ? 0 : 8;
        let top = Math.max(at.top + inset, box.top);
        const bottom = Math.min(at.bottom - inset, box.bottom);

        for (const heading of heads) {
          if (heading.top <= top && heading.bottom > top) {
            top = heading.bottom;
          }
        }

        if (bottom > top) {
          const bar = document.createElement('i');

          bar.className = stripe;
          bar.style.top = `${top}px`;
          bar.style.height = `${bottom - top}px`;
          bars.push(bar);
        }
      }

      sliver.replaceChildren(...bars);
    });
  };

  list.addEventListener('scroll', fitSliver, { passive: true, signal: listening.signal });
  window.addEventListener('resize', fitSliver, { signal: listening.signal });
  // The columns follow the width as it changes; a draw moves each pane to its place only when they change.
  window.addEventListener('resize', () => relayout() && draw(), { signal: listening.signal });

  /** Whether the last draw showed the list in the conversation's place on a narrow screen; true at first, so a load is no leaving. */
  let wasListing = true;
  /** Draws the state; Preact changes only what differs, so the focus, a selection, the scroll position and open menus stay. */
  const drawRegions = (): void => {
    // On a narrow screen the list and the conversation are each a full-width view (page.css); the list shows until a work item is opened.
    const listing = shownHistory === null && (view.list || wanted === null);

    // Leaving the conversation for the list in the phone's layout (Back, a swipe right or the browser's back, all through back(), or a refused
    // open) leaves the work item, so a mic on for it turns off and a phone's microphone is released; what plays goes on (PRD R119).
    const leftConversation = listing && !wasListing && isPhone() && ((state.voice?.here === true && state.voice.mic !== 'off') || micOpening);

    wasListing = listing;

    // After this draw, since releasing the phone's microphone draws again.
    if (leftConversation) {
      micLeaves++;
      micOpening = false;
      micStart.clear();
      micTiming = null;
      queueMicrotask(() => {
        phoneVoice?.micOff();
        void command('mic', { on: false });
      });
    }

    root.classList.toggle('listing', listing);
    // A ticket's History shows in the conversation's place, over its column and the side column (architecture.md § Web page).
    root.classList.toggle('history', shownHistory !== null);
    mount(historyHost, shownHistory === null ? null : renderHistory(shownHistory));

    // The drawer is only outside the phone's layout while the list does not fit, with a work item open; the focus leaves a list that the phone's layout now
    // hides for Back.
    const dropped = view.drawer !== null && !drawerMode();

    if (dropped) {
      dropDrawer();
    }

    root.classList.toggle('drawer-open', view.drawer !== null);
    root.classList.toggle('drawer-held', view.drawer === 'open');
    fitSliver();

    if (dropped && drawer.contains(document.activeElement) && getComputedStyle(drawer).display === 'none') {
      head.querySelector<HTMLElement>('.back-toggle')?.focus();
    }
    // The pane helper finds this window by the marker until it has found it (architecture.md § Pane state); the dock brings it forward by its
    // `show` marker (architecture.md § Dock).
    document.title = pageTitle(state.groups) + (view.pane?.marker == null ? '' : ` [sb-pane ${view.pane.marker}]`) + (showMarker === null ? '' : ` [sb-show ${showMarker}]`);
    header.draw(state.header, state.groups);
    // A search shows only the rows that match, in every group, open (PRD R63).
    const listed = header.list(state.groups);
    mount(sheetHost, renderSheet(view.sheet, view.acting));

    // The persona dialog belongs to the conversation it opened for, so it closes when another replaces it, before a pick could pin that one's session.
    if (view.personas !== null && (state.scope === null || state.scope.scopeGen !== personaScope)) {
      view.personas = null;
    }

    mount(personaHost, renderPersonaDialog(state.session?.persona, view.personas));
    coverForPersonas(view.personas !== null);
    mount(list, renderListPane(expired, listError, renderList(listed.groups, state.scope?.workItemId ?? null, view.collapsed, listed.filtering, poolMenu(), view.bands, !paneWorks(), dragView), header.end(listed.groups)));
    // The rows may have moved under a still pointer.
    reorder.refresh();

    // An ended session's note sits just above the composer on every tab, with Resume, as in the Conversation view; the page resumes it in the
    // terminal holder, or a Codex thread in its daemon, without a terminal.
    mount(note, renderEndedNote(state.session, resuming));

    // From the wide layout Status, Artifacts, Console and Browser are a column of their own; the Chrome pane covers the Browser tab's area.
    const side = wide() && state.scope !== null;

    root.classList.toggle('wide', side);
    // Under 800 px of height the composer shows only on the Conversation tab (page.css).
    root.classList.toggle('off-conversation', state.scope !== null && mainTab() !== 'conversation');

    if (!side) {
      mount(detailHead, null);
      drawPane(detailBody, null);
    }

    const turnEnded = changesSession === 'running' && state.session?.state !== 'running';

    changesSession = state.session?.state ?? null;
    changes.follow(state.scope === null || state.key === null ? null : `${state.key} ${state.scope.scopeGen} ${state.scope.workItemId ?? ''}`, turnEnded);
    localFiles.follow(state.scope === null || state.key === null ? null : `${state.key} ${state.scope.scopeGen} ${state.scope.workItemId ?? ''}`);

    if (state.scope === null) {
      mount(head, null);
      drawPane(panel, renderEmpty(state.connected ? 'Choose a work item on the left.' : 'Connecting to Switchboard…'));
      shown = null;
      updateComposer();
      return;
    }

    const shownArtifact = openArtifact();

    // Opened only while it shows: not under the phone's list or a History.
    if (shownArtifact !== null && (side ? sideTab() : mainTab()) === 'artifacts' && !(isPhone() && root.classList.contains('listing')) && !root.classList.contains('history')) {
      artifactsOpened([shownArtifact]);
    }

    const strip = { open: shownArtifact, fit: view.artifactFit, menu: view.artifactMenu, now: deps.now(), closed: closedNow(), unread: unreadArtifacts(state.artifacts, state.scope.workItemId ?? null, artifactsSeen) };

    // The file tabs, then the one Changes tab, last so it keeps its place as file tabs come and go.
    const changeTabs = (shown: Tab): ComponentChild[] => [localTabs(localFiles.view, shown === 'file', true), changesTab(changes.view, shown === 'diff', localFiles.view.tabs.length === 0)];

    mount(head, [renderHeader(state, view), side ? null : renderTabs({ ...view, tab: mainTab() }, state, showBrowser(), strip, changeTabs(mainTab()), showConsole())]);

    const artifact = view.artifact === null ? undefined : state.artifacts.find((one) => one.path === view.artifact);
    const now = deps.now();
    /** Draws the Status or Artifacts tab, or an open artifact, into a pane; an open artifact stays as it is, so a frame or a video is not reloaded. */
    const drawTab = (pane: HTMLElement, tab: Tab): void => {
      pane.classList.toggle('console-pane', tab === 'console');
      pane.classList.toggle('browser-pane', tab === 'browser');
      pane.classList.toggle('diff-pane', tab === 'diff' || (tab === 'file' && localFiles.codeShown()));

      if (tab === 'browser') {
        // The Chrome pane's window lies over this area while it shows; until then the area says why it does not.
        const row = selectedRow(state);
        const note = browserNote(view.pane, pane.getBoundingClientRect().width, itemLinks(), paneHidden());

        drawPane(pane, note === null ? null : renderEmpty(note));
      } else if (tab === 'console') {
        drawConsole(pane);
      } else if (tab === 'diff') {
        changes.drawDiff(pane);
      } else if (tab === 'file') {
        localFiles.draw(pane);
      } else if (tab === 'artifacts' && artifact !== undefined && state.key !== null) {
        const kept = artifactDocs.get(docKey(artifact.path));

        // A new version replaces the one shown, and a Markdown artifact keeps the reader's place.
        if ((artifact.type === 'markdown' || artifactShow(artifact) === 'text') && kept?.updatedAt !== artifact.updatedAt) {
          const open = pane.querySelector<HTMLElement>(':scope > .artifact-view');

          void fillArtifact(artifact, open?.dataset['artifact'] === artifact.path ? (open.querySelector<HTMLElement>('.artifact-doc')?.scrollTop ?? 0) : 0);
        }

        const doc = artifactDocs.get(docKey(artifact.path));

        drawPane(pane, renderArtifactView(state.key, artifact, doc?.updatedAt === artifact.updatedAt ? doc.html : undefined));

        if (doc?.updatedAt === artifact.updatedAt && doc.html !== undefined && doc.top !== null) {
          const shown = pane.querySelector<HTMLElement>('.artifact-doc');

          if (shown !== null) {
            shown.scrollTop = doc.top;
          }

          doc.top = null;
        }

        drawDiagrams(pane);
      } else {
        drawPane(pane, tab === 'status' ? renderStatus(state, now) : tab === 'artifacts' ? renderArtifacts(state, now) : renderTimeline(state, view));
        drawDiagrams(pane);
      }

      pane.classList.toggle('framed', (tab === 'artifacts' && artifact !== undefined) || (tab === 'file' && !localFiles.codeShown()));
    };

    drawTab(panel, mainTab());

    if (side) {
      mount(detailHead, renderSideSwitch(sideTab(), state, showBrowser(), strip, [...changeTabs(sideTab()), renderMaximize(panelMaximized)], showConsole()));
      drawTab(detailBody, sideTab());
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
    showWaiting();
    dropConsoles();
    changes.drop();
    localFiles.drop();
  };
  /** Opens each open menu down and to the right of its button, or the other way where the page has no room (`placeMenus`, architecture.md § Conversation view, Menus). */
  // A menu may set a wider max-width of its own, as the Artifacts menu does for its kind column.
  const fitMenus = (): void =>
    placeMenus(root, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }, (menu) => parseFloat(getComputedStyle(menu as unknown as Element).maxWidth) || MENU_MAX_WIDTH);
  /**
   * How many artifact tabs the shown strip fits (`artifactTabsFit`), measured after a draw: its other tabs and the Artifacts button as drawn, and a
   * fixed width per artifact tab. True when that changes which tabs show, so the strip is drawn once more; a change of the strip's width draws again
   * (`stripWidth`).
   */
  const fitArtifactTabs = (): boolean => {
    const strip = (wide() ? detailHead : head).querySelector<HTMLElement>('.tabs');

    if (strip === null) {
      return false;
    }

    const fixed = [...strip.querySelectorAll<HTMLElement>(':scope > .tab:not(.artifact-tab)')].reduce((sum, tab) => sum + tab.getBoundingClientRect().width, 0);
    const menu = strip.querySelector<HTMLElement>('.artifact-menu-button')?.getBoundingClientRect().width;
    const count = state.artifacts.length;
    const fit = artifactTabsFit(strip.getBoundingClientRect().width, fixed, count, menu || undefined);
    const changed = Math.min(fit, count) !== Math.min(view.artifactFit, count);

    view.artifactFit = fit;
    return changed;
  };
  // Makes the rest of the page inert while the persona dialog shows, so Tab and clicks reach only the dialog, as Settings does.
  function coverForPersonas(on: boolean): void {
    if (on === personaCovers) {
      return;
    }

    personaCovers = on;

    for (const child of root.children) {
      if (child !== personaHost) {
        child.toggleAttribute('inert', on);
      }
    }
  }
  /** Closes the persona dialog and gives the focus back to the view options button, under which the persona row opened it. */
  const closePersonas = (): void => {
    view.personas = null;
    draw();
    head.querySelector<HTMLElement>('button.view-options')?.focus();
  };
  // A draw asked for before the next repaint (`drawSoon`), which a draw meanwhile makes unneeded.
  let frame: { cancelled: boolean } | null = null;
  const draw = (): void => {
    if (frame !== null) {
      frame.cancelled = true;
      frame = null;
    }

    // A card is drawn anew from HTML, so the control that had the focus in it gets it back, with an Other field's caret.
    const focus = cardFocus();

    drawRegions();
    restoreCardFocus(focus);

    // Measured again after a draw that changed the tabs, since the Artifacts button may have come or gone; twice at most.
    for (let again = 0; again < 2 && fitArtifactTabs(); again++) {
      drawRegions();
    }

    fitMenus();
    reportBrowser();
  };


  /** Draws before the next repaint, once however many events ask for it before then. */
  const drawSoon = (): void => {
    if (frame !== null) {
      return;
    }

    const asked = { cancelled: false };

    frame = asked;
    (deps.frame ?? ((run: () => void) => void (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 0))))(() => {
      if (!asked.cancelled) {
        frame = null;
        draw();
      }
    });
  };

  // ---- The console ----
  /** A pane's one line, for the console's host, which the console module draws into itself. */
  const emptyLine = (text: string): HTMLElement => {
    const line = document.createElement('p');

    line.className = 'empty';
    line.textContent = text;
    return line;
  };
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
      drawPane(pane, renderEmpty(why ?? 'Connecting to Switchboard…'));
      return;
    }

    // The hub ends a console when the page's scope generation, session or launch changes, so the page mounts a new one then.
    const id = `${state.key} ${state.scope?.scopeGen ?? ''} ${session.id} ${session.launch ?? ''}`;
    const shownConsole = pane.querySelector<HTMLElement>(':scope > .console');

    if (shownConsole?.dataset['console'] === id) {
      return;
    }

    const host = document.createElement('div');

    host.className = 'console';
    host.dataset['console'] = id;
    host.append(emptyLine('Loading the console…'));
    takePane(pane);
    pane.replaceChildren(host);
    dropConsoles();

    const key = state.key;
    const sessionId = session.id;
    const launch = session.launch;

    consoleLoad ??= deps.loadConsole?.() ?? Promise.resolve(null);
    void consoleLoad.then((module) => {
      if (!root.contains(host)) {
        return;
      }

      if (module === null) {
        host.replaceChildren(emptyLine('The console could not be loaded. Reload the page to try again.'));
        consoleLoad = null;
        return;
      }

      host.replaceChildren();
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
      void post('page-focus', { focused, notify: notificationsAllowed() });
    }

    checkSeen();
  };

  window.addEventListener('focus', () => reportFocus());
  window.addEventListener('blur', () => reportFocus());
  document.addEventListener('visibilitychange', () => reportFocus());

  /** Keeps a group's open or closed choice for the next load; a page whose storage refuses keeps it until it reloads. */
  const keepGroup = (group: string, open: boolean): void => {
    let kept: Record<string, boolean> = {};

    try {
      const read: unknown = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '{}');

      kept = read !== null && typeof read === 'object' && !Array.isArray(read) ? (read as Record<string, boolean>) : {};
    } catch {
      kept = {};
    }

    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify({ ...kept, [group]: open }));
    } catch {
      // Storage full or refused: the choice lasts this load.
    }
  };

  // ---- History ----
  /** The History shown in the conversation's place, or null; each ticket's settings last while the page is open. */
  let shownHistory: HistoryOpen | null = null;
  const historyUis = new Map<number, HistoryUi>();
  let historyTick: ReturnType<typeof setInterval> | null = null;
  let historyChange: ReturnType<typeof setTimeout> | null = null;
  // Each read of the hub, so an answer that a later read overtook is dropped.
  let historyRead = 0;
  // What had the focus before History opened, given it back when History closes.
  let historyReturn: (() => HTMLElement | null) | null = null;
  /** Reads the open History from the hub; a failed read keeps what it shows and says why. */
  const readHistory = async (): Promise<void> => {
    const asked = shownHistory;

    if (asked === null) {
      return;
    }

    const read = ++historyRead;
    const answer = await post('page-history', { ticketId: asked.ticketId });

    if (shownHistory !== asked || read !== historyRead) {
      return;
    }

    if (answer.status === 200) {
      asked.view = answer.body['view'] as HistoryView;
      asked.categories = (answer.body['categories'] as HistoryCategory[] | undefined) ?? [];
      asked.error = null;
    } else {
      asked.error = String(answer.body['error'] ?? `Switchboard did not answer (status ${answer.status}).`);
    }

    draw();
  };
  const openHistory = (ticketId: number, key: string, returnTo: () => HTMLElement | null): void => {
    historyReturn = returnTo;
    closeMenus();
    shownHistory = { ticketId, key, view: null, categories: [], error: null, ui: historyUis.get(ticketId) ?? { ...EMPTY_HISTORY_UI } };
    historyTick ??= setInterval(() => void readHistory(), HISTORY_REFRESH_MS);
    draw();
    historyHost.querySelector<HTMLElement>('.hist-close')?.focus();
    void readHistory();
  };
  /** Closes History; with `focusBack`, as from Close or Escape, the control that opened it takes the focus again. */
  const closeHistory = (focusBack = false): void => {
    if (shownHistory === null) {
      return;
    }

    const back = historyReturn;

    shownHistory = null;
    historyReturn = null;
    historyRead++;
    clearInterval(historyTick ?? undefined);
    clearTimeout(historyChange ?? undefined);
    historyTick = null;
    historyChange = null;
    draw();

    if (focusBack) {
      back?.()?.focus();
    }
  };
  /** The operator changed the open History's chips, filter, sections or runs: kept for the ticket while the page is open. */
  const setHistoryUi = (ui: HistoryUi): void => {
    if (shownHistory !== null) {
      shownHistory.ui = ui;
      historyUis.set(shownHistory.ticketId, ui);
    }
  };

  historyHost.addEventListener('input', (event) => {
    const field = event.target as HTMLInputElement;

    if (shownHistory !== null && field.classList.contains('hist-filter')) {
      setHistoryUi({ ...shownHistory.ui, query: field.value });
      draw();
    }
  });
  // A section or run the operator opened or closed stays so across redraws.
  historyHost.addEventListener(
    'toggle',
    (event) => {
      const details = event.target as HTMLDetailsElement;
      const section = details.dataset?.['section'];
      const run = details.dataset?.['run'];

      if (shownHistory === null) {
        return;
      }

      // Drawn again, so the next drawing compares against what the page shows, and Expand all opens a section the operator closed.
      if (section !== undefined && (shownHistory.ui.sections[section] ?? null) !== details.open) {
        setHistoryUi({ ...shownHistory.ui, sections: { ...shownHistory.ui.sections, [section]: details.open } });
        draw();
      } else if (run !== undefined && shownHistory.ui.runs.includes(run) !== details.open) {
        setHistoryUi({ ...shownHistory.ui, runs: details.open ? [...shownHistory.ui.runs, run] : shownHistory.ui.runs.filter((one) => one !== run) });
        draw();
      }
    },
    true,
  );
  historyHost.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && shownHistory !== null) {
      event.stopPropagation();
      closeHistory(true);
    }
  });

  // ---- Selecting ----
  const select = async (workItemId: number): Promise<void> => {
    const listing = view.list || wanted === null;

    // A work item opened from the list shows its conversation in History's place.
    closeHistory();
    // Choosing a work item hides the drawer, as a row's click hides the auto-hidden dock.
    closeDrawer();
    wanted = workItemId;
    listError = null;
    view.list = false;
    view.picker = false;
    view.actions = false;
    view.sheet = null;
    view.providers = null;
    newFrom = null;
    view.artifact = null;
    // On a phone, a conversation opened from the list is a history entry of its own, which the browser's back, as Android's back button, leaves.
    if (listing && isPhone() && !conversationEntry(history.state)) {
      history.pushState({ [CONVERSATION_ENTRY]: true }, '', `#w=${workItemId}`);
    } else {
      history.replaceState(history.state, '', `#w=${workItemId}`);
    }

    // Where the column folds into the conversation's tabs, the work item already open shows its Conversation tab again; another opens on it
    // with its hello (`openTabs`), so a refused select leaves the open work item's tab as it was.
    if (state.scope?.workItemId === workItemId && !wide()) {
      view.tab = 'conversation';
    }

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

        // A conversation still shown keeps its history entry; with none, the entry the refused row added goes, as Back's does.
        if (wanted !== null) {
          history.replaceState(history.state, '', `#w=${wanted}`);
        } else if (conversationEntry(history.state) && !backPending) {
          history.replaceState(history.state, '', '#');
          backPending = true;
          history.back();
        } else {
          history.replaceState(conversationEntry(history.state) ? history.state : null, '', '#');
        }

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

  /** Back to the list on a phone, from the Back button or a swipe right (swipeBack.ts), with the focus on the selected row. */
  const back = (): void => {
    view.list = true;
    draw();
    list.querySelector<HTMLElement>('.row.selected')?.focus();

    // The conversation's history entry goes with it, so the browser's back from the list leaves the page as before.
    if (conversationEntry(history.state) && !backPending) {
      backPending = true;
      history.back();
    }
  };
  /** Whether Back's `history.back()` has not landed yet. */
  let backPending = false;
  // The browser's back, as Android's back button, leaves a phone's conversation as Back does, and its forward opens it again; the list's entry
  // keeps the open work item's address, as Back leaves it.
  window.addEventListener(
    'popstate',
    (event) => {
      const left = backPending;

      backPending = false;

      if (wanted === null || !isPhone()) {
        return;
      }

      const listing = view.list;

      // A row opened before Back's own step back landed gets its entry again.
      if (left) {
        if (listing) {
          history.replaceState(history.state, '', `#w=${wanted}`);
        } else {
          history.pushState({ [CONVERSATION_ENTRY]: true }, '', `#w=${wanted}`);
        }

        return;
      }

      if (conversationEntry(event.state)) {
        if (listing) {
          view.list = false;
          view.tab = 'conversation';
          draw();
        }

        return;
      }

      history.replaceState(history.state, '', `#w=${wanted}`);

      if (!listing) {
        back();
      }
    },
    { signal: listening.signal },
  );
  // A swipe right over a phone's conversation goes back, while no menu, sheet, Settings or History lies over it.
  const stopSwipe = swipeBack({
    root,
    host: root.querySelector<HTMLElement>('.main')!,
    under: drawer,
    enabled: () => isPhone() && !root.classList.contains('listing') && shownHistory === null && document.querySelector('.menu, [role="menu"], [role="listbox"]:not([hidden]), .sheet-backdrop, .settings-backdrop, .persona-backdrop') === null,
    back,
    reducedMotion: () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    nativeEdgeBack: () => browserBackPreview(navigator.userAgent, navigator.platform, navigator.maxTouchPoints, history.length),
  });

  listening.signal.addEventListener('abort', stopSwipe);
  listening.signal.addEventListener('abort', () => document.documentElement.classList.remove('phone'));

  // ---- Cards (PRD R103) ----
  // The hub keeps each card's draft for every page, window and the voice; a page shows its own change at once, until the hub's `questions` follows.
  const cardUi = (key: string): CardDraft => {
    let ui = view.cards.get(key);

    if (ui === undefined) {
      ui = { local: null, pending: 0, sending: false, error: null, menuOpen: false };
      view.cards.set(key, ui);
    }

    return ui;
  };
  const cardNow = (key: string): LedgerCard | null => pageLedger(state).cards.get(key) ?? null;
  const cardDraftOf = (key: string): SharedDraft | undefined => view.cards.get(key)?.local ?? state.questions?.drafts[key];
  let otherTimer: ReturnType<typeof setTimeout> | null = null;
  let advanceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Shows a card's new draft and tells the hub; `quiet` leaves the page undrawn, as while an Other field is typed in. */
  const setDraft = (key: string, draft: SharedDraft, quiet = false): void => {
    const ui = cardUi(key);
    const session = state.session;

    ui.local = draft;
    ui.error = null;

    if (!quiet) {
      draw();
    }

    if (session === null) {
      return;
    }

    ui.pending++;
    void command('card-draft', { sessionId: session.id, card: key, draft }).then((answer) => {
      ui.pending--;

      if (answer.status !== 200 && ui.pending === 0) {
        ui.local = null;
        draw();
      }
    });
  };
  const sendCard = async (key: string): Promise<void> => {
    const card = cardNow(key);
    const ui = cardUi(key);
    const session = state.session;
    const given = card === null ? [] : draftAnswers(card, cardDraftOf(key));

    if (card === null || given.length === 0 || ui.sending || session === null || session.conversation !== 'full' || !state.connected) {
      return;
    }

    ui.sending = true;
    ui.error = null;
    draw();
    toEnd();

    const answer = await command('send', { sessionId: session.id, launch: session.launch, answers: given.map(({ one, pick }) => ({ card: key, slug: one.question.slug, letters: pick.letters, other: pick.other ?? '' })) });
    const id = (answer.body['message'] as { id?: string } | undefined)?.id ?? null;
    const late = id === null ? undefined : unsent.get(id);

    ui.sending = false;

    if (answer.status !== 200 || late !== undefined) {
      ui.error = late?.error ?? String(answer.body['error'] ?? 'Not sent.');
      unsent.delete(id ?? '');
    } else {
      ui.sentId = id;
    }

    draw();
  };
  /** Moves a card to the step before or after, or by slug. */
  const stepCard = (key: string, to: 'back' | 'next' | string): void => {
    const card = cardNow(key);

    if (card !== null) {
      setDraft(key, moveStep(card, cardDraftOf(key), to));
    }
  };
  /** Picks a letter; a single-choice pick moves on after `ADVANCE_MS` (design open choice 4), unless the operator moved first. */
  const pickCard = (key: string, slug: string, letter: string): void => {
    const card = cardNow(key);

    if (card === null) {
      return;
    }

    const { draft, advance } = pickLetter(card, cardDraftOf(key), slug, letter);

    setDraft(key, draft);

    if (advance) {
      clearTimeout(advanceTimer ?? undefined);
      advanceTimer = setTimeout(() => {
        const now = cardNow(key);

        if (now !== null && currentStep(now, cardDraftOf(key))?.question.slug === slug) {
          stepCard(key, 'next');
        }
      }, ADVANCE_MS);
    }
  };
  const openOther = (key: string, slug: string): void => {
    const card = cardNow(key);

    if (card !== null) {
      setDraft(key, setOther(card, cardDraftOf(key), slug, cardDraftOf(key)?.picks[slug]?.other ?? ''));
      [...root.querySelectorAll<HTMLTextAreaElement>('textarea.qc-other')].find((field) => field.dataset['card'] === key)?.focus();
    }
  };
  /** The control in a card that has the focus, to give it back after a draw. */
  const cardFocus = (): { card: string; selector: string; start: number | null; end: number | null } | null => {
    const active = document.activeElement as HTMLElement | null;
    const card = active?.closest<HTMLElement>('.question-card.qc');

    if (active === null || card == null) {
      return null;
    }

    const key = card.dataset['card'] ?? '';
    const data = ['action', 'slug', 'letter'].map((name) => (active.dataset[name] === undefined ? '' : `[data-${name}="${active.dataset[name]!.replace(/["\\]/g, (char) => `\\${char}`)}"]`)).join('');
    const field = active instanceof HTMLTextAreaElement;

    return { card: key, selector: field ? '.qc-other' : data === '' ? '' : data, start: field ? active.selectionStart : null, end: field ? active.selectionEnd : null };
  };
  const restoreCardFocus = (focus: ReturnType<typeof cardFocus>): void => {
    if (focus === null || document.activeElement?.closest('.question-card.qc') != null) {
      return;
    }

    const card = [...root.querySelectorAll<HTMLElement>('.question-card.qc')].find((one) => one.dataset['card'] === focus.card);
    const target = (focus.selector === '' ? null : card?.querySelector<HTMLElement>(focus.selector)) ?? card;

    target?.focus({ preventScroll: true });

    if (target instanceof HTMLTextAreaElement && focus.start !== null) {
      target.setSelectionRange(focus.start, focus.end ?? focus.start);
    }
  };

  // ---- Clicks ----
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;

    if (changes.click(target) || localFiles.click(target)) {
      return;
    }

    // A web link in a reply, a status or an artifact opens in the Chrome pane's window while the pane is on, never in whichever browser window
    // had the focus last; without the pane it opens in a new browser tab, as its target says.
    const web = target.closest<HTMLAnchorElement>('.body a[href][target="_blank"]');

    if (web !== null && webLink(web.getAttribute('href') ?? '') && paneReady()) {
      event.preventDefault();
      openInPane(web.href);
      return;
    }
    const sideTab = target.closest<HTMLElement>('[data-side]')?.dataset['side'];

    if (SIDE_TABS.includes(sideTab as SideTab)) {
      chooseTab(sideTab as SideTab);
      view.artifact = sideTab === 'artifacts' ? view.artifact : null;
      draw();
      saveTab();
      return;
    }

    const tab = target.closest<HTMLElement>('[data-tab]')?.dataset['tab'] as Tab | undefined;

    if (tab !== undefined && TABS.some((one) => one.tab === tab)) {
      leaving(tab);
      chooseTab(tab);
      view.artifact = tab === 'artifacts' ? view.artifact : null;
      draw();
      saveTab();
      return;
    }

    const button = target.closest<HTMLElement>('[data-action]');
    const action = button?.dataset['action'];

    switch (action) {
      case 'select':
        void select(Number(button!.dataset['workItem']));
        break;
      case 'list-pin':
        pinList(!listPinned);
        break;
      case 'panel-max':
        maximizePanel(!panelMaximized);
        break;
      case 'drawer':
        if (view.drawer === null) {
          openDrawer('open');
        } else {
          closeDrawer();
        }

        break;
      case 'back':
        back();
        break;
      case 'group': {
        const group = button!.dataset['group']!;

        if (!view.collapsed.delete(group)) {
          view.collapsed.add(group);
        }

        keepGroup(group, !view.collapsed.has(group));
        draw();
        break;
      }
      case 'band': {
        const band = button!.dataset['band']!;

        view.bands.set(band, !bandOpen(band, view.bands));
        draw();
        break;
      }
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
        view.actions = false;
        view.viewMenu = false;
        draw();
        break;
      case 'persona':
        void choosePersona();
        break;
      case 'persona-close':
        // A press on the dialog itself is not one on its backdrop.
        if (!button!.classList.contains('persona-backdrop') || target === button) {
          closePersonas();
        }

        break;
      case 'actions':
        view.actions = !view.actions;
        view.linkMenu = false;
        view.rowMenu = null;
        view.picker = false;
        view.viewMenu = false;
        draw();
        break;
      case 'row-action':
        chooseAction(button!.dataset['row'] ?? '', button!.dataset['label'] ?? '');
        break;
      case 'row-paste':
        void copyPaste(button!.dataset['label'] ?? '');
        break;
      case 'row-command':
        void runCommand(button!.dataset['label'] ?? '');
        break;
      case 'open-link':
        // A pill's link, without the browser pane, opens without selecting its row; an Open item of the header's or a pool row's menu closes the menu.
        openLink(button!.dataset['row'] ?? '', button!.dataset['link'] ?? '');
        break;
      case 'row-history': {
        const key = button!.dataset['row'] ?? '';
        const shown = rowByKey(key)?.history ?? null;
        // Back to the menu's opener: the header's actions button, or the pool ticket's row in the list.
        const opener = button!.closest('.row-menu') === null ? (): HTMLElement | null => root.querySelector<HTMLElement>('.header [data-action="actions"]') : (): HTMLElement | null => [...list.querySelectorAll<HTMLElement>('[data-action="pool-menu"]')].find((one) => one.dataset['row'] === key) ?? null;

        if (shown !== null) {
          openHistory(shown.ticketId, shown.key, opener);
        }

        break;
      }
      case 'history-close':
        closeHistory(true);
        break;
      case 'history-chip':
        if (shownHistory !== null) {
          const category = button!.dataset['category'] ?? '';
          const hidden = shownHistory.ui.hidden.includes(category) ? shownHistory.ui.hidden.filter((one) => one !== category) : [...shownHistory.ui.hidden, category];

          setHistoryUi({ ...shownHistory.ui, hidden });
          draw();
        }

        break;
      case 'history-all':
        if (shownHistory?.view != null) {
          const open = button!.dataset['all'] === 'open';

          setHistoryUi({ ...shownHistory.ui, sections: Object.fromEntries(shownHistory.view.sections.map((section) => [section.key, open])) });
          draw();
        }

        break;
      case 'history-open': {
        const target = tabUrl(button!.dataset['url'] ?? '');

        if (target !== null) {
          (deps.openUrl ?? ((one: string) => void window.open(one, '_blank', 'noopener,noreferrer')))(target);
        }

        break;
      }
      case 'pool-menu': {
        const key = button!.dataset['row'] ?? '';
        const open = view.rowMenu === key;

        closeMenus();
        view.picker = false;
        view.rowMenu = open ? null : key;
        draw();
        // A row near the list's end keeps its menu in view.
        list.querySelector<HTMLElement>('.row-menu')?.scrollIntoView?.({ block: 'nearest' });
        break;
      }
      case 'link-menu':
        view.linkMenu = !view.linkMenu;
        draw();
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
        // A pick applies at once and closes the dialog.
        closePersonas();

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

        chooseTab('artifacts');

        view.artifact = button!.dataset['path'] ?? null;
        view.artifactMenu = false;

        // Choosing a closed artifact opens its tab again.
        if (view.artifact !== null && closedNow().has(view.artifact)) {
          setClosed(view.artifact, false);
        }

        draw();
        saveTab();
        break;
      case 'artifact-menu':
        view.artifactMenu = !view.artifactMenu;
        draw();
        break;
      case 'close-artifact': {
        // Closing an artifact's tab hides it for the work item on every device, until a newer version; the menu still lists it. Closing the
        // open one shows Status.
        const path = button!.dataset['path'] ?? openArtifact();

        if (path !== null) {
          setClosed(path, true);
        }

        const wasOpen = path === openArtifact();

        if (wasOpen) {
          view.artifact = null;
          chooseTab('status');
        }

        view.artifactMenu = false;
        draw();

        // The work item's kept artifact goes; Status shows without becoming the choice for every work item.
        if (wasOpen && state.scope?.workItemId != null) {
          savedTabs = { workItemId: state.scope.workItemId, tab: null, closed: savedTabs?.closed ?? [] };
          void post('page-tabs', { workItemId: state.scope.workItemId, tab: null });
        }

        break;
      }
      case 'artifact-window':
        artifactWindow();
        break;
      case 'view-menu':
        view.viewMenu = !view.viewMenu;
        // One header menu at a time.
        view.providers = null;
        view.picker = false;
        view.actions = false;
        draw();
        break;
      case 'pane-pair':
        void pairPane();
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
      case 'toggle-expand-replies':
        if (!local) {
          view.expandReplies = !(view.expandReplies ?? state.expandReplies);

          try {
            localStorage.setItem(EXPAND, view.expandReplies ? '1' : '0');
          } catch {
            // A page without local storage keeps the choice until it reloads.
          }

          draw();
          break;
        }

        // On this computer's page, voice.expandReplies in settings.json; the checkbox and the replies follow the hub's `settings` event once the file is reloaded.
        expandAsked = !(expandAsked ?? state.expandReplies);

        if (expandSending === null) {
          void sendExpand();
        }

        break;
      case 'card-pick':
        pickCard(button!.dataset['card']!, button!.dataset['slug']!, button!.dataset['letter']!);
        break;
      case 'card-other':
        openOther(button!.dataset['card']!, button!.dataset['slug']!);
        break;
      case 'card-step':
        stepCard(button!.dataset['card']!, button!.dataset['slug']!);
        break;
      case 'card-back':
        stepCard(button!.dataset['card']!, 'back');
        break;
      case 'card-next':
        stepCard(button!.dataset['card']!, 'next');
        break;
      case 'card-send':
        void sendCard(button!.dataset['card']!);
        break;
      case 'card-menu': {
        const ui = cardUi(button!.dataset['card']!);

        ui.menuOpen = !ui.menuOpen;
        draw();
        break;
      }
      case 'card-dismiss': {
        const key = button!.dataset['card']!;
        const ui = cardUi(key);

        ui.menuOpen = false;
        draw();

        if (state.session !== null) {
          void command('card-dismiss', { sessionId: state.session.id, card: key, slug: button!.dataset['slug']! }).then((answer) => {
            if (answer.status !== 200) {
              ui.error = String(answer.body['error'] ?? 'Not dismissed.');
              draw();
            }
          });
        }

        break;
      }
      case 'goto-card': {
        const key = button!.dataset['targetCard']!;

        showLinked('conversation', () => [...document.querySelectorAll<HTMLElement>('.question-card')].find((card) => card.dataset['cardKey'] === key) ?? null);
        [...document.querySelectorAll<HTMLElement>('.question-card.qc')].find((card) => card.dataset['cardKey'] === key)?.focus({ preventScroll: true });
        break;
      }
      case 'goto-message':
        showLinked('conversation', () => [...document.querySelectorAll<HTMLElement>('.timeline li.message')].find((one) => one.dataset['id'] === button!.dataset['target']) ?? null);
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

    if (!field.classList?.contains('qc-other')) {
      return;
    }

    // Typing in Other keeps the page undrawn, so the field keeps its caret; the hub hears it once the typing pauses, and the buttons follow then.
    const key = field.dataset['card']!;
    const slug = field.dataset['slug']!;
    const card = cardNow(key);

    if (card === null) {
      return;
    }

    const draft = setOther(card, cardDraftOf(key), slug, field.value);

    cardUi(key).local = draft;
    clearTimeout(otherTimer ?? undefined);
    otherTimer = setTimeout(() => setDraft(key, cardDraftOf(key) ?? draft, true), OTHER_SETTLE_MS);
  });
  // The dropdown closes on a press outside the header and on Escape, which gives the focus back to its button.
  document.addEventListener('pointerdown', (event) => {
    if (changes.pointerDown(event.target)) {
      draw();
    }

    // A pool row's menu closes on a press outside it and its row, which toggles it itself.
    if (view.rowMenu !== null && !(event.target instanceof Element && event.target.closest('.pool-row') !== null)) {
      view.rowMenu = null;
      view.linkMenu = false;
      draw();
    }

    if (view.artifactMenu && !(event.target instanceof Element && event.target.closest('.artifact-more') !== null)) {
      view.artifactMenu = false;
      draw();
    }

    if ((view.picker || view.actions || view.providers !== null || view.viewMenu) && !(event.target instanceof Node && head.querySelector('.header')?.contains(event.target) === true)) {
      view.providers = null;
      view.picker = false;
      view.actions = false;
      view.viewMenu = false;
      draw();
    }
  });
  root.addEventListener('keydown', (event) => {
    // A question card's keys while it has the focus (design § 6): A–H pick, O opens Other, Enter goes on or sends, Backspace goes back.
    const cardEl = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('.question-card.qc') : null;

    if (cardEl !== null && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
      const key = cardEl.dataset['card']!;
      const card = cardNow(key);
      const inField = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
      const action = card === null || !(state.connected && state.session?.conversation === 'full') ? null : cardKeyAction(event.key, inField && event.key !== 'Enter');
      const step = card === null ? null : currentStep(card, cardDraftOf(key));

      if (action !== null && step !== null && !(inField && event.key === 'Enter' && event.shiftKey)) {
        // A button's own Enter clicks it.
        if (action.type === 'forward' && event.target instanceof HTMLButtonElement && !event.target.matches('.qc-other')) {
          return;
        }

        event.preventDefault();

        if (action.type === 'pick') {
          pickCard(key, step.question.slug, action.letter);
        } else if (action.type === 'other') {
          openOther(key, step.question.slug);
        } else if (action.type === 'back') {
          stepCard(key, 'back');
        } else {
          const steps = cardSteps(card!);

          if (steps.indexOf(step) === steps.length - 1) {
            setDraft(key, cardDraftOf(key) ?? { step: step.question.slug, picks: {} }, true);
            void sendCard(key);
          } else if ((cardDraftOf(key)?.picks[step.question.slug]?.letters.length ?? 0) > 0 || (cardDraftOf(key)?.picks[step.question.slug]?.other ?? '').trim() !== '') {
            stepCard(key, 'next');
          }
        }

        return;
      }
    }

    // The Changes tab's own keys, while the focus is in it (changes.tsx `key`).
    if (changes.key(event)) {
      event.preventDefault();
      return;
    }

    // Enter on a focused local file link opens it, as a click does.
    if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.matches('a.path-link[data-action="local-file"]')) {
      event.preventDefault();
      localFiles.click(event.target);
      return;
    }

    // Left and Right, Home and End move between a tab strip's tabs, as in a tab list; Enter or Space then chooses one.
    const tab = event.target instanceof HTMLElement && event.target.getAttribute('role') === 'tab' ? event.target : null;
    // A narrow strip hides some diff tabs (page.css), which cannot take the focus.
    const tabs = tab === null ? [] : [...(tab.closest('.tabs')?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].filter((one) => getComputedStyle(one.closest('.tab') ?? one).display !== 'none');

    if (tab !== null && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && tabs.length > 1) {
      const at = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;

      tabs[next]!.focus();
      event.preventDefault();
      return;
    }

    // Ctrl+Enter goes ahead in an input sheet, whose box takes several lines, as in the dock's dialog.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && view.sheet?.kind === 'input') {
      event.preventDefault();
      void sheetGo();
      return;
    }

    if (event.key === 'Escape' && view.personas !== null) {
      closePersonas();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && view.sheet !== null) {
      view.sheet = null;
      draw();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && view.artifactMenu) {
      view.artifactMenu = false;
      draw();
      root.querySelector<HTMLElement>('.artifact-menu-button')?.focus();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && view.rowMenu !== null) {
      const opener = view.rowMenu;

      view.rowMenu = null;
      view.linkMenu = false;
      draw();
      list.querySelector<HTMLElement>(`[data-action="pool-menu"][data-row="${opener}"]`)?.focus();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && (view.picker || view.actions || view.providers !== null || view.viewMenu)) {
      const opener = view.picker || view.providers !== null ? 'button.picker' : view.actions ? 'button.actions' : 'button.view-options';

      view.providers = null;
      view.picker = false;
      view.actions = false;
      view.viewMenu = false;
      draw();
      head.querySelector<HTMLElement>(opener)?.focus();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && changes.escape()) {
      draw();
      root.querySelector<HTMLElement>('.changes-files')?.focus();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && view.drawer !== null) {
      closeDrawer();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && panelMaximized) {
      // A console typing into its session stops its keys first (console.ts), so its Escape stays the session's.
      maximizePanel(false);
      event.stopImmediatePropagation();
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (view.picker || view.actions || view.providers !== null || view.viewMenu || view.rowMenu !== null)) {
      // Up and Down move between a header menu's rows, or a pool row's menu's, as in a VS Code menu.
      const rows = [...(view.rowMenu !== null ? list.querySelectorAll<HTMLElement>('.row-menu .menu-row') : head.querySelectorAll<HTMLElement>('.header .menu .menu-row'))];
      const at = rows.indexOf(document.activeElement as HTMLElement);

      if (rows.length > 0) {
        rows[at === -1 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]!.focus();
        event.preventDefault();
      }
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
  /** The list's row with this key, `item:<id>` or a pool ticket's `ticket:<id>`, or null. */
  const rowByKey = (key: string): PageRow | null => state.groups.flatMap((group) => group.rows).find((one) => rowKey(one) === key) ?? null;
  /** The hub's request fields that name a row: a work item's ID, or a pool ticket's. */
  const rowTarget = (row: PageRow): Record<string, number> => (row.workItemId !== null ? { workItemId: row.workItemId } : { ticketId: row.ticketId ?? -1 });
  /** Why a row's control did not run: over the composer for the open work item, over the list for a pool ticket, which has no conversation. */
  const refusedFor = (row: PageRow | null, why: string | null): void => {
    if (row !== null && row.workItemId === null) {
      listError = why;
      draw();
    } else {
      showError(why);
    }
  };
  /** Places a dragged Ready for review row after `after`, or first (PRD R73); the hub's list then shows the new order, or the list why not. */
  const moveRow = async (workItemId: number, after: number | null): Promise<void> => {
    const answer = await post('row-move', { workItemId, after });

    if (answer.status !== 200) {
      listError = String(answer.body['error'] ?? `Not moved (status ${answer.status}).`);
      draw();
    }
  };
  // Alt+Up and Alt+Down move the selected Ready for review row, as the dock's (PRD R73), with its Move up and Move down; not while typing.
  document.addEventListener(
    'keydown',
    (event) => {
      const up = event.key === 'ArrowUp';
      const typing = event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .console') !== null;

      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(up || event.key === 'ArrowDown') || typing || view.acting) {
        return;
      }

      const selected = state.scope?.workItemId ?? null;
      const row = state.groups.find((group) => group.key === 'review')?.rows.find((one) => one.workItemId !== null && one.workItemId === selected);
      const label = up ? 'Move up' : 'Move down';

      if (row !== undefined && row.actions.some((action) => action.label === label)) {
        event.preventDefault();
        void runAction(rowKey(row), label, {});
      }
    },
    { signal: listening.signal },
  );
  /** Closes the header's actions menu and a pool row's menu. */
  const closeMenus = (): void => {
    view.actions = false;
    view.rowMenu = null;
    view.linkMenu = false;
  };
  /**
   * Opens a row's ticket or link, an http or https URL from the hub's row, in a new tab; the installed app on this computer asks the
   * hub, which opens it in the default browser, since a link it opened itself would stay in the browser that installed it. A page on another
   * device opens it in its own browser, as the hub's browser is on the computer.
   */
  const openLink = (key: string, which: string): void => {
    const row = rowByKey(key);
    const url = row === null ? null : rowLink(row, which);
    const target = url === null ? null : tabUrl(url);

    if (view.actions || view.rowMenu !== null) {
      closeMenus();
      draw();
    }

    if (row === null || target === null) {
      return;
    }

    if (standalone() && paneLocal()) {
      void post('row-open', { ...rowTarget(row), url }).then((answer) => answer.status === 200 || refusedFor(row, String(answer.body['error'] ?? `The link did not open (status ${answer.status}).`)));
      return;
    }

    (deps.openUrl ?? ((one: string) => void window.open(one, '_blank', 'noopener,noreferrer')))(target);
  };
  /**
   * A control of a row's menu, the header's for the open work item or a pool ticket's in the list: Snooze… opens its choices, one that asks first
   * its question, one with an input its text, any other runs at once.
   */
  const chooseAction = (key: string, label: string): void => {
    const row = rowByKey(key);
    const action = row?.actions.find((one) => one.label === label);

    closeMenus();

    // A work item's controls run only on the open one, as the hub checks.
    if (row === null || action === undefined || view.acting || (row.workItemId !== null && row.workItemId !== selectedRow(state)?.workItemId)) {
      draw();
      return;
    }

    if (action.input !== null && action.input !== undefined) {
      view.sheet = { kind: 'input', row: key, label: action.label, input: action.input, text: action.input.text ?? '', picked: action.input.choice?.value ?? '' };
      draw();
      sheetHost.querySelector<HTMLTextAreaElement>('.sheet-input')?.focus();
      return;
    }

    if (action.action === 'snooze') {
      view.sheet = { kind: 'snooze', row: key, label: action.label, title: row.title, choices: snoozeChoices(new Date(deps.now())), picked: '0', date: '', comment: '' };
    } else if (action.confirm !== null) {
      view.sheet = { kind: 'confirm', row: key, action };
    } else {
      void runAction(key, action.label, {});
    }

    draw();
  };
  /** A row's VS Code control on the selected work item: the hub opens its window in VS Code, or says why not. */
  const runCommand = async (label: string): Promise<void> => {
    const row = selectedRow(state);

    closeMenus();

    if (row === null || view.acting) {
      draw();
      return;
    }

    view.acting = true;
    draw();

    const answer = await command('row-command', { workItemId: row.workItemId, label });

    view.acting = false;
    showError(answer.status === 200 ? null : String(answer.body['error'] ?? `Not done (status ${answer.status}).`));
    draw();
  };
  /**
   * Runs a row's control, named by its label: `row-action` on the selected work item, or `pool-action` on a pool ticket; the hub checks again that
   * its row still offers it.
   */
  const runAction = async (key: string, label: string, extra: Record<string, unknown>): Promise<void> => {
    const row = rowByKey(key);

    view.acting = true;
    draw();

    const answer = row === null ? { status: 409, body: { error: 'The row is gone.' } } : row.workItemId !== null ? await command('row-action', { workItemId: row.workItemId, label, ...extra }) : await post('pool-action', { ticketId: row.ticketId, label, ...extra });

    view.acting = false;
    view.sheet = null;
    refusedFor(row, answer.status === 200 ? null : String(answer.body['error'] ?? `Not done (status ${answer.status}).`));
    draw();
  };
  const sheetGo = async (): Promise<void> => {
    const sheet = view.sheet;

    if (sheet === null || view.acting) {
      return;
    }

    if (sheet.kind === 'confirm') {
      await runAction(sheet.row, sheet.action.label, {});
    } else if (sheet.kind === 'input') {
      if (!inputReady(sheet)) {
        sheetHost.querySelector<HTMLTextAreaElement>('.sheet-input')?.focus();
        return;
      }

      const choice = sheet.input.choice !== null && sheet.picked !== sheet.input.choice.value ? sheet.picked : null;

      await runAction(sheet.row, sheet.label, { text: sheet.text.trim(), ...(choice === null ? {} : { choice }) });
    } else if (sheet.kind === 'snooze') {
      const picked = sheet.picked;
      const until = picked === 'date' ? snoozeDateUntil(sheet.date, sheet.choices) : (sheet.choices[Number(picked)]?.until ?? null);
      const first = firstSnoozeDay(sheet.choices);

      if (picked === 'date' && (until === null || first === null || sheet.date < first)) {
        sheetHost.querySelector<HTMLInputElement>('.snooze-date')?.focus();
        return;
      }

      const comment = sheet.comment.trim();

      await runAction(sheet.row, sheet.label, { until, ...(comment === '' ? {} : { comment }) });
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

    // An input sheet keeps its text and choice, and enables its button as the dock's dialog does, without a redraw under the caret.
    if (sheet?.kind === 'input') {
      if (field.classList.contains('sheet-input')) {
        sheet.text = field.value;
      } else if (field.classList.contains('sheet-select')) {
        sheet.picked = field.value;
      }

      const go = sheetHost.querySelector<HTMLButtonElement>('[data-action="sheet-go"]');

      if (go !== null) {
        go.disabled = view.acting || !inputReady(sheet);
      }

      return;
    }

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

  /** The view options menu's persona row: the roster in the persona dialog, from which a pick pins a persona to the session. */
  const choosePersona = async (): Promise<void> => {
    view.viewMenu = false;
    view.picker = false;
    view.providers = null;
    view.actions = false;
    personaScope = state.scope?.scopeGen ?? null;
    view.personas = { items: null, error: null };
    draw();
    personaHost.querySelector<HTMLElement>('.persona-close')?.focus();

    const ask = ++personaAsks;
    const answer = await command('personas');

    // The dialog closed, or closed and opened again, or its conversation changed (drawRegions closes it then).
    if (view.personas === null || ask !== personaAsks || personaScope !== state.scope?.scopeGen) {
      return;
    }

    view.personas = answer.status === 200 ? { items: (answer.body['personas'] as NonNullable<View['personas']>['items']) ?? [], error: null } : { items: null, error: String(answer.body['error'] ?? 'Switchboard did not answer.') };

    if (view.personas.items?.length === 0) {
      view.personas = { items: null, error: 'No personas. Add them to voice.personas in settings.json, with voice.enabled on.' };
    }

    draw();

    // The current persona, else the first, takes the focus from Close once the roster shows, unless the operator moved it.
    if (document.activeElement === personaHost.querySelector('.persona-close')) {
      personaHost.querySelector<HTMLElement>('.persona-option.current, .persona-option')?.focus();
    }
  };

  // ---- The Chrome pane (architecture.md § Pane state): the installed page reports its right column, wakes and pairs the extension ----
  const toExtension =
    deps.toExtension ??
    ((extensionId: string, message: Record<string, unknown>): Promise<unknown> => {
      const runtime = (globalThis as { chrome?: { runtime?: { sendMessage?(id: string, message: unknown, callback: (answer: unknown) => void): void; lastError?: unknown } } }).chrome?.runtime;

      if (runtime?.sendMessage === undefined) {
        return Promise.resolve(null);
      }

      return new Promise((resolve) => runtime.sendMessage!(extensionId, message, (answer) => resolve(runtime.lastError === undefined ? (answer ?? null) : null)));
    });
  let paneSent = 'null';
  /** The Browser tab's area under its tab strip, while it is the tab shown; the Chrome pane covers it (architecture.md § Web page). */
  const browserArea = (): HTMLElement | null => {
    // The pane window stays above the page, so it hides while Settings, a sheet (the page's or the list header's) or History covers the page.
    const listSheet = root.querySelector('#list-sheet .sheet-backdrop') !== null;

    if (!showBrowser() || state.key === null || state.scope === null || view.sheet !== null || view.personas !== null || listSheet || settingsPane.isOpen() || shownHistory !== null) {
      return null;
    }

    return wide() ? (sideTab() === 'browser' ? detailBody : null) : mainTab() === 'browser' ? panel : null;
  };
  /**
   * Sends the Chrome pane's state, the Browser tab's area or null, when it changed, and with `force` whatever was sent before, so the pane's
   * visibility follows the tab shown even after a lost request; a request the hub did not take is sent again at the next report.
   */
  // Numbers each report, so the hub drops one that a later one overtook.
  let paneSeq = 0;
  /**
   * Whether a floating layer of the page is open: a menu, a dropdown, the composer's list, a sheet, a dialog, Settings or the work items'
   * drawer. The pane's window lies above the page, so it would cover the part of the layer over the Browser tab.
   */
  const floating = (): boolean => view.drawer !== null || contextMenu !== 'closed' || root.querySelector('.glass:not([hidden]), [role="menu"], [role="dialog"], [role="alertdialog"]') !== null;
  let floatingShown = false;
  let paneHold: ReturnType<typeof setTimeout> | null = null;
  /** Whether the pane stays hidden for a floating layer: at once while one is open, and until PANE_SHOW_DELAY_MS after the last closes, so a quick close and open again does not flicker it. */
  const paneCovered = (): boolean => {
    if (floating()) {
      floatingShown = true;

      if (paneHold !== null) {
        clearTimeout(paneHold);
        paneHold = null;
      }

      return true;
    }

    if (floatingShown) {
      floatingShown = false;
      paneHold = setTimeout(() => {
        paneHold = null;
        reportPane(true);
      }, PANE_SHOW_DELAY_MS);
    }

    return paneHold !== null;
  };
  paneHidden = () => floating() || paneHold !== null;
  /** Whether the Browser tab was last told the pane is hidden for a layer, so it is drawn again when that changes. */
  let noteCovered = false;
  const reportPane = (force = false): void => {
    // A page on another device cannot drive the pane; the hub refuses its reports. A closed page reports nothing more.
    if (!paneLocal() || listening.signal.aborted) {
      return;
    }

    // The pane follows the page as drawn, so an event's draw still waiting for its frame is made first.
    if (frame !== null) {
      draw();
    }

    const covered = paneCovered();

    if (covered !== noteCovered) {
      noteCovered = covered;
      // A layer can open or close without a redraw, as the composer's list does; the Browser tab then says so.
      if (browserArea() !== null) {
        queueMicrotask(draw);
      }
    }

    const area = covered ? null : browserArea();
    const box = area === null ? null : area.getBoundingClientRect();
    const rect = box === null || box.width === 0 ? null : { left: box.left, top: box.top, width: box.width, height: box.height, dpr: window.devicePixelRatio || 1, innerWidth: window.innerWidth, innerHeight: window.innerHeight };
    const text = JSON.stringify(rect);

    // Sent again whatever was sent only while the pane is on for this page; off, only a change goes.
    const again = force && view.pane?.enabled === true && paneLocal();

    if (again || text !== paneSent) {
      paneSent = text;
      paneSeq += 1;
      void post('pane-rect', { rect, seq: paneSeq }).then((answer) => {
        if (answer.status !== 200 && paneSent === text) {
          paneSent = '';
        }
      });
    }
  };
  const paneColumn = typeof ResizeObserver === 'function' ? new ResizeObserver(() => reportPane()) : null;

  paneColumn?.observe(detailBody);
  paneColumn?.observe(panel);
  // A layer can open or close without a redraw, as the composer's list does, so the page's changes are watched too, once a turn at most.
  let layersQueued = false;
  const layers = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (!layersQueued) {
      layersQueued = true;
      queueMicrotask(() => {
        layersQueued = false;
        reportPane();
      });
    }
  }) : null;

  layers?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  listening.signal.addEventListener('abort', () => {
    layers?.disconnect();

    if (paneHold !== null) {
      clearTimeout(paneHold);
    }
  });
  // A strip that widens or narrows fits another number of artifact tabs.
  let stripWidth = -1;
  const strips = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const width = (wide() ? detailHead : head).getBoundingClientRect().width;

    if (width !== stripWidth) {
      stripWidth = width;
      draw();
    }
  }) : null;

  strips?.observe(detailHead);
  strips?.observe(head);
  reportBrowser = () => {
    const force = forcePane;

    forcePane = false;
    reportPane(force);
  };
  // The pane's state is sent again when the page comes back to the front or into view, and hidden when the page goes away, as on a reload.
  window.addEventListener('focus', () => reportPane(true), { signal: listening.signal });
  document.addEventListener('visibilitychange', () => reportPane(true), { signal: listening.signal });
  // A page back from the back/forward cache, which sent null as it went, shows the pane again if Browser is its tab.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      reportPane(true);
    }
  }, { signal: listening.signal });
  window.addEventListener('pagehide', () => {
    if (view.pane?.enabled === true && paneLocal() && state.key !== null) {
      paneSent = 'null';
      paneSeq += 1;
      void post('pane-rect', { rect: null, seq: paneSeq }, true);
    }
  }, { signal: listening.signal });
  // Settings and the list header's sheets open and close without the page's draw.
  const settingsShown = typeof MutationObserver === 'function' ? new MutationObserver(() => reportPane()) : null;

  settingsShown?.observe(settingsHost, { childList: true, subtree: false, attributes: true });
  settingsShown?.observe(root.querySelector('#list-sheet')!, { childList: true, subtree: true });
  window.addEventListener('resize', () => reportPane());
  window.addEventListener('resize', fitMenus, { signal: listening.signal });
  // A scroll moves a menu's anchor; a menu's own scrolling does not.
  document.addEventListener('scroll', (event) => (event.target instanceof Element && event.target.closest('.menu') !== null ? undefined : fitMenus()), { capture: true, signal: listening.signal });
  // A move to a monitor of another scale changes devicePixelRatio without a resize of the column in CSS pixels.
  const watchScale = (): void => {
    if (typeof window.matchMedia === 'function') {
      window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener?.(
        'change',
        () => {
          reportPane();
          watchScale();
        },
        { once: true },
      );
    }
  };

  watchScale();

  const wake = (): void => {
    if (view.pane?.enabled === true && view.pane.extension === 'none' && view.pane.extensionId !== undefined && standalone()) {
      void toExtension(view.pane.extensionId, { type: 'wake' });
    }
  };
  const paneWake = setInterval(wake, PANE_WAKE_MS);
  let paneWasOn = false;
  const paneChanged = (): void => {
    const on = view.pane?.enabled === true;

    // A new stream's key has no report yet; turning the pane on starts one.
    if (on !== paneWasOn) {
      paneWasOn = on;
      paneSent = on ? '' : paneSent;
    }

    wake();
    reportPane();
  };
  const pairPane = async (): Promise<void> => {
    view.paneNote = 'Pairing…';
    draw();

    const answer = await post('pane-pair', {});
    const token = answer.body['token'];
    const extensionId = answer.body['extensionId'];

    if (answer.status !== 200 || typeof token !== 'string' || typeof extensionId !== 'string') {
      view.paneNote = String(answer.body['error'] ?? `Pairing failed (status ${answer.status}).`);
    } else {
      const reply = (await toExtension(extensionId, { type: 'pair', token })) as { ok?: unknown; error?: unknown } | null;

      view.paneNote = reply === null ? 'The Switchboard Chrome extension is not installed in this browser, or is an older build.' : reply.ok === true ? 'Sent to the Chrome extension.' : String(reply.error ?? 'The Chrome extension refused.');
    }

    draw();
  };

  // ---- The stream ----
  // The installed app says so, since a dock click with `dock.openIn: web` shows its work item there (architecture.md § Web page).
  // The hub routes needs-you alerts to a page only once it may show notifications, so the page says when that changes.
  askForNotifications(document, () => reportFocus(true));
  const installedApp = deps.standalone?.() ?? (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
  const source = new deps.EventSource(installedApp ? '/v1/conversation/events?page=1&installed=1' : '/v1/conversation/events?page=1');

  for (const type of EVENTS) {
    source.addEventListener(type, (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { type: string } & Record<string, unknown>;
      const keyBefore = state.key;

      state = applyEvent(state, data);

      if (type === 'hello') {
        expired = false;

        // The artifacts a work item has when this device first sees it count as opened; only later ones are new.
        if (state.scope?.workItemId != null && (readArtifactsSeen() ?? artifactsSeen)[String(state.scope.workItemId)] === undefined) {
          artifactsOpened(state.artifacts.map((artifact) => artifact.path));
        }

        // A new stream has a new key, unbound: the page selects its work item again.
        if (state.key !== keyBefore) {
          focusSent = null;
          reportFocus(true);
        }

        if (state.key !== keyBefore) {
          acked = null;
          selectInFlight = false;
          // After a hub restart the voice comes back to this phone over the new stream's key (architecture.md § Hub lifecycle).
          phoneVoice?.keyChanged();
        }

        reconcile();
      }

      // Dictation (architecture.md § Dictation): live words show dimmed after the box's text; the hub's draft fills the box unless the operator typed over it.
      // An open History reads again soon after the list changed, as the History tab does after a stream state.
      if (type === 'list' && shownHistory !== null && historyChange === null) {
        historyChange = setTimeout(() => {
          historyChange = null;
          void readHistory();
        }, HISTORY_CHANGE_MS);
      }

      // Another device ticked a changed file viewed, or cleared its tick (architecture.md § Web page).
      if (type === 'viewed') {
        changes.viewedEvent(data);
      }

      // settings.json changed on disk: Settings reads it again, keeping unsaved edits under the dock's changed-on-disk warning (PRD R54).
      // With no save in flight, the hub's settings hold what Expand replies asked for, or a newer change.
      if ((type === 'settings' || type === 'hello') && expandSending === null) {
        expandAsked = null;
      }

      if (type === 'config') {
        void settingsPane.reload();
      }

      if (type === 'pane') {
        // The pane glues a window on the computer that runs Switchboard, so a page on another device has none: no menu rows, no Browser tab.
        view.pane = paneLocal() ? ((data['pane'] as PaneView | undefined) ?? null) : null;
        paneChanged();
      } else if (type === 'hello' || type === 'scope') {
        // A new key or work item: the hub reads the column, and the work item's tabs, again.
        paneSent = view.pane?.enabled === true ? '' : 'null';
        setTimeout(reportPane, 0);
      }

      // A dock click shows its work item here, as a click on its row would (architecture.md § Dock).
      if (type === 'show' && typeof data['workItemId'] === 'number') {
        showMarker = typeof data['marker'] === 'string' ? data['marker'] : null;
        clearTimeout(showTimer);
        showTimer = setTimeout(() => {
          showMarker = null;
          draw();
        }, SHOW_MARKER_MS);
        void select(data['workItemId']);
      }

      // The hub chose this page to raise needs-you alerts (alerts.surface, PRD R65): the message under the list's header, as in the dock's toast,
      // a notification per work item, and the chime when nothing else sounds.
      if (type === 'needs' && Array.isArray(data['items'])) {
        header.needs(data['items'] as NeedsItem[]);
        notifyNeeds(data['items'] as NeedsItem[], (workItemId) => void select(workItemId));

        if (data['sound'] === true) {
          playChime();
        }
      }

      // The hub's drafts now hold what this page changed, unless a change is still on its way.
      if (type === 'questions') {
        for (const ui of view.cards.values()) {
          if (ui.pending === 0) {
            ui.local = null;
          }
        }
      }

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
          card.sentId = null;
          card.error = error;
        } else if (isAnswerMessage(message.text)) {
          // An answer message's questions reopen with their picks; its text never goes into the composer.
          mine.delete(message.id);
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

      // A new stream sends the pane's state again.
      if (type === 'hello') {
        forcePane = true;
      }

      // The hub's tabs for the work item: in each `hello`, and from another device in `tabs`.
      if (type === 'hello' && state.scope?.workItemId != null) {
        const tabs = data['tabs'] as { tab: string | null; closed: Array<{ path: string; updatedAt: number }> } | null | undefined;

        savedTabs = tabs == null ? null : { workItemId: state.scope.workItemId, tab: tabs.tab, closed: tabs.closed };
        openOn = data['openOn'] === 'status' || data['openOn'] === 'browser' ? data['openOn'] : null;
      } else if (type === 'tabs' && data['workItemId'] === state.scope?.workItemId) {
        const tabs = data['tabs'] as { tab: string | null; closed: Array<{ path: string; updatedAt: number }> };

        savedTabs = { workItemId: data['workItemId'] as number, tab: tabs.tab, closed: tabs.closed };
      }

      // The artifact shown here closed on another device, as a `tabs` event or a new `hello` tells: Status shows.
      if ((type === 'tabs' || type === 'hello') && view.artifact !== null && closedNow().has(view.artifact)) {
        view.artifact = null;
        view.side = view.side === 'artifacts' ? 'status' : view.side;
        view.tab = view.tab === 'artifacts' ? 'status' : view.tab;
      }

      // A work item opened anew, or the pane's state known before the operator chose a tab on it: its opening tabs (`openTabs`).
      const opened = state.scope?.workItemId ?? null;

      // The hub sends `scope` before the `hello` that carries the work item's tabs and artifacts, so a work item opens on its `hello`.
      if ((type === 'hello' && opened !== openedItem) || (type === 'pane' && !tabChosen && !paneKnown)) {
        openedItem = opened;
        tabChosen = false;
        openTabs();
      }

      // A burst of events, such as a long history read, draws once per frame, not once per event.
      drawSoon();

      if (type === 'session' || type === 'hello') {
        void readPrompt();
      }
    });
  }

  const lost = reconnector({
    fetch: (url, init) => deps.fetch(url, init),
    setTimeout: (run, ms) => setTimeout(run, ms),
    reload: deps.reload ?? (() => location.reload()),
    build: deps.build ?? null,
    // A reload would end the phone's audio until its next tap, so it waits while the voice is on this phone or coming back to it.
    hold: () => phoneVoice !== null && phoneVoice.state !== 'off',
  });

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
      // A draw still asked for would draw the closed page.
      if (frame !== null) {
        frame.cancelled = true;
        frame = null;
      }

      clearInterval(seenTimer);
      clearInterval(historyTick ?? undefined);
      clearTimeout(historyChange ?? undefined);
      clearInterval(paneWake);
      paneColumn?.disconnect();
      strips?.disconnect();
      settingsShown?.disconnect();
      clearInterval(promptTimer);
      clearTimeout(showTimer);
      // A start still pending neither redraws nor reports its timing from a closed page.
      micStart.clear();
      micTiming = null;
      listening.abort();
      dropDrawer();
      dropFileIcons();
      header.close();
      source.close();

      for (const mounted of consoles.values()) {
        mounted.dispose();
      }

      consoles.clear();
    },
  };
}

/** Whether a history entry's state marks a phone's conversation (`CONVERSATION_ENTRY`). */
/** Whether enough of an element shows in its scrolling area to be seen: all of it, or 40 px of a taller one. */
function inView(element: HTMLElement, area: HTMLElement): boolean {
  const box = element.getBoundingClientRect();
  const shown = area.getBoundingClientRect();

  return box.height > 0 && Math.min(box.bottom, shown.bottom) - Math.max(box.top, shown.top) >= Math.min(box.height, 40);
}

/** How long a card or a message an answer links to stays highlighted. */
const FLASH_MS = 1_600;

/** Highlights a card or a message an answer links to for a moment, as the Conversation view does. */
function flash(element: HTMLElement): void {
  element.classList.remove('linked');
  void element.offsetWidth;
  element.classList.add('linked');
  setTimeout(() => element.classList.remove('linked'), FLASH_MS);
}

function conversationEntry(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[CONVERSATION_ENTRY] === true;
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

/** Mermaid's options: strict, drawn on demand, in its `default` theme while the operating system is light and its `dark` one otherwise. */
export function mermaidOptions(): { startOnLoad: false; securityLevel: 'strict'; theme: 'default' | 'dark' } {
  const light = typeof matchMedia === 'function' && matchMedia(LIGHT_SCHEME).matches;

  return { startOnLoad: false, securityLevel: 'strict', theme: light ? 'default' : 'dark' };
}

/** The diff viewer's build this page was built with, its folder under `/page/diff/` (`packages/web/build.mjs`). */
declare const __DIFF_BUILD__: string | undefined;

/** Loads the diff viewer's modules from the hub, the build this page was built with; null when the hub has none. */
export function loadDiff(): Promise<DiffModule | null> {
  const url = `/page/diff/${typeof __DIFF_BUILD__ === 'string' ? __DIFF_BUILD__ : 'none'}/diff.js`;

  return import(url).then(
    (module) => module as DiffModule,
    () => null,
  );
}

/** Loads Mermaid from the hub once, for diagrams in replies, statuses and artifacts; false when the hub has none. */
export function loadMermaid(): Promise<boolean> {
  return new Promise((resolve) => {
    const script = document.createElement('script');

    script.src = '/page/mermaid.min.js';
    script.onload = () => {
      const mermaid = (globalThis as { mermaid?: { initialize(options: object): void } }).mermaid;

      mermaid?.initialize(mermaidOptions());
      resolve(mermaid !== undefined);
    };
    script.onerror = () => resolve(false);
    document.head.append(script);
  });
}

/**
 * A sash that sets a pane's width (architecture.md § Web page): dragged, or with Left and Right (`SASH_STEP`, four times that with Shift), Home
 * and End while it has the focus; the width goes into a CSS property on the root, kept in local storage under `key` and set before the page
 * is first drawn, so the page does not jump. A double-click returns to the default and forgets it. Several sashes may set one pane's width.
 */
/**
 * Lets a sash set its pane's width, between `min` and `max`, kept in local storage under `key`; a drag or a key stops at `limit()` too, though
 * never below `min`, while a kept width is taken as it is. `changed` runs after each width kept. Returns the width set, or null for the default.
 */
function resizer(
  root: HTMLElement,
  sashes: HTMLElement | HTMLElement[],
  pane: HTMLElement,
  { property, key, min, max, limit, changed }: { property: string; key: string; min: number; max: number; limit?: () => number; changed?: () => void },
): { width(): number | null } {
  const all = Array.isArray(sashes) ? sashes : [sashes];
  /** The width set, or null for the default. */
  let width: number | null = null;
  /** The pane's width as drawn, without its border, which the page's width can hold below the width set. */
  const drawn = (): number => pane.clientWidth || (width ?? pane.getBoundingClientRect().width);
  /** The most a drag or a key may set now. */
  const most = (): number => Math.max(min, Math.min(max, limit?.() ?? max));
  const set = (next: number | null, keep: boolean, cap = max): void => {
    width = next === null ? null : Math.round(Math.min(cap, Math.max(min, next)));

    if (width === null) {
      root.style.removeProperty(property);
    } else {
      root.style.setProperty(property, `${width}px`);
    }

    for (const sash of all) {
      if (width === null) {
        sash.removeAttribute('aria-valuenow');
      } else {
        sash.setAttribute('aria-valuenow', String(pane.clientWidth || width));
      }
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

      changed?.();
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

  for (const sash of all) {
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
      const cap = most();
      const before = width;
      const move = (next: PointerEvent): void => set(next.clientX - left, false, cap);
      const end = (event: PointerEvent): void => {
        sash.removeEventListener('pointermove', move);
        sash.removeEventListener('pointerup', end);
        sash.removeEventListener('pointercancel', end);
        sash.classList.remove('dragging');
        root.classList.remove('resizing');

        // A drag the browser cancelled keeps nothing: the width goes back to where it was.
        if (event.type === 'pointercancel') {
          set(before, false);
          return;
        }

        set(drawn(), true, cap);
      };

      sash.addEventListener('pointermove', move);
      sash.addEventListener('pointerup', end);
      sash.addEventListener('pointercancel', end);
    });
    sash.addEventListener('dblclick', () => set(null, true));
    sash.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? SASH_STEP * 4 : SASH_STEP;
      const now = drawn();
      const cap = most();
      const next = { ArrowLeft: now - step, ArrowRight: now + step, Home: min, End: cap }[event.key];

      if (next !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        set(next, true, Math.max(cap, Math.min(max, now)));
      }
    });
  }

  return { width: () => width };
}
