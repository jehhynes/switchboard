import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Session, WindowBinding, WorkItem } from '@switchboard/core';
import { windowFileKey } from '@switchboard/core';
import { needsYou } from '@switchboard/core/group';
import { windowItems, windowOf } from './dock.js';
import type { Snapshot } from './snapshot.js';

/** One of a window's conversations (architecture.md § Window scope): its primary work item, or an ad hoc conversation it hosts. */
export interface ConversationRef {
  workItemId: number;
  primary: boolean;
}

/** What a window may see: its conversations, and of the selected one its work item and current session (architecture.md § Window scope). */
export interface WindowScope {
  kind: 'item';
  /** The window key, which every conversation route names. */
  key: string;
  /** The window's first folder, where a new conversation runs; null before it is known. */
  folder: string | null;
  /** The primary work item's ticket title, never an issue number alone. */
  title: string;
  /** Rises each time the window's selected conversation or its current session changes, so a command for the earlier one is refused. */
  scopeGen: number;
  /** The primary work item first, then the hosted conversations, newest first. */
  conversations: ConversationRef[];
  /** The selected conversation's work item. */
  workItemId: number;
  /** The selected conversation's current session's folder, or the checkout before its first. */
  cwd: string | null;
  /** The selected conversation's current session, the one started last; null before its first. */
  sessionId: string | null;
}

export interface WindowScopesDeps {
  /** The store's window bindings, kept by workspace file, the hosted work items and their sessions. */
  store: {
    windowBinding(file: string): WindowBinding | null;
    setWindowBinding(binding: WindowBinding): void;
    workItem(id: number): Pick<WorkItem, 'id' | 'ticketId' | 'status'> | null;
    ticket(id: number): { title: string; repoRoot: string; hostWindow?: string | null } | null;
    hostedWorkItems(file: string): Array<Pick<WorkItem, 'id' | 'ticketId' | 'status'>>;
    sessionsFor(workItemId: number): Array<Pick<Session, 'id' | 'cwd'>>;
  };
  /** The folder of the item windows' workspace files. */
  windows: string;
  now(): number;
  newKey?(): string;
}

interface Window {
  key: string;
  /** The workspace file of an item window; null for a folder window, which has no binding yet. */
  file: string | null;
  /** The primary work item. */
  workItemId: number | null;
  /** The primary work item's ticket, kept once seen, so its History stays readable after the work item leaves the snapshot. */
  ticketId: number | null;
  title: string;
  folder: string | null;
  scopeGen: number;
  selected: number | null;
  sessionId: string | null;
  cwd: string | null;
  /** Tickets this window may read the History of beyond its own, from History commands the dock left for it. */
  granted: Set<number>;
}

/**
 * The window scope rule (architecture.md § Window scope): each VS Code window gets a key in the `hello` of its `/events` stream, bound to its
 * workspace file. Its conversations are its primary work item, the newest work item of that file's window that is not done, else the newest,
 * and the ad hoc conversations its binding hosts (`Ticket.hostWindow`); never another work item, even one in the same folder. `windowItems`
 * can name several work items for one file, since successive work items of a ticket reuse its worktree, so it is never authority.
 */
export class WindowScopes {
  readonly #windows = new Map<string, Window>();

  constructor(private readonly deps: WindowScopesDeps) {}

  /** Registers a window stream and returns its key; the key dies with the stream. */
  open(file: string | null, snapshot: Snapshot | null): string {
    const key = this.deps.newKey?.() ?? randomBytes(24).toString('hex');
    const stored = file === null ? null : this.#binding(file);
    const workItemId = stored?.workItemId ?? null;
    // A bound work item that has left the snapshot, such as one done long ago, still names its ticket and title.
    const window: Window = {
      key,
      file,
      workItemId,
      ticketId: stored?.ticketId ?? (workItemId === null ? null : (this.deps.store.workItem(workItemId)?.ticketId ?? null)),
      title: stored?.title ?? '',
      folder: file === null ? null : workspaceFolder(file),
      scopeGen: stored?.scopeGen ?? 0,
      selected: stored?.selectedWorkItemId ?? null,
      sessionId: stored?.selectedSessionId ?? null,
      cwd: null,
      granted: new Set(),
    };

    this.#windows.set(key, window);

    if (file !== null) {
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

  /** Binds every window again in a new snapshot; returns the keys whose selected conversation or its current session changed. */
  update(snapshot: Snapshot): string[] {
    return [...this.#windows.values()].filter((window) => window.file !== null && this.#bind(window, snapshot)).map((window) => window.key);
  }

  #binding(file: string): WindowBinding | null {
    return this.deps.store.windowBinding(windowFileKey(file)) ?? this.deps.store.windowBinding(file);
  }

  /** The window's primary work item from the snapshot, its conversations and its selection; true when the selection or its session changed. */
  #bind(window: Window, snapshot: Snapshot | null): boolean {
    const before = { primary: window.workItemId, selected: window.selected, sessionId: window.sessionId, ticketId: window.ticketId, title: window.title };

    if (snapshot !== null) {
      const items = windowItems(snapshot, window.file!, this.deps.windows).sort((a, b) => a.id - b.id);
      const bound = items.filter((item) => item.status !== 'done').at(-1) ?? items.at(-1) ?? null;

      if (bound !== null) {
        if (bound.id !== window.workItemId) {
          window.granted.clear();
        }

        window.workItemId = bound.id;
        window.ticketId = bound.ticketId;
        window.title = bound.ticket.title;
        window.folder = windowOf(bound, this.deps.windows)?.folders[0] ?? window.folder;
      }
    }

    const listed = this.#listed(window).map((ref) => ref.workItemId);

    // A successor work item that replaced the selected primary is selected in its place; a selected conversation that left goes back to the primary.
    if (window.selected === null || (window.selected === before.primary && window.workItemId !== before.primary) || !listed.includes(window.selected)) {
      window.selected = window.workItemId !== null && listed.includes(window.workItemId) ? window.workItemId : (listed[0] ?? null);
    }

    this.#follow(window);

    const changed = window.selected !== before.selected || window.sessionId !== before.sessionId;

    if (changed) {
      window.scopeGen++;
    }

    if (changed || window.workItemId !== before.primary || window.ticketId !== before.ticketId || window.title !== before.title) {
      this.#save(window);
    }

    return changed;
  }

  /** The selected conversation's current session and its folder, else the checkout. */
  #follow(window: Window): void {
    const latest = window.selected === null ? undefined : this.deps.store.sessionsFor(window.selected).at(-1);
    const item = window.selected === null ? null : this.deps.store.workItem(window.selected);
    const ticket = item === null ? null : this.deps.store.ticket(item.ticketId);

    window.sessionId = latest?.id ?? null;
    window.cwd = latest?.cwd ?? (window.selected === window.workItemId ? window.folder : ticket?.repoRoot || window.folder);
  }

  #save(window: Window): void {
    this.deps.store.setWindowBinding({
      file: windowFileKey(window.file!),
      workItemId: window.workItemId,
      since: this.deps.now(),
      scopeGen: window.scopeGen,
      selectedWorkItemId: window.selected,
      selectedSessionId: window.sessionId,
      ticketId: window.ticketId,
      title: window.title,
    });
  }

  /**
   * The window's conversations: its primary work item first, then the ad hoc conversations its binding hosts that are not done, newest first,
   * and the selected one even when it is done, until another is selected.
   */
  #listed(window: Window): ConversationRef[] {
    if (window.file === null) {
      return [];
    }

    const hosted = this.deps.store.hostedWorkItems(window.file).filter((item) => item.status !== 'done' || item.id === window.selected);

    // A deleted primary stays the binding's, for its ticket and title, but is no conversation.
    const primary = window.workItemId !== null && this.deps.store.workItem(window.workItemId) !== null;

    return [...(primary ? [{ workItemId: window.workItemId!, primary: true }] : []), ...hosted.filter((item) => item.id !== window.workItemId).map((item) => ({ workItemId: item.id, primary: false }))];
  }

  /** The window's scope, or null for an unknown key or a window with no conversation. */
  scope(key: string): WindowScope | null {
    const window = this.#windows.get(key);

    if (window === undefined || window.file === null || window.selected === null) {
      return null;
    }

    return { kind: 'item', key, folder: window.folder, title: window.title, scopeGen: window.scopeGen, conversations: this.#listed(window), workItemId: window.selected, cwd: window.cwd, sessionId: window.sessionId };
  }

  /** Whether the key names a connected window. */
  has(key: string): boolean {
    return this.#windows.has(key);
  }

  /** The workspace file of the window the key names, or null. */
  fileOf(key: string): string | null {
    return this.#windows.get(key)?.file ?? null;
  }

  /** Whether the work item is one of the window's conversations. */
  holds(key: string, workItemId: number): boolean {
    const window = this.#windows.get(key);

    return window !== undefined && this.#listed(window).some((ref) => ref.workItemId === workItemId);
  }

  /**
   * Selects one of the window's conversations, raising its `scopeGen` and keeping the selection in its binding; false for a work item that is not
   * one of them.
   */
  select(key: string, workItemId: number): boolean {
    const window = this.#windows.get(key);

    if (window === undefined || !this.holds(key, workItemId)) {
      return false;
    }

    this.#choose(window, workItemId);

    return true;
  }

  #choose(window: Window, workItemId: number): void {
    window.selected = workItemId;
    this.#follow(window);
    window.scopeGen++;
    this.#save(window);
  }

  /** Whether the work item is a conversation the window's binding hosts, done or not. */
  #hosts(window: Window, workItemId: number): boolean {
    const item = this.deps.store.workItem(workItemId);
    const host = item === null ? null : (this.deps.store.ticket(item.ticketId)?.hostWindow ?? null);

    return window.file !== null && host !== null && windowFileKey(host) === windowFileKey(window.file);
  }

  /**
   * A dock row's click (architecture.md § Dock): stores a hosted work item, done or not, as its host binding's selection, so the window the click
   * opens shows it, and selects it in the connected windows of that binding; a primary row selects its work item in the windows it is primary of.
   * Returns the keys of the windows it moved and whether anything was selected or stored.
   */
  selectFor(workItemId: number, hostWindow: string | null): { keys: string[]; selected: boolean } {
    const windows = [...this.#windows.values()].filter((window) =>
      window.file === null ? false : hostWindow !== null ? windowFileKey(window.file) === windowFileKey(hostWindow) && this.#hosts(window, workItemId) : window.workItemId === workItemId,
    );
    let stored = false;

    if (hostWindow !== null && windows.length === 0) {
      const binding = this.#binding(hostWindow);

      const item = this.deps.store.workItem(workItemId);
      const host = item === null ? null : (this.deps.store.ticket(item.ticketId)?.hostWindow ?? null);

      if (binding !== null && host !== null && windowFileKey(host) === windowFileKey(hostWindow)) {
        const latest = this.deps.store.sessionsFor(workItemId).at(-1);

        this.deps.store.setWindowBinding({ ...binding, file: windowFileKey(hostWindow), scopeGen: binding.scopeGen + 1, selectedWorkItemId: workItemId, selectedSessionId: latest?.id ?? null });
        stored = true;
      }
    }

    const moved = windows.filter((window) => window.selected !== workItemId);

    for (const window of moved) {
      this.#choose(window, workItemId);
    }

    return { keys: moved.map((window) => window.key), selected: stored || windows.length > 0 };
  }

  /** The keys of connected windows whose selected conversation's current session is this one. */
  showing(sessionId: string): string[] {
    return [...this.#windows.values()].filter((window) => window.selected !== null && window.sessionId === sessionId).map((window) => window.key);
  }

  /** The keys of connected windows that list the work item among their conversations. */
  listing(workItemId: number): string[] {
    return [...this.#windows.keys()].filter((key) => this.holds(key, workItemId));
  }

  /**
   * What the window's `/events` stream gets in place of the whole snapshot: its conversations' work items alone, the controls its pane needs, and
   * how many work items need the operator, without naming them. A window that is not an item window gets no work item.
   */
  scoped(key: string, snapshot: Snapshot): Snapshot {
    const window = this.#windows.get(key);
    const ids = new Set(window === undefined ? [] : this.#listed(window).map((ref) => ref.workItemId));
    const { held: _held, notes: _notes, ...rest } = snapshot;

    // The sources' notes and errors can name other tickets, so a window gets neither.
    return { ...rest, errors: { ...snapshot.errors, sources: {} }, workItems: snapshot.workItems.filter((item) => ids.has(item.id)), pool: [], needsCount: snapshot.workItems.filter(needsYou).length };
  }

  /** Lets the window that claimed a ticket's History command open that ticket's History. */
  grant(key: string, ticketId: number): void {
    this.#windows.get(key)?.granted.add(ticketId);
  }

  /** Whether the window may read the ticket's History: its primary work item's, a conversation's, or one the dock sent it. */
  allowsTicket(key: string, ticketId: number, _snapshot?: Snapshot): boolean {
    const window = this.#windows.get(key);

    if (window === undefined) {
      return false;
    }

    return window.ticketId === ticketId || window.granted.has(ticketId) || this.#listed(window).some((ref) => this.deps.store.workItem(ref.workItemId)?.ticketId === ticketId);
  }
}

/** The first folder a workspace file names, or null when it cannot be read. */
export function workspaceFolder(file: string): string | null {
  try {
    const folders = (JSON.parse(readFileSync(file, 'utf8')) as { folders?: Array<{ path?: unknown }> }).folders;
    const path = folders?.[0]?.path;

    return typeof path === 'string' && path !== '' ? path : null;
  } catch {
    return null;
  }
}
