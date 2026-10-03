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
 * The recorded hub, when it answers with the recorded token and pid. A record can outlive its hub, because a
 * forced exit on Windows skips cleanup (GC M25), so the record alone proves nothing.
 */
export async function findHub(home: string): Promise<HubRecord | null> {
  const record = readHubRecord(home);

  if (record === null) {
    return null;
  }

  const reply = await call(record.port, 'GET', '/status', record.token, 1000);
  const identity = reply?.status === 200 ? parseHubIdentity(reply.body) : null;

  return identity?.hub === HUB_NAME && identity.pid === record.pid ? record : null;
}
