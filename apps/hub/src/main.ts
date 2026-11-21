import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { switchboardHome } from '@switchboard/core';
import { ATTACH_TIMEOUT_MS, buildOf, bundleHome, killProcessTree, connectHolder, currentHolderBuild, createHubApp, findHub, gitBashRoot, handledBody, isSnapshotWorker, postToHub, recordedHubPid, registerTitle, reportBody, runAttach, runHolder, runSnapshotWorker, serveHub, stopHub, ticketBody } from '@switchboard/hub';

declare const __SWITCHBOARD_VERSION__: string | undefined;

/** The extension's esbuild build defines the version; the plain tsc build used by spawn tests does not. */
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
  const hub = await findHub(home, REPORT_TIMEOUT_MS);
  const reply = hub === null ? null : await postToHub(hub, '/ticket', native ? { ...body, nativeSessionId: native } : body, REPORT_TIMEOUT_MS);

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
    const hub = await findHub(home, REPORT_TIMEOUT_MS);
    const reply = hub === null ? null : await postToHub(hub, '/handled', { ...body, nativeSessionId }, REPORT_TIMEOUT_MS);
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
  const hub = await findHub(home, REPORT_TIMEOUT_MS);
  const reply = hub === null ? null : await postToHub(hub, '/report', native ? { ...body, nativeSessionId: native } : body, REPORT_TIMEOUT_MS);

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

  const hub = await findHub(home, REGISTER_TIMEOUT_MS);
  const reply = hub === null ? null : await postToHub(hub, '/register', { nativeSessionId: native, title }, REGISTER_TIMEOUT_MS);

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

/** Returns an exit code, or -1 to keep serving. */
async function main(argv: readonly string[]): Promise<number> {
  const bundle = process.argv[1];

  if (argv[0] === 'report' || argv[0] === 'register' || argv[0] === 'attach' || argv[0] === 'holder' || argv[0] === 'web') {
    // A session runs `<home>/.switchboard/hub.js report …`, so the bundle's location names its home; the extension's own bundle names none.
    const home = flag(argv, 'home') || bundleHome(bundle, homedir());
    const rest = argv.slice(1).filter((argument) => !argument.startsWith('--home'));

    const commands = { report, register, attach, holder, web };

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

  const build = bundle === undefined ? 'unknown' : buildOf(bundle);
  const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const configDir = resolve(flag(argv, 'config') || switchboardHome(home));
  const result = await serveHub({ home, version: VERSION, build, configDir, log, app: () => createHubApp({ home, configDir, log, ...(codeModeIdle === null ? {} : { codeModeIdleMs: Number(codeModeIdle) }), ...(bundle === undefined ? {} : { snapshotWorker: resolve(bundle) }) }), ...(idle > 0 ? { idleMs: idle } : {}), ...(browserPort === null ? {} : { browserPort: Number(browserPort) || null }), ...(pagePort === null ? {} : { pagePort: Number(pagePort) }) });

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
  process.stderr.write(`uncaughtException: ${String(error)}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  process.stderr.write(`unhandledRejection: ${String(error)}\n`);
});

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
