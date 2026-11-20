import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { HELLO_DEADLINE_MS, LineReader, PROTOCOL, encode, parseHubMessage } from './protocol.js';
import type { HubMessage, VoiceMessage } from './protocol.js';

export interface VoiceServerDeps {
  token: string;
  build: string;
  /** Messages to a hub that just connected, after its welcome. */
  greeting(): VoiceMessage[];
  receive(message: HubMessage): void;
  shutdown(): void;
  /** A hub connected, or the last one left. */
  connected?(connected: boolean): void;
  log(line: string): void;
}

/**
 * The voice process's loopback listener (architecture.md § Voice): the hub authenticates with the token from `voice.json` and is its only client;
 * a hub that connects replaces the one before, as after a hub restart.
 */
export class VoiceServer {
  readonly #server: Server;
  #hub: Socket | null = null;

  constructor(private readonly deps: VoiceServerDeps) {
    this.#server = createServer((socket) => this.#accept(socket));
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', () => {
        const address = this.#server.address();

        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  }

  /** Sends a message to the connected hub; dropped while none is. */
  send(message: VoiceMessage): void {
    this.#hub?.write(encode(message));
  }

  close(): Promise<void> {
    this.#hub?.destroy();

    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  #accept(socket: Socket): void {
    const reader = new LineReader();
    let welcomed = false;
    const deadline = setTimeout(() => socket.destroy(), HELLO_DEADLINE_MS);

    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(deadline);

      if (this.#hub === socket) {
        this.#hub = null;
        this.deps.connected?.(false);
      }
    });
    socket.on('data', (chunk: Buffer) => {
      const lines = reader.push(chunk);

      if (!Array.isArray(lines)) {
        socket.end(encode({ type: 'error', message: lines.error }));
        return;
      }

      for (const line of lines) {
        const message = parseHubMessage(line);

        if ('error' in message) {
          socket.end(encode({ type: 'error', message: message.error }));
          return;
        }

        if (!welcomed) {
          if (message.type !== 'hello' || !sameToken(message.token, this.deps.token)) {
            socket.end(encode({ type: 'error', message: 'The token is wrong.' }));
            return;
          }

          welcomed = true;
          clearTimeout(deadline);
          this.#hub?.destroy();
          this.#hub = socket;
          socket.write(encode({ type: 'welcome', protocol: PROTOCOL, build: this.deps.build, pid: process.pid, features: [] }));

          for (const greeting of this.deps.greeting()) {
            socket.write(encode(greeting));
          }

          this.deps.connected?.(true);
          continue;
        }

        if (message.type === 'shutdown') {
          this.deps.log('Exiting: the hub asked it to stop.');
          this.deps.shutdown();
          return;
        }

        this.deps.receive(message);
      }
    });
  }
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);

  return a.length === b.length && timingSafeEqual(a, b);
}
