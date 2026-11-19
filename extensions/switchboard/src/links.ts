import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

/**
 * A status's Markdown for the Markdown preview, which reads it from a `switchboard-status:` document and would resolve a relative link against
 * that URI: each inline link to a path with no scheme, relative to the session's folder or absolute, becomes a `file:` URL, keeping its line
 * fragment. Links inside fenced code, web links and links with no folder to resolve against are left as written.
 */
export function previewLinks(markdown: string, cwd: string | null): string {
  let fence: string | null = null;

  return markdown
    .split('\n')
    .map((line) => {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);

      if (open !== null) {
        fence = fence === null ? open[1]! : open[1]![0] === fence[0] && open[1]!.length >= fence.length ? null : fence;
        return line;
      }

      if (fence !== null) {
        return line;
      }

      return line.replace(/\]\((<[^>]*>|[^)\s]+)\)/g, (whole, raw: string) => {
        const href = raw.startsWith('<') ? raw.slice(1, -1) : raw;

        if (href === '' || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:(?![\\/])/i.test(href)) {
          return whole;
        }

        const target = linkTarget(href, cwd);

        if (target === null || !('file' in target)) {
          return whole;
        }

        return `](${pathToFileURL(target.file).href}${target.line === null ? '' : `#L${target.line}`})`;
      });
    })
    .join('\n');
}
