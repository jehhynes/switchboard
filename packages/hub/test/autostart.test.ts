import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTOSTART_USAGE, HIDDEN_LAUNCHER, LINK_KEY, RUN_KEY, regValue, runAutostart, runValueName, supervisesBundle, supervisorName, supervisorTaskXml, supervisorUnit, taskCommand, windowsCommandLine } from '../src/autostart.js';
import { supervisorAddress, supervisorOffPath } from '../src/supervise.js';
import type { AutostartCli } from '../src/autostart.js';

const REG = 'C:\\Windows\\System32\\reg.exe';
const SCHTASKS = 'C:\\Windows\\System32\\schtasks.exe';
const WSCRIPT = 'C:\\Windows\\System32\\wscript.exe';
const LAUNCHER = 'C:\\Users\\me\\.switchboard\\run-hidden.js';
const TASK_XML = 'C:\\Users\\me\\.switchboard\\supervisor-task.xml';
const TASK = 'Switchboard supervisor';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const BUNDLE = 'C:\\Users\\me\\.switchboard\\hub.js';
const COMMAND = `"${NODE}" "${BUNDLE}" "start" "--no-wait" "--home=C:\\Users\\me"`;
const SUPERVISOR = `"${WSCRIPT}" //B //Nologo //E:JScript "${LAUNCHER}" "${NODE}" "${BUNDLE}" "supervise" "--home=C:\\Users\\me"`;

/** A `reg query` answer as reg.exe prints it. */
const answer = (key: string, name: string, data: string): string => `\r\n${key}\r\n    ${name}    REG_SZ    ${data}\r\n\r\n`;

interface Fake {
  cli: AutostartCli;
  runs: string[][];
  out: string[];
  err: string[];
  /** reg.exe's registry: key and value name to data. */
  registry: Map<string, string>;
  /** schtasks.exe's tasks: name to definition. */
  tasks: Map<string, string>;
  /** The files the steps wrote, which never reach the disk. */
  files: Map<string, string | Uint8Array>;
  /** Whether this home's supervisor answers on its lock. */
  supervising: { now: boolean; stops: string[] };
}

function fake(overrides: Partial<AutostartCli> = {}): Fake {
  const runs: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const registry = new Map<string, string>();
  const tasks = new Map<string, string>();
  const files = new Map<string, string | Uint8Array>();
  const supervising = { now: false, stops: [] as string[] };
  const missing = { code: 1, stdout: 'ERROR: The system cannot find the file specified.' };
  const cli: AutostartCli = {
    platform: 'win32',
    osHome: 'C:\\Users\\me',
    env: { SystemRoot: 'C:\\Windows', USERDOMAIN: 'PC', USERNAME: 'me' },
    supervisorRunning: async () => supervising.now,
    stopSupervisor: async (address) => {
      supervising.stops.push(address);

      const was = supervising.now;

      supervising.now = false;
      return was;
    },
    files: { write: (path, data) => void files.set(path, data), remove: (path) => void files.delete(path) },
    run: async (command, args) => {
      runs.push([command, ...args]);

      if (command === SCHTASKS) {
        const [verb, , name] = args;

        if (verb === '/create') {
          const data = files.get(args[args.indexOf('/xml') + 1]!);

          if (!(data instanceof Uint8Array)) {
            return missing;
          }

          tasks.set(name!, Buffer.from(data).toString('utf16le').replace(/^\ufeff/, ''));
        } else if (verb === '/query' || verb === '/run' || verb === '/delete') {
          if (!tasks.has(name!)) {
            return missing;
          }

          if (verb === '/query') {
            return { code: 0, stdout: tasks.get(name!)! };
          }

          if (verb === '/run') {
            supervising.now = true;
          } else {
            tasks.delete(name!);
          }
        }

        return { code: 0, stdout: 'SUCCESS' };
      }

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

  return { cli, runs, out, err, registry, tasks, files, supervising };
}

/** Each persist argument runAutostart passed to configDir. */
const persisted: boolean[] = [];

const changes = (runs: string[][]): string[][] => runs.filter((run) => run[1] !== 'query' && run[1] !== '/query');

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
  it('writes the Run value and the switchboard: link with reg.exe from System32, both running hub.js start for this home, with no URL argument, and registers and runs the supervisor task', async () => {
    const { cli, runs, out, registry, tasks, files, supervising } = fake();

    expect(await runAutostart(['on'], cli)).toBe(0);
    expect(changes(runs)).toEqual([
      [REG, 'add', RUN_KEY, '/v', 'Switchboard', '/t', 'REG_SZ', '/d', COMMAND, '/f'],
      [REG, 'add', LINK_KEY, '/ve', '/t', 'REG_SZ', '/d', 'URL:Switchboard', '/f'],
      [REG, 'add', LINK_KEY, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'],
      [REG, 'add', `${LINK_KEY}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', COMMAND, '/f'],
      [SCHTASKS, '/create', '/tn', TASK, '/xml', TASK_XML, '/f'],
      [SCHTASKS, '/run', '/tn', TASK],
    ]);
    expect(COMMAND).not.toContain('%');
    // The definition was read from a UTF-16 file, which is then removed; the launcher stays for the task to run.
    expect([...files.keys()]).toEqual([LAUNCHER]);
    expect(files.get(LAUNCHER)).toBe(HIDDEN_LAUNCHER);
    expect(taskCommand(tasks.get(TASK)!)).toBe(SUPERVISOR);
    // A supervisor running an older definition is asked to stop before the task runs the new one.
    expect(supervising.stops).toEqual([supervisorAddress('C:\\Users\\me', 'win32')]);
    expect(out.join('')).toBe('The hub now starts at login, and switchboard:start links start it, for C:\\Users\\me, with the config folder config.json names, now C:\\Users\\me\\.claude\\switchboard. A supervisor, the scheduled task "Switchboard supervisor", starts it again if it stops without hub.js --stop.\n');
    expect(COMMAND).not.toContain('--config');
    expect(SUPERVISOR).not.toContain('--config');

    out.length = 0;
    expect(await runAutostart([], cli)).toBe(0);
    expect(out.join('')).toBe(`Login start: ${COMMAND}\nswitchboard: link: ${COMMAND}\nSupervisor: ${SUPERVISOR} (running)\n`);
    expect(registry.size).toBe(4);
    expect(tasks.size).toBe(1);
  });

  it('defines the supervisor task to start hidden at this user\'s logon, with no window, time limit or battery stop, at normal priority, and to start again after a failure', () => {
    const { cli } = fake();
    const xml = supervisorTaskXml({ runtime: NODE, bundle: BUNDLE, home: 'C:\\Users\\me' }, cli);
    const settings = /<Settings>[\s\S]*<\/Settings>/.exec(xml)![0];

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">')).toBe(true);
    expect(xml).toContain('<LogonTrigger>\r\n      <Repetition>\r\n        <Interval>PT5M</Interval>\r\n        <StopAtDurationEnd>false</StopAtDurationEnd>\r\n      </Repetition>\r\n      <Enabled>true</Enabled>\r\n      <UserId>PC\\me</UserId>\r\n    </LogonTrigger>');
    expect(xml).toContain('<Principal id="Author">\r\n      <UserId>PC\\me</UserId>\r\n      <LogonType>InteractiveToken</LogonType>\r\n      <RunLevel>LeastPrivilege</RunLevel>');
    for (const setting of ['<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>', '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>', '<Hidden>true</Hidden>', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>', '<Priority>4</Priority>', '<RestartOnFailure>\r\n      <Interval>PT1M</Interval>\r\n      <Count>10</Count>\r\n    </RestartOnFailure>']) {
      expect(settings).toContain(setting);
    }
    expect(xml).toContain(`<Command>${WSCRIPT}</Command>`);
    expect(taskCommand(xml)).toBe(SUPERVISOR);

    // Text is escaped for XML, and read back unescaped.
    const odd = supervisorTaskXml({ runtime: NODE, bundle: 'C:\\A&B<C>\\.switchboard\\hub.js', home: 'C:\\A&B<C>' }, cli);

    expect(odd).toContain('<Description>Starts the Switchboard hub for C:\\A&amp;B&lt;C&gt; again');
    expect(taskCommand(odd)).toBe(`"${WSCRIPT}" //B //Nologo //E:JScript "C:\\A&B<C>\\.switchboard\\run-hidden.js" "${NODE}" "C:\\A&B<C>\\.switchboard\\hub.js" "supervise" "--home=C:\\A&B<C>"`);
  });

  it('names the Run value and the supervisor task by hash for another home, so a test home never replaces the real one', async () => {
    const { cli, runs } = fake({ home: 'D:\\scratch', bundle: 'D:\\scratch\\.switchboard\\hub.js' });
    const entry = { runtime: NODE, bundle: cli.bundle, home: cli.home };
    const name = runValueName(entry, cli.osHome);
    const task = supervisorName(entry, cli.osHome, 'win32');

    expect(name).toMatch(/^Switchboard [0-9a-f]{8}$/);
    expect(task).toBe(`Switchboard supervisor ${name.slice('Switchboard '.length)}`);
    expect(await runAutostart(['on'], cli)).toBe(0);
    expect(changes(runs)[0]).toEqual([REG, 'add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', `"${NODE}" "D:\\scratch\\.switchboard\\hub.js" "start" "--no-wait" "--home=D:\\scratch"`, '/f']);
    expect(changes(runs).slice(4)).toEqual([
      [SCHTASKS, '/create', '/tn', task, '/xml', 'D:\\scratch\\.switchboard\\supervisor-task.xml', '/f'],
      [SCHTASKS, '/run', '/tn', task],
    ]);
  });

  it('prints the changes on --dry-run and makes none', async () => {
    const { cli, runs, out, files, tasks, supervising } = fake();

    persisted.length = 0;
    expect(await runAutostart(['on', '--dry-run'], cli)).toBe(0);
    expect(changes(runs)).toEqual([]);
    // A dry run reads the config folder without importing it into config.json.
    expect(persisted).toEqual([false]);
    expect([files.size, tasks.size, supervising.stops.length]).toEqual([0, 0, 0]);
    expect(out.join('')).toContain(`Would run "${REG}" "add" "${RUN_KEY}" "/v" "Switchboard" "/t" "REG_SZ" "/d"`);
    expect(out.join('')).toContain(`Would write ${TASK_XML} (UTF-16):\n<?xml`);
    expect(out.join('')).toContain(`Would stop the supervisor on ${supervisorAddress('C:\\Users\\me', 'win32')}\n`);
    expect(out.join('').split('\n').filter((line) => line.startsWith('Would run'))).toHaveLength(6);
  });

  it("turns all three off, deleting the supervisor task before stopping the supervisor, and leaves entries that start another home's hub", async () => {
    const mine = fake();

    await runAutostart(['on'], mine.cli);
    mine.runs.length = 0;
    mine.supervising.stops.length = 0;
    expect(await runAutostart(['off'], mine.cli)).toBe(0);
    expect(changes(mine.runs)).toEqual([
      [REG, 'delete', RUN_KEY, '/v', 'Switchboard', '/f'],
      [REG, 'delete', LINK_KEY, '/f'],
      [SCHTASKS, '/delete', '/tn', TASK, '/f'],
    ]);
    expect(mine.supervising.stops).toEqual([supervisorAddress('C:\\Users\\me', 'win32')]);
    expect([mine.registry.size, mine.tasks.size]).toEqual([0, 0]);
    expect(mine.out.at(-1)).toBe('The hub no longer starts at login, switchboard: links no longer start it, and no supervisor starts it again.\n');
    // The marker that makes a supervisor the task had already launched exit once it takes its lock.
    expect([...mine.files.keys()]).toEqual([supervisorOffPath('C:\\Users\\me')]);
    expect(changes(mine.runs).length).toBe(3);

    // Turning on again removes it.
    await runAutostart(['on'], mine.cli);
    expect([...mine.files.keys()]).toEqual([LAUNCHER]);

    const other = fake();

    other.registry.set(`${RUN_KEY}|Switchboard`, COMMAND);
    other.registry.set(`${LINK_KEY}\\shell\\open\\command|(Default)`, '"node" "D:\\other\\.switchboard\\hub.js" "start"');
    expect(await runAutostart(['off'], other.cli)).toBe(0);
    expect(changes(other.runs)).toEqual([[REG, 'delete', RUN_KEY, '/v', 'Switchboard', '/f']]);
    expect(other.supervising.stops).toEqual([]);
    expect(other.out.at(-1)).toBe("The switchboard: link starts another hub, so it was left as it is; anything else of this home's is removed.\n");

    // Entries under the same names whose command runs another script, even one that mentions this bundle, are left alone.
    const foreign = fake();

    foreign.registry.set(`${RUN_KEY}|Switchboard`, `"C:\\tool.exe" "C:\\other.js" "start" "${BUNDLE}"`);
    foreign.registry.set(`${LINK_KEY}\\shell\\open\\command|(Default)`, `"C:\\tool.exe" "${BUNDLE}x" "start"`);
    foreign.tasks.set(TASK, '<Task><Actions><Exec><Command>C:\\tool.exe</Command><Arguments>"D:\\other\\.switchboard\\hub.js" "supervise"</Arguments></Exec></Actions></Task>');
    expect(await runAutostart(['off'], foreign.cli)).toBe(0);
    expect(changes(foreign.runs)).toEqual([]);
    expect(foreign.tasks.size).toBe(1);
    expect(foreign.out.at(-1)).toBe("The login entry, the switchboard: link and the supervisor task start another hub, so they were left as they are; anything else of this home's is removed.\n");

    // A task shaped like the supervisor's whose script is another, with this bundle only as an argument, is another program's too.
    const lookalike = fake();

    lookalike.tasks.set(TASK, `<Task><Actions><Exec><Command>${WSCRIPT}</Command><Arguments>//B //Nologo //E:JScript "${LAUNCHER}" "${NODE}" "C:\\other.js" "${BUNDLE}" "supervise"</Arguments></Exec></Actions></Task>`);
    expect(await runAutostart(['off'], lookalike.cli)).toBe(0);
    expect(changes(lookalike.runs)).toEqual([]);
    expect(lookalike.tasks.size).toBe(1);
    expect(supervisesBundle(`"/usr/bin/node" "/tool.js" "/home/me/.switchboard/hub.js" "supervise"`, { runtime: '/usr/bin/node', bundle: '/home/me/.switchboard/hub.js', home: '/home/me' }, 'linux')).toBe(false);
    expect(supervisesBundle(`"/usr/bin/node" "/home/me/.switchboard/hub.js" "supervise"`, { runtime: '/usr/bin/node', bundle: '/home/me/.switchboard/hub.js', home: '/home/me' }, 'linux')).toBe(true);

    // This home's supervisor is stopped whatever started it.
    const loose = fake();

    loose.supervising.now = true;
    expect(await runAutostart([], loose.cli)).toBe(0);
    expect(loose.out.at(-1)).toBe('Login start: off\nswitchboard: link: off\nSupervisor: off, but one is running for this home\n');
    expect(await runAutostart(['off'], loose.cli)).toBe(0);
    expect(loose.supervising.stops).toEqual([supervisorAddress('C:\\Users\\me', 'win32')]);
    expect(changes(loose.runs)).toEqual([]);

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

  it('refuses usage errors, VS Code\'s runtime, other platforms, unquotable paths, an unnamed user and a missing hub, changing nothing', async () => {
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
      [{ env: { SystemRoot: 'C:\\Windows' } }, 'Refused: USERNAME is not set, so the supervisor task cannot name the user whose logon starts it.\n'],
      [{ exists: () => false }, `No hub is installed in ${BUNDLE}; run <extension folder>/dist/hub.js install first.\n`],
      [{ configDir: async () => ({ error: 'C:\\Users\\me\\.switchboard\\config.json is not valid JSON; fix it, or run hub.js config set configDir <folder>' }) }, 'Refused: C:\\Users\\me\\.switchboard\\config.json is not valid JSON; fix it, or run hub.js config set configDir <folder>.\n'],
    ];

    for (const [overrides, message] of cases) {
      const { cli, runs, err, files } = fake(overrides);

      expect(await runAutostart(['on'], cli)).toBe(1);
      expect(err).toEqual([message]);
      expect(changes(runs)).toEqual([]);
      expect(files.size).toBe(0);
    }
  });

  it('stops at a failed change and names it', async () => {
    const { cli, runs, err } = fake();
    const run = cli.run;

    cli.run = async (command, args) => (args[0] === 'add' && args[1] === LINK_KEY ? { code: 1, stdout: 'ERROR: Access is denied.' } : run(command, args));
    expect(await runAutostart(['on'], cli)).toBe(3);
    expect(changes(runs)).toHaveLength(1);
    expect(err.join('')).toBe(`run "${REG}" "add" "${LINK_KEY}" "/ve" "/t" "REG_SZ" "/d" "URL:Switchboard" "/f" failed with exit code 1: ERROR: Access is denied.\n`);

    // A supervisor that does not stop fails the step, and the task is not run.
    const stuck = fake();

    stuck.cli.stopSupervisor = async () => {
      throw new Error('the supervisor on its pipe did not stop within 5 seconds');
    };
    expect(await runAutostart(['on'], stuck.cli)).toBe(3);
    expect(stuck.err.join('')).toBe(`stop the supervisor on ${supervisorAddress('C:\\Users\\me', 'win32')} failed: Error: the supervisor on its pipe did not stop within 5 seconds\n`);
    expect(changes(stuck.runs).at(-1)).toEqual([SCHTASKS, '/create', '/tn', TASK, '/xml', TASK_XML, '/f']);
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

  const linux = (overrides: Partial<AutostartCli> = {}): Fake => {
    const made = fake({ platform: 'linux', osHome: '/home/me', env: { XDG_CONFIG_HOME: join(xdg, 'config'), XDG_DATA_HOME: join(xdg, 'data') }, home: '/home/me', runtime: '/usr/bin/node', bundle: '/home/me/.switchboard/hub.js', configDir: async () => '/home/me/.switchboard', run: async (command, args) => ({ code: 0, stdout: [command, ...args].join(' ') }), ...overrides });

    // The Linux entries are real files under the test's XDG folders.
    delete (made.cli as { files?: unknown }).files;

    return made;
  };
  const EXEC = 'Exec="/usr/bin/node" "/home/me/.switchboard/hub.js" "start" "--no-wait" "--home=/home/me"';
  const SUPERVISE = '"/usr/bin/node" "/home/me/.switchboard/hub.js" "supervise" "--home=/home/me"';

  it('writes an XDG autostart entry, a switchboard: handler and the supervisor unit, makes the handler the default and runs the unit, and removes all three', async () => {
    const runs: string[][] = [];
    const { cli, out, supervising } = linux({ run: async (command, args) => (runs.push([command, ...args]), { code: 0, stdout: '' }) });
    const login = join(xdg, 'config', 'autostart', 'switchboard.desktop');
    const link = join(xdg, 'data', 'applications', 'switchboard-link.desktop');
    const unit = join(xdg, 'config', 'systemd', 'user', 'switchboard-supervisor.service');

    expect(await runAutostart(['on'], cli)).toBe(0);
    expect(readFileSync(login, 'utf8')).toBe(['[Desktop Entry]', 'Type=Application', 'Name=Switchboard', 'Comment=Starts the Switchboard hub', EXEC, 'Terminal=false', 'NoDisplay=true', 'X-GNOME-Autostart-enabled=true', ''].join('\n'));
    expect(readFileSync(link, 'utf8')).toContain(`${EXEC}\nTerminal=false\nNoDisplay=true\nMimeType=x-scheme-handler/switchboard;\n`);
    expect(readFileSync(unit, 'utf8')).toBe(supervisorUnit({ runtime: '/usr/bin/node', bundle: '/home/me/.switchboard/hub.js', home: '/home/me' }));
    expect(runs).toEqual([
      ['xdg-mime', 'default', 'switchboard-link.desktop', 'x-scheme-handler/switchboard'],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'switchboard-supervisor.service'],
      ['systemctl', '--user', 'restart', 'switchboard-supervisor.service'],
    ]);
    expect(out.join('')).toContain('A supervisor, the systemd user unit switchboard-supervisor.service, starts it again if it stops without hub.js --stop.\n');
    // A supervisor the unit did not start is stopped before the unit restarts.
    expect(supervising.stops).toEqual([supervisorAddress('/home/me', 'linux')]);

    out.length = 0;
    supervising.now = true;
    expect(await runAutostart([], cli)).toBe(0);
    expect(out.join('')).toBe(`Login start: ${EXEC.slice(5)}\nswitchboard: link: ${EXEC.slice(5)}\nSupervisor: ${SUPERVISE} (running)\n`);

    runs.length = 0;
    expect(await runAutostart(['off'], cli)).toBe(0);
    expect([existsSync(login), existsSync(link), existsSync(unit)]).toEqual([false, false, false]);
    // systemctl stops the supervisor; the unit's KillMode=process leaves the hub running.
    expect(runs).toEqual([
      ['systemctl', '--user', 'disable', '--now', 'switchboard-supervisor.service'],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    // A supervisor the unit did not start would keep running, so it is asked too.
    expect(supervising.stops).toEqual([supervisorAddress('/home/me', 'linux'), supervisorAddress('/home/me', 'linux')]);
  });

  it('defines the unit to run with the graphical session, restart on failure with a growing wait, and stop only the supervisor', () => {
    const text = supervisorUnit({ runtime: '/usr/bin/node', bundle: '/home/me/.switchboard/hub.js', home: '/home/me' });

    for (const line of ['PartOf=graphical-session.target', 'After=graphical-session.target', 'Type=simple', `ExecStart=${SUPERVISE}`, 'Restart=on-failure', 'RestartSec=10', 'RestartSteps=5', 'RestartMaxDelaySec=300', 'KillMode=process', 'WantedBy=graphical-session.target']) {
      expect(text.split('\n')).toContain(line);
    }
  });

  it('refuses a path that a desktop entry or unit would need escaped', async () => {
    const { cli, err } = linux({ home: '/home/$me', bundle: '/home/$me/.switchboard/hub.js' });

    expect(await runAutostart(['on'], cli)).toBe(1);
    expect(err.join('')).toContain('holds a character the login start cannot quote safely');
    expect(existsSync(join(xdg, 'config'))).toBe(false);
  });
});
