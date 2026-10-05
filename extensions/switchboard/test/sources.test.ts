import { describe, expect, it } from 'vitest';
import { sourceContexts } from '../src/sources.js';

describe('sourceContexts', () => {
  it('marks each toggled source on or off, leaves an unconfigured one undefined, and ignores other sources', () => {
    expect(sourceContexts({ sourceStates: [{ name: 'github', enabled: true }, { name: 'zoho', enabled: false }, { name: 'other', enabled: true }] })).toEqual({
      github: 'on',
      zoho: 'off',
      forum: undefined,
    });
  });
});
