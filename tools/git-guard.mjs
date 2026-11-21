// Keeps checks away from the repository's git config, refs and index. See docs/testing.md.
//
// A commit hook runs with GIT_DIR and GIT_INDEX_FILE pointing at the checkout
// being committed to; in a worktree, GIT_DIR is .git/worktrees/<name>, whose
// config is the main repository's .git/config, which every worktree shares. A
// test that runs `git init` and `git config` in a temp folder with those
// variables set reinitializes that repository as bare and writes its user there.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** `env` without any GIT_* variable, so git in a child process finds its repository from its own folder. */
export function cleanGitEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
}

// Keys no check has a reason to change: a bare flag or work tree breaks every
// checkout of the repository, and a user section authors every commit.
const WATCHED = /^(core\.bare|core\.worktree|core\.hookspath|user\..+|author\..+|committer\..+)$/;

function watched(path) {
  let text;

  try {
    text = execFileSync('git', ['config', '--file', path, '--list', '-z'], { encoding: 'utf8', env: cleanGitEnv(), windowsHide: true });
  } catch {
    return null;
  }

  return text.split('\0').filter(Boolean).map((entry) => entry.split('\n')).filter(([key]) => WATCHED.test(key.toLowerCase()))
    .map(([key, ...value]) => `${key.toLowerCase()}=${value.join('\n')}`).sort();
}

/** The lines of `lines` not in `other`, counting a repeated line once per copy. */
function without(lines, other) {
  const left = [...other];

  return lines.filter((line) => {
    const at = left.indexOf(line);

    if (at === -1) return true;
    left.splice(at, 1);
    return false;
  });
}

/**
 * The checkout's HEAD, its branch and a hash of the index entries with their flags, which stay put while a commit hook
 * runs. Shared refs such as `refs/remotes/origin/main` are left out: a fetch or push in another worktree moves them. They are read with the caller's environment, so in a commit hook they are those of the commit being made.
 */
function checkout(cwd) {
  const git = (...args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
    } catch {
      return null;
    }
  };
  const branch = git('symbolic-ref', '-q', 'HEAD');
  const index = git('ls-files', '-v', '--stage', '-z');

  return [
    `HEAD -> ${branch ?? '(detached)'}`,
    ...['HEAD', ...(branch ? [branch] : [])].map((ref) => `${ref}=${git('rev-parse', '-q', '--verify', ref) ?? '(none)'}`),
    `index=${index === null ? '(unreadable)' : createHash('sha1').update(index).digest('hex')}`,
  ];
}

/**
 * Records the watched keys of the shared config of the repository holding `cwd` and, with `checkout`, its checkout's
 * HEAD, branch and index. Only a commit hook passes `checkout`: staging in that checkout during
 * the hook can put files in the commit, so it fails the commit too, while a session can stage, commit or rebase during a
 * plain `npm run verify`. `check()` returns null while they are unchanged, else a message naming each change and how
 * to undo a config change; it changes nothing itself.
 */
export function guardRepo(cwd, { checkout: watchCheckout = false } = {}) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', env: cleanGitEnv(), windowsHide: true }).trim();
  const path = `${common}/config`;
  const before = watched(path);
  const refsBefore = watchCheckout ? checkout(cwd) : [];

  return {
    path,
    check() {
      const after = watched(path);
      const refsAfter = watchCheckout ? checkout(cwd) : [];
      const configChanged = JSON.stringify(after) !== JSON.stringify(before);
      const refsChanged = JSON.stringify(refsAfter) !== JSON.stringify(refsBefore);

      if (!configChanged && !refsChanged) return null;

      return [
        'changed the repository:',
        ...(configChanged ? [
          `  the shared git config ${path}:`,
          ...without(before ?? [], after ?? []).map((line) => `    - ${line}`),
          ...without(after ?? [], before ?? []).map((line) => `    + ${line}`),
          ...(after === null ? ['    (git can no longer read it)'] : []),
          '  Undo each change, for example:',
          `    git config --file "${path}" core.bare false`,
          `    git config --file "${path}" --remove-section user`,
        ] : []),
        ...(refsChanged ? [
          `  the refs or index of the checkout at ${cwd}:`,
          ...without(refsBefore, refsAfter).map((line) => `    - ${line}`),
          ...without(refsAfter, refsBefore).map((line) => `    + ${line}`),
        ] : []),
      ].join('\n');
    },
  };
}
