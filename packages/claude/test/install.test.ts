import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTRACT_HOOK_SOURCE, HOOK_SOURCE } from '../src/hooks.js';
import { claudeSettingsPath, installHooks, MARKER_KEEP_MS, markerPass, pruneMarkers, readMarkers } from '../src/install.js';

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

  /** Writes a marker file whose mtime is an hour old, so a read does not count it as just written. */
  const writeOld = (file: string, text: string, mtime = new Date(Date.now() - 3_600_000)) => {
    writeFileSync(join(dir, 'activity', file), text);
    utimesSync(join(dir, 'activity', file), mtime, mtime);
  };

  it('reads a file again only when its stat changed', () => {
    mkdirSync(join(dir, 'activity'));
    const mtime = new Date(Date.now() - 3_600_000);
    writeOld('a.json', JSON.stringify({ sessionId: 'a', event: 'Stop' }), mtime);
    expect(readMarkers(dir).get('a')?.event).toBe('Stop');

    // Same size and mtime in the same file: the earlier read stands, which shows the file was not read again.
    writeOld('a.json', JSON.stringify({ sessionId: 'a', event: 'Stap' }), mtime);
    expect(readMarkers(dir).get('a')?.event).toBe('Stop');

    writeOld('a.json', JSON.stringify({ sessionId: 'a', event: 'StopFailure' }), mtime);
    expect(readMarkers(dir).get('a')?.event).toBe('StopFailure');

    writeOld('a.json', JSON.stringify({ sessionId: 'a', event: 'StopFailurf' }));
    expect(readMarkers(dir).get('a')?.event).toBe('StopFailurf');
  });

  it('reads a replaced file of the same size and mtime again', () => {
    mkdirSync(join(dir, 'activity'));
    const mtime = new Date(Date.now() - 3_600_000);
    writeOld('a.json', JSON.stringify({ sessionId: 'a', event: 'Stop' }), mtime);
    expect(readMarkers(dir).get('a')?.event).toBe('Stop');

    // The hook writes a temporary file and renames it over the marker, which gives the marker a new file ID.
    writeOld('a.json.1.tmp', JSON.stringify({ sessionId: 'a', event: 'Stap' }), mtime);
    renameSync(join(dir, 'activity', 'a.json.1.tmp'), join(dir, 'activity', 'a.json'));
    expect(readMarkers(dir).get('a')?.event).toBe('Stap');
  });

  it('reads a file that failed to parse again on the next read, even with the same stat', () => {
    mkdirSync(join(dir, 'activity'));
    const mtime = new Date(Date.now() - 3_600_000);
    writeOld('a.json', '{"sessionId":"a"x', mtime);
    writeOld('n.json', 'null', mtime);
    expect(readMarkers(dir).size).toBe(0);

    // Same size and mtime, in the same file.
    writeOld('a.json', '{"sessionId":"a"}', mtime);
    expect([...readMarkers(dir).keys()]).toEqual(['a']);
  });

  it('sees a new file ID when a file of the same size and mtime is renamed over a marker, as the hook writes one', () => {
    mkdirSync(join(dir, 'activity'));
    const mtime = new Date(Date.now() - 3_600_000);
    const path = join(dir, 'activity', 'a.json');
    writeOld('a.json', JSON.stringify({ sessionId: 'a', event: 'Stop' }), mtime);
    const before = statSync(path, { bigint: true });

    writeOld('a.json.1.tmp', JSON.stringify({ sessionId: 'a', event: 'Stap' }), mtime);
    renameSync(join(dir, 'activity', 'a.json.1.tmp'), path);
    const after = statSync(path, { bigint: true });

    expect([after.size, after.mtimeNs]).toEqual([before.size, before.mtimeNs]);
    expect(after.ino).not.toBe(before.ino);
  });

  it('reads a just-written file again even when its stat is unchanged', () => {
    mkdirSync(join(dir, 'activity'));
    const mtime = new Date();
    writeOld('a.json', JSON.stringify({ sessionId: 'a', event: 'Stop' }), mtime);
    expect(readMarkers(dir).get('a')?.event).toBe('Stop');

    writeOld('a.json', JSON.stringify({ sessionId: 'a', event: 'Stap' }), mtime);
    expect(readMarkers(dir).get('a')?.event).toBe('Stap');
  });

  it('drops removed files, adds new ones and reads a fixed unreadable one', () => {
    mkdirSync(join(dir, 'activity'));
    writeOld('a.json', JSON.stringify({ sessionId: 'a', event: 'Stop' }));
    writeOld('b.json', '{');
    expect([...readMarkers(dir).keys()]).toEqual(['a']);

    rmSync(join(dir, 'activity', 'a.json'));
    writeOld('b.json', JSON.stringify({ sessionId: 'b', event: 'Stop' }));
    writeOld('c.json', JSON.stringify({ sessionId: 'c', event: 'Stop' }));
    expect([...readMarkers(dir).keys()].sort()).toEqual(['b', 'c']);

    rmSync(join(dir, 'activity'), { recursive: true });
    expect(readMarkers(dir).size).toBe(0);
  });

  it('keys markers by their session ID, not their file name, as before', () => {
    mkdirSync(join(dir, 'activity'));
    writeOld('x.json', JSON.stringify({ sessionId: 'a', event: 'Stop', at: 1 }));
    expect([...readMarkers(dir)]).toEqual([['a', { sessionId: 'a', event: 'Stop', at: 1 }]]);
  });

  it('answers every read in a pass from one read of the folder', () => {
    mkdirSync(join(dir, 'activity'));
    writeOld('a.json', JSON.stringify({ sessionId: 'a', event: 'Stop' }));

    const seen = markerPass(() => {
      const first = readMarkers(dir);
      first.delete('a');
      writeOld('b.json', JSON.stringify({ sessionId: 'b', event: 'Stop' }));
      const second = markerPass(() => readMarkers(dir));

      return [first.size, [...second.keys()]];
    });

    // A caller's change to its map does not reach the next caller, and the file written during the pass is read after it.
    expect(seen).toEqual([0, ['a']]);
    expect([...readMarkers(dir).keys()].sort()).toEqual(['a', 'b']);
  });

  it('ends a pass that throws', () => {
    mkdirSync(join(dir, 'activity'));
    expect(() => markerPass(() => { readMarkers(dir); throw new Error('boom'); })).toThrow('boom');
    writeOld('a.json', JSON.stringify({ sessionId: 'a', event: 'Stop' }));
    expect([...readMarkers(dir).keys()]).toEqual(['a']);
  });
});

describe('pruneMarkers', () => {
  const write = (file: string, text: string, ageMs: number) => {
    const path = join(dir, 'activity', file);
    writeFileSync(path, text);
    const at = new Date(Date.now() - ageMs);
    utimesSync(path, at, at);
  };
  const left = () => readdirSync(join(dir, 'activity')).sort();

  it('deletes only week-old markers of sessions nobody knows', () => {
    mkdirSync(join(dir, 'activity'));
    const old = MARKER_KEEP_MS + 60_000;
    write('gone.json', JSON.stringify({ sessionId: 'gone', event: 'Stop' }), old);
    write('bad.json', '{', old);
    write('known.json', JSON.stringify({ sessionId: 'known', event: 'Stop' }), old);
    // Known by the session ID inside, under another file name.
    write('renamed.json', JSON.stringify({ sessionId: 'retired', event: 'Stop' }), old);
    write('recent.json', JSON.stringify({ sessionId: 'recent', event: 'Stop' }), MARKER_KEEP_MS - 60_000);
    write('other.json.1.tmp', '{}', old);
    const known = new Set(['known', 'retired']);

    expect(pruneMarkers(dir, (id) => known.has(id), Date.now())).toEqual({ removed: 2, failed: 0 });
    expect(left()).toEqual(['known.json', 'other.json.1.tmp', 'recent.json', 'renamed.json']);
    expect(readMarkers(dir).has('gone')).toBe(false);
  });

  it('counts a marker it cannot delete, and reads no folder that is missing', () => {
    expect(pruneMarkers(join(dir, 'none'), () => false, Date.now())).toEqual({ removed: 0, failed: 0 });
    mkdirSync(join(dir, 'activity'));
    // A folder named like a marker cannot be removed as a file.
    mkdirSync(join(dir, 'activity', 'stuck.json'));
    const at = new Date(Date.now() - MARKER_KEEP_MS - 60_000);
    utimesSync(join(dir, 'activity', 'stuck.json'), at, at);

    expect(pruneMarkers(dir, () => false, Date.now())).toEqual({ removed: 0, failed: 1 });
    expect(existsSync(join(dir, 'activity', 'stuck.json'))).toBe(true);
  });
});
