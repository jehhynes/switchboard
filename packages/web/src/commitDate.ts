// Which of a commit's dates the page shows: git's author date by default, or its committer date, which a rebase, amend, cherry-pick or squash
// rewrites (PRD R118). Chosen on the Changes tab's `⋯` menu and kept in local storage, as Wrap is, so it holds where Settings cannot be changed.
import type { CommitInfo } from '@switchboard/protocol';
import { fullTime } from '@switchboard/conversation/messageMeta';

export const COMMIT_DATE_KEY = 'switchboard.commitDate';

/** The choice made where local storage refused it, which holds until the page reloads. */
let unkept: boolean | null = null;

/** Whether this device shows committer dates rather than author dates. */
export function showsCommitted(): boolean {
  if (unkept !== null) {
    return unkept;
  }

  try {
    return localStorage.getItem(COMMIT_DATE_KEY) === 'committed';
  } catch {
    return false;
  }
}

export function keepCommitted(committed: boolean): void {
  try {
    localStorage.setItem(COMMIT_DATE_KEY, committed ? 'committed' : 'authored');
    unkept = null;
  } catch {
    unkept = committed;
  }
}

/** The date a commit shows, in milliseconds. */
export const commitTime = (info: CommitInfo, committed: boolean): number => (committed ? info.committed : info.authored) * 1000;

/** A commit's dates for a tooltip: the one shown, named, then the other where they differ. */
export function commitDates(info: CommitInfo, committed: boolean): string {
  const authored = `Authored ${fullTime(info.authored * 1000)}`;
  const written = `Committed ${fullTime(info.committed * 1000)}`;

  if (info.authored === info.committed) {
    return committed ? written : authored;
  }

  return committed ? `${written} · ${authored}` : `${authored} · ${written}`;
}
