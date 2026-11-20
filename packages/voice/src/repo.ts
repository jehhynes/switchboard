/**
 * A repository's `owner/name`, lower case, from an https, ssh:// or scp-style (`git@host:owner/repo`) remote URL, which picks its fixed terms
 * (claude-collab `repo.js`); null for a local path or anything else. A worktree shares its repository's remote.
 */
export function parseRemote(url: string): string | null {
  const text = url.trim();

  if (!/^(?:[a-z][a-z0-9+.-]*:\/\/|[^@/\s]+@[^:/\s]+:)/i.test(text)) {
    return null;
  }

  const match = /[:/]([^/:]+)\/([^/:]+)$/.exec(text.replace(/\/+$/, '').replace(/\.git$/i, ''));

  return match === null ? null : `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
}
