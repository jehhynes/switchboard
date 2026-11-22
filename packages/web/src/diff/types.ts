// What the page hands the diff viewer and gets back (architecture.md § Web page); shared by the page and the viewer's own bundle.

import type { DiffData, FileData } from '@switchboard/protocol';

export type { DiffData, FileData } from '@switchboard/protocol';

export interface FileMountOptions {
  wrap: boolean;
  /** The line to scroll to and select, null for the top. */
  line: number | null;
  /** What the file's header shows before its name and after it. */
  prefix?: HTMLElement;
  suffix?: HTMLElement;
}

export interface DiffMountOptions {
  layout: 'split' | 'stacked';
  wrap: boolean;
  /** A line number was clicked: the old side's or the new side's line. */
  onLine?(side: 'old' | 'new', line: number): void;
  /** What the file's header shows after its counts. */
  meta?: HTMLElement;
}

export interface DiffMount {
  set(layout: 'split' | 'stacked', wrap: boolean): void;
  dispose(): void;
}

/** What the Changes tab's viewer knows of a row before its diff is read: enough for its header and a placeholder of about its height. */
export interface ChangesRowInput {
  path: string;
  from?: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

/** A row's content in the Changes tab: its diff as read, a note in its place (binary, too large, a refusal), or a placeholder while unread. */
export type RowContent = { data: DiffData } | { note: string } | null;

export interface ChangesMountOptions {
  layout: 'split' | 'stacked';
  wrap: boolean;
  /** Reads a file's diff with both sides, when an unchanged region of its patch-only diff is expanded; null when it cannot be read. */
  loadSides(path: string): Promise<DiffData | null>;
  /** A line number was clicked in a file's diff: the old side's or the new side's line. */
  onLine?(path: string, side: 'old' | 'new', line: number): void;
  /** What a file's own header shows after its counts, and before its name. */
  headerMeta?(path: string): HTMLElement | null;
  headerPrefix?(path: string): HTMLElement | null;
  /** A file's own header was clicked, away from the page's controls in it. */
  onHeader?(path: string): void;
}

export interface ChangesMount {
  /** Replaces the rows, in order: a path kept keeps its content, a new one starts as a placeholder. */
  setRows(rows: ChangesRowInput[]): void;
  /** Shows a row's diff, a note, or a placeholder (null), of `lines` lines when given, else of its estimated height. */
  setRow(path: string, content: RowContent, lines?: number): void;
  setCollapsed(path: string, collapsed: boolean): void;
  scrollToFile(path: string): void;
  /** The row whose header is at the top of the view, or null for none. */
  current(): string | null;
  /** The indexes of the first and last rows that meet the view, no taller than the window; null with no rows or while the view has no height. */
  visible(): { first: number; last: number } | null;
  /** Calls `listener` once a frame at most while the view scrolls or resizes. */
  onWant(listener: () => void): void;
  /** A row's drawn height in pixels, or undefined when it is not a row. */
  heightOf(path: string): number | undefined;
  /** Where each hunk of a row's drawn diff starts: its first line on the new side, or on the old side for a hunk that only deletes; none while it has no diff. */
  hunkStarts(path: string): Array<{ line: number; side: 'additions' | 'deletions' }>;
  /** The first line of a row's diff showing under the sticky header, on the new side unless it is a deleted line; null when none shows. */
  topLine(path: string): number | null;
  /** Brings a row's line to the top of the view, under the sticky header. */
  scrollToLine(path: string, line: number, side: 'additions' | 'deletions'): void;
  /** How many diff lines `pixels` of a row's height holds, for a placeholder that keeps that height. */
  linesFor(pixels: number): number;
  set(layout: 'split' | 'stacked', wrap: boolean): void;
  dispose(): void;
}

/** What `diff.js` exports. */
export interface DiffModule {
  mountDiff(host: HTMLElement, data: DiffData, version: string, options: DiffMountOptions): DiffMount | null;
  mountFile(host: HTMLElement, data: FileData, version: string, options: FileMountOptions): DiffMount;
  mountChanges(host: HTMLElement, rows: ChangesRowInput[], options: ChangesMountOptions): ChangesMount;
}
