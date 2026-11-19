import { isAbsolute, join } from 'node:path';

/** Whether this VS Code accepts views in the secondary side bar: 1.106 and later, as Claude Code's extension decides. */
export function supportsSecondarySidebar(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);

  return major > 1 || (major === 1 && minor >= 106);
}

/** A link in a reply: a web page, or a file and line relative to the session's folder, such as `./src/a.ts#L42`; null for anything else. */
export function linkTarget(href: string, cwd: string | null): { url: string } | { file: string; line: number | null } | null {
  if (/^https?:\/\//i.test(href)) {
    return { url: href };
  }

  if (/^[a-z][a-z0-9+.-]*:(?![\\/])/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) {
    return null;
  }

  const match = /^([^#]*)(?:#L(\d+)(?:-L?\d+)?)?$/.exec(decodeURI(href));
  const path = match?.[1] ?? '';

  if (path === '' || (cwd === null && !isAbsolute(path))) {
    return null;
  }

  return { file: isAbsolute(path) ? path : join(cwd!, path), line: match?.[2] === undefined ? null : Number(match[2]) };
}
