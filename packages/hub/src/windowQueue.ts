import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostKey } from '@switchboard/core';

/** How long a pending open or window command waits for its window. */
export const OPEN_CLAIM_MS = 2 * 60_000;

interface PendingOpen {
  /** `folderKey` of the session's directory. */
  folder: string;
  sessionId: string;
  at: number;
  /** The destination window's workspace file; only a window bound to it claims the open. */
  workspace: string;
}

interface PendingCommand {
  id: number;
  command: Record<string, unknown>;
  workspace: string | null;
  at: number;
}

interface Queued {
  opens: PendingOpen[];
  commands: PendingCommand[];
  nextId: number;
}

/**
 * The sessions and commands left for VS Code windows until a window claims them (PRD R71). Each change is written to `file`, so a hub that
 * replaces another, as the first window started after an extension update does, keeps what the dock left for the window it is opening.
 */
export class WindowQueue {
  private constructor(
    private readonly file: string | null,
    private readonly now: () => number,
    private readonly log: (line: string) => void,
    private queued: Queued,
  ) {}

  /** Reads the queue a previous hub saved to `file`, dropping what expired; a missing or unreadable file, or a null `file`, starts empty. */
  static load(file: string | null, now: () => number, log: (line: string) => void = () => {}): WindowQueue {
    let queued: Queued = { opens: [], commands: [], nextId: 1 };

    try {
      const read = file === null ? null : (JSON.parse(readFileSync(file, 'utf8')) as Partial<Queued> | null);

      if (read !== null && Array.isArray(read.opens) && Array.isArray(read.commands) && Number.isInteger(read.nextId)) {
        queued = { opens: read.opens.filter(isOpen), commands: read.commands.filter(isCommand), nextId: read.nextId! };
      }
    } catch {
      // No queue saved yet.
    }

    const recent = (at: number) => now() - at <= OPEN_CLAIM_MS;

    return new WindowQueue(file, now, log, { ...queued, opens: queued.opens.filter((open) => recent(open.at)), commands: queued.commands.filter((pending) => recent(pending.at)) });
  }

  /**
   * Records that a window or the dock asked to open a session, run in `cwd`, in the window opened from `workspace`, which only a window bound to
   * that file claims when it connects or gains focus, because item windows share folders (architecture.md § Window scope). It replaces an
   * earlier open for that window. False when the queue could not be saved, so nothing was recorded.
   */
  recordOpen(sessionId: string, cwd: string, workspace: string): boolean {
    const folder = folderKey(cwd);
    const opens = [...this.queued.opens.filter((open) => !sameWorkspace(open.workspace, workspace)), { folder, sessionId, at: this.now(), workspace }];

    return this.commit({ ...this.queued, opens });
  }

  /** The session the window opened from `workspace` should open, if one is pending and recent; none for a window with no workspace file. Claiming removes it. */
  claimOpen(workspace: string | null): string | null {
    const pending = workspace === null ? undefined : this.queued.opens.find((open) => sameWorkspace(open.workspace, workspace));

    if (pending === undefined) {
      return null;
    }

    this.update({ ...this.queued, opens: this.queued.opens.filter((open) => open !== pending) });

    return this.now() - pending.at <= OPEN_CLAIM_MS ? pending.sessionId : null;
  }

  /**
   * Keeps a command for the window opened from `workspace` to run when it next claims, or with null for the first focused window that claims.
   * Returns its ID, or null when the queue could not be saved, so a later hub never hands out an ID the dock already holds.
   */
  recordCommand(command: Record<string, unknown>, workspace: string | null): number | null {
    const id = this.queued.nextId;

    return this.commit({ opens: this.queued.opens, commands: [...this.queued.commands, { id, command, workspace, at: this.now() }], nextId: id + 1 }) ? id : null;
  }

  /** Drops a command no window has claimed yet, because the dock did not bring its window forward; false when it is gone already. */
  withdrawCommand(id: number): boolean {
    const commands = this.queued.commands.filter((pending) => pending.id !== id);

    if (commands.length === this.queued.commands.length) {
      return false;
    }

    this.update({ ...this.queued, commands });
    return true;
  }

  /**
   * The commands for a window opened from `workspace` that are pending and recent, oldest first, and when the window is `focused`, those for any
   * window, which the dock left for the window it brought to the front. Claiming removes them; one `accepts` refuses stays queued as it was, with
   * its ID, time and workspace.
   */
  claimCommands(workspace: string | null, focused: boolean, accepts: (command: Record<string, unknown>) => boolean = () => true): Record<string, unknown>[] {
    const now = this.now();
    const recent = this.queued.commands.filter((pending) => now - pending.at <= OPEN_CLAIM_MS);
    const mine = recent.filter(
      (pending) => (pending.workspace === null ? focused : workspace !== null && folderKey(pending.workspace) === folderKey(workspace)) && accepts(pending.command),
    );

    if (mine.length > 0 || recent.length < this.queued.commands.length) {
      this.update({ ...this.queued, commands: recent.filter((pending) => !mine.includes(pending)) });
    }

    return mine.map((pending) => pending.command);
  }

  /** Saves `next` and only then keeps it; false when the save failed. */
  private commit(next: Queued): boolean {
    if (!this.save(next)) {
      return false;
    }

    this.queued = next;
    return true;
  }

  /** Keeps `next`, a removal, even when the save fails: a later hub may then hand out a claimed entry again until it expires. */
  private update(next: Queued): void {
    this.save(next);
    this.queued = next;
  }

  /** Writes the queue through a temporary file, so the next hub never reads half of it. */
  private save(queued: Queued): boolean {
    if (this.file === null) {
      return true;
    }

    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(queued));
      renameSync(`${this.file}.tmp`, this.file);
      return true;
    } catch (error) {
      this.log(`window queue not saved to ${this.file}: ${(error as Error).message}`);
      return false;
    }
  }
}

function isOpen(value: unknown): value is PendingOpen {
  const open = value as PendingOpen | null;

  return typeof open?.folder === 'string' && typeof open.sessionId === 'string' && Number.isFinite(open.at) && typeof open.workspace === 'string';
}

function isCommand(value: unknown): value is PendingCommand {
  const pending = value as PendingCommand | null;

  return (
    Number.isInteger(pending?.id) &&
    typeof pending!.command === 'object' &&
    pending!.command !== null &&
    Number.isFinite(pending!.at) &&
    (pending!.workspace === null || typeof pending!.workspace === 'string')
  );
}

function sameWorkspace(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : folderKey(a) === folderKey(b);
}

/** A destination compared as a window binding is (`hostKey`), so a folder destination keeps its case where the file system does. */
function folderKey(path: string): string {
  return hostKey(path);
}
