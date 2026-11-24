import type { HubRecord } from '@switchboard/core';
import { call } from './http.js';

/** Ask a hub to stop. True when it agreed. */
export async function stopHub(record: HubRecord): Promise<boolean> {
  return (await call(record.port, 'POST', '/shutdown', record.token))?.status === 200;
}

/** Posts JSON to the hub. Null when it does not answer in time; otherwise the status, the error the hub gave if any, and the parsed body. */
export async function postToHub(record: HubRecord, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; error: string | null; body: unknown } | null> {
  const reply = await call(record.port, 'POST', path, record.token, timeoutMs, body);

  if (reply === null) {
    return null;
  }

  let parsed: unknown = null;

  try {
    parsed = JSON.parse(reply.body);
  } catch {
    return { status: reply.status, error: reply.status === 200 ? null : reply.body, body: null };
  }

  const error = (parsed as { error?: unknown } | null)?.error;

  return { status: reply.status, error: typeof error === 'string' ? error : null, body: parsed };
}
