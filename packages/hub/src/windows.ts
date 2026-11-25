import { randomBytes } from 'node:crypto';
import type { Session, WorkItem } from '@switchboard/core';
import { windowOf } from './dock.js';
import { pageGroups } from './page.js';
import type { Snapshot } from './snapshot.js';

/** Why the hub refuses a page key that no connected page holds, as after the page's stream ended or the hub restarted (403). */
export const PAGE_GONE = "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page.";
/** Why the hub refuses a request about a work item or session from a connected page that has none open (403). */
export const NOTHING_OPEN = 'This page has no work item open, so that was not done. Open one and try again.';
/** Why the hub refuses a request about a work item, session or message outside what the page shows, as after it opened another (403). */
export const NOT_SHOWN = 'This page now shows another work item or session, so that was not done. Check what it shows and try again.';
/** Why the hub refuses to select a work item it does not have, as after it was deleted, or a session that is not that work item's (403). */
export const GONE_ITEM = 'Switchboard has no such work item, or that session is not one of its sessions.';
/** Why the hub refuses to mark seen a reply or status that is not in the session the page shows (403). */
export const NOT_IN_SESSION = 'That reply or status is not in the session this page shows.';
/** Why the hub refuses to read a reply again that is not in the session the page shows (403). */
export const REPLY_NOT_SHOWN = 'That reply is not in the session this page shows, so it was not read again.';
/** Why the hub refuses a page key that another browser sign-in or origin holds (403). */
export const OTHER_SIGN_IN = "This page's connection belongs to another sign-in or address. Reload the page.";

/**
 * The 403 for a request outside a page's scope (architecture.md § Window scope), saying which of the scope rule's facts failed: the key is no
 * connected page's (`known` false), the page has no work item open (`scope` null), or the request names something the page does not show.
 */
export function outOfScope(known: boolean, scope: WindowScope | null): { status: 403; body: { error: string } } {
  return { status: 403, body: { error: !known ? PAGE_GONE : scope === null ? NOTHING_OPEN : NOT_SHOWN } };
}

/** One of a page's conversations (architecture.md § Window scope): a work item of the selected work item's group. */
export interface ConversationRef {
  workItemId: number;
  primary: boolean;
}

/** What a web page may see: its conversations, and of the selected one its work item and current session (architecture.md § Window scope). */
export interface WindowScope {
  /** The web page, bound to the work item it selected (architecture.md § Web page). */
  kind: 'page';
  /** The page key, which every conversation route names. */
  key: string;
  /** The folder the selected work item's window works in, where its sessions run; null before it is known. */
  folder: string | null;
  /** The selected work item's ticket title. */
  title: string;
  /** Rises each time the page's selected conversation or its current session changes, so a command for the earlier one is refused. */
  scopeGen: number;
  /** The selected work item's group in the page's list, the group's own work item first when it has one. */
  conversations: ConversationRef[];
  /** The selected conversation's work item. */
  workItemId: number | null;
  /** The selected conversation's current session's folder, or the checkout before its first. */
  cwd: string | null;
  /** The session the page shows: the current session, or an earlier session of the work item that the page chose (`earlier`); null before its first. */
  sessionId: string | null;
  /** The page shows an earlier session of its work item, read-only (architecture.md § Web page); left out for the current session. */
  earlier?: true;
}

export interface WindowScopesDeps {
  store: {
    workItem(id: number): Pick<WorkItem, 'id' | 'ticketId' | 'status'> | null;
    ticket(id: number): { title: string; repoRoot: string } | null;
    sessionsFor(workItemId: number): Array<Pick<Session, 'id' | 'cwd'>>;
  };
  /** The folder of the work items' workspace files. */
  windows: string;
  newKey?(): string;
}

interface Page {
  key: string;
  workItemId: number | null;
  ticketId: number | null;
  title: string;
  folder: string | null;
  scopeGen: number;
  selected: number | null;
  sessionId: string | null;
  /** An earlier session of the selected work item the page shows instead of the current one; null shows the current one. */
  pinned: string | null;
  cwd: string | null;
  /** The selected work item's group in the page's list, the group's own work item first when it has one. */
  group: { ids: number[]; head: boolean };
}

/**
 * The scope rule (architecture.md § Window scope): each web page's conversation stream gets a page key, bound to nothing until it selects a work
 * item, and then to that work item's group in the page's list. Never kept in the store, so a reload starts unbound.
 */
export class WindowScopes {
  readonly #pages = new Map<string, Page>();
  /** The latest snapshot, which a page's `select` reads its work item's window and group from. */
  #snapshot: Snapshot | null = null;

  constructor(private readonly deps: WindowScopesDeps) {}

  /** Registers a web page's conversation stream and returns its page key (architecture.md § Web page). */
  openPage(): string {
    const key = this.deps.newKey?.() ?? randomBytes(24).toString('hex');

    this.#pages.set(key, { key, workItemId: null, ticketId: null, title: '', folder: null, scopeGen: 0, selected: null, sessionId: null, pinned: null, cwd: null, group: { ids: [], head: false } });
    return key;
  }

  /** Whether the key is a connected web page's. */
  isPage(key: string): boolean {
    return this.#pages.has(key);
  }

  close(key: string): void {
    this.#pages.delete(key);
  }

  keys(): string[] {
    return [...this.#pages.keys()];
  }

  /** Binds every page again in a new snapshot; returns the keys whose selected conversation or its current session changed. */
  update(snapshot: Snapshot): string[] {
    this.#snapshot = snapshot;

    return [...this.#pages.values()].filter((page) => this.#bind(page)).map((page) => page.key);
  }

  /** A page's selected work item again: its title, folder, group and current session; true when its selection or session changed. */
  #bind(page: Page): boolean {
    const before = { selected: page.selected, sessionId: page.sessionId };

    if (page.selected !== null && this.deps.store.workItem(page.selected) === null) {
      page.selected = null;
    }

    this.#place(page);
    this.#follow(page);

    const changed = page.selected !== before.selected || page.sessionId !== before.sessionId;

    if (changed) {
      page.scopeGen++;
    }

    return changed;
  }

  /** A page's work item's title, the folder its window works in, and its group in the page's list. */
  #place(page: Page): void {
    const id = page.selected;

    page.workItemId = id;

    if (id === null) {
      page.group = { ids: [], head: false };
      return;
    }

    const item = this.deps.store.workItem(id);
    const ticket = item === null ? null : this.deps.store.ticket(item.ticketId);
    const shown = this.#snapshot?.workItems.find((one) => one.id === id);
    const group = this.#snapshot === null ? undefined : pageGroups(this.#snapshot, this.deps.windows, id).find((one) => one.ids.includes(id));

    page.ticketId = item?.ticketId ?? null;
    page.title = ticket?.title ?? page.title;
    page.folder = (shown === undefined ? null : (windowOf(shown, this.deps.windows)?.folders[0] ?? null)) ?? ticket?.repoRoot ?? null;
    page.group = group === undefined ? { ids: [id], head: false } : { ids: group.ids, head: group.kind === 'item' };
  }

  /**
   * The selected conversation's current session and its folder, else the checkout; the earlier session the page pinned while that is still an
   * earlier session of the selected work item. The folder stays the current session's, so the work item's artifacts and changes stay its own
   * while an earlier session shows, such as a setup session that ran in the repository's root.
   */
  #follow(page: Page): void {
    const sessions = page.selected === null ? [] : this.deps.store.sessionsFor(page.selected);
    const latest = sessions.at(-1);
    const pinned = page.pinned === null ? undefined : sessions.find((one) => one.id === page.pinned && one !== latest);
    const shown = pinned ?? latest;
    const item = page.selected === null ? null : this.deps.store.workItem(page.selected);
    const ticket = item === null ? null : this.deps.store.ticket(item.ticketId);

    page.pinned = pinned?.id ?? null;
    page.sessionId = shown?.id ?? null;
    page.cwd = page.selected === null ? null : (latest?.cwd ?? (page.selected === page.workItemId ? page.folder : ticket?.repoRoot || page.folder));
  }

  /** A page's conversations: its selected work item's group in the page's list, the group's own work item first when it has one. */
  #listed(page: Page): ConversationRef[] {
    const ids = page.selected === null ? [] : page.group.ids.includes(page.selected) ? page.group.ids : [page.selected];

    return ids.filter((id) => this.deps.store.workItem(id) !== null).map((id, index) => ({ workItemId: id, primary: page.group.head && index === 0 && ids === page.group.ids }));
  }

  /** The page's scope, or null for an unknown key or a page with no selection. */
  scope(key: string): WindowScope | null {
    const page = this.#pages.get(key);

    return page === undefined || page.selected === null
      ? null
      : { kind: 'page', key, folder: page.folder, title: page.title, scopeGen: page.scopeGen, conversations: this.#listed(page), workItemId: page.selected, cwd: page.cwd, sessionId: page.sessionId, ...(page.pinned === null ? {} : { earlier: true as const }) };
  }

  /** Whether the key names a connected page. */
  has(key: string): boolean {
    return this.#pages.has(key);
  }

  /** Whether the work item is one of the page's conversations. */
  holds(key: string, workItemId: number): boolean {
    const page = this.#pages.get(key);

    return page !== undefined && this.#listed(page).some((ref) => ref.workItemId === workItemId);
  }

  /**
   * Selects any work item the store knows (architecture.md § Web page), raising the page's `scopeGen`; the scope rule then holds it to that work
   * item's group. `sessionId` names one of the work item's sessions, an earlier one to show it read-only or the current one. False for an unknown
   * key, work item or session.
   */
  select(key: string, workItemId: number, sessionId: string | null = null): boolean {
    const page = this.#pages.get(key);

    if (page === undefined || this.deps.store.workItem(workItemId) === null || (sessionId !== null && !this.deps.store.sessionsFor(workItemId).some((one) => one.id === sessionId))) {
      return false;
    }

    page.selected = workItemId;
    page.pinned = sessionId;
    this.#place(page);
    this.#follow(page);
    page.scopeGen++;
    return true;
  }

  /** The keys of connected pages whose selected conversation's shown session is this one. */
  showing(sessionId: string): string[] {
    return [...this.#pages.values()].filter((page) => page.selected !== null && page.sessionId === sessionId).map((page) => page.key);
  }

  /** The keys of connected pages that list the work item among their conversations. */
  listing(workItemId: number): string[] {
    return [...this.#pages.keys()].filter((key) => this.holds(key, workItemId));
  }
}

/** The scope with no session while it shows an earlier session read-only, for what acts only on a current session, as the voice does. */
export function liveScope(scope: WindowScope | null): WindowScope | null {
  return scope?.earlier === true ? { ...scope, sessionId: null } : scope;
}
