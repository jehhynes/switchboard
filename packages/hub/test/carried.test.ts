import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hubBundlePath, switchboardHome } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { carriesBuilds, installCarried } from '../src/carried.js';
import { tempHome } from './helpers.js';

const HOLDER = '0123456789abcdef';
const VOICE = 'fedcba9876543210';
const HELPER = '00112233445566ff';

let root: string;
let remove: () => void;
let dist: string;
let home: string;

/** A program's build folder as the extension carries it. */
function program(name: string, build: string, entry: string): void {
  mkdirSync(join(dist, name), { recursive: true });
  writeFileSync(join(dist, name, entry), name);
  writeFileSync(join(dist, name, 'manifest.json'), JSON.stringify({ build, files: [entry] }));
}

beforeEach(() => {
  ({ home: root, remove } = tempHome());
  dist = join(root, 'extension', 'dist');
  home = join(root, 'user');
  mkdirSync(join(dist, 'mermaid'), { recursive: true });
  writeFileSync(join(dist, 'hub.js'), 'hub one');
  writeFileSync(join(dist, 'mermaid', 'mermaid.min.js'), 'mermaid');
  mkdirSync(join(dist, 'chrome'));
  writeFileSync(join(dist, 'chrome', 'manifest.json'), '{"manifest_version":3}');
  program('holder', HOLDER, 'holder.js');
  program('voice', VOICE, 'voice.js');
});

afterEach(() => {
  remove();
});

describe('installCarried', () => {
  it('installs the hub bundle, Mermaid and the browser extension at once, then the holder and voice builds, and reports a hub bundle it did not change', async () => {
    const first = installCarried(dist, home, 'linux');

    expect(first.hub).toBe(true);
    expect(readFileSync(hubBundlePath(home), 'utf8')).toBe('hub one');
    expect(readFileSync(join(switchboardHome(home), 'web', 'mermaid.min.js'), 'utf8')).toBe('mermaid');
    expect(readFileSync(join(switchboardHome(home), 'web', 'chrome', 'manifest.json'), 'utf8')).toBe('{"manifest_version":3}');
    expect(await first.programs).toEqual([]);
    expect(JSON.parse(readFileSync(join(switchboardHome(home), 'holder', 'current.json'), 'utf8'))).toEqual({ build: HOLDER });
    expect(JSON.parse(readFileSync(join(switchboardHome(home), 'voice', 'current.json'), 'utf8'))).toEqual({ build: VOICE });

    const again = installCarried(dist, home, 'linux');

    expect(again.hub).toBe(false);
    expect(await again.programs).toEqual([]);

    writeFileSync(join(dist, 'hub.js'), 'hub two');
    expect(installCarried(dist, home, 'linux').hub).toBe(true);
    expect(readFileSync(hubBundlePath(home), 'utf8')).toBe('hub two');
  });

  it('reports a program that cannot be installed', async () => {
    writeFileSync(join(dist, 'voice', 'manifest.json'), '{}');
    expect(await installCarried(dist, home, 'linux').programs).toEqual([`${join(dist, 'voice', 'manifest.json')} is missing or invalid.`]);
  });

  it('throws when the hub bundle is missing, before installing anything else', () => {
    expect(() => installCarried(join(root, 'nowhere'), home, 'linux')).toThrow();
    expect(existsSync(join(switchboardHome(home), 'holder'))).toBe(false);
  });
});

describe('carriesBuilds', () => {
  it("tells a build folder, with the hub bundle and the holder's manifest, from another folder", () => {
    expect(carriesBuilds(dist)).toBe(true);
    expect(carriesBuilds(join(dist, 'holder'))).toBe(false);
    expect(carriesBuilds(switchboardHome(home))).toBe(false);
  });
});
