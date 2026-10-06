import type { Exec } from '@switchboard/claude';

export interface GitWorktree {
  path: string;
  /** Null for a detached HEAD. */
  branch: string | null;
}

const GIT_TIMEOUT_MS = 15_000;

/** Parses `git worktree list --porcelain`. Paths use forward slashes, as git prints them. An entry git marks `prunable`, such as a deleted directory, is left out. */
export function parseWorktrees(text: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];

  for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];

    if (path !== undefined && !/^prunable\b/m.test(block)) {
      worktrees.push({ path, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null });
    }
  }

  return worktrees;
}

/** The worktrees of the repository that holds `cwd`, or null when git fails there. Read-only. */
export async function listWorktrees(cwd: string, exec: Exec): Promise<GitWorktree[] | null> {
  const result = await exec('git', ['worktree', 'list', '--porcelain'], { cwd, timeoutMs: GIT_TIMEOUT_MS });

  return result.code === 0 ? parseWorktrees(result.stdout) : null;
}

function samePath(a: string, b: string): boolean {
  const normal = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

  return normal(a) === normal(b);
}

/** The worktree a session reported, when `git worktree list` run in that path shows it; else null. */
export async function reportedWorktree(path: string, exec: Exec): Promise<GitWorktree | null> {
  const worktrees = await listWorktrees(path, exec);

  return worktrees?.find((worktree) => samePath(worktree.path, path)) ?? null;
}
