import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@switchboard/core';
import { listenHub, VOICE_NOT_ALLOWED, VOICE_OFF, VOICE_TICKET_MS, VOICE_TICKETS_PER_PAGE } from '../src/server.js';
import type { HubServer, PageRoutes } from '../src/server.js';
import { PageAccess } from '../src/page.js';
import type { RemoteAccess } from '../src/page.js';
import { CONTROL_RATE, UPLINK_BYTES_PER_SECOND, VOICE_CLOSE, VOICE_HELLO_MS, VOICE_PENDING_MAX, VoiceSockets } from '../src/voiceSocket.js';
import { PAGE_SESSION_MS } from '../src/page.js';
import type { VoiceDevice } from '../src/voiceSocket.js';
import { until } from './helpers.js';

/** A WebSocket client written out by hand, so a test can send any header and any frame, and read a refusal's reason. */
class Client {
  readonly messages: Array<Record<string, unknown>> = [];
  readonly status: Promise<number>;
  /** The refusal's body, or the upgrade's head. */
  body = '';
  closeCode: number | null = null;
  closeReason = '';
  readonly closed: Promise<void>;
  #buffer = Buffer.alloc(0);
  #waiters: Array<() => void> = [];

  constructor(
    readonly socket: Socket,
    path: string,
    headers: Record<string, string>,
  ) {
    let resolveStatus!: (status: number) => void;
    let upgraded = false;

    this.status = new Promise((resolve) => (resolveStatus = resolve));
    this.closed = new Promise((resolve) => socket.on('close', () => resolve()));
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);

      if (!upgraded) {
        const end = this.#buffer.indexOf('\r\n\r\n');

        if (end < 0) {
          return;
        }

        const head = this.#buffer.subarray(0, end).toString();
        const status = Number(head.split(' ')[1]);

        this.#buffer = this.#buffer.subarray(end + 4);
        upgraded = true;

        if (status !== 101) {
          this.body = this.#buffer.toString('utf8');
          socket.on('data', (more: Buffer) => (this.body += more.toString('utf8')));
          socket.on('end', () => resolveStatus(status));
          return;
        }

        resolveStatus(status);
      }

      if (upgraded && this.closeCode === null) {
        this.#frames();
      }
    });
    socket.on('close', () => resolveStatus(0));
    socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
  }

  #frames(): void {
    while (this.#buffer.length >= 2) {
      const opcode = this.#buffer[0]! & 0x0f;
      let length = this.#buffer[1]! & 0x7f;
      let offset = 2;

      if (length === 126) {
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      }

      if (this.#buffer.length < offset + length) {
        return;
      }

      const payload = this.#buffer.subarray(offset, offset + length);

      this.#buffer = this.#buffer.subarray(offset + length);

      if (opcode === 0x1) {
        this.messages.push(JSON.parse(payload.toString('utf8')) as Record<string, unknown>);
      } else if (opcode === 0x2) {
        this.messages.push({ binary: Buffer.from(payload) });
      } else if (opcode === 0x8) {
        this.closeCode = payload.readUInt16BE(0);
        this.closeReason = payload.subarray(2).toString('utf8');
      }

      this.#waiters.splice(0).forEach((wake) => wake());
    }
  }

  frame(payload: Buffer, opcode = 0x1): void {
    const mask = randomBytes(4);
    const length = payload.length;
    const header = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length]) : Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff]);
    const body = Buffer.from(payload);

    for (let index = 0; index < body.length; index++) {
      body[index] = body[index]! ^ mask[index % 4]!;
    }

    this.socket.write(Buffer.concat([header, mask, body]));
  }

  send(message: unknown): void {
    this.frame(Buffer.from(JSON.stringify(message)));
  }

  async next(count = this.messages.length + 1): Promise<Record<string, unknown>> {
    while (this.messages.length < count) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }

    return this.messages[count - 1]!;
  }
}

/** A request with chosen headers, answering its status, headers and body. */
function send(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const outbound = request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      let text = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
    });

    outbound.on('error', reject);
    outbound.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const HOST = 'pc.tail.ts.net';
const REMOTE = { Host: HOST, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '100.64.0.2', 'Tailscale-User-Login': 'alex@example.com', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) Version/27.0 Mobile/15E148 Safari/604.1' };
const PHONE_ORIGIN = `https://${HOST}`;

describe('the voice socket on the page origin', () => {
  let server: HubServer;
  let store: Store;
  let remoteAccess: RemoteAccess;
  let enabled: boolean;
  let now: number;
  /** Why a page's `hello {resume: true}` is refused, or null while the hub waits for that device. */
  let resumeRefused: string | null;
  const clients: Client[] = [];
  const streams: Array<ReturnType<typeof request>> = [];
  let logs: string[];

  beforeEach(() => {
    store = Store.open(':memory:');
    remoteAccess = { hosts: [HOST], logins: ['alex@example.com'] };
    enabled = true;
    now = 1_000;
    resumeRefused = 'Voice did not resume after Switchboard restarted.';
    logs = [];
  });

  afterEach(async () => {
    clients.splice(0).forEach((client) => client.socket.destroy());
    streams.splice(0).forEach((stream) => stream.destroy());
    await server.close();
    store.close();
  });

  async function serve() {
    const events: string[] = [];
    const audio: Buffer[] = [];
    const sockets = new VoiceSockets({
      now: () => now,
      idleMs: 1_000,
      log: () => undefined,
      opened: (device, resumed) => events.push(`opened ${device.key}${resumed ? ' resumed' : ''}`),
      resumable: (device) => (events.push(`resumable ${device.key}`), resumeRefused),
      closed: (device, reason, refused) => events.push(`closed ${device.key}: ${reason}${refused ? ' (refused)' : ''}`),
      audio: (_device, data) => audio.push(data),
      message: (device, data) => events.push(`message ${device.key} ${String(data['type'])}`),
    });
    const pages = new Set<string>();
    let keys = 0;
    const page: PageRoutes = {
      access: new PageAccess(store, () => now),
      remote: () => remoteAccess,
      asset: () => null,
      opened: () => {
        const key = `page-${++keys}`;

        pages.add(key);
        return key;
      },
      isPage: (key) => pages.has(key),
      list: () => [],
      files: async () => null,
      artifact: () => null,
      upload: () => ({ status: 404, body: {} }),
      voice: {
        enabled: () => enabled,
        accept: (request, socket, head, device: VoiceDevice) => sockets.accept(request, socket, head, device),
        close: (match, reason, code) => sockets.close(match, reason, code),
      },
    };

    server = await listenHub({
      identity: { hub: 'switchboard', protocol: 1, version: '0', pid: 1 },
      onShutdown: () => {},
      page,
      now: () => now,
      log: (line) => logs.push(line),
      conversation: (key, write) => {
        write(`event: hello\ndata: {"key":"${key}"}\n\n`);
        return { close: () => {} };
      },
    });

    const localCookie = String((await send(server.port, 'GET', `/page?t=${page.access.token()}`, {})).headers['set-cookie']).split(';')[0]!;
    /** Pairs a device through the remote host, answering its cookie. */
    const pair = async (headers: Record<string, string> = REMOTE): Promise<string> => {
      const link = new URL(page.access.pair(HOST).url);

      return String((await send(server.port, 'GET', `${link.pathname}${link.search}`, headers)).headers['set-cookie']).split(';')[0]!;
    };
    /** Opens a page stream with a cookie, answering its page key and a way to end it. */
    const openPage = async (headers: Record<string, string>): Promise<{ key: string; end(): void }> => {
      const before = keys;
      const stream = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/events?page=1', headers }, (response) => response.resume());

      stream.on('error', () => {});
      stream.end();
      streams.push(stream);
      await until(() => (keys > before ? true : null));
      return { key: `page-${keys}`, end: () => stream.destroy() };
    };
    const idOf = (cookie: string): string => {
      const hash = page.access.sessionOf(cookie)!;

      return hash.slice(0, 8);
    };
    const open = (key: string, headers: Record<string, string>): Client => {
      const client = new Client(connect(server.port, '127.0.0.1'), `/v1/voice/socket?window=${encodeURIComponent(key)}`, {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      });

      clients.push(client);
      return client;
    };
    const allow = async (cookie: string, on: boolean, from = localCookie) => {
      const here = await openPage({ Host: `127.0.0.1:${server.port}`, Cookie: from });
      const answer = await send(server.port, 'POST', '/v1/conversation/page-device-voice', { 'Content-Type': 'application/json', Cookie: from, Origin: `http://127.0.0.1:${server.port}` }, { window: here.key, id: idOf(cookie), allow: on });

      here.end();
      return answer;
    };

    return { page, sockets, events, audio, localCookie, pair, openPage, open, allow, idOf };
  }

  it('refuses the socket without a sign-in, from another origin or host, with a key of another sign-in, from this computer, while voice is off and before voice is allowed', async () => {
    const { pair, openPage, open, allow, localCookie } = await serve();
    const phone = await pair();
    const other = await pair();
    const phonePage = await openPage({ ...REMOTE, Cookie: phone });
    const otherPage = await openPage({ ...REMOTE, Cookie: other });
    const localPage = await openPage({ Host: `127.0.0.1:${server.port}`, Cookie: localCookie });
    const good = { ...REMOTE, Cookie: phone, Origin: PHONE_ORIGIN };
    const refused = async (key: string, headers: Record<string, string>): Promise<[number, string]> => {
      const client = open(key, headers);

      return [await client.status, client.body.trim()];
    };

    // Before voice is allowed on the phone.
    expect(await refused(phonePage.key, good)).toEqual([403, VOICE_NOT_ALLOWED]);
    expect((await allow(phone, true)).status).toBe(200);

    expect(await refused(phonePage.key, { ...REMOTE, Origin: PHONE_ORIGIN })).toEqual([401, 'Not signed in.']);
    expect(await refused(phonePage.key, { ...REMOTE, Cookie: phone })).toEqual([403, 'The page opens the voice only from its own origin.']);
    expect(await refused(phonePage.key, { ...good, Origin: 'https://evil.example' })).toEqual([403, 'The page opens the voice only from its own origin.']);
    expect(await refused(phonePage.key, { ...good, Origin: `http://${HOST}` })).toEqual([403, 'The page opens the voice only from its own origin.']);
    // A host that rebinds to this machine, a proxied request naming the loopback, HTTP, another login and a Funnel request.
    expect((await refused(phonePage.key, { ...good, Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' }))[0]).toBe(403);
    expect((await refused(phonePage.key, { ...good, Host: `127.0.0.1:${server.port}` }))[0]).toBe(403);
    expect((await refused(phonePage.key, { ...good, 'X-Forwarded-Proto': 'http' }))[0]).toBe(403);
    expect((await refused(phonePage.key, { ...good, 'Tailscale-User-Login': 'mallory@example.com' }))[0]).toBe(403);
    expect((await refused(phonePage.key, { ...good, 'Tailscale-Funnel-Request': '?1' }))[0]).toBe(403);
    // A page key that is no one's, another device's, or this computer's page's.
    expect(await refused('page-99', good)).toEqual([403, 'Not in this window.']);
    expect(await refused(otherPage.key, good)).toEqual([403, 'Not in this window.']);
    expect(await refused(localPage.key, good)).toEqual([403, 'Not in this window.']);
    // This computer's own page, with its own key and cookie, and a phone's cookie on this computer.
    expect(await refused(localPage.key, { Host: `127.0.0.1:${server.port}`, Cookie: localCookie, Origin: `http://127.0.0.1:${server.port}` })).toEqual([403, 'Use Voice on the computer to use this computer\'s microphone and speaker.']);
    expect(await refused(phonePage.key, { Host: `127.0.0.1:${server.port}`, Cookie: phone, Origin: `http://127.0.0.1:${server.port}` })).toEqual([401, 'Not signed in.']);
    // Another path, and a plain GET with no upgrade.
    const wrongPath = new Client(connect(server.port, '127.0.0.1'), `/v1/voice/other?window=${phonePage.key}`, { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...good });

    clients.push(wrongPath);
    expect(await wrongPath.status).toBe(404);
    expect((await send(server.port, 'GET', `/v1/voice/socket?window=${phonePage.key}`, good)).status).not.toBe(101);

    enabled = false;
    expect(await refused(phonePage.key, good)).toEqual([403, VOICE_OFF]);
    enabled = true;

    const client = open(phonePage.key, good);

    expect(await client.status).toBe(101);
  });

  it('signs in a socket without its cookie by a one-use ticket for its own page key, origin and sign-in, and logs each refusal', async () => {
    const { pair, openPage, open, allow, localCookie } = await serve();
    const phone = await pair();
    const other = await pair();
    const phonePage = await openPage({ ...REMOTE, Cookie: phone });
    const otherPage = await openPage({ ...REMOTE, Cookie: other });
    const ticketFor = async (key: string, cookie = phone): Promise<{ status: number; ticket?: string; error?: string }> => {
      const answer = await send(server.port, 'POST', '/v1/conversation/page-voice-ticket', { ...REMOTE, 'Content-Type': 'application/json', Cookie: cookie, Origin: PHONE_ORIGIN }, { window: key });

      return { status: answer.status, ...(JSON.parse(answer.body) as { ticket?: string; error?: string }) };
    };
    // As the browser extension's frame opens it: the page's own origin, no cookie.
    const withTicket = (key: string, ticket: string, headers: Record<string, string> = { ...REMOTE, Origin: PHONE_ORIGIN }): Client => {
      const client = new Client(connect(server.port, '127.0.0.1'), `/v1/voice/socket?window=${encodeURIComponent(key)}&ticket=${encodeURIComponent(ticket)}`, {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      });

      clients.push(client);
      return client;
    };
    const refused = async (client: Client): Promise<[number, string]> => [await client.status, client.body.trim()];

    await allow(phone, true);

    // A ticket only for a page key of the asking sign-in, and none from this computer's sign-in through the remote host.
    expect(await ticketFor(otherPage.key)).toEqual({ status: 403, error: 'Not in this window.' });
    expect(await ticketFor('page-99')).toEqual({ status: 403, error: 'Not in this window.' });
    expect((await ticketFor(phonePage.key, localCookie)).status).toBe(401);

    const first = await ticketFor(phonePage.key);

    expect(first.status).toBe(200);
    expect(first.ticket).toMatch(/^[0-9a-f]{64}$/);

    const client = withTicket(phonePage.key, first.ticket!);

    expect(await client.status).toBe(101);
    client.socket.destroy();

    // Used up, refused or not; an unknown one; one for another key; and one from another origin.
    expect(await refused(withTicket(phonePage.key, first.ticket!))).toEqual([401, 'Not signed in.']);
    expect(await refused(withTicket(phonePage.key, 'f'.repeat(64)))).toEqual([401, 'Not signed in.']);

    const forOther = (await ticketFor(otherPage.key, other)).ticket!;

    expect(await refused(withTicket(phonePage.key, forOther))).toEqual([401, 'Not signed in.']);

    const elsewhere = (await ticketFor(phonePage.key)).ticket!;

    expect(await refused(withTicket(phonePage.key, elsewhere, { ...REMOTE, Origin: 'https://evil.example' }))).toEqual([403, 'The page opens the voice only from its own origin.']);
    expect(await refused(withTicket(phonePage.key, elsewhere))).toEqual([401, 'Not signed in.']);

    // An upgrade refused before any sign-in check, here for another host, uses its ticket up too.
    const early = (await ticketFor(phonePage.key)).ticket!;

    expect((await refused(withTicket(phonePage.key, early, { ...REMOTE, Host: 'evil.example', Origin: PHONE_ORIGIN })))[0]).toBe(403);
    expect(await refused(withTicket(phonePage.key, early))).toEqual([401, 'Not signed in.']);

    // A page key holds VOICE_TICKETS_PER_PAGE tickets, each usable in any order, and one more drops the oldest; the page's stream ending drops its tickets.
    const replaced = (await ticketFor(phonePage.key)).ticket!;
    const kept: string[] = [];

    for (let index = 1; index < VOICE_TICKETS_PER_PAGE; index++) {
      kept.push((await ticketFor(phonePage.key)).ticket!);
    }

    const replacing = (await ticketFor(phonePage.key)).ticket!;

    expect(await refused(withTicket(phonePage.key, replaced))).toEqual([401, 'Not signed in.']);
    // An older ticket still opens the socket after a newer one was given, as when the hub answers overlapping taps out of order.
    expect((await refused(withTicket(phonePage.key, kept[0]!)))[0]).toBe(101);

    const ending = await openPage({ ...REMOTE, Cookie: phone });
    const dropped = (await ticketFor(ending.key)).ticket!;

    ending.end();
    await until(async () => ((await ticketFor(ending.key)).status === 403 ? true : null));
    expect(await refused(withTicket(ending.key, dropped))).toEqual([401, 'Not signed in.']);
    expect((await refused(withTicket(phonePage.key, replacing)))[0]).toBe(101);

    // A ticket lapses after VOICE_TICKET_MS.
    const late = (await ticketFor(phonePage.key)).ticket!;

    now += VOICE_TICKET_MS + 1;
    expect(await refused(withTicket(phonePage.key, late))).toEqual([401, 'Not signed in.']);

    // A ticket does not outlive its sign-in, nor pass a device voice is not allowed on.
    const forbidden = (await ticketFor(phonePage.key)).ticket!;

    await allow(phone, false);
    expect(await refused(withTicket(phonePage.key, forbidden))).toEqual([403, VOICE_NOT_ALLOWED]);
    expect(logs.filter((line) => line.startsWith('voice socket: refused'))).toEqual([
      'voice socket: refused 401: Not signed in.',
      'voice socket: refused 401: Not signed in.',
      'voice socket: refused 401: Not signed in.',
      'voice socket: refused 403: The page opens the voice only from its own origin.',
      'voice socket: refused 401: Not signed in.',
      'voice socket: refused 403: The page is not served as this name. Set web.tailscale or web.remoteHosts in settings.json.',
      'voice socket: refused 401: Not signed in.',
      'voice socket: refused 401: Not signed in.',
      'voice socket: refused 401: Not signed in.',
      'voice socket: refused 401: Not signed in.',
      `voice socket: refused 403: ${VOICE_NOT_ALLOWED}`,
    ]);
  });

  it('lets only this computer allow voice, per device, and says so in the devices list and to the page', async () => {
    const { pair, openPage, allow, localCookie, idOf } = await serve();
    const phone = await pair();
    const phonePage = await openPage({ ...REMOTE, Cookie: phone });
    const post = (command: string, headers: Record<string, string>, body: Record<string, unknown>) => send(server.port, 'POST', `/v1/conversation/${command}`, { 'Content-Type': 'application/json', ...headers }, body);

    // The phone cannot allow itself, even naming its own ID.
    expect((await post('page-device-voice', { ...REMOTE, Cookie: phone, Origin: PHONE_ORIGIN }, { window: phonePage.key, id: idOf(phone), allow: true })).status).toBe(403);
    expect(JSON.parse((await post('page-voice-state', { ...REMOTE, Cookie: phone, Origin: PHONE_ORIGIN }, { window: phonePage.key })).body)).toEqual({ allowed: false, error: VOICE_NOT_ALLOWED });
    // Nor does a hub-token request reach the page command, and the hub token has no route of its own for it: the page's routes refuse it unsigned-in.
    expect((await send(server.port, 'POST', '/v1/conversation/page-device-voice', { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, { id: idOf(phone), allow: true })).status).not.toBe(200);
    expect((await send(server.port, 'POST', '/page/voice', { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, { id: idOf(phone), allow: true })).status).toBe(401);

    expect(JSON.parse((await allow(phone, true)).body)).toEqual({ voice: true });
    expect(JSON.parse((await post('page-voice-state', { ...REMOTE, Cookie: phone, Origin: PHONE_ORIGIN }, { window: phonePage.key })).body)).toEqual({ allowed: true, error: null });

    const here = await openPage({ Host: `127.0.0.1:${server.port}`, Cookie: localCookie });
    const local = { Cookie: localCookie, Origin: `http://127.0.0.1:${server.port}` };
    const listed = JSON.parse((await post('page-devices', local, { window: here.key })).body) as { devices: Array<{ id: string; voice: boolean }> };

    expect(listed.devices.map((one) => [one.id, one.voice])).toEqual(expect.arrayContaining([[idOf(phone), true], [idOf(localCookie), false]]));
    // This computer's sign-in has no voice to allow, a missing ID none, and a malformed body is refused.
    expect((await post('page-device-voice', local, { window: here.key, id: idOf(localCookie), allow: true })).status).toBe(404);
    expect((await post('page-device-voice', local, { window: here.key, id: '00000000', allow: true })).status).toBe(404);
    expect((await post('page-device-voice', local, { window: here.key, id: idOf(phone), allow: 'yes' })).status).toBe(400);
    expect(JSON.parse((await post('page-voice-state', local, { window: here.key })).body)).toEqual({ allowed: false, error: 'Use Voice on the computer to use this computer\'s microphone and speaker.' });

    enabled = false;
    expect(JSON.parse((await post('page-voice-state', { ...REMOTE, Cookie: phone, Origin: PHONE_ORIGIN }, { window: phonePage.key })).body)).toEqual({ allowed: false, error: VOICE_OFF });
  });

  it('answers hello and ping, closes audio sent before hello, and passes audio after it within twice real time', async () => {
    const { pair, openPage, open, allow, events, audio } = await serve();
    const phone = await pair();
    const phonePage = await openPage({ ...REMOTE, Cookie: phone });
    const good = { ...REMOTE, Cookie: phone, Origin: PHONE_ORIGIN };

    await allow(phone, true);

    const early = open(phonePage.key, good);

    expect(await early.status).toBe(101);
    early.frame(Buffer.alloc(640), 0x2);
    await early.closed;
    expect([early.closeCode, early.closeReason]).toEqual([1008, 'Audio before hello.']);
    expect(audio).toEqual([]);

    const client = open(phonePage.key, good);

    expect(await client.status).toBe(101);
    client.send({ type: 'ping', t: 5 });
    expect(await client.next()).toEqual({ type: 'pong', t: 5, at: now });
    client.send({ type: 'hello' });
    expect(await client.next()).toEqual({ type: 'welcome', at: now });
    expect(events).toContain(`opened ${phonePage.key}`);
    client.frame(Buffer.alloc(640, 1), 0x2);
    client.send({ type: 'state', visible: true });
    await until(() => (events.includes(`message ${phonePage.key} state`) ? true : null));
    expect(audio.map((one) => one.length)).toEqual([640]);

    // A second's worth at twice real time is the burst; more with no time passing closes the socket.
    for (let sent = 640; sent <= UPLINK_BYTES_PER_SECOND * 2; sent += 32_000) {
      client.frame(Buffer.alloc(32_000), 0x2);
    }

    await client.closed;
    expect([client.closeCode, client.closeReason]).toEqual([1008, 'Audio faster than real time.']);
    expect(events.at(-1)).toBe(`closed ${phonePage.key}: Audio faster than real time.`);
  });

  it('lets a page take the voice back with hello {resume: true} only while the hub waits for its device, and closes the voice for a restart with its own code', async () => {
    const { pair, openPage, open, allow, events, sockets } = await serve();
    const phone = await pair();
    const phonePage = await openPage({ ...REMOTE, Cookie: phone });
    const good = { ...REMOTE, Cookie: phone, Origin: PHONE_ORIGIN };

    await allow(phone, true);

    // Refused: the socket closes with the reason, and nothing took the voice.
    const refused = open(phonePage.key, good);

    expect(await refused.status).toBe(101);
    refused.send({ type: 'hello', resume: true });
    await refused.closed;
    expect([refused.closeCode, refused.closeReason]).toEqual([VOICE_CLOSE.refused, 'Voice did not resume after Switchboard restarted.']);
    expect(events).toEqual([`resumable ${phonePage.key}`]);

    resumeRefused = null;

    const resumed = open(phonePage.key, good);

    expect(await resumed.status).toBe(101);
    resumed.send({ type: 'hello', resume: true });
    expect(await resumed.next()).toEqual({ type: 'welcome', at: now });
    expect(events).toEqual([`resumable ${phonePage.key}`, `resumable ${phonePage.key}`, `opened ${phonePage.key} resumed`]);

    // A plain hello is a tap, which never asks.
    events.length = 0;

    const tapped = open(phonePage.key, good);

    expect(await tapped.status).toBe(101);
    tapped.send({ type: 'hello' });
    expect(await tapped.next()).toEqual({ type: 'welcome', at: now });
    await resumed.closed;
    expect(events).toEqual([`opened ${phonePage.key}`]);

    sockets.close(() => true, 'Switchboard is restarting.', VOICE_CLOSE.restarting);
    await tapped.closed;
    expect([tapped.closeCode, tapped.closeReason]).toEqual([VOICE_CLOSE.restarting, 'Switchboard is restarting.']);
  });

  it('closes a socket that never says hello, and one sending a frame over the limit', async () => {
    const { pair, openPage, open, allow } = await serve();
    const phone = await pair();
    const phonePage = await openPage({ ...REMOTE, Cookie: phone });
    const good = { ...REMOTE, Cookie: phone, Origin: PHONE_ORIGIN };

    await allow(phone, true);

    const big = open(phonePage.key, good);

    expect(await big.status).toBe(101);
    big.send({ type: 'hello' });
    await big.next();
    // A header claiming a 64-bit length is over the limit before any of it arrives.
    big.socket.write(Buffer.from([0x82, 0x80 | 127, 0, 0, 0, 0, 0, 1, 0, 0]));
    await big.closed;
    expect(big.closeCode).toBe(1009);

    const silent = open(phonePage.key, good);

    expect(await silent.status).toBe(101);
    await silent.closed;
    expect([silent.closeCode, silent.closeReason]).toEqual([1008, 'No hello.']);
  }, VOICE_HELLO_MS + 5_000);

  it('closes the socket when voice is forbidden on the device, it is signed out, remote access drops it or its page closes, and a newer device takes it over', async () => {
    const { pair, openPage, open, allow, events, page } = await serve();
    const phone = await pair();
    const good = { ...REMOTE, Cookie: phone, Origin: PHONE_ORIGIN };
    const connected = async (key: string, headers = good): Promise<Client> => {
      const client = open(key, headers);

      expect(await client.status).toBe(101);
      client.send({ type: 'hello' });
      await client.next();
      return client;
    };

    await allow(phone, true);

    // Forbidding voice mid-connection.
    const first = await connected((await openPage({ ...REMOTE, Cookie: phone })).key);

    await allow(phone, false);
    await first.closed;
    expect([first.closeCode, first.closeReason]).toEqual([VOICE_CLOSE.refused, 'Voice is no longer allowed on this device.']);
    await allow(phone, true);

    // The page stream whose key opened it ends.
    const phonePage = await openPage({ ...REMOTE, Cookie: phone });
    const second = await connected(phonePage.key);

    phonePage.end();
    await second.closed;
    // Going away, not refused: a stream that ends may be a dropped connection.
    expect([second.closeCode, second.closeReason]).toEqual([1001, 'The page that opened the voice closed.']);

    // Remote access no longer allows the login.
    const third = await connected((await openPage({ ...REMOTE, Cookie: phone })).key);

    remoteAccess = { hosts: [HOST], logins: ['other@example.com'] };
    server.remoteChanged();
    await third.closed;
    expect([third.closeCode, third.closeReason]).toEqual([VOICE_CLOSE.refused, 'Remote access no longer allows this device.']);
    remoteAccess = { hosts: [HOST], logins: ['alex@example.com'] };

    // A newer device takes the voice over; the older is told why.
    const tablet = await pair();

    await allow(tablet, true);

    const fourth = await connected((await openPage({ ...REMOTE, Cookie: phone })).key);
    const fifth = await connected((await openPage({ ...REMOTE, Cookie: tablet })).key, { ...good, Cookie: tablet });

    await fourth.closed;
    expect([fourth.closeCode, fourth.closeReason]).toEqual([VOICE_CLOSE.moved, 'Voice is now on another device.']);

    // Signing the device out, then pairing it anew, which needs voice allowed again.
    const id = page.access.sessionOf(tablet)!.slice(0, 8);
    const here = await openPage({ Host: `127.0.0.1:${server.port}`, Cookie: String((await send(server.port, 'GET', `/page?t=${page.access.token()}`, {})).headers['set-cookie']).split(';')[0]! });

    expect(here.key).toMatch(/^page-/);
    expect((await send(server.port, 'POST', '/page/revoke', { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, { id })).status).toBe(200);
    await fifth.closed;
    expect([fifth.closeCode, fifth.closeReason]).toEqual([VOICE_CLOSE.refused, 'This device was signed out.']);

    const again = await pair();
    const againPage = await openPage({ ...REMOTE, Cookie: again });
    const refused = open(againPage.key, { ...good, Cookie: again });

    expect(await refused.status).toBe(403);
    expect(refused.body.trim()).toBe(VOICE_NOT_ALLOWED);
    // The socket a newer device took over is no loss of the voice, so it is not reported closed; the refusals are the operator's choice rather
    // than a lost phone, and the ended page stream is neither.
    expect(events.filter((line) => line.startsWith('closed')).map((line) => line.endsWith(' (refused)'))).toEqual([true, false, true, true]);
  });

  it('checks the sign-in again at each message, so a socket does not outlive an expired or trimmed sign-in, voice turned off or a lost login', async () => {
    const { pair, openPage, open, allow } = await serve();
    const phone = await pair();

    await allow(phone, true);

    const connected = async (): Promise<Client> => {
      const client = open((await openPage({ ...REMOTE, Cookie: phone })).key, { ...REMOTE, Cookie: phone, Origin: PHONE_ORIGIN });

      expect(await client.status).toBe(101);
      client.send({ type: 'hello' });
      await client.next();
      return client;
    };

    // Unused for longer than a sign-in lasts.
    const expired = await connected();

    now += PAGE_SESSION_MS + 1;
    expired.send({ type: 'ping', t: 1 });
    await expired.closed;
    expect([expired.closeCode, expired.closeReason]).toEqual([VOICE_CLOSE.refused, 'This device was signed out.']);

    // A socket that sends only audio is checked too.
    now -= PAGE_SESSION_MS + 1;

    const audioOnly = await connected();

    now += PAGE_SESSION_MS + 1;
    audioOnly.frame(Buffer.from([2, 0, 0]), 0x2);
    await audioOnly.closed;
    expect([audioOnly.closeCode, audioOnly.closeReason]).toEqual([VOICE_CLOSE.refused, 'This device was signed out.']);
  });

  it('closes a socket whose sign-in the store trimmed', async () => {
    const { pair, openPage, open, allow, page } = await serve();
    const phone = await pair();
    const good = { ...REMOTE, Cookie: phone, Origin: PHONE_ORIGIN };

    await allow(phone, true);

    const key = (await openPage({ ...REMOTE, Cookie: phone })).key;
    const connected = async (): Promise<Client> => {
      const client = open(key, good);

      expect(await client.status).toBe(101);
      client.send({ type: 'hello' });
      await client.next();
      return client;
    };

    const trimmed = await connected();

    store.deletePageSessions(page.access.sessionOf(phone)!);
    trimmed.send({ type: 'ping', t: 1 });
    await trimmed.closed;
    expect([trimmed.closeCode, trimmed.closeReason]).toEqual([VOICE_CLOSE.refused, 'This device was signed out.']);
  });

  it('closes a socket that goes silent, the oldest of too many waiting for hello, one sending too many messages, and one after voice is turned off', async () => {
    const { pair, openPage, open, allow } = await serve();
    const phone = await pair();
    const good = { ...REMOTE, Cookie: phone, Origin: PHONE_ORIGIN };

    await allow(phone, true);

    const key = (await openPage({ ...REMOTE, Cookie: phone })).key;
    const connected = async (): Promise<Client> => {
      const client = open(key, good);

      expect(await client.status).toBe(101);
      client.send({ type: 'hello' });
      await client.next();
      return client;
    };

    // Silent past the idle time (1 s in this test).
    const silent = await connected();

    await silent.closed;
    expect([silent.closeCode, silent.closeReason]).toEqual([1001, 'The page stopped answering.']);

    // Too many waiting for hello: the oldest goes.
    const waiting: Client[] = [];

    for (let index = 0; index <= VOICE_PENDING_MAX; index++) {
      const client = open(key, good);

      expect(await client.status).toBe(101);
      waiting.push(client);
    }

    await waiting[0]!.closed;
    expect([waiting[0]!.closeCode, waiting[0]!.closeReason]).toEqual([1008, 'Too many voice sockets waiting.']);
    expect(waiting[1]!.closeCode).toBeNull();
    waiting.forEach((client) => client.socket.destroy());

    // More messages than the rate's burst with no time passing.
    const chatty = await connected();

    for (let index = 0; index < CONTROL_RATE * 2 + 1; index++) {
      chatty.send({ type: 'state' });
    }

    await chatty.closed;
    expect([chatty.closeCode, chatty.closeReason]).toEqual([1008, 'Too many messages.']);

    // Voice turned off while connected.
    const late = await connected();

    enabled = false;
    late.send({ type: 'ping', t: 2 });
    await late.closed;
    expect([late.closeCode, late.closeReason]).toEqual([VOICE_CLOSE.refused, VOICE_OFF]);
  });

  it('closes the voice socket when the hub closes', async () => {
    const { pair, openPage, open, allow } = await serve();
    const phone = await pair();

    await allow(phone, true);

    const client = open((await openPage({ ...REMOTE, Cookie: phone })).key, { ...REMOTE, Cookie: phone, Origin: PHONE_ORIGIN });

    expect(await client.status).toBe(101);
    client.send({ type: 'hello' });
    await client.next();
    await server.close();
    await client.closed;
    expect([client.closeCode, client.closeReason]).toEqual([VOICE_CLOSE.refused, 'Switchboard stopped.']);
    server = { close: async () => undefined } as unknown as HubServer;
  });
});
