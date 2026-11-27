// Checks run below normal priority so the desktop stays responsive while they
// use every core. Windows and Linux start child processes at their parent's
// lowered priority, so lowering the process that starts a check run lowers its
// builds, typechecks and test workers too. See docs/testing.md.
import { constants, setPriority } from 'node:os';

/** Lowers this process to below normal priority; a process the OS will not lower keeps running as it is. */
export function lowPriority() {
  try {
    setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {}
}
