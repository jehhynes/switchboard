import { request } from 'node:http';
import type { HubRecord } from '@switchboard/core';
import { call } from './http.js';

export interface EventStream {
  close(): void;
}

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

export const OPEN_TIMEOUT_MS = 5000;

/**
 * Open the hub's event stream, which keeps the hub from exiting idle. `onEvent` gets each named event and its data line. Null when the hub refuses, or does not send
 * response headers within `timeoutMs`. `onEnd` runs once if the stream ends for any reason other than `close()`. `query` tells the hub about the window, as
 * `workspace` and `focused`.
 */
export function openEvents(record: HubRecord, onEnd: () => void, timeoutMs = OPEN_TIMEOUT_MS, onEvent?: (event: string, data: string) => void, query?: Record<string, string>): Promise<EventStream | null> {
  return openStream(record, query === undefined ? '/events' : `/events?${new URLSearchParams(query).toString()}`, onEnd, timeoutMs, onEvent);
}

/**
 * Opens a window's conversation stream (architecture.md § Conversation API) for the window key its `/events` hello carried. Null when the hub
 * refuses the key or does not answer in time; `onEnd` runs once when the stream ends for any reason other than `close()`.
 */
export function openConversation(record: HubRecord, key: string, onEnd: () => void, onEvent: (event: string, data: string) => void, timeoutMs = OPEN_TIMEOUT_MS): Promise<EventStream | null> {
  return openStream(record, `/v1/conversation/events?${new URLSearchParams({ window: key }).toString()}`, onEnd, timeoutMs, onEvent);
}

function openStream(record: HubRecord, path: string, onEnd: () => void, timeoutMs: number, onEvent?: (event: string, data: string) => void): Promise<EventStream | null> {
  return new Promise((resolve) => {
    let opened = false;
    let ended = false;

    const deadline = setTimeout(() => {
      if (!opened) {
        outbound.destroy();
        resolve(null);
      }
    }, timeoutMs);

    const end = (): void => {
      if (!ended) {
        ended = true;
        onEnd();
      }
    };

    const outbound = request(
      { host: '127.0.0.1', port: record.port, method: 'GET', path, headers: { Authorization: `Bearer ${record.token}` } },
      (response) => {
        clearTimeout(deadline);

        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);

          return;
        }

        opened = true;
        let buffer = '';

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;

          for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = /^event: (.*)$/m.exec(frame)?.[1];
            const data = /^data: (.*)$/m.exec(frame)?.[1];

            if (event !== undefined && data !== undefined) {
              onEvent?.(event, data);
            }
          }
        });
        response.on('end', end);
        response.on('close', end);
        resolve({
          close: () => {
            ended = true;
            outbound.destroy();
          },
        });
      },
    );

    outbound.on('error', () => {
      clearTimeout(deadline);

      if (opened) {
        end();
      } else {
        resolve(null);
      }
    });
    outbound.end();
  });
}
