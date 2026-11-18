import { readFileSync } from 'node:fs';
import { HolderClient, parseHolderRecord, recordPath } from '@switchboard/holder';
import type { SessionEntry } from '@switchboard/holder';
import { findHeld, heldFromHolder, heldTexts } from './held.js';
import type { HeldSession } from './held.js';

const USAGE = 'Usage:\n  holder list\n  holder stop <Switchboard session ID, Claude session ID or its first 8 characters>\n';

/** The holder calls the CLI makes while the hub is down; `list` and `kill` are the same in every protocol. */
export interface HolderControl {
  list(): Promise<SessionEntry[]>;
  kill(session: string): Promise<number | null>;
  close(): void;
}

export interface HolderCliDeps {
  /** Posts to the hub; a string says why no hub answered. */
  post(path: '/holder/list' | '/holder/stop', body: unknown): Promise<{ status: number; error: string | null; body: unknown } | string>;
  /** The holder `holder.json` names, or null when there is none or it does not answer. */
  holder(): Promise<HolderControl | null>;
  now(): number;
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
 * `hub.js holder list` and `hub.js holder stop <id>` (architecture.md § Visibility of held sessions): through the hub when it answers, else
 * through the holder, with the work item key and Claude session ID its labels give. Exit codes: 0 done, 1 usage, 2 neither the hub nor the
 * holder answered (stop), 3 refused or not found.
 */
export async function runHolder(argv: readonly string[], deps: HolderCliDeps): Promise<number> {
  const [command, id, ...rest] = argv;

  if (!((command === 'list' && id === undefined) || (command === 'stop' && id !== undefined && id !== '' && rest.length === 0))) {
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
      deps.out(heldTable((reply.body as { sessions: HeldSession[] }).sessions, deps.now()));
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
    const held = (await holder.list()).map(heldFromHolder);

    if (command === 'list') {
      deps.out(`${reply}, so this is the terminal holder's own list.\n${heldTable(held, deps.now())}`);
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

    await holder.kill(found.session);
    deps.out(`Stopped held session ${found.session}.\n`);
    return 0;
  } catch (error) {
    deps.err(`The terminal holder failed: ${(error as Error).message}\n`);
    return 3;
  } finally {
    holder.close();
  }
}
