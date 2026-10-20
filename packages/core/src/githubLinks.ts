import type { SourceLink } from './source.js';

const GITHUB_URL = /https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)(?![\w-])/g;

/**
 * Each distinct GitHub issue or pull request URL in the texts, in order of first appearance, as `Issue #n` or `Pull request #n` (PRD R61).
 * A URL is cut to the issue or pull request, with owner and repository lowercased as GitHub ignores their case, so variants are one link.
 */
export function githubLinks(texts: readonly string[]): SourceLink[] {
  const links = new Map<string, SourceLink>();

  for (const text of texts) {
    for (const [, owner, repo, kind, number] of text.matchAll(GITHUB_URL)) {
      const target = `https://github.com/${owner!.toLowerCase()}/${repo!.toLowerCase()}/${kind}/${number}`;

      if (!links.has(target)) {
        links.set(target, { label: `${kind === 'pull' ? 'Pull request' : 'Issue'} #${number}`, target, mentioned: true });
      }
    }
  }

  return [...links.values()];
}
