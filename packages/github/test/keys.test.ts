import { describe, expect, it } from 'vitest';
import { keyOf, parseKey, refOf } from '../src/keys.js';

describe('GitHub ticket keys (PRD R44)', () => {
  it('keeps bare numbers for the home repository and qualifies every other repository in lowercase', () => {
    expect(keyOf('acme/widgets', 'Acme/Widgets', 18941)).toBe('18941');
    expect(keyOf('acme/widgets', 'Acme/Widgets-Dashboard', 63)).toBe('acme/widgets-dashboard#63');
    expect(refOf('acme/widgets', 'acme/widgets', 18941)).toBe('#18941');
    expect(refOf('acme/widgets', 'acme/widgets-dashboard', 63)).toBe('acme/widgets-dashboard#63');
  });

  it('reads a key back to its repository and number, and refuses a key no GitHub source writes', () => {
    expect(parseKey('acme/widgets', '18941')).toEqual({ repo: 'acme/widgets', number: 18941 });
    expect(parseKey('acme/widgets', 'Acme/Widgets-Dashboard#63')).toEqual({ repo: 'acme/widgets-dashboard', number: 63 });
    expect(parseKey('acme/widgets', 'T456')).toBeNull();
    expect(parseKey('acme/widgets', 'acme#63')).toBeNull();
  });
});
