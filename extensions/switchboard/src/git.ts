import * as vscode from 'vscode';
import { changesPlan, noRepository, repositoryRefusal } from './changes.js';
import type { ChangedPath, DiffSide } from './changes.js';

/** `Status` from the Git extension's API version 1, which ships no declarations (mechanics M21). */
const GitStatus = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  INDEX_DELETED: 2,
  INDEX_RENAMED: 3,
  INDEX_COPIED: 4,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
  IGNORED: 8,
  INTENT_TO_ADD: 9,
  INTENT_TO_RENAME: 10,
  TYPE_CHANGED: 11,
  ADDED_BY_US: 12,
  ADDED_BY_THEM: 13,
  DELETED_BY_US: 14,
  DELETED_BY_THEM: 15,
  BOTH_ADDED: 16,
  BOTH_DELETED: 17,
  BOTH_MODIFIED: 18,
} as const;

interface GitChange {
  /** The path now: a rename's new name. */
  readonly uri: vscode.Uri;
  /** The path before: a rename's old name. */
  readonly originalUri: vscode.Uri;
  readonly status: number;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly mergeChanges: readonly GitChange[];
    readonly workingTreeChanges: readonly GitChange[];
    readonly indexChanges: readonly GitChange[];
    readonly untrackedChanges: readonly GitChange[];
  };
  /** Resolves when the resource groups are rebuilt from a new status read. */
  status(): Promise<void>;
  getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
  diffBetween(ref1: string, ref2: string): Promise<GitChange[]>;
}

interface GitApi {
  getRepository(uri: vscode.Uri): GitRepository | null;
}

/** Refs tried in order for the merge base. Nothing is fetched. */
const BASE_REFS = ['origin/HEAD', 'origin/main', 'origin/master'];

async function gitApi(): Promise<GitApi | null> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');

  if (extension === undefined) {
    return null;
  }

  return (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
}

/** Copies count as additions, and conflicts as modifications, including a modify/delete conflict, which leaves the modified file on disk; ignored files are left out. */
function kindOf(status: number): ChangedPath['kind'] | null {
  switch (status) {
    case GitStatus.INDEX_ADDED:
    case GitStatus.UNTRACKED:
    case GitStatus.INTENT_TO_ADD:
    case GitStatus.INDEX_COPIED:
    case GitStatus.BOTH_ADDED:
    case GitStatus.ADDED_BY_US:
    case GitStatus.ADDED_BY_THEM:
      return 'added';
    case GitStatus.INDEX_DELETED:
    case GitStatus.DELETED:
    case GitStatus.BOTH_DELETED:
      return 'deleted';
    case GitStatus.IGNORED:
      return null;
    default:
      return 'modified';
  }
}

function changedPaths(changes: readonly GitChange[]): ChangedPath[] {
  const paths: ChangedPath[] = [];

  for (const change of changes) {
    const kind = kindOf(change.status);
    // A copy's original also differs from its path, but that file still exists unchanged.
    const renamed = (change.status === GitStatus.INDEX_RENAMED || change.status === GitStatus.INTENT_TO_RENAME) && change.originalUri.fsPath !== change.uri.fsPath;

    if (kind !== null) {
      paths.push(renamed ? { path: change.uri.fsPath, kind, from: change.originalUri.fsPath } : { path: change.uri.fsPath, kind });
    }
  }

  return paths;
}

/** The first base ref that shares history with HEAD, or null. `getBranchBase` is avoided because it writes to the git config. */
async function mergeBase(repository: GitRepository): Promise<string | null> {
  for (const ref of BASE_REFS) {
    try {
      const base = await repository.getMergeBase('HEAD', ref);

      if (base) {
        return base;
      }
    } catch {
      // The ref does not exist here; try the next.
    }
  }

  return null;
}

/** Opens the worktree in Source Control for this window's lifetime and returns its repository, or null after a warning. */
async function openRepository(path: string): Promise<GitRepository | null> {
  const api = await gitApi();

  if (api === null) {
    void vscode.window.showWarningMessage('Switchboard: enable the Git extension to use this.');
    return null;
  }

  const root = vscode.Uri.file(path);

  // The Git command takes a path string, not a URI.
  await vscode.commands.executeCommand('git.openRepository', root.fsPath);

  const repository = api.getRepository(root);
  const refusal = repository === null ? noRepository(root.fsPath) : repositoryRefusal(root.fsPath, repository.rootUri.fsPath);

  if (refusal !== null) {
    void vscode.window.showWarningMessage(`Switchboard: ${refusal}`);
    return null;
  }

  return repository;
}

function sideUri(side: DiffSide | null): vscode.Uri | undefined {
  if (side === null) {
    return undefined;
  }

  const file = vscode.Uri.file(side.path);

  return side.ref === null ? file : file.with({ scheme: 'git', query: JSON.stringify({ path: file.fsPath, ref: side.ref }) });
}

/**
 * A multi-diff editor that Open changes opened for the ticket, by the ticket key that starts its title, since the ticket's title can change.
 * Its input type is not in the stable API, so the `textDiffs` field identifies it.
 */
function isChangesTab(tab: vscode.Tab, key: string): boolean {
  return typeof tab.input === 'object' && tab.input !== null && 'textDiffs' in tab.input && tab.label.startsWith(`${key} `);
}

/**
 * Opens one multi-diff editor with a worktree's changes from its merge base to disk, committed and uncommitted (PRD R57).
 * `_workbench.openMultiDiffEditor` is private; re-verify it after a VS Code upgrade (mechanics M21).
 */
export async function openChanges(path: string, key: string, title: string): Promise<void> {
  const label = `${key} ${title}`;

  try {
    const repository = await openRepository(path);

    if (repository === null) {
      return;
    }

    // A newly opened repository has empty resource groups until its first status read completes.
    await repository.status();

    const base = await mergeBase(repository);
    const plan = changesPlan({
      label,
      base,
      committed: base === null ? [] : changedPaths(await repository.diffBetween(base, 'HEAD')),
      staged: changedPaths(repository.state.indexChanges),
      // Untracked files are in one group or the other by `git.untrackedChanges`, and in neither when it is `hidden`. Conflicted files are in mergeChanges.
      working: changedPaths([...repository.state.mergeChanges, ...repository.state.workingTreeChanges, ...repository.state.untrackedChanges]),
    });

    // An open editor with the same source URI is reused with its old resources, so the ticket's earlier editor is closed, even when
    // nothing has changed now, and the new one gets its own URI.
    await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => isChangesTab(tab, key)));

    if ('refusal' in plan) {
      void vscode.window.showInformationMessage(`Switchboard: ${plan.message}`);
      return;
    }

    await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
      multiDiffSourceUri: vscode.Uri.from({ scheme: 'switchboard-changes', path: `/${key}/${Date.now()}` }),
      title: plan.title,
      resources: plan.rows.map((row) => ({ originalUri: sideUri(row.original), modifiedUri: sideUri(row.modified) })),
    });
  } catch (error) {
    void vscode.window.showErrorMessage(`Switchboard: could not open the changes of ${label}: ${String(error)}`);
  }
}
