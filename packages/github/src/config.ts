import { isAbsolute } from 'node:path';

export interface GithubConfig {
  ghPath: string;
  /** The home repository, `owner/name` in lowercase: its issues keep bare keys, such as `18941` (PRD R44). */
  repo: string;
  /** Short display names of other repositories on the board, by `owner/name` in lowercase, such as `dash` (PRD R27). */
  labels: Record<string, string>;
  logins: string[];
  /** False puts an issue in the assigned state by its project status alone, whoever is assigned. */
  requireAssignee: boolean;
  /** True reads each issue's open blockers, so its work waits until they close (PRD R90). */
  waitForBlockers: boolean;
  /** True puts a closed issue in the assigned state like an open one, for a team that closes issues before merging (PRD R44). */
  includeClosed: boolean;
  project: { owner: string; number: number; statusField: string };
  /** Empty puts an issue in any status, or none, in the assigned state. */
  assignedStatuses: string[];
  /** Its first group is the issue number a worktree branch names. */
  branchPattern: RegExp;
  maxPages: number;
  /** A JSON file of `{login: {roles: string[]}}`, or null. Triage shows each comment author's roles from it. */
  rolesFile: string | null;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

export type ConfigResult = { config: GithubConfig } | { error: string };

const KEYS = ['ghPath', 'repo', 'labels', 'logins', 'requireAssignee', 'waitForBlockers', 'includeClosed', 'project', 'assignedStatuses', 'branchPattern', 'maxPages', 'rolesFile'];

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry !== '') ? (value as string[]) : null;
}

/** Whether an issue's project status puts it in the assigned state: any status, or none, while no status is configured. */
export function inAssignedStatus(config: GithubConfig, status: string | undefined): boolean {
  return config.assignedStatuses.length === 0 || (status !== undefined && config.assignedStatuses.includes(status));
}

/** Reads the GitHub keys of the source `name`. The source refuses to poll until repo, logins and project are set. */
export function parseGithubConfig(options: Record<string, unknown>, name = 'github'): ConfigResult {
  const path = `sources.${name}`;
  const unknown = Object.keys(options).filter((key) => !KEYS.includes(key));

  if (unknown.length > 0) {
    return { error: `${path}.${unknown[0]} is not a setting.` };
  }

  const { ghPath = 'gh', repo, labels = {}, logins, requireAssignee = true, waitForBlockers = false, includeClosed = false, project, assignedStatuses = [], branchPattern = '^(\\d+)-', maxPages = 5, rolesFile = '' } = options;

  if (typeof repo !== 'string' || !REPO.test(repo)) {
    return { error: `${path}.repo must be set to owner/name.` };
  }

  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
    return { error: `${path}.labels must map owner/name to a label.` };
  }

  for (const [key, label] of Object.entries(labels)) {
    if (!REPO.test(key)) {
      return { error: `${path}.labels.${key}: the key must be owner/name.` };
    }

    if (typeof label !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(label)) {
      return { error: `${path}.labels.${key} must be lowercase letters, digits and hyphens.` };
    }
  }

  const loginList = strings(logins);

  if (loginList === null || loginList.length === 0) {
    return { error: `${path}.logins must list at least one login.` };
  }

  if (typeof requireAssignee !== 'boolean') {
    return { error: `${path}.requireAssignee must be true or false.` };
  }

  if (typeof waitForBlockers !== 'boolean') {
    return { error: `${path}.waitForBlockers must be true or false.` };
  }

  if (typeof includeClosed !== 'boolean') {
    return { error: `${path}.includeClosed must be true or false.` };
  }

  const p = project as { owner?: unknown; number?: unknown; statusField?: unknown } | undefined;

  if (typeof p?.owner !== 'string' || p.owner === '' || typeof p.number !== 'number' || !Number.isInteger(p.number)) {
    return { error: `${path}.project must give owner and number.` };
  }

  const statuses = strings(assignedStatuses);

  if (statuses === null) {
    return { error: `${path}.assignedStatuses must list statuses.` };
  }

  if (typeof ghPath !== 'string' || ghPath === '') {
    return { error: `${path}.ghPath must be a path.` };
  }

  if (typeof maxPages !== 'number' || !Number.isInteger(maxPages) || maxPages < 1) {
    return { error: `${path}.maxPages must be a whole number of at least 1.` };
  }

  const rolesPath = typeof rolesFile === 'string' ? rolesFile.trim() : null;

  if (rolesPath === null || (rolesPath !== '' && !isAbsolute(rolesPath) && !/^~([\\/]|$)/.test(rolesPath))) {
    return { error: `${path}.rolesFile must be an absolute path or start with ~.` };
  }

  let pattern: RegExp;

  try {
    pattern = new RegExp(String(branchPattern));
  } catch {
    return { error: `${path}.branchPattern is not a valid regular expression.` };
  }

  return {
    config: {
      ghPath,
      repo: repo.toLowerCase(),
      labels: Object.fromEntries(Object.entries(labels as Record<string, string>).map(([key, label]) => [key.toLowerCase(), label])),
      logins: loginList,
      requireAssignee,
      waitForBlockers,
      includeClosed,
      project: { owner: p.owner, number: p.number, statusField: typeof p.statusField === 'string' && p.statusField !== '' ? p.statusField : 'Status' },
      assignedStatuses: statuses,
      branchPattern: pattern,
      maxPages,
      rolesFile: rolesPath === '' ? null : rolesPath,
    },
  };
}
