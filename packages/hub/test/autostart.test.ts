import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTOSTART_USAGE, LINK_KEY, RUN_KEY, regValue, runAutostart, runValueName, windowsCommandLine } from '../src/autostart.js';
import type { AutostartCli } from '../src/autostart.js';

const REG = 'C:\\Windows\\System32\\reg.exe';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const BUNDLE = 'C:\\Users\\me\\.switchboard\\hub.js';
const COMMAND = `"${NODE}" "${BUNDLE}" "start" "--no-wait" "--home=C:\\Users\\me"`;

/** A `reg query` answer as reg.exe prints it. */
const answer = (key: string, name: string, data: string): string => `\r\n${key}\r\n    ${name}    REG_SZ    ${data}\r\n\r\n`;

interface Fake {
  cli: AutostartCli;
  runs: string[][];
  out: string[];
  err: string[];
  /** reg.exe's registry: key and value name to data. */
  registry: Map<string, string>;
}

function fake(overrides: Partial<AutostartCli> = {}): Fake {
  const runs: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const registry = new Map<string, string>();
  const cli: AutostartCli = {
    platform: 'win32',
    osHome: 'C:\\Users\\me',
    env: { SystemRoot: 'C:\\Windows' },
    run: async (command, args) => {
      runs.push([command, ...args]);

      const [verb, key, which, name] = args;
      const slot = `${key}|${which === '/ve' ? '(Default)' : name}`;

      if (verb === 'query') {
        return registry.has(slot) ? { code: 0, stdout: answer(key!, which === '/ve' ? '(Default)' : name!, registry.get(slot)!) } : { code: 1, stdout: 'ERROR: The system was unable to find the specified registry key or value.' };
      }

      if (verb === 'add') {
        registry.set(slot, args[args.indexOf('/d') + 1]!);
      } else if (verb === 'delete') {
        for (const each of [...registry.keys()].filter((one) => (which === '/v' ? one === slot : one.startsWith(key!)))) {
          registry.delete(each);
        }
      }

      return { code: 0, stdout: 'The operation completed successfully.' };
    },
    home: 'C:\\Users\\me',
    runtime: NODE,
    electron: false,
    bundle: BUNDLE,
    configDir: async (persist) => (persisted.push(persist), 'C:\\Users\\me\\.claude\\switchboard'),
    exists: () => true,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...overrides,
  };

  return { cli, runs, out, err, registry };
}

/** Each persist argument runAutostart passed to configDir. */
const persisted: boolean[] = [];

const changes = (runs: string[][]): string[][] => runs.filter((run) => run[1] !== 'query');

describe('windowsCommandLine', () => {
  it('quotes every argument and doubles trailing backslashes so they do not escape the closing quote', () => {
    expect(windowsCommandLine(['C:\\Program Files\\nodejs\\node.exe', '--home=D:\\'])).toBe('"C:\\Program Files\\nodejs\\node.exe" "--home=D:\\\\"');
  });
});

describe('regValue', () => {
  it("reads a reg query answer's data, spaces included, and nothing from an error", () => {
    expect(regValue(answer(RUN_KEY, 'Switchboard', COMMAND))).toBe(COMMAND);
    expect(regValue('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
  });
});

describe('hub.js autostart on Windows', () => {
  it('writes the Run value and the switchboard: link with reg.exe from System32, both running hub.js start for this home, with no URL argument', async () => {
    const { cli, runs, out, registry } = fake();

    expect(await runAutostart(['on'], cli)).toBe(0);
    expect(changes(runs)).toEqual([
      [REG, 'add', RUN_KEY, '/v', 'Switchboard', '/t', 'REG_SZ', '/d', COMMAND, '/f'],
      [REG, 'add', LINK_KEY, '/ve', '/t', 'REG_SZ', '/d', 'URL:Switchboard', '/f'],
      [REG, 'add', LINK_KEY, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'],
      [REG, 'add', `${LINK_KEY}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', COMMAND, '/f'],
    ]);
    expect(COMMAND).not.toContain('%');
    expect(out.join('')).toBe('The hub now starts at login, and switchboard:start links start it, for C:\\Users\\me, with the config folder config.json names, now C:\\Users\\me\\.claude\\switchboard.\n');
    expect(COMMAND).not.toContain('--config');

    out.length = 0;
    expect(await runAutostart([], cli)).toBe(0);
    expect(out.join('')).toBe(`Login start: ${COMMAND}\nswitchboard: link: ${COMMAND}\n`);
    expect(registry.size).toBe(4);
  });

  it('names the Run value by hash for another home, so a test home never replaces the real one, ', async () => {
    const { cli, runs } = fake({ home: 'D:\\scratch', bundle: 'D:\\scratch\\.switchboard\\hub.js' });
    const name = runValueName({ runtime: NODE, bundle: cli.bundle, home: cli.home }, cli.osHome);

    expect(name).toMatch(/^Switchboard [0-9a-f]{8}$/);
    expect(await runAutostart(['on'], cli)).toBe(0);
    expect(changes(runs)[0]).toEqual([REG, 'add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', `"${NODE}" "D:\\scratch\\.switchboard\\hub.js" "start" "--no-wait" "--home=D:\\scratch"`, '/f']);
  });

  it('prints the changes on --dry-run and makes none', async () => {
    const { cli, runs, out } = fake();

    persisted.length = 0;
    expect(await runAutostart(['on', '--dry-run'], cli)).toBe(0);
    expect(changes(runs)).toEqual([]);
    // A dry run reads the config folder without importing it into config.json.
    expect(persisted).toEqual([false]);
    expect(out.join('')).toContain(`Would run "${REG}" "add" "${RUN_KEY}" "/v" "Switchboard" "/t" "REG_SZ" "/d"`);
    expect(out.join('').split('\n').filter((line) => line.startsWith('Would run'))).toHaveLength(4);
  });

  it("turns both off, and leaves a link that starts another home's hub", async () => {
    const mine = fake();

    await runAutostart(['on'], mine.cli);
    mine.runs.length = 0;
    expect(await runAutostart(['off'], mine.cli)).toBe(0);
    expect(changes(mine.runs)).toEqual([
      [REG, 'delete', RUN_KEY, '/v', 'Switchboard', '/f'],
      [REG, 'delete', LINK_KEY, '/f'],
    ]);
    expect(mine.registry.size).toBe(0);
    expect(mine.out.at(-1)).toBe('The hub no longer starts at login, and switchboard: links no longer start it.\n');

    const other = fake();

    other.registry.set(`${RUN_KEY}|Switchboard`, COMMAND);
    other.registry.set(`${LINK_KEY}\\shell\\open\\command|(Default)`, '"node" "D:\\other\\.switchboard\\hub.js" "start"');
    expect(await runAutostart(['off'], other.cli)).toBe(0);
    expect(changes(other.runs)).toEqual([[REG, 'delete', RUN_KEY, '/v', 'Switchboard', '/f']]);
    expect(other.out.at(-1)).toBe("The switchboard: link starts another hub, so it was left as it is; anything else of this home's is removed.\n");

    // Entries under the same names whose command runs another script, even one that mentions this bundle, are left alone.
    const foreign = fake();

    foreign.registry.set(`${RUN_KEY}|Switchboard`, `"C:\\tool.exe" "C:\\other.js" "start" "${BUNDLE}"`);
    foreign.registry.set(`${LINK_KEY}\\shell\\open\\command|(Default)`, `"C:\\tool.exe" "${BUNDLE}x" "start"`);
    expect(await runAutostart(['off'], foreign.cli)).toBe(0);
    expect(changes(foreign.runs)).toEqual([]);
    expect(foreign.out.at(-1)).toBe("The login entry and the switchboard: link start another hub, so they were left as they are; anything else of this home's is removed.\n");

    const none = fake();

    expect(await runAutostart(['off', '--dry-run'], none.cli)).toBe(0);
    expect(none.out).toEqual(['Nothing to change.\n']);
  });

  it('says when turning on replaced the link of another home', async () => {
    const { cli, out, registry } = fake();

    registry.set(`${LINK_KEY}\\shell\\open\\command|(Default)`, '"node" "D:\\other\\.switchboard\\hub.js" "start"');
    expect(await runAutostart(['on'], cli)).toBe(0);
    expect(out.join('')).toContain('This replaced the link that ran "node" "D:\\other\\.switchboard\\hub.js" "start".');
  });

  it('refuses usage errors, VS Code\'s runtime, other platforms, unquotable paths and a missing hub, changing nothing', async () => {
    for (const rest of [['maybe'], ['on', 'off'], ['on', '--force'], ['--dry-run'], ['on', '--config=D:\\cfg']]) {
      const { cli, runs, err } = fake();

      expect(await runAutostart(rest, cli)).toBe(1);
      expect(err).toEqual([AUTOSTART_USAGE]);
      expect(runs).toEqual([]);
    }

    const cases: Array<[Partial<AutostartCli>, string]> = [
      [{ electron: true }, `Run hub.js autostart with Node.js, as node ${BUNDLE} autostart, so the hub does not start with VS Code's runtime.\n`],
      [{ platform: 'darwin' }, 'hub.js autostart works on Windows and Linux, not darwin.\n'],
      [{ home: 'C:\\Users\\100%', bundle: 'C:\\Users\\100%\\.switchboard\\hub.js' }, 'Refused: C:\\Users\\100%\\.switchboard\\hub.js holds a character the login start cannot quote safely (" % or a line break).\n'],
      [{ exists: () => false }, `No hub is installed in ${BUNDLE}; run <extension folder>/dist/hub.js install first.\n`],
      [{ configDir: async () => ({ error: 'C:\\Users\\me\\.switchboard\\config.json is not valid JSON; fix it, or run hub.js config set configDir <folder>' }) }, 'Refused: C:\\Users\\me\\.switchboard\\config.json is not valid JSON; fix it, or run hub.js config set configDir <folder>.\n'],
    ];

    for (const [overrides, message] of cases) {
      const { cli, runs, err } = fake(overrides);

      expect(await runAutostart(['on'], cli)).toBe(1);
      expect(err).toEqual([message]);
      expect(changes(runs)).toEqual([]);
    }
  });

  it('stops at a failed change and names it', async () => {
    const { cli, runs, err } = fake();
    const run = cli.run;

    cli.run = async (command, args) => (args[0] === 'add' && args[1] === LINK_KEY ? { code: 1, stdout: 'ERROR: Access is denied.' } : run(command, args));
    expect(await runAutostart(['on'], cli)).toBe(3);
    expect(changes(runs)).toHaveLength(1);
    expect(err.join('')).toBe(`run "${REG}" "add" "${LINK_KEY}" "/ve" "/t" "REG_SZ" "/d" "URL:Switchboard" "/f" failed with exit code 1: ERROR: Access is denied.\n`);
  });
});

describe('hub.js autostart on Linux', () => {
  let xdg: string;

  beforeEach(() => {
    xdg = mkdtempSync(join(tmpdir(), 'switchboard-autostart-'));
  });

  afterEach(() => {
    rmSync(xdg, { recursive: true, force: true });
  });

  const linux = (overrides: Partial<AutostartCli> = {}): Fake =>
    fake({ platform: 'linux', osHome: '/home/me', env: { XDG_CONFIG_HOME: join(xdg, 'config'), XDG_DATA_HOME: join(xdg, 'data') }, home: '/home/me', runtime: '/usr/bin/node', bundle: '/home/me/.switchboard/hub.js', configDir: async () => '/home/me/.switchboard', run: async (command, args) => ({ code: 0, stdout: [command, ...args].join(' ') }), ...overrides });
  const EXEC = 'Exec="/usr/bin/node" "/home/me/.switchboard/hub.js" "start" "--no-wait" "--home=/home/me"';

  it('writes an XDG autostart entry and a switchboard: handler, makes it the default with xdg-mime, and removes both', async () => {
    const runs: string[][] = [];
    const { cli, out } = linux({ run: async (command, args) => (runs.push([command, ...args]), { code: 0, stdout: '' }) });
    const login = join(xdg, 'config', 'autostart', 'switchboard.desktop');
    const link = join(xdg, 'data', 'applications', 'switchboard-link.desktop');

    expect(await runAutostart(['on'], cli)).toBe(0);
    expect(readFileSync(login, 'utf8')).toBe(['[Desktop Entry]', 'Type=Application', 'Name=Switchboard', 'Comment=Starts the Switchboard hub', EXEC, 'Terminal=false', 'NoDisplay=true', 'X-GNOME-Autostart-enabled=true', ''].join('\n'));
    expect(readFileSync(link, 'utf8')).toContain(`${EXEC}\nTerminal=false\nNoDisplay=true\nMimeType=x-scheme-handler/switchboard;\n`);
    expect(runs).toEqual([['xdg-mime', 'default', 'switchboard-link.desktop', 'x-scheme-handler/switchboard']]);

    out.length = 0;
    expect(await runAutostart([], cli)).toBe(0);
    expect(out.join('')).toBe(`Login start: ${EXEC.slice(5)}\nswitchboard: link: ${EXEC.slice(5)}\n`);

    expect(await runAutostart(['off'], cli)).toBe(0);
    expect([existsSync(login), existsSync(link)]).toEqual([false, false]);
  });

  it('refuses a path that a desktop entry would need escaped', async () => {
    const { cli, err } = linux({ home: '/home/$me', bundle: '/home/$me/.switchboard/hub.js' });

    expect(await runAutostart(['on'], cli)).toBe(1);
    expect(err.join('')).toContain('holds a character the login start cannot quote safely');
    expect(existsSync(join(xdg, 'config'))).toBe(false);
  });
});
