import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { switchboardHome } from '@switchboard/core';
import { buildOf, createHubApp, findHub, gitBashRoot, postToHub, reportBody, serveHub, stopHub } from '@switchboard/hub';

declare const __SWITCHBOARD_VERSION__: string | undefined;

/** The extension's esbuild build defines the version; the plain tsc build used by spawn tests does not. */
const VERSION = typeof __SWITCHBOARD_VERSION__ === 'string' ? __SWITCHBOARD_VERSION__ : '0.0.0-dev';

const REPORT_TIMEOUT_MS = 10_000;

const REPORT_USAGE = `Usage:
  report stage <sessionId> <stage>
  report worktree <sessionId> <path>
  report done <sessionId>
  report approval <sessionId> --prompt <prompt> [--summary <text>] [--report <path>]
  report link <sessionId> --label <text> --target <http(s) url>
  report paste <sessionId> --label <text> --file <absolute path>
  report question <sessionId> --text <question>
`;

function flag(argv: readonly string[], name: string): string | null {
  const match = argv.find((argument) => argument === `--${name}` || argument.startsWith(`--${name}=`));

  if (match === undefined) {
    return null;
  }

  return match.includes('=') ? match.slice(match.indexOf('=') + 1) : '';
}

/** Exit codes: 0 recorded, 1 usage, 2 no hub, 3 refused (architecture.md § Session reports). */
async function report(home: string, argv: readonly string[]): Promise<number> {
  const body = reportBody(argv, gitBashRoot(process.env));

  if (body === null) {
    process.stderr.write(REPORT_USAGE);
    return 1;
  }

  const hub = await findHub(home);
  const reply = hub === null ? null : await postToHub(hub, '/report', body, REPORT_TIMEOUT_MS);

  if (reply === null) {
    process.stderr.write('The Switchboard hub is not running, so the report was not recorded.\n');
    return 2;
  }

  if (reply.status !== 200) {
    process.stderr.write(`Refused: ${reply.error ?? `status ${reply.status}`}\n`);
    return reply.status === 400 ? 1 : 3;
  }

  process.stdout.write('recorded\n');
  return 0;
}

/** Returns an exit code, or -1 to keep serving. */
async function main(argv: readonly string[]): Promise<number> {
  const bundle = process.argv[1];

  if (argv[0] === 'report') {
    // A session runs `<home>/.switchboard/hub.js report …`, so the bundle's location names its home.
    const home = flag(argv, 'home') || (bundle === undefined ? homedir() : dirname(dirname(resolve(bundle))));

    return report(home, argv.slice(1).filter((argument) => !argument.startsWith('--home')));
  }

  const home = flag(argv, 'home') || homedir();

  if (flag(argv, 'stop') !== null) {
    const running = await findHub(home);
    const stopped = running !== null && (await stopHub(running));

    process.stdout.write(stopped ? 'Stopped the hub.\n' : 'No hub is running for this home.\n');

    return 0;
  }

  const idle = Number(flag(argv, 'idle-ms'));
  // --browser-port=0 serves no browser endpoint, for a second hub such as a test's.
  const browserPort = flag(argv, 'browser-port');
  const build = bundle === undefined ? 'unknown' : buildOf(bundle);
  const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const configDir = resolve(flag(argv, 'config') || switchboardHome(home));
  const result = await serveHub({ home, version: VERSION, build, configDir, log, app: () => createHubApp({ home, configDir, log }), ...(idle > 0 ? { idleMs: idle } : {}), ...(browserPort === null ? {} : { browserPort: Number(browserPort) || null }) });

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
