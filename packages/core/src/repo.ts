import type { Ticket } from './model.js';
import type { Settings, SourceSettings } from './settings.js';

/** Compares repo paths as Windows does: either separator, any case, no trailing separator. */
export function samePath(a: string, b: string): boolean {
  const key = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

  return key(a) === key(b);
}

/** A source's home repository, `owner/name` in lowercase, from its `repo` setting: the one plugin key core reads. Empty when it has none. */
export function homeRepo(source: SourceSettings | undefined): string {
  const repo = source?.options['repo'];

  return typeof repo === 'string' ? repo.toLowerCase() : '';
}

/** A ticket's repository: its own, or its source's home repository when it records none. */
export function repoOf(settings: Settings, ticket: Pick<Ticket, 'source' | 'repo'>): string {
  return ticket.repo || homeRepo(settings.sources[ticket.source]);
}

/** Whether a source's `repoRoot` is a pattern, which `{name}` makes it. */
export function isRootPattern(repoRoot: string): boolean {
  return repoRoot.includes('{name}');
}

function fill(pattern: string, repo: string): string {
  const [owner = '', name = ''] = repo.split('/');

  return pattern.replace('{owner}', owner).replace('{name}', name);
}

export type RootResult = { root: string } | { error: string };

/**
 * A ticket's repo root (PRD R16, R21): its own `repoRoot` when it has one, as an ad-hoc, schedule or reported ticket does; else its source's
 * `repoRoot` with `{owner}` and `{name}` replaced by the ticket's repository; else, for a root without `{name}`, that root for the home
 * repository only. `stored` lists the repositories with tickets in the source: two that resolve to one root are refused, so neither runs in
 * the other's clone.
 */
export function ticketRoot(settings: Settings, ticket: Pick<Ticket, 'source' | 'repo' | 'repoRoot'>, stored: readonly string[] = []): RootResult {
  if (ticket.repoRoot !== '') {
    return { root: ticket.repoRoot };
  }

  const source = settings.sources[ticket.source];
  const path = `sources.${ticket.source}.repoRoot`;

  if (source === undefined || source.repoRoot === '') {
    return { error: `${path} is not set.` };
  }

  const home = homeRepo(source);
  const repo = ticket.repo || home;

  if (!isRootPattern(source.repoRoot)) {
    return repo === home ? { root: source.repoRoot } : { error: `${path} has no {name}, so ${repo} has no repo root.` };
  }

  if (repo === '') {
    return { error: `${path} names {name}, but the ticket has no repository.` };
  }

  const root = fill(source.repoRoot, repo);
  const other = [...new Set([home, ...stored])].find((entry) => entry !== '' && entry !== repo && samePath(fill(source.repoRoot, entry), root));

  return other === undefined ? { root } : { error: `${repo} and ${other} both resolve to ${root}; add {owner} to ${path}.` };
}

/**
 * The repos an ad-hoc prompt or a task report can run in (PRD R6, R68), the first being the default: each source's root for its home
 * repository, then the roots of the other repositories with stored tickets, so a repository stays listed after its work closes. A pattern is
 * never listed, and a root two repositories share is left out.
 */
export function repoRoots(settings: Settings, stored: Readonly<Record<string, readonly string[]>> = {}): string[] {
  const roots: string[] = [];

  for (const [name, source] of Object.entries(settings.sources)) {
    const repos = stored[name] ?? [];

    for (const repo of isRootPattern(source.repoRoot) ? [homeRepo(source), ...repos] : ['']) {
      const result = ticketRoot(settings, { source: name, repo, repoRoot: '' }, repos);

      if ('root' in result && !roots.some((root) => samePath(root, result.root))) {
        roots.push(result.root);
      }
    }
  }

  return roots;
}
