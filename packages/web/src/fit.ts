/** How a pill on a list row's line 2 is drawn: whole, as its icon only, or left out. */
export type PillFit = 'full' | 'compact' | 'omitted';

/** A pill's width whole and as its icon only, and whether it is Returned, which shrinks and goes last. */
export interface FitPill {
  width: number;
  compact: number;
  returned: boolean;
}

/** Pills wider than this shrink first, while the playbook keeps its width; the playbook then gives way down to its floor. */
export const SHRINK_FIRST = 56;
export const PLAYBOOK_FLOOR = 60;

/**
 * Fits line 2's pills into `available` pixels as the dock's `PillLine` does (architecture.md § Dock, Line 2): first the pills wider than
 * `SHRINK_FIRST` shrink to their icon, longest first, while the playbook keeps its width; then, with the playbook down to `PLAYBOOK_FLOOR`,
 * the rest longest first, Returned last; then, the playbook giving way entirely, pills that do not fit even as icons are left out whole,
 * the last first, and Returned only when it alone does not fit. `others` are the widths of the line's other items, such as the comment
 * icon; `gap` is the space between items.
 */
export function fitPills(available: number, others: readonly number[], playbook: number, pills: readonly FitPill[], gap: number): PillFit[] {
  const fit: PillFit[] = pills.map(() => 'full');
  const width = (playbookWidth: number): number => {
    const shown = pills.map((pill, index) => (fit[index] === 'full' ? pill.width : fit[index] === 'compact' ? pill.compact : null)).filter((one): one is number => one !== null);
    // A playbook given no width takes no place and no space, as the dock's.
    const items = [...others, ...(playbookWidth > 0 ? [playbookWidth] : []), ...shown];

    return items.reduce((sum, one) => sum + one, 0) + gap * Math.max(0, items.length - 1);
  };
  const fits = (playbookWidth: number): boolean => width(playbookWidth) <= available + 0.5;
  /** Shrinks the widest whole pill that `can` allows; false when there is none. */
  const shrink = (can: (pill: FitPill) => boolean): boolean => {
    let widest = -1;

    pills.forEach((pill, index) => {
      if (fit[index] === 'full' && can(pill) && (widest === -1 || pill.width > pills[widest]!.width)) {
        widest = index;
      }
    });

    if (widest !== -1) {
      fit[widest] = 'compact';
    }

    return widest !== -1;
  };

  while (!fits(playbook) && shrink((pill) => !pill.returned && pill.width > SHRINK_FIRST)) {
    // Shrinks the next.
  }

  if (fits(playbook)) {
    return fit;
  }

  const floor = Math.min(playbook, PLAYBOOK_FLOOR);

  while (!fits(floor) && (shrink((pill) => !pill.returned) || shrink((pill) => pill.returned))) {
    // Shrinks the next.
  }

  // The playbook gives way entirely before a pill is left out.
  for (let index = pills.length - 1; index >= 0 && !fits(0); index -= 1) {
    if (!pills[index]!.returned) {
      fit[index] = 'omitted';
    }
  }

  pills.forEach((pill, index) => {
    if (pill.returned && !fits(0)) {
      fit[index] = 'omitted';
    }
  });

  return fit;
}
