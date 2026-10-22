import { readFileSync } from 'node:fs';
import { HUB_NAME, hubRecordPath, parseHubIdentity, parseHubRecord } from '@switchboard/core';
import type { HubRecord } from '@switchboard/core';
import { call } from './http.js';

export function readHubRecord(home: string): HubRecord | null {
  try {
    return parseHubRecord(readFileSync(hubRecordPath(home), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The recorded hub, when it answers with the recorded token and pid within `timeoutMs`. A record can outlive its hub, because a
 * forced exit on Windows skips cleanup (GC M25), so the record alone proves nothing.
 */
export async function findHub(home: string, timeoutMs = 1000): Promise<HubRecord | null> {
  const record = readHubRecord(home);

  if (record === null) {
    return null;
  }

  const reply = await call(record.port, 'GET', '/status', record.token, timeoutMs);
  const identity = reply?.status === 200 ? parseHubIdentity(reply.body) : null;

  return identity?.hub === HUB_NAME && identity.pid === record.pid ? record : null;
}

/** The recorded hub's pid while that process runs, or null. The pid can belong to another process after the hub died. */
export function recordedHubPid(home: string): number | null {
  const pid = readHubRecord(home)?.pid;

  if (pid === undefined) {
    return null;
  }

  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}
