import { randomBytes } from 'node:crypto';
import type { WindowBinding } from '@switchboard/core';
import { needsYou } from '@switchboard/core/group';
import { windowItems } from './dock.js';
import type { Snapshot, WorkItemView } from './snapshot.js';

/** What a window may see: its work item and that work item's current session (architecture.md § Window scope). */
export interface WindowScope {
  kind: 'item';
  workItemId: number;
  /** The window key, which every conversation route names. */
  key: string;
  /** The ticket's title, never an issue number alone. */
  title: string;
  cwd: string | null;
  /** Rises each time the window's work item changes, so a command for the earlier one is refused. */
  scopeGen: number;
  /** The work item's current session, the one started last; null before its first. */
  sessionId: string | null;
}

export interface WindowScopesDeps {
  /** The store's window bindings, kept by workspace file. */
  store: { windowBinding(file: string): WindowBinding | null; setWindowBinding(binding: WindowBinding): void; workItem(id: number): { ticketId: number } | null };
  /** The folder of the item windows' workspace files. */
  windows: string;
  now(): number;
  newKey?(): string;
}

interface Window {
  key: string;
  /** The workspace file of an item window; null for a folder window, which has no work item. */
  file: string | null;
  workItemId: number | null;
  /** The bound work item's ticket, kept once seen, so its History stays readable after the work item leaves the snapshot. */
  ticketId: number | null;
  scopeGen: number;
  sessionId: string | null;
  title: string;
  cwd: string | null;
  /** Tickets this window may read the History of beyond its own, from History commands the dock left for it. */
  granted: Set<number>;
}

/**
 * The window scope rule (architecture.md § Window scope): each VS Code window gets a key in the `hello` of its `/events` stream, bound to its
 * workspace file, and sees only the work item its binding names: the newest work item of that file's window that is not done, else the newest.
 * `windowItems` can name several work items for one file, since successive work items of a ticket reuse its worktree, so it is never authority.
 */
export class WindowScopes {
  readonly #windows = new Map<string, Window>();

  constructor(private readonly deps: WindowScopesDeps) {}

  /** Registers a window stream and returns its key; the key dies with the stream. */
  open(file: string | null, snapshot: Snapshot | null): string {
    const key = this.deps.newKey?.() ?? randomBytes(24).toString('hex');
    const stored = file === null ? null : this.deps.store.windowBinding(file);
    const workItemId = stored?.workItemId ?? null;
    // A bound work item that has left the snapshot, such as one done long ago, still names its ticket.
    const window: Window = { key, file, workItemId, ticketId: workItemId === null ? null : (this.deps.store.workItem(workItemId)?.ticketId ?? null), scopeGen: stored?.scopeGen ?? 0, sessionId: null, title: '', cwd: null, granted: new Set() };

    this.#windows.set(key, window);

    if (snapshot !== null) {
      this.#bind(window, snapshot);
    }

    return key;
  }

  close(key: string): void {
    this.#windows.delete(key);
  }

  keys(): string[] {
    return [...this.#windows.keys()];
  }

  /**
   * Binds every window to its work item in a new snapshot; returns the keys whose work item or current session changed, which start from empty
   * with the new one.
   */
  update(snapshot: Snapshot): string[] {
    return [...this.#windows.values()].filter((window) => this.#bind(window, snapshot)).map((window) => window.key);
  }

  #bind(window: Window, snapshot: Snapshot): boolean {
    if (window.file === null) {
      return false;
    }

    const items = windowItems(snapshot, window.file, this.deps.windows).sort((a, b) => a.id - b.id);
    const bound = items.filter((item) => item.status !== 'done').at(-1) ?? items.at(-1) ?? null;
    // A work item that left the snapshot, such as one done long ago, stays the window's.
    const workItemId = bound?.id ?? window.workItemId;
    const item = workItemId === null ? undefined : snapshot.workItems.find((one) => one.id === workItemId);
    const sessionId = item?.sessions.at(-1)?.id ?? (workItemId === window.workItemId ? window.sessionId : null);
    const moved = workItemId !== window.workItemId;
    const changed = moved || sessionId !== window.sessionId;

    if (moved) {
      window.ticketId = null;
    }

    if (item !== undefined) {
      window.ticketId = item.ticketId;
      window.title = item.ticket.title;
      window.cwd = item.sessions.at(-1)?.cwd ?? item.worktree?.path ?? null;
    }

    if (moved) {
      window.workItemId = workItemId;
      window.scopeGen++;
      window.granted.clear();
      this.deps.store.setWindowBinding({ file: window.file, workItemId, since: this.deps.now(), scopeGen: window.scopeGen });
    }

    window.sessionId = sessionId;

    return changed;
  }

  /** The window's scope, or null for an unknown key or a window with no work item. */
  scope(key: string): WindowScope | null {
    const window = this.#windows.get(key);

    if (window === undefined || window.workItemId === null) {
      return null;
    }

    return { kind: 'item', workItemId: window.workItemId, key, title: window.title, cwd: window.cwd, scopeGen: window.scopeGen, sessionId: window.sessionId };
  }

  /** Whether the key names a connected window. */
  has(key: string): boolean {
    return this.#windows.has(key);
  }

  /** The keys of connected windows whose current session is this one. */
  showing(sessionId: string): string[] {
    return [...this.#windows.values()].filter((window) => window.workItemId !== null && window.sessionId === sessionId).map((window) => window.key);
  }

  /**
   * What the window's `/events` stream gets in place of the whole snapshot: its work item alone, the controls its pane needs, and how many work
   * items need the operator, without naming them. A window that is not an item window gets no work item.
   */
  scoped(key: string, snapshot: Snapshot): Snapshot & { needsCount: number } {
    const window = this.#windows.get(key);
    const item = window?.workItemId == null ? undefined : snapshot.workItems.find((one) => one.id === window.workItemId);
    const { held: _held, notes: _notes, ...rest } = snapshot;

    // The sources' notes and errors can name other tickets, so a window gets neither.
    return { ...rest, errors: { ...snapshot.errors, sources: {} }, workItems: item === undefined ? [] : [item], pool: [], needsCount: snapshot.workItems.filter(needsYou).length };
  }

  /** Lets the window that claimed a ticket's History command open that ticket's History. */
  grant(key: string, ticketId: number): void {
    this.#windows.get(key)?.granted.add(ticketId);
  }

  /** Whether the window may read the ticket's History: its own work item's, or one the dock sent it. */
  allowsTicket(key: string, ticketId: number, snapshot: Snapshot): boolean {
    const window = this.#windows.get(key);

    if (window === undefined) {
      return false;
    }

    const item: WorkItemView | undefined = window.workItemId === null ? undefined : snapshot.workItems.find((one) => one.id === window.workItemId);

    return (item?.ticketId ?? window.ticketId) === ticketId || window.granted.has(ticketId);
  }
}
