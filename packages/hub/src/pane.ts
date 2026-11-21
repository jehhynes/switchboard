import { randomBytes } from 'node:crypto';
import { PANE_EXTENSION_ID } from '@switchboard/core';
import type { PaneLinkState } from './paneLink.js';

/** The narrowest right column the pane covers, in CSS pixels: a normal Chrome window would not go below about 514 DIP (mechanics M103). */
export const PANE_MIN_WIDTH = 515;
/** The most links a work item's pane opens; the extension takes no more. */
export const PANE_MAX_TABS = 20;

/** The page's right column, as `getBoundingClientRect` gives it in CSS pixels, with the page's scale and viewport size. */
export interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
  dpr: number;
  innerWidth: number;
  innerHeight: number;
}

/** What the page shows of the pane (architecture.md § Pane state). */
export interface PanePageView {
  enabled: boolean;
  extension: PaneLinkState;
  /** The extension the page wakes and hands a pairing token to. */
  extensionId: string;
  /** The marker the page puts in its title until the pane helper has found its window. */
  marker: string | null;
  /** The pane helper shows the pane over this page's column. */
  shown: boolean;
  error: string | null;
}

/** A column the pane can cover, or null for a missing, malformed or too narrow one. */
export function paneRect(value: unknown): PaneRect | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const rect = value as Record<string, unknown>;
  const keys = ['left', 'top', 'width', 'height', 'dpr', 'innerWidth', 'innerHeight'] as const;

  if (!keys.every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]) && Math.abs(rect[key]) < 100_000)) {
    return null;
  }

  const read = Object.fromEntries(keys.map((key) => [key, rect[key] as number])) as unknown as PaneRect;

  return read.width >= PANE_MIN_WIDTH && read.height > 0 && read.dpr > 0 && read.innerWidth > 0 && read.innerHeight > 0 ? read : null;
}

/**
 * The tabs of a work item's row: its ticket URL, then its links, each http or https and once, at most {@link PANE_MAX_TABS}; the pull request's
 * tab in front for a work item in Ready for review, else the ticket's (PRD R113). Null without one.
 */
export function paneTabs(row: { url: string; links: ReadonlyArray<{ url: string; kind: string }> }, group: string | null): { urls: string[]; active: string } | null {
  const web = (url: string): boolean => {
    try {
      return ['http:', 'https:'].includes(new URL(url).protocol) && url.length <= 2048;
    } catch {
      return false;
    }
  };
  const urls = [...new Set([row.url, ...row.links.map((link) => link.url)].filter(web))].slice(0, PANE_MAX_TABS);
  const pullRequest = row.links.find((link) => link.kind === 'pr' && urls.includes(link.url))?.url;

  if (urls.length === 0) {
    return null;
  }

  return { urls, active: group === 'review' && pullRequest !== undefined ? pullRequest : web(row.url) ? row.url : urls[0]! };
}

export interface PaneStateDeps {
  enabled(): boolean;
  extension(): PaneLinkState;
  /** Sends the extension a message; false when no paired extension is connected. */
  toExtension(message: Record<string, unknown>): boolean;
  /** Sends the pane helper its `pane` order; false when no ready helper takes it. */
  toHelper(data: { marker: string | null; rect: PaneRect | null }): boolean;
  /** Whether a page needs the pane helper: the setting is on, a paired extension is connected and a page owns the pane. */
  want(on: boolean): void;
  toPage(key: string, view: PanePageView): void;
  pages(): string[];
  /** The tabs of the work item a page shows, with its ID, or null. */
  tabsOf(key: string): { workItemId: number; urls: string[]; active: string } | null;
  /** Whether focus in the pane window counts as focus in the page now. */
  focused(key: string, focused: boolean): void;
  log(line: string): void;
  marker?(): string;
}

/**
 * The Chrome pane's state in the hub (architecture.md § Pane state): which page owns the pane, its column, the handshake marker, and what the
 * pane helper reported; it tells the extension which window and tabs to show, the helper where to put the pane, and each page what to draw.
 */
export class PaneState {
  #owner: string | null = null;
  #rect: PaneRect | null = null;
  /** Each page's latest column, so a page that gains the focus can take the pane over. */
  readonly #rects = new Map<string, PaneRect>();
  /** The page that last gained its own focus, which takes the pane over once it has a column. */
  #focusedPage: string | null = null;
  #marker: string | null = null;
  #found = false;
  #shown = false;
  #focused = false;
  #error: string | null = null;
  /** Why the pane helper is not running, until it says it is ready again. */
  #helperError: string | null = null;
  /** The operator closed the pane window: no new one until the page shows another work item. */
  #dismissed: string | null = null;
  #helperReady = false;
  #sentHelper = '';
  #sentTabs = '';
  readonly #sentPages = new Map<string, string>();

  constructor(private readonly deps: PaneStateDeps) {}

  /**
   * `pane-rect`: the page's column, or null when it has none the pane can cover. A page owns the pane when none does, and takes it over when it
   * gains the focus (`pageFocused`), so a page in the background never moves the pane away from the one in use.
   */
  pageRect(key: string, rect: PaneRect | null): void {
    if (rect === null) {
      this.#rects.delete(key);
    } else {
      this.#rects.set(key, rect);
    }

    if (rect !== null && this.#owner !== key && (this.#owner === null || this.#focusedPage === key)) {
      this.#setOwner(key);
    }

    if (this.#owner === key) {
      this.#rect = rect;
    }

    this.update();
  }

  /** A page gained its own focus: it takes the pane over when it has a column, now or when it reports one. */
  pageFocused(key: string): void {
    const rect = this.#rects.get(key);

    this.#focusedPage = key;

    if (key !== this.#owner && rect !== undefined) {
      this.#setOwner(key);
      this.#rect = rect;
      this.update();
    }
  }

  pageClosed(key: string): void {
    this.#sentPages.delete(key);
    this.#rects.delete(key);
    this.#focusedPage = this.#focusedPage === key ? null : this.#focusedPage;

    if (this.#owner === key) {
      this.#setOwner(null);
    }

    this.update();
  }

  /** The pane helper's report (architecture.md § Pane helper): `ready`, or the current marker's state; false for a stale marker. */
  helperReport(report: { state: string; marker: string | null; focused?: boolean; reason?: string }): boolean {
    if (report.state === 'ready') {
      this.#helperReady = true;
      this.#helperError = null;
      this.#sentHelper = '';
      this.update();
      return true;
    }

    if (report.marker === null || report.marker !== this.#marker) {
      return false;
    }

    if (report.focused !== undefined && report.focused !== this.#focused && this.#owner !== null) {
      this.#focused = report.focused;
      this.deps.focused(this.#owner, report.focused);
    }

    if (report.state === 'found') {
      this.#found = true;
    } else if (report.state === 'shown' || report.state === 'hidden') {
      this.#shown = report.state === 'shown';
    } else if (report.state === 'lost') {
      // The page's window or the pane window was recreated: find both again with a new marker.
      this.deps.log('pane: a window was recreated; finding them again');
      this.#restart();
    } else if (report.state === 'failed') {
      this.#error = report.reason ?? 'Switchboard could not keep the pane in place.';
      this.deps.log(`pane: ${this.#error}`);
      this.#restart();
      this.#dismissed = this.#tabsKey();
    }

    this.update();
    return true;
  }

  /** The pane helper stopped, with why when it will not start again until no page needs it: the pane starts over once one is ready again. */
  helperStopped(error: string | null): void {
    this.#helperReady = false;
    this.#helperError = error;
    this.#sentHelper = '';
    this.update();
  }

  /** A paired extension's message: `closed` when the operator closed the pane window. */
  extensionMessage(message: Record<string, unknown>): void {
    if (message['type'] === 'closed') {
      this.#restart();
      this.#dismissed = this.#tabsKey();
      this.update();
    }
  }

  /** The pane's state after any change: the setting, the extension, a page's selection or the views. */
  update(): void {
    const tabs = this.#owner === null ? null : this.deps.tabsOf(this.#owner);
    const tabsKey = JSON.stringify(tabs);

    // Showing another work item lifts a dismissal and an error.
    if (this.#dismissed !== null && this.#dismissed !== tabsKey) {
      this.#dismissed = null;
      this.#error = null;
    }

    const wanted = this.deps.enabled() && this.deps.extension() === 'paired' && this.#owner !== null && this.#dismissed === null;
    const active = wanted && this.#helperReady;

    if (!active && this.#marker !== null) {
      this.#restart();
    }

    if (active && this.#marker === null) {
      this.#marker = this.deps.marker?.() ?? randomBytes(6).toString('hex');
      this.deps.toExtension({ type: 'window', marker: this.#marker });
    }

    const show = active && this.#rect !== null && tabs !== null;

    if (show && this.#found && tabsKey !== this.#sentTabs) {
      this.#sentTabs = tabsKey;
      this.deps.toExtension({ type: 'tabs', urls: tabs!.urls, active: tabs!.active });
    }

    const order = { marker: this.#marker, rect: show ? this.#rect : null };
    const orderKey = JSON.stringify(order);

    if (this.#helperReady && orderKey !== this.#sentHelper) {
      this.#sentHelper = orderKey;

      if (!this.deps.toHelper(order)) {
        this.#helperReady = false;
        this.#sentHelper = '';
      }
    }

    // Started when a page needs it and stopped when none does; a stopped helper lets the pane go.
    this.deps.want(wanted);

    for (const key of this.deps.pages()) {
      const view: PanePageView = {
        enabled: this.deps.enabled(),
        extension: this.deps.extension(),
        extensionId: PANE_EXTENSION_ID,
        marker: key === this.#owner && !this.#found ? this.#marker : null,
        shown: key === this.#owner && show && this.#shown,
        error: key === this.#owner ? (this.#error ?? this.#helperError) : null,
      };
      const text = JSON.stringify(view);

      if (this.#sentPages.get(key) !== text) {
        this.#sentPages.set(key, text);
        this.deps.toPage(key, view);
      }
    }
  }

  #tabsKey(): string {
    return JSON.stringify(this.#owner === null ? null : this.deps.tabsOf(this.#owner));
  }

  #setOwner(key: string | null): void {
    this.#restart();
    this.#owner = key;
    this.#rect = null;
    this.#error = null;
    this.#dismissed = null;
  }

  #restart(): void {
    if (this.#focused && this.#owner !== null) {
      this.deps.focused(this.#owner, false);
    }

    this.#marker = null;
    this.#found = false;
    this.#shown = false;
    this.#focused = false;
    this.#sentTabs = '';
  }
}
