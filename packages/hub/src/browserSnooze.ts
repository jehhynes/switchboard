import type { IncomingMessage } from 'node:http';

/** Snoozes the ticket in scope with this URL: null when there is none, otherwise the core's refusal or null (PRD R66). */
export type SnoozeByUrl = (url: string, until: number | null) => { refused: string | null } | null;

/** Ends the snooze of the ticket in scope with this URL: null when there is none, otherwise the core's refusal or null. */
export type UnsnoozeByUrl = (url: string) => { refused: string | null } | null;

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
 * Reads the JSON body of a request from the Chrome extension's service worker, or the refusal for any other sender. A web
 * page cannot send it: its JSON content type needs a CORS preflight, which fails because the endpoint sends no CORS headers,
 * and its Origin is not an extension.
 */
async function readExtensionBody(request: IncomingMessage): Promise<{ body: Record<string, unknown> } | { reply: BrowserReply }> {
  const origin = request.headers.origin ?? '';
  const contentType = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();

  if (!origin.startsWith('chrome-extension://')) {
    request.resume();

    return { reply: { status: 403, body: { error: 'forbidden origin' } } };
  }

  if (contentType !== 'application/json') {
    request.resume();

    return { reply: { status: 415, body: { error: 'Expected Content-Type: application/json.' } } };
  }

  const text = await readBody(request);
  let body: unknown;

  try {
    body = text === null ? null : JSON.parse(text);
  } catch {
    body = null;
  }

  return { body: typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {} };
}

function answer(url: string, result: { refused: string | null } | null): BrowserReply {
  if (result === null) {
    return { status: 404, body: { error: `Switchboard has no ticket for ${url}.` } };
  }

  return result.refused === null ? { status: 200, body: { done: true } } : { status: 409, body: { error: result.refused } };
}

/** `POST /snooze {url, until}` from the Chrome extension's service worker (PRD R66). */
export async function handleSnooze(request: IncomingMessage, snooze: SnoozeByUrl): Promise<BrowserReply> {
  const read = await readExtensionBody(request);

  if ('reply' in read) {
    return read.reply;
  }

  const { url, until } = read.body;

  if (typeof url !== 'string' || url === '' || (until !== null && (typeof until !== 'number' || !Number.isFinite(until)))) {
    return { status: 400, body: { error: 'Expected {url, until}, where until is epoch milliseconds or null.' } };
  }

  return answer(url, snooze(url, until));
}

/** `POST /unsnooze {url}` from the Chrome extension's service worker (PRD R66). */
export async function handleUnsnooze(request: IncomingMessage, unsnooze: UnsnoozeByUrl): Promise<BrowserReply> {
  const read = await readExtensionBody(request);

  if ('reply' in read) {
    return read.reply;
  }

  const { url } = read.body;

  if (typeof url !== 'string' || url === '') {
    return { status: 400, body: { error: 'Expected {url}.' } };
  }

  return answer(url, unsnooze(url));
}
