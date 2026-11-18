import { createHash } from 'node:crypto';
import { join, resolve, win32 } from 'node:path';

/** Contents of `holder.json` in the Switchboard home: how a client reaches the running terminal holder. */
export interface HolderRecord {
  protocol: number;
  build: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

export const RECORD_FILE = 'holder.json';
export const LOG_FILE = 'holder.log';

export function recordPath(home: string): string {
  return join(home, RECORD_FILE);
}

/** The single-instance lock of a Switchboard home's holder: a named pipe on Windows, a socket file elsewhere. */
export function holderLockAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const key = createHash('sha256').update(win32.resolve(home).toLowerCase()).digest('hex').slice(0, 16);

    return `\\\\.\\pipe\\switchboard-holder-${key}`;
  }

  return join(resolve(home), 'holder.sock');
}

const isInteger = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Null for anything that is not a complete record, such as a file caught mid-write. */
export function parseHolderRecord(text: string): HolderRecord | null {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }

  const r = raw as Record<string, unknown>;

  if (!isInteger(r.protocol, 1) || !isInteger(r.port, 1, 65535) || !isInteger(r.pid, 1) || typeof r.build !== 'string' || typeof r.token !== 'string' || r.token === '' || typeof r.startedAt !== 'string') {
    return null;
  }

  return { protocol: r.protocol, build: r.build, port: r.port, token: r.token, pid: r.pid, startedAt: r.startedAt };
}
