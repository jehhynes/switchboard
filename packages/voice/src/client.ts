import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { LineReader, PROTOCOL, encode, parseVoiceMessage } from './protocol.js';
import type { HubMessage, VoiceMessage } from './protocol.js';

export interface VoiceWelcome {
  protocol: number;
  build: string;
  pid: number;
  features: string[];
}

export interface VoiceConnectOptions {
  port: number;
  token: string;
  /** How long to wait for the connection and the welcome; 5 seconds by default. */
  timeoutMs?: number;
}

/** The hub's connection to the voice process (architecture.md § Voice). */
export class VoiceClient {
  #socket!: Socket;
  #onMessage: (message: VoiceMessage) => void = () => undefined;
  readonly #onClose: Array<(error: Error) => void> = [];
  #closed = false;
  welcome!: VoiceWelcome;

  private constructor() {}

  /** Connects and completes the hello; messages that come with the welcome wait for `onMessage`. */
  static connect(options: VoiceConnectOptions): Promise<VoiceClient> {
    const client = new VoiceClient();
    const early: VoiceMessage[] = [];
    let delivering = false;

    return new Promise((resolve, reject) => {
      const socket = connect(options.port, '127.0.0.1');
      const reader = new LineReader();
      let welcomed = false;
      const timer = setTimeout(() => fail(new Error('The voice process did not answer.')), options.timeoutMs ?? 5_000);

      function fail(error: Error): void {
        clearTimeout(timer);
        socket.destroy();

        if (!welcomed) {
          reject(error);
        } else if (!client.#closed) {
          client.#closed = true;

          for (const listener of client.#onClose) {
            listener(error);
          }
        }
      }

      client.#socket = socket;
      client.onMessage = (listener) => {
        client.#onMessage = listener;

        if (!delivering) {
          delivering = true;

          for (const message of early.splice(0)) {
            listener(message);
          }
        }
      };
      socket.on('connect', () => socket.write(encode({ type: 'hello', token: options.token })));
      socket.on('error', (error) => fail(new Error(`The voice process could not be reached: ${error.message}`)));
      socket.on('close', () => fail(new Error('The voice process closed the connection.')));
      socket.on('data', (chunk: Buffer) => {
        const lines = reader.push(chunk);

        if (!Array.isArray(lines)) {
          fail(new Error(lines.error));
          return;
        }

        for (const line of lines) {
          const message = parseVoiceMessage(line);

          if (message === null) {
            fail(new Error('The voice process sent a malformed message.'));
            return;
          }

          if (!welcomed) {
            if (message.type !== 'welcome') {
              fail(new Error(message.type === 'error' ? message.message : 'The voice process did not welcome the connection.'));
              return;
            }

            welcomed = true;
            clearTimeout(timer);
            client.welcome = { protocol: message.protocol, build: message.build, pid: message.pid, features: Array.isArray(message.features) ? message.features : [] };
            resolve(client);
          } else if (delivering) {
            client.#onMessage(message);
          } else {
            early.push(message);
          }
        }
      });
    });
  }

  /** Delivers the process's messages, those that came before it first. */
  onMessage: (listener: (message: VoiceMessage) => void) => void = () => undefined;

  /** Each listener is called once when the connection ends; the link and the hub both listen. */
  onClose(listener: (error: Error) => void): void {
    this.#onClose.push(listener);
  }

  /** Whether the process speaks the hub's protocol. */
  get compatible(): boolean {
    return this.welcome.protocol === PROTOCOL;
  }

  send(message: HubMessage): void {
    if (!this.#closed) {
      this.#socket.write(encode(message));
    }
  }

  close(): void {
    this.#closed = true;
    this.#socket.destroy();
  }
}
