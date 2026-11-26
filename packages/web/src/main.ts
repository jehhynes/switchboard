import { applyEvent, commandQuery, EMPTY, mentionOf, mentionQuery, pageTitle, rowLink, selectedEntry, selectedRow, sentTexts, tabUrl, withEarlier } from './model.js';
import { snoozeChoices } from '@switchboard/core/snooze';
import { BROWSER_EXTENSION_ID } from '@switchboard/core/hubRecord';
import type { PageState } from './model.js';
import { MENU_MAX_WIDTH, menuPlace, placeMenus } from '@switchboard/conversation/menuPlace';
import { escape, renderMarkdown, webLink } from './markdown.js';
import { ARTIFACTS_SEEN, artifactShow, artifactUrl, openArtifactsSeen, parseArtifactsSeen, unknownSeen, unreadArtifacts, textArtifactHtml, bandOpen, closedArtifacts, collapsedGroups, firstSnoozeDay, GROUPS_KEY, inputReady, renderMicButton, markdownBody, newView, rowKey, renderVoice, snoozeDateUntil, TABS, consoleNote, hasConsole, SIDE_TABS } from './render.js';
import type { CardDraft, NewDraft, SideTab, Tab, View } from './render.js';
import type { ConsoleOptions, MountedConsole } from './console.js';
import { LIGHT_SCHEME } from './console.js';
import type { ArtifactView, ItemView, PageRow, ScreenPrompt } from '@switchboard/protocol';
import { mount, unmount } from './island.js';
import type { ComponentChild, VNode } from 'preact';
import { renderList, renderListPane, sourceIcons } from './list.js';
import { rowDrag } from './reorder.js';
import type { DragView } from './reorder.js';
import { menuRows, renderHeader, renderMaximize, renderSideSwitch, renderTabs } from './header.js';
import { CHAT_MIN, chatNeed, fitLayout, isPhone, sideLimit, sideWidth, type Layout } from './layout.js';
import { pageLedger, renderTimeline } from './timeline.js';
import { fitFade } from './replyFade.js';
import { cardSteps, currentStep, draftAnswers, moveStep, pickLetter, picked, sendLabel, setComment } from '@switchboard/conversation/questions';
import type { CardDraft as SharedDraft, LedgerCard } from '@switchboard/conversation/questions';
import { cardKeyAction, isAnswerMessage, questionsWaiting } from '@switchboard/conversation/questionCard';
import { renderArtifacts, renderArtifactView, renderEmpty } from './side.js';
import { renderPersonaDialog } from './personas.js';
import { renderSheet } from './sheet.js';
import { toast } from './toast.js';
import { composerOptionId, renderComposer, renderComposerMenu, renderDraftNote, renderEndedNote, renderFrame, renderShared } from './composer.js';
import { composerInput } from './composerInput.js';
import { listHeader } from './listHeader.js';
import { modalLayers } from './layers.js';
import { PhoneVoice } from './phoneVoice.js';
import { MicStart } from '@switchboard/conversation/voiceControls';
import { browserBackPreview, swipeBack } from './swipeBack.js';
import { settings } from './settings.js';
import { attachments, drawChips } from './attachments.js';
import type { Attached } from './attachments.js';
import { Connection } from './connection.js';
import { COMMAND_MS, CONVERSATION_CHANGED, FAILURE_TEXT, NAVIGATION_MS, READ_MS, request, timedFetch, transient, UPLOAD_MS } from './request.js';
import type { Answer } from './request.js';
import { dotView, renderBanner, renderScreen, renderUpdate } from './connectionView.js';
import type { ConnectionView } from './connectionView.js';
import { renderOpening, renderOpeningHead, renderOpeningSide, renderOpeningTabs } from './opening.js';
import { closable, stripTabs } from './tabs.js';
import type { DocTab, TabFit } from './tabs.js';
import type { Opening } from './opening.js';
import { LIST_HASH, parseRoute, parseScrolls, parseTabSets, ROUTE_KEY, routeHash, SCROLL_KEY, startRoute, tabSetKey, TABS_KEY, withScroll, withTabSet } from './route.js';
import type { Route, ScrollPlace, TabSet } from './route.js';
import { renderContextMeter } from '@switchboard/conversation/contextMeter';
import type { ContextMenuState } from '@switchboard/conversation/contextMeter';
import { EMPTY_HISTORY_UI, expandable, needsYou, renderHistory } from './history.js';
import type { HistoryHead, HistoryOpen, HistoryUi } from './history.js';
import type { HistoryCategory, HistoryView } from '@switchboard/protocol';
import { askForNotifications, notificationsAllowed, notifyNeeds, playChime } from './alerts.js';
import { ChangesController } from './changes.js';
import { LocalFilesController } from './localFiles.js';
import { artifactTarget, decodedTarget, fileTabLink, localFileUrl, watchPictures } from './localLinks.js';
import type { DiffModule } from './diff/types.js';
import { useFileIcons } from './fileIcons.js';
import type { NeedsItem } from './alerts.js';
import { IframeBrowser, canInstallExtension, frameCover, frameUrl, frameLinks, IFRAME_EXTENSION_ID, IFRAME_RENEW_MS } from './iframeBrowser.js';
import type { FrameCover } from './iframeBrowser.js';
import type { BrowserIdentity } from './iframeBrowser.js';

/** The Actions menu's control that starts VS Code on the work item (`OPEN_IN_VSCODE` in the hub's page.ts); History's folder links run it too. */
const OPEN_IN_VSCODE = 'Open in VS Code';

/** The stream's event types the page reads. */
/** How long typing in a card's Comment field pauses before the hub hears it. */
export const COMMENT_SETTLE_MS = 400;

export const EVENTS = ['tabs', 'hello', 'list', 'scope', 'conversations', 'session', 'message', 'reply', 'state', 'artifact', 'unread', 'voice', 'settings', 'progress', 'words', 'draft', 'questions', 'needs', 'config', 'viewed'];
/** How long an unread reply or state must be visible on a focused page before it counts as seen (architecture.md § Unread). */
export const SEEN_MS = 1_000;
const SEEN_CHECK_MS = 250;
const COMPOSER_MAX_PX = 200;
/** How long the composer says a message sent from the History or Artifacts tab went. */
export const SENT_NOTE_MS = 4_000;
/** How often the page reads the prompt a session waits on in its terminal while it waits. */
export const PROMPT_POLL_MS = 1_000;
/** How long the box's draft waits before the hub hears it. */
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
/** A paired device's own Collapse details, '1' or '0'; this computer's page keeps it in settings.json instead. */
const BRIEF = 'switchboard.briefReplies';
/** The Expand replies a paired device kept before Collapse details replaced it, read as its inverse until Collapse details is first toggled there. */
const EXPAND = 'switchboard.expandReplies';
/** Where an earlier page kept the conversation's text size, which is now fixed; removed on load. */
const OLD_TEXT_SCALE = 'switchboard.textScale';
const CHAT_WIDTH = 'switchboard.chatWidth';
/**
 * The drawer's timing, carried over from the retired dock's auto-hide: a pointer resting on the sliver this long shows it, and a drawer shown that way hides once
 * nothing has kept it open for `DRAWER_HIDE_MS`, checked every `DRAWER_TICK_MS`.
 */
export const DRAWER_REVEAL_MS = 500;
export const DRAWER_HIDE_MS = 400;
const DRAWER_TICK_MS = 100;
/** How often an open History reads the hub again, so its times stay current, and how soon after a list change. */
export const HISTORY_REFRESH_MS = 30_000;
/** How often an open file tab in view is read again; an unchanged file answers 304. */
export const FILE_POLL_MS = 2_000;
export const FRAME_SHOW_DELAY_MS = 100;
/** The longest a page layer's transition or animation is followed frame by frame for the website frame's holes. */
export const LAYER_MOVE_MS = 1_000;
/** How long the page waits for the browser extension to say it opened a link before opening a tab itself, within a click's activation. */
export const LINK_ANSWER_MS = 2_000;
/** How much sooner the extension stops starting a link the page asked for than the page stops waiting. */
const LINK_MARGIN_MS = 500;
const HISTORY_CHANGE_MS = 1_000;
/** How long a press on a row's waiting questions waits for its work item's card to be drawn before it leaves the conversation where it opened. */
const CARD_WAIT_MS = 5_000;
/** At most this many earlier pages of the conversation are read to reach that card. */
const CARD_PAGES_MAX = 20;
/** The mark on the history entry a phone's conversation adds over the list, so the browser's back returns to the list (architecture.md § Web page). */
const CONVERSATION_ENTRY = 'switchboardConversation';
/** Where the page keeps the `opId` of each message sent without a settled answer, over a reload. */
const SEND_OPS = 'switchboard.sendOps';
/** Where the page keeps each work item's draft, over a reload. */
const DRAFTS = 'switchboard.drafts';
/** Where the page keeps New conversation…'s draft, by work item, with its provider and opId, over a reload. */
const NEW_DRAFTS = 'switchboard.newDrafts';

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
  /** How often an open file tab in view is read again; `FILE_POLL_MS` when left out. */
  filePollMs?: number;
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
  /** Whether this browser can install the Switchboard extension (`canInstallExtension`); read from `navigator` when left out. */
  extensionInstallable?(): boolean;
  /** Runs a draw before the next repaint; `requestAnimationFrame` when left out. */
  frame?(run: () => void): void;
}

/** A local storage value, or null without local storage. */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** How long a message's send is tried again on a transient failure, with the same `opId`, and how long one try may take. */
export const SEND_RETRY_MS = 30_000;
export const SEND_TRY_MS = 10_000;

/** What the console's script, `console.js`, offers once loaded (architecture.md § Web page). */
export interface ConsoleModule {
  mount(host: HTMLElement, options: ConsoleOptions): MountedConsole;
}

/**
 * The web page (architecture.md § Web page): the list of work items on the left; the selected one's conversation, History and artifacts tabs and
 * the composer on the right. Everything it shows comes from its own conversation stream, bound to the work item it selected.
 */
export function startPage(root: HTMLElement, deps: PageDeps): { state(): PageState; close(): void } {
  // Every request ends within its time (request.ts): the page's controllers read through `readFetch`, uploads through `uploadFetch`.
  const timers = { fetch: deps.fetch, setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>) };
  const readFetch = timedFetch(timers, READ_MS);
  const uploadFetch = timedFetch(timers, UPLOAD_MS);
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
  // The list header's sheets (listHeader.tsx), at the page's root like the others, so no column's stacking or display hides them.
  const listSheet = root.querySelector<HTMLElement>('#list-sheet')!;
  // The persona dialog over the whole page, as Settings is.
  const personaHost = root.appendChild(document.createElement('div'));
  // The toast over the page (toast.tsx): every refusal and failure, a copy that worked and the needs-you message.
  const toastHost = root.appendChild(document.createElement('div'));

  toastHost.id = 'toast';

  const toastBox = toast(toastHost, { open: (workItemId) => void select(workItemId) });
  // The scope generation the persona dialog opened for, and each opening's number, so a late roster answer fills only the dialog that asked.
  let personaScope: number | null = null;
  let personaAsks = 0;
  const detailHead = root.querySelector<HTMLElement>('#detail .detail-head')!;
  const detailBody = root.querySelector<HTMLElement>('#detail .detail-body')!;
  // The open work item takes the room first (layout.ts): the list is a column while the operator keeps it pinned, and a drawer otherwise;
  // History and Artifacts are a column only while they and the conversation fit, and tabs otherwise. A layout choice an earlier page kept is
  // dropped.
  localStorage.removeItem('switchboard.layout');
  let layout: Layout | null = null;
  const wide = (): boolean => layout?.wide === true;
  // The installed page, as Chrome opens it from its own window; only it reports a column for embedded tabs (architecture.md § Web page).
  const standalone = (): boolean => deps.standalone?.() ?? (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);

  // The work items' and the conversation's widths (architecture.md § Web page), each set on a sash: the work items' on their edge, or on the
  // open drawer's, the conversation's between it and the History and Artifacts column, which takes the rest of the width. A drag only sets a
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
   * Whether the History and Artifacts column covers the whole page, list and conversation too, for a wide artifact or diff; until restored,
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

    // The History and Artifacts column is maximized only while it is a column.
    panelMaximized &&= next.wide;
    root.classList.toggle('maximized', panelMaximized);

    return changed;
  };

  relayout();
  const localPage = (): boolean => deps.local ?? ['127.0.0.1', 'localhost'].includes(location.hostname);
  /** Whether this browser can install the extension embedded link tabs need, as desktop Chrome and Edge can, and a phone's or Safari's cannot. */
  const installable =
    deps.extensionInstallable?.() ??
    canInstallExtension({
      userAgent: navigator.userAgent,
      userAgentData: (navigator as Navigator & BrowserIdentity).userAgentData,
      ...(typeof window.matchMedia === 'function' ? { finePointer: window.matchMedia('(any-pointer: fine)').matches } : {}),
    });
  /** Whether the extension answered that it embeds this page's links, kept as the embedded browser reports it (`changed`). */
  let embedReady = false;
  /**
   * Whether this page shows embedded link tabs: they are enabled, and this browser can install the extension or has it answering. Where it can
   * do neither, as on an iPhone, the page makes no Browser tabs and never asks for the extension; its links open as ordinary links do.
   */
  const browserTab = (): boolean => state.iframeBrowser === true && (installable || embedReady);
  /** Opens a link in a new browser tab, through `deps.openUrl` when given. */
  const openNewTab = (url: string): void => (deps.openUrl ?? ((one: string) => void window.open(one, '_blank', 'noopener,noreferrer')))(url);
  /** Whether this browser's Switchboard extension answered that it opens the page's links in its Switchboard tab group (architecture.md § Browser extension). */
  let extensionLinks = false;
  /**
   * Opens a web link in the extension's Switchboard tab group, one tab per kind, while the extension answers and no embedded link tab shows
   * the links; runs `otherwise` without the extension, or when the extension does not open it.
   */
  const openTab = (url: string, otherwise: () => void): void => {
    if (!extensionLinks) {
      otherwise();
      return;
    }

    // Chrome keeps a click's activation for about five seconds, so `otherwise` waits at most LINK_ANSWER_MS for the answer and can still open
    // a tab. An extension that does not answer in time is not asked again until it answers the next `links` probe.
    let settled = false;
    const fallBack = (): void => {
      if (!settled) {
        settled = true;
        otherwise();
      }
    };
    const late = setTimeout(() => {
      extensionLinks = false;
      fallBack();
    }, LINK_ANSWER_MS);

    // The extension refuses a link whose turn comes after `until`, on the same computer's clock, so a slow open seldom lands beside the page's own tab.
    void toExtension(BROWSER_EXTENSION_ID, { type: 'open', url, until: deps.now() + LINK_ANSWER_MS - LINK_MARGIN_MS }).then((answer) => {
      clearTimeout(late);

      if ((answer as { opened?: unknown } | null)?.opened === true) {
        settled = true;
      } else {
        fallBack();
      }
    });
  };
  let linkItem: number | null = null;
  const itemLinks = (): boolean => frameLinks(selectedRow(state)).length > 0 || (linkItem !== null && linkItem === state.scope?.workItemId);
  /** Whether the Browser tab shows: embedded tabs enabled for this page, and links of the open work item to show; the operator's History or Browser choice stays. */
  const showBrowser = (): boolean => browserTab() && itemLinks();
  /** Whether the Console tab shows: an active session, not ended, that the terminal holder may hold; otherwise its console would be blank, so there is no tab. */
  const showConsole = (): boolean => hasConsole(state.session);
  /** Whether the open work item's row offers its ticket's History, which the History tab reads under the state. */
  const offersHistory = (): boolean => (selectedRow(state)?.history ?? null) !== null;
  /** The work item whose History a row's menu chose before its `hello` came, to open once its kept tabs are back. */
  let historyOnHello: number | null = null;
  /** The tab the conversation's pane shows: always the conversation while the column has its own place, and never a Browser tab that is gone. */
  const mainTab = (): Tab => (wide() || (view.tab === 'browser' && !showBrowser()) || (view.tab === 'artifacts' && openArtifact() === null) || (view.tab === 'diff' && !changes.view.tab) || (view.tab === 'file' && localFiles.shown() === null) ? 'conversation' : view.tab === 'console' && !showConsole() ? 'history' : view.tab);
  /** The work item whose tabs were last chosen on its opening, and whether the operator has chosen a tab since. */
  let openedItem: number | null = null;
  let tabChosen = false;
  /** The open work item's tabs as the hub keeps them for every device (`page-tabs`), or null before any was chosen. */
  let savedTabs: { workItemId: number; tab: string | null; closed: Array<{ path: string; updatedAt: number }> } | null = null;
  /** Which artifact versions this device has shown (`ArtifactsSeen`), read again when another of its pages keeps a change. */
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
   * Keeps artifacts of the open work item shown on this device at their versions, merged with what its other pages kept since, so two pages
   * showing different ones keep both.
   */
  const artifactsOpened = (artifacts: ReadonlyArray<Pick<ArtifactView, 'path' | 'updatedAt'>>): void => {
    const workItemId = state.scope?.workItemId;

    if (workItemId == null) {
      return;
    }

    const kept = readArtifactsSeen() ?? artifactsSeen;
    const next = openArtifactsSeen(kept, workItemId, artifacts);

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
      const browserUseful = (): boolean => {
    const row = selectedRow(state);

    return browserTab() && (iframe.ready) && row !== null && itemLinks();
  };
  const browserFirst = (): boolean => browserUseful() && state.session === null;
  /** The tab every work item opens on, History or Browser, as the operator last chose it on any device; null before any choice. */
  let openOn: 'history' | 'browser' | null = null;
  /**
   * The tabs a work item opens on: Console or an artifact kept for it while it still applies; otherwise Browser when embedded tabs has links of
   * the work item to show and the operator last chose Browser, or the work item has no state yet, or before any choice when it also has no
   * session yet; otherwise History. That is the column's tab; where the column folds into the conversation's tabs, the work item opens on the
   * Conversation tab.
   */
  const openTabs = (): void => {
    const saved = savedTabs?.workItemId === state.scope?.workItemId ? savedTabs?.tab : null;
    const path = saved?.startsWith('artifact:') === true ? saved.slice('artifact:'.length) : null;
    const kept: Tab | null = saved === 'console' && showConsole() ? 'console' : path !== null && state.artifacts.some((one) => one.path === path) && !closedNow().has(path) ? 'artifacts' : null;
    // A work item with no state yet opens on Browser whatever was chosen before.
    const reported = state.state !== null;
    const browser = openOn === 'browser' || !reported ? browserUseful() : openOn === null && browserFirst();
    const chosen: Tab = kept ?? (browser ? 'browser' : 'history');

    view.side = chosen as SideTab;
    view.tab = !wide() || chosen === 'history' ? 'conversation' : chosen;
    view.artifact = chosen === 'artifacts' ? path : null;
  };
  /**
   * Keeps the operator's choice in the hub, for every device: History or Browser as the tab every work item opens on, and Console or an artifact for
   * the open work item.
   */
  const saveTab = (): void => {
    const workItemId = state.scope?.workItemId ?? null;
    const shown = wide() ? sideTab() : mainTab();

    // The Changes tab or a file tab lasts as long as the page shows the work item, so it is not kept.
    if (workItemId === null || shown === 'conversation' || shown === 'diff' || shown === 'file') {
      return;
    }

    if (shown === 'history' || shown === 'browser') {
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
    const change = closed ? { path, updatedAt: artifact.updatedAt } : null;
    const pending = { change, opId: newOp() };

    unechoed.set(path, pending);
    // One artifact at a time, so two devices closing different tabs do not overwrite each other.
    void post('page-tabs', closed ? { workItemId, close: change } : { workItemId, reopen: path }, false, { opId: pending.opId }).then((answer) => {
      // A refused change has no echo to wait for.
      if (answer.status !== 200 && unechoed.get(path) === pending) {
        unechoed.delete(path);
      }
    });
  };
  /**
   * This page's latest artifact close (the version) or reopen (null) by path, with its request's opId, until the `tabs` event that answers that
   * request. The hub sends `tabs` to the sender too, with its opId, so one sent before a change of this page's can come after it; it is read
   * with these changes over it, so it undoes none of them, even where it holds the same state from an older change.
   */
  const unechoed = new Map<string, { change: { path: string; updatedAt: number } | null; opId: string }>();
  /** The closed artifacts of a `tabs` event with this page's changes it does not answer over them; the change it answers is no longer waited for. */
  const withUnechoed = (closed: Array<{ path: string; updatedAt: number }>, opId: unknown): Array<{ path: string; updatedAt: number }> => {
    let next = closed;

    for (const [path, pending] of unechoed) {
      if (pending.opId === opId) {
        unechoed.delete(path);
      } else {
        next = [...next.filter((one) => one.path !== path), ...(pending.change === null ? [] : [pending.change])];
      }
    }

    return next;
  };
  /** What the column right of the conversation shows: History in place of a Browser tab that is gone. */
  const sideTab = (): SideTab => ((view.side === 'browser' && !showBrowser()) || (view.side === 'console' && !showConsole()) || (view.side === 'artifacts' && openArtifact() === null) || (view.side === 'diff' && !changes.view.tab) || (view.side === 'file' && localFiles.shown() === null) ? 'history' : view.side);
  /** The artifact whose tab is chosen, while the work item still has it; artifacts have no list of their own, only a tab each and a menu. */
  function openArtifact(): string | null {
    return view.artifact !== null && state.artifacts.some((one) => one.path === view.artifact) ? view.artifact : null;
  }
  /**
   * Chooses a tab of the column or of the conversation. Browser is one choice in both layouts, so a page that crosses the wide breakpoint keeps
   * embedded tabs; another tab chosen in one layout leaves Browser in the other.
   */
  const chooseTab = (tab: Tab): void => {
    // Where the tab left was is kept, for when it shows again.
    keepScroll();
    tabChosen = true;
    // The pane follows the tab: its state is sent again, whatever was sent before.

    if (tab === 'browser') {
      view.side = 'browser';
      view.tab = 'browser';
    } else if (wide()) {
      view.side = tab === 'conversation' ? view.side : tab;
      view.tab = view.tab === 'browser' ? 'conversation' : view.tab;
    } else {
      view.tab = tab;
      // A tab of the column chosen here is the column's choice too; Conversation leaves the column's choice, but Browser.
      view.side = tab !== 'conversation' ? tab : view.side === 'browser' ? 'history' : view.side;
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
    const browserReady = (): boolean => iframe.available && state.scope !== null;
  /** Opens a web link in its link tab, one named `name` when the work item has none for it (`frameLink`), else as `openTab` does. */
  const openBrowserLink = (url: string, name = ''): void => {
    iframe.follow(selectedRow(state));
    if (iframe.open(url, state.scope?.workItemId ?? null, name)) {
      linkItem = state.scope?.workItemId ?? null;
      leaving('browser'); chooseTab('browser'); draw(); saveTab();
    } else openTab(url, () => openNewTab(url));
  };
  /** Opens a web link of the conversation or History: in a link tab while the extension shows them, else as `openTab` does. */
  const openWebLink = (url: string, name: string): void => {
    if (browserReady()) openBrowserLink(url, name);
    else openTab(url, () => openNewTab(url));
  };
  /** Reports the Browser tab's area to the hub after each draw, once the pane's report is set up below; sent again after a tab change. */
  let reportBrowser = (): void => {};
  /** Whether the pane is hidden for a floating layer of the page, set up with the pane's report below. */

  let state: PageState = EMPTY;
  let iframeAtLoad: boolean | null = null;
  const view: View = newView();
  // The Changes list, its menu and the session state it was last drawn at, so a turn's end reads it again (architecture.md § Web page).
  const changes = new ChangesController({
    fetch: (...args) => readFetch(...args),
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
    inView: () => document.visibilityState === 'visible' && !(isPhone() && root.classList.contains('listing')) && (mainTab() === 'diff' || (wide() && sideTab() === 'diff')),
    drawDiagrams: (element) => drawDiagrams(element),
    // A quote of lines joins the end of the message being written, after a blank line, and the box takes the focus.
    quote: (text) => {
      input.value = input.value.trim() === '' ? text : `${input.value.replace(/\s+$/, '')}\n\n${text}`;
      input.setSelectionRange(input.value.length, input.value.length);
      box.changed(input.value);
      grow();
      refresh();
      keepDraft();
      input.focus();
    },
  });
  let changesSession: string | null = null;
  /** The session the Changes tab last followed, so a new session of the work item reads an open tab's list again. */
  let changesSessionId: string | null = null;
  // Local file links' tabs (architecture.md § Web page); the hub decides what a paired device may read (architecture.md § Remote access).
  const localFiles = new LocalFilesController({
    fetch: (...args) => readFetch(...args),
    key: () => state.key,
    draw: () => draw(),
    show: () => {
      leaving('file');
      chooseTab('file');
      draw();
    },
    openDoc: (id, line, chosen = true) => openDoc(id, { line, chosen }),
    fileShown: () => (wide() ? sideTab() : mainTab()) === 'file',
    keepArtifact: (path) => {
      if (view.side === 'file' && state.artifacts.some((one) => one.path === path) && !closedNow().has(path)) {
        view.side = 'artifacts';
        view.artifact = path;
      }

      draw();
    },
    closeDoc: (id) => closeDoc(id),
    loadDiff: () => deps.loadDiff?.() ?? Promise.resolve(null),
    takePane: (pane) => takePane(pane),
    drawPane: (pane, tree) => drawPane(pane, tree),
    drawDiagrams: (pane) => drawDiagrams(pane),
    inView: () => document.visibilityState === 'visible' && !(isPhone() && root.classList.contains('listing')) && (mainTab() === 'file' || (wide() && sideTab() === 'file')),
    shown: () => `${state.key ?? ''} ${state.scope?.scopeGen ?? ''}`,
    diffSettings: () => ({ layout: state.diffLayout, wrap: state.diffWrap }),
  });
  // An open file tab, and the Changes tab's file view of a file on disk, are read again while in view, so a file the session changes shows its new version.
  const filePoll = setInterval(() => (localFiles.refresh(true), changes.refreshFile(true)), deps.filePollMs ?? FILE_POLL_MS);
  // File type icons, whose mapping loads the first time a list draws one (architecture.md § Web page).
  const dropFileIcons = useFileIcons({ fetch: (...args) => readFetch(...args), loaded: () => draw() });

  // The groups the operator opened or closed on an earlier load.
  view.collapsed = collapsedGroups(localStorage.getItem(GROUPS_KEY));

  try {
    view.details = localStorage.getItem(DETAILS) === '1';
    localStorage.removeItem(OLD_TEXT_SCALE);
  } catch {
    // Off without local storage.
  }

  /** A drag of a Ready for review row under way (reorder.ts), which the list draws. */
  let dragView: DragView | null = null;
  // The route the page starts on (route.ts): the address's, or the one this device kept for an installed app started again with no hash.
  const firstRoute = startRoute(location.hash, readStored(ROUTE_KEY));
  let wanted: number | null = null;
  /** The route whose tab to show once its work item has come (`applyRoute`), then null. */
  let routing: Route | null = null;
  /** The scroll places this tab kept, by `<work item> <tab>` (route.ts). */
  const scrollPlaces = (): Record<string, ScrollPlace> => {
    try {
      return parseScrolls(sessionStorage.getItem(SCROLL_KEY));
    } catch {
      return {};
    }
  };
  /** Each work item's tabs as this device left them (route.ts), kept in local storage for a reload. */
  const readTabSets = (): Record<string, TabSet> | null => {
    try {
      return parseTabSets(localStorage.getItem(TABS_KEY));
    } catch {
      return null;
    }
  };
  let tabSets: Record<string, TabSet> = readTabSets() ?? {};
  /** While a work item's kept tabs or the route's tab are put back, before its panes are drawn: no scroll place or tab set is kept meanwhile. */
  let restoringTabs = false;
  /** The work items whose conversation took its kept place in this page's life; later the page's own memory of it (`left`) serves. */
  const placedConversations = new Set<string>();

  if (firstRoute.w !== null && isPhone() && !conversationEntry(history.state)) {
    // A phone that starts on a conversation puts the list's entry under it, so the browser's back goes to the list as after a row's click. A
    // reload of that entry keeps both and adds none.
    history.replaceState(null, '', LIST_HASH);
    history.pushState({ [CONVERSATION_ENTRY]: true }, '', routeHash(firstRoute));
  } else {
    // Outside the phone's layout the mark means nothing, and Back would take an entry from before the page.
    if (!isPhone() && conversationEntry(history.state)) {
      history.replaceState(null, '');
    }

    if ((firstRoute.w !== null || firstRoute.h != null) && location.hash !== routeHash(firstRoute)) {
      history.replaceState(history.state, '', routeHash(firstRoute));
    }
  }
  // The page's connection (architecture.md § Web page, Connection): it owns the stream and says whether the page is live, offline or signed out.
  const connection = new Connection({
    open: () => new deps.EventSource(installedApp ? '/v1/conversation/events?page=1&installed=1' : '/v1/conversation/events?page=1'),
    events: EVENTS,
    event: (type, raw) => onEvent(type, raw),
    fetch: (url, init) => deps.fetch(url, init),
    now: () => deps.now(),
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    build: deps.build ?? null,
    changed: () => {
      // Commands may go through the grace period, so the composer stays as it was until the page is offline.
      if (state.connected !== connection.usable) {
        state = { ...state, connected: connection.usable };
      }

      drawSoon();
    },
  });
  let opId = 0;
  const newOp = (): string => `${deps.now().toString(36)}-${(++opId).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /**
   * Posts a page command (architecture.md § Web page, Requests), failing at once while the page is offline. Each try is built afresh, so a retry
   * names the page key and scope generation the page has then; `retryFor` tries a transient failure again for that long with the same `opId`,
   * for a command the hub runs once per `opId`.
   */
  const post = async (name: string, body: Record<string, unknown> | (() => Record<string, unknown>), keepalive = false, options: { timeout?: number; retryFor?: number; opId?: string } = {}): Promise<Answer> => {
    if (connection.state === 'offline' || connection.state === 'signedOut') {
      return { status: 0, body: { error: connection.state === 'offline' ? FAILURE_TEXT.network : FAILURE_TEXT.signedOut }, failure: connection.state === 'offline' ? 'network' : 'signedOut' };
    }

    const op = options.opId ?? newOp();
    const answer = await request(
      timers,
      `/v1/conversation/${name}`,
      () => ({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ window: state.key, opId: op, ...(typeof body === 'function' ? body() : body) }), ...(keepalive ? { keepalive } : {}) }),
      { timeout: options.timeout ?? COMMAND_MS, retryFor: options.retryFor ?? 0, ready: (ms) => connection.whenLive(ms), now: () => Date.now() },
    );

    // The sign-in may have gone with the stream still open: the connection asks the hub.
    if (answer.status === 401) {
      connection.check();
    }

    return answer;
  };
  // The list's header: the source icons, search and More Actions (architecture.md § Web page).
  // The page's listeners on its root, the document and the window end with the page.
  const listening = new AbortController();

  watchPictures(root, listening.signal);
  // Settings over the whole page (architecture.md § Web page); it reads settings.json again when the page comes back.
  const settingsHost = root.appendChild(document.createElement('div'));
  // The open dialogs: the page under the top one inert, the focus kept in it and given back to its opener (layers.ts).
  const modals = modalLayers(root);
  const settingsPane = settings(settingsHost, { post: (name, body) => post(name, body), closed: () => root.querySelector<HTMLElement>('.more-actions')?.focus(), layered: () => modals.sync() });

  window.addEventListener('focus', () => void settingsPane.reload(), { signal: listening.signal });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void settingsPane.reload(), { signal: listening.signal });
  const local = deps.local ?? ['127.0.0.1', 'localhost'].includes(location.hostname);


  // A paired device may not change settings.json (architecture.md § Remote access), so its Collapse details is its own, following
  // voice.briefReplies until it is first toggled there.
  if (!local) {
    try {
      const kept = localStorage.getItem(BRIEF);
      const expand = localStorage.getItem(EXPAND);

      view.briefReplies = kept === '1' ? true : kept === '0' ? false : expand === '1' ? false : expand === '0' ? true : null;
    } catch {
      // Follows voice.briefReplies without local storage.
    }
  }
  /**
   * The value Collapse details was last clicked to, until the hub's `settings` event or a refusal, so a quick second click reverses the
   * first, and the value of the save in flight; saves go one at a time, so a later click's value is the one the file keeps.
   */
  let briefAsked: boolean | null = null;
  let briefSending: boolean | null = null;
  const sendBrief = async (): Promise<void> => {
    let on = briefAsked!;

    for (;;) {
      briefSending = on;
      const answer = await post('brief-replies', { on });

      briefSending = null;

      if (answer.status !== 200) {
        briefAsked = briefAsked === on ? null : briefAsked;
        showError(String(answer.body['error'] ?? `Fold reply details did not change (status ${answer.status}).`));
      }

      if (briefAsked === null || briefAsked === on) {
        return;
      }

      on = briefAsked;
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
    : new PhoneVoice({ key: () => state.key, post: (name, body) => post(name, body), fetch: (url) => readFetch(url, { credentials: 'same-origin' }).then((response) => response.arrayBuffer?.()), changed: () => draw(), now: () => deps.now() });
  const header = listHeader(root.querySelector<HTMLElement>('.side-head')!, list, listSheet, {
    fetch: (...args) => deps.fetch(...args),
    post: (name, body) => post(name, body),
    redraw: () => draw(),
    select: (workItemId) => void select(workItemId),
    now: () => deps.now(),
    local,
    openSettings: () => settingsPane.open(),
    reload: () => (deps.reload ?? (() => location.reload()))(),
    refused: (text) => (text === null ? toastBox.clear('warning') : toastBox.show(text, 'warning')),
    connection: () => dotView(connectionView(), deps.now()),
    // The pin shows only where it changes the list: with no work item open the list is a column either way.
    pinned: () => (pinWorks() ? listPinned : undefined),
    ...(phoneVoice === null ? {} : { phoneVoice: { state: () => phoneVoice.state, error: () => phoneVoice.error, toggle: () => (phoneVoice.state === 'off' ? phoneVoice.start() : phoneVoice.stop()) } }),
  });
  /** A command for the conversation the page shows, refused by the hub when the page has moved on since. */
  const command = (name: string, body: Record<string, unknown> = {}, options: { timeout?: number; retryFor?: number; opId?: string } = {}): Promise<Answer> => post(name, () => ({ scopeGen: state.scope?.scopeGen ?? -1, ...body }), false, options);

  // ---- The composer ----
  mount(composerHost, renderComposer());

  const input = composerHost.querySelector('textarea')!;
  const send = composerHost.querySelector<HTMLButtonElement>('button.send')!;
  const menu = composerHost.querySelector<HTMLElement>('.composer-menu')!;
  const voiceControls = composerHost.querySelector<HTMLElement>('.voice-controls')!;
  const micSlot = composerHost.querySelector<HTMLElement>('.composer-mic')!;
  const contextSlot = composerHost.querySelector<HTMLElement>('.context-meter')!;
  const liveWords = composerHost.querySelector<HTMLElement>('.live-words')!;
  const hint = composerHost.querySelector<HTMLElement>('.composer-hint')!;
  const mirror = composerHost.querySelector<HTMLElement>('.live-mirror')!;
  const mirrorText = composerHost.querySelector<HTMLElement>('.mirror-text')!;
  const attachButton = composerHost.querySelector<HTMLButtonElement>('button.attach')!;
  const attachInput = composerHost.querySelector<HTMLInputElement>('input.attach-input')!;
  const chips = composerHost.querySelector<HTMLElement>('.attachments')!;
  // A drag of a Ready for review row moves it (PRD R73); its drop line redraws before the next repaint.
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
  // The draft the hub last sent for dictation, per session, so a newer one replaces it in the box but never text typed over it.
  const hubDrafts = new Map<string, string>();
  // The number of the last dictated piece joined to the box, per session, which `send` carries as `heard`, so the hub takes with the message
  // only the pieces its text holds (architecture.md § Dictation).
  const heardPieces = new Map<string, number>();
  // While a message is on its way: the pieces heard meanwhile, which fill the box once the hub took it or join its text when refused, and the
  // hub's other drafts, applied once it answered.
  let heardWhileSending: { sessionId: string; text: string } | null = null;
  const draftsWhileSending: Array<{ sessionId: string; text: string; added: string | null; piece: number | null }> = [];
  // The session the message on its way goes to, whose pieces are kept for its box even when the page shows another work item meanwhile.
  let sendingTo: string | null = null;
  const takeHubDraft = (sessionId: string, text: string, added: string | null = null, piece: number | null = null): void => {
    // The hub's text still holds the message until it takes it, so only the piece is kept; an older draft of the session waiting for the
    // answer would now drop it, so it is dropped instead.
    if (sending && added !== null && sessionId === sendingTo) {
      hubDrafts.set(sessionId, text);

      if (piece !== null) {
        heardPieces.set(sessionId, piece);
      }

      for (let i = draftsWhileSending.length - 1; i >= 0; i--) {
        if (draftsWhileSending[i]!.sessionId === sessionId) draftsWhileSending.splice(i, 1);
      }

      const so = heardWhileSending?.text ?? '';

      heardWhileSending = { sessionId, text: so === '' || /\s$/.test(so) ? `${so}${added.trimStart()}` : `${so} ${added.trimStart()}` };
      return;
    }

    if (sending) {
      draftsWhileSending.push({ sessionId, text, added, piece });
      return;
    }

    const before = hubDrafts.get(sessionId) ?? '';

    hubDrafts.set(sessionId, text);

    // New conversation…'s draft is no session's: dictation for the session shown waits in the hub's draft for it.
    if (sessionId !== state.session?.id || draftShown()) {
      return;
    }

    if (piece !== null) {
      heardPieces.set(sessionId, piece);
    }

    // Each piece the hub names joins the end of what the box holds now, so the operator's edits since stay, as while the box has the focus
    // and dictation keeps listening, and the caret and selection stay where they were (architecture.md § Dictation). A box that differs
    // from the hub's draft then is told to the hub, whose draft it becomes.
    if (added !== null) {
      const { selectionStart, selectionEnd, selectionDirection } = input;

      input.value = input.value === '' || /\s$/.test(input.value) ? `${input.value}${added.trimStart()}` : `${input.value} ${added.trimStart()}`;
      input.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? undefined);
      // An open list was for the text before the piece.
      box.changed(input.value);
      closeMenu();
      keepDraft();
      grow();
      refresh();

      if (input.value !== text) {
        hubDrafts.set(sessionId, input.value);
        tellHub();
      }

      return;
    }

    // Any other draft, as the hub's emptied one once a turn sent, replaces the box only while it holds nothing typed since.
    if (input.value === '' || input.value === before) {
      input.value = text;
      box.changed(text);
      closeMenu();
      keepDraft();
      grow();
      refresh();
    }
  };
  let sending = false;
  /**
   * The `opId` of the last message each work item sent without an answer that settled it, with its session, launch and text, kept in local
   * storage over a reload, so the same message sent again, from here or after a reload, reuses it and the hub types it once; another message
   * from the same work item replaces it.
   */
  const sendOps = (): Record<string, { key: string; opId: string }> => {
    try {
      const kept = JSON.parse(localStorage.getItem(SEND_OPS) ?? '{}') as unknown;

      return kept !== null && typeof kept === 'object' && !Array.isArray(kept) ? (kept as Record<string, { key: string; opId: string }>) : {};
    } catch {
      return {};
    }
  };
  /** Keeps `op` as the work item's unsettled send, or with null settles `settled`, only while it is still the one kept, as another page of this device may have kept a newer one. */
  const keepSendOp = (workItemId: number | null, op: { key: string; opId: string } | null, settled?: string): void => {
    if (workItemId === null) {
      return;
    }

    const kept = sendOps();

    if (op === null && kept[String(workItemId)]?.opId !== settled) {
      return;
    }

    delete kept[String(workItemId)];

    try {
      localStorage.setItem(SEND_OPS, JSON.stringify(op === null ? kept : Object.fromEntries([...Object.entries(kept), [String(workItemId), op]].slice(-20))));
    } catch {
      // Kept for this page only through the retries.
    }
  };
  /** Why a message was not sent: the hub's reason, or the plain words for no answer. */
  const notSent = (answer: Answer): string => (transient(answer.failure) ? `Your message was not sent. ${String(answer.body['error'])}` : String(answer.body['error'] ?? 'Your message was not sent. Try again.'));
  let draftOf: number | null = null;
  const box = composerInput();
  // Why a message of another work item was not sent, shown when the composer shows that work item again.
  const errors = new Map<number, string>();
  // The messages this page sent, by ID, and not-sent events whose send had not answered yet, so a late refusal finds its text.
  const mine = new Set<string>();
  const unsent = new Map<string, { text: string; error: string; workItemId: number | null }>();
  // Returns that arrived while the composer was sending, put back once it answered.
  const held: Array<{ text: string; error: string; workItemId: number | null }> = [];
  let menuOpen: { kind: 'files'; start: number; items: Array<{ path: string; dir: boolean }> } | { kind: 'commands'; items: Array<{ name: string; description: string }> } | null = null;
  let active = 0;

  /** How many times the operator chose a work item or a session, so an answer that arrives later leaves a newer choice alone. */
  let selections = 0;
  /** Whether the page shows New conversation…'s draft for the work item it shows. */
  const draftShown = (): boolean => view.newDraft !== null && view.newDraft.workItemId === (state.scope?.workItemId ?? null);
  const drafts = (): Record<string, string> => {
    try {
      return JSON.parse(localStorage.getItem(DRAFTS) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  };
  /** New conversation…'s drafts kept, by work item; any malformed one is left out. */
  const newDrafts = (): Record<string, { provider: string; text: string; opId: string }> => {
    try {
      const kept = JSON.parse(localStorage.getItem(NEW_DRAFTS) ?? '{}') as unknown;

      return kept === null || typeof kept !== 'object' || Array.isArray(kept)
        ? {}
        : Object.fromEntries(Object.entries(kept as Record<string, Record<string, unknown>>).filter(([, one]) => one !== null && typeof one === 'object' && typeof one['provider'] === 'string' && typeof one['text'] === 'string' && typeof one['opId'] === 'string')) as Record<string, { provider: string; text: string; opId: string }>;
    } catch {
      return {};
    }
  };
  /** Keeps New conversation…'s draft of a work item, its text the box's, or with null drops it. */
  const keepNewDraft = (workItemId: number, draft: NewDraft | null): void => {
    const all = newDrafts();

    if (draft === null) {
      delete all[workItemId];
    } else {
      all[workItemId] = { provider: draft.provider, text: input.value, opId: draft.opId };
    }

    try {
      localStorage.setItem(NEW_DRAFTS, JSON.stringify(all));
    } catch {
      // Kept for this page only.
    }
  };
  const keepDraft = (): void => {
    // New conversation…'s text is not the work item's draft, which waits for its session; it is kept apart.
    if (draftShown()) {
      keepNewDraft(view.newDraft!.workItemId, view.newDraft);
      return;
    }

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
    fetch: (...args) => uploadFetch(...args),
    shown: () => draftOf,
    refused: (workItemId, error) => (workItemId === draftOf ? showError(error) : void errors.set(workItemId, error)),
    changed: () => {
      drawAttachments();
      refresh();
    },
    expired: () => connection.check(),
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

    // Where the tabs fold into the conversation's, the composer hides off the Conversation tab, so the toast says it there.
    if (root.classList.contains('off-conversation')) {
      sentNote.hidden = true;
      toastBox.show('Sent. Its reply shows on the Conversation tab.', 'info');
      return;
    }

    sentNote.hidden = mainTab() === 'conversation';

    if (!sentNote.hidden) {
      sentTimer = setTimeout(() => void (sentNote.hidden = true), SENT_NOTE_MS);
    }
  };
  /** Shows why something was refused or failed in the toast, or hides a refusal shown there with null. */
  const showError = (text: string | null): void => (text === null ? toastBox.clear('warning') : toastBox.show(text, 'warning'));
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
  /** Leaves New conversation…'s draft unsent, starting nothing, and puts the work item's own draft back in the box. */
  const leaveDraft = (): void => {
    if (view.newDraft === null) {
      return;
    }

    keepNewDraft(view.newDraft.workItemId, null);
    view.newDraft = null;
    input.value = draftOf === null ? '' : (drafts()[draftOf] ?? '');
    box.reset();
    showError(null);
    grow();
    refresh();
    tellHub();
  };
  // New conversation…'s draft sends its text alone, with no session yet to take files or commands.
  const canSend = (): boolean =>
    state.connected && !sending && (draftShown() ? view.newDraft?.sending === false && input.value.trim() !== '' : state.session?.conversation === 'full' && !uploading() && (input.value.trim() !== '' || shownAttachments().length > 0));
  const refresh = (): void => {
    send.disabled = !canSend();
  };
  // Closing the list drops its request still on the way, so its answer does not open it again.
  const closeMenu = (): void => {
    box.cancel();
    menuOpen = null;
    menu.hidden = true;
    mount(menu, null);
    input.removeAttribute('aria-activedescendant');
  };
  const drawMenu = (): void => {
    if (menuOpen === null) {
      closeMenu();
      return;
    }

    mount(menu, renderComposerMenu(menuOpen, active));
    menu.setAttribute('aria-label', menuOpen.kind === 'files' ? 'Files' : 'Slash commands');
    menu.hidden = false;

    if (menuOpen.items.length > 0) {
      input.setAttribute('aria-activedescendant', composerOptionId(active));
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };
  /** The `@` picker and the `/` list follow the text before the caret. */
  const follow = async (): Promise<void> => {
    const before = input.value.slice(0, input.selectionStart);
    const mention = mentionQuery(before);
    const slash = commandQuery(before);
    const ask = box.ask();
    const shown = state.scope?.scopeGen;
    const picked = selections;
    const current = (): boolean => box.current(ask) && shown === state.scope?.scopeGen && picked === selections;

    if (mention !== null && state.key !== null) {
      const response = await readFetch(`/v1/conversation/files?window=${encodeURIComponent(state.key)}&q=${encodeURIComponent(mention.query)}`, { credentials: 'same-origin' }).catch(() => null);
      const files = response?.ok === true ? (((await response.json()) as { files?: Array<{ path: string; dir: boolean }> }).files ?? []) : [];

      if (current()) {
        menuOpen = { kind: 'files', start: mention.start, items: files };
        active = 0;
        drawMenu();
      }
    } else if (slash !== null && state.session !== null && !draftShown()) {
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
        box.changed(input.value);
      }
    } else {
      input.value = box.choose(open.items[index].name);
      input.setSelectionRange(input.value.length, input.value.length);
    }

    closeMenu();
    input.focus();
    grow();
    refresh();
    keepDraft();
  };
  const submit = async (): Promise<void> => {
    if (draftShown()) {
      void sendDraft();
      return;
    }

    if (!canSend() || state.scope === null || state.session === null) {
      return;
    }

    // Attached files go as mentions after the text.
    const files = shownAttachments().slice();
    const typed = input.value;
    const mentions = files.flatMap((one) => mentionOf(one.path!.replaceAll('\\', '/')) ?? []);
    const text = mentions.length === 0 ? typed : typed.trim() === '' ? mentions.join(' ') : `${typed.replace(/\s+$/, '')} ${mentions.join(' ')}`;
    const asCommand = box.asCommand(text);
    const target = { sessionId: state.session.id, launch: state.session.launch };
    const from = draftOf;

    sending = true;
    sendingTo = target.sessionId;
    input.readOnly = true;
    composerHost.classList.add('sending');
    // A list open or asked for belongs to the text being sent.
    closeMenu();
    refresh();

    // A send whose answer was lost is tried again with the same opId, by the retries and by the next Send of the same text, so the hub
    // types it once however often it arrives.
    const sendKey = JSON.stringify([target.sessionId, target.launch, text, asCommand]);
    const kept = from === null ? undefined : sendOps()[String(from)];
    const op = kept?.key === sendKey ? kept.opId : newOp();

    keepSendOp(from, { key: sendKey, opId: op });

    // The hub takes its draft with the message, the pieces up to `heard` as its dictation, so no composer update has to empty it first, and
    // `composerSeq` puts every update posted before it behind it (architecture.md § Dictation). While dictating, the box keeps the focus
    // until the hub takes the message, so what is heard meanwhile joins the draft rather than sending.
    clearTimeout(composerTimer);
    const sent = command('send', { ...target, text, ...(asCommand ? { command: true } : {}), heard: heardPieces.get(target.sessionId) ?? 0, composerSeq: ++composerSeq }, { timeout: SEND_TRY_MS, retryFor: SEND_RETRY_MS, opId: op });

    toEnd();

    const answer = await sent;

    // Settled: taken, or refused for good. No answer, or a refusal for a page key or scope generation the page has not caught up with after a
    // reconnect, which the hub gives before it looks at the opId, leaves it unsettled.
    if (answer.status === 200 || answer.failure === 'bad' || (answer.status === 409 && answer.body['error'] !== CONVERSATION_CHANGED)) {
      keepSendOp(from, null, op);
    }

    sending = false;
    sendingTo = null;
    const dictated = heardWhileSending?.text ?? '';

    heardWhileSending = null;
    input.readOnly = false;
    composerHost.classList.remove('sending');

    const id = (answer.body['message'] as { id?: string } | undefined)?.id ?? null;
    const late = id === null ? undefined : unsent.get(id);

    if (answer.status === 200 && late === undefined) {
      if (id !== null) {
        mine.add(id);
      }


      if (from === draftOf) {
        input.value = dictated;
        box.changed(input.value);
        showError(null);
        confirmSent();
      }

      const all = drafts();

      if (from !== null) {
        // Shown elsewhere meanwhile, the work item's draft becomes what was heard while it was on its way.
        if (from !== draftOf && dictated !== '') {
          all[from] = dictated;
          hubDrafts.set(target.sessionId, dictated);
        } else {
          delete all[from];
        }

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
        giveBack(from, dictated.trim() === '' ? typed : `${typed.replace(/\s+$/, '')} ${dictated.trim()}`, late.error);
      }
    } else if (from === draftOf) {
      showError(notSent(answer));
    } else {
      giveBack(from, dictated.trim(), notSent(answer));
    }

    if (from === draftOf && answer.status === 200 && late === undefined) {
      // Taken: the box gives up the focus, so later spoken turns send on their own again.
      if (state.voice?.here === true && !['off', 'idle-off', 'unavailable'].includes(state.voice.mic) && document.activeElement === input) {
        input.blur();
      }
    } else if (from === draftOf) {
      // Not taken: the box keeps its text and the focus, dictation heard meanwhile joins its end, and the hub's draft becomes the box's.
      const heard = dictated.trim();

      if (heard !== '') {
        input.value = input.value === '' || /\s$/.test(input.value) ? `${input.value}${heard}` : `${input.value} ${heard}`;
        box.changed(input.value);
        keepDraft();
      }

      tellHub();
    }

    // The box now holds the hub's draft: taken, the pieces heard meanwhile; refused, the box's text, told to the hub. The hub's other drafts
    // that came meanwhile apply now, as any other.
    if (from === draftOf) {
      hubDrafts.set(target.sessionId, input.value);
    }

    for (const one of draftsWhileSending.splice(0)) {
      takeHubDraft(one.sessionId, one.text, one.added, one.piece);
    }

    for (const one of held.splice(0)) {
      giveBack(one.workItemId, one.text, one.error);
    }

    box.changed(input.value);
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
      box.changed(input.value);
      closeMenu();
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
    box.changed(input.value);
    grow();
    refresh();
    keepDraft();
    void follow();
  });
  input.addEventListener('keydown', (event) => {
    // Keys an input method composes with are its own: they neither pick from the list nor send. Some browsers mark its Enter only with key code 229.
    if (event.isComposing || event.keyCode === 229) {
      return;
    }

    if (menuOpen !== null && menuOpen.items.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      active = (active + (event.key === 'ArrowDown' ? 1 : menuOpen.items.length - 1)) % menuOpen.items.length;
      drawMenu();
      event.preventDefault();
      return;
    }

    // Only a bare Enter or Tab picks: Shift+Enter adds a line and Shift+Tab moves the focus, and with Ctrl, Alt or Meta the key does nothing,
    // so a half-typed query is never sent.
    if (menuOpen !== null && (event.key === 'Enter' || event.key === 'Tab') && menuOpen.items.length > 0 && !event.shiftKey) {
      if (!event.ctrlKey && !event.altKey && !event.metaKey) {
        choose(active);
      }

      event.preventDefault();
      return;
    }

    // An Escape the box uses is marked used, so the page's own Escape does not also close the drawer or the maximized column.
    if (event.key === 'Escape') {
      // Escape also drops a list asked for but not shown yet.
      box.cancel();

      if (menuOpen !== null) {
        closeMenu();
        event.preventDefault();
      } else if (state.voice?.here === true && state.voice.speaking !== null) {
        void command('stop-speaking');
        event.preventDefault();
      }

      return;
    }

    // Up and Down at the box's first and last lines walk the session's earlier messages, and give the draft back after the newest.
    // A recalled `/name` goes escaped; the draft given back after the newest keeps the command chosen in it.
    if ((event.key === 'ArrowUp' && !input.value.slice(0, input.selectionStart).includes('\n')) || (event.key === 'ArrowDown' && box.walking && !input.value.slice(input.selectionEnd).includes('\n'))) {
      const recalled = box.recall(event.key === 'ArrowUp', input.value, sentTexts(state.items));

      if (recalled === null) {
        return;
      }

      input.value = recalled;
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
  // A press on Send leaves the focus in the box, so dictation keeps joining the draft while the message is on its way; Tab still reaches it.
  send.addEventListener('mousedown', (event) => {
    if (document.activeElement === input) {
      event.preventDefault();
    }
  });
  send.addEventListener('click', () => void submit());
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
  // Files pasted with no text beside them are attached; text pasted with a picture, as from a web page, stays text.
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

      // Files dropped on another tab, where the tabs fold and the composer hides, show the Conversation tab, so their chips show.
      if (root.classList.contains('off-conversation') && canAttach()) {
        leaving('conversation');
        chooseTab('conversation');
        view.artifact = null;
        draw();
        saveTab();
      }

      attachFiles([...(event.dataTransfer?.files ?? [])]);
    },
    { signal: listening.signal },
  );
  composerHost.querySelector('button.slash')!.addEventListener('click', () => {
    if (input.value === '' && !input.disabled && !draftShown()) {
      input.value = '/';
      box.changed('/');
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
    // New conversation…'s draft has no session whose context to show yet.
    const full = state.connected && state.session?.conversation === 'full' && !draftShown();

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
    const why = String(answer.body['error'] ?? 'The session did not run /compact.');

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

  // The box's focus and draft, for the focus rule of dictation (architecture.md § Dictation). The box keeps
  // dictation listening while it has the focus (`listen`): spoken turns join its draft and wait for Send.
  let composerTimer: ReturnType<typeof setTimeout> | undefined;
  // Each `composer` and `send` is numbered, so the hub ignores an update that arrives after a newer one (architecture.md § Dictation).
  let composerSeq = 0;
  const tellHub = (): void => {
    clearTimeout(composerTimer);

    if (state.scope !== null && state.voice?.enabled === true) {
      // New conversation…'s box is not the session's: the hub sees it unfocused, its draft for the session as it was. While a message is on
      // its way only the focus goes: the hub takes its draft with the message.
      const drafting = draftShown();
      const draft = drafting ? (hubDrafts.get(state.session?.id ?? '') ?? '') : sending ? null : input.value;

      void command('composer', { focused: !drafting && document.activeElement === input, ...(draft === null ? {} : { draft }), listen: true, seq: ++composerSeq, heard: heardPieces.get(state.session?.id ?? '') ?? 0 });
    }
  };
  /** The hint that dictation joins the draft and waits for Send, while the box has the focus and the mic is on here. */
  const syncHint = (): void => {
    hint.hidden = !(document.activeElement === input && state.voice?.here === true && !['off', 'idle-off', 'unavailable'].includes(state.voice.mic));
  };

  input.addEventListener('focus', () => {
    tellHub();
    syncHint();
  });
  input.addEventListener('blur', () => {
    tellHub();
    syncHint();
  });
  input.addEventListener('input', () => {
    clearTimeout(composerTimer);
    composerTimer = setTimeout(tellHub, COMPOSER_DRAFT_MS);
  });

  /** The composer follows the selected work item: its own draft, enabled only for a session it can talk to. */
  const updateComposer = (): void => {
    const id = state.scope?.workItemId ?? null;

    if (id !== draftOf) {
      // New conversation…'s draft belongs to the work item it was chosen in.
      if (view.newDraft !== null && view.newDraft.workItemId !== id) {
        view.newDraft = null;
      }

      draftOf = id;
      // Live words belong to the conversation they were heard for; its clearing event may never reach this one.
      liveWords.textContent = '';
      liveWords.hidden = true;
      input.value = id === null ? '' : (drafts()[id] ?? '');

      // New conversation…'s draft left unsent, as before a reload, comes back with its text, provider and opId.
      const keptNew = id === null || view.newDraft !== null ? undefined : newDrafts()[id];

      if (id !== null && keptNew !== undefined) {
        view.newDraft = { workItemId: id, provider: keptNew.provider, installed: null, opId: keptNew.opId, sending: false };
        input.value = keptNew.text;
        void askProviders(view.newDraft);
      }
      box.reset();
      showError(id === null ? null : (errors.get(id) ?? null));
      closeMenu();
      contextMenu = 'closed';
      drawAttachments();

      if (id !== null) {
        errors.delete(id);
      }
    }

    const drafting = draftShown();
    // The draft's composer types the new conversation's first message; the voice and the mic stay with the sessions.
    const live = state.connected && state.session?.conversation === 'full' && !drafting;
    const full = live || (state.connected && drafting);

    // On every tab, so the operator can type and dictate from History or the artifacts too, but on a short screen (page.css).
    composerHost.hidden = state.scope === null;
    input.disabled = !full;
    attachButton.disabled = !live;
    input.placeholder = drafting
      ? 'First message of the new session…'
      : full
      ? 'Message…'
      : state.scope?.earlier === true
        ? 'Switch to the current session to send a message.'
        : state.session?.state === 'ended' && state.session.conversation !== 'none'
          ? 'Resume the session to send a message.'
        : (state.session?.reason ?? (state.connected ? 'No session has started yet.' : connection.state === 'offline' ? 'Messages cannot be sent while offline.' : connection.state === 'signedOut' ? 'Signed out.' : 'Connecting to Switchboard…'));
    // The voice controls from packages/conversation, acting on this computer's voice process (architecture.md § Web page).
    mount(voiceControls, renderShared(renderVoice(state.voice, live)));
    syncHint();
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

    mount(micSlot, live ? renderShared(renderMicButton(micView, micStart.pending)) : null);
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
   * title the head shows; its pictures from its folder, or from elsewhere through the local file route (`artifactTarget`); a relative link to
   * another artifact opening that one in place, to another file in the folder in a new tab, and to a file elsewhere in a file tab; Mermaid included. Only an artifact's latest version is kept (`artifactDocs`), with `top`,
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
    const response = await readFetch(artifactUrl(key, path), { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
    const text = response?.ok === true ? await response.text() : null;
    /** Where a relative target lies: in the artifact route, or a local file by its absolute path (`artifactTarget`). */
    const place = (target: string, isLink = false): { name: string } | { path: string } | null => artifactTarget(artifact, state.artifactsDir ?? null, decodedTarget(target), isLink);
    const base = (src: string): string | null => {
      const to = place(src.split(/[?#]/)[0]!);

      return to === null ? null : 'name' in to ? artifactUrl(key, to.name) : localFileUrl(key, to.path, true);
    };
    const link = (href: string): string | null => {
      const at = href.indexOf('#');
      const to = href.startsWith('#') ? null : place(href.slice(0, at === -1 ? undefined : at), true);

      if (to === null) {
        return null;
      }

      if ('path' in to) {
        // `linkTarget` decodes the target and reads a `#` as its fragment, so a decoded name's `%` and `#` go back encoded.
        return fileTabLink(to.path.replace(/[%#]/g, encodeURIComponent) + (at === -1 ? '' : decodedTarget(href.slice(at))));
      }

      return state.artifacts.some((one) => one.path === to.name)
        ? `href="${escape(artifactUrl(key, to.name))}" data-action="artifact" data-path="${escape(to.name)}"`
        : `href="${escape(artifactUrl(key, to.name))}" target="_blank" rel="noopener noreferrer"`;
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
    // The window has no route in its address, so a link to a place in the document is a plain fragment link to an id there.
    copy.querySelectorAll<HTMLElement>('[data-anchor]').forEach((node) => (node.id = node.dataset['anchor']!));
    copy.querySelectorAll<HTMLElement>('a.anchor-link').forEach((node) => {
      node.setAttribute('href', `#${node.dataset['target'] ?? ''}`);
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

  // Whether the conversation follows its end, set by the operator's own scrolling, and where the page itself last scrolled it.
  let pinned = true;
  let ownTop = 0;
  /** What the panel last showed: its tab and conversation; another starts at its top, or at its end for a conversation. */
  let shown: string | null = null;
  /** What the side column last showed: its work item, tab and artifact. */
  let shownSide: string | null = null;
  /** Where the conversation was when another tab was shown. */
  let left: { conversation: string; pinned: boolean; top: number } | null = null;
  /** Keeps where the conversation is when the page moves from it to another tab, by a tab or an artifact's row. */
  const leaving = (next: Tab): void => {
    if (restoringTabs) {
      return;
    }

    if (mainTab() === 'conversation' && next !== 'conversation' && state.scope !== null && !wide()) {
      left = { conversation: `${state.scope.workItemId ?? ''} ${state.session?.id ?? ''}`, pinned, top: panel.scrollTop };
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

  /**
   * The work item whose row's waiting questions were pressed, until its oldest open card is shown or `until` passes; `pages` counts the earlier
   * pages read to reach the card, `reading` is set while one is read, and `selected` once its selection is past any comment it waited for. A new
   * selection drops it (`select`, `selectSession`).
   */
  let cardWanted: { workItemId: number; until: number; pages: number; reading: boolean; selected: boolean } | null = null;
  /** Shows the oldest open card of the work item whose row's waiting questions were pressed, once its current session's questions have come. */
  const showWantedCard = (): void => {
    if (cardWanted === null) {
      return;
    }

    // Its selection has not finished, or an earlier page is being read, which refreshes the deadline when it comes.
    if (!cardWanted.selected || cardWanted.reading) {
      return;
    }

    if (Date.now() > cardWanted.until) {
      cardWanted = null;
      return;
    }

    const scope = state.scope;
    const session = scope?.workItemId === cardWanted.workItemId && scope.earlier !== true ? state.session : null;
    const key = session != null && state.questions?.sessionId === session.id ? state.questions.oldest : undefined;
    const find = (): HTMLElement | null => [...document.querySelectorAll<HTMLElement>('.question-card')].find((card) => card.dataset['cardKey'] === key) ?? null;

    // Its current session, or its questions, have not come yet.
    if (key === undefined) {
      return;
    }

    if (key === null) {
      cardWanted = null;
      return;
    }

    if (find() === null) {
      // The conversation is shown first, then read back a page at a time while the card is older than the items the page holds.
      if (mainTab() !== 'conversation') {
        leaving('conversation');
        chooseTab('conversation');
        view.artifact = null;
        draw();
        saveTab();
        return;
      }

      const wanting = cardWanted;

      if (!state.more || wanting.pages >= CARD_PAGES_MAX) {
        cardWanted = null;
        return;
      }

      wanting.reading = true;
      wanting.pages++;
      void earlier().then(
        (read) => read,
        () => false,
      ).then((read) => {
        wanting.reading = false;

        if (cardWanted !== wanting) {
          return;
        }

        if (!read) {
          cardWanted = null;
          showError('Switchboard could not find the reply that asked these questions.');
          return;
        }

        wanting.until = Date.now() + CARD_WAIT_MS;
        showWantedCard();
      });
      return;
    }

    cardWanted = null;
    showLinked('conversation', find);
    [...document.querySelectorAll<HTMLElement>('.question-card.qc')].find((card) => card.dataset['cardKey'] === key)?.focus({ preventScroll: true });
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

  let listFocus: string | null = null;
  let pendingRowControl: { key: string; run: () => void } | null = null;
  let rowMenuPoint: { x: number; y: number } | undefined;
  const listRowElement = (key: string): HTMLElement | undefined => [...list.querySelectorAll<HTMLElement>('.row')].find((one) => one.dataset['row'] === key);
  /** Pills clipped onto line 2's hidden wrap are not keyboard stops, nor are pills outside the list's Tab stop row (setListTabStop). */
  const fitListLinks = (): void => {
    for (const links of list.querySelectorAll<HTMLElement>('.row-links')) {
      const box = links.getBoundingClientRect();
      if (box.height === 0) continue;
      const stop = links.closest<HTMLElement>('.row')?.tabIndex === 0;
      for (const pill of links.querySelectorAll<HTMLElement>('.pill[data-action="open-link"]')) {
        const rect = pill.getBoundingClientRect();
        const index = stop && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5 && rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 ? 0 : -1;
        if (pill.tabIndex !== index) pill.tabIndex = index;
        if (pill.tabIndex === -1 && document.activeElement === pill) pill.closest<HTMLElement>('.row')?.focus({ preventScroll: true });
      }
    }
  };
  /** The list's one Tab stop, by `row:<key>`, `group:<key>` or `band:<key>`: the row or heading the focus was last on in the list. */
  let listStop: string | null = null;
  const stopId = (one: Element): string => (one.matches('.row') ? `row:${(one as HTMLElement).dataset['row']}` : one.matches('.group-head') ? `group:${(one as HTMLElement).dataset['group']}` : `band:${(one as HTMLElement).dataset['band']}`);
  /**
   * Makes one row or heading the list's Tab stop, so Tab passes the list in one press plus that row's pills (architecture.md § Web page,
   * Keyboard): the one the focus was last on, else the selected row, else the first. Moves no focus.
   */
  const setListTabStop = (): void => {
    const stops = [...list.querySelectorAll<HTMLElement>('.row, .group-head, .band-head')];
    const stop = stops.find((one) => stopId(one) === listStop) ?? stops.find((one) => one.matches('.row.selected')) ?? stops[0];
    // Set only where it changes, so a redraw that changes nothing writes nothing.
    const set = (one: HTMLElement, index: number): void => { if (one.tabIndex !== index) one.tabIndex = index; };
    for (const one of stops) set(one, one === stop ? 0 : -1);
    for (const pill of list.querySelectorAll<HTMLElement>('.pill[data-action="open-link"], .row-head .questions')) set(pill, pill.closest('.row') === stop ? 0 : -1);
    fitListLinks();
  };
  window.addEventListener('resize', fitListLinks, { signal: listening.signal });
  // A web font that loads after a draw changes which pills fit, as icons or whole.
  document.fonts?.addEventListener('loadingdone', fitListLinks, { signal: listening.signal });
  const listResized = typeof ResizeObserver === 'function' ? new ResizeObserver(fitListLinks) : null;
  listResized?.observe(list);
  listening.signal.addEventListener('abort', () => listResized?.disconnect());
  /** The row whose menu is open, while the list still has that row. */
  const rowMenu = (): { row: string; rows: VNode[]; point?: { x: number; y: number } } | null => {
    const row = view.rowMenu === null ? undefined : state.groups.flatMap((group) => group.rows).find((one) => rowKey(one) === view.rowMenu);

    return row === undefined ? null : { row: rowKey(row), rows: menuRows(row, view), ...(rowMenuPoint === undefined ? {} : { point: rowMenuPoint }) };
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
  /** Drops the classes a tab's drawing set on a pane, for a placeholder drawn in it. */
  const plainPane = (pane: HTMLElement): void => {
    pane.classList.remove('console-pane', 'browser-pane', 'history-pane', 'diff-pane', 'framed');
  };
  const takePane = (pane: HTMLElement): void => {
    if (preactPanes.delete(pane)) {
      unmount(pane);
    }
  };
  // ---- The work items' drawer (architecture.md § Web page), shown and hidden as an auto-hide ----
  const drawer = root.querySelector<HTMLElement>('.side')!;
  const sliver = root.querySelector<HTMLElement>('.sliver')!;
  // Under a drawer opened by its button or a key, a backdrop takes the press outside it, so the press closes the drawer and does nothing else.
  const backdrop = root.querySelector<HTMLElement>('.drawer-backdrop')!;
  /** Whether the list's pin changes it: only while a work item's conversation shows; with none open it is a column either way. */
  const pinWorks = (): boolean => !(view.list || wanted === null);
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
  /** What keeps a drawer shown by the pointer open: the pointer over it, a menu or sheet of the list, or typing in its search box. */
  const drawerKept = (): boolean => {
    const focused = document.activeElement;

    return overDrawer || root.classList.contains('resizing') || view.rowMenu !== null || view.sheet !== null || drawer.querySelector('.menu') !== null || listSheet.querySelector('.sheet-backdrop') !== null || ((focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) && drawer.contains(focused));
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
      if (view.drawer !== null && event.target instanceof Node && event.target !== backdrop && !drawer.contains(event.target) && !sheetHost.contains(event.target) && !listSheet.contains(event.target) && head.querySelector('.list-toggle')?.contains(event.target) !== true) {
        closeDrawer();
      }
    },
    { signal: listening.signal },
  );

  backdrop.addEventListener('click', () => closeDrawer());

  /**
   * Draws the hidden list's sliver: each row's coloured stripe at its height, cut to the list's view and left out
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
    view.connection = dotView(connectionView(), deps.now());
    // On a narrow screen the list and the conversation are each a full-width view (page.css); the list shows until a work item is opened.
    const listing = view.list || wanted === null;

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
    document.title = pageTitle(state.groups);
    header.draw(state.header, state.groups);
    // A search shows only the rows that match, in every group, open (PRD R63).
    const listed = header.list(state.groups);
    mount(sheetHost, renderSheet(view.sheet, view.acting));

    // The persona dialog belongs to the conversation it opened for, so it closes when another replaces it, before a pick could pin that one's session.
    if (view.personas !== null && (state.scope === null || state.scope.scopeGen !== personaScope)) {
      view.personas = null;
    }

    mount(personaHost, renderPersonaDialog(state.session?.persona, view.personas));
    modals.sync();
    const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : null;
    const focusedRow = focused?.closest<HTMLElement>('.list-row')?.querySelector<HTMLElement>('.row')?.dataset['row'];
    const focusLink = focused?.matches('.pill') ? focused.dataset['link'] : undefined;
    if (listFocus !== null && !state.groups.some((group) => group.rows.some((row) => rowKey(row) === listFocus))) listFocus = null;
    mount(list, renderListPane(renderList(listed.groups, listSelected(), view.collapsed, listed.filtering, rowMenu(), view.bands, true, dragView, sourceIcons(state.header)), header.end(listed.groups)));
    // The rows may have moved under a still pointer.
    reorder.refresh();
    if (focusedRow !== undefined && document.activeElement !== focused) {
      const group = state.groups.find((one) => one.rows.some((row) => rowKey(row) === focusedRow));
      const row = listRowElement(focusedRow);
      const heading = group === undefined ? null : [...list.querySelectorAll<HTMLElement>('.group-head')].find((one) => one.dataset['group'] === group.key);
      let target = row ?? heading;
      if (group !== undefined && view.collapsed.has(group.key) && !listed.filtering) target = heading;
      else if (focusLink !== undefined) target = row?.querySelector<HTMLElement>(`[data-link="${focusLink}"]`) ?? row;
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: 'nearest' });
    }
    setListTabStop();

    // An ended session's note sits just above the composer, with Resume, so it shows only where the composer does;
    // the page resumes it in the terminal holder, or a Codex thread in its daemon, without a terminal.
    mount(note, draftShown() ? renderDraftNote(view.newDraft!) : renderEndedNote(state.session, resuming, state.scope?.earlier === true ? (state.scope.workItemId ?? null) : null));

    // From the wide layout History, Artifacts, Console and Browser are a column of their own; embedded tabs covers the Browser tab's area.
    // While another work item opens, the columns keep their widths and the conversation's composer its place (page.css), so nothing moves when it comes.
    const pending = openingShown();
    const side = wide() && (state.scope !== null || pending !== null);

    // The maximized column restores for another work item's open, so its placeholder or why it failed shows.
    if (pending !== null && panelMaximized) {
      panelMaximized = false;
      root.classList.remove('maximized');
    }

    root.classList.toggle('wide', side);
    root.classList.toggle('item-opening', pending !== null);
    // Where the tabs fold into the conversation's, the composer and the note show only on the Conversation tab (page.css).
    // A work item being opened opens on the Conversation tab there, so its composer keeps its place meanwhile.
    root.classList.toggle('off-conversation', state.scope !== null && pending === null && mainTab() !== 'conversation');

    // The hidden box gives up the focus, so its blur tells the hub, and spoken turns send as messages again rather than join a draft out of view.
    if (root.classList.contains('off-conversation') && composerHost.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }

    if (!side) {
      mount(detailHead, null);
      drawPane(detailBody, null);
    }

    const turnEnded = changesSession === 'running' && state.session?.state !== 'running';
    // Another session of the work item can have changed the worktree, so an open Changes tab reads its list again.
    const sessionMoved = changesSessionId !== null && changesSessionId !== (state.session?.id ?? null);

    changesSession = state.session?.state ?? null;
    changesSessionId = state.session?.id ?? null;
    changes.follow(followed(), turnEnded || sessionMoved);
    localFiles.follow(followed());

    // The session may have changed the file shown.
    if (turnEnded) {
      localFiles.refresh();
      changes.refreshFile();
    }

    if (state.scope === null || pending !== null) {
      iframe.follow(null);
      followHistory(false);
      mount(head, pending === null ? null : [renderOpeningHead(pending, view.connection), side ? null : renderOpeningTabs(false)]);
      plainPane(panel);
      drawPane(panel, pending === null ? renderEmpty(state.connected ? 'No work item open. Choose one in the list to see its conversation.' : 'Connecting to Switchboard…') : renderOpening(pending));

      if (side && pending !== null) {
        mount(detailHead, renderOpeningTabs(true));
        plainPane(detailBody);
        drawPane(detailBody, renderOpeningSide(pending));
      }

      shown = null;
      updateComposer();
      return;
    }

    iframe.follow(selectedRow(state), state.groups.some((group) => group.key === 'review' && group.rows.includes(selectedRow(state)!)));
    const shownArtifact = openArtifact();

    // Shown only while it shows: not under the phone's list. A new version that comes while it shows is shown too.
    if (shownArtifact !== null && (side ? sideTab() : mainTab()) === 'artifacts' && !(isPhone() && root.classList.contains('listing'))) {
      artifactsOpened(state.artifacts.filter((one) => one.path === shownArtifact));
    }

    const strip = { ...(browserTab() ? { links: iframe.tabs, link: iframe.selected } : {}), open: shownArtifact, fit: view.tabFit, menu: view.tabMenu, now: deps.now(), closed: closedNow(), unread: unreadArtifacts(state.artifacts, state.scope.workItemId ?? null, artifactsSeen), files: localFiles.view, changes: changes.view };

    // The History tab reads the hub only while it shows.
    followHistory((side ? sideTab() : mainTab()) === 'history' && !(isPhone() && root.classList.contains('listing')));
    mount(head, [renderHeader(state, view, deps.now()), side ? null : renderTabs({ ...view, tab: mainTab() }, state, showBrowser(), strip, showConsole())]);

    const artifact = view.artifact === null ? undefined : state.artifacts.find((one) => one.path === view.artifact);
    const now = deps.now();
    /** Draws History or the Artifacts tab, or an open artifact, into a pane; an open artifact stays as it is, so a frame or a video is not reloaded. */
    const drawTab = (pane: HTMLElement, tab: Tab): void => {
      pane.classList.toggle('console-pane', tab === 'console');
      pane.classList.toggle('browser-pane', tab === 'browser');
      pane.classList.toggle('history-pane', tab === 'history');
      pane.classList.toggle('diff-pane', tab === 'diff' || (tab === 'file' && localFiles.codeShown()));

      if (tab !== 'file') {
        filePlaced.delete(pane);
      }

      if (tab !== 'history') {
        historyPlaced.delete(pane);
      }

      if (tab === 'browser') {
        takePane(pane);
        iframe.draw(pane, selectedRow(state), state.groups.some((group) => group.key === 'review' && group.rows.includes(selectedRow(state)!)));
      } else if (tab === 'console') {
        drawConsole(pane);
      } else if (tab === 'history') {
        // The ticket's History only for a row that offers it (`followHistory`); the state always.
        drawPane(pane, renderHistory(offersHistory() ? shownHistory : null, state.state, now, historyHead()));
        drawDiagrams(pane);
        placeHistory(pane);
      } else if (tab === 'diff') {
        changes.drawDiff(pane);
      } else if (tab === 'file') {
        localFiles.draw(pane);
        placeFile(pane);
      } else if (tab === 'artifacts' && artifact !== undefined && state.key !== null) {
        const kept = artifactDocs.get(docKey(artifact.path));

        // A new version replaces the one shown, and a Markdown artifact keeps the reader's place.
        if ((artifact.type === 'markdown' || artifactShow(artifact) === 'text') && kept?.updatedAt !== artifact.updatedAt) {
          const open = pane.querySelector<HTMLElement>(':scope > .artifact-view');

          // A document shown anew, as after a reload, comes back to its kept place.
          void fillArtifact(artifact, open?.dataset['artifact'] === artifact.path ? (open.querySelector<HTMLElement>('.artifact-doc')?.scrollTop ?? 0) : (artifactTop(artifact.path) ?? 0));
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
        drawPane(pane, tab === 'artifacts' ? renderArtifacts(state, now) : renderTimeline(state, view));
        drawDiagrams(pane);
      }

      pane.classList.toggle('framed', (tab === 'artifacts' && artifact !== undefined) || (tab === 'file' && !localFiles.codeShown()));
    };

    drawTab(panel, mainTab());

    if (side) {
      // A side tab shown anew comes back to its kept place.
      const sideShowing = `${state.scope.workItemId ?? ''} ${sideTab()} ${openArtifact() ?? ''}`;

      if (sideShowing !== shownSide) {
        shownSide = sideShowing;

        const top = keptTop(sideTab());

        if (top !== null) {
          queueMicrotask(() => void (detailBody.scrollTop = top));
        }
      }

      mount(detailHead, renderSideSwitch(sideTab(), state, showBrowser(), strip, showConsole(), renderMaximize(panelMaximized)));
      drawTab(detailBody, sideTab());
    }
    // The composer first, so the conversation is scrolled against its final height.
    updateComposer();

    // By work item and session, not scope generation, so a reconnect's new generation keeps the operator's place; a tab other than the
    // conversation by work item alone, so a new session of the work item keeps its place too.
    const conversation = `${state.scope.workItemId ?? ''} ${state.session?.id ?? ''}`;
    const showing = mainTab() === 'conversation' ? `conversation ${conversation}` : `${mainTab()} ${state.scope.workItemId ?? ''}`;

    if (showing !== shown) {
      shown = showing;

      // The conversation comes back where the operator left it, while it is the same conversation; another tab or conversation starts afresh.
      const kept = mainTab() === 'conversation' && left !== null && left.conversation === conversation ? left : null;

      pinned = kept?.pinned ?? true;
      panel.scrollTop = mainTab() !== 'conversation' ? (keptTop(mainTab()) ?? 0) : kept !== null && !kept.pinned ? kept.top : panel.scrollHeight;

      // A conversation first shown in this page's life, as after a reload, comes back where it was, by the item that was first in view.
      const w = state.scope.workItemId;
      const place = w == null || placedConversations.has(conversationPlace(w)) || mainTab() !== 'conversation' ? undefined : scrollPlaces()[conversationPlace(w)];

      if (w != null && mainTab() === 'conversation') {
        placedConversations.add(conversationPlace(w));
      }

      const anchor = place?.id == null ? null : ([...panel.querySelectorAll<HTMLElement>('.timeline > li[data-id]')].find((item) => item.dataset['id'] === place.id) ?? null);

      if (place !== undefined && kept === null && !place.pinned && anchor !== null) {
        pinned = false;
        panel.scrollTop += anchor.getBoundingClientRect().top - panel.getBoundingClientRect().top - place.offset;
      }

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
    rememberTabs();
    checkSeen();
    showWaiting();
    showWantedCard();
    dropConsoles();
    changes.drop();
    localFiles.drop();
  };
  /**
   * Places a row's open menu at its row in the viewport: where the right click was, kept as its offset from the row, or under the row's start;
   * its row's place is read again on each draw and scroll, so the menu stays with it. Kept inside the viewport.
   */
  const placeRowMenus = (): void => {
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;

    for (const anchor of list.querySelectorAll<HTMLElement>('.row-menu-anchor')) {
      const box = anchor.parentElement!.getBoundingClientRect();
      const x = box.left + (anchor.dataset['x'] === undefined ? 8 : Number(anchor.dataset['x']));
      const y = box.top + (anchor.dataset['y'] === undefined ? box.height - 4 : Number(anchor.dataset['y']));

      anchor.style.left = `${Math.round(width === 0 ? x : Math.min(Math.max(0, x), width))}px`;
      anchor.style.top = `${Math.round(height === 0 ? y : Math.min(Math.max(0, y), height))}px`;
    }
  };
  /**
   * Opens a question card's menu above its button where the conversation's visible room below it is short and the room above is longer
   * (`menuPlace`, measured in the conversation's box as far as the viewport shows it, since that box clips the card). The card never scrolls, so
   * its menu, a row or two, keeps its height.
   */
  const placeCardMenus = (): void => {
    for (const cardMenu of panel.querySelectorAll<HTMLElement>('.qc-menu')) {
      cardMenu.classList.remove('flip-y');

      const box = panel.getBoundingClientRect();
      const top = Math.max(box.top, 0);
      const bottom = Math.min(box.bottom, document.documentElement.clientHeight);

      if (bottom <= top || cardMenu.parentElement === null) {
        continue;
      }

      const inBox = (rect: DOMRect) => ({ left: rect.left - box.left, right: rect.right - box.left, top: rect.top - top, bottom: rect.bottom - top, width: rect.width, height: rect.height });
      const place = menuPlace(inBox(cardMenu.parentElement.getBoundingClientRect()), inBox(cardMenu.getBoundingClientRect()), { width: box.width, height: bottom - top });

      cardMenu.classList.toggle('flip-y', place.flipY);
    }
  };
  /** Opens each open menu down and to the right of its button, or the other way where the page has no room (`placeMenus`, architecture.md § Conversation view, Menus). */
  // A menu may set a wider max-width of its own, as the More menu does for its kind column.
  const fitMenus = (): void => {
    placeRowMenus();
    placeCardMenus();
    placeMenus(root, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }, (menu) => parseFloat(getComputedStyle(menu as unknown as Element).maxWidth) || MENU_MAX_WIDTH);
  };
  /**
   * The shown strip's room for its tabs (`fitTabs` in tabs.ts), measured after a draw: its width less the maximize button's, More's width, and
   * each tab's least width, its label cut to `--sb-tab-label-least` (page.css): a drawn tab's as drawn less what its label has beyond that, kept
   * while it is in More under the same sizing rules, and an undrawn one's from page.css's numbers, with a close mark or without. True when that changes, so the strip is drawn
   * again; a change of the strip's width draws again (`stripWidth`).
   */
  /** The sizing rules the strip's tabs were last measured under: `--sb-tab-pad`, `--sb-tab-label-least` and `--sb-tab-close-room`. */
  let tabSizing = '';
  const fitStripTabs = (): boolean => {
    const strip = (wide() ? detailHead : head).querySelector<HTMLElement>('.tabs');

    if (strip === null) {
      return false;
    }

    const width = (node: Element | null): number => node?.getBoundingClientRect().width ?? 0;

    // A strip not laid out, as under the phone's list, shows every tab until it is.
    if (width(strip) <= 0) {
      const changed = view.tabFit.width > 0;

      view.tabFit = { ...view.tabFit, width: 0 };
      return changed;
    }

    // The sizing rule's own numbers; a page without its stylesheet, as under test, has none and takes page.css's.
    const read = (node: Element | null, name: string, fallback: number): number => {
      const style = node === null ? null : (getComputedStyle(node) as Partial<CSSStyleDeclaration> | null);

      return parseFloat(typeof style?.getPropertyValue === 'function' ? style.getPropertyValue(name) : '') || fallback;
    };
    const first = strip.querySelector(':scope > .tab[data-id]');
    const pad = read(first, '--sb-tab-pad', 14);
    const label = read(first, '--sb-tab-label-least', 44);
    const close = read(first, '--sb-tab-close-room', 32);
    // A tab measured under other sizing rules, as across the 480 px breakpoint or on a touch screen, is measured again, or taken from page.css's
    // numbers while it is not drawn.
    const sizing = first === null ? tabSizing : `${pad} ${label} ${close}`;
    const measured = sizing === tabSizing ? { ...view.tabFit.measured } : {};

    tabSizing = sizing;

    for (const tab of strip.querySelectorAll<HTMLElement>(':scope > [data-id]')) {
      const cut = tab.querySelector('.tab-label');

      // A tab cut to its least label is never narrower than its own min-width, as the Changes tab's, whose count may not show yet.
      measured[tab.dataset['id']!] = Math.ceil(Math.max(width(tab) - width(cut) + (cut === null ? 0 : label), read(tab, 'min-width', 0)));
    }

    // The icon, its gap and the border with the label; More's icon, gap and count before it is drawn.
    const fit: TabFit = {
      width: Math.floor(width(strip) - [...strip.querySelectorAll(':scope > .panel-max')].reduce((sum, one) => sum + width(one), 0)),
      more: Math.ceil(width(strip.querySelector(':scope > .tab-more')) || 2 * pad + 43),
      plain: Math.ceil(2 * pad + 23 + label),
      closable: Math.ceil(pad + 23 + label + close),
      measured,
    };
    const changed = JSON.stringify(fit) !== JSON.stringify(view.tabFit);

    view.tabFit = fit;
    return changed;
  };
  /** Closes the persona dialog and gives the focus back to the view options button, under which the persona row opened it. */
  const closePersonas = (): void => {
    view.personas = null;
    draw();
    head.querySelector<HTMLElement>('button.view-options')?.focus();
  };
  /** The connection as the page draws it. */
  const connectionView = (): ConnectionView => ({ state: connection.state, since: connection.since, lastLiveAt: connection.lastLiveAt, nextAt: connection.nextAt, update: connection.update });
  const bannerHosts = [...root.querySelectorAll<HTMLElement>('.conn-banner-host')];
  const connectionHost = root.querySelector<HTMLElement>('#connection')!;
  /** Redraws the countdown of the next attempt each second while offline. */
  let connectionTick: ReturnType<typeof setInterval> | undefined;
  /** Draws the banner, the screen in the page's place and the Update ready chip; what the page shows dims while it is stale. */
  const drawConnection = (): void => {
    const shown = connectionView();
    const now = deps.now();
    const screen = renderScreen(shown, local, now);

    for (const host of bannerHosts) {
      mount(host, renderBanner(shown, now));
    }

    mount(connectionHost, [screen, renderUpdate(shown)]);
    root.classList.toggle('stale', shown.state === 'offline' && shown.lastLiveAt !== null);
    root.classList.toggle('unreachable', screen !== null);

    if (shown.state === 'offline' && connectionTick === undefined) {
      connectionTick = setInterval(drawConnection, 1_000);
    } else if (shown.state !== 'offline' && connectionTick !== undefined) {
      clearInterval(connectionTick);
      connectionTick = undefined;
    }
  };
  // A draw asked for before the next repaint (`drawSoon`), which a draw meanwhile makes unneeded.
  let frame: { cancelled: boolean } | null = null;
  // Collapse details' fades, fitted to the lines their details draw, before the page paints them, and again as their width changes. Each observes
  // its details' box, which the fade's own height does not resize, so fitting one never asks for another. Details that would hide less than 1.5
  // lines open for good instead, with no fade and nothing to click.
  const fadesObserved = new Set<Element>();
  const fades =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          const short = entries.map((entry) => entry.target.parentElement).filter((fade): fade is HTMLElement => fade?.classList.contains('reply-fade') === true && !fitFade(fade));

          if (short.length > 0) {
            // A fade with the focus gives it to its reply, as a click on it does, rather than leaving it to the page.
            const focused = short.find((fade) => fade === document.activeElement)?.dataset['reply'];

            short.forEach((fade) => view.open.add(`more:${fade.dataset['reply']}`));
            draw();
            if (focused !== undefined) {
              [...root.querySelectorAll<HTMLElement>('li.reply')].find((reply) => reply.dataset['id'] === focused)?.focus();
            }
          }
        })
      : null;

  listening.signal.addEventListener('abort', () => {
    fades?.disconnect();
    fadesObserved.clear();
  });
  /** Observes the fades the draw made and lets go of those it opened or removed. */
  const watchFades = (): void => {
    if (fades === null) {
      return;
    }

    for (const text of fadesObserved) {
      if (!text.isConnected || text.parentElement?.classList.contains('reply-fade') !== true) {
        fades.unobserve(text);
        fadesObserved.delete(text);
      }
    }

    for (const text of root.querySelectorAll('.reply-fade > .reply-more-text')) {
      if (!fadesObserved.has(text)) {
        fades.observe(text);
        fadesObserved.add(text);
      }
    }
  };
  const draw = (): void => {
    if (frame !== null) {
      frame.cancelled = true;
      frame = null;
    }

    // A card is drawn anew from HTML, so the control that had the focus in it gets it back, with a Comment field's caret.
    const focus = cardFocus();

    drawRegions();
    restoreCardFocus(focus);

    // Measured again after a draw that changed the tabs, since More and the tabs drawn may have changed; twice at most.
    for (let again = 0; again < 3 && fitStripTabs(); again++) {
      drawRegions();
    }

    fitMenus();
    fitListLinks();
    watchFades();
    reportBrowser();
    drawConnection();
    keepRoute();
  };
  /** The tab the route names for the shown work item: the column's on a wide page, else the conversation pane's; null for the Conversation. */
  /** The route for what the page shows: its work item, the column's tab on a wide page, else the conversation pane's, History among them, and what that tab shows (route.ts). */
  const routeOf = (): Route => {
    const tab = wide() ? sideTab() : mainTab();
    const shownFile = tab === 'file' ? localFiles.shown() : null;
    const t = tab === 'artifacts' ? `artifact:${openArtifact() ?? ''}` : tab === 'console' || tab === 'history' ? tab : tab === 'browser' ? 'link' : tab === 'diff' ? 'changes' : shownFile !== null ? 'file' : null;

    return { w: wanted, t, f: tab === 'diff' ? changes.focusPath : null, p: shownFile?.target ?? null, l: shownFile?.line ?? null, u: tab === 'browser' ? iframe.selected || null : null, h: null };
  };
  /** Puts the route in the address and keeps it on this device, once the work item asked for shows (route.ts). */
  let keptRoute: string | null = null;
  const keepRoute = (): void => {
    // Until Back's step back lands, the conversation's entry keeps its route, for the browser's forward.
    if (backPending) {
      return;
    }

    // The phone's list is `#list` in the address, so a reload shows the list; the device keeps the work item it showed, for an installed app.
    if (isPhone() && (view.list || wanted === null)) {
      if (parseRoute(location.hash).w !== null) {
        history.replaceState(history.state, '', LIST_HASH);
      }

      keptRoute = null;
      return;
    }

    // No work item: none to come back to.
    const waiting = routing !== null || (wanted !== null && (openingShown() !== null || state.scope?.workItemId !== wanted));
    const hash = waiting ? null : routeHash(routeOf());

    if (hash === null || hash === keptRoute) {
      return;
    }

    keptRoute = hash;

    if ((wanted !== null || /[#&]h=/.test(location.hash)) && location.hash !== hash) {
      history.replaceState(history.state, '', hash);
    }

    try {
      localStorage.setItem(ROUTE_KEY, hash);
    } catch {
      // Kept in the address only.
    }
  };
  /** Tabs whose own viewers scroll inside them, so the pane's scroll means nothing; the Changes tab's place is its file in the route. */
  // An artifact's document scrolls inside its own view: its place is that view's (`artifactTop`).
  // History scrolls its body under its sticky toolbar (`historyPlace`).
  const ownScroller = (tab: Tab): boolean => tab === 'diff' || tab === 'file' || tab === 'console' || tab === 'browser' || tab === 'artifacts' || tab === 'history';
  /** A conversation's place's key: by work item and session, so an earlier session shown keeps its own place and lends it to no other. */
  const conversationPlace = (w: number): string => `${w} conversation ${state.session?.id ?? ''}`;
  /** History's place: its body's scroll top in the pane that shows it. */
  const historyPlace = (places: Record<string, ScrollPlace>, w: number, pane: HTMLElement): Record<string, ScrollPlace> => {
    const body = pane.querySelector<HTMLElement>('.hist-body');

    // Only a body brought back to its place: one still loading would keep the top in place of the operator's place.
    return body === null || historyPlaced.get(pane) !== body ? places : withScroll(places, `${w} history`, { id: null, offset: 0, pinned: false, top: body.scrollTop });
  };
  /** The History body each pane last brought back to its kept place, so it is placed once each time it shows. */
  const historyPlaced = new WeakMap<HTMLElement, HTMLElement>();
  const placeHistory = (pane: HTMLElement): void => {
    const body = pane.querySelector<HTMLElement>('.hist-body');
    const w = state.scope?.workItemId;

    // Not while the ticket's History loads: a body too short for the place would lose it. The state alone draws at once.
    if (body === null || w == null || (offersHistory() && shownHistory?.view == null) || historyPlaced.get(pane) === body) {
      return;
    }

    historyPlaced.set(pane, body);

    const top = scrollPlaces()[`${w} history`]?.top;

    if (top !== undefined) {
      body.scrollTop = top;
    }
  };
  /** The kept scroll top of an artifact's document for the work item shown; null for none. */
  const artifactTop = (path: string): number | null => {
    const w = state.scope?.workItemId;

    return w == null ? null : (scrollPlaces()[`${w} artifact:${path}`]?.top ?? null);
  };
  /** An artifact's place: its document's scroll top in the pane that shows it. */
  const artifactPlace = (places: Record<string, ScrollPlace>, w: number, pane: HTMLElement): Record<string, ScrollPlace> => {
    const view = pane.querySelector<HTMLElement>(':scope > .artifact-view');
    const doc = view?.querySelector<HTMLElement>('.artifact-doc');

    return view?.dataset['artifact'] == null || doc == null ? places : withScroll(places, `${w} artifact:${view.dataset['artifact']}`, { id: null, offset: 0, pinned: false, top: doc.scrollTop });
  };
  /**
   * Keeps where each pane shown is, by work item and tab, for this tab's life and a reload: the conversation by the first item in view and how
   * far below the pane's top it starts, another tab by its scroll top.
   */
  const keepScroll = (): void => {
    const w = state.scope?.workItemId;

    if (w == null || openingShown() !== null || restoringTabs) {
      return;
    }

    let places = scrollPlaces();
    const main = mainTab();

    // A conversation not yet drawn in this page's life keeps the place it had.
    if (main === 'conversation' && placedConversations.has(conversationPlace(w))) {
      const top = panel.getBoundingClientRect().top;
      const first = [...panel.querySelectorAll<HTMLElement>('.timeline > li[data-id]')].find((item) => item.getBoundingClientRect().bottom > top);

      places = withScroll(places, conversationPlace(w), { id: first?.dataset['id'] ?? null, offset: first === undefined ? 0 : first.getBoundingClientRect().top - top, pinned, top: panel.scrollTop });
    } else if (main === 'artifacts') {
      places = artifactPlace(places, w, panel);
    } else if (main === 'history') {
      places = historyPlace(places, w, panel);
    } else if (main !== 'conversation' && !ownScroller(main)) {
      places = withScroll(places, `${w} ${main}`, { id: null, offset: 0, pinned: false, top: panel.scrollTop });
    }

    if (wide() && sideTab() === 'artifacts') {
      places = artifactPlace(places, w, detailBody);
    } else if (wide() && sideTab() === 'history') {
      places = historyPlace(places, w, detailBody);
    } else if (wide() && !ownScroller(sideTab())) {
      places = withScroll(places, `${w} ${sideTab() === 'artifacts' ? `artifact:${openArtifact() ?? ''}` : sideTab()}`, { id: null, offset: 0, pinned: false, top: detailBody.scrollTop });
    }

    for (const [key, top] of fileTops) {
      places = withScroll(places, key, { id: null, offset: 0, pinned: false, top });
    }

    try {
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify(places));
      fileTops.clear();
    } catch {
      // Not kept without session storage.
    }
  };
  /** The kept scroll top of a tab other than the conversation, for the work item shown; null for none. */
  const keptTop = (tab: Tab): number | null => {
    const w = state.scope?.workItemId;

    return w == null || ownScroller(tab) ? null : (scrollPlaces()[`${w} ${tab === 'artifacts' ? `artifact:${openArtifact() ?? ''}` : tab}`]?.top ?? null);
  };

  /**
   * Each file tab's scroll top as the operator left it, by `<work item> file:<target>`, kept with the scroll places; a file in the code view
   * keeps its line instead. The pane that last brought a file tab back to its place, so a scroll there is that tab's.
   */
  const fileTops = new Map<string, number>();
  const filePlaced = new WeakMap<HTMLElement, { key: string; node: HTMLElement }>();
  const fileKey = (): string | null => {
    const w = state.scope?.workItemId;
    const shown = localFiles.shown();

    return w == null || shown === null ? null : `${w} file:${shown.target}`;
  };
  const fileScroller = (pane: HTMLElement): HTMLElement => pane.querySelector<HTMLElement>(':scope > .local-view > .artifact-doc, :scope > .local-view > .local-entries') ?? pane;
  /** Brings a file tab drawn anew in a pane, once read, back to where it was left. */
  const placeFile = (pane: HTMLElement): void => {
    const key = fileKey();
    const shown = localFiles.shown();

    if (key === null || shown === null || shown.entry.state === 'loading' || localFiles.codeShown()) {
      filePlaced.delete(pane);
      return;
    }

    // By its scroller too: a placeholder or a change of layout draws the same file anew.
    const node = fileScroller(pane);
    const placed = filePlaced.get(pane);

    if (placed?.key === key && placed.node === node) {
      return;
    }

    filePlaced.set(pane, { key, node });

    const top = fileTops.get(key) ?? scrollPlaces()[key]?.top;

    if (top !== undefined) {
      node.scrollTop = top;
    }
  };

  for (const pane of [panel, detailBody]) {
    pane.addEventListener(
      'scroll',
      (event) => {
        const key = fileKey();

        if (key !== null && !restoringTabs && openingShown() === null && filePlaced.get(pane)?.key === key && event.target === fileScroller(pane)) {
          fileTops.set(key, fileScroller(pane).scrollTop);
        }
      },
      { capture: true, passive: true, signal: listening.signal },
    );
  }

  /** Keeps the shown work item's tabs (`TabSet`) once its own are drawn, on this device, the latest `TAB_SETS_KEPT`. */
  const rememberTabs = (): void => {
    const w = state.scope?.workItemId;

    // Between a select and its work item's `hello`, the tabs drawn are still the work item's before, or already cleared for the next one.
    if (w == null || restoringTabs || openingShown() !== null || openedItem !== w || wanted !== w) {
      return;
    }

    const files = localFiles.view.tabs;
    const shownFile = files.findIndex((one) => one.id === localFiles.view.open);
    const links = iframe.kept(w);
    const set: TabSet = { side: view.side, tab: view.tab, artifact: view.artifact, changes: changes.view.tab, changesFile: changes.view.tab ? changes.focusPath : null, files: files.map((one) => ({ target: one.target, line: one.line })), file: shownFile === -1 ? null : shownFile, ...(links === null ? {} : { links }) };
    const key = tabSetKey(w);

    if (Object.keys(tabSets).at(-1) === key && JSON.stringify(tabSets[key]) === JSON.stringify(set)) {
      return;
    }

    // Added to what this device's other pages kept since, so a page showing another work item does not drop theirs.
    tabSets = withTabSet(readTabSets() ?? tabSets, w, set);

    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabSets));
    } catch {
      // Kept for this page only.
    }
  };
  /** Puts back a work item's kept tabs: its link tabs, its Changes tab and file tabs, in their order, then the tabs it showed. */
  const restoreTabs = (set: TabSet): void => {
    const w = state.scope?.workItemId ?? null;

    if (w !== null && set.links !== undefined) {
      iframe.restore(w, set.links);

      // Links added from the conversation are tabs of the work item's even when its row has none.
      if (set.links.open.length > 0) {
        linkItem = w;
      }
    }

    // The Changes and file tabs follow the work item from now on, as the next draw would make them.
    changes.follow(followed(), false);
    localFiles.follow(followed());

    if (set.changes) {
      changes.openChanges(set.changesFile);
    }

    for (const one of set.files) {
      localFiles.open(one.target, one.line, false);
    }

    localFiles.view.open = (set.file === null ? undefined : localFiles.view.tabs[set.file])?.id ?? localFiles.view.tabs.at(-1)?.id ?? null;

    if ([...SIDE_TABS, 'diff', 'file'].includes(set.side)) {
      view.side = set.side as SideTab;
    }

    // Where the column folds into the conversation's strip, every opening shows the Conversation tab (PRD R109); the column's tab waits in `side`.
    view.tab = wide() && TABS.some((one) => one.tab === set.tab) ? (set.tab as Tab) : 'conversation';

    // An artifact gone or closed since leaves its tab to History (`sideTab`, `mainTab`).
    view.artifact = set.artifact !== null && state.artifacts.some((one) => one.path === set.artifact) && !closedNow().has(set.artifact) ? set.artifact : null;
    tabChosen = true;
  };

  window.addEventListener('pagehide', () => (keepScroll(), rememberTabs()), { signal: listening.signal });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && keepScroll(), { signal: listening.signal });
  document.addEventListener('visibilitychange', () => (localFiles.refresh(), changes.refreshFile()), { signal: listening.signal });


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

            return answer.status === 200 ? null : String(answer.body['error'] ?? `The keys were not sent to the session (status ${answer.status}).`);
          },
          copy: (text) => void navigator.clipboard?.writeText(text).catch(() => undefined),
          readOnly: state.scope?.earlier === true,
        }),
      );
    });
  }

  // ---- Seen ----
  const visibleSince = new Map<string, number>();
  const reported = new Set<string>();
  let seenFor: string | null = null;
  let hostFocused = false;
  const focusedVisible = (): boolean => document.visibilityState !== 'hidden' && (document.hasFocus() || hostFocused);
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

    // The conversation's pane, and on a wide screen the History and Artifacts column beside it.
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

  window.addEventListener('focus', () => reportFocus(), { signal: listening.signal });
  window.addEventListener('blur', () => reportFocus(), { signal: listening.signal });
  document.addEventListener('visibilitychange', () => reportFocus(), { signal: listening.signal });

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
  /** The History the History tab shows, the open work item's ticket's, or null before it first shows; each ticket's settings last while the page is open. */
  let shownHistory: HistoryOpen | null = null;
  /** Whether the History tab shows, so the page reads the hub for it. */
  let historyLive = false;
  const historyUis = new Map<number, HistoryUi>();
  let historyTick: ReturnType<typeof setInterval> | null = null;
  let historyChange: ReturnType<typeof setTimeout> | null = null;
  // Each read of the hub, so an answer that a later read overtook is dropped.
  let historyRead = 0;
  /** Reads the shown History from the hub; a failed read keeps what it shows and says why. */
  const readHistory = async (): Promise<void> => {
    const asked = shownHistory;

    if (asked === null || !historyLive) {
      return;
    }

    const read = ++historyRead;
    const answer = await post('page-history', { ticketId: asked.ticketId });

    if (shownHistory !== asked || read !== historyRead) {
      return;
    }

    if (answer.status === 200 && typeof answer.body['view'] === 'object' && answer.body['view'] !== null) {
      asked.view = answer.body['view'] as HistoryView;
      asked.categories = (answer.body['categories'] as HistoryCategory[] | undefined) ?? [];
      asked.error = null;
    } else {
      asked.error = String(answer.body['error'] ?? (answer.status === 200 ? 'Switchboard sent no History.' : `Switchboard did not answer (status ${answer.status}).`));
    }

    draw();
  };
  /**
   * Follows whether the History tab shows, on each draw: while it does, the open work item's ticket's History is read at once, every
   * `HISTORY_REFRESH_MS` and soon after a list change; another ticket's starts at Loading…, and the same ticket's keeps what it showed until
   * the read answers. Hidden, it reads nothing, and an answer on its way is dropped.
   */
  const followHistory = (shows: boolean): void => {
    const ticket = shows ? (selectedRow(state)?.history ?? null) : null;

    if (ticket === null) {
      if (historyLive) {
        historyLive = false;
        historyRead++;
        clearInterval(historyTick ?? undefined);
        clearTimeout(historyChange ?? undefined);
        historyTick = null;
        historyChange = null;
      }

      return;
    }

    if (shownHistory?.ticketId !== ticket.ticketId) {
      shownHistory = { ticketId: ticket.ticketId, key: ticket.key, view: null, categories: [], error: null, ui: historyUis.get(ticket.ticketId) ?? { ...EMPTY_HISTORY_UI } };
      historyRead++;
    } else if (historyLive) {
      return;
    }

    historyLive = true;
    historyTick ??= setInterval(() => void readHistory(), HISTORY_REFRESH_MS);
    void readHistory();
  };
  /** The head History shows before its ticket's History loads: the open work item's row and scope (`HistoryHead`). */
  const historyHead = (): HistoryHead => {
    const row = selectedRow(state);

    return {
      key: row?.history?.key ?? row?.ticket ?? '',
      title: state.scope?.title ?? row?.title ?? '',
      sourceKind: row?.sourceKind ?? null,
      playbook: row === null || row === undefined || row.playbook === '' ? null : row.playbook,
      status: row?.mark?.title ?? null,
      needsYou: needsYou(row ?? null),
      workItemId: state.scope?.workItemId ?? row?.workItemId ?? null,
      sessionId: state.scope?.sessionId ?? null,
    };
  };
  /** The operator changed the open History's chips, filter, groups, runs or state bodies: kept for the ticket while the page is open. */
  const setHistoryUi = (ui: HistoryUi): void => {
    if (shownHistory !== null) {
      shownHistory.ui = ui;
      historyUis.set(shownHistory.ticketId, ui);
    }
  };

  root.addEventListener('input', (event) => {
    const field = event.target as HTMLInputElement;

    if (shownHistory !== null && field.classList?.contains('hist-filter')) {
      setHistoryUi({ ...shownHistory.ui, query: field.value });
      draw();
    }
  }, { signal: listening.signal });
  // A section or run the operator opened or closed stays so across redraws.
  root.addEventListener(
    'toggle',
    (event) => {
      const details = event.target as HTMLDetailsElement;
      const section = details.dataset?.['section'];
      const run = details.dataset?.['run'];
      const body = details.dataset?.['body'];

      if (shownHistory === null || !(details instanceof HTMLDetailsElement) || details.closest('.history-view') === null) {
        return;
      }

      // Drawn again, so the next drawing compares against what the page shows, and Expand all opens a run the operator closed.
      if (body !== undefined && shownHistory.ui.bodies[body] !== details.open) {
        setHistoryUi({ ...shownHistory.ui, bodies: { ...shownHistory.ui.bodies, [body]: details.open } });
        draw();
      } else if (section !== undefined && (shownHistory.ui.sections[section] ?? null) !== details.open) {
        setHistoryUi({ ...shownHistory.ui, sections: { ...shownHistory.ui.sections, [section]: details.open } });
        draw();
      } else if (run !== undefined && shownHistory.ui.runs.includes(run) !== details.open) {
        setHistoryUi({ ...shownHistory.ui, runs: details.open ? [...shownHistory.ui.runs, run] : shownHistory.ui.runs.filter((one) => one !== run) });
        draw();
      }
    },
    { capture: true, signal: listening.signal },
  );

  // ---- Selecting ----
  /** The earlier session the page shows, or null for the current one. */
  const shownSession = (): string | null => (state.scope?.earlier === true ? state.scope.sessionId : null);
  /**
   * What the Changes and file tabs follow: the work item shown, so a reconnect's new page key or scope generation keeps them, and so does a new
   * session of the same work item, as an approval, a retry or a reopen starts; null with none.
   */
  function followed(): string | null {
    return state.scope === null || state.key === null ? null : String(state.scope.workItemId ?? '');
  }

  /** The newest `select`, and the comment it waits to send first. */
  let selecting = 0;
  let flushing: Promise<unknown> | null = null;
  /**
   * Opens a work item; `sameHead` for a conversation the shown work item's dropdown made, which opens under its head. `sessionId` names an earlier
   * session of it to show read-only; null shows its current session.
   */
  const select = async (workItemId: number, sameHead = false, sessionId: string | null = null): Promise<void> => {
    const mine = ++selecting;

    cardWanted = null;

    // comment still waiting goes to its conversation before the page moves on, while the hub still takes it from this page; a later choice
    // wins over this one while it waits.
    if (commentTimers.size > 0) {
      const all = Promise.all([flushing, flushComments()]);

      flushing = all;
      void all.finally(() => {
        if (flushing === all) {
          flushing = null;
        }
      });
    }

    if (flushing !== null) {
      await flushing;

      if (mine !== selecting) {
        return;
      }
    }

    if (hostSelection !== null && hostSelection.item !== workItemId) hostSelection = null;
    const listing = view.list || wanted === null;

    listFocus = `item:${workItemId}`;
    if (pendingRowControl?.key !== listFocus) pendingRowControl = null;
    closeMenus();

    // Where the work item left is kept, and its tabs, for when it is opened again.
    keepScroll();
    rememberTabs();

    // Choosing a work item hides the drawer.
    closeDrawer();
    wanted = workItemId;
    wantedSession = sessionId;
    showError(null);
    // Another work item shows its own head and a placeholder at once, not the one shown before (opening.tsx).
    // A conversation of the shown work item's dropdown opens under the same head, as before.
    opening = !sameHead && (state.scope === null || !state.scope.conversations.some((entry) => entry.workItemId === workItemId)) ? { workItemId, title: rowTitle(workItemId), error: null } : null;
    hostPending = opening === null ? workItemId : null;

    // Asked again after its open failed.
    if (acked === workItemId && (state.scope?.workItemId !== workItemId || shownSession() !== sessionId)) {
      acked = null;
    }

    view.list = false;
    view.picker = false;
    view.actions = false;
    view.sheet = null;
    leaveDraft();
    selections++;
    closeMenu();
    view.artifact = null;
    // On a phone, a conversation opened from the list is a history entry of its own, which the browser's back, as Android's back button, leaves.
    if (listing && isPhone() && !conversationEntry(history.state)) {
      history.replaceState(history.state, '', LIST_HASH);
      history.pushState({ [CONVERSATION_ENTRY]: true }, '', `#w=${workItemId}`);
    } else {
      history.replaceState(history.state, '', `#w=${workItemId}`);
    }

    // Where the column folds into the conversation's tabs, the work item already open shows its Conversation tab again; another opens on it
    // with its hello (`openTabs`), so a refused select leaves the open work item's tab as it was.
    if (state.scope?.workItemId === workItemId && !wide()) {
      view.tab = 'conversation';
    }

    // Nothing to ask while the page shows what the hub last took, or what it shows with nothing taken since; an answer whose scope has not
    // come yet is corrected by asking again.
    if (state.scope?.workItemId === workItemId && shownSession() === sessionId && !selectInFlight && (acked === null || (acked === workItemId && ackedSession === sessionId))) {
      acked = workItemId;
      ackedSession = sessionId;
      draw();
      return;
    }

    reconcile();
    // A narrow screen leaves the list at once; the conversation follows with the select's scope.
    draw();
  };
  /**
   * Shows one session of the shown work item from its dropdown or the earlier session's note: an earlier one read-only, or with null its current
   * one, through the same requests as `select`, keeping the tab, the artifact and the places shown.
   */
  const selectSession = (workItemId: number, sessionId: string | null): void => {
    cardWanted = null;
    closeMenus();
    leaveDraft();
    selections++;
    closeMenu();
    view.picker = false;
    showError(null);
    wanted = workItemId;
    wantedSession = sessionId;
    hostPending = workItemId;
    reconcile();
    draw();
  };
  /** The work item being opened, until its `hello` brings it, or why it could not be opened. */
  let opening: Opening | null = null;
  /**
   * The page's latest choice that opens under the shown head (a conversation of its host group, the shown one again or one of its sessions), until
   * a scope comes while no select is outstanding (its own, or one the hub showed itself), or a refusal; null with none.
   */
  let hostPending: number | null = null;
  /** The opening to draw: one whose work item is not the one the page shows yet. */
  // Until the work item's own hello clears it: a `scope` event alone brings none of its conversation.
  const openingShown = (): Opening | null => (opening === null ? null : { ...opening, title: rowTitle(opening.workItemId) });
  /**
   * The work item the list draws selected: the one opening, else the page's latest choice under the shown head while it is pending (`hostPending`),
   * else the one shown, also when the hub itself shows another, as New session does.
   */
  const listSelected = (): number | null => opening?.workItemId ?? hostPending ?? state.scope?.workItemId ?? null;
  const rowTitle = (workItemId: number): string => state.groups.flatMap((group) => group.rows).find((row) => row.workItemId === workItemId)?.title ?? 'Work item';
  /** Try again: the open is asked once more. */
  const retryOpening = (): void => {
    if (opening?.error == null) {
      return;
    }

    opening = { ...opening, error: null };
    acked = null;
    reconcile();
    draw();
  };
  /** Back to the list from an open that failed: the work item the hub still shows is the page's again, and a phone shows the list. */
  const leaveOpening = (): void => {
    opening = null;
    hostPending = null;
    wanted = state.scope?.workItemId ?? null;
    wantedSession = shownSession();
    acked = wanted;
    ackedSession = wantedSession;
    // The list's keyboard place follows back to the work item shown, as after a refused select of the shown one's dropdown.
    listFocus = wanted === null ? null : `item:${wanted}`;
    pendingRowControl = null;
    history.replaceState(history.state, '', wanted === null ? '#' : `#w=${wanted}`);

    if (isPhone() || wanted === null) {
      back();
    } else {
      draw();
    }
  };
  // One select at a time; the latest work item asked for wins, whatever order the answers and scope events come in.
  let selectInFlight = false;
  let acked: number | null = null;
  /** The earlier session of `wanted` the page asks to show, null for its current one, and the one the hub last took with `acked`. */
  let wantedSession: string | null = null;
  let ackedSession: string | null = null;
  const reconcile = (): void => {
    if (wanted === null || selectInFlight || state.key === null || (acked === wanted && ackedSession === wantedSession)) {
      return;
    }

    const asked = wanted;
    const askedSession = wantedSession;
    const key = state.key;

    selectInFlight = true;
    void post('select', { workItemId: asked, ...(askedSession === null ? {} : { sessionId: askedSession }) }, false, { timeout: NAVIGATION_MS }).then((answer) => {
      // An answer for a stream that has gone leaves the new stream's select alone.
      if (key !== state.key) {
        return;
      }

      selectInFlight = false;
      if (answer.status !== 200 && hostSelection?.item === asked) hostSelection = null;
      if (answer.status !== 200 && pendingRowControl?.key === `item:${asked}`) pendingRowControl = null;

      if (answer.status === 200) {
        acked = asked;
        ackedSession = askedSession;
      } else if (wanted === asked && wantedSession === askedSession && opening?.workItemId === asked) {
        // The refusal replaces the view, for the work item asked for, until Try again or Back to the list; it is not asked again meanwhile.
        acked = asked;
        ackedSession = askedSession;
        opening = { workItemId: asked, title: rowTitle(asked), error: String(answer.body['error'] ?? FAILURE_TEXT.bad) };
        draw();
      } else if (wanted === asked && wantedSession === askedSession) {
        // Another conversation or session of the shown work item's dropdown: the shown one stays, with why above its box.
        wanted = state.scope?.workItemId ?? null;
        wantedSession = shownSession();
        acked = wanted;
        ackedSession = wantedSession;
        hostPending = null;
        listFocus = wanted === null ? null : `item:${wanted}`;
        pendingRowControl = null;
        if (view.rowMenu === `item:${asked}`) closeMenus();
        history.replaceState(history.state, '', wanted === null ? '#' : `#w=${wanted}`);
        showError(String(answer.body['error'] ?? FAILURE_TEXT.bad));
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
  // The browser's back, as Android's back button, leaves a phone's conversation as Back does, and its forward opens it again at its route; the
  // list's entry is `#list`. Outside the phone's layout opening a work item adds no entry (the operator's decision), so only an address edited
  // by hand moves the page, to its route.
  window.addEventListener(
    'popstate',
    (event) => {
      const left = backPending;

      backPending = false;

      if (!isPhone()) {
        if (location.hash !== keptRoute) {
          applyRoute(parseRoute(location.hash), 'popstate');
        }

        return;
      }

      const listing = view.list || wanted === null;

      // A row opened before Back's own step back landed gets its entry again.
      if (left) {
        keptRoute = null;

        if (listing) {
          history.replaceState(history.state, '', LIST_HASH);
        } else {
          history.pushState({ [CONVERSATION_ENTRY]: true }, '', `#w=${wanted}`);
          draw();
        }

        return;
      }

      if (conversationEntry(event.state)) {
        view.list = false;
        applyRoute(parseRoute(location.hash), 'popstate');
        return;
      }

      history.replaceState(history.state, '', LIST_HASH);

      if (!listing) {
        back();
      }
    },
    { signal: listening.signal },
  );
  /**
   * Shows what a route names (route.ts), at the start and on the browser's back and forward or an address edited by hand, never on a `tabs`
   * event: its work item, opened as a row's click opens it, then, once that work item shows, its tab (`routeTab`). At the start the stream is
   * not open yet, so the work item opens once it is.
   */
  const applyRoute = (route: Route, cause: 'start' | 'popstate'): void => {
    if (route.w === null) {
      return;
    }

    routing = route;

    if (cause === 'start') {
      wanted = route.w;
      opening = { workItemId: route.w, title: '', error: null };
    } else if (route.w === wanted && state.scope?.workItemId === route.w && openedItem === route.w && openingShown() === null) {
      routeTab();
      draw();
    } else {
      void select(route.w);
    }
  };
  /**
   * Shows the tab the route names for the work item shown, as no choice of the operator's (`openDoc` without `chosen`): an artifact gone or
   * closed on every device gives way to History. Where the column folds into the conversation's strip, the route's tab waits in the column's
   * choice and the page shows the Conversation tab, as every opening does there (PRD R109).
   */
  const routeTab = (): void => {
    const route = routing;

    routing = null;

    if (route === null || route.w !== state.scope?.workItemId) {
      return;
    }

    // History is a tab of the work item's (an address from before kept it as `h`), so a route that named it opens that tab.
    const tab = route.t ?? (route.h != null ? 'history' : null);
    const path = tab?.startsWith('artifact:') === true ? tab.slice('artifact:'.length) : null;

    restoringTabs = true;
    // The Changes and file tabs follow the work item from now on, as the next draw would make them.
    changes.follow(followed(), false);
    localFiles.follow(followed());

    try {
      if (path !== null) {
        if (state.artifacts.some((one) => one.path === path) && !closedNow().has(path)) {
          openDoc(`artifact:${path}`, { chosen: false });
        } else {
          view.artifact = null;
          chooseTab('history');
        }
      } else if (tab === 'link') {
        if (route.u != null) {
          openDoc(`link:${route.u}`, { chosen: false });
        } else if (showBrowser()) {
          chooseTab('browser');
        }
      } else if (tab === 'history' || (tab === 'console' && showConsole())) {
        chooseTab(tab);
      } else if (tab === 'changes') {
        changes.openChanges(route.f ?? null);
      } else if (tab === 'file' && route.p != null) {
        openDoc(`file:${route.p}`, { line: route.l ?? null, chosen: false });
      } else if (tab === null) {
        chooseTab('conversation');
      }
    } finally {
      restoringTabs = false;
    }

    if (!wide()) {
      view.tab = 'conversation';
    }
  };

  applyRoute(firstRoute, 'start');
  // A swipe right over a phone's conversation goes back, while no menu, sheet or Settings lies over it.
  const stopSwipe = swipeBack({
    root,
    host: root.querySelector<HTMLElement>('.main')!,
    under: drawer,
    enabled: () => isPhone() && !root.classList.contains('listing') && document.querySelector('.menu, [role="menu"], [role="listbox"]:not([hidden]), .sheet-backdrop, .settings-backdrop, .persona-backdrop') === null,
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
  /** Drops a card's own draft once the hub holds it: nothing on its way, no comment waiting, and the last draft sent carried back. */
  const settleCard = (ui: CardDraft): boolean => {
    if (ui.local === null || ui.pending > 0 || ui.unsent === true || ui.awaiting !== undefined) {
      return false;
    }

    ui.local = null;
    return true;
  };
  /** Marks each card's last draft carried back once the hub's drafts hold it; an event from before the hub took it leaves this page's. */
  const takeDrafts = (questions: unknown): void => {
    const hub = (questions as { drafts?: Record<string, unknown> } | null | undefined)?.drafts ?? {};

    for (const [key, ui] of view.cards) {
      if (ui.awaiting !== undefined && hub[key] !== undefined && sameDraft(hub[key]) === ui.awaiting) {
        ui.awaiting = undefined;
      }

      settleCard(ui);
    }
  };
  /** A draft as text whatever its keys' order, to tell whether the hub's draft is the one this page sent. */
  const sameDraft = (draft: unknown): string => JSON.stringify(draft, (_key, value: unknown) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : value));
  /** The conversation a card command goes to: the session shown, at the scope generation it is shown at. */
  type CardTarget = { sessionId: string; scopeGen: number };
  const cardTarget = (): CardTarget | null => (state.session === null ? null : { sessionId: state.session.id, scopeGen: state.scope?.scopeGen ?? -1 });
  /** Each card's comment waiting for the typing to pause, by `<session ID> <card key>`, with the conversation it was typed in. */
  const commentTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; target: CardTarget; key: string }>();
  /**
   * Shows a card's new draft and tells the hub, for the conversation shown or the one given; `quiet` leaves the page undrawn, as while a Comment
   * field is typed in. The draft carries any comment still waiting, so its timer goes.
   */
  const setDraft = (key: string, draft: SharedDraft, quiet = false, target: CardTarget | null = cardTarget()): Promise<void> => {
    const ui = cardUi(key);
    const waiting = target === null ? undefined : commentTimers.get(`${target.sessionId} ${key}`);

    if (waiting !== undefined) {
      clearTimeout(waiting.timer);
      commentTimers.delete(`${target!.sessionId} ${key}`);
    }

    ui.local = draft;
    ui.unsent = false;
    ui.error = null;

    if (!quiet) {
      draw();
    }

    if (target === null) {
      return Promise.resolve();
    }

    const gen = (ui.gen ?? 0) + 1;

    ui.gen = gen;
    ui.pending++;
    ui.awaiting = sameDraft(draft);
    // A conversation still shown goes at the generation it is shown at now, as after a reconnect.
    const scopeGen = target.sessionId === state.session?.id ? (state.scope?.scopeGen ?? target.scopeGen) : target.scopeGen;

    return command('card-draft', { ...target, scopeGen, card: key, draft }).then((answer) => {
      ui.pending--;

      // Only the newest draft's answer counts; an older one's is overtaken by it.
      if (gen === ui.gen) {
        if (answer.status === 0) {
          // No answer came: unless an event already carried it back, it stays this page's, to go with the next change; newer typing stays too.
          ui.unsent = ui.unsent === true || ui.awaiting !== undefined;
        } else if (answer.status !== 200) {
          // The hub refused it: the hub's draft shows.
          ui.awaiting = undefined;
        } else if (ui.awaiting !== undefined && sameDraft(state.questions?.drafts[key]) === ui.awaiting) {
          // The hub already showed this page the same draft, so no event will carry it.
          ui.awaiting = undefined;
        }
      }

      if (settleCard(ui)) {
        draw();
      }
    });
  };
  /** Sends each card's comment still waiting for a pause now, to the session it was typed in, as before the page shows another conversation. */
  const flushComments = (): Promise<unknown> =>
    Promise.all(
      [...commentTimers.values()].map(({ target, key }) => {
        const local = cardUi(key).local;

        return local === null ? undefined : setDraft(key, local, true, target);
      }),
    );
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

    const answer = await command('send', { sessionId: session.id, launch: session.launch, answers: given.map(({ one, pick }) => ({ card: key, slug: one.question.slug, letters: pick.letters, other: pick.other ?? '' })) }, { timeout: SEND_TRY_MS, retryFor: SEND_RETRY_MS });
    const id = (answer.body['message'] as { id?: string } | undefined)?.id ?? null;
    const late = id === null ? undefined : unsent.get(id);

    ui.sending = false;

    if (answer.status !== 200 || late !== undefined) {
      ui.error = late?.error ?? String(answer.body['error'] ?? 'Your message was not sent. Try again.');
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
  /** Picks or drops a letter; the card stays on the question, so its comment can follow, until Next. */
  const pickCard = (key: string, slug: string, letter: string): void => {
    const card = cardNow(key);

    if (card !== null) {
      setDraft(key, pickLetter(card, cardDraftOf(key), slug, letter));
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

    return { card: key, selector: field ? '.qc-comment' : data === '' ? '' : data, start: field ? active.selectionStart : null, end: field ? active.selectionEnd : null };
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
  /** Scope-bound menu controls select their row only when chosen, and wait for the hub's matching scope before running. */
  const forRow = (key: string, run: () => void): void => {
    const row = rowByKey(key);
    if (row === null) return;
    if (row.workItemId === null || (row.workItemId === state.scope?.workItemId && (wanted === null || wanted === row.workItemId))) { run(); return; }
    pendingRowControl = { key, run };
    void select(row.workItemId);
  };
  /** Selects the open work item's History tab and gives it the focus. */
  const openHistory = (): void => {
    leaving('history');
    chooseTab('history');
    view.artifact = null;
    draw();
    (wide() ? detailHead : head).querySelector<HTMLElement>('[data-side="history"], [data-tab="history"]')?.focus();
  };
  /** The strip's tabs as drawn (tabs.ts), in its order at the page's width. */
  const docTabs = (): DocTab[] =>
    stripTabs({ shown: wide() ? sideTab() : mainTab(), stateUnread: false, browser: showBrowser(), ...(browserTab() ? { links: iframe.tabs, link: iframe.selected } : {}), artifacts: state.artifacts, open: openArtifact(), closed: closedNow(), files: localFiles.view, changes: true, console: showConsole() }, wide() ? 'wide' : 'narrow');
  /**
   * Opens a document's tab, or selects the tab it has (architecture.md § Web page), whatever opened it: a conversation or History link, Open
   * report, an artifact card, the More menu or a route. `id` is `artifact:<path>`, `file:<path>` at `line` or `link:<url>` named `name`. A file the hub reads as an artifact gives way to that artifact's tab (localFiles.tsx). Without `chosen`, as for a restore, it is no
   * choice of the operator's: it keeps nothing in the hub (`page-tabs`) and opens no closed artifact again.
   */
  const openDoc = (id: string, { line = null, name = '', chosen = true }: { line?: number | null; name?: string; chosen?: boolean } = {}): void => {
    view.tabMenu = false;

    if (id.startsWith('artifact:')) {
      const path = id.slice('artifact:'.length);

      if (!chosen && closedNow().has(path)) {
        draw();
        return;
      }

      leaving('artifacts');
      chooseTab('artifacts');
      view.artifact = path;

      // Choosing a closed artifact opens its tab again.
      if (closedNow().has(path)) {
        setClosed(path, false);
      }

      draw();

      if (chosen) {
        saveTab();
      }
    } else if (id.startsWith('file:')) {
      localFiles.open(id.slice('file:'.length), line, chosen);
    } else if (id.startsWith('link:')) {
      const url = id.slice('link:'.length);
      const w = state.scope?.workItemId ?? null;

      if (!chosen) {
        // A route's link tab: kept among the work item's link tabs and selected, with or without the extension, never opened in a browser tab.
        if (w !== null && browserTab() && frameUrl(url)) {
          const kept = iframe.kept(w) ?? { open: [], closed: [], selected: '' };

          iframe.restore(w, { ...kept, open: kept.open.some((one) => one.url === url) ? kept.open : [...kept.open, { url, name: '' }], selected: url });
          linkItem = w;
          chooseTab('browser');
        }

        draw();
      } else if (browserTab() && !iframe.available && iframe.select(url)) {
        // Without the extension a link tab selects all the same, and its pane offers the link in a browser tab.
        leaving('browser');
        chooseTab('browser');
        draw();
      } else {
        openWebLink(url, name);
      }
    }
  };
  /** Shows a tab of the strip, History on a wide page or the conversation on a narrow one for none, without keeping it as a choice (`closeDoc`). */
  const showDoc = (tab: DocTab | undefined): void => {
    if (tab?.kind === 'artifact') {
      view.artifact = tab.artifact.path;
      chooseTab('artifacts');
    } else if (tab?.kind === 'file') {
      localFiles.select(tab.file.id);
      chooseTab('file');
    } else if (tab?.kind === 'link') {
      if (!iframe.open(tab.link.url)) {
        iframe.select(tab.link.url);
      }

      chooseTab('browser');
    } else {
      chooseTab(wide() ? 'history' : 'conversation');
    }
  };
  /**
   * Closes a document's tab: a link, an artifact or a file (architecture.md § Web page). Closing the tab shown shows its neighbour in
   * the strip, the one before it, else the one after it; closing another changes nothing else. What shows next is no choice of the operator's,
   * so it posts no `page-tabs`; only an artifact's close is kept, for every device. The focus goes to the tab shown when the closed tab showed or
   * had the focus (`focused`).
   */
  const closeDoc = (id: string, focused = false): void => {
    const docs = docTabs().filter(closable);
    const at = docs.findIndex((tab) => tab.id === id);
    const shown = at !== -1 && docs[at]!.selected;

    if (id.startsWith('artifact:')) {
      const path = id.slice('artifact:'.length);

      setClosed(path, true);

      // Nor does the column show it later, on a wider page.
      if (view.artifact === path) {
        view.artifact = null;
      }
    } else if (id.startsWith('link:')) {
      iframe.close(id.slice('link:'.length));
    } else if (id.startsWith('file:')) {
      localFiles.remove(id.slice('file:'.length));
    }

    view.tabMenu = false;

    if (shown) {
      showDoc(docs[at - 1] ?? docs[at + 1]);
    }

    draw();

    if (shown || focused) {
      (wide() ? detailHead : head).querySelector<HTMLElement>('.tabs [role="tab"][aria-selected="true"]')?.focus();
    }
  };
  const openRowMenu = (key: string, point?: { x: number; y: number }): void => {
    const row = rowByKey(key);
    if (row === null || menuRows(row, view).length === 0) return;
    listFocus = key;
    closeMenus();
    view.picker = false;
    view.viewMenu = false;
    view.rowMenu = key;
    rowMenuPoint = point;
    draw();
    // The menu itself takes the focus, with no row chosen, so Enter alone runs nothing; Down or Up chooses the first or last row.
    list.querySelector<HTMLElement>('.row-menu')?.focus();
  };
  list.addEventListener('contextmenu', (event) => {
    const target = event.target as HTMLElement;
    const entry = target.closest<HTMLElement>('.list-row');
    if (entry === null) return;
    event.preventDefault();
    if (target.closest('.row-menu') !== null) return;
    const row = entry.querySelector<HTMLElement>('.row')!;
    // Windows can follow the Menu key's keydown with contextmenu after focus has moved into the menu.
    if (view.rowMenu === row.dataset['row'] && event.button !== 2) return;
    const box = row.parentElement!.getBoundingClientRect();
    openRowMenu(row.dataset['row']!, { x: event.clientX - box.left, y: event.clientY - box.top });
  }, { signal: listening.signal });
  list.addEventListener('focusin', (event) => {
    const target = event.target as HTMLElement;
    const stop = target.closest('.row, .group-head, .band-head');
    if (stop !== null && stopId(stop) !== listStop) {
      listStop = stopId(stop);
      setListTabStop();
    }
    if (!target.matches('.row') || listFocus === target.dataset['row']) return;
    // The focus is not the selection: only the open work item's row is drawn selected (list.tsx), so a focus needs no redraw.
    listFocus = target.dataset['row']!;
    target.scrollIntoView?.({ block: 'nearest' });
  }, { signal: listening.signal });
  list.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || view.rowMenu !== null) return;
    const target = event.target as HTMLElement;
    if (target.matches('.pill[data-action="open-link"], .row-head .questions') && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      target.click();
      return;
    }
    if (!target.matches('.row, .group-head, .band-head')) return;
    const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (target.matches('.row') && ((plain && event.key === 'ContextMenu') || (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'F10'))) {
      event.preventDefault();
      openRowMenu(target.dataset['row']!);
    } else if (plain && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const stops = [...list.querySelectorAll<HTMLElement>('.row, .group-head, .band-head')];
      const next = stops[stops.indexOf(target) + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next === undefined) return;
      if (next.matches('.row')) listFocus = next.dataset['row']!;
      next.focus({ preventScroll: true });
      next.scrollIntoView?.({ block: 'nearest' });
    } else if (plain && target.matches('.row') && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      target.click();
    }
  }, { signal: listening.signal });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pendingRowControl !== null) {
      pendingRowControl = null;
      event.preventDefault();
      return;
    }
    if (event.key !== 'F8' || event.ctrlKey || event.metaKey || event.altKey || !state.connected || view.sheet !== null || view.personas !== null || settingsPane.isOpen() || root.querySelector('.sheet-backdrop') !== null) return;
    event.preventDefault();
    const rows = state.groups.flatMap((group) => group.rows.map((row) => ({ group, row })));
    const selected = listFocus ?? (state.scope?.workItemId == null ? null : `item:${state.scope.workItemId}`);
    const at = rows.findIndex(({ row }) => rowKey(row) === selected);
    const start = at < 0 ? (event.shiftKey ? rows.length : -1) : at;
    for (let step = 1; step <= rows.length; step++) {
      const entry = rows[((start + (event.shiftKey ? -step : step)) % rows.length + rows.length) % rows.length]!;
      // A stripe is the hub's operator-turn signal; an idle hosted conversation has neither a stripe nor agent-turn dimming.
      if (!['blocked', 'review'].includes(entry.group.key) || entry.row.stripe === null || entry.row.workItemId === null) continue;
      closeMenus();
      listFocus = rowKey(entry.row);
      const hidden = !header.list(state.groups).groups.some((group) => group.rows.some((row) => rowKey(row) === listFocus));
      if (hidden) header.clearSearch();
      view.collapsed.delete(entry.group.key);
      keepGroup(entry.group.key, true);
      if (entry.row.band !== null) view.bands.set(`${entry.group.key}:${entry.row.band}`, true);
      void select(entry.row.workItemId);
      draw();
      const target = listRowElement(listFocus);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: 'nearest' });
      break;
    }
  }, { signal: listening.signal });
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;

    // A More menu row does what its tab does, and the menu closes.
    if (view.tabMenu && target.closest('.tab-menu .menu-row') !== null) {
      view.tabMenu = false;
    }

    if (changes.click(target) || localFiles.click(target)) {
      return;
    }

    // Supported conversation links open in their own embedded tab, else in the extension's tab group when it answers, else as links do.
    const web = target.closest<HTMLAnchorElement>('.body a[href][target="_blank"]');

    if (web !== null && webLink(web.getAttribute('href') ?? '') && (browserReady() || extensionLinks)) {
      event.preventDefault();
      openWebLink(web.href, web.textContent ?? '');
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

    // A click or a tap anywhere on a folded reply's text opens it, as one on its fade does; a link, a button or a fold in it does its own thing,
    // and a drag that selects text does nothing.
    const foldedBody = target.closest<HTMLElement>('li.reply.folded > .body');

    if (foldedBody !== null && target.closest('a, button, summary, details, input, textarea, select, label') === null && (document.getSelection()?.isCollapsed ?? true)) {
      openReply(foldedBody.parentElement!.dataset['id']!);
      return;
    }

    const button = target.closest<HTMLElement>('[data-action]');
    const action = button?.dataset['action'];

    switch (action) {
      case 'select': {
        const workItemId = Number(button!.dataset['workItem']);

        listFocus = button!.dataset['row'] ?? null;
        // The dropdown's row or the note's button of the shown work item shows its current session in place; a list row opens the work item.
        if (button!.dataset['row'] === undefined && state.scope?.workItemId === workItemId && state.scope.earlier === true) {
          selectSession(workItemId, null);
        } else {
          void select(workItemId);
        }

        break;
      }
      case 'select-session':
        // An earlier session of the shown work item, read-only.
        selectSession(Number(button!.dataset['workItem']), button!.dataset['session'] ?? null);
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
      case 'draft-provider':
        if (view.newDraft !== null && !view.newDraft.sending) {
          view.newDraft.provider = button!.dataset['provider'] ?? view.newDraft.provider;
          keepNewDraft(view.newDraft.workItemId, view.newDraft);
          draw();
          input.focus();
        }
        break;
      case 'draft-cancel':
        leaveDraft();
        draw();
        break;
      case 'picker':
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
        view.copyMenu = false;
        view.rowMenu = null;
        view.picker = false;
        view.viewMenu = false;
        draw();
        break;
      case 'row-action':
        forRow(button!.dataset['row'] ?? '', () => chooseAction(button!.dataset['row'] ?? '', button!.dataset['label'] ?? ''));
        break;
      case 'row-paste':
        forRow(button!.dataset['row'] ?? '', () => void copyPaste(button!.dataset['label'] ?? ''));
        break;
      case 'row-command':
        forRow(button!.dataset['row'] ?? '', () => void runCommand(button!.dataset['label'] ?? ''));
        break;
      case 'open-link':
        event.preventDefault();
        openLink(button!.dataset['row'] ?? '', button!.dataset['link'] ?? '', event.ctrlKey || event.metaKey);
        break;
      case 'row-history':
        // The menu's work item's History tab: the header's menu names the open work item; a row's menu in the list selects its row first (forRow).
        forRow(button!.dataset['row'] ?? '', () => {
          closeMenus();

          // A row's menu runs this once its work item's scope comes; its `hello` then puts its kept tabs back, so History opens after that.
          if (state.scope?.workItemId != null && state.scope.workItemId !== openedItem) {
            historyOnHello = state.scope.workItemId;
            draw();
          } else {
            openHistory();
          }
        });
        break;
      case 'history-chip':
        if (shownHistory !== null) {
          const category = button!.dataset['category'] ?? '';
          const hidden = shownHistory.ui.hidden.includes(category) ? shownHistory.ui.hidden.filter((one) => one !== category) : [...shownHistory.ui.hidden, category];

          setHistoryUi({ ...shownHistory.ui, hidden });
          draw();
        }

        break;
      case 'history-chips':
        if (shownHistory !== null) {
          setHistoryUi({ ...shownHistory.ui, chips: !shownHistory.ui.chips });
          draw();
        }

        break;
      case 'history-section':
        if (shownHistory?.view != null) {
          const section = button!.dataset['section'] ?? '';

          setHistoryUi({ ...shownHistory.ui, sections: { ...shownHistory.ui.sections, [section]: button!.getAttribute('aria-expanded') !== 'true' } });
          draw();
        }

        break;
      case 'history-all':
        if (shownHistory?.view != null) {
          // Expand all opens the groups, the runs and the older states' bodies; Collapse all closes them.
          setHistoryUi(
            button!.dataset['all'] === 'open'
              ? expandable(shownHistory.view, shownHistory.ui, historyHead(), state.state?.id ?? null, deps.now())
              : { ...shownHistory.ui, sections: Object.fromEntries(shownHistory.view.sections.map((section) => [section.key, false])), runs: [], bodies: Object.fromEntries(Object.keys(expandable(shownHistory.view, shownHistory.ui, historyHead(), state.state?.id ?? null, deps.now()).bodies).map((key) => [key, false])) },
          );
          draw();
        }

        break;
      case 'history-open': {
        const target = tabUrl(button!.dataset['url'] ?? '');

        if (target !== null) {
          openDoc(`link:${target}`, { name: button!.dataset['label'] ?? '' });
        }

        break;
      }
      case 'history-file':
        openDoc(`file:${button!.dataset['path'] ?? ''}`);
        break;
      case 'history-folder':
        void runCommand(OPEN_IN_VSCODE);
        break;
      case 'history-session': {
        const workItemId = Number(button!.dataset['workItem']);
        const sessionId = button!.dataset['session'] ?? '';

        // An earlier session shows read-only; the hub shows the current one as the conversation.
        if (Number.isInteger(workItemId) && sessionId !== '') {
          selectSession(workItemId, sessionId);
        }

        break;
      }
      case 'row-report':
        forRow(button!.dataset['row'] ?? '', () => {
          closeMenus();
          openDoc(`file:${button!.dataset['file'] ?? ''}`);
        });
        break;
      case 'row-menu':
      case 'pool-menu': {
        const key = button!.dataset['row'] ?? '';
        const open = view.rowMenu === key;

        // The menu is fixed to the viewport and flips up where the row has no room under it (`fitMenus`), so the list does not scroll for it.
        if (open) { closeMenus(); draw(); } else { openRowMenu(key); }
        break;
      }
      case 'link-menu':
        view.linkMenu = !view.linkMenu;
        draw();
        break;
      case 'copy-menu':
        view.copyMenu = !view.copyMenu;
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
      case 'more':
        // A link in the fade's visible lines opens as a link and leaves the reply folded.
        if (target.closest('a') === null) {
          openReply(button!.dataset['reply']!);
        }

        break;
      case 'artifact':
        // A link to another artifact in a Markdown artifact opens it in place, unless asked for a new tab.
        if (button!.tagName === 'A') {
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) {
            break;
          }

          event.preventDefault();
        }

        if (button!.dataset['path'] !== undefined) {
          openDoc(`artifact:${button!.dataset['path']}`);
        }

        break;
      case 'tab-menu':
        view.tabMenu = !view.tabMenu;
        draw();
        break;
      case 'close-artifact': {
        // Closing an artifact's tab hides it for the work item on every device, until a newer version; the More menu still lists it.
        const path = button!.dataset['path'] ?? openArtifact();

        if (path !== null) {
          closeDoc(`artifact:${path}`);
        }

        break;
      }
      case 'artifact-window':
        artifactWindow();
        break;
      case 'view-menu':
        view.viewMenu = !view.viewMenu;
        // One header menu at a time.
        view.picker = false;
        view.actions = false;
        draw();
        break;
      case 'iframe-open':
        openDoc(`link:${button?.dataset['url'] ?? ''}`);
        break;
      case 'iframe-close':
        closeDoc(`link:${button?.dataset['url'] ?? ''}`);
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
      case 'toggle-spoken-replies':
        // Spoken replies, experimental and off until turned on here (PRD R105); the voice event redraws the menu's check.
        void command('speak-replies', { on: state.voice?.speakReplies !== true });
        break;
      case 'toggle-brief-replies':
        if (!local) {
          view.briefReplies = !(view.briefReplies ?? state.briefReplies);

          try {
            localStorage.setItem(BRIEF, view.briefReplies ? '1' : '0');
            localStorage.removeItem(EXPAND);
          } catch {
            // A page without local storage keeps the choice until it reloads.
          }

          draw();
          break;
        }

        // On this computer's page, voice.briefReplies in settings.json; the checkbox and the replies follow the hub's `settings` event once the file is reloaded.
        briefAsked = !(briefAsked ?? state.briefReplies);

        if (briefSending === null) {
          void sendBrief();
        }

        break;
      case 'card-pick':
        pickCard(button!.dataset['card']!, button!.dataset['slug']!, button!.dataset['letter']!);
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
              ui.error = String(answer.body['error'] ?? 'The question was not skipped.');
              draw();
            }
          });
        }

        break;
      }
      case 'goto-questions': {
        // A row's waiting questions open its work item at its oldest open card (PRD R103), within a few seconds of its conversation coming.
        const workItemId = Number(button!.dataset['workItem']);

        listFocus = `item:${workItemId}`;
        const selection = select(workItemId);
        const wanting = { workItemId, until: Date.now() + CARD_WAIT_MS, pages: 0, reading: false, selected: false };

        cardWanted = wanting;
        void selection.then(() => {
          wanting.selected = true;
          wanting.until = Date.now() + CARD_WAIT_MS;
          showWantedCard();
        });
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
      case 'anchor': {
        // A link to a place in the same Markdown (markdown.ts): the heading or footnote of that name in the same document.
        const place = [...(button!.closest('.body')?.querySelectorAll<HTMLElement>('[data-anchor]') ?? [])].find((one) => one.dataset['anchor'] === button!.dataset['target']);

        // A place inside a closed section is shown first, each section around it opened.
        for (let section = place?.parentElement?.closest('details'); section; section = section.parentElement?.closest('details')) {
          section.open = true;
        }

        place?.scrollIntoView?.({ block: 'start' });
        break;
      }
      case 'resend-message': {
        // Back in the composer to read and send again; never sent from here, since Claude may have it.
        const id = button!.closest<HTMLElement>('li[data-id]')?.dataset['id'];
        const message = state.items.find((item) => item.id === id && item.type === 'message');

        if (message?.type === 'message') {
          giveBack(message.workItemId, message.text, 'Check the terminal first: the session may already have this message.');
        }

        break;
      }
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
  }, { signal: listening.signal });
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
  }, { capture: true, signal: listening.signal });
  root.addEventListener('input', (event) => {
    const field = event.target as HTMLInputElement;

    if (changes.input(event.target)) {
      return;
    }

    if (field.classList?.contains('request-field')) {
      view.requestValues.set(field.dataset['field']!, field.value);
      return;
    }

    if (!field.classList?.contains('qc-comment')) {
      return;
    }

    // Typing a comment keeps the page undrawn, so the field keeps its caret; the hub hears it once the typing pauses, and the buttons follow then.
    const key = field.dataset['card']!;
    const slug = field.dataset['slug']!;
    const card = cardNow(key);

    if (card === null) {
      return;
    }

    const draft = setComment(card, cardDraftOf(key), slug, field.value);
    const ui = cardUi(key);
    const target = cardTarget();

    // Held as this page's until a card-draft carries it, whatever `questions` events come meanwhile.
    ui.local = draft;
    ui.unsent = true;

    // The page stays undrawn, so Next and Send follow the comment here: a comment alone answers the question.
    const cardEl = field.closest<HTMLElement>('.question-card.qc');
    const next = cardEl?.querySelector<HTMLButtonElement>('[data-action="card-next"]');
    const send = cardEl?.querySelector<HTMLButtonElement>('[data-action="card-send"]');
    const locked = ui.sending || !(state.connected && state.session?.conversation === 'full');

    if (next != null) {
      next.disabled = locked || !picked(draft.picks[slug]);
    }

    if (send != null && !ui.sending) {
      const count = draftAnswers(card, draft).length;

      send.disabled = locked || count === 0;
      send.textContent = sendLabel(count, cardSteps(card).length);
    }

    if (target === null) {
      return;
    }

    // Each card waits for its own pause and sends its newest text to the conversation it was typed in.
    const id = `${target.sessionId} ${key}`;

    clearTimeout(commentTimers.get(id)?.timer);
    commentTimers.set(id, { target, key, timer: setTimeout(() => setDraft(key, cardUi(key).local ?? draft, true, target), COMMENT_SETTLE_MS) });
  }, { signal: listening.signal });
  // The dropdown closes on a press outside the header and on Escape, which gives the focus back to its button.
  document.addEventListener('pointerdown', (event) => {
    if (changes.pointerDown(event.target)) {
      draw();
    }

    // A row's menu closes on a press outside it and its row; the row's own click closes or toggles it.
    if (view.rowMenu !== null && !(event.target instanceof Element && event.target.closest('.list-row')?.querySelector<HTMLElement>('.row')?.dataset['row'] === view.rowMenu)) {
      view.rowMenu = null;
      view.linkMenu = false;
      view.copyMenu = false;
      draw();
    }

    if (view.tabMenu && !(event.target instanceof Element && event.target.closest('.tab-more') !== null)) {
      view.tabMenu = false;
      draw();
    }

    // A question card's menu closes on a press outside it and its button; the button's own click toggles it.
    if (closeCardMenus(event.target instanceof Element ? event.target.closest('.qc-menu-anchor') : null)) {
      draw();
    }

    if ((view.picker || view.actions || view.viewMenu) && !(event.target instanceof Node && head.querySelector('.header')?.contains(event.target) === true)) {
      view.picker = false;
      view.actions = false;
      view.viewMenu = false;
      draw();
    }
  }, { signal: listening.signal });
  // A press in a website's frame, an artifact's frame or another window sends the page no pointerdown, only its window's blur, so the page's
  // menus close when its window loses the focus, as a desktop app's menus do. Sheets and dialogs stay.
  window.addEventListener('blur', () => {
    const open = view.picker || view.actions || view.viewMenu || view.rowMenu !== null || view.tabMenu;
    const closed = [changes.pointerDown(null), closeCardMenus(null)].includes(true);

    // Drop a list still on its way, and close one already drawn.
    box.cancel();
    if (menuOpen !== null) {
      closeMenu();
    }

    if (contextMenu !== 'closed') {
      setContextMenu('closed');
    }

    if (open) {
      view.picker = false;
      view.viewMenu = false;
      view.tabMenu = false;
      closeMenus();
    }

    if (open || closed) {
      draw();
    }
  }, { signal: listening.signal });
  root.addEventListener('keydown', (event) => {
    // A question card's keys while it has the focus (design § 6): 1–8 pick by place, Down and Up move between options, Enter goes on or sends
    // (Shift+Enter adds a line to the comment), Backspace goes back.
    // Not in the card's menu or on its button, whose keys are the menu's.
    const cardEl = event.target instanceof HTMLElement && event.target.closest('.qc-menu-anchor') === null ? event.target.closest<HTMLElement>('.question-card.qc') : null;

    if (cardEl !== null && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
      const key = cardEl.dataset['card']!;
      const card = cardNow(key);
      const inField = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
      const action = card === null || !(state.connected && state.session?.conversation === 'full') ? null : cardKeyAction(event.key, inField && event.key !== 'Enter');
      const step = card === null ? null : currentStep(card, cardDraftOf(key));

      if (action !== null && step !== null && !(inField && event.key === 'Enter' && event.shiftKey)) {
        // A button's own Enter clicks it.
        if (action.type === 'forward' && event.target instanceof HTMLButtonElement && !event.target.matches('.qc-comment')) {
          return;
        }

        event.preventDefault();

        if (action.type === 'move') {
          const options = [...cardEl.querySelectorAll<HTMLButtonElement>('.qc-option')];
          const at = options.indexOf(event.target as HTMLButtonElement);

          options[at === -1 ? (action.by === 1 ? 0 : options.length - 1) : Math.min(options.length - 1, Math.max(0, at + action.by))]?.focus();
        } else if (action.type === 'pick') {
          const option = step.question.options[action.index];

          if (option !== undefined) {
            pickCard(key, step.question.slug, option.letter);
          }
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

    // Enter on a focused link to a place in the same Markdown goes there, as a click does.
    if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.matches('a.anchor-link[data-action="anchor"]')) {
      event.preventDefault();
      event.target.click();
      return;
    }

    // Left and Right, Home and End move between a tab strip's tabs, as in a tab list; Enter or Space then chooses one.
    const tab = event.target instanceof HTMLElement && event.target.getAttribute('role') === 'tab' ? event.target : null;
    const tabs = tab === null ? [] : [...(tab.closest('.tabs')?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];

    if (tab !== null && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && tabs.length > 1) {
      const at = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;

      tabs[next]!.focus();
      event.preventDefault();
      return;
    }

    // Ctrl+Enter goes ahead in an input sheet, whose box takes several lines.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && view.sheet?.kind === 'input') {
      event.preventDefault();
      void sheetGo();
      return;
    }

    // An Escape a part already used, as the composer closing its list, closes nothing more.
    if (event.key === 'Escape' && event.defaultPrevented) {
      return;
    }

    let changesClosed: 'files' | 'more' | null = null;
    let cardMenu: HTMLElement | null = null;
    // A question card's open menu that holds the focus, or whose button does, for Up and Down.
    const cardAnchor = document.activeElement instanceof HTMLElement && document.activeElement.closest('.qc-menu-anchor')?.querySelector('.qc-menu') != null ? document.activeElement.closest<HTMLElement>('.qc-menu-anchor') : null;

    if (event.key === 'Escape' && view.personas !== null) {
      closePersonas();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && view.sheet !== null) {
      view.sheet = null;
      draw();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && view.tabMenu) {
      view.tabMenu = false;
      draw();
      root.querySelector<HTMLElement>('.tab-more-button')?.focus();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && view.rowMenu !== null) {
      const opener = view.rowMenu;

      view.rowMenu = null;
      view.linkMenu = false;
      view.copyMenu = false;
      draw();
      listRowElement(opener)?.focus();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && (view.picker || view.actions || view.viewMenu)) {
      const opener = view.picker ? 'button.picker' : view.actions ? 'button.actions' : 'button.view-options';

      view.picker = false;
      view.actions = false;
      view.viewMenu = false;
      draw();
      head.querySelector<HTMLElement>(opener)?.focus();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && (cardMenu = root.querySelector<HTMLElement>('.qc-menu-button[aria-expanded="true"]')) !== null) {
      const card = cardMenu.dataset['card']!;

      closeCardMenus(null);
      draw();
      [...root.querySelectorAll<HTMLElement>('.qc-menu-button')].find((button) => button.dataset['card'] === card)?.focus();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && (changesClosed = changes.escape()) !== null) {
      draw();
      root.querySelector<HTMLElement>(changesClosed === 'more' ? '.changes-more' : '.changes-files')?.focus();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && view.drawer !== null) {
      closeDrawer();
      event.stopImmediatePropagation();
    } else if (event.key === 'Escape' && panelMaximized) {
      // A console typing into its session stops its keys first (console.ts), so its Escape stays the session's.
      maximizePanel(false);
      event.stopImmediatePropagation();
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (view.picker || view.actions || view.viewMenu || view.rowMenu !== null || view.tabMenu || cardAnchor !== null)) {
      // Up and Down move between the open menu's enabled rows.
      const rows = [...(cardAnchor !== null ? cardAnchor.querySelectorAll<HTMLElement>('.qc-menu [role="menuitem"]:not(:disabled)') : view.rowMenu !== null ? list.querySelectorAll<HTMLElement>('.row-menu .menu-row:not(:disabled)') : view.tabMenu ? root.querySelectorAll<HTMLElement>('.tab-menu .menu-row') : head.querySelectorAll<HTMLElement>('.header .menu .menu-row:not(:disabled)'))];
      const at = rows.indexOf(document.activeElement as HTMLElement);

      if (rows.length > 0) {
        rows[at === -1 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]!.focus();
        event.preventDefault();
      }
    }
  }, { signal: listening.signal });
  /** Opens a folded reply for good; the reply takes the focus its fade had, rather than leaving it to the page. */
  const openReply = (id: string): void => {
    view.open.add(`more:${id}`);
    draw();
    [...root.querySelectorAll<HTMLElement>('li.reply')].find((reply) => reply.dataset['id'] === id)?.focus();
  };
  root.addEventListener('keydown', (event) => {
    // A folded reply's fade is a button: Enter or Space opens the reply.
    const fade = event.target instanceof HTMLElement && event.target.matches('.reply-fade') ? event.target : null;

    if (fade !== null && (event.key === 'Enter' || event.key === ' ') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
      event.preventDefault();
      openReply(fade.dataset['reply']!);
    }
  }, { signal: listening.signal });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && (event.target as HTMLElement) !== input && state.voice?.here === true && state.voice.speaking !== null) {
      void command('stop-speaking');
    }
  }, { signal: listening.signal });

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
  /**
   * The dropdown's New conversation…: an empty draft in the shown work item, its composer focused, in the provider of the conversation shown; nothing
   * starts until its first message is sent (`sendDraft`). The work item's own draft is kept for when the page goes back to its session.
   */
  const newConversation = async (): Promise<void> => {
    const workItemId = state.scope?.workItemId ?? null;

    view.picker = false;

    if (workItemId === null) {
      draw();
      return;
    }

    keepDraft();

    // The session shown, current or earlier, names the provider; a Claude session's view names none.
    const shown = state.session !== null ? (state.session.provider ?? 'claude') : selectedEntry(state)?.provider;
    const draft: NewDraft = { workItemId, provider: shown === 'codex' ? 'codex' : 'claude', installed: null, opId: newOp(), sending: false };

    view.newDraft = draft;
    view.tab = 'conversation';
    input.value = '';
    keepNewDraft(workItemId, draft);
    box.reset();
    closeMenu();
    showError(null);
    draw();
    input.focus();
    await askProviders(draft);
  };
  /** Asks which providers are installed for New conversation…'s draft, keeping its provider when installed, else the hub's default. */
  const askProviders = async (draft: NewDraft): Promise<void> => {
    const answer = await post('providers', {});

    if (view.newDraft !== draft) {
      return;
    }

    const installed: string[] = answer.status === 200 ? ((answer.body['installed'] as string[] | undefined) ?? []).filter((one) => one === 'claude' || one === 'codex') : [];
    const preferred = String(answer.body['defaultProvider'] ?? '');

    draft.installed = installed;

    if (installed.length === 0) {
      showError(answer.status === 200 ? 'Neither Claude nor Codex is installed.' : String(answer.body['error'] ?? 'Switchboard did not answer.'));
    } else if (!installed.includes(draft.provider)) {
      draft.provider = installed.includes(preferred) ? preferred : installed[0]!;
      keepNewDraft(draft.workItemId, draft);
    }

    draw();
  };
  /**
   * Sends the draft's first message: the hub starts a new session of the work item with it as its prompt and shows that session, its earlier ones
   * staying in the dropdown. The draft keeps its opId across retries, so the hub starts one session however often it arrives; refused, the text
   * stays in the draft with why.
   */
  const sendDraft = async (): Promise<void> => {
    const draft = view.newDraft;
    const text = input.value;

    if (draft === null || draft.sending || !draftShown() || text.trim() === '' || !state.connected) {
      return;
    }

    // The operator's choices of a work item or session so far; one made while it is sent stands.
    const chosenBefore = selections;

    draft.sending = true;
    input.readOnly = true;
    composerHost.classList.add('sending');
    draw();

    // A retry after the page moved to another work item goes with no scope generation the hub takes, so it never starts there; one after a
    // reconnect to the same work item takes its new generation.
    const answer = await post('page-conversation', () => ({ scopeGen: state.scope?.workItemId === draft.workItemId ? state.scope.scopeGen : -1, provider: draft.provider, text }), false, { timeout: SEND_TRY_MS, retryFor: SEND_RETRY_MS, opId: draft.opId });

    draft.sending = false;
    input.readOnly = false;
    composerHost.classList.remove('sending');

    if (answer.status === 200) {
      keepNewDraft(draft.workItemId, null);

      if (view.newDraft === draft) {
        view.newDraft = null;
        input.value = draftOf === null ? '' : (drafts()[draftOf] ?? '');
        box.reset();
        showError(null);
      }

      // The hub shows the new session, the work item's current one, so the page asks for no earlier one again, unless the operator chose
      // another session or work item while it was sent.
      if (wanted === draft.workItemId && selections === chosenBefore) {
        wantedSession = null;
        ackedSession = null;
      }
    } else if (view.newDraft === draft) {
      showError(String(answer.body['error'] ?? 'The session was not started.'));
    }

    grow();
    refresh();
    draw();
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
    showError(answer.status === 200 ? null : String(answer.body['error'] ?? `The key was not sent to the session (status ${answer.status}).`));
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
  /** Places a dragged Ready for review row after `after`, or first (PRD R73); the hub's list then shows the new order, or the list why not. */
  const moveRow = async (workItemId: number, after: number | null): Promise<void> => {
    const answer = await post('row-move', { workItemId, after });

    if (answer.status !== 200) {
      showError(String(answer.body['error'] ?? `The work item was not moved (status ${answer.status}).`));
    }
  };
  // Alt+Up and Alt+Down move the selected Ready for review row (PRD R73), with its Move up and Move down; not while typing.
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
  /** Closes each question card's open menu but the one whose anchor is `keep`; true when one closed. */
  const closeCardMenus = (keep: Element | null): boolean => {
    let closed = false;

    for (const button of root.querySelectorAll<HTMLElement>('.qc-menu-button[aria-expanded="true"]')) {
      if (keep === null || !keep.contains(button)) {
        cardUi(button.dataset['card']!).menuOpen = false;
        closed = true;
      }
    }

    return closed;
  };
  /** Closes the header's actions menu and the list's row menu. */
  const closeMenus = (): void => {
    view.actions = false;
    view.rowMenu = null;
    view.linkMenu = false;
    view.copyMenu = false;
  };
  /**
   * Opens a web link in its work item's embedded tab when enabled. Modified clicks use the default browser locally or an outside tab remotely.
   * Without embedding, ordinary clicks use the extension's tab group, then the installed app's default browser or a new tab.
   */
  const openLink = (key: string, which: string, external = false): void => {
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

    if (external) {
      if (localPage()) {
        void post('row-open', { ...rowTarget(row), url }).then((answer) => answer.status === 200 || showError(String(answer.body['error'] ?? `The link did not open (status ${answer.status}).`)));
      } else openNewTab(target);
      return;
    }
    if (state.iframeBrowser === true && iframe.available && row.workItemId !== null && frameUrl(target)) { forRow(key, () => openBrowserLink(target)); return; }
    openTab(target, () => {
      if (standalone() && localPage()) {
        void post('row-open', { ...rowTarget(row), url }).then((answer) => answer.status === 200 || showError(String(answer.body['error'] ?? `The link did not open (status ${answer.status}).`)));
        return;
      }

      openNewTab(target);
    });
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
      draw();
      // A control that asks first starts on Cancel, so Enter cancels it.
      sheetHost.querySelector<HTMLElement>('.sheet [data-action="sheet-cancel"]')?.focus();
      return;
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
    showError(answer.status === 200 ? null : String(answer.body['error'] ?? `${label.replace(/…$/, '')} did not work (status ${answer.status}).`));
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

    const answer = row === null ? { status: 409, body: { error: 'This work item is no longer in the list.' } } : row.workItemId !== null ? await command('row-action', { workItemId: row.workItemId, label, ...extra }) : await post('pool-action', { ticketId: row.ticketId, label, ...extra });

    view.acting = false;
    view.sheet = null;
    showError(answer.status === 200 ? null : String(answer.body['error'] ?? `${label.replace(/…$/, '')} did not work (status ${answer.status}).`));
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
    view.copyMenu = false;
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
      showError(null);
      view.sheet = { kind: 'text', title: `Copy ${label}`, text };
      draw();
    } else {
      toastBox.show(`Copied ${label}.`, 'info');
    }
  };

  // The Snooze sheet keeps what the operator chose in the view, so a redraw while it is open changes nothing of it.
  const keepSheet = (event: Event): void => {
    const field = event.target as HTMLInputElement | HTMLTextAreaElement;
    const sheet = view.sheet;

    // An input sheet keeps its text and choice, and enables its button, without a redraw under the caret.
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
      // Picking a date chooses On.
      sheet.picked = field.value === '' ? sheet.picked : 'date';
      draw();
    } else if (field.classList.contains('snooze-comment')) {
      sheet.comment = field.value;
    }
  };

  sheetHost.addEventListener('input', keepSheet);
  sheetHost.addEventListener('change', keepSheet);

  /** Reads the page of items before the oldest the page holds; whether it added any. */
  const earlier = async (): Promise<boolean> => {
    const oldest = state.items[0];

    if (state.session === null) {
      return false;
    }

    const shown = `${state.key} ${state.scope?.scopeGen} ${state.session.id}`;
    const answer = await command('history', { sessionId: state.session.id, before: oldest?.id ?? null });

    // A page that moved on meanwhile never takes another conversation's history.
    if (answer.status === 200 && shown === `${state.key} ${state.scope?.scopeGen} ${state.session?.id}`) {
      const before = state.items.length;

      state = withEarlier(state, answer.body['items'] as ItemView[], answer.body['more'] === true);
      draw();
      return state.items.length > before;
    }

    return false;
  };

  /** The view options menu's persona row: the roster in the persona dialog, from which a pick pins a persona to the session. */
  const choosePersona = async (): Promise<void> => {
    view.viewMenu = false;
    view.picker = false;
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

  // ---- Embedded link tabs ----
  const toExtension =
    deps.toExtension ??
    ((extensionId: string, message: Record<string, unknown>): Promise<unknown> => {
      const runtime = (globalThis as { chrome?: { runtime?: { sendMessage?(id: string, message: unknown, callback: (answer: unknown) => void): void; lastError?: unknown } } }).chrome?.runtime;

      if (runtime?.sendMessage === undefined) {
        return Promise.resolve(null);
      }

      return new Promise((resolve) => runtime.sendMessage!(extensionId, message, (answer) => resolve(runtime.lastError === undefined ? (answer ?? null) : null)));
    });
  let hostSelection: { item: number; url: string | null } | null = null;
  const applyHostSelection = (): void => {
    const request = hostSelection;
    if (request === null || !iframe.ready || state.scope?.workItemId !== request.item || wanted !== request.item) return;
    hostSelection = null;
    iframe.follow(selectedRow(state));
    if (request.url !== null) openBrowserLink(request.url);
    else { chooseTab('browser'); draw(); }
  };
  const iframe = new IframeBrowser({
    send: (message) => toExtension(IFRAME_EXTENSION_ID, message),
    changed: (becameReady) => { embedReady = iframe.ready; if (becameReady && !tabChosen) openTabs(); applyHostSelection(); draw(); },
    external: (url) => { if (frameUrl(url)) (deps.openUrl ?? ((one: string) => void window.open(one, '_blank', 'noopener,noreferrer')))(url); },
    extension: () => header.openExtension(),
  });
  const iframeRenew = setInterval(() => void iframe.renew(), IFRAME_RENEW_MS);
  const resumeIframe = (): void => {
    if (state.iframeBrowser === true && state.connected && document.visibilityState !== 'hidden') { void iframe.renew(); reportFrames(); }
  };
  window.addEventListener('focus', resumeIframe, { signal: listening.signal });
  document.addEventListener('visibilitychange', resumeIframe, { signal: listening.signal });
  window.addEventListener('message', (event) => {
    if (window.parent === window || event.source !== window.parent || event.origin !== `chrome-extension://${IFRAME_EXTENSION_ID}`) return;
    if (event.data?.type === 'switchboard-iframe-resume') resumeIframe();
    if (event.data?.type === 'switchboard-iframe-holes' && iframe.holesAnswered()) reportFrames();
    if (event.data?.type === 'switchboard-iframe-focus' && typeof event.data.focused === 'boolean') { hostFocused = event.data.focused; reportFocus(true); }
    if (event.data?.type === 'switchboard-iframe-select') {
      const { workItemId, url } = event.data;
      if (!Number.isSafeInteger(workItemId) || workItemId <= 0 || !(url === null || typeof url === 'string' && frameUrl(url))) return;
      hostSelection = { item: workItemId, url };
      if (state.scope?.workItemId !== workItemId || wanted !== workItemId) void select(workItemId);
      applyHostSelection();
    }
  }, { signal: listening.signal });
  window.addEventListener('pagehide', () => iframe.configure(false), { signal: listening.signal });
  window.addEventListener('pageshow', () => { if (iframeAtLoad === (state.iframeBrowser === true)) iframe.configure(state.iframeBrowser === true); }, { signal: listening.signal });
  const iframePlace = setInterval(() => reportFrames(), 5_000);
  // The sibling frame draws over the page. A host that cuts holes (iframeBrowser.holes) cuts each menu, popover, dialog, toast, Update ready or the drawer
  // that overlaps the frame out of it, so the layer shows and takes the pointer, and darkens the frame under a modal backdrop, which then takes
  // the pointer. An older host does not, so the frame hides under a modal dialog or the list's drawer, and under a menu, popover, toast or Update ready only
  // where that layer's box overlaps the frame's, as the More menu does when it drops from its strip over the Browser tab. A menu that opens
  // beside the frame, such as the session dropdown, leaves it showing.
  const frameLayers = (): FrameCover | undefined => {
    const slot = iframe.slotRect();
    if (slot === null) return undefined;
    const layers: Element[] = [...root.querySelectorAll('.glass:not([hidden]), [role="menu"], [role="dialog"], [role="alertdialog"], #toast .toast, #connection .conn-update')];
    if (view.drawer !== null) layers.push(drawer);
    return frameCover(slot, layers, root.querySelectorAll('.drawer-backdrop, .sheet-backdrop, .settings-backdrop, .persona-backdrop'), root.querySelector('[aria-modal="true"], [role="alertdialog"]') !== null);
  };
  const overlaps = (a: DOMRect, b: DOMRect): boolean => a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const floating = (): boolean => {
    if (view.drawer !== null || root.querySelector('[aria-modal="true"], [role="alertdialog"]') !== null) return true;
    const slot = iframe.slotRect();
    return slot !== null && [...root.querySelectorAll<HTMLElement>('.glass:not([hidden]), [role="menu"], [role="dialog"], #toast .toast, #connection .conn-update')].some((layer) => overlaps(layer.getBoundingClientRect(), slot));
  };
  let floatingShown = false;
  let framesHold: ReturnType<typeof setTimeout> | null = null;
  /** Whether website frames stay hidden for a floating layer: at once while one is open, and until FRAME_SHOW_DELAY_MS after the last closes, so a quick close and open again does not flicker it. */
  const framesCovered = (): boolean => {
    if (floating()) {
      floatingShown = true;

      if (framesHold !== null) {
        clearTimeout(framesHold);
        framesHold = null;
      }

      return true;
    }

    if (floatingShown) {
      floatingShown = false;
      framesHold = setTimeout(() => {
        framesHold = null;
        reportFrames();
      }, FRAME_SHOW_DELAY_MS);
    }

    return framesHold !== null;
  };
  const reportFrames = (): void => {
    if (listening.signal.aborted) return;
    if (frame !== null) draw();
    const holes = iframe.holes;

    // With no Browser tab no frame shows, so the layers over one are not looked for: reportFrames runs at every draw.
    if (!browserTab()) {
      floatingShown = false;
      clearTimeout(framesHold ?? undefined);
      framesHold = null;
    }

    const covered = !holes && browserTab() && framesCovered();
    iframe.place(browserTab() && state.connected && openingShown() === null && showBrowser() && (wide() ? sideTab() : mainTab()) === 'browser' && !covered && (holes || !settingsPane.isOpen()) && !(isPhone() && root.classList.contains('listing')), holes && browserTab() ? frameLayers() : undefined);
  };
  const browserResize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => reportFrames()) : null;

  browserResize?.observe(detailBody);
  browserResize?.observe(panel);
  // A toast replaced in place changes only its text, which the layers' observer below does not see, so its size is watched for the overlap.
  browserResize?.observe(toastHost);
  // A layer can open or close without a redraw, as the composer's list does, so the page's changes are watched too, once a turn at most.
  let layersQueued = false;
  const layers = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (!layersQueued) {
      layersQueued = true;
      queueMicrotask(() => {
        layersQueued = false;
        reportFrames();
      });
    }
  }) : null;

  layers?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  // A layer that slides or fades in, as the drawer does, moves without a change the observers see, so the holes follow it each frame while it
  // moves, for at most LAYER_MOVE_MS, and once more when it stops. Moves are counted before the host answers that it cuts holes, so a move
  // under way when it answers is followed too.
  let layersMoving = 0;
  let layersMovingUntil = 0;
  let layerFrame: number | null = null;
  const layerEvent = (event: Event): boolean => event.target instanceof Element && event.target.closest('.side, .glass, [role="menu"], [role="dialog"], .toast') !== null;
  const followLayers = (): void => {
    layerFrame = null;
    reportFrames();
    if (layersMoving > 0 && performance.now() < layersMovingUntil && !listening.signal.aborted) layerFrame = requestAnimationFrame(followLayers);
  };
  const layerStarted = (event: Event): void => {
    if (!layerEvent(event)) return;
    layersMoving++;
    layersMovingUntil = performance.now() + LAYER_MOVE_MS;
    layerFrame ??= requestAnimationFrame(followLayers);
  };
  const layerStopped = (event: Event): void => {
    if (!layerEvent(event)) return;
    layersMoving = Math.max(0, layersMoving - 1);
    if (layersMoving === 0 && layerFrame !== null) {
      cancelAnimationFrame(layerFrame);
      layerFrame = null;
    }
    reportFrames();
  };
  root.addEventListener('transitionrun', layerStarted, { signal: listening.signal });
  root.addEventListener('animationstart', layerStarted, { signal: listening.signal });
  for (const name of ['transitionend', 'transitioncancel', 'animationend', 'animationcancel']) root.addEventListener(name, layerStopped, { signal: listening.signal });
  listening.signal.addEventListener('abort', () => { if (layerFrame !== null) cancelAnimationFrame(layerFrame); });
  listening.signal.addEventListener('abort', () => {
    layers?.disconnect();

    if (framesHold !== null) {
      clearTimeout(framesHold);
    }
  });
  // A strip that widens or narrows fits another set of tabs.
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
  reportBrowser = () => reportFrames();
  // Frame visibility is reported again when the page comes back to the front or into view, and hidden when the page goes away, as on a reload.
  window.addEventListener('focus', () => reportFrames(), { signal: listening.signal });
  document.addEventListener('visibilitychange', () => reportFrames(), { signal: listening.signal });
  // A page back from the back/forward cache, which sent null as it went, shows the pane again if Browser is its tab.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      reportFrames();
    }
  }, { signal: listening.signal });
  // Settings and the list header's sheets open and close without the page's draw.
  const settingsShown = typeof MutationObserver === 'function' ? new MutationObserver(() => reportFrames()) : null;

  settingsShown?.observe(settingsHost, { childList: true, subtree: false, attributes: true });
  settingsShown?.observe(root.querySelector('#list-sheet')!, { childList: true, subtree: true });
  window.addEventListener('resize', () => reportFrames(), { signal: listening.signal });
  window.addEventListener('resize', fitMenus, { signal: listening.signal });
  // A scroll moves a menu's anchor; a menu's own scrolling does not.
  document.addEventListener('scroll', (event) => (event.target instanceof Element && event.target.closest('.menu') !== null ? undefined : fitMenus()), { capture: true, signal: listening.signal });
  // A move to a monitor of another scale changes devicePixelRatio without a resize of the column in CSS pixels.
  const watchScale = (): void => {
    if (typeof window.matchMedia === 'function') {
      window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener?.(
        'change',
        () => {
          reportFrames();
          watchScale();
        },
        { once: true },
      );
    }
  };

  watchScale();

  /** Asks the extension whether it opens the page's links, at the start and whenever the page shows again, as the extension can be added or removed. */
  const askLinks = (): void =>
    void toExtension(BROWSER_EXTENSION_ID, { type: 'links' }).then((answer) => {
      extensionLinks = (answer as { links?: unknown } | null)?.links === true;
    });

  askLinks();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && askLinks(), { signal: listening.signal });
  // ---- The stream ----
  // The installed app says so, since `alerts.surface: auto` raises needs-you alerts only there (architecture.md § Web page).
  // The hub routes needs-you alerts to a page only once it may show notifications, so the page says when that changes.
  askForNotifications(document, () => reportFocus(true));
  const installedApp = deps.standalone?.() ?? (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
  /** A new stream since the work item was last shown on one, whose Changes tab reads again once it shows it. */
  let rebound = false;
  // Every event of the page's stream, which the connection opens and opens again (connection.ts).
  const onEvent = (type: string, raw: string): void => {
      const data = JSON.parse(raw) as { type: string } & Record<string, unknown>;
      const keyBefore = state.key;
      // A new stream's hello, before the page has selected its work item again on it, keeps what the page shows, so a reconnect within the grace
      // period changes nothing the operator sees.
      const keep = type === 'hello' && typeof data['key'] === 'string' && data['key'] !== keyBefore && data['scope'] == null && wanted !== null && state.scope?.workItemId === wanted;
      const before = state;

      state = applyEvent(state, data);
      // A state whose body changed is unread again under the same ID, so it is reported seen again once it shows.
      if (type === 'state' && state.state?.unread === true) reported.delete(state.state.id);
      // A pending choice ends with a scope that comes while no select is outstanding, its own or one the hub showed itself; a late scope of an
      // earlier choice, a reconnect's hello with none, or any other event leaves it.
      if (hostPending !== null && state.scope != null && state.scope !== before.scope && !selectInFlight && acked === wanted && ackedSession === wantedSession) hostPending = null;
      if (type === 'hello' && iframeAtLoad === null) iframeAtLoad = state.iframeBrowser === true;
      if (type === 'hello' || type === 'settings') {
        if (iframeAtLoad !== (state.iframeBrowser === true)) iframe.requireReload();
        else iframe.configure(state.iframeBrowser === true);
        if (iframeAtLoad === true && state.iframeBrowser !== true && window.parent !== window) window.parent.postMessage({ type: 'switchboard-iframe-disabled' }, `chrome-extension://${IFRAME_EXTENSION_ID}`);
      }
      if (state.key !== keyBefore) pendingRowControl = null;
      const pending = pendingRowControl;
      if (pending !== null && state.scope?.workItemId === wanted && pending.key === `item:${wanted}`) {
        pendingRowControl = null;
        queueMicrotask(() => {
          if (state.scope?.workItemId === wanted && pending.key === `item:${wanted}`) pending.run();
        });
      }

      if (keep) {
        state = { ...state, scope: before.scope, session: before.session, items: before.items, more: before.more, state: before.state, artifacts: before.artifacts, unread: before.unread, questions: before.questions };
      }

      // The Changes tab kept through a reconnect reads its list again once the new stream shows the work item, as a new stream reads anew.
      if (type === 'hello' && rebound && wanted !== null && state.scope?.workItemId === wanted && !keep) {
        rebound = false;

        if (changes.view.tab) {
          void changes.refresh();
        }

        // So does the file tab shown, which tries again after a failed read, and the Changes tab's file view on disk.
        localFiles.refresh();
        changes.refreshFile();
      }

      // The work item being opened has come: its conversation replaces the placeholder.
      if (type === 'hello' && opening !== null && opening.error === null && state.scope?.workItemId === opening.workItemId) {
        opening = null;
      }

      if (type === 'hello') {
        // The artifacts a work item has when this device first sees it count as shown, and so do those an earlier page kept without a version,
        // at the versions they have now; only later ones and later versions are new.
        const kept = readArtifactsSeen() ?? artifactsSeen;
        const unknown = state.scope?.workItemId == null ? [] : unknownSeen(state.artifacts, state.scope.workItemId, kept);

        if (state.scope?.workItemId != null && (unknown.length > 0 || kept[String(state.scope.workItemId)] === undefined)) {
          artifactsOpened(unknown);
        }

        // A new stream has a new key, unbound: the page selects its work item again.
        if (state.key !== keyBefore) {
          focusSent = null;
          reportFocus(true);
        }

        if (state.key !== keyBefore) {
          rebound = true;
          acked = null;
          selectInFlight = false;
          // After a hub restart the voice comes back to this phone over the new stream's key (architecture.md § Hub lifecycle).
          phoneVoice?.keyChanged();
        }

        reconcile();
      }

      // Dictation (architecture.md § Dictation): live words show dimmed after the box's text; the hub's draft fills the box unless the operator typed over it.
      // An open History reads again soon after the list changed, as the History tab does after a stream state.
      // A new pinned state moves the one before it into the timeline, which the next read brings.
      if ((type === 'list' || (type === 'state' && state.state?.id !== before.state?.id)) && historyLive && historyChange === null) {
        historyChange = setTimeout(() => {
          historyChange = null;
          void readHistory();
        }, HISTORY_CHANGE_MS);
      }

      // Another device ticked a changed file viewed, or cleared its tick (architecture.md § Web page).
      if (type === 'viewed') {
        changes.viewedEvent(data);
      }

      // settings.json changed on disk: Settings reads it again, keeping unsaved edits under the changed-on-disk warning (PRD R54).
      // With no save in flight, the hub's settings hold what Collapse details asked for, or a newer change.
      if ((type === 'settings' || type === 'hello') && briefSending === null) {
        briefAsked = null;
      }

      if (type === 'config') {
        void settingsPane.reload();
      }

      if (type === 'hello' || type === 'scope') {
        // A new key or work item: the hub reads the column, and the work item's tabs, again.
        setTimeout(reportFrames, 0);
      }

      // The hub chose this page to raise needs-you alerts (alerts.surface, PRD R65): the last message in the toast, a
      // notification per work item, and the chime when nothing else sounds.
      if (type === 'needs' && Array.isArray(data['items'])) {
        const last = (data['items'] as NeedsItem[]).at(-1);

        if (last !== undefined) {
          toastBox.show(last.message, 'info', last.workItemId);
        }

        notifyNeeds(data['items'] as NeedsItem[], (workItemId) => void select(workItemId));

        if (data['sound'] === true) {
          playChime();
        }
      }

      // The hub's drafts hold what this page changed once they carry the draft it sent last.
      if (type === 'questions' || (type === 'hello' && data['questions'] != null)) {
        takeDrafts(data['questions']);
      }

      if (type === 'words') {
        liveWords.textContent = String(data['text'] ?? '');
        liveWords.hidden = liveWords.textContent === '';
        showLive();
      } else if (type === 'draft' && typeof data['sessionId'] === 'string') {
        takeHubDraft(data['sessionId'], String(data['text'] ?? ''), typeof data['added'] === 'string' ? data['added'] : null, typeof data['piece'] === 'number' ? data['piece'] : null);
      }

      // A message this page sent that was not sent: a card's answer goes back to its card, any other text to its own work item's draft.
      if (type === 'message' && (data['message'] as { delivery?: string }).delivery === 'not-sent') {
        const message = data['message'] as Extract<ItemView, { type: 'message' }>;
        const error = message.error ?? 'Your message was not sent. Try again.';
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
          }

      // The hub's tabs for the work item: in each `hello`, which is the hub's whole state, and in `tabs`, from another device or this one's echo.
      if (type === 'hello' && state.scope?.workItemId != null && !keep) {
        const tabs = data['tabs'] as { tab: string | null; closed: Array<{ path: string; updatedAt: number }> } | null | undefined;

        unechoed.clear();
        savedTabs = tabs == null ? null : { workItemId: state.scope.workItemId, tab: tabs.tab, closed: tabs.closed };
        // `status`, kept before History took the Status tab's place, is History.
        openOn = data['openOn'] === 'history' || data['openOn'] === 'status' ? 'history' : data['openOn'] === 'browser' ? 'browser' : null;
      } else if (type === 'tabs' && data['workItemId'] === state.scope?.workItemId) {
        const tabs = data['tabs'] as { tab: string | null; closed: Array<{ path: string; updatedAt: number }> };

        savedTabs = { workItemId: data['workItemId'] as number, tab: tabs.tab, closed: withUnechoed(tabs.closed, data['opId']) };
      }

      // The artifact shown here closed on another device, as a `tabs` event or a new `hello` tells: History shows in its place, or the conversation
      // where the column folds into the conversation's strip. A `tabs` event only reconciles, so it moves nothing else and keeps no choice.
      if ((type === 'tabs' || type === 'hello') && view.artifact !== null && closedNow().has(view.artifact)) {
        view.artifact = null;
        view.side = view.side === 'artifacts' ? 'history' : view.side;
        view.tab = view.tab === 'artifacts' ? 'conversation' : view.tab;
      }

      // A work item opened anew, or the pane's state known before the operator chose a tab on it: its opening tabs (`openTabs`).
      const opened = state.scope?.workItemId ?? null;

      // The hub sends `scope` before the `hello` that carries the work item's tabs and artifacts, so a work item opens on its `hello`.
      if (type === 'hello' && opened !== openedItem) {
        // The work item left takes its kept places when it is opened again.
        if (openedItem !== null && openedItem !== opened) {
          for (const key of placedConversations) {
            if (key.startsWith(`${openedItem} `)) {
              placedConversations.delete(key);
            }
          }
        }

        openedItem = opened;
        tabChosen = false;
        openTabs();

        if (type === 'hello') {
          tabSets = readTabSets() ?? tabSets;
        }

        const kept = type === 'hello' && opened !== null ? tabSets[tabSetKey(opened)] : undefined;

        if (kept !== undefined) {
          restoringTabs = true;

          try {
            restoreTabs(kept);
          } finally {
            restoringTabs = false;
          }
        }
      }

      // The route's tab, once its work item has come with its kept tabs (`applyRoute`); another work item that came first drops it.
      if (type === 'hello' && routing !== null && opened !== null) {
        if (opened === routing.w) {
          routeTab();
        } else {
          routing = null;
        }
      }

      // History a row's menu chose for this work item before its `hello`, now that its kept tabs are back.
      if (type === 'hello' && historyOnHello !== null) {
        const asked = historyOnHello;

        historyOnHello = null;

        if (asked === opened) {
          queueMicrotask(() => state.scope?.workItemId === asked && openHistory());
        }
      }

      applyHostSelection();
      // A burst of events, such as a long history read, draws once per frame, not once per event.
      drawSoon();

      if (type === 'session' || type === 'hello') {
        void readPrompt();
      }
  };

  // Brought back to the front, online again or out of the back-forward cache, the page checks its stream at once rather than wait for the watchdog.
  for (const type of ['online', 'focus', 'pageshow'] as const) {
    window.addEventListener(type, () => connection.wake(), { signal: listening.signal });
  }

  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && connection.wake(), { signal: listening.signal });
  root.addEventListener(
    'click',
    (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action="conn-retry"], [data-action="conn-reload"], [data-action="open-retry"], [data-action="open-back"]')?.dataset['action'];

      if (action === 'open-retry') {
        retryOpening();
      } else if (action === 'open-back') {
        leaveOpening();
      } else if (action === 'conn-retry') {
        connection.retryNow();
      } else if (action === 'conn-reload') {
        (deps.reload ?? (() => location.reload()))();
      }
    },
    { signal: listening.signal },
  );
  connection.start();
  draw();

  return {
    state: () => state,
    close: () => {
      clearInterval(iframeRenew);
      clearInterval(iframePlace);
      iframe.dispose();
      // A draw still asked for would draw the closed page.
      if (frame !== null) {
        frame.cancelled = true;
        frame = null;
      }

      clearInterval(seenTimer);
      clearInterval(filePoll);
      clearInterval(historyTick ?? undefined);
      clearTimeout(historyChange ?? undefined);
      browserResize?.disconnect();
      strips?.disconnect();
      settingsShown?.disconnect();
      modals.close();
      clearInterval(promptTimer);

      for (const { timer } of commentTimers.values()) {
        clearTimeout(timer);
      }

      // A start still pending neither redraws nor reports its timing from a closed page.
      micStart.clear();
      micTiming = null;
      listening.abort();
      dropDrawer();
      dropFileIcons();
      header.close();
      toastBox.close();
      connection.close();
      clearInterval(connectionTick);

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

/** Highlights a card or a message an answer links to for a moment. */
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

/** Loads Mermaid from the hub once, for diagrams in replies, states and artifacts; false when the hub has none. */
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
