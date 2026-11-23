import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hubConfigPath, readHubConfig, writeHubConfig } from '../src/hubConfig.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'switchboard-hub-config-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('config.json', () => {
  it('reads as no file until written, and writes the resolved folder, keeping other keys', () => {
    expect(hubConfigPath(home)).toBe(join(home, '.switchboard', 'config.json'));
    expect(readHubConfig(home)).toBeNull();

    writeHubConfig(home, join(home, 'cfg', '..', 'cfg2'));
    expect(readHubConfig(home)).toEqual({ dir: resolve(home, 'cfg2') });

    writeFileSync(hubConfigPath(home), JSON.stringify({ other: 1, configDir: join(home, 'a') }));
    writeHubConfig(home, join(home, 'b'));
    expect(JSON.parse(readFileSync(hubConfigPath(home), 'utf8'))).toEqual({ other: 1, configDir: resolve(home, 'b') });
  });

  it('reports a file that is not JSON, names no folder or names a relative one, rather than reading it as absent', () => {
    mkdirSync(join(home, '.switchboard'));

    for (const [text, error] of [
      ['{', 'is not valid JSON'],
      ['[]', 'must name configDir, an absolute path'],
      ['{"configDir": 3}', 'must name configDir, an absolute path'],
      ['{"configDir": "cfg"}', 'must name configDir, an absolute path'],
    ] as const) {
      writeFileSync(hubConfigPath(home), text);
      expect(readHubConfig(home)).toEqual({ error: `${hubConfigPath(home)} ${error}` });
    }

    // writeHubConfig replaces a file that cannot be used, which is how hub.js config set repairs it.
    writeHubConfig(home, join(home, 'cfg'));
    expect(readHubConfig(home)).toEqual({ dir: resolve(home, 'cfg') });
  });
});
