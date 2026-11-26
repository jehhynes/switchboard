import { describe, expect, it } from 'vitest';
import { commandToken } from '../src/desk.js';

describe('commandToken', () => {
  it('returns what the command prints, and fails when it prints nothing or exits non-zero', async () => {
    expect(await commandToken('echo abc123')()).toEqual({ token: 'abc123' });
    expect(await commandToken('true')()).toEqual({ error: 'The Zoho token command failed: it printed nothing' });
    expect(await commandToken('echo refused >&2; exit 2')()).toEqual({ error: 'The Zoho token command failed: refused' });
    expect(await commandToken('echo abc123', 'no-such-bash')()).toEqual({ error: expect.stringMatching(/^The Zoho token command failed: .*ENOENT/) });
  });
});
