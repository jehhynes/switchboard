import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hubRunning, lockAddress, scriptHome, stoppedHomes } from '../src/hookHomes.js';

describe('scriptHome', () => {
  it('reads the Switchboard home of each script Switchboard installs, with either slash', () => {
    expect(scriptHome('C:/Temp/sb-live-home-a/.switchboard/codex-hook.mjs')).toBe('C:/Temp/sb-live-home-a/.switchboard');
    expect(scriptHome('C:\\Users\\me\\.switchboard\\hook.mjs')).toBe('C:/Users/me/.switchboard');
    expect(scriptHome('/home/me/.switchboard/contract.mjs')).toBe('/home/me/.switchboard');
  });

  it('reads no home from another script or a folder not named .switchboard', () => {
    expect(scriptHome('C:/Users/me/.ground-control/hook.mjs')).toBeNull();
    expect(scriptHome('C:/Users/me/.switchboard/hub.js')).toBeNull();
    expect(scriptHome('C:/Users/me/.switchboard/tools/hook.mjs')).toBeNull();
    expect(scriptHome('C:/Users/me/my.switchboard/hook.mjs')).toBeNull();
  });
});

describe('lockAddress', () => {
  it('names one pipe per profile on Windows, whatever the case and slashes, and a socket in the home elsewhere', () => {
    expect(lockAddress('C:/Users/Me', 'win32')).toBe(lockAddress('c:\\users\\me', 'win32'));
    expect(lockAddress('C:/Users/me', 'win32')).toMatch(/^\\\\\.\\pipe\\switchboard-[0-9a-f]{16}$/);
    expect(lockAddress('C:/Users/me', 'win32')).not.toBe(lockAddress('C:/Users/you', 'win32'));
    expect(lockAddress('/home/me', 'linux')).toBe(join('/home/me', '.switchboard', 'hub.sock'));
  });
});

describe('hubRunning', () => {
  let profile: string;

  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), 'switchboard-hook-home-'));
    mkdirSync(join(profile, '.switchboard'));
  });

  afterEach(() => {
    rmSync(profile, { recursive: true, force: true });
  });

  it("is true while a process holds the home's lock, as a starting hub does before it writes hub.json, and false after", async () => {
    const home = join(profile, '.switchboard').replaceAll('\\', '/');
    const lock = createServer((socket) => socket.destroy());

    expect(await hubRunning(home)).toBe(false);
    await new Promise<void>((done) => lock.listen(lockAddress(profile), done));
    expect(await hubRunning(home)).toBe(true);
    await new Promise((done) => lock.close(done));
    expect(await hubRunning(home)).toBe(false);
  });
});

describe('stoppedHomes', () => {
  const profile = 'C:/Users/me';

  it('runs the plan once to learn the homes, and returns those whose hub does not run, checking each once', async () => {
    const asked: string[] = [];
    let plans = 0;
    const stopped = await stoppedHomes(
      (stale) => {
        plans++;
        // The plan's check keeps every home while the homes are being learned.
        expect(['C:/a/.switchboard', 'C:/b/.switchboard', 'C:/a/.switchboard'].map(stale)).toEqual([false, false, false]);
      },
      async (home) => (asked.push(home), home === 'C:/b/.switchboard'),
      profile,
    );

    expect(plans).toBe(1);
    expect([...stopped]).toEqual(['C:/a/.switchboard']);
    expect(asked.sort()).toEqual(['C:/a/.switchboard', 'C:/b/.switchboard']);
  });

  it("never returns the profile's own home, though its hub is down", async () => {
    const own = process.platform === 'win32' ? 'c:\\users\\ME\\.switchboard' : `${profile}/.switchboard`;
    const stopped = await stoppedHomes((stale) => [own, 'C:/a/.switchboard'].map(stale), async () => false, profile);

    expect([...stopped]).toEqual(['C:/a/.switchboard']);
  });
});
