import { describe, expect, it } from 'vitest';
import { parseWorktrees, reportedWorktree } from '../src/git.js';

// `git worktree list --porcelain` after the linked worktree's directory was deleted (git 2.x, 2026-10-06).
const PRUNABLE = [
  'worktree D:/git/widgets',
  'HEAD fb3c7c7dc4011bf53298c3b3e2b52b9737479e55',
  'branch refs/heads/master',
  '',
  'worktree D:/git/widgets-wt/7-gone',
  'HEAD fb3c7c7dc4011bf53298c3b3e2b52b9737479e55',
  'branch refs/heads/7-gone',
  'prunable gitdir file points to non-existent location',
  '',
  'worktree D:/git/widgets-wt/8-live',
  'HEAD def',
  'detached',
  '',
].join('\r\n');

describe('parseWorktrees', () => {
  it('lists each worktree with its branch and leaves out a prunable one', () => {
    expect(parseWorktrees(PRUNABLE)).toEqual([
      { path: 'D:/git/widgets', branch: 'master' },
      { path: 'D:/git/widgets-wt/8-live', branch: null },
    ]);
  });
});

describe('reportedWorktree', () => {
  const exec = async () => ({ code: 0, stdout: PRUNABLE, stderr: '', missing: false, timedOut: false });

  it('refuses a reported path whose registration is prunable', async () => {
    expect(await reportedWorktree('D:\\git\\widgets-wt\\7-gone', exec)).toBeNull();
    expect(await reportedWorktree('D:\\git\\widgets-wt\\8-live\\', exec)).toEqual({ path: 'D:/git/widgets-wt/8-live', branch: null });
  });
});
