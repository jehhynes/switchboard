// This device's Wrap choice for code and diffs, shared by the Changes tab's diffs and file view and by local file tabs: kept in local storage so
// it holds where Settings cannot be changed, as on a paired phone; without one the views follow `web.diffWrap`.

export const WRAP_KEY = 'switchboard.diffWrap';

/** The choice made on a page without local storage, which holds until it reloads. */
let unkept: 'on' | 'off' | null = null;

/** The Wrap choice this device keeps, or null when it has none. */
export function storedWrap(): 'on' | 'off' | null {
  try {
    const kept = localStorage.getItem(WRAP_KEY);

    return kept === 'on' || kept === 'off' ? kept : null;
  } catch {
    return unkept;
  }
}

export function keepWrap(choice: 'on' | 'off'): void {
  try {
    localStorage.setItem(WRAP_KEY, choice);
  } catch {
    unkept = choice;
  }
}
