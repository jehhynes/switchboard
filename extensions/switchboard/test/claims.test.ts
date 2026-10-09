import { describe, expect, it } from 'vitest';
import { claimIsFor } from '../src/claims.js';

const FILE = 'C:\\Users\\me\\.switchboard\\windows\\gh-107-58c609.code-workspace';

describe('claimIsFor', () => {
  it("matches the window's workspace file as Windows compares paths", () => {
    expect(claimIsFor(JSON.stringify({ workspace: FILE }), FILE)).toBe(true);
    expect(claimIsFor(JSON.stringify({ workspace: 'c:/users/me/.switchboard/windows/GH-107-58c609.code-workspace/' }), FILE)).toBe(true);
  });

  it('refuses another window, a window with no workspace file, and an event without a workspace', () => {
    expect(claimIsFor(JSON.stringify({ workspace: FILE.replace('107', '108') }), FILE)).toBe(false);
    expect(claimIsFor(JSON.stringify({ workspace: FILE }), null)).toBe(false);
    expect(claimIsFor(JSON.stringify({ workspace: null }), FILE)).toBe(false);
    expect(claimIsFor('null', FILE)).toBe(false);
    expect(claimIsFor('not json', FILE)).toBe(false);
  });
});
