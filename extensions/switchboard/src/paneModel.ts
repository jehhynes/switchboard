import type { PullRequestStatus } from '@switchboard/core';
import type { DockRow, Snapshot, VoiceView } from '@switchboard/hub';
import { dockView } from '@switchboard/hub';
import { voiceStatus } from './conversationModel.js';

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
  /** A pull request's state, review decision and checks, once its source read them (PRD R92); null otherwise. */
  pr: PullRequestStatus | null;
}

/** A line of text the pane shows under an item's pills, with its tooltip. */
export interface PaneText {
  text: string;
  title: string | null;
}

/** One work item of this window: its pills, its approval report and its main control (PRD R92). */
export interface PaneItem {
  /** The row's key, which the main control's message names. */
  key: string;
  /** The source's plugin, such as `github`, which colours the ticket pill as the dock does. */
  sourceKind: string;
  /** The playbook, as the dock's row names it, and the row's mark in words and as its codicon glyph. */
  playbook: string;
  mark: { glyph: string; title: string } | null;
  /** The dock row's stripe, which the pane's item takes too (PRD R27). */
  stripe: DockRow['stripe'];
  links: PaneLink[];
  /** The row's line 3 without its alerts: waits, the stage and its age. */
  progress: PaneText[];
  /** The first line of the latest status of this window's session for the work item, or null. */
  status: string | null;
  /** The row's warnings and errors, such as a failed setup, and its rate-limit wait with its reset time. */
  alerts: PaneText[];
  /** The approval report's draft, a file path, or null. */
  report: string | null;
  main: { label: string; glyph: string | null; title: string } | null;
}

/** The voice at a glance in this window: the mic's state as the status bar item shows it, and Talk here while the voice is elsewhere. */
export interface PaneVoice {
  icon: string;
  text: string;
  tooltip: string;
  talkHere: boolean;
}

/** What the Switchboard pane shows: only this window's work items, and the voice in this window; nothing about other windows (PRD R92). */
export interface PaneModel {
  items: PaneItem[];
  voice: PaneVoice | null;
}

/** What only this window knows: its Conversation view's latest status, for the work item it belongs to, and its voice state. */
export interface PaneWindow {
  status: { workItemId: number; line: string } | null;
  voice: VoiceView | null;
}

/** The pane's model for the window opened from `file`; a window that is not an item window has no items (PRD R92). */
export function paneModel(snapshot: Snapshot | null, file: string | null, windows: string, now: number, here: PaneWindow = { status: null, voice: null }): PaneModel {
  const shown = voiceStatus(here.voice);
  const voice = shown === null ? null : { icon: /^\$\(([\w-]+)\)/.exec(shown.text)?.[1] ?? 'mic', text: shown.text.replace(/^\$\([\w-]+\)\s*/, ''), tooltip: shown.tooltip, talkHere: here.voice?.here === false || here.voice?.deviceOff === true };

  if (snapshot === null) {
    return { items: [], voice };
  }

  return { items: file === null ? [] : windowRows(snapshot, file, windows, now).map((row) => paneItem(row, here.status)), voice };
}

/**
 * The rows, in list order, whose item window is the one opened from `file`. Done rows are left out while the window has a row that is not done, because a
 * later work item of the same ticket, such as a merge after its development, runs in the same worktree and repeats the ticket's pills.
 */
export function windowRows(snapshot: Snapshot, file: string, windows: string, now: number): DockRow[] {
  const rows = dockView(snapshot, now, windows).groups.flatMap((group) =>
    group.rows.filter((row) => row.window?.file != null && normal(row.window.file) === normal(file)).map((row) => ({ row, done: group.key === 'done' })),
  );
  const open = rows.filter((entry) => !entry.done);

  return (open.length === 0 ? rows : open).map((entry) => entry.row);
}

const REVIEWS: Record<NonNullable<PullRequestStatus['review']>, string> = { approved: 'Approved', 'changes-requested': 'Changes requested', pending: 'Review pending' };
const CHECKS: Record<NonNullable<PullRequestStatus['checks']>, string> = { passing: 'Checks passing', failing: 'Checks failing', running: 'Checks running' };
const STATES: Record<PullRequestStatus['state'], string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

/** A pull request pill's tooltip: its label, state, review decision and checks. */
export function pullRequestTitle(label: string, pr: PullRequestStatus | null): string {
  return pr === null ? label : [label, STATES[pr.state], pr.review === null ? null : REVIEWS[pr.review], pr.checks === null ? null : CHECKS[pr.checks]].filter((part) => part !== null).join(' · ');
}

/** A rate-limit wait on line 3, with its reset time (`limitTexts` and the limit queue wait in the hub's rows, architecture.md § Rate limits). */
const RATE_LIMIT = /^(Rate limited · |Starts after the usage limit resets)/;

/** A line 3 detail the pane shows as an alert: a warning or error, or a rate-limit wait, which the dock draws untoned. */
function alert(detail: DockRow['details'][number]): boolean {
  return detail.tone !== null || RATE_LIMIT.test(detail.text);
}

function paneItem(row: DockRow, status: PaneWindow['status']): PaneItem {
  const report = row.commands.find((command) => command.label === 'Open report')?.command['url'];
  const workItemId = Number(/^item:(\d+)$/.exec(row.key)?.[1] ?? NaN);

  return {
    key: row.key,
    sourceKind: row.sourceKind,
    playbook: row.playbook,
    mark: row.mark === null ? null : { glyph: row.mark.glyph, title: row.mark.title },
    stripe: row.stripe,
    links: [
      { text: row.ticket, glyph: null, url: row.url === '' ? null : row.url, kind: 'ticket', mentioned: false, title: row.title, pr: null },
      ...row.links.map((link) => {
        const pr = link.pr ?? null;
        const label = link.mentioned ? `${link.label}: named in the ticket` : link.label;

        return { text: link.badge, glyph: link.glyph, url: link.url, kind: link.kind, mentioned: link.mentioned, title: link.kind === 'pr' ? pullRequestTitle(label, pr) : label, pr };
      }),
    ],
    progress: row.details.filter((detail) => !alert(detail)).map(({ text, title }) => ({ text, title })),
    status: status !== null && status.workItemId === workItemId && status.line !== '' ? status.line : null,
    alerts: row.details.filter(alert).map(({ text, title }) => ({ text, title })),
    report: typeof report === 'string' ? report : null,
    main: row.main === null ? null : { label: row.main, glyph: row.mainGlyph, title: row.mainTitle ?? row.main },
  };
}

/**
 * The terminal command of a row whose main control is Open in terminal (PRD R28): the window command the row has, or with
 * `dock.openTerminal` set to the terminal app, where the row has none, the same command built from the row's terminal. Null otherwise.
 */
export function mainTerminal(row: DockRow): Record<string, unknown> | null {
  return row.main === 'Open in terminal' ? terminalCommand(row) : null;
}

/** The terminal command of a row's session: the window command the row has, or the same command built from its terminal; null without one. */
export function terminalCommand(row: DockRow): Record<string, unknown> | null {
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
