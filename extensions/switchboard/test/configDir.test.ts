import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hubConfigPath, writeHubConfig } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { windowConfigDir } from '../src/configDir.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'switchboard-window-config-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('windowConfigDir', () => {
  it("follows the setting until config.json exists, then config.json, so a window accepts the hub's folder", () => {
    expect(windowConfigDir(home, home, '~/cfg', false)).toBe(resolve(home, 'cfg'));
    expect(windowConfigDir(home, home, '', false)).toBe(resolve(home, '.switchboard'));
    expect(windowConfigDir(home, home, 'relative', false)).toBe(resolve(home, '.switchboard'));

    writeHubConfig(home, join(home, 'owned'));
    expect(windowConfigDir(home, home, '~/cfg', false)).toBe(resolve(home, 'owned'));
    expect(windowConfigDir(home, home, '~/cfg', true)).toBe(resolve(home, 'owned'));
  });

  it('ignores the setting in an isolated home, and falls back to it while config.json cannot be used', () => {
    expect(windowConfigDir(home, home, '~/cfg', true)).toBe(resolve(home, '.switchboard'));

    mkdirSync(join(home, '.switchboard'));
    writeFileSync(hubConfigPath(home), '{');
    expect(windowConfigDir(home, home, '~/cfg', false)).toBe(resolve(home, 'cfg'));
  });
});
