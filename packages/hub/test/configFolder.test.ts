import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hubConfigPath, switchboardHome, writeHubConfig } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_USAGE, loadConfigFolder, parseJsonc, runConfig, vscodeSettingsPath } from '../src/configFolder.js';
import type { ConfigCli, ConfigFolderDeps } from '../src/configFolder.js';

let home: string;
let deps: ConfigFolderDeps;

beforeEach(() => {
  home = resolve(mkdtempSync(join(tmpdir(), 'switchboard-config-folder-')));
  // osHome is another folder, so the environment's VS Code settings are never read: the settings path is under the scratch home.
  deps = { home, osHome: join(home, 'not-this-home'), platform: process.platform, env: { APPDATA: join(home, 'env-appdata'), XDG_CONFIG_HOME: join(home, 'env-xdg') } };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const writeVscode = (text: string): void => {
  const path = vscodeSettingsPath(deps);

  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

const stored = (): unknown => JSON.parse(readFileSync(hubConfigPath(home), 'utf8'));

describe('parseJsonc', () => {
  it("reads VS Code's settings.json with comments and trailing commas, and keeps them inside strings", () => {
    expect(parseJsonc('{\n  // a comment\n  "a": "x // y, }", /* block */ "b": [1, 2,],\n  "c": "q\\"/*",\n}\n')).toEqual({ a: 'x // y, }', b: [1, 2], c: 'q"/*' });
    expect(parseJsonc('{"a": }')).toBeNull();
    expect(parseJsonc('')).toBeNull();
  });
});

describe('vscodeSettingsPath', () => {
  it("uses the environment's folders only for the user's own home", () => {
    expect(vscodeSettingsPath({ home: 'C:\\Users\\me', osHome: 'c:\\users\\ME', platform: 'win32', env: { APPDATA: 'D:\\Roaming' } })).toBe('D:\\Roaming\\Code\\User\\settings.json');
    expect(vscodeSettingsPath({ home: 'D:\\scratch', osHome: 'C:\\Users\\me', platform: 'win32', env: { APPDATA: 'D:\\Roaming' } })).toBe('D:\\scratch\\AppData\\Roaming\\Code\\User\\settings.json');
    expect(vscodeSettingsPath({ home: '/home/me', osHome: '/home/me', platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' } })).toBe('/xdg/Code/User/settings.json');
    expect(vscodeSettingsPath({ home: '/tmp/s', osHome: '/home/me', platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' } })).toBe('/tmp/s/.config/Code/User/settings.json');
    expect(vscodeSettingsPath({ home: '/Users/me', osHome: '/Users/me', platform: 'darwin', env: {} })).toBe('/Users/me/Library/Application Support/Code/User/settings.json');
  });
});

describe('loadConfigFolder', () => {
  it("imports VS Code's switchboard.configDir once, with ~ as the home, and then reads config.json whatever the setting says", () => {
    writeVscode('{\n  // mine\n  "switchboard.configDir": "~/repo/switchboard",\n}');

    expect(loadConfigFolder(deps, null)).toEqual({ dir: resolve(home, 'repo', 'switchboard'), source: 'vscode', notices: [] });
    expect(stored()).toEqual({ configDir: resolve(home, 'repo', 'switchboard') });

    writeVscode('{"switchboard.configDir": "~/elsewhere"}');
    expect(loadConfigFolder(deps, null)).toEqual({ dir: resolve(home, 'repo', 'switchboard'), source: 'file', notices: [] });
  });

  it("imports the running hub's folder before the VS Code setting, so an upgrade keeps the folder the hub runs on", () => {
    writeVscode('{"switchboard.configDir": "~/stale"}');

    expect(loadConfigFolder(deps, null, { running: join(home, 'running') })).toEqual({ dir: resolve(home, 'running'), source: 'hub', notices: [] });
    expect(stored()).toEqual({ configDir: resolve(home, 'running') });
  });

  it('prefers --config to the VS Code setting on the import, and ignores a --config that differs from config.json, saying so', () => {
    writeVscode('{"switchboard.configDir": "~/vscode"}');

    expect(loadConfigFolder(deps, join(home, 'flag'))).toMatchObject({ dir: resolve(home, 'flag'), source: 'flag' });

    const ignored = loadConfigFolder(deps, join(home, 'other'));

    expect(ignored).toEqual({ dir: resolve(home, 'flag'), source: 'file', notices: [`--config=${join(home, 'other')} is ignored: ${hubConfigPath(home)} names ${resolve(home, 'flag')}; hub.js config set configDir <folder> changes it.`] });
    expect(loadConfigFolder(deps, join(home, 'flag'))).toEqual({ dir: resolve(home, 'flag'), source: 'file', notices: [] });
  });

  it("falls back to the dock's dock-hub.json and then the Switchboard home, and reports a setting it cannot import", () => {
    writeVscode('{"switchboard.configDir": "relative/cfg"}');
    mkdirSync(switchboardHome(home), { recursive: true });
    writeFileSync(join(switchboardHome(home), 'dock-hub.json'), JSON.stringify({ execPath: 'node', configDir: join(home, 'dock') }));

    expect(loadConfigFolder(deps, null)).toEqual({ dir: resolve(home, 'dock'), source: 'dock', notices: ['switchboard.configDir must be an absolute path or start with ~: relative/cfg, so it was not imported.'] });

    rmSync(hubConfigPath(home));
    rmSync(join(switchboardHome(home), 'dock-hub.json'));
    writeVscode('{ not json');

    expect(loadConfigFolder(deps, null)).toEqual({ dir: resolve(switchboardHome(home)), source: 'default', notices: [`${vscodeSettingsPath(deps)} could not be read as JSON, so switchboard.configDir was not imported.`] });
    expect(stored()).toEqual({ configDir: resolve(switchboardHome(home)) });
  });

  it('imports without writing config.json when asked not to persist, as for a dry run', () => {
    writeVscode('{"switchboard.configDir": "~/cfg"}');

    expect(loadConfigFolder(deps, null, { persist: false })).toEqual({ dir: resolve(home, 'cfg'), source: 'vscode', notices: [] });
    expect(() => readFileSync(hubConfigPath(home))).toThrow();
  });

  it('refuses a config.json it cannot use rather than import over it or fall back to the Switchboard home', () => {
    mkdirSync(switchboardHome(home), { recursive: true });
    writeFileSync(hubConfigPath(home), '{"configDir": "cfg"}');
    writeVscode('{"switchboard.configDir": "~/vscode"}');

    expect(loadConfigFolder(deps, join(home, 'flag'))).toEqual({ error: `${hubConfigPath(home)} must name configDir, an absolute path; fix it, or run hub.js config set configDir <folder>` });
    expect(readFileSync(hubConfigPath(home), 'utf8')).toBe('{"configDir": "cfg"}');
  });
});

describe('hub.js config', () => {
  interface Fake {
    cli: ConfigCli;
    out: string[];
    err: string[];
    restarts: number;
  }

  const fake = (running: string | null, restartCode = 0): Fake => {
    const fakeState: Fake = {
      out: [],
      err: [],
      restarts: 0,
      cli: {
        ...deps,
        running: async () => running,
        restart: async () => (fakeState.restarts++, restartCode),
        out: (text) => fakeState.out.push(text),
        err: (text) => fakeState.err.push(text),
      },
    };

    return fakeState;
  };

  it('shows the folder and where it came from, prints it alone with get, and says when the running hub reads another', async () => {
    writeVscode('{"switchboard.configDir": "~/cfg"}');
    writeHubConfig(home, join(home, 'cfg'));

    const shown = fake(resolve(home, 'old'));

    expect(await runConfig([], shown.cli)).toBe(0);
    expect(shown.out.join('')).toBe(`configDir: ${resolve(home, 'cfg')} (from config.json, ${hubConfigPath(home)})\nThe running hub reads ${resolve(home, 'old')}; hub.js restart moves it to ${resolve(home, 'cfg')}.\n`);

    rmSync(hubConfigPath(home));

    const imported = fake(resolve(home, 'old'));

    expect(await runConfig([], imported.cli)).toBe(0);
    expect(imported.out.join('')).toBe(`configDir: ${resolve(home, 'old')} (imported from the running hub, ${hubConfigPath(home)})\n`);
    rmSync(hubConfigPath(home));

    const got = fake(null);

    expect(await runConfig(['get', 'configDir'], got.cli)).toBe(0);
    expect(got.out).toEqual([`${resolve(home, 'cfg')}\n`]);
  });

  it('sets an existing folder, with ~ as the home, and restarts a running hub that reads another folder only', async () => {
    mkdirSync(join(home, 'cfg'));

    const idle = fake(null);

    expect(await runConfig(['set', 'configDir', '~/cfg'], idle.cli)).toBe(0);
    expect(stored()).toEqual({ configDir: resolve(home, 'cfg') });
    expect(idle.out.join('')).toBe(`The config folder is now ${resolve(home, 'cfg')}.\nThe hub reads it when it starts.\n`);
    expect(idle.restarts).toBe(0);

    const same = fake(resolve(home, 'cfg'));

    expect(await runConfig(['set', 'configDir', join(home, 'cfg')], same.cli)).toBe(0);
    expect(same.restarts).toBe(0);

    const other = fake(resolve(home, 'old'), 4);

    expect(await runConfig(['set', 'configDir', join(home, 'cfg')], other.cli)).toBe(4);
    expect(other.restarts).toBe(1);
  });

  it('refuses usage errors and a relative, missing or non-folder path, leaving config.json as it was', async () => {
    mkdirSync(join(home, 'kept'));
    writeFileSync(join(home, 'file.txt'), '');
    await runConfig(['set', 'configDir', join(home, 'kept')], fake(null).cli);

    for (const rest of [['get'], ['get', 'other'], ['set', 'configDir'], ['set', 'configDir', ' '], ['set', 'other', home], ['set', 'configDir', home, 'extra'], ['maybe']]) {
      const { cli, err } = fake(null);

      expect(await runConfig(rest, cli)).toBe(1);
      expect(err).toEqual([CONFIG_USAGE]);
    }

    for (const [path, message] of [
      ['cfg', 'Refused: configDir must be an absolute path or start with ~: cfg.\n'],
      [join(home, 'missing'), `Refused: ${resolve(home, 'missing')} does not exist. Create it, with settings.json in it, first.\n`],
      [join(home, 'file.txt'), `Refused: ${resolve(home, 'file.txt')} is not a folder.\n`],
    ] as const) {
      const { cli, err, restarts } = fake(resolve(home, 'old'));

      expect(await runConfig(['set', 'configDir', path], cli)).toBe(1);
      expect(err).toEqual([message]);
      expect(restarts).toBe(0);
    }

    expect(stored()).toEqual({ configDir: resolve(home, 'kept') });
  });

  it('reports a config.json it cannot use, and set replaces it', async () => {
    mkdirSync(switchboardHome(home), { recursive: true });
    writeFileSync(hubConfigPath(home), '{');

    const broken = fake(null);

    expect(await runConfig([], broken.cli)).toBe(3);
    expect(broken.err).toEqual([`${hubConfigPath(home)} is not valid JSON; fix it, or run hub.js config set configDir <folder>.\n`]);

    expect(await runConfig(['set', 'configDir', home], fake(null).cli)).toBe(0);
    expect(stored()).toEqual({ configDir: home });
  });
});
