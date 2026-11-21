// What the page hands the diff viewer and gets back (architecture.md § Web page); shared by the page and the viewer's own bundle.

/** The hub's `diff` answer: git's patch from the base to disk and both whole sides, null where the file has none or the hub left it out. */
export interface DiffData {
  path: string;
  from?: string;
  status: string;
  patch: string | null;
  old: string | null;
  new: string | null;
  binary: boolean;
  /** Why the sides or the patch were left out: `sides` when only the patch came, `patch` when nothing did. */
  tooLarge: 'sides' | 'patch' | null;
}

/** The hub's `file` answer: a file read whole, on disk or at the base. */
export interface FileData {
  path: string;
  side: 'disk' | 'base';
  contents: string | null;
  binary: boolean;
  tooLarge: boolean;
}

export interface FileMountOptions {
  wrap: boolean;
  /** The line to scroll to and select, null for the top. */
  line: number | null;
}

export interface DiffMountOptions {
  layout: 'split' | 'stacked';
  wrap: boolean;
  /** A line number was clicked: the old side's or the new side's line. */
  onLine?(side: 'old' | 'new', line: number): void;
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
