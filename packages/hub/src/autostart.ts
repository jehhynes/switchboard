import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';

/** What the login start and the `switchboard:` link run: `<runtime> <bundle> start --no-wait --home=<home> --config=<configDir>`. */
export interface StartEntry {
  runtime: string;
  bundle: string;
  home: string;
  configDir: string;
}

export interface AutostartDeps {
  platform: NodeJS.Platform;
  /** The user's own home, whose Switchboard home gets the plain entry names; another home's names carry its hash. */
  osHome: string;
  env: NodeJS.ProcessEnv;
  /** Runs a program without a shell and answers its exit code and output. */
  run(command: string, args: readonly string[]): Promise<{ code: number; stdout: string }>;
}

export type Step = { kind: 'run'; command: string; args: string[] } | { kind: 'write'; path: string; content: string } | { kind: 'remove'; path: string };

/** What is registered now: each entry's command, or null when there is none. */
export interface AutostartState {
  login: string | null;
  link: string | null;
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
  return [entry.runtime, entry.bundle, 'start', '--no-wait', `--home=${entry.home}`, `--config=${entry.configDir}`];
}

/**
 * Why an entry cannot be written safely, or null. Windows expands `%` in a link's command and both platforms split at `"`; a desktop entry's
 * `Exec` also gives meaning to `\`, `$` and \`, which a quoted path would then need escaped twice, so those are refused instead.
 */
export function unsafe(entry: StartEntry, platform: NodeJS.Platform): string | null {
  const refused = platform === 'win32' ? /["%\r\n]/ : /["%\r\n\\$`]/;
  const path = [entry.runtime, entry.bundle, entry.home, entry.configDir].find((one) => refused.test(one));

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

function linuxPaths(entry: StartEntry, deps: AutostartDeps): { login: string; link: string } {
  const hash = suffix(entry, deps.osHome, deps.platform);
  const config = deps.env['XDG_CONFIG_HOME'] || join(deps.osHome, '.config');
  const data = deps.env['XDG_DATA_HOME'] || join(deps.osHome, '.local', 'share');

  return { login: join(config, 'autostart', hash === '' ? 'switchboard.desktop' : `switchboard-${hash}.desktop`), link: join(data, 'applications', 'switchboard-link.desktop') };
}

function desktopEntry(entry: StartEntry, extra: string[]): string {
  return ['[Desktop Entry]', 'Type=Application', 'Name=Switchboard', 'Comment=Starts the Switchboard hub', `Exec=${desktopExec(startArguments(entry))}`, 'Terminal=false', 'NoDisplay=true', ...extra, ''].join('\n');
}

function execOf(text: string): string | null {
  return /^Exec=(.*)$/m.exec(text)?.[1] ?? null;
}

/** The data of a `reg query` answer's REG_SZ line. */
export function regValue(stdout: string): string | null {
  return /\sREG_(?:EXPAND_)?SZ {4}(.*)$/m.exec(stdout.replace(/\r/g, ''))?.[1] ?? null;
}

function regExe(env: NodeJS.ProcessEnv): string {
  // An absolute path, so a reg.exe earlier on PATH cannot stand in for it.
  return join(env['SystemRoot'] || 'C:\\Windows', 'System32', 'reg.exe');
}

/** Reads what is registered, changing nothing. */
export async function autostartState(entry: StartEntry, deps: AutostartDeps): Promise<AutostartState> {
  if (deps.platform === 'win32') {
    const reg = regExe(deps.env);
    const [login, link] = await Promise.all([deps.run(reg, ['query', RUN_KEY, '/v', runValueName(entry, deps.osHome)]), deps.run(reg, ['query', `${LINK_KEY}\\shell\\open\\command`, '/ve'])]);

    return { login: login.code === 0 ? regValue(login.stdout) : null, link: link.code === 0 ? regValue(link.stdout) : null };
  }

  const paths = linuxPaths(entry, deps);
  const read = (path: string): string | null => (existsSync(path) ? execOf(readFileSync(path, 'utf8')) : null);

  return { login: read(paths.login), link: read(paths.link) };
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

    return [
      { kind: 'run', command: reg, args: ['add', RUN_KEY, '/v', runValueName(entry, deps.osHome), '/t', 'REG_SZ', '/d', command, '/f'] },
      { kind: 'run', command: reg, args: ['add', LINK_KEY, '/ve', '/t', 'REG_SZ', '/d', 'URL:Switchboard', '/f'] },
      { kind: 'run', command: reg, args: ['add', LINK_KEY, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'] },
      { kind: 'run', command: reg, args: ['add', `${LINK_KEY}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f'] },
    ];
  }

  const paths = linuxPaths(entry, deps);

  return [
    { kind: 'write', path: paths.login, content: desktopEntry(entry, ['X-GNOME-Autostart-enabled=true']) },
    { kind: 'write', path: paths.link, content: desktopEntry(entry, [`MimeType=${LINK_SCHEME};`]) },
    { kind: 'run', command: 'xdg-mime', args: ['default', 'switchboard-link.desktop', LINK_SCHEME] },
  ];
}

/** The steps that turn them off: each entry only while it starts this home's hub. */
export function offSteps(entry: StartEntry, state: AutostartState, deps: AutostartDeps): Step[] {
  const steps: Step[] = [];
  const ours = state.link !== null && namesBundle(state.link, entry, deps.platform);
  const login = state.login !== null && namesBundle(state.login, entry, deps.platform);

  if (deps.platform === 'win32') {
    const reg = regExe(deps.env);

    if (login) {
      steps.push({ kind: 'run', command: reg, args: ['delete', RUN_KEY, '/v', runValueName(entry, deps.osHome), '/f'] });
    }

    if (ours) {
      steps.push({ kind: 'run', command: reg, args: ['delete', LINK_KEY, '/f'] });
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

  return steps;
}

export function describeStep(step: Step): string {
  switch (step.kind) {
    case 'run':
      return `run ${windowsCommandLine([step.command, ...step.args])}`;
    case 'write':
      return `write ${step.path}:\n${step.content}`;
    case 'remove':
      return `remove ${step.path}`;
  }
}

/** Runs the steps in order and stops at the first that fails, answering why. */
export async function applySteps(steps: readonly Step[], deps: AutostartDeps): Promise<string | null> {
  for (const step of steps) {
    try {
      if (step.kind === 'write') {
        mkdirSync(dirname(step.path), { recursive: true });
        writeFileSync(step.path, step.content);
      } else if (step.kind === 'remove') {
        rmSync(step.path, { force: true });
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
  /** The running hub's config folder, else the Switchboard home. */
  defaultConfigDir(): Promise<string>;
  exists(path: string): boolean;
  out(text: string): void;
  err(text: string): void;
}

export const AUTOSTART_USAGE = 'Usage: hub.js autostart [on | off] [--config=<dir>] [--dry-run]\n';

/**
 * `hub.js autostart`: shows, turns on or turns off the login-time start and the `switchboard:` link, which both run `hub.js start` for this home with
 * the Node.js that runs this command (architecture.md § Hub lifecycle). `--dry-run` prints the changes and makes none. Exit codes: 0 done, 1
 * usage or refused, 3 a change failed.
 */
export async function runAutostart(rest: readonly string[], cli: AutostartCli): Promise<number> {
  const words = rest.filter((argument) => !argument.startsWith('--'));
  const flags = rest.filter((argument) => argument.startsWith('--'));
  const verb = words[0] ?? 'status';
  const config = flags.find((argument) => argument.startsWith('--config='))?.slice('--config='.length);

  if (words.length > 1 || !['status', 'on', 'off'].includes(verb) || flags.some((argument) => argument !== '--dry-run' && !argument.startsWith('--config=')) || (verb === 'status' && flags.length > 0) || config === '') {
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

  // The running hub's config folder by default, so a VS Code window with switchboard.configDir set accepts the hub the login start starts.
  const entry: StartEntry = { runtime: cli.runtime, bundle: cli.bundle, home: cli.home, configDir: (cli.platform === 'win32' ? win32 : posix).resolve(config ?? (await cli.defaultConfigDir())) };
  const state = await autostartState(entry, cli);
  const ours = state.link !== null && namesBundle(state.link, entry, cli.platform);

  if (verb === 'status') {
    cli.out(`Login start: ${state.login ?? 'off'}\nswitchboard: link: ${state.link === null ? 'off' : `${state.link}${ours ? '' : " (another home's hub)"}`}\n`);
    return 0;
  }

  if (verb === 'on') {
    const why = unsafe(entry, cli.platform);

    if (why !== null) {
      cli.err(`Refused: ${why}.\n`);
      return 1;
    }

    if (!cli.exists(entry.bundle)) {
      cli.err(`No hub is installed in ${entry.bundle}; run <extension folder>/dist/hub.js install first.\n`);
      return 1;
    }
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

  if (verb === 'on') {
    cli.out(`The hub now starts at login, and ${LINK_URL} links start it, for ${entry.home} with config folder ${entry.configDir}.${state.link !== null && !ours ? ` This replaced the link that ran ${state.link}.` : ''}\n`);
  } else {
    const kept = [state.login !== null && !namesBundle(state.login, entry, cli.platform) ? 'login entry' : null, state.link !== null && !ours ? 'switchboard: link' : null].filter((one) => one !== null);

    cli.out(kept.length === 0 ? 'The hub no longer starts at login, and switchboard: links no longer start it.\n' : `The ${kept.join(' and the ')} ${kept.length === 1 ? 'starts' : 'start'} another hub, so ${kept.length === 1 ? 'it was' : 'they were'} left as ${kept.length === 1 ? 'it is' : 'they are'}; anything else of this home's is removed.\n`);
  }

  return 0;
}
