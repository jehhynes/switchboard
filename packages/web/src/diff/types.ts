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

/** What `diff.js` exports. */
export interface DiffModule {
  mountDiff(host: HTMLElement, data: DiffData, version: string, options: DiffMountOptions): DiffMount | null;
  mountFile(host: HTMLElement, data: FileData, version: string, options: FileMountOptions): DiffMount;
}
