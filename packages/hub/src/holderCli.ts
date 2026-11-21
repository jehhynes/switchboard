import { readFileSync } from 'node:fs';
import { FEATURES, HolderClient, PROTOCOL, parseHolderRecord, recordPath } from '@switchboard/holder';
import type { SessionEntry } from '@switchboard/holder';
import { findHeld, heldFromHolder, heldTexts } from './held.js';
import type { HeldSession } from './held.js';

const USAGE = 'Usage:\n  holder list\n  holder stop <Switchboard session ID, Claude session ID or its first 8 characters>\n  holder stop --all [--yes]\n';

/** How long `stop --all` waits for the holder to exit after `shutdown` before it ends its process tree. */
const HOLDER_EXIT_MS = 10_000;
const POLL_MS = 100;
/** How long the CLI waits for the holder to answer `list` or `shutdown`, and `kill`, which ends a process tree, so a holder that stopped answering fails the command rather than hang it. */
const HOLDER_ANSWER_MS = 5_000;
const HOLDER_KILL_MS = 20_000;

/** The holder's answer, or a failure once it has not answered in `ms`. */
function answered<T>(request: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([request, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('The terminal holder did not answer.')), ms)))]).finally(() => clearTimeout(timer));
}

/** The holder's `welcome`: who answers, and what it serves. */
export interface HolderIdentity {
  protocol: number;
  build: string;
  pid: number;
  features?: string[];
}

/** The holder calls the CLI makes while the hub is down; `list` and `kill` are the same in every protocol. */
export interface HolderControl {
  readonly welcome: HolderIdentity;
  list(): Promise<SessionEntry[]>;
  kill(session: string): Promise<number | null>;
  /** Asks the holder to exit; refused while it holds a live session. */
  shutdown(): Promise<void>;
  close(): void;
}

export interface HolderCliDeps {
  /** Posts to the hub; a string says why no hub answered. */
  post(path: '/holder/list' | '/holder/stop', body: unknown): Promise<{ status: number; error: string | null; body: unknown } | string>;
  /** The holder `holder.json` names, or null when there is none or it does not answer. */
  holder(): Promise<HolderControl | null>;
  now(): number;
  /** Whether a process runs with this pid. */
  alive(pid: number): boolean;
  /** Ends a process and its descendants, as `taskkill /T /F` does; the error when it could not. */
  killTree(pid: number): Promise<{ error: string } | null>;
  sleep(ms: number): Promise<void>;
  out(text: string): void;
  err(text: string): void;
}

/** Connects to the holder of a Switchboard home with any protocol, checking that the process answering is the one the record names. */
export async function connectHolder(switchboardHome: string): Promise<HolderControl | null> {
  let record;

  try {
    record = parseHolderRecord(readFileSync(recordPath(switchboardHome), 'utf8'));
  } catch {
    return null;
  }

  if (record === null) {
    return null;
  }

  try {
    const client = await HolderClient.connect({ port: record.port, token: record.token });

    if (client.welcome.pid === record.pid) {
      return client;
    }

    client.close();
  } catch {
    // Not answering, as after the holder exited.
  }

  return null;
}

export { idleText } from './held.js';
export { killTree as killProcessTree } from '@switchboard/holder';

/** Whether a holder lacks a request this build sends, as one from an older build does. */
export function olderHolder(welcome: HolderIdentity): boolean {
  return welcome.protocol !== PROTOCOL || FEATURES.some((feature) => !(welcome.features ?? []).includes(feature));
}

/** A line naming the holder, marked when it is from an older build. */
export function holderLine(welcome: HolderIdentity): string {
  const lacks = welcome.protocol === PROTOCOL && (welcome.features ?? []).includes('write') ? 'cannot show its sessions in the web page\'s console' : 'cannot type into sessions';
  const older = olderHolder(welcome) ? `; it is from an older build and ${lacks}, and \`holder stop --all\` ends it so the next session starts this build` : '';

  return `Terminal holder: pid ${welcome.pid}, build ${welcome.build}, protocol ${welcome.protocol}${older}.\n`;
}

/** A plain table of the held sessions, one row each. */
export function heldTable(held: readonly HeldSession[], now: number): string {
  if (held.length === 0) {
    return 'No held sessions.\n';
  }

  const rows = [
    ['Work item', 'Switchboard ID', 'Claude ID', 'Folder', 'State', 'Idle', 'Memory', 'Terminals'],
    ...held.map((one) => {
      const texts = heldTexts(one, now);

      return [texts.item, one.session, texts.nativeSessionId, one.cwd, one.state, texts.idle, texts.memory, String(one.clients)];
    }),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));

  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join('  ')).join('\n') + '\n';
}

/**
 * `hub.js holder list`, `hub.js holder stop <id>` and `hub.js holder stop --all [--yes]` (architecture.md § Visibility of held sessions): through
 * the hub when it answers, else through the holder, with the work item key and Claude session ID its labels give. Exit codes: 0 done, 1 usage,
 * 2 neither the hub nor the holder answered (stop), 3 refused or not found.
 */
export async function runHolder(argv: readonly string[], deps: HolderCliDeps): Promise<number> {
  const [command, id, ...rest] = argv;

  if (command === 'stop' && id === '--all' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--yes'))) {
    return stopAll(rest.length === 1, deps);
  }

  if (!((command === 'list' && id === undefined) || (command === 'stop' && id !== undefined && id !== '' && !id.startsWith('--') && rest.length === 0))) {
    deps.err(USAGE);
    return 1;
  }

  const reply = await deps.post(command === 'list' ? '/holder/list' : '/holder/stop', command === 'list' ? {} : { id });

  if (typeof reply !== 'string') {
    if (reply.status !== 200) {
      deps.err(`Refused: ${reply.error ?? `status ${reply.status}`}\n`);
      return reply.status === 400 ? 1 : 3;
    }

    if (command === 'list') {
      const body = reply.body as { sessions: HeldSession[]; holder?: HolderIdentity | null };
      const older = body.holder != null && olderHolder(body.holder) ? holderLine(body.holder) : '';

      deps.out(older + heldTable(body.sessions, deps.now()));
    } else {
      deps.out(`Stopped held session ${(reply.body as { stopped: string }).stopped}.\n`);
    }

    return 0;
  }

  const holder = await deps.holder();

  if (holder === null) {
    if (command === 'list') {
      deps.out('No terminal holder is running.\n');
      return 0;
    }

    deps.err(`${reply}, and no terminal holder is running.\n`);
    return 2;
  }

  try {
    const held = (await answered(holder.list(), HOLDER_ANSWER_MS)).map(heldFromHolder);

    if (command === 'list') {
      deps.out(`${reply}, so this is the terminal holder's own list.\n${olderHolder(holder.welcome) ? holderLine(holder.welcome) : ''}${heldTable(held, deps.now())}`);
      return 0;
    }

    const found = findHeld(held, id!);

    if ('refused' in found) {
      deps.err(`Refused: ${found.refused}\n`);
      return 3;
    }

    if (found.exitedAt !== null) {
      deps.err(`Refused: Held session ${found.session} has exited.\n`);
      return 3;
    }

    await answered(holder.kill(found.session), HOLDER_KILL_MS);
    deps.out(`Stopped held session ${found.session}.\n`);
    return 0;
  } catch (error) {
    deps.err(`The terminal holder failed: ${(error as Error).message}\n`);
    return 3;
  } finally {
    holder.close();
  }
}

/**
 * `holder stop --all`: names the holder and the live sessions that end with it, which can be resumed afterwards; with `--yes` it stops each
 * (through the hub when it answers, so the flow records the stop, else in the holder, which closes the pseudo-terminal and ends the process
 * tree), asks the holder to exit, and ends the holder's process tree when it has not exited within 10 seconds. A holder from an older build,
 * which cannot type, is replaced this way: the next Code Mode session starts the installed build.
 */
async function stopAll(confirmed: boolean, deps: HolderCliDeps): Promise<number> {
  const reply = await deps.post('/holder/list', {});
  const hub = typeof reply !== 'string';

  if (hub && reply.status !== 200) {
    deps.err(`Refused: ${reply.error ?? `status ${reply.status}`}\n`);
    return 3;
  }

  const holder = await deps.holder();

  if (holder === null) {
    deps.out('No terminal holder is running.\n');
    return 0;
  }

  try {
    const held = hub ? (reply.body as { sessions: HeldSession[] }).sessions : (await answered(holder.list(), HOLDER_ANSWER_MS)).map(heldFromHolder);
    const live = held.filter((one) => one.exitedAt === null);

    deps.out(holderLine(holder.welcome));
    deps.out(live.length === 0 ? 'It holds no live session.\n' : `${live.length === 1 ? 'This held session ends' : `These ${live.length} held sessions end`} with it; each can be resumed afterwards:\n${heldTable(live, deps.now())}`);

    if (!confirmed) {
      deps.out(`Run \`holder stop --all --yes\` to end ${live.length === 0 ? 'the terminal holder' : 'them and the terminal holder'}.\n`);
      return 0;
    }

    for (const one of live) {
      const stopped = hub ? await deps.post('/holder/stop', { id: one.session }) : await answered(holder.kill(one.session), HOLDER_KILL_MS).then(() => null, (error: Error) => error.message);

      if (typeof stopped === 'string') {
        deps.err(`Held session ${one.session} did not stop: ${stopped}\n`);
      } else if (stopped !== null && stopped.status !== 200) {
        deps.err(`Held session ${one.session} did not stop: ${stopped.error ?? `status ${stopped.status}`}\n`);
      } else {
        deps.out(`Stopped held session ${one.session}.\n`);
      }
    }

    // A session that did not stop makes the holder refuse to exit, and one that stopped answering never does; ending its process tree ends
    // its sessions too.
    await answered(holder.shutdown(), HOLDER_ANSWER_MS).catch(() => undefined);
    holder.close();

    const pid = holder.welcome.pid;

    for (let waited = 0; deps.alive(pid) && waited < HOLDER_EXIT_MS; waited += POLL_MS) {
      await deps.sleep(POLL_MS);
    }

    if (deps.alive(pid)) {
      const failed = await deps.killTree(pid);

      if (failed !== null) {
        deps.err(`The terminal holder (pid ${pid}) did not exit and could not be ended: ${failed.error}\n`);
        return 3;
      }

      deps.out(`The terminal holder did not exit, so its process tree was ended.\n`);
    }

    deps.out(`Ended the terminal holder (pid ${pid}). The next Code Mode session starts the installed build.\n`);
    return 0;
  } catch (error) {
    deps.err(`The terminal holder failed: ${(error as Error).message}\n`);
    return 3;
  } finally {
    holder.close();
  }
}
