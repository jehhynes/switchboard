import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hubBundlePath, hubLogPath, hubRecordPath, resolveConfigDir, switchboardHome } from '../src/paths.js';

describe('paths', () => {
  it('puts every hub file in the Switchboard home under the given home', () => {
    const home = join('C:', 'Users', 'someone');

    expect(switchboardHome(home)).toBe(join(home, '.switchboard'));
    expect(hubRecordPath(home)).toBe(join(home, '.switchboard', 'hub.json'));
    expect(hubLogPath(home)).toBe(join(home, '.switchboard', 'hub.log'));
    expect(hubBundlePath(home)).toBe(join(home, '.switchboard', 'hub.js'));
  });

  it('resolves the configDir setting: empty is the Switchboard home, ~ is the profile, and a relative path is refused', () => {
    const home = resolve('C:/Users/someone');
    const profile = resolve('C:/Users/profile');

    expect(resolveConfigDir('  ', home, profile)).toEqual({ dir: switchboardHome(home) });
    expect(resolveConfigDir('~/.claude/switchboard', home, profile)).toEqual({ dir: resolve(profile, '.claude', 'switchboard') });
    expect(resolveConfigDir(`~${sep}cfg`, home, profile)).toEqual({ dir: resolve(profile, 'cfg') });
    expect(resolveConfigDir('~', home, profile)).toEqual({ dir: resolve(profile) });
    expect(resolveConfigDir(resolve('D:/git/cfg/'), home, profile)).toEqual({ dir: resolve('D:/git/cfg') });
    expect(resolveConfigDir('cfg', home, profile)).toEqual({ error: 'switchboard.configDir must be an absolute path or start with ~: cfg' });
    expect(resolveConfigDir('~other/cfg', home, profile)).toEqual({ error: 'switchboard.configDir must be an absolute path or start with ~: ~other/cfg' });
  });
});
