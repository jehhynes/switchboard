import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { answers, hubBundlePath, hubLogPath, lockAddress, switchboardHome } from '@switchboard/core';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { ATTACH_TIMEOUT_MS, buildOf, carriesBuilds, installCarried, loadConfigFolder, reportReady, runConfig, startSuccessor, bundleHome, killProcessTree, connectHolder, currentHolderBuild, createHubApp, dropColourOverrides, findHub, gitBashRoot, handledBody, holdSupervisorLock, HubSupervisor, isSnapshotWorker, pendingHandover, postToHub, readStopped, recordedHubPid, registerTitle, reportBody, runAttach, runHolder, runAutostart, runSnapshotWorker, serveHub, START_FLAGS, START_WAIT_MS, startDetached, stopHub, stopSupervisor, supervisorAddress, supervisorOffPath, ticketBody } from '@switchboard/hub';

declare const __SWITCHBOARD_VERSION__: string | undefined;

/** The esbuild builds (apps/hub/carried.cjs) define the version; the plain tsc build used by spawn tests does not. */
const VERSION = typeof __SWITCHBOARD_VERSION__ === 'string' ? __SWITCHBOARD_VERSION__ : '0.0.0-dev';

const REPORT_TIMEOUT_MS = 10_000;
/** Longer than the hub's Claude roster read, 15 seconds, which a registration waits for. */
const REGISTER_TIMEOUT_MS = 30_000;

const REPORT_USAGE = `Usage:
  report stage <sessionId> <stage>
  report worktree <sessionId> <path>
  report done <sessionId>
  report approval <sessionId> --prompt <prompt> [--summary <text>] [--report <path>]
  report link <sessionId> --label <text> --target <http(s) url>
  report handled <sessionId> <ticket url> [--release <assignment key>]
  report paste <sessionId> --label <text> --file <absolute path>
  report question <sessionId> --text <question>
`;

/**
 * Posts a session command to the running hub, and when the hub answers 503 because it is handing over to a new build, which it does before
 * handling the command, posts it again to the hub that takes over, until `timeoutMs` has passed (architecture.md § Hub lifecycle). Null when no
 * hub answers.
 */
async function postCommand(home: string, path: string, body: unknown, timeoutMs: number): Promise<Awaited<ReturnType<typeof postToHub>>> {
  const deadline = Date.now() + timeoutMs;
  let hub = await findHub(home, timeoutMs);

  for (;;) {
    const reply = hub === null ? null : await postToHub(hub, path, body, Math.max(1000, deadline - Date.now()));

    if (hub === null || reply === null || reply.status !== 503) {
      return reply;
    }

    const restarting = hub.token;

    hub = null;

    while (hub === null) {
      if (Date.now() > deadline) {
        return reply;
      }

      await new Promise((done) => setTimeout(done, 250));

      const next = await findHub(home);

      hub = next !== null && next.token !== restarting ? next : null;
    }
  }
}

/** Why the hub took no command: the process `hub.json` names runs but the hub did not answer, or none runs. */
function noHub(home: string): string {
  const pid = recordedHubPid(home);

  return pid === null ? 'The Switchboard hub is not running' : `The Switchboard hub (pid ${pid}) did not answer`;
}

function flag(argv: readonly string[], name: string): string | null {
  const match = argv.find((argument) => argument === `--${name}` || argument.startsWith(`--${name}=`));

  if (match === undefined) {
    return null;
  }

  return match.includes('=') ? match.slice(match.indexOf('=') + 1) : '';
}

/**
 * Moves the session's ad-hoc work item onto a source's ticket and prints its key and the session's report contract (PRD R83). The usage text
 * does not name it, so only a skill the operator invokes runs it. Exit codes as for a report.
 */
async function ticket(home: string, argv: readonly string[]): Promise<number> {
  const body = ticketBody(argv);

  if (body === null) {
    process.stderr.write('Usage: report ticket <sessionId> <ticket url> [--playbook <name>]\n');
    return 1;
  }

  const native = process.env['CLAUDE_CODE_SESSION_ID'];
  const reply = await postCommand(home, '/ticket', native ? { ...body, nativeSessionId: native } : body, REPORT_TIMEOUT_MS);

  if (reply === null) {
    process.stderr.write(`${noHub(home)}; run the command again, which answers the contract of a work item it moved.\n`);
    return 2;
  }

  if (reply.status !== 200) {
    process.stderr.write(`Refused: ${reply.error ?? `status ${reply.status}`}\n`);
    return reply.status === 400 ? 1 : 3;
  }

  const { key, contract } = reply.body as { key: string; contract: string };

  process.stdout.write(`Moved to ${key}. Follow this report contract from now on, in place of any earlier one.\n\n${contract}\n`);
  return 0;
}

/** Exit codes: 0 recorded, 1 usage, 2 no hub, 3 refused (architecture.md § Session reports). */
async function report(home: string, argv: readonly string[]): Promise<number> {
  if (argv[0] === 'handled') {
    const body = handledBody(argv);
    if (body === null) {
      process.stderr.write('Usage: report handled <sessionId> <ticket url> [--release <assignment key>]\n');
      return 1;
    }
    const nativeSessionId = process.env['CLAUDE_CODE_SESSION_ID'];
    const reply = await postCommand(home, '/handled', { ...body, nativeSessionId }, REPORT_TIMEOUT_MS);
    if (reply === null) { process.stderr.write(`${noHub(home)}.\n`); return 2; }
    if (reply.status !== 200) { process.stderr.write(`Refused: ${reply.error ?? reply.status}\n`); return reply.status === 400 ? 1 : 3; }
    process.stdout.write(`${JSON.stringify(reply.body)}\n`);
    return 0;
  }
  if (argv[0] === 'ticket') {
    return ticket(home, argv);
  }

  const body = reportBody(argv, gitBashRoot(process.env));

  if (body === null) {
    process.stderr.write(REPORT_USAGE);
    return 1;
  }

  // Claude names the reporting copy, so the hub can refuse a copy a fork retired (PRD R78).
  const native = process.env['CLAUDE_CODE_SESSION_ID'];
  const reply = await postCommand(home, '/report', native ? { ...body, nativeSessionId: native } : body, REPORT_TIMEOUT_MS);

  if (reply === null) {
    process.stderr.write(`${noHub(home)}, so the report was not recorded.\n`);
    return 2;
  }

  if (reply.status !== 200) {
    process.stderr.write(`Refused: ${reply.error ?? `status ${reply.status}`}\n`);
    return reply.status === 400 ? 1 : 3;
  }

  process.stdout.write('recorded\n');
  return 0;
}

/**
 * Registers the Claude session that runs the command as a work item and prints its report contract (PRD R81). The usage text of `report` does not
 * name it, so only the skill the operator invokes runs it. Exit codes as for a report.
 */
async function register(home: string, argv: readonly string[]): Promise<number> {
  const title = registerTitle(argv);
  const native = process.env['CLAUDE_CODE_SESSION_ID'];

  if (title === null) {
    process.stderr.write('Usage: register --title <text>\n');
    return 1;
  }

  if (!native) {
    process.stderr.write('Only a Claude Code session can register: CLAUDE_CODE_SESSION_ID is not set.\n');
    return 1;
  }

  const reply = await postCommand(home, '/register', { nativeSessionId: native, title }, REGISTER_TIMEOUT_MS);

  if (reply === null) {
    process.stderr.write(`${noHub(home)}; run the command again, which answers the contract of a session it registered.\n`);
    return 2;
  }

  if (reply.status !== 200) {
    process.stderr.write(`Refused: ${reply.error ?? `status ${reply.status}`}\n`);
    return reply.status === 400 ? 1 : 3;
  }

  const { key, contract, already } = reply.body as { key: string; contract: string; already: boolean };

  process.stdout.write(`${already ? 'Already registered' : 'Registered'} as ${key}.\n\n${contract}\n`);
  return 0;
}

/** Attaches this terminal to a Code Mode session until input ends (architecture.md § Attach client). Exit codes: 0 done, 1 usage. */
function attach(home: string, argv: readonly string[]): Promise<number> {
  if (argv.length !== 1 || argv[0] === '') {
    process.stderr.write('Usage: attach <session ID>\n');
    return Promise.resolve(1);
  }

  const stdin = process.stdin;

  stdin.setEncoding('utf8');

  return runAttach({
    sessionId: argv[0]!,
    post: async (body) => {
      const hub = await findHub(home);
      const reply = hub === null ? null : await postToHub(hub, '/attach', body, ATTACH_TIMEOUT_MS);

      return reply ?? `${noHub(home)}.`;
    },
    size: () => ({ cols: process.stdout.columns || 120, rows: process.stdout.rows || 40 }),
    write: (text) => process.stdout.write(text),
    raw: (on) => {
      if (stdin.isTTY) {
        stdin.setRawMode(on);
      }
    },
    onInput: (listener) => stdin.on('data', listener),
    onResize: (listener) => process.stdout.on('resize', listener),
    onEnd: (listener) => stdin.on('end', listener),
  });
}

/** Lists or stops held sessions (architecture.md § Visibility of held sessions). Exit codes as `runHolder`'s. */
function holder(home: string, argv: readonly string[]): Promise<number> {
  return runHolder(argv, {
    post: async (path, body) => {
      const hub = await findHub(home, REPORT_TIMEOUT_MS);
      // A stop waits for the holder's kill, which answers within 15 seconds.
      const reply = hub === null ? null : await postToHub(hub, path, body, REGISTER_TIMEOUT_MS);

      return reply ?? noHub(home);
    },
    holder: () => connectHolder(switchboardHome(home)),
    installed: () => currentHolderBuild(switchboardHome(home)),
    now: () => Date.now(),
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM: it runs, under another user.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    killTree: (pid) => killProcessTree(pid),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}

/**
 * Prints a one-time link to the web page; with `pair`, a pairing link and code for another device; with `devices`, the signed-in devices; with
 * `revoke`, signs every device out, or with an ID that one (architecture.md § Web page, § Remote access). Exit codes: 0 done, 2 no hub, 3 refused.
 */
async function web(home: string, rest: readonly string[]): Promise<number> {
  const words = rest.filter((argument) => !argument.startsWith('--'));
  const [verb = 'link', id] = words;
  const known = verb === 'link' ? words.length === 0 : verb === 'revoke' ? words.length <= 2 : (verb === 'pair' || verb === 'devices') && words.length === 1;

  if (!known) {
    process.stderr.write(`Usage: hub.js web [pair | devices | revoke [<device ID>]]\n`);
    return 1;
  }

  const route = verb === 'link' ? '/page/link' : `/page/${verb}`;
  const hub = await findHub(home, REPORT_TIMEOUT_MS);
  const reply = hub === null ? null : await postToHub(hub, route, verb === 'revoke' && id !== undefined ? { id } : {}, REPORT_TIMEOUT_MS);

  if (reply === null) {
    process.stderr.write(`${noHub(home)}.\n`);
    return 2;
  }

  const body = (reply.body ?? {}) as Record<string, unknown>;

  if (reply.status !== 200) {
    process.stderr.write(`Refused: ${typeof body['error'] === 'string' ? body['error'] : (reply.error ?? `status ${reply.status}`)}\n`);
    return 3;
  }

  if (verb === 'revoke') {
    process.stdout.write(id !== undefined ? `Signed out device ${id}.\n` : `Signed out every browser (${String(body['revoked'])} sign-ins). Open a new link to use the web page again.\n`);
    return 0;
  }

  if (verb === 'pair') {
    process.stdout.write(`Open this link on the device within five minutes; it works once:\n${String(body['url'])}\nOr open https://${String(body['host'])}/ on the device and type the code ${String(body['code'])}.\n`);
    return 0;
  }

  if (verb === 'devices') {
    const devices = Array.isArray(body['devices']) ? (body['devices'] as Array<{ id: string; label: string; host: string | null; login: string | null; usedAt: number }>) : [];

    process.stdout.write(
      devices.length === 0
        ? 'No device is signed in.\n'
        : devices.map((one) => `${one.id}  ${one.label || 'Unknown device'}  ${one.host === null ? 'this computer' : `${one.host} as ${String(one.login)}`}  last used ${new Date(one.usedAt).toLocaleString()}\n`).join(''),
    );
    return 0;
  }

  const url = body['url'];

  if (typeof url !== 'string') {
    process.stderr.write(`Refused: status ${reply.status}\n`);
    return 3;
  }

  const notice = body['notice'];

  if (typeof notice === 'string') {
    process.stderr.write(`${notice}\n`);
  }

  process.stdout.write(`Open this link in a browser on this machine within two minutes; it works once:\n${url}\n`);
  return 0;
}

/**
 * Installs the builds a build folder carries into the home (architecture.md § Hub lifecycle): the running hub restarts onto the hub bundle
 * once quiet, and `--wait` waits for that, as `hub.js restart` does. Run as `apps/hub/dist/install/hub.js install` (`npm run install-local`).
 * Exit codes: 0 installed,
 * 1 usage or not a build folder, 3 a program that could not be installed, 4 with `--wait`, the hub not restarted within 60 seconds.
 */
async function install(home: string, rest: readonly string[], bundle: string | undefined): Promise<number> {
  const dist = bundle === undefined ? null : dirname(resolve(bundle));

  if (rest.some((argument) => argument !== '--wait') || dist === null) {
    process.stderr.write('Usage: <build folder>/hub.js install [--wait] [--home=<dir>]\n');
    return 1;
  }

  if (!carriesBuilds(dist) || resolve(dist, 'hub.js') === resolve(hubBundlePath(home))) {
    process.stderr.write(`Run the hub.js of a Switchboard build folder, such as apps/hub/dist/install; ${dist} carries no terminal holder build.\n`);
    return 1;
  }

  // Found before the bundle is replaced: once it is, the hub can restart onto it by itself while the programs install, and then no hub answers
  // for a moment.
  const running = await findHub(home);
  const installed = installCarried(dist, home);
  const errors = await installed.programs;
  const build = buildOf(hubBundlePath(home));

  process.stdout.write(`${installed.hub ? 'Installed' : 'Already installed:'} hub build ${build} in ${hubBundlePath(home)}.\n`);

  for (const error of errors) {
    process.stderr.write(`${error}\n`);
  }

  // The installed hub starts on config.json's folder, so import it now (architecture.md § Config folder).
  // A running hub's folder is what a window or a login entry chose, and its restart onto this build reads config.json.
  const loaded = loadConfigFolder(configDeps(home), null, { running: running?.configDir ?? null });

  if ('error' in loaded) {
    process.stderr.write(`${loaded.error}.\n`);
  } else {
    for (const notice of loaded.notices) {
      process.stderr.write(`${notice}\n`);
    }

    process.stdout.write(`Config folder: ${loaded.dir}.\n`);
  }

  const failed = errors.length > 0 || 'error' in loaded ? 3 : 0;

  if (running === null || running.build === build) {
    return failed;
  }

  if (!rest.includes('--wait')) {
    process.stdout.write(`The running hub (pid ${running.pid}, build ${running.build}) restarts onto it once it is quiet; hub.js restart waits for that.\n`);
    return failed;
  }

  process.stdout.write(`The running hub (pid ${running.pid}, build ${running.build}) restarts onto it once it is quiet; waiting for that.\n`);

  // Asking reports what the restart waits for, and tries again a build whose successor failed. The hub may already be handing over, having seen
  // the new bundle itself, and then refuses or does not answer; the wait below covers that too.
  const reply = await postToHub(running, '/restart', {}, REPORT_TIMEOUT_MS);
  const waiting = reply?.status === 200 ? (reply.body as { waiting: string | null }).waiting : null;

  if (waiting !== null) {
    process.stdout.write(`It waits until it is quiet: ${waiting}.\n`);
  }

  const found = await newHub(home, running.token);

  if (found === null) {
    process.stderr.write(`The hub has not restarted within ${RESTART_WAIT_MS / 1000} seconds; it restarts once it is quiet. See ${hubLogPath(home)}.\n`);
    return 4;
  }

  process.stdout.write(`Restarted: pid ${found.pid}, build ${found.build}.\n`);
  return failed;
}

/** How long `hub.js restart` waits for the new hub. */
const RESTART_WAIT_MS = 60_000;

/** The hub that took over from the hub with `token`, within `hub.js restart`'s wait, or null. */
async function newHub(home: string, token: string): Promise<Awaited<ReturnType<typeof findHub>>> {
  for (const deadline = Date.now() + RESTART_WAIT_MS; Date.now() < deadline; ) {
    await new Promise((done) => setTimeout(done, 250));

    const found = await findHub(home);

    if (found !== null && found.token !== token) {
      return found;
    }
  }

  return null;
}

/**
 * Restarts the running hub onto the installed bundle once it is quiet, and waits for the new hub (architecture.md § Hub lifecycle). Exit codes: 0
 * restarted, 1 usage, 2 no hub, 3 refused, 4 not restarted within 60 seconds.
 */
async function restart(home: string, rest: readonly string[]): Promise<number> {
  if (rest.length > 0) {
    process.stderr.write('Usage: hub.js restart\n');
    return 1;
  }

  const hub = await findHub(home, REPORT_TIMEOUT_MS);
  const reply = hub === null ? null : await postToHub(hub, '/restart', {}, REPORT_TIMEOUT_MS);

  if (hub === null || reply === null) {
    process.stderr.write(`${noHub(home)}.\n`);
    return 2;
  }

  if (reply.status !== 200) {
    process.stderr.write(`Refused: ${reply.error ?? `status ${reply.status}`}\n`);
    return 3;
  }

  const { installed, waiting } = reply.body as { installed: string; waiting: string | null };

  process.stdout.write(`Restarting the hub (pid ${hub.pid}, build ${hub.build}) onto build ${installed}${waiting === null ? '' : `; it waits until it is quiet: ${waiting}`}.\n`);

  const found = await newHub(home, hub.token);

  if (found !== null) {
    process.stdout.write(`Restarted: pid ${found.pid}, build ${found.build}.\n`);
    return 0;
  }

  process.stderr.write(`The hub has not restarted within ${RESTART_WAIT_MS / 1000} seconds; it restarts once it is quiet. See ${hubLogPath(home)}.\n`);
  return 4;
}

const START_USAGE = `Usage: hub.js start [--config=<dir>] [--no-wait] [${START_FLAGS.filter((name) => name !== 'config').map((name) => `--${name}=<value>`).join('] [')}]\n`;

/**
 * Starts the installed hub detached, when none runs for the home, with the runtime that runs this command, and waits for it (architecture.md
 * § Hub lifecycle); `--no-wait`, for a login start or a link, returns once it is started. Exit codes: 0 running or started, 1 usage or no
 * installed hub, 4 not started.
 */
async function start(home: string, rest: readonly string[]): Promise<number> {
  const passed = rest.filter((argument) => argument !== '--no-wait');

  if (passed.some((argument) => !(START_FLAGS as readonly string[]).some((name) => argument.startsWith(`--${name}=`)))) {
    process.stderr.write(START_USAGE);
    return 1;
  }

  const running = await findHub(home);

  if (running !== null) {
    process.stdout.write(`The hub is already running: pid ${running.pid}, build ${running.build}, config folder ${running.configDir}.\n`);
    return 0;
  }

  const bundle = hubBundlePath(home);

  if (!existsSync(bundle)) {
    process.stderr.write(`No hub is installed in ${bundle}; run npm run install-local in the repository, or hub.js install from a build folder, first.\n`);
    return 1;
  }

  const loaded = loadConfigFolder(configDeps(home), flag(passed, 'config'));

  if ('error' in loaded) {
    process.stderr.write(`Not starting: ${loaded.error}.\n`);
    return 1;
  }

  for (const notice of loaded.notices) {
    process.stderr.write(`${notice}\n`);
  }

  const configDir = loaded.dir;
  const child = startDetached(process.execPath, bundle, home, [`--home=${home}`, `--config=${configDir}`, ...passed.filter((argument) => !argument.startsWith('--config='))]);

  if (rest.includes('--no-wait')) {
    process.stdout.write(`Starting the hub (pid ${child.pid}); its output goes to ${hubLogPath(home)}.\n`);
    return 0;
  }

  const ended: { code: number | null } = { code: null };

  child.on('exit', (code) => (ended.code = code ?? 1));
  child.on('error', () => (ended.code = 1));

  for (const deadline = Date.now() + START_WAIT_MS; Date.now() < deadline; ) {
    await new Promise((done) => setTimeout(done, 100));

    const found = await findHub(home);

    if (found !== null) {
      process.stdout.write(`Started the hub: pid ${found.pid}, build ${found.build}, config folder ${found.configDir}.\n`);
      return 0;
    }

    if (ended.code !== null) {
      process.stderr.write(`The hub exited with code ${ended.code}; see ${hubLogPath(home)}.\n`);
      return 4;
    }
  }

  process.stderr.write(`The hub did not start within ${START_WAIT_MS / 1000} seconds; see ${hubLogPath(home)}.\n`);
  return 4;
}

/** Runs `hub.js autostart` with the real registry or desktop entries (architecture.md § Hub lifecycle). */
async function autostart(home: string, rest: readonly string[]): Promise<number> {
  return runAutostart(rest, {
    platform: process.platform,
    osHome: homedir(),
    env: process.env,
    run: (command, args) =>
      new Promise((done) =>
        execFile(command, args, { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) =>
          done({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout: `${stdout}${stderr}` }),
        ),
      ),
    home: resolve(home),
    runtime: process.execPath,
    electron: process.versions['electron'] !== undefined,
    bundle: hubBundlePath(home),
    configDir: async (persist) => {
      const loaded = loadConfigFolder(configDeps(home), null, { persist, running: (await findHub(home))?.configDir ?? null });

      return 'error' in loaded ? loaded : loaded.dir;
    },
    supervisorRunning: answers,
    stopSupervisor: async (address) => {
      // The step names this home's supervisor address; the request goes there with this home's token.
      const stopped = address === supervisorAddress(home) ? await stopSupervisor(home) : false;

      // Task Scheduler counts the task as running until wscript.exe, which waits for the supervisor, has exited too, and ignores a run meanwhile.
      if (stopped && process.platform === 'win32') {
        await new Promise((done) => setTimeout(done, 1_000));
      }

      return stopped;
    },
    exists: existsSync,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}

function configDeps(home: string): { home: string; osHome: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv } {
  return { home: resolve(home), osHome: homedir(), platform: process.platform, env: process.env };
}

/** Shows or sets the config folder in config.json (architecture.md § Config folder). Exit codes as `runConfig`'s. */
function config(home: string, rest: readonly string[]): Promise<number> {
  return runConfig(rest, {
    ...configDeps(home),
    running: async () => (await findHub(home))?.configDir ?? null,
    restart: () => restart(home, []),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}

const SUPERVISE_USAGE = `Usage: hub.js supervise [--config=<dir>] [--grace-ms=<ms>] [--check-ms=<ms>] [${START_FLAGS.filter((name) => name !== 'config').map((name) => `--${name}=<value>`).join('] [')}]\n`;

/**
 * Runs the supervisor that the autostart task or unit starts: it starts the installed hub again, with this runtime and the config folder `--config`
 * names, else the one config.json names (architecture.md § Config folder), when the hub has gone without `hub.js --stop` (architecture.md § Hub lifecycle), passing on the serving flags as `hub.js start` does. It logs to the hub log. Exit codes: 0 asked to stop or another
 * supervisor runs, 1 usage or VS Code's runtime.
 */
async function supervise(home: string, rest: readonly string[]): Promise<number> {
  const known = [...START_FLAGS, 'grace-ms', 'check-ms'];
  const passed = rest.filter((argument) => (START_FLAGS as readonly string[]).some((name) => name !== 'config' && argument.startsWith(`--${name}=`)));
  const named = flag(rest, 'config') || null;

  if (rest.some((argument) => !known.some((name) => argument.startsWith(`--${name}=`))) || [flag(rest, 'grace-ms'), flag(rest, 'check-ms')].some((value) => value !== null && !/^\d+$/.test(value))) {
    process.stderr.write(SUPERVISE_USAGE);
    return 1;
  }

  if (process.platform !== 'win32' && process.platform !== 'linux') {
    process.stderr.write(`hub.js supervise works on Windows and Linux, not ${process.platform}.\n`);
    return 1;
  }

  if (process.versions['electron'] !== undefined) {
    process.stderr.write("Run hub.js supervise with Node.js, so the hubs it starts do not run on VS Code's runtime.\n");
    return 1;
  }

  const bundle = hubBundlePath(home);
  // Without --config the hub reads config.json each time it starts, so hub.js config set holds for the hubs this starts too.
  const configArgs = named === null ? [] : [`--config=${resolve(named)}`];
  const log = (line: string): void => {
    try {
      appendFileSync(hubLogPath(home), `${new Date().toISOString()} supervisor: ${line}\n`);
    } catch {
      // A log that cannot be written must not stop the supervisor.
    }
  };
  const grace = flag(rest, 'grace-ms');
  const check = flag(rest, 'check-ms');
  const supervisor = new HubSupervisor({
    hubLocked: () => answers(lockAddress(home)),
    handover: () => pendingHandover(home) !== null,
    stopped: () => readStopped(home),
    start: () => {
      if (!existsSync(bundle)) {
        return `no hub is installed in ${bundle}`;
      }

      try {
        startDetached(process.execPath, bundle, home, [`--home=${home}`, ...configArgs, ...passed]).on('error', (error) => log(`the hub did not start: ${error.message}`));
        return null;
      } catch (error) {
        return String(error);
      }
    },
    now: Date.now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    log,
    ...(grace === null ? {} : { graceMs: Number(grace) }),
    ...(check === null ? {} : { checkMs: Number(check) }),
  });

  mkdirSync(switchboardHome(home), { recursive: true });

  const lock = await holdSupervisorLock(home, () => {
    log('stopping: asked by hub.js autostart');
    supervisor.stop();
  });

  if (lock === null) {
    process.stdout.write(`A supervisor is already running for this home on ${supervisorAddress(home)}.\n`);
    return 0;
  }

  // Checked once the lock is held, so hub.js autostart off either finds this supervisor on its lock or has written the marker first.
  if (existsSync(supervisorOffPath(home))) {
    lock.close();
    log('not starting: hub.js autostart off removed the supervisor; hub.js autostart on turns it on again');
    process.stdout.write('hub.js autostart off removed the supervisor; run hub.js autostart on to turn it on again.\n');
    return 0;
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log(`stopping: received ${signal}`);
      supervisor.stop();
    });
  }

  log(`watching the hub for ${home} as pid ${process.pid}, starting it with ${named === null ? 'the config folder config.json names' : `config folder ${resolve(named)}`}`);
  await supervisor.run();
  lock.close();

  return 0;
}

/** Returns an exit code, or -1 to keep serving. */
async function main(argv: readonly string[]): Promise<number> {
  const bundle = process.argv[1];

  if (argv[0] === 'report' || argv[0] === 'register' || argv[0] === 'attach' || argv[0] === 'holder' || argv[0] === 'web' || argv[0] === 'restart' || argv[0] === 'install' || argv[0] === 'start' || argv[0] === 'autostart' || argv[0] === 'config' || argv[0] === 'supervise') {
    // A session runs `<home>/.switchboard/hub.js report …`, so the bundle's location names its home; a build folder's bundle names none.
    const home = flag(argv, 'home') || bundleHome(bundle, homedir());
    const rest = argv.slice(1).filter((argument) => !argument.startsWith('--home'));

    const commands = { report, register, attach, holder, web, restart, start, autostart, config, supervise, install: (home: string, rest: readonly string[]) => install(home, rest, bundle) };

    return commands[argv[0] as keyof typeof commands](home, rest);
  }

  const home = flag(argv, 'home') || homedir();

  if (flag(argv, 'stop') !== null) {
    const running = await findHub(home);
    const stopped = running !== null && (await stopHub(running));

    process.stdout.write(stopped ? 'Stopped the hub.\n' : 'No hub is running for this home.\n');

    return 0;
  }

  const idle = Number(flag(argv, 'idle-ms'));
  const codeModeIdle = flag(argv, 'code-mode-idle-ms');

  if (codeModeIdle !== null && !/^[1-9]\d*$/.test(codeModeIdle)) {
    process.stderr.write(`--code-mode-idle-ms takes a whole number of milliseconds above 0, not "${codeModeIdle}".\n`);

    return 1;
  }

  // --browser-port=0 serves no browser endpoint, and --page-port=0 the web page only on the hub's port, for a second hub such as a test's.
  const browserPort = flag(argv, 'browser-port');
  const pagePort = flag(argv, 'page-port');

  if (pagePort !== null && !/^\d+$/.test(pagePort)) {
    process.stderr.write(`--page-port takes a port number, not "${pagePort}".\n`);

    return 1;
  }

  const takeover = flag(argv, 'takeover');

  if (takeover !== null && !/^[1-9]\d*$/.test(takeover)) {
    process.stderr.write(`--takeover takes the pid of the hub to take over from, not "${takeover}".\n`);

    return 1;
  }

  // A successor's bundle has loaded, so the hub it takes over from can hand over (architecture.md § Hub lifecycle).
  if (takeover !== null) {
    reportReady();
  }

  const build = bundle === undefined ? 'unknown' : buildOf(bundle);
  const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const loaded = loadConfigFolder(configDeps(home), flag(argv, 'config'));

  if ('error' in loaded) {
    process.stderr.write(`Not starting: ${loaded.error}; pid ${process.pid} exiting.\n`);

    return 1;
  }

  for (const notice of loaded.notices) {
    log(notice);
  }

  const configDir = loaded.dir;
  const result = await serveHub({ home, version: VERSION, build, configDir, log, app: (carried) => createHubApp({ home, configDir, log, handover: carried, ...(codeModeIdle === null ? {} : { codeModeIdleMs: Number(codeModeIdle) }), ...(bundle === undefined ? {} : { snapshotWorker: resolve(bundle) }) }), ...(idle > 0 ? { idleMs: idle } : {}), ...(takeover === null ? {} : { takeover: Number(takeover) }), restart: { bundle: hubBundlePath(home), successor: () => startSuccessor({ execPath: process.execPath, bundle: hubBundlePath(home), args: argv, env: process.env, logPath: hubLogPath(home) }) }, ...(browserPort === null ? {} : { browserPort: Number(browserPort) || null }), ...(pagePort === null ? {} : { pagePort: Number(pagePort) }) });

  if ('existing' in result) {
    process.stdout.write(`A hub is already running for this home on port ${result.existing.port}; pid ${process.pid} exiting.\n`);

    return 0;
  }

  if ('refused' in result) {
    process.stderr.write(`Not starting: ${result.refused}; pid ${process.pid} exiting.\n`);

    return 1;
  }

  // Foreground runs only: a Windows process without a console receives no signals (GC M25).
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void result.served.stop(`received ${signal}`).then(() => process.exit(0)));
  }

  return -1;
}

// node:sqlite prints an ExperimentalWarning when the store opens (mechanics M1); it is expected, so keep it out of the log.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes('SQLite is an experimental feature')) {
    return;
  }

  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

process.on('uncaughtException', (error) => {
  process.stderr.write(`uncaughtException: ${error instanceof Error && error.stack !== undefined ? error.stack : String(error)}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  process.stderr.write(`unhandledRejection: ${String(error)}\n`);
});

// Every hub.js command, the supervisor and `start` included, so nothing it starts inherits them (mechanics M149).
dropColourOverrides(process.env);

// The hub runs its own bundle again as its snapshot worker (architecture.md § Hub lifecycle).
if (isSnapshotWorker()) {
  runSnapshotWorker();
} else {
  void main(process.argv.slice(2))
    .then((code) => {
      if (code >= 0) {
        process.exit(code);
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`Hub failed: ${String(error)}\n`);
      process.exit(1);
    });
}
