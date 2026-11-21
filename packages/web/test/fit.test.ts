import { describe, expect, it } from 'vitest';
import { fitPills } from '../src/fit.js';
import type { FitPill } from '../src/fit.js';

const pill = (width: number, returned = false): FitPill => ({ width, compact: 26, returned });

// Line 2 as the dock's PillLine fits it (architecture.md § Dock, Line 2): a 16 px comment icon, a 100 px playbook, 6 px gaps.
describe('fitPills', () => {
  it('keeps every pill whole while the line has room', () => {
    expect(fitPills(400, [16], 100, [pill(60), pill(80), pill(30, true)], 6)).toEqual(['full', 'full', 'full']);
  });

  it('shrinks the pills wider than 56 px first, longest first, while the playbook keeps its width', () => {
    // Whole: 16 + 100 + 60 + 80 + 40 + 4 gaps = 320.
    expect(fitPills(270, [16], 100, [pill(60), pill(80), pill(40)], 6)).toEqual(['full', 'compact', 'full']);
    expect(fitPills(240, [16], 100, [pill(60), pill(80), pill(40)], 6)).toEqual(['compact', 'compact', 'full']);
  });

  it('lets the playbook give way down to 60 px before shrinking the short pills, then Returned last', () => {
    // With both long pills compact: 16 + 100 + 26 + 26 + 40 + 30 + 5 gaps = 268; the playbook at 60 makes it 228.
    expect(fitPills(230, [16], 100, [pill(60), pill(80), pill(40), pill(30, true)], 6)).toEqual(['compact', 'compact', 'full', 'full']);
    expect(fitPills(215, [16], 100, [pill(60), pill(80), pill(40), pill(30, true)], 6)).toEqual(['compact', 'compact', 'compact', 'full']);
    expect(fitPills(212, [16], 100, [pill(60), pill(80), pill(40), pill(30, true)], 6)).toEqual(['compact', 'compact', 'compact', 'compact']);
  });

  it('lets the playbook give way entirely before leaving out pills that do not fit even as icons, the last first, Returned only when alone it does not fit', () => {
    const pills = [pill(60), pill(80), pill(40), pill(30, true)];

    // As icons with the playbook at 60 px: 16 + 60 + 26 * 4 + 5 gaps = 210; with no playbook: 16 + 26 * 4 + 4 gaps = 144, so all stay as icons.
    expect(fitPills(180, [16], 100, pills, 6)).toEqual(['compact', 'compact', 'compact', 'compact']);
    expect(fitPills(144, [16], 100, pills, 6)).toEqual(['compact', 'compact', 'compact', 'compact']);
    expect(fitPills(143, [16], 100, pills, 6)).toEqual(['compact', 'compact', 'omitted', 'compact']);
    expect(fitPills(100, [16], 100, pills, 6)).toEqual(['compact', 'omitted', 'omitted', 'compact']);
    expect(fitPills(70, [16], 100, pills, 6)).toEqual(['omitted', 'omitted', 'omitted', 'compact']);
    expect(fitPills(40, [16], 100, pills, 6)).toEqual(['omitted', 'omitted', 'omitted', 'omitted']);
  });

  it('counts a missing playbook as no item', () => {
    expect(fitPills(66, [], 0, [pill(30), pill(30)], 6)).toEqual(['full', 'full']);
    expect(fitPills(65, [], 0, [pill(30), pill(30)], 6)).toEqual(['compact', 'full']);
  });
});
