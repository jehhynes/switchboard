import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { supervisorAddress, supervisorOffPath } from './supervise.js';

/**
 * What the login start and the `switchboard:` link run: `<runtime> <bundle> start --no-wait --home=<home>`. They name no config folder, so `hub.js start`
 * reads config.json and `hub.js config set` needs no new entries (architecture.md § Config folder).
 */
export interface StartEntry {
  runtime: string;
  bundle: string;
  home: string;
}

export interface AutostartDeps {
  platform: NodeJS.Platform;
  /** The user's own home, whose Switchboard home gets the plain entry names; another home's names carry its hash. */
  osHome: string;
  env: NodeJS.ProcessEnv;
  /** Runs a program without a shell and answers its exit code and output. */
  run(command: string, args: readonly string[]): Promise<{ code: number; stdout: string }>;
  /** Whether a supervisor answers on its lock address. */
  supervisorRunning(address: string): Promise<boolean>;
  /** Asks the supervisor on the address to stop and waits until it has; false when none ran, and throws when it does not stop. */
  stopSupervisor(address: string): Promise<boolean>;
  /** Writes and removes files; the real file system unless a test gives its own. */
  files?: { write(path: string, data: string | Uint8Array): void; remove(path: string): void };
}

export type Step =
  | { kind: 'run'; command: string; args: string[] }
  | { kind: 'write'; path: string; content: string; utf16?: boolean }
  | { kind: 'remove'; path: string }
  | { kind: 'stop-supervisor'; address: string };

/** What is registered now: each entry's command, or null when there is none, and whether this home's supervisor runs. */
export interface AutostartState {
  login: string | null;
  link: string | null;
  supervisor: string | null;
  supervising: boolean;
}

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const LINK_KEY = 'HKCU\\Software\\Classes\\switchboard';
export const LINK_SCHEME = 'x-scheme-handler/switchboard';

/** The link's target names no URL argument, so nothing from a web page reaches the command. */
export const LINK_URL = 'switchboard:start';

function suffix(entry: StartEntry, osHome: string, platform: NodeJS.Platform): string {
  const resolve = platform === 'win32' ? win32.resolve : posix.resolve;
  const same = platform === 'win32' ? resolve(entry.home).toLowerCase() === resolve(osHome).toLowerCase() : resolve(entry.home) === resolve(osHome);

  return same ? '' : createHash('sha256').update(resolve(entry.home)).digest('hex').slice(0, 8);
}

/** The Run key's value name: `Switchboard`, or `Switchboard <hash>` for another home, such as a test's. */
export function runValueName(entry: StartEntry, osHome: string): string {
  const hash = suffix(entry, osHome, 'win32');

  return hash === '' ? 'Switchboard' : `Switchboard ${hash}`;
}

export function startArguments(entry: StartEntry): string[] {
  return [entry.runtime, entry.bundle, 'start', '--no-wait', `--home=${entry.home}`];
}

/** What the supervisor task or unit runs: `<runtime> <bundle> supervise --home=<home>`, naming no config folder, as the start entries do. */
export function superviseArguments(entry: StartEntry): string[] {
  return [entry.runtime, entry.bundle, 'supervise', `--home=${entry.home}`];
}

/** The supervisor's scheduled task, `Switchboard supervisor`, or its systemd user unit, `switchboard-supervisor.service`; another home's carry its hash. */
export function supervisorName(entry: StartEntry, osHome: string, platform: NodeJS.Platform): string {
  const hash = suffix(entry, osHome, platform);

  if (platform === 'win32') {
    return hash === '' ? 'Switchboard supervisor' : `Switchboard supervisor ${hash}`;
  }

  return hash === '' ? 'switchboard-supervisor.service' : `switchboard-supervisor-${hash}.service`;
}

/**
 * Run by `wscript.exe`, which opens no window, so the supervisor task shows no console: runs its arguments, each quoted, as one hidden command,
 * waits for it and exits with its exit code, which Task Scheduler's restart on failure reads.
 */
export const HIDDEN_LAUNCHER = [
  '// Written by hub.js autostart on: runs the Switchboard supervisor with no window.',
  "var shell = new ActiveXObject('WScript.Shell');",
  'var parts = [];',
  'for (var i = 0; i < WScript.Arguments.length; i++) {',
  "  parts.push('\"' + WScript.Arguments(i).replace(/(\\\\+)$/, '$1$1') + '\"');",
  '}',
  "WScript.Quit(shell.Run(parts.join(' '), 0, true));",
  '',
].join('\r\n');

function xmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlValue(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function systemExe(env: NodeJS.ProcessEnv, name: string): string {
  // An absolute path, so a program of the same name earlier on PATH cannot stand in for it.
  return win32.join(env['SystemRoot'] || 'C:\\Windows', 'System32', name);
}

/** The Windows user the task runs as and whose logon starts it: `<USERDOMAIN>\\<USERNAME>`. */
function taskUser(env: NodeJS.ProcessEnv): string {
  return env['USERDOMAIN'] ? `${env['USERDOMAIN']}\\${env['USERNAME'] ?? ''}` : (env['USERNAME'] ?? '');
}

function windowsSupervisor(entry: StartEntry, deps: AutostartDeps): { name: string; launcher: string; xml: string; schtasks: string; wscript: string } {
  const folder = win32.dirname(entry.bundle);

  return {
    name: supervisorName(entry, deps.osHome, 'win32'),
    launcher: win32.join(folder, 'run-hidden.js'),
    xml: win32.join(folder, 'supervisor-task.xml'),
    schtasks: systemExe(deps.env, 'schtasks.exe'),
    wscript: systemExe(deps.env, 'wscript.exe'),
  };
}

/**
 * The supervisor's Task Scheduler definition: it starts at the user's logon, hidden from Task Scheduler's list and with no window, with no time
 * limit, at normal priority, which the hub it starts inherits, and on battery. Task Scheduler starts it again a minute after a failure, and
 * every five minutes the logon trigger fires again, which starts it only when it is not running, in case a failure was not seen.
 */
export function supervisorTaskXml(entry: StartEntry, deps: AutostartDeps): string {
  const paths = windowsSupervisor(entry, deps);
  const user = xmlText(taskUser(deps.env));

  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlText(`Starts the Switchboard hub for ${entry.home} again if it stops without hub.js --stop. Written by hub.js autostart on.`)}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Repetition>',
    '        <Interval>PT5M</Interval>',
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${user}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${user}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>true</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>4</Priority>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>10</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlText(paths.wscript)}</Command>`,
    `      <Arguments>${xmlText(`//B //Nologo //E:JScript ${windowsCommandLine([paths.launcher, ...superviseArguments(entry)])}`)}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** A task definition's command line, as `schtasks /query /xml` prints it: its quoted command, then its arguments. */
export function taskCommand(xml: string): string | null {
  const command = /<Command>([^<]*)<\/Command>/.exec(xml)?.[1];
  const args = /<Arguments>([^<]*)<\/Arguments>/.exec(xml)?.[1] ?? '';

  return command === undefined ? null : `"${xmlValue(command)}"${args === '' ? '' : ` ${xmlValue(args)}`}`;
}

/**
 * The supervisor's systemd user unit. It runs with the graphical session, as the login start does, so the hubs it starts get that session's
 * environment. `KillMode=process` stops only the supervisor with the unit, never the hub it started, which runs on in the unit's control group.
 * systemd starts it again after a failure, waiting longer each time where it supports `RestartSteps`.
 */
export function supervisorUnit(entry: StartEntry): string {
  return [
    '[Unit]',
    `Description=Starts the Switchboard hub for ${entry.home} again if it stops without hub.js --stop. Written by hub.js autostart on.`,
    'PartOf=graphical-session.target',
    'After=graphical-session.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${desktopExec(superviseArguments(entry))}`,
    'Restart=on-failure',
    'RestartSec=10',
    'RestartSteps=5',
    'RestartMaxDelaySec=300',
    'KillMode=process',
    '',
    '[Install]',
    'WantedBy=graphical-session.target',
    '',
  ].join('\n');
}

/**
 * Whether a registered supervisor command runs this home's bundle: on Windows `"<wscript>" //B //Nologo //E:JScript "<launcher>" "<runtime>"
 * "<bundle>" "supervise"`, elsewhere `"<runtime>" "<bundle>" "supervise"`, so a command that only mentions the bundle is another program's.
 */
export function supervisesBundle(command: string, entry: StartEntry, platform: NodeJS.Platform): boolean {
  const shape = platform === 'win32' ? /^"[^"]*" \/\/B \/\/Nologo \/\/E:JScript "[^"]*" "[^"]*" "([^"]*)" "supervise"/ : /^"[^"]*" "([^"]*)" "supervise"/;
  const script = shape.exec(command)?.[1];

  return script !== undefined && (platform === 'win32' ? script.toLowerCase() === entry.bundle.toLowerCase() : script === entry.bundle);
}

/**
 * Why an entry cannot be written safely, or null. Windows expands `%` in a link's command and both platforms split at `"`; a desktop entry's
 * `Exec` also gives meaning to `\`, `$` and \`, which a quoted path would then need escaped twice, so those are refused instead.
 */
export function unsafe(entry: StartEntry, platform: NodeJS.Platform): string | null {
  const refused = platform === 'win32' ? /["%\r\n]/ : /["%\r\n\\$`]/;
  const path = [entry.runtime, entry.bundle, entry.home].find((one) => refused.test(one));

  return path === undefined ? null : `${path} holds a character the login start cannot quote safely (${platform === 'win32' ? '" % or a line break' : '" % \\ $ ` or a line break'})`;
}

/** One command line for Windows, each argument quoted, with trailing backslashes doubled so they do not escape the closing quote. */
export function windowsCommandLine(args: readonly string[]): string {
  return args.map((arg) => `"${arg.replace(/(\\+)$/, '$1$1')}"`).join(' ');
}

/** A desktop entry's `Exec`, each argument quoted; `unsafe` has refused every character that would need escaping. */
export function desktopExec(args: readonly string[]): string {
  return args.map((arg) => `"${arg}"`).join(' ');
}

function linuxPaths(entry: StartEntry, deps: AutostartDeps): { login: string; link: string; unit: string } {
  const hash = suffix(entry, deps.osHome, deps.platform);
  const config = deps.env['XDG_CONFIG_HOME'] || join(deps.osHome, '.config');
  const data = deps.env['XDG_DATA_HOME'] || join(deps.osHome, '.local', 'share');

  return {
    login: join(config, 'autostart', hash === '' ? 'switchboard.desktop' : `switchboard-${hash}.desktop`),
    link: join(data, 'applications', 'switchboard-link.desktop'),
    unit: join(config, 'systemd', 'user', supervisorName(entry, deps.osHome, deps.platform)),
  };
}

function desktopEntry(entry: StartEntry, extra: string[]): string {
  return ['[Desktop Entry]', 'Type=Application', 'Name=Switchboard', 'Comment=Starts the Switchboard hub', `Exec=${desktopExec(startArguments(entry))}`, 'Terminal=false', 'NoDisplay=true', ...extra, ''].join('\n');
}

function execOf(text: string): string | null {
  return /^Exec=(.*)$/m.exec(text)?.[1] ?? null;
}

function execStartOf(text: string): string | null {
  return /^ExecStart=(.*)$/m.exec(text)?.[1] ?? null;
}

/** The data of a `reg query` answer's REG_SZ line. */
export function regValue(stdout: string): string | null {
  return /\sREG_(?:EXPAND_)?SZ {4}(.*)$/m.exec(stdout.replace(/\r/g, ''))?.[1] ?? null;
}

function regExe(env: NodeJS.ProcessEnv): string {
  // An absolute path, so a reg.exe earlier on PATH cannot stand in for it.
  return win32.join(env['SystemRoot'] || 'C:\\Windows', 'System32', 'reg.exe');
}

/** Reads what is registered, changing nothing. */
export async function autostartState(entry: StartEntry, deps: AutostartDeps): Promise<AutostartState> {
  if (deps.platform === 'win32') {
    const reg = regExe(deps.env);
    const task = windowsSupervisor(entry, deps);
    const [login, link, supervisor, supervising] = await Promise.all([
      deps.run(reg, ['query', RUN_KEY, '/v', runValueName(entry, deps.osHome)]),
      deps.run(reg, ['query', `${LINK_KEY}\\shell\\open\\command`, '/ve']),
      deps.run(task.schtasks, ['/query', '/tn', task.name, '/xml']),
      deps.supervisorRunning(supervisorAddress(entry.home, 'win32')),
    ]);

    return { login: login.code === 0 ? regValue(login.stdout) : null, link: link.code === 0 ? regValue(link.stdout) : null, supervisor: supervisor.code === 0 ? taskCommand(supervisor.stdout) : null, supervising };
  }

  const paths = linuxPaths(entry, deps);
  const read = (path: string, of: (text: string) => string | null): string | null => (existsSync(path) ? of(readFileSync(path, 'utf8')) : null);

  return { login: read(paths.login, execOf), link: read(paths.link, execOf), supervisor: read(paths.unit, execStartOf), supervising: await deps.supervisorRunning(supervisorAddress(entry.home, deps.platform)) };
}

/** Whether a registered command starts this home's hub: its second quoted argument, the script Node runs, is this home's bundle. */
export function namesBundle(command: string, entry: StartEntry, platform: NodeJS.Platform): boolean {
  const script = /^"[^"]*" "([^"]*)" "start"/.exec(command)?.[1];

  return script !== undefined && (platform === 'win32' ? script.toLowerCase() === entry.bundle.toLowerCase() : script === entry.bundle);
}

/** The steps that turn the login start and the link on: each written over whatever is there. */
export function onSteps(entry: StartEntry, deps: AutostartDeps): Step[] {
  if (deps.platform === 'win32') {
    const reg = regExe(deps.env);
    const command = windowsCommandLine(startArguments(entry));
    const task = windowsSupervisor(entry, deps);

    return [
      { kind: 'run', command: reg, args: ['add', RUN_KEY, '/v', runValueName(entry, deps.osHome), '/t', 'REG_SZ', '/d', command, '/f'] },
      { kind: 'run', command: reg, args: ['add', LINK_KEY, '/ve', '/t', 'REG_SZ', '/d', 'URL:Switchboard', '/f'] },
      { kind: 'run', command: reg, args: ['add', LINK_KEY, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'] },
      { kind: 'run', command: reg, args: ['add', `${LINK_KEY}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f'] },
      // The new definition replaces the old; a supervisor still running the old one stops, so the task's next run starts the new one now.
      { kind: 'remove', path: supervisorOffPath(entry.home) },
      { kind: 'write', path: task.launcher, content: HIDDEN_LAUNCHER },
      { kind: 'write', path: task.xml, content: supervisorTaskXml(entry, deps), utf16: true },
      { kind: 'run', command: task.schtasks, args: ['/create', '/tn', task.name, '/xml', task.xml, '/f'] },
      { kind: 'remove', path: task.xml },
      { kind: 'stop-supervisor', address: supervisorAddress(entry.home, 'win32') },
      { kind: 'run', command: task.schtasks, args: ['/run', '/tn', task.name] },
    ];
  }

  const paths = linuxPaths(entry, deps);
  const unit = supervisorName(entry, deps.osHome, deps.platform);

  return [
    { kind: 'write', path: paths.login, content: desktopEntry(entry, ['X-GNOME-Autostart-enabled=true']) },
    { kind: 'write', path: paths.link, content: desktopEntry(entry, [`MimeType=${LINK_SCHEME};`]) },
    { kind: 'run', command: 'xdg-mime', args: ['default', 'switchboard-link.desktop', LINK_SCHEME] },
    { kind: 'write', path: paths.unit, content: supervisorUnit(entry) },
    { kind: 'run', command: 'systemctl', args: ['--user', 'daemon-reload'] },
    { kind: 'run', command: 'systemctl', args: ['--user', 'enable', unit] },
    // A supervisor the unit did not start would keep the lock, so the unit's own would exit at once.
    { kind: 'stop-supervisor', address: supervisorAddress(entry.home, deps.platform) },
    // A restart, not a start, so a supervisor running an older definition picks up this one; only the supervisor stops (KillMode=process).
    { kind: 'run', command: 'systemctl', args: ['--user', 'restart', unit] },
  ];
}

/** The steps that turn them off: each entry only while it starts this home's hub, and this home's supervisor whatever started it. */
export function offSteps(entry: StartEntry, state: AutostartState, deps: AutostartDeps): Step[] {
  const steps: Step[] = [];
  const ours = state.link !== null && namesBundle(state.link, entry, deps.platform);
  const login = state.login !== null && namesBundle(state.login, entry, deps.platform);
  const supervisor = state.supervisor !== null && supervisesBundle(state.supervisor, entry, deps.platform);

  if (deps.platform === 'win32') {
    const reg = regExe(deps.env);

    if (login) {
      steps.push({ kind: 'run', command: reg, args: ['delete', RUN_KEY, '/v', runValueName(entry, deps.osHome), '/f'] });
    }

    if (ours) {
      steps.push({ kind: 'run', command: reg, args: ['delete', LINK_KEY, '/f'] });
    }

    // The task goes first, so its trigger starts no supervisor after this one stops. Deleting it leaves a running supervisor running, so the
    // supervisor is then asked to exit, whatever started it, rather than Task Scheduler ending it, which could end the hub it started.
    // A supervisor the task launched just before has no lock to be asked on yet; the marker makes it exit once it takes the lock.
    if (supervisor) {
      const task = windowsSupervisor(entry, deps);

      steps.push(
        { kind: 'write', path: supervisorOffPath(entry.home), content: 'hub.js autostart off removed the supervisor task.\n' },
        { kind: 'run', command: task.schtasks, args: ['/delete', '/tn', task.name, '/f'] },
        { kind: 'remove', path: task.launcher },
      );
    }

    if (supervisor || state.supervising) {
      steps.push({ kind: 'stop-supervisor', address: supervisorAddress(entry.home, 'win32') });
    }

    return steps;
  }

  const paths = linuxPaths(entry, deps);

  if (login) {
    steps.push({ kind: 'remove', path: paths.login });
  }

  if (ours) {
    steps.push({ kind: 'remove', path: paths.link });
  }

  if (supervisor) {
    const unit = supervisorName(entry, deps.osHome, deps.platform);

    steps.push({ kind: 'run', command: 'systemctl', args: ['--user', 'disable', '--now', unit] }, { kind: 'remove', path: paths.unit }, { kind: 'run', command: 'systemctl', args: ['--user', 'daemon-reload'] });
  }

  // A supervisor the unit did not start, such as one run by hand, holds the lock while the unit is stopped.
  if (supervisor || state.supervising) {
    steps.push({ kind: 'stop-supervisor', address: supervisorAddress(entry.home, deps.platform) });
  }

  return steps;
}

export function describeStep(step: Step): string {
  switch (step.kind) {
    case 'run':
      return `run ${windowsCommandLine([step.command, ...step.args])}`;
    case 'write':
      return `write ${step.path}${step.utf16 === true ? ' (UTF-16)' : ''}:\n${step.content}`;
    case 'remove':
      return `remove ${step.path}`;
    case 'stop-supervisor':
      return `stop the supervisor on ${step.address}`;
  }
}

/** Runs the steps in order and stops at the first that fails, answering why. */
export async function applySteps(steps: readonly Step[], deps: AutostartDeps): Promise<string | null> {
  const files = deps.files ?? {
    write: (path: string, data: string | Uint8Array) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    },
    remove: (path: string) => rmSync(path, { force: true }),
  };

  for (const step of steps) {
    try {
      if (step.kind === 'write') {
        // schtasks reads a task definition as UTF-16 with a byte order mark.
        files.write(step.path, step.utf16 === true ? Buffer.from(`\ufeff${step.content}`, 'utf16le') : step.content);
      } else if (step.kind === 'remove') {
        files.remove(step.path);
      } else if (step.kind === 'stop-supervisor') {
        await deps.stopSupervisor(step.address);
      } else {
        const result = await deps.run(step.command, step.args);

        if (result.code !== 0) {
          return `${describeStep(step)} failed with exit code ${result.code}: ${result.stdout.trim()}`;
        }
      }
    } catch (error) {
      return `${describeStep(step).split('\n')[0]} failed: ${String(error)}`;
    }
  }

  return null;
}

export interface AutostartCli extends AutostartDeps {
  /** The Switchboard home's parent, resolved. */
  home: string;
  /** The runtime running the command, which the entries run. */
  runtime: string;
  /** Whether that runtime is VS Code's Electron. */
  electron: boolean;
  /** The installed hub, `<home>/.switchboard/hub.js`. */
  bundle: string;
  /** The config folder `hub.js start` reads from config.json, imported first when there is none, or why config.json cannot be used. */
  configDir(persist: boolean): Promise<string | { error: string }>;
  exists(path: string): boolean;
  out(text: string): void;
  err(text: string): void;
}

export const AUTOSTART_USAGE = 'Usage: hub.js autostart [on | off] [--dry-run]\n';

/**
 * `hub.js autostart`: shows, turns on or turns off the login-time start and the `switchboard:` link, which both run `hub.js start` for this home with
 * the Node.js that runs this command, and the supervisor, which runs `hub.js supervise` (architecture.md § Hub lifecycle). `--dry-run` prints the changes and makes none. Exit codes: 0 done, 1
 * usage or refused, 3 a change failed.
 */
export async function runAutostart(rest: readonly string[], cli: AutostartCli): Promise<number> {
  const words = rest.filter((argument) => !argument.startsWith('--'));
  const flags = rest.filter((argument) => argument.startsWith('--'));
  const verb = words[0] ?? 'status';
  if (words.length > 1 || !['status', 'on', 'off'].includes(verb) || flags.some((argument) => argument !== '--dry-run') || (verb === 'status' && flags.length > 0)) {
    cli.err(AUTOSTART_USAGE);
    return 1;
  }

  if (cli.platform !== 'win32' && cli.platform !== 'linux') {
    cli.err(`hub.js autostart works on Windows and Linux, not ${cli.platform}.\n`);
    return 1;
  }

  if (cli.electron) {
    cli.err(`Run hub.js autostart with Node.js, as node ${cli.bundle} autostart, so the hub does not start with VS Code's runtime.\n`);
    return 1;
  }

  const entry: StartEntry = { runtime: cli.runtime, bundle: cli.bundle, home: cli.home };
  const state = await autostartState(entry, cli);
  let folder = '';
  const ours = state.link !== null && namesBundle(state.link, entry, cli.platform);

  const supervisor = state.supervisor !== null && supervisesBundle(state.supervisor, entry, cli.platform);

  if (verb === 'status') {
    const running = state.supervising ? 'running' : 'not running';

    cli.out(
      `Login start: ${state.login ?? 'off'}\nswitchboard: link: ${state.link === null ? 'off' : `${state.link}${ours ? '' : " (another home's hub)"}`}\n` +
        `Supervisor: ${state.supervisor === null ? `off${state.supervising ? ", but one is running for this home" : ''}` : `${state.supervisor} (${supervisor ? running : `another home's hub; this home's is ${running}`})`}\n`,
    );
    return 0;
  }

  if (verb === 'on') {
    const why = unsafe(entry, cli.platform);

    if (why !== null) {
      cli.err(`Refused: ${why}.\n`);
      return 1;
    }

    if (cli.platform === 'win32' && !cli.env['USERNAME']) {
      cli.err('Refused: USERNAME is not set, so the supervisor task cannot name the user whose logon starts it.\n');
      return 1;
    }

    if (!cli.exists(entry.bundle)) {
      cli.err(`No hub is installed in ${entry.bundle}; run <extension folder>/dist/hub.js install first.\n`);
      return 1;
    }

    // The entries start a hub on config.json's folder, so one that cannot be used would leave every login start refused.
    const configDir = await cli.configDir(!flags.includes('--dry-run'));

    if (typeof configDir !== 'string') {
      cli.err(`Refused: ${configDir.error}.\n`);
      return 1;
    }

    folder = configDir;
  }

  const steps = verb === 'on' ? onSteps(entry, cli) : offSteps(entry, state, cli);

  if (flags.includes('--dry-run')) {
    cli.out(steps.length === 0 ? 'Nothing to change.\n' : steps.map((step) => `Would ${describeStep(step)}\n`).join(''));
    return 0;
  }

  const failed = await applySteps(steps, cli);

  if (failed !== null) {
    cli.err(`${failed}\n`);
    return 3;
  }

  const name = supervisorName(entry, cli.osHome, cli.platform);

  if (verb === 'on') {
    cli.out(
      `The hub now starts at login, and ${LINK_URL} links start it, for ${entry.home}, with the config folder config.json names, now ${folder}.${state.link !== null && !ours ? ` This replaced the link that ran ${state.link}.` : ''}` +
        ` A supervisor, the ${cli.platform === 'win32' ? `scheduled task "${name}"` : `systemd user unit ${name}`}, starts it again if it stops without hub.js --stop.\n`,
    );
  } else {
    const kept = [
      state.login !== null && !namesBundle(state.login, entry, cli.platform) ? 'login entry' : null,
      state.link !== null && !ours ? 'switchboard: link' : null,
      state.supervisor !== null && !supervisor ? (cli.platform === 'win32' ? 'supervisor task' : 'supervisor unit') : null,
    ].filter((one) => one !== null);
    const list = kept.length === 1 ? kept[0] : `${kept.slice(0, -1).join(', the ')} and the ${kept.at(-1)}`;

    cli.out(
      kept.length === 0
        ? 'The hub no longer starts at login, switchboard: links no longer start it, and no supervisor starts it again.\n'
        : `The ${list} ${kept.length === 1 ? 'starts' : 'start'} another hub, so ${kept.length === 1 ? 'it was' : 'they were'} left as ${kept.length === 1 ? 'it is' : 'they are'}; anything else of this home's is removed.\n`,
    );
  }

  return 0;
}
