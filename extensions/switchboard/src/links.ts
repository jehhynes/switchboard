import { isAbsolute, join } from 'node:path';

/** Whether this VS Code accepts views in the secondary side bar: 1.106 and later, as Claude Code's extension decides. */
export function supportsSecondarySidebar(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);

  return major > 1 || (major === 1 && minor >= 106);
}

/** The path of a `file:` URL, still percent-encoded: `file:///D:/a.ts` and `file:/D:/a.ts` give `D:/a.ts`, `file://host/share/a.ts` a UNC path. */
function filePath(href: string): string {
  const rest = href.slice('file:'.length);
  const local = rest.startsWith('//') ? rest.replace(/^\/\/(localhost)?(?=\/)/i, '') : rest;

  if (local.startsWith('//')) {
    return local;
  }

  return /^\/[a-z](:|%3a)/i.test(local) ? local.slice(1) : local;
}

/**
 * A link in a reply: a web page, or a file and line, such as `./src/a.ts#L42` relative to the session's folder, `D:/x/a.ts` or
 * `file:///D:/x/a.ts#L3`; null for anything else.
 */
export function linkTarget(href: string, cwd: string | null): { url: string } | { file: string; line: number | null } | null {
  if (/^https?:\/\//i.test(href)) {
    return { url: href };
  }

  const local = /^file:/i.test(href) ? filePath(href) : href;

  if (/^[a-z][a-z0-9+.-]*:(?![\\/])/i.test(local) && !/^[a-z]:[\\/]/i.test(local)) {
    return null;
  }

  // The fragment is split off first, so an encoded `#` (`%23`) stays in the path.
  const match = /^([^#]*)(?:#L(\d+)(?:-L?\d+)?)?$/.exec(local);
  let path = match?.[1] ?? '';

  try {
    path = decodeURIComponent(path);
  } catch {
    // A stray `%` is part of the name.
  }

  if (path === '' || (cwd === null && !isAbsolute(path))) {
    return null;
  }

  return { file: isAbsolute(path) ? path : join(cwd!, path), line: match?.[2] === undefined ? null : Number(match[2]) };
}
