import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempHome(): { home: string; remove(): void } {
  const home = mkdtempSync(join(tmpdir(), 'switchboard-home-'));

  return { home, remove: () => rmSync(home, { recursive: true, force: true }) };
}

export async function until<T>(what: () => T | null | Promise<T | null>, within = 5000): Promise<T> {
  const deadline = Date.now() + within;

  for (;;) {
    const answer = await what();

    if (answer !== null) {
      return answer;
    }

    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }

    await new Promise((done) => setTimeout(done, 20));
  }
}

/**
 * Opens an event stream on the hub's port with `headers`, calling `onEvent` with each named event and its data line; null when the hub refuses it.
 * `onEnd` runs once when the hub ends it.
 */
export function openStream(port: number, path: string, headers: Record<string, string>, onEvent?: (event: string, data: string) => void, onEnd?: () => void): Promise<{ close(): void } | null> {
  return new Promise((resolve) => {
    let closed = false;
    const outbound = request({ host: '127.0.0.1', port, method: 'GET', path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }

      let buffer = '';
      let ended = false;
      const end = (): void => {
        if (!ended && !closed) {
          ended = true;
          onEnd?.();
        }
      };

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;

        for (let at = buffer.indexOf('\n\n'); at !== -1; at = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, at);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];

          buffer = buffer.slice(at + 2);

          if (event !== undefined && data !== undefined) {
            onEvent?.(event, data);
          }
        }
      });
      response.on('end', end);
      response.on('close', end);
      resolve({
        close: () => {
          closed = true;
          outbound.destroy();
        },
      });
    });

    outbound.on('error', () => resolve(null));
    outbound.end();
  });
}
