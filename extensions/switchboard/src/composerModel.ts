import type { ItemView } from '@switchboard/hub';

/**
 * The composer's extras (architecture.md § Conversation view): file mentions, slash commands and message history. Decisions only, so the page
 * and the extension share them and Vitest covers them without a DOM or VS Code.
 */

/** A slash command the session offers, as the hub's `commands` lists it. */
export interface CommandItem {
  name: string;
  description: string;
}

/** A file or folder the picker offers, relative to the session's folder with forward slashes; a folder ends with a slash. */
export interface FileItem {
  path: string;
  dir: boolean;
}

/** Folders and files the picker never lists, as Claude Code's panel leaves them out when it lists with VS Code (its `findFiles` fallback). */
export const PICKER_EXCLUDES = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.nuxt/**', '**/.DS_Store', '**/Thumbs.db', '**/*.log', '**/.env', '**/.env.*'];
/** The most files and folders the picker shows. */
export const PICKER_ITEMS = 50;

/** A path with forward slashes and no trailing slash, for comparing. */
function slashed(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * A path as a mention names it: relative to the session's folder when inside it, with forward slashes, and absolute otherwise. Windows paths
 * compare without case.
 */
export function relativeTo(path: string, cwd: string | null): string {
  const target = slashed(path);

  if (cwd === null || cwd === '') {
    return target;
  }

  const base = slashed(cwd);
  const windows = /^[A-Za-z]:\//.test(base) || /^\/\//.test(base);
  const same = windows ? target.toLowerCase().startsWith(`${base.toLowerCase()}/`) : target.startsWith(`${base}/`);

  return same ? target.slice(base.length + 1) : target;
}

/** The local path a dropped `file:` or `vscode-remote:` URI names, or null for any other; a drive letter loses its leading slash. */
export function pathOfUri(uri: string): string | null {
  const text = uri.trim();
  let path: string;

  if (text.startsWith('file://')) {
    path = text.slice('file://'.length);
    // A UNC path keeps its host.
    path = path.startsWith('/') ? path : `//${path}`;
  } else if (text.startsWith('vscode-remote://')) {
    const slash = text.indexOf('/', 'vscode-remote://'.length);

    if (slash === -1) {
      return null;
    }

    path = text.slice(slash);
  } else {
    return null;
  }

  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }

  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

/**
 * The mention of a path, as Claude Code's panel writes it: `@path`, or `@"path"` when the path has a space or a colon or ends in anything but a
 * letter, digit, underscore or slash. Null for a path with a double quote or a line break, which no mention can name.
 */
export function mentionOf(path: string): string | null {
  if (path === '' || /["\r\n]/.test(path)) {
    return null;
  }

  const bare = !/[\s:]/.test(path) && /\w$/.test(path.replace(/\/+$/, ''));

  return bare ? `@${path}` : `@"${path}"`;
}

/** The file query the text before the caret ends with: `@` and what follows it up to the caret, at the start or after a space; null for none. */
export function mentionQuery(before: string): { start: number; query: string } | null {
  const match = /(^|\s)@("[^"\n]*|[^\s"]*)$/.exec(before);

  if (match === null) {
    return null;
  }

  return { start: match.index + match[1]!.length, query: match[2]!.replace(/^"/, '') };
}

/** The command query when the box's text up to the caret is a slash and one word: what follows the slash; null otherwise. */
export function commandQuery(before: string): string | null {
  return /^\/([^\s/]*)$/.exec(before)?.[1] ?? null;
}

/** The commands whose name holds the query, without case: those that start with it first, each group in the list's order. */
export function matchCommands(commands: readonly CommandItem[], query: string): CommandItem[] {
  const want = query.toLowerCase();
  const starts = commands.filter((command) => command.name.toLowerCase().startsWith(want));
  const holds = commands.filter((command) => !command.name.toLowerCase().startsWith(want) && command.name.toLowerCase().includes(want));

  return [...starts, ...holds];
}

/**
 * The glob a file query searches with, as Claude Code's panel builds it: any path that holds the query, its letters in either case, and the
 * files under a folder that does, so a query with a slash finds the files below it. A comma, which would split the braces, matches any character.
 */
export function fileGlob(query: string): string {
  const text = query.trim();

  if (text === '') {
    return '**/*';
  }

  const pattern = [...text].map((char) => (/[a-zA-Z]/.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : char === ',' ? '?' : /[*?{}[\]!]/.test(char) ? `[${char}]` : char)).join('');

  return `{**/*${pattern}*,**/*${pattern}*/**}`;
}

/**
 * The picker's list from the files found: each file and the folders above it, those that hold the query, ranked as a name that starts with it,
 * a name that holds it, then a path that holds it, shorter paths first; at most `PICKER_ITEMS`.
 */
export function rankFiles(files: readonly string[], query: string): FileItem[] {
  const want = query.toLowerCase().replace(/\\/g, '/');
  const items = new Map<string, FileItem>();

  for (const file of files) {
    const path = file.replace(/\\/g, '/');

    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
      const dir = `${path.slice(0, slash)}/`;

      if (dir.toLowerCase().includes(want)) {
        items.set(dir, { path: dir, dir: true });
      }
    }

    if (path.toLowerCase().includes(want)) {
      items.set(path, { path, dir: false });
    }
  }

  const rank = (item: FileItem): number => {
    const name = item.path.replace(/\/$/, '').split('/').pop()!.toLowerCase();

    return name.startsWith(want) ? 0 : name.includes(want) ? 1 : 2;
  };

  return [...items.values()].sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || a.path.localeCompare(b.path)).slice(0, PICKER_ITEMS);
}

/** The most patterns one setting's braces expand to. */
const MAX_EXPANDED = 64;

// A pattern's brace groups expanded into the patterns they stand for, innermost first, `**/{a,b}/**` into `**/a/**` and `**/b/**`; null for
// unbalanced braces or too many. (A line comment, since a glob would end a block comment.)
function expandBraces(pattern: string): string[] | null {
  const group = /\{([^{}]*)\}/.exec(pattern);

  if (group === null) {
    return /[{},]/.test(pattern) ? null : [pattern];
  }

  const out: string[] = [];

  for (const choice of group[1]!.split(',')) {
    const expanded = expandBraces(pattern.slice(0, group.index) + choice + pattern.slice(group.index + group[0].length));

    if (expanded === null || out.length + expanded.length > MAX_EXPANDED) {
      return null;
    }

    out.push(...expanded);
  }

  return out;
}

/**
 * The exclude glob for VS Code's `findFiles`: the picker's own list and the settings' patterns that are on, as one brace pattern, a setting's own
 * braces expanded, since the list's braces cannot hold them. A pattern with unbalanced braces, or a `when` clause, is left out.
 */
export function excludeGlob(...settings: Array<Record<string, unknown> | undefined>): string {
  const patterns = new Set(PICKER_EXCLUDES);

  for (const setting of settings) {
    for (const [pattern, on] of Object.entries(setting ?? {})) {
      for (const one of on === true ? (expandBraces(pattern) ?? []) : []) {
        patterns.add(one);
      }
    }
  }

  return `{${[...patterns].join(',')}}`;
}

/** The messages Up and Down walk: the session's messages the view holds, oldest first, the same text twice in a row once. */
export function messageHistory(items: readonly ItemView[]): string[] {
  const texts: string[] = [];

  for (const item of items) {
    if (item.type === 'message' && !item.withdrawn && item.text.trim() !== '' && texts.at(-1) !== item.text) {
      texts.push(item.text);
    }
  }

  return texts;
}

/** Whether the text still starts with the chosen command, `/name` and then a space or the end, on one line, so it goes as a command. */
export function sendsAsCommand(text: string, chosen: string | null): boolean {
  if (chosen === null || text.includes('\n')) {
    return false;
  }

  const start = `/${chosen}`;
  const trimmed = text.trim();

  return trimmed === start || trimmed.startsWith(`${start} `);
}
