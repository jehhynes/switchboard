import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTRACT_HOOK_SOURCE, HOOK_SOURCE } from '../src/hooks.js';
import { claudeSettingsPath, installHooks, readMarkers } from '../src/install.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'switchboard-install-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('claudeSettingsPath', () => {
  it('uses CLAUDE_CONFIG_DIR when set', () => {
    expect(claudeSettingsPath('C:/Users/me', {})).toBe(join('C:/Users/me', '.claude', 'settings.json'));
    expect(claudeSettingsPath('C:/Users/me', { CLAUDE_CONFIG_DIR: 'D:/claude' })).toBe(join('D:/claude', 'settings.json'));
  });
});

describe('installHooks', () => {
  it('writes the hooks and adds entries, keeping existing settings', () => {
    const home = join(dir, '.switchboard');
    const settings = join(dir, '.claude', 'settings.json');
    mkdirSync(join(dir, '.claude'));
    writeFileSync(settings, JSON.stringify({ theme: 'dark' }));

    expect(installHooks(home, settings)).toBeNull();
    expect(readFileSync(join(home, 'hook.mjs'), 'utf8')).toBe(HOOK_SOURCE);
    expect(readFileSync(join(home, 'contract.mjs'), 'utf8')).toBe(CONTRACT_HOOK_SOURCE);

    const written = JSON.parse(readFileSync(settings, 'utf8'));
    expect(written.theme).toBe('dark');
    expect(written.hooks.Stop[0].hooks[0].args).toEqual([join(home, 'hook.mjs').replaceAll('\\', '/')]);
    expect(written.hooks.SessionStart[1].hooks[0].args).toEqual([join(home, 'contract.mjs').replaceAll('\\', '/')]);

    const before = readFileSync(settings, 'utf8');
    expect(installHooks(home, settings)).toBeNull();
    expect(readFileSync(settings, 'utf8')).toBe(before);
  });

  it('creates missing settings, and leaves malformed settings untouched with the reason', () => {
    const settings = join(dir, 'new', 'settings.json');

    expect(installHooks(join(dir, 'sb'), settings)).toBeNull();
    expect(Object.keys(JSON.parse(readFileSync(settings, 'utf8')).hooks)).toHaveLength(13);

    writeFileSync(settings, '{ broken');
    expect(installHooks(join(dir, 'sb'), settings)).toBe('Claude settings.json is not valid JSON, so Switchboard did not add its hooks.');
    expect(readFileSync(settings, 'utf8')).toBe('{ broken');
  });
});

describe('readMarkers', () => {
  it('reads markers by session ID and skips unreadable ones', () => {
    expect(readMarkers(join(dir, 'none')).size).toBe(0);

    mkdirSync(join(dir, 'activity'));
    writeFileSync(join(dir, 'activity', 'a.json'), JSON.stringify({ sessionId: 'a', event: 'Stop' }));
    writeFileSync(join(dir, 'activity', 'b.json'), '{');
    writeFileSync(join(dir, 'activity', 'c.json.1.tmp'), '{}');

    expect([...readMarkers(dir)]).toEqual([['a', { sessionId: 'a', event: 'Stop' }]]);
  });
});
