import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listenBrowser } from '../src/browser.js';
import type { BrowserServer } from '../src/browser.js';
import { HELLO_MS, PAIRING_MS, PaneLink } from '../src/paneLink.js';
import type { PaneLinkState } from '../src/paneLink.js';

const ORIGIN = 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije';

/** A WebSocket client written out by hand, so a test can send any Origin and any frame. */
class Client {
  readonly messages: unknown[] = [];
  readonly status: Promise<number>;
  closeCode: number | null = null;
  readonly closed: Promise<void>;
  #buffer = Buffer.alloc(0);
  #waiters: Array<() => void> = [];

  constructor(
    readonly socket: Socket,
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

        this.#buffer = this.#buffer.subarray(end + 4);
        upgraded = true;
        resolveStatus(Number(head.split(' ')[1]));
      }

      this.#frames();
    });
    socket.on('close', () => resolveStatus(0));
    socket.write(`GET /pane HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
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
        this.messages.push(JSON.parse(payload.toString('utf8')));
      } else if (opcode === 0x8) {
        this.closeCode = payload.readUInt16BE(0);
      } else if (opcode === 0xa) {
        this.messages.push({ pong: payload.toString('utf8') });
      }

      this.#waiters.splice(0).forEach((wake) => wake());
    }
  }

  /** Sends a frame: masked text by default. */
  frame(payload: Buffer, { opcode = 0x1, masked = true, fin = true } = {}): void {
    const mask = randomBytes(4);
    const length = payload.length;
    const header = length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | length]) : Buffer.from([(fin ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | 126, length >> 8, length & 0xff]);
    const body = Buffer.from(payload);

    if (masked) {
      for (let index = 0; index < body.length; index++) {
        body[index] = body[index]! ^ mask[index % 4]!;
      }
    }

    this.socket.write(Buffer.concat(masked ? [header, mask, body] : [header, body]));
  }

  send(message: unknown): void {
    this.frame(Buffer.from(JSON.stringify(message)));
  }

  /** The next message after the ones already read, waiting for it. */
  async next(count = this.messages.length + 1): Promise<unknown> {
    while (this.messages.length < count) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }

    return this.messages[count - 1];
  }
}

let server: BrowserServer | null = null;
let home: string | null = null;
const clients: Client[] = [];

afterEach(async () => {
  clients.splice(0).forEach((client) => client.socket.destroy());
  await server?.close();
  server = null;

  if (home !== null) {
    rmSync(home, { recursive: true, force: true });
    home = null;
  }
});

async function setup(options: { enabled?: boolean } = {}) {
  let now = 1_000;
  let enabled = options.enabled ?? true;
  const received: Array<Record<string, unknown>> = [];
  const states: PaneLinkState[] = [];
  const log: string[] = [];

  home = mkdtempSync(join(tmpdir(), 'sb-pane-'));

  const link = new PaneLink({ origin: ORIGIN, file: join(home, 'chrome-pane.json'), enabled: () => enabled, now: () => now, log: (line) => log.push(line), message: (data) => received.push(data), changed: (state) => states.push(state) });

  server = await listenBrowser(0, () => [], () => [], undefined, undefined, (request, socket, head) => link.upgrade(request, socket, head));

  const port = server.port;
  const open = (headers: Record<string, string> = {}): Client => {
    const client = new Client(connect(port, '127.0.0.1'), {
      Host: `127.0.0.1:${port}`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      Origin: ORIGIN,
      ...headers,
    });

    clients.push(client);
    return client;
  };

  return { link, open, received, states, log, file: join(home, 'chrome-pane.json'), port, advance: (ms: number) => (now += ms), enable: (on: boolean) => (enabled = on) };
}

describe('PaneLink', () => {
  it('refuses an upgrade from another origin, host or path, or while the pane is off', async () => {
    const pane = await setup();

    expect(await pane.open({ Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }).status).toBe(403);
    expect(await pane.open({ Origin: 'http://127.0.0.1:47616' }).status).toBe(403);
    expect(await pane.open({ Host: `switchboard.example:${pane.port}` }).status).toBe(403);
    expect(await pane.open({ 'Sec-WebSocket-Version': '8' }).status).toBe(403);
    expect(await pane.open({ 'Sec-WebSocket-Key': 'c2hvcnQ=' }).status).toBe(403);
    pane.enable(false);
    expect(await pane.open().status).toBe(403);
    expect(pane.link.state()).toBe('none');
    expect(pane.log).toContain('pane socket refused: not the Switchboard extension');
  });

  it('pairs the extension once with the page’s token, keeping only the credential’s hash, and refuses the token again', async () => {
    const pane = await setup();
    const first = pane.open();

    expect(await first.status).toBe(101);
    first.send({ type: 'hello', credential: null });
    expect(await first.next()).toEqual({ type: 'unpaired' });
    expect(pane.link.state()).toBe('unpaired');

    first.send({ type: 'pair', token: 'made-up' });
    expect(await first.next()).toEqual({ type: 'unpaired', error: 'The pairing token is unknown, used or expired. Pair again from the page.' });

    const token = pane.link.pairingToken();

    first.send({ type: 'pair', token });

    const paired = (await first.next()) as { type: string; credential: string };

    expect(paired.type).toBe('paired');
    expect(paired.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pane.link.state()).toBe('paired');
    expect(readFileSync(pane.file, 'utf8')).not.toContain(paired.credential);

    // The token works once; a second extension cannot pair with it.
    const second = pane.open();

    second.send({ type: 'pair', token });
    expect(await second.next()).toMatchObject({ type: 'unpaired' });

    // The credential connects again later.
    first.socket.destroy();
    await first.closed;

    const again = pane.open();

    again.send({ type: 'hello', credential: paired.credential });
    expect(await again.next()).toEqual({ type: 'paired' });

    const wrong = pane.open();

    wrong.send({ type: 'hello', credential: 'x'.repeat(43) });
    expect(await wrong.next()).toEqual({ type: 'unpaired' });
    expect(pane.states).toContain('paired');
  });

  it('refuses an expired token', async () => {
    const pane = await setup();
    const token = pane.link.pairingToken();
    const client = pane.open();

    pane.advance(PAIRING_MS + 1);
    client.send({ type: 'pair', token });
    expect(await client.next()).toMatchObject({ type: 'unpaired' });
    expect(pane.link.state()).toBe('unpaired');
  });

  it('passes a paired extension’s messages on, sends it the hub’s, and lets a newer pairing replace it', async () => {
    const pane = await setup();
    const first = pane.open();

    first.send({ type: 'pair', token: pane.link.pairingToken() });
    await first.next();
    first.send({ type: 'ping' });
    first.send({ type: 'closed' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pane.received).toEqual([{ type: 'closed' }]);
    expect(pane.link.send({ type: 'tabs', urls: [] })).toBe(true);
    expect(await first.next()).toEqual({ type: 'tabs', urls: [] });

    const second = pane.open();

    second.send({ type: 'pair', token: pane.link.pairingToken() });
    expect(await second.next()).toMatchObject({ type: 'paired' });
    await first.closed;
    expect(first.closeCode).toBe(1000);
    expect(pane.link.state()).toBe('paired');

    pane.link.closeAll();
    await second.closed;
    expect(pane.link.state()).toBe('none');
    expect(pane.link.send({ type: 'tabs' })).toBe(false);
  });

  it('closes an unpaired socket that sends anything but hello, pair or ping, and passes it nothing', async () => {
    const pane = await setup();
    const client = pane.open();

    client.send({ type: 'closed' });
    await client.closed;
    expect(client.closeCode).toBe(1008);
    expect(pane.received).toEqual([]);
  });

  it('closes on a frame the pane does not use: unmasked, binary, fragmented, too long or not JSON, and answers a ping', async () => {
    const pane = await setup();
    const codes: Array<number | null> = [];

    for (const send of [
      (client: Client) => client.frame(Buffer.from('{}'), { masked: false }),
      (client: Client) => client.frame(Buffer.from([1, 2]), { opcode: 0x2 }),
      (client: Client) => client.frame(Buffer.from('{"type":'), { fin: false }),
      (client: Client) => client.frame(Buffer.from('not json')),
      (client: Client) => client.frame(Buffer.from([0xff, 0xfe])),
      (client: Client) => client.socket.write(Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 1, 0, 0])),
    ]) {
      const client = pane.open();

      expect(await client.status).toBe(101);
      send(client);
      await client.closed;
      codes.push(client.closeCode);
    }

    expect(codes).toEqual([1002, 1003, 1003, 1007, 1007, 1009]);

    const pinged = pane.open();

    pinged.frame(Buffer.from('hi'), { opcode: 0x9 });
    expect(await pinged.next()).toEqual({ pong: 'hi' });
  });

  it('closes a socket that does not say hello in time, even one that keeps pinging', async () => {
    const pane = await setup();
    const client = pane.open();
    const started = Date.now();

    expect(await client.status).toBe(101);

    const pinging = setInterval(() => client.send({ type: 'ping' }), 1_000);

    await client.closed;
    clearInterval(pinging);
    expect(client.closeCode).toBe(1001);
    expect(Date.now() - started).toBeLessThan(HELLO_MS + 1_000);
  }, HELLO_MS + 2_000);
});
