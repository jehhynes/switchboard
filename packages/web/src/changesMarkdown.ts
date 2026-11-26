// A Markdown file in the Changes tab's file view (architecture.md § Web page, Changes): its links and pictures resolve to files of the worktree
// and are read only through the Changes routes, `file` and `file-raw`; any other target is text that says why, never a local file tab's link.
import { linkTarget } from './localLinks.js';
import { escape, renderMarkdown } from './markdown.js';
import type { LinkAnswer } from './markdown.js';

/**
 * Where a Markdown file's link or picture lies, by the worktree's paths, resolved against the file's own folder; null for a target outside the
 * worktree, an absolute path or a `file:` URI, which the Changes tab never reads.
 */
export function worktreeTarget(file: string, href: string): { path: string; line: number | null } | null {
  const target = linkTarget(href);

  if (target === null || /^[a-z][a-z0-9+.-]*:/i.test(href) || /^[a-z]:[\\/]/i.test(target.path) || target.path.startsWith('/') || target.path.startsWith('\\')) {
    return null;
  }

  const parts = file.split('/').slice(0, -1);

  for (const part of target.path.replaceAll('\\', '/').split('/')) {
    if (part === '..') {
      if (parts.length === 0) {
        return null;
      }

      parts.pop();
    } else if (part !== '.' && part !== '') {
      parts.push(part);
    }
  }

  return parts.length === 0 ? null : { path: parts.join('/'), line: target.line };
}

/** Why a Markdown link in the Changes tab's file view does not open. */
export const LINK_REFUSED = 'Only files of this worktree open from the Changes tab.';

/**
 * A worktree file's Markdown as HTML: a link to a file of the worktree opens it in the file view (`data-action="changes-file"`), at the line it
 * names; a picture's source is `raw(path)`; any other target is denied text.
 */
export function worktreeMarkdown(file: string, text: string, raw: (path: string) => string): string {
  const link = (href: string): LinkAnswer => {
    const target = worktreeTarget(file, href);

    return target === null ? { denied: LINK_REFUSED } : `class="path-link" title="${escape(target.path)}" tabindex="0" role="link" data-action="changes-file" data-path="${escape(target.path)}"${target.line === null ? '' : ` data-line="${target.line}"`}`;
  };
  const picture = (src: string): string | null => {
    const target = worktreeTarget(file, src);

    return target === null ? null : raw(target.path);
  };

  return renderMarkdown(text, picture, link);
}
