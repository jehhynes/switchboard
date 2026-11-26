import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeStale, testTemp } from '../../../tools/vitest-temp.js';

const DAY_S = 24 * 60 * 60;

/** A folder under `root` named `name`, last changed `ageS` seconds before `now`. */
function folder(root: string, name: string, now: number, ageS: number): string {
  const path = join(root, name);

  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'f.txt'), 'x');
  utimesSync(path, now / 1000 - ageS, now / 1000 - ageS);
  return path;
}

describe('testTemp', () => {
  it('TestTemp_NewRun_GivesTheRunItsOwnFolderAndSharesTheHomes', () => {
    const base = mkdtempSync(join(tmpdir(), 'temp-base-'));
    const env = testTemp(base);
    const root = join(base, 'switchboard-tests');

    expect(dirname(env['TEMP']!)).toBe(root);
    expect(basename(env['TEMP']!)).toMatch(new RegExp(`^run-${process.pid}-`));
    expect(existsSync(env['TEMP']!)).toBe(true);
    expect([env['TMP'], env['TMPDIR']]).toEqual([env['TEMP'], env['TEMP']]);
    expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: join(root, 'claude-home'), CODEX_HOME: join(root, 'codex-home'), GIT_CEILING_DIRECTORIES: root });
  });

  it('TestTemp_InsideARunsFolder_KeepsThatFolder', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'temp-base-')), 'switchboard-tests');
    const run = join(root, 'run-1-abc');

    mkdirSync(run, { recursive: true });
    expect(testTemp(run)).toEqual({ TEMP: run, TMP: run, TMPDIR: run, CLAUDE_CONFIG_DIR: join(root, 'claude-home'), CODEX_HOME: join(root, 'codex-home'), GIT_CEILING_DIRECTORIES: root });
    // A run whose temp folder is the shared folder itself, as before runs had folders of their own.
    expect(testTemp(root)).toMatchObject({ TEMP: root, GIT_CEILING_DIRECTORIES: root });
    expect(readdirSync(root)).toEqual(['run-1-abc']);
  });
});

describe('removeStale', () => {
  it('RemoveStale_OldFolders_RemovesThemAndKeepsTheHomesLiveRunsAndRecentFolders', () => {
    const root = mkdtempSync(join(tmpdir(), 'stale-'));
    const now = Date.now();

    folder(root, 'sb-changes-old', now, 2 * DAY_S);
    folder(root, 'run-111-dead', now, 2 * DAY_S);
    folder(root, 'run-222-live', now, 2 * DAY_S);
    folder(root, 'claude-home', now, 30 * DAY_S);
    folder(root, 'codex-home', now, 30 * DAY_S);
    folder(root, 'sb-changes-recent', now, DAY_S - 60);
    writeFileSync(join(root, 'old-file.txt'), 'x');
    utimesSync(join(root, 'old-file.txt'), now / 1000 - 2 * DAY_S, now / 1000 - 2 * DAY_S);

    const asked: number[] = [];

    removeStale(root, now, (pid) => (asked.push(pid), pid === 222));
    expect(readdirSync(root).sort()).toEqual(['claude-home', 'codex-home', 'run-222-live', 'sb-changes-recent']);
    expect(asked.sort()).toEqual([111, 222]);
  });
});
