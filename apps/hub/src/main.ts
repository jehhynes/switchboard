import { homedir } from 'node:os';
import { buildOf, findHub, serveHub, stopHub } from '@switchboard/hub';

declare const __SWITCHBOARD_VERSION__: string | undefined;

/** The extension's esbuild build defines the version; the plain tsc build used by spawn tests does not. */
const VERSION = typeof __SWITCHBOARD_VERSION__ === 'string' ? __SWITCHBOARD_VERSION__ : '0.0.0-dev';

function flag(argv: readonly string[], name: string): string | null {
  const match = argv.find((argument) => argument === `--${name}` || argument.startsWith(`--${name}=`));

  if (match === undefined) {
    return null;
  }

  return match.includes('=') ? match.slice(match.indexOf('=') + 1) : '';
}

/** Returns an exit code, or -1 to keep serving. */
async function main(argv: readonly string[]): Promise<number> {
  const home = flag(argv, 'home') || homedir();

  if (flag(argv, 'stop') !== null) {
    const running = await findHub(home);
    const stopped = running !== null && (await stopHub(running));

    process.stdout.write(stopped ? 'Stopped the hub.\n' : 'No hub is running for this home.\n');

    return 0;
  }

  const idle = Number(flag(argv, 'idle-ms'));
  const build = process.argv[1] === undefined ? 'unknown' : buildOf(process.argv[1]);
  const result = await serveHub({ home, version: VERSION, build, ...(idle > 0 ? { idleMs: idle } : {}) });

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
