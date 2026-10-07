import type { IncomingMessage } from 'node:http';

/** Snoozes the ticket in scope with this URL: null when there is none, otherwise the core's refusal or null (PRD R66). */
export type SnoozeByUrl = (url: string, until: number | null) => { refused: string | null } | null;

export interface BrowserReply {
  status: number;
  body: unknown;
}

const MAX_BODY_BYTES = 16 * 1024;

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(null));
  });
}

/**
 * `POST /snooze {url, until}` from the Chrome extension's service worker. A web page cannot send it: its JSON content
 * type needs a CORS preflight, which fails because the endpoint sends no CORS headers, and its Origin is not an extension.
 */
export async function handleSnooze(request: IncomingMessage, snooze: SnoozeByUrl): Promise<BrowserReply> {
  const origin = request.headers.origin ?? '';
  const contentType = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();

  if (!origin.startsWith('chrome-extension://')) {
    request.resume();

    return { status: 403, body: { error: 'forbidden origin' } };
  }

  if (contentType !== 'application/json') {
    request.resume();

    return { status: 415, body: { error: 'Expected Content-Type: application/json.' } };
  }

  const text = await readBody(request);
  let body: unknown;

  try {
    body = text === null ? null : JSON.parse(text);
  } catch {
    body = null;
  }

  const { url, until } = (typeof body === 'object' && body !== null ? body : {}) as { url?: unknown; until?: unknown };

  if (typeof url !== 'string' || url === '' || (until !== null && (typeof until !== 'number' || !Number.isFinite(until)))) {
    return { status: 400, body: { error: 'Expected {url, until}, where until is epoch milliseconds or null.' } };
  }

  const result = snooze(url, until);

  if (result === null) {
    return { status: 404, body: { error: `Switchboard has no ticket for ${url}.` } };
  }

  return result.refused === null ? { status: 200, body: { done: true } } : { status: 409, body: { error: result.refused } };
}
