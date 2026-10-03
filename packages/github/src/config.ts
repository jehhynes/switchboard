export interface GithubConfig {
  ghPath: string;
  /** `owner/name`. */
  repo: string;
  logins: string[];
  project: { owner: string; number: number; statusField: string };
  assignedStatuses: string[];
  /** Its first group is the issue number a worktree branch names. */
  branchPattern: RegExp;
  maxPages: number;
}

export type ConfigResult = { config: GithubConfig } | { error: string };

const KEYS = ['ghPath', 'repo', 'logins', 'project', 'assignedStatuses', 'branchPattern', 'maxPages'];

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry !== '') ? (value as string[]) : null;
}

/** Reads the GitHub keys of `sources.github`. The source refuses to poll until repo, logins, project and statuses are set. */
export function parseGithubConfig(options: Record<string, unknown>): ConfigResult {
  const unknown = Object.keys(options).filter((key) => !KEYS.includes(key));

  if (unknown.length > 0) {
    return { error: `sources.github.${unknown[0]} is not a setting.` };
  }

  const { ghPath = 'gh', repo, logins, project, assignedStatuses, branchPattern = '^(\\d+)-', maxPages = 5 } = options;

  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { error: 'sources.github.repo must be set to owner/name.' };
  }

  const loginList = strings(logins);

  if (loginList === null || loginList.length === 0) {
    return { error: 'sources.github.logins must list at least one login.' };
  }

  const p = project as { owner?: unknown; number?: unknown; statusField?: unknown } | undefined;

  if (typeof p?.owner !== 'string' || p.owner === '' || typeof p.number !== 'number' || !Number.isInteger(p.number)) {
    return { error: 'sources.github.project must give owner and number.' };
  }

  const statuses = strings(assignedStatuses);

  if (statuses === null || statuses.length === 0) {
    return { error: 'sources.github.assignedStatuses must list at least one status.' };
  }

  if (typeof ghPath !== 'string' || ghPath === '') {
    return { error: 'sources.github.ghPath must be a path.' };
  }

  if (typeof maxPages !== 'number' || !Number.isInteger(maxPages) || maxPages < 1) {
    return { error: 'sources.github.maxPages must be a whole number of at least 1.' };
  }

  let pattern: RegExp;

  try {
    pattern = new RegExp(String(branchPattern));
  } catch {
    return { error: 'sources.github.branchPattern is not a valid regular expression.' };
  }

  return {
    config: {
      ghPath,
      repo,
      logins: loginList,
      project: { owner: p.owner, number: p.number, statusField: typeof p.statusField === 'string' && p.statusField !== '' ? p.statusField : 'Status' },
      assignedStatuses: statuses,
      branchPattern: pattern,
      maxPages,
    },
  };
}
