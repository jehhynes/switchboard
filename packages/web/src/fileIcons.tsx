// File type icons (architecture.md § Web page): VS Code's Seti file icon theme, its font and mapping copied by gen-seti.mjs, picked for a file name as
// VS Code picks it. The mapping and the font load the first time an icon is asked for; until then, and when they cannot load, a file shows the
// generic file codicon. Any list of files on the page draws its icons with `FileIcon` or `fileIconClass`.
import type { VNode } from 'preact';

/** The mapping gen-seti.mjs writes to src/seti/file-icons.json, which the hub serves as /page/file-icons.json. */
export interface FileIconMap {
  source: string;
  /** The icon of a file nothing else matches. */
  file: number;
  /** Icons by lower-case file name, file extension (without its dot) and VS Code language ID. */
  fileNames: Record<string, number>;
  fileExtensions: Record<string, number>;
  languageIds: Record<string, number>;
  /** The languages VS Code's built-in extensions register: by lower-case file name, by file name ending, and by lower-case glob, in registration order. */
  languages: { names: Record<string, string>; extensions: Record<string, string>; patterns: Array<[string, string]> };
  /** Each icon as its font character and its colours in the dark and the light theme. */
  icons: Array<[string, string, string]>;
}

/** A glob of a language's `filenamePatterns` as a regular expression: `**` crosses folders, `*` and `?` do not. */
function globExpression(glob: string): RegExp {
  let out = '';

  for (let at = 0; at < glob.length; at++) {
    const char = glob[at]!;

    if (glob.startsWith('**/', at)) {
      out += '(?:.*/)?';
      at += 2;
    } else if (glob.startsWith('**', at)) {
      out += '.*';
      at += 1;
    } else if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(`^${out}$`);
}

const globs = new Map<string, RegExp>();

/**
 * The language VS Code gives a file by its path alone: an exact file name, else the longest matching glob (matched against the path when it has a
 * slash, else the name), else the longest matching name ending; a later registration wins a tie. Null when none matches.
 */
export function languageOf(map: FileIconMap, path: string): string | null {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  const named = map.languages.names[name];

  if (named !== undefined) {
    return named;
  }

  let pattern: [string, string] | null = null;

  for (let at = map.languages.patterns.length - 1; at >= 0; at--) {
    const entry = map.languages.patterns[at]!;

    if (pattern === null || entry[0].length > pattern[0].length) {
      let expression = globs.get(entry[0]);

      if (expression === undefined) {
        expression = globExpression(entry[0]);
        globs.set(entry[0], expression);
      }

      if (expression.test(entry[0].includes('/') ? lower : name)) {
        pattern = entry;
      }
    }
  }

  if (pattern !== null) {
    return pattern[1];
  }

  let ending: string | null = null;

  for (const key of Object.keys(map.languages.extensions)) {
    if ((ending === null || key.length > ending.length) && name.endsWith(key)) {
      ending = key;
    }
  }

  return ending === null ? null : map.languages.extensions[ending]!;
}

/**
 * The icon VS Code's Seti theme gives a file, by the theme's rules in the order VS Code's CSS ranks them: the lower-case file name, else the
 * longest of its dot-separated endings (`test.ts`, then `ts`; `.gitignore` has `gitignore`), else its language, else the theme's file icon.
 */
export function iconOf(map: FileIconMap, path: string): number {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const named = map.fileNames[name];

  if (named !== undefined) {
    return named;
  }

  const parts = name.split('.');

  for (let at = 1; at < parts.length; at++) {
    const icon = map.fileExtensions[parts.slice(at).join('.')];

    if (icon !== undefined) {
      return icon;
    }
  }

  const language = languageOf(map, path);
  const icon = language === null ? undefined : map.languageIds[language];

  return icon ?? map.file;
}

/** The style sheet that draws each icon: the Seti font, and each icon's character in its dark colour, and in its light one while the system is light. */
export function iconStyles(map: FileIconMap, font: string): string {
  const escape = (char: string): string => `\\${char.codePointAt(0)!.toString(16)}`;
  const dark = map.icons.map(([char, color], at) => `.seti-${at}::before{content:'${escape(char)}';color:${color}}`);
  const light = map.icons.map(([, , color], at) => `.seti-${at}::before{color:${color}}`);

  return `@font-face{font-family:seti;src:url('${font}') format('woff');font-display:block}${dark.join('')}@media (prefers-color-scheme: light){${light.join('')}}`;
}

interface Loader {
  fetch: typeof fetch;
  /** Called once the mapping is in, to draw the icons. */
  loaded(): void;
}

let loader: Loader | null = null;
let map: FileIconMap | null = null;
let loading = false;
const cache = new Map<string, string>();

/**
 * Sets how the mapping loads and what draws once it has; the page calls it at start. Nothing loads until an icon is asked for. Answers a function
 * that drops this loader, for a page that closes.
 */
export function useFileIcons(next: Loader): () => void {
  loader = next;
  return () => {
    if (loader === next) {
      loader = null;
    }
  };
}

/** Forgets the mapping and the loader, for tests. */
export function resetFileIcons(): void {
  loader = null;
  map = null;
  loading = false;
  cache.clear();
  document.querySelectorAll('style[data-file-icons]').forEach((style) => style.remove());
}

/** Whether a body read as JSON is a mapping this page can use. */
function isMap(body: unknown): body is FileIconMap {
  const map = body as Partial<FileIconMap> | null;

  return typeof map === 'object' && map !== null && typeof map.file === 'number' && Array.isArray(map.icons) && typeof map.fileNames === 'object' && typeof map.fileExtensions === 'object' && typeof map.languageIds === 'object' && typeof map.languages === 'object';
}

async function load(from: Loader): Promise<void> {
  const style = document.createElement('style');

  try {
    const response = await from.fetch('/page/file-icons.json', { credentials: 'same-origin' });
    const body: unknown = response.ok ? await response.json() : null;

    if (!isMap(body)) {
      return;
    }

    style.dataset['fileIcons'] = '';
    style.textContent = iconStyles(body, '/page/seti.woff');
    document.head.append(style);

    // The font loads before any icon shows, so a font that does not load leaves the file codicon rather than missing characters.
    const fonts = (document as { fonts?: FontFaceSet }).fonts;

    if (fonts !== undefined && (await fonts.load('16px seti', body.icons[body.file]![0])).length === 0) {
      throw new Error('The Seti font did not load.');
    }

    // A page that closed meanwhile gets nothing; the next page to ask loads again.
    if (loader !== from) {
      loading = false;
      style.remove();
      return;
    }

    map = body;
    from.loaded();
  } catch {
    // The generic icon stays.
    style.remove();
  }
}

/**
 * The classes of a file's icon element, `file-icon seti-<n>`, or null before the mapping has loaded or when it cannot, when the element should
 * be the file codicon; the first call starts the load.
 */
export function fileIconClass(path: string): string | null {
  if (map === null) {
    if (!loading && loader !== null) {
      loading = true;
      void load(loader);
    }

    return null;
  }

  let classes = cache.get(path);

  if (classes === undefined) {
    classes = `file-icon seti-${iconOf(map, path)}`;
    cache.set(path, classes);
  }

  return classes;
}

/** A file's type icon by its path or name, as VS Code's Explorer draws it. */
export function FileIcon({ path }: { path: string }): VNode {
  return <span class={fileIconClass(path) ?? 'codicon codicon-file'} aria-hidden="true"></span>;
}
