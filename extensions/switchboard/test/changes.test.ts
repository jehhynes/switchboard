import { describe, expect, it } from 'vitest';
import { noRepository, repositoryRefusal } from '../src/changes.js';

const ROOT = 'd:/work/repo.worktrees/18941-inbox-badge';

describe('the repository a command will actually run against', () => {
  it('accepts the repository that was asked for', () => {
    expect(repositoryRefusal(ROOT, ROOT)).toBeNull();
  });

  it('compares drive letters case-insensitively', () => {
    expect(repositoryRefusal('d:/work/repo', 'D:\\work\\repo')).toBeNull();
  });

  // VS Code can fall back to the only open repository. Reject a main clone returned for a worktree request.
  it('refuses a different repository, naming both', () => {
    expect(repositoryRefusal(ROOT, 'd:/work/repo')).toBe(
      `VS Code selected d:/work/repo instead of ${ROOT}.`,
    );
  });

  it('says what to check when VS Code has no repository there', () => {
    expect(noRepository(ROOT)).toBe(
      `VS Code has no repository at ${ROOT}. Check that the worktree still exists and that Git is enabled.`,
    );
  });
});

