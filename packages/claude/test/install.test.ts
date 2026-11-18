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
  it('writes the hooks and adds entries, keeping existing settings', async () => {
    const home = join(dir, '.switchboard');
    const settings = join(dir, '.claude', 'settings.json');
    mkdirSync(join(dir, '.claude'));
    writeFileSync(settings, JSON.stringify({ theme: 'dark' }));

    expect(await installHooks(home, settings, 'node')).toBeNull();
    expect(readFileSync(join(home, 'hook.mjs'), 'utf8')).toBe(HOOK_SOURCE);
    expect(readFileSync(join(home, 'contract.mjs'), 'utf8')).toBe(CONTRACT_HOOK_SOURCE);

    const written = JSON.parse(readFileSync(settings, 'utf8'));
    expect(written.theme).toBe('dark');
    expect(written.hooks.Stop[0].hooks[0].args).toEqual([join(home, 'hook.mjs').replaceAll('\\', '/')]);
    expect(written.hooks.SessionStart[1].hooks[0].args).toEqual([join(home, 'contract.mjs').replaceAll('\\', '/')]);

    const before = readFileSync(settings, 'utf8');
    expect(await installHooks(home, settings, 'node')).toBeNull();
    expect(readFileSync(settings, 'utf8')).toBe(before);
  });

  it('creates missing settings, and leaves malformed settings untouched with the reason', async () => {
    const settings = join(dir, 'new', 'settings.json');

    expect(await installHooks(join(dir, 'sb'), settings, 'node')).toBeNull();
    expect(Object.keys(JSON.parse(readFileSync(settings, 'utf8')).hooks)).toHaveLength(13);

    writeFileSync(settings, '{ broken');
    expect(await installHooks(join(dir, 'sb'), settings, 'node')).toBe('Claude settings.json is not valid JSON, so Switchboard did not add its hooks.');
    expect(readFileSync(settings, 'utf8')).toBe('{ broken');
  });

  it("removes the entries of a Switchboard home whose hub does not run, and keeps a running hub's", async () => {
    const home = join(dir, '.switchboard');
    const settings = join(dir, '.claude', 'settings.json');
    const stopped = 'C:/Temp/sb-live-home-a/.switchboard';
    const running = 'C:/Temp/sb-live-home-b/.switchboard';
    const entry = (other: string) => ({ hooks: [{ type: 'command', command: 'node', args: [`${other}/hook.mjs`], async: true, timeout: 5 }] });
    const asked: string[] = [];

    mkdirSync(join(dir, '.claude'));
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [entry(stopped), entry(running)] } }));

    expect(await installHooks(home, settings, 'node', async (other) => (asked.push(other), other === running))).toBeNull();
    expect(JSON.parse(readFileSync(settings, 'utf8')).hooks.Stop).toEqual([entry(running), entry(home.replaceAll('\\', '/'))]);
    expect(asked.sort()).toEqual([running, stopped].sort());
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
