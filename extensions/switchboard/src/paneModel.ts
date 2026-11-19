import type { DockRow, Snapshot } from '@switchboard/hub';
import { dockView } from '@switchboard/hub';

/** A link pill: the ticket's key or one of its links (PRD R52), opened in VS Code. */
export interface PaneLink {
  text: string;
  /** The codicon glyph before the text, as the dock draws a pull request badge, or null. */
  glyph: string | null;
  /** Null for a ticket with no page, such as an ad-hoc one, whose key is shown but opens nothing. */
  url: string | null;
  kind: 'ticket' | 'pr' | 'issue' | 'url';
  /** A link named in the ticket's text (PRD R61), drawn muted. */
  mentioned: boolean;
  title: string;
}

/** One work item of this window: its pills, its approval report and its main control (PRD R92). */
export interface PaneItem {
  /** The row's key, which the main control's message names. */
  key: string;
  links: PaneLink[];
  /** The approval report's draft, a file path, or null. */
  report: string | null;
  main: { label: string; glyph: string | null; title: string } | null;
}

/** What the Switchboard pane shows: this window's work items, or with none, how many work items need the operator (PRD R64, R92). */
export interface PaneModel {
  items: PaneItem[];
  needs: number;
}

/** The pane's model for the window opened from `file`, null for a window that is not an item window (PRD R92). */
export function paneModel(snapshot: Snapshot | null, file: string | null, windows: string, now: number): PaneModel {
  if (snapshot === null) {
    return { items: [], needs: 0 };
  }

  // The hub counts the work items that need the operator without naming them, since the window's snapshot holds its own work item only.
  return { items: file === null ? [] : windowRows(snapshot, file, windows, now).map(paneItem), needs: snapshot.needsCount ?? 0 };
}

/**
 * The rows, in list order, whose item window is the one opened from `file`. Done rows are left out while the window has a row that is not done, because a
 * later work item of the same ticket, such as a merge after its development, runs in the same worktree and repeats the ticket's pills.
 */
export function windowRows(snapshot: Snapshot, file: string, windows: string, now: number): DockRow[] {
  const rows = dockView(snapshot, now, windows).groups.flatMap((group) =>
    group.rows.filter((row) => row.window !== null && normal(row.window.file) === normal(file)).map((row) => ({ row, done: group.key === 'done' })),
  );
  const open = rows.filter((entry) => !entry.done);

  return (open.length === 0 ? rows : open).map((entry) => entry.row);
}

function paneItem(row: DockRow): PaneItem {
  const report = row.commands.find((command) => command.label === 'Open report')?.command['url'];

  return {
    key: row.key,
    links: [
      { text: row.ticket, glyph: null, url: row.url === '' ? null : row.url, kind: 'ticket', mentioned: false, title: row.title },
      ...row.links.map((link) => ({ text: link.badge, glyph: link.glyph, url: link.url, kind: link.kind, mentioned: link.mentioned, title: link.mentioned ? `${link.label}: named in the ticket` : link.label })),
    ],
    report: typeof report === 'string' ? report : null,
    main: row.main === null ? null : { label: row.main, glyph: row.mainGlyph, title: row.mainTitle ?? row.main },
  };
}

/**
 * The terminal command of a row whose main control is Open in terminal (PRD R28): the window command the row has, or with
 * `dock.openTerminal` set to the terminal app, where the row has none, the same command built from the row's terminal. Null otherwise.
 */
export function mainTerminal(row: DockRow): Record<string, unknown> | null {
  if (row.main !== 'Open in terminal') {
    return null;
  }

  const command = row.commands.find((shown) => shown.command['type'] === 'terminal')?.command;

  if (command !== undefined) {
    return command;
  }

  const terminal = row.terminal;

  if (terminal === null) {
    return null;
  }

  // A Code Mode session's terminal attaches by its Switchboard session ID, and the hub adds its attach command (PRD R95).
  if (terminal.codeMode === true) {
    return { type: 'terminal', provider: 'claude', sessionId: terminal.sessionId, cwd: terminal.cwd, name: row.ticket, shortId: null, active: false, codeMode: true };
  }

  return { type: 'terminal', provider: terminal.provider, sessionId: terminal.sessionId, cwd: terminal.cwd, name: row.ticket, shortId: terminal.args[0] === 'attach' ? (terminal.args[1] ?? null) : null, active: terminal.active };
}

function normal(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}
