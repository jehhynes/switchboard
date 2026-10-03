import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hubBundlePath, hubLogPath, hubRecordPath, switchboardHome } from '../src/paths.js';

describe('paths', () => {
  it('puts every hub file in the Switchboard home under the given home', () => {
    const home = join('C:', 'Users', 'someone');

    expect(switchboardHome(home)).toBe(join(home, '.switchboard'));
    expect(hubRecordPath(home)).toBe(join(home, '.switchboard', 'hub.json'));
    expect(hubLogPath(home)).toBe(join(home, '.switchboard', 'hub.log'));
    expect(hubBundlePath(home)).toBe(join(home, '.switchboard', 'hub.js'));
  });
});
