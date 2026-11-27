// Local file links (architecture.md § Web page): reading a link's target and line, the hub's routes for a local file, and a local Markdown
// file drawn as HTML, its relative links and pictures resolved against its own folder.
import { escape, markdownBody, renderMarkdown } from './markdown.js';

/** What the hub answers for a local file or folder (`LocalFileView` in packages/hub/src/localFiles.ts). */
export interface LocalFileData {
  path: string;
  name: string;
  kind: 'text' | 'markdown' | 'image' | 'pdf' | 'audio' | 'video' | 'binary' | 'dir';
  contents: string | null;
  tooLarge: boolean;
  size: number | null;
  entries: Array<{ name: string; dir: boolean }> | null;
  more: boolean;
  /** The file's modification time, which a picture's or PDF's address carries so a new version loads again; null or absent for a folder. */
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

/** A target as written, from markdown-it's attribute: its escaping undone and its percent-encoding decoded, or kept when malformed. */
export function decodedTarget(text: string): string {
  const plain = text.replace(/&(amp|quot|lt|gt|#39);/g, (_match, name: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" })[name]!);

  try {
    return decodeURIComponent(plain);
  } catch {
    return plain;
  }
}

/** A link's attributes that open its target, as `linkTarget` reads it, in a file tab of the page (`LocalFilesController`). */
export function fileTabLink(target: string): string {
  return `class="path-link" title="${escape(target)}" tabindex="0" role="link" data-action="local-file" data-target="${escape(target)}"`;
}

/** A segment of a name the artifact route serves, as `ARTIFACT_SEGMENT` in packages/conversation/src/artifacts.ts reads it. */
const SERVED = /^(?!(?:con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(?:\.|$))[^./\\:\x00-\x1f](?:[^/\\:\x00-\x1f]*[^/\\:\x00-\x1f. ])?$/i;

/**
 * Where a Markdown artifact's picture or link lies (architecture.md § Artifacts): `name`, for the artifact route, when it is in the artifact
 * folder, or, for an external artifact (`@<id>/<file>`), a file under the folder its file is in; otherwise `path`,
 * its absolute path, read as a local file under that route's rules, resolved against the artifact's own folder (`artifactsDir`, or an external
 * artifact's `file`). `target` is decoded once, a `file:` URI too, and has no fragment. Null when the folder is unknown or the target is another scheme.
 * A link (`link`) in an external artifact takes the route only to the artifact itself, so a link to another file beside it opens a file tab,
 * at its line, or that file's own artifact tab when it is one.
 */
export function artifactTarget(artifact: { path: string; file?: string }, artifactsDir: string | null, target: string, link = false): { name: string } | { path: string } | null {
  if (/^file:/i.test(target)) {
    return { path: fileUriPath(target) };
  }

  if (/^[a-z]:[\\/]/i.test(target) || target.startsWith('/') || target.startsWith('\\')) {
    return { path: target.replaceAll('\\', '/') };
  }

  if (absolute(target)) {
    return null;
  }

  const relative = target.replaceAll('\\', '/');
  const first = artifact.path.split('/')[0] ?? '';
  const external = first.startsWith('@');
  const parts = external ? [] : artifact.path.split('/').slice(0, -1);
  let outside = false;

  for (const part of relative.split('/')) {
    if (part === '..') {
      outside ||= parts.length === 0;
      parts.pop();
    } else if (part !== '.' && part !== '') {
      parts.push(part);
    }
  }

  const served = !outside && parts.every((part) => SERVED.test(part));

  if (external) {
    const name = `${first}/${parts.join('/')}`;

    if (served && parts.length > 0 && (!link || name === artifact.path)) {
      return { name };
    }

    return artifact.file === undefined ? null : { path: joinPath(artifact.file.replaceAll('\\', '/').replace(/\/[^/]*$/, ''), relative) };
  }

  if (served && parts.length > 1) {
    return { name: parts.join('/') };
  }

  return artifactsDir === null ? null : { path: joinPath(artifactsDir.replaceAll('\\', '/').replace(/\/$/, ''), `${artifact.path.split('/').slice(0, -1).join('/')}/${relative}`) };
}

/**
 * Shows the note in place of a Markdown picture (`picture` in markdown.ts) that does not load, as when the hub refuses it or the page's CSP
 * blocks it, and the picture again once a later source loads. It marks the frame by class, which Preact's redraws leave alone, as they only
 * set what the drawn markup changes.
 */
export function watchPictures(root: HTMLElement, signal: AbortSignal): void {
  const mark = (broken: boolean) => (event: Event): void => {
    const target = event.target;

    if (target instanceof HTMLImageElement && target.hasAttribute('data-picture')) {
      target.parentElement?.classList.toggle('broken', broken);
    }
  };

  // Neither event bubbles, so both are caught on the way down.
  root.addEventListener('error', mark(true), { capture: true, signal });
  root.addEventListener('load', mark(false), { capture: true, signal });
}

/** A Markdown file as the page draws an artifact: its relative pictures from its folder and its relative links opening in file tabs. */
export function localMarkdown(key: string, data: LocalFileData): string {
  const dir = data.path.slice(0, data.path.lastIndexOf('/'));
  const decoded = decodedTarget;
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

    return fileTabLink(target);
  };

  return renderMarkdown(markdownBody(data.contents ?? ''), base, link);
}

