// Local file links (architecture.md § Web page): reading a link's target and line, the hub's routes for a local file, and a local Markdown
// file drawn as HTML, its relative links and pictures resolved against its own folder.
import { escape, renderMarkdown } from './markdown.js';

/** What the hub answers for a local file or folder (`LocalFileView` in packages/hub/src/localFiles.ts). */
export interface LocalFileData {
  path: string;
  name: string;
  kind: 'text' | 'markdown' | 'image' | 'pdf' | 'binary' | 'dir';
  contents: string | null;
  tooLarge: boolean;
  size: number | null;
  entries: Array<{ name: string; dir: boolean }> | null;
  more: boolean;
  /** A picture's or PDF's modification time, so a new version loads again; null or absent otherwise. */
  modified?: number | null;
  /** The work item's artifact this file is, by real path: the page shows that artifact's tab in place of a file tab. */
  artifact?: string;
}

/**
 * The path a `file:` URI names, still percent-encoded: `file:///D:/a.ts`, `file:/D:/a.ts` and `file://localhost/D:/a.ts` give `D:/a.ts`,
 * `file:///home/a.ts` gives `/home/a.ts`, and `file://host/share/a.ts` the UNC path `//host/share/a.ts`.
 */
export function fileUriPath(uri: string): string {
  let rest = uri.slice('file:'.length);

  if (rest.startsWith('//')) {
    const slash = rest.indexOf('/', 2);
    const host = rest.slice(2, slash === -1 ? undefined : slash);

    rest = slash === -1 ? '' : rest.slice(slash);

    if (host !== '' && host.toLowerCase() !== 'localhost') {
      return `//${host}${rest}`;
    }
  }

  return /^\/[a-z](?::|%3a)/i.test(rest) ? rest.slice(1) : rest;
}

/**
 * A link's target as the hub reads it, with the line it names: `#L<n>` (or `#L<n>-L<m>`, `#L<n>C<c>`), or `:<n>` after a file name, and
 * the target percent-decoded as markdown-it encoded it, a `file:` URI as the path it names; null for a link to a place in the same text.
 */
export function linkTarget(href: string): { path: string; line: number | null } | null {
  const at = href.indexOf('#');
  const fragment = at === -1 ? '' : href.slice(at + 1);
  let path = at === -1 ? href : href.slice(0, at);

  if (/^file:/i.test(path)) {
    path = fileUriPath(path);
  }

  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape stays as written.
  }

  const named = /^L(\d+)/.exec(fragment);
  let line = named === null ? null : Number(named[1]);
  const suffix = /^(.*?[^/\\:][^/\\:]*):(\d+)(?::\d+)?$/.exec(path);

  if (line === null && suffix !== null && !/^[a-z]$/i.test(suffix[1]!)) {
    path = suffix[1]!;
    line = Number(suffix[2]);
  }

  return path.trim() === '' ? null : { path, line: line !== null && line > 0 ? line : null };
}

/** The hub's view of a local file for a page key, or its bytes for a picture or PDF (`raw`). */
export function localFileUrl(key: string, path: string, raw = false): string {
  return `/v1/conversation/local-file${raw ? '-raw' : ''}?window=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}`;
}

/** Joins a relative link to the folder of the file it is in, with forward slashes; `..` steps out of it as a path does. */
export function joinPath(dir: string, href: string): string {
  const parts = dir.split('/');

  for (const part of href.split('/')) {
    if (part === '..') {
      parts.length > 1 && parts.pop();
    } else if (part !== '.' && part !== '') {
      parts.push(part);
    }
  }

  return parts.join('/');
}

/** Whether a link names a place by itself: a scheme, a drive or an absolute path, not one relative to the file it is in. */
const absolute = (href: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('\\');

/** A Markdown file as the page draws an artifact: its relative pictures from its folder and its relative links opening in file tabs. */
export function localMarkdown(key: string, data: LocalFileData): string {
  const dir = data.path.slice(0, data.path.lastIndexOf('/'));
  // markdown-it gives a target percent-encoded inside an attribute's escaping.
  const decoded = (text: string): string => {
    const plain = text.replace(/&(amp|quot|lt|gt|#39);/g, (_match, name: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" })[name]!);

    try {
      return decodeURIComponent(plain);
    } catch {
      return plain;
    }
  };
  const base = (src: string): string | null => {
    const path = decoded(src.split(/[?#]/)[0]!);

    return localFileUrl(key, absolute(src) ? path : joinPath(dir, path), true);
  };
  const link = (href: string): string | null => {
    if (href.startsWith('#') || absolute(href)) {
      return null;
    }

    const at = href.indexOf('#');
    const target = joinPath(dir, decoded(href.slice(0, at === -1 ? undefined : at))) + (at === -1 ? '' : href.slice(at));

    return `class="path-link" title="${escape(target)}" tabindex="0" role="link" data-action="local-file" data-target="${escape(target)}"`;
  };

  return renderMarkdown(data.contents ?? '', base, link);
}

