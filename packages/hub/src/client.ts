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

export const OPEN_TIMEOUT_MS = 5000;

/**
 * Open the hub's event stream, which keeps the hub from exiting idle. Null when the hub refuses, or does not send
 * response headers within `timeoutMs`. `onEnd` runs once if the stream ends for any reason other than `close()`.
 */
export function openEvents(record: HubRecord, onEnd: () => void, timeoutMs = OPEN_TIMEOUT_MS): Promise<EventStream | null> {
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
      { host: '127.0.0.1', port: record.port, method: 'GET', path: '/events', headers: { Authorization: `Bearer ${record.token}` } },
      (response) => {
        clearTimeout(deadline);

        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);

          return;
        }

        opened = true;
        response.on('data', () => {});
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
