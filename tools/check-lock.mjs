// A machine-wide limit on heavy checks: the pre-commit hook and `npm run verify`
// take a slot before they build and test, so checks from sessions committing at
// the same time run one after another instead of slowing each other down.
// See docs/testing.md.
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Set for the checks a slot holder starts, so a nested `npm run verify` does not wait on its own parent. */
export const HELD = 'SWITCHBOARD_CHECK_SLOT';
/** A lock with no process ID yet, left by a holder killed while it wrote one, is taken over this long after it was made. */
const EMPTY_MS = 10_000;
/** A lock is taken over this long after it was made even while its process ID runs, which may be another process that reused it. */
const HELD_MS = 60 * 60 * 1000;

/**
 * Waits for one of `slots` lock files in `dir` and returns a function that frees it; the slot is also freed when the
 * process exits. A lock whose process is gone, or older than HELD_MS, is taken over. Returns a no-op when the environment says a parent holds one.
 */
export function takeSlot({ dir = tmpdir(), slots = Number(process.env.SWITCHBOARD_CHECK_SLOTS) || 1, env = process.env, pid = process.pid, alive = processAlive, sleep = sleepSync, log = console.log, pollMs = 1000, now = Date.now } = {}) {
  if (env[HELD]) return () => {};

  let waited = false;

  for (;;) {
    for (let n = 1; n <= slots; n++) {
      const path = join(dir, `switchboard-check-${n}.lock`);

      if (tryLock(path, pid, alive, now)) {
        env[HELD] = path;

        const free = () => {
          if (owner(path) === pid) rmSync(path, { force: true });
          delete env[HELD];
          process.off('exit', free);
        };

        process.on('exit', free);
        return free;
      }
    }

    if (!waited) {
      log(`checks: waiting for another session's checks (${holders(dir, slots).join(', ')}) to finish`);
      waited = true;
    }

    sleep(pollMs);
  }
}

function tryLock(path, pid, alive, now) {
  try {
    const fd = openSync(path, 'wx');

    writeSync(fd, String(pid));
    closeSync(fd);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const holder = owner(path);

  if (holder === null ? age(path, now) > EMPTY_MS : !alive(holder) || age(path, now) > HELD_MS) {
    // Moved aside first, so of two waiters that saw the same stale lock only one takes it; one that moved another's
    // new lock puts it back.
    const aside = `${path}.${pid}.stale`;

    try {
      renameSync(path, aside);
    } catch {
      return false;
    }

    if (owner(aside) !== holder) {
      try { renameSync(aside, path); } catch { /* Its holder frees its slot by removing a file that is gone; it ends either way. */ }
      return false;
    }

    rmSync(aside, { force: true });
    return tryLock(path, pid, () => true, now);
  }

  return false;
}

/** Milliseconds since `path` last changed, or 0 when it is gone. */
function age(path, now) {
  try {
    return now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function owner(path) {
  try {
    const pid = Number(readFileSync(path, 'utf8'));

    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function holders(dir, slots) {
  const pids = [];

  for (let n = 1; n <= slots; n++) {
    const pid = owner(join(dir, `switchboard-check-${n}.lock`));

    if (pid !== null) pids.push(`pid ${pid}`);
  }

  return pids;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
