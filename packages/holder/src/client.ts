import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { LineReader, MAX_HOST_LINE_BYTES, PROTOCOL, encode, parseHostMessage } from './protocol.js';
import type { ClientMessage, HostMessage, SessionEntry, SpawnRequest } from './protocol.js';

export class HolderError extends Error {}

function otherProtocol(protocol: number): string {
  return `The terminal holder speaks protocol ${protocol}, not ${PROTOCOL}.`;
}

export interface Welcome {
  protocol: number;
  build: string;
  pid: number;
  /** Requests added within the protocol that this holder serves, such as `snapshot`; empty for a holder from before them. */
  features: string[];
}

export interface ConnectOptions {
  port: number;
  token: string;
  /** How long to wait for the connection and the welcome; 5 seconds by default. */
  timeoutMs?: number;
}

/** A watched event: a session exited, or a client attached or detached. */
export type HolderEvent = Extract<HostMessage, { type: 'exited' | 'attached' | 'detached' }>;

type Request = ClientMessage extends infer M ? (M extends { id: number } ? Omit<M, 'id'> : never) : never;

/** Opens a connection and completes the hello; rejects with the holder's refusal. */
function open(options: ConnectOptions, onMessage: (message: HostMessage) => void, onClose: (error: HolderError) => void): Promise<{ socket: Socket; welcome: Welcome }> {
  return new Promise((resolve, reject) => {
    const socket = connect(options.port, '127.0.0.1');
    const reader = new LineReader(MAX_HOST_LINE_BYTES);
    let welcome: Welcome | null = null;
    let closed = false;
    const timer = setTimeout(() => fail(new HolderError('The terminal holder did not answer.')), options.timeoutMs ?? 5_000);

    function fail(error: HolderError): void {
      if (closed) {
        return;
      }

      closed = true;
      clearTimeout(timer);
      socket.destroy();

      if (welcome === null) {
        reject(error);
      } else {
        onClose(error);
      }
    }

    socket.on('connect', () => socket.write(encode({ type: 'hello', token: options.token })));
    socket.on('error', (error) => fail(new HolderError(`The terminal holder could not be reached: ${error.message}`)));
    socket.on('close', () => fail(new HolderError('The terminal holder closed the connection.')));
    socket.on('data', (chunk: Buffer) => {
      const lines = reader.push(chunk);

      if (!Array.isArray(lines)) {
        fail(new HolderError(lines.error));
        return;
      }

      for (const line of lines) {
        const message = parseHostMessage(line);

        if (message === null) {
          fail(new HolderError('The terminal holder sent a malformed message.'));
          return;
        }

        if (welcome === null) {
          if (message.type !== 'welcome') {
            fail(new HolderError(message.type === 'error' ? message.message : 'The terminal holder did not welcome the connection.'));
            return;
          }

          clearTimeout(timer);
          welcome = { protocol: message.protocol, build: message.build, pid: message.pid, features: Array.isArray(message.features) ? message.features.filter((feature) => typeof feature === 'string') : [] };
          resolve({ socket, welcome });
        } else if (message.type === 'error' && message.re === undefined) {
          fail(new HolderError(message.message));
          return;
        } else {
          onMessage(message);
        }
      }
    });
  });
}

/** A control connection to the terminal holder. */
export class HolderClient {
  #socket!: Socket;
  #nextId = 1;
  #closed: HolderError | null = null;
  readonly #pending = new Map<number, { resolve: (message: HostMessage) => void; reject: (error: HolderError) => void }>();
  #onEvent: ((event: HolderEvent) => void) | null = null;
  #onClose: ((error: HolderError) => void) | null = null;
  welcome!: Welcome;

  private constructor() {}

  static async connect(options: ConnectOptions): Promise<HolderClient> {
    const client = new HolderClient();
    const { socket, welcome } = await open(options, (message) => client.#receive(message), (error) => client.#close(error));

    client.#socket = socket;
    client.welcome = welcome;

    return client;
  }

  /** Called once when the connection ends, with why. */
  onClose(listener: (error: HolderError) => void): void {
    this.#onClose = listener;
  }

  async spawn(request: SpawnRequest): Promise<{ session: string; pid: number }> {
    const reply = await this.#request({ type: 'spawn', ...request }, 'spawned');

    return { session: reply.session, pid: reply.pid };
  }

  async list(): Promise<SessionEntry[]> {
    return (await this.#request({ type: 'list' }, 'sessions')).sessions;
  }

  /** Ends the session's process tree; resolves its exit code once it has exited. */
  async kill(session: string): Promise<number | null> {
    return (await this.#request({ type: 'kill', session }, 'killed')).exitCode;
  }

  /** The start of the session's output and its visible screen, as text. */
  async screen(session: string): Promise<{ head: string; text: string }> {
    const reply = await this.#request({ type: 'screen', session }, 'screen');

    return { head: reply.head, text: reply.text };
  }

  /**
   * The screen and `scrollback` lines above it serialized with their attributes, its size and its revision. A holder that does not name
   * `snapshot` in its features would close the connection on the request, so it is refused here.
   */
  async snapshot(session: string, scrollback: number): Promise<{ data: string; cols: number; rows: number; rev: number }> {
    if (!this.welcome.features.includes('snapshot')) {
      throw new HolderError('The terminal holder does not serve snapshots; it is from an older build.');
    }

    const reply = await this.#request({ type: 'snapshot', session, scrollback }, 'snapshot');

    return { data: reply.data, cols: reply.cols, rows: reply.rows, rev: reply.rev };
  }

  /** Delivers exits, attaches and detaches on this connection from now on. */
  async watch(listener: (event: HolderEvent) => void): Promise<void> {
    this.#onEvent = listener;
    await this.#request({ type: 'watch' }, 'watching');
  }

  /** Asks the holder to exit; rejects while it holds a live session. */
  async shutdown(): Promise<void> {
    await this.#request({ type: 'shutdown' }, 'bye');
  }

  close(): void {
    this.#socket.destroy();
  }

  /** Whether the holder speaks this client's protocol; with another, only `list`, `kill` and `shutdown` may be sent. */
  get compatible(): boolean {
    return this.welcome.protocol === PROTOCOL;
  }

  #request<T extends HostMessage['type']>(request: Request, expected: T): Promise<Extract<HostMessage, { type: T }>> {
    if (this.#closed !== null) {
      return Promise.reject(this.#closed);
    }

    if (!this.compatible && request.type !== 'list' && request.type !== 'kill' && request.type !== 'shutdown') {
      return Promise.reject(new HolderError(otherProtocol(this.welcome.protocol)));
    }

    const id = this.#nextId++;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (message) => (message.type === expected ? resolve(message as Extract<HostMessage, { type: T }>) : reject(new HolderError(`The terminal holder answered ${message.type} to ${request.type}.`))),
        reject,
      });
      this.#socket.write(encode({ ...request, id } as ClientMessage));
    });
  }

  #receive(message: HostMessage): void {
    if ('re' in message && message.re !== undefined) {
      const pending = this.#pending.get(message.re);

      this.#pending.delete(message.re);

      if (message.type === 'error') {
        pending?.reject(new HolderError(message.message));
      } else {
        pending?.resolve(message);
      }

      return;
    }

    if (message.type === 'exited' || message.type === 'attached' || message.type === 'detached') {
      this.#onEvent?.(message);
    }
  }

  #close(error: HolderError): void {
    this.#closed = error;

    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }

    this.#pending.clear();
    this.#onClose?.(error);
  }
}

export interface AttachOptions extends ConnectOptions {
  session: string;
  cols: number;
  rows: number;
  /** Replay, then output, to write to the terminal in order. */
  onData: (data: string) => void;
  /** The replay has been delivered. */
  onReplayed?: () => void;
  /** The program exited. */
  onExit?: (exitCode: number | null) => void;
  /** The connection ended, with the holder's refusal when there was one. */
  onClose?: (error: HolderError | null) => void;
}

/** A client attached to one session: it receives the session's screen and output and sends input and size. */
export class Attachment {
  readonly #socket: Socket;
  readonly welcome: Welcome;

  private constructor(socket: Socket, welcome: Welcome) {
    this.#socket = socket;
    this.welcome = welcome;
  }

  static async open(options: AttachOptions): Promise<Attachment> {
    let exited = false;
    const { socket, welcome } = await open(
      options,
      (message) => {
        if (message.type === 'replay' || message.type === 'output') {
          options.onData(message.data);
        } else if (message.type === 'replayed') {
          options.onReplayed?.();
        } else if (message.type === 'exited') {
          exited = true;
          options.onExit?.(message.exitCode);
        }
      },
      (error) => options.onClose?.(exited ? null : error),
    );

    if (welcome.protocol !== PROTOCOL) {
      socket.destroy();
      throw new HolderError(otherProtocol(welcome.protocol));
    }

    socket.write(encode({ type: 'attach', session: options.session, cols: options.cols, rows: options.rows }));

    return new Attachment(socket, welcome);
  }

  input(data: string): void {
    this.#socket.write(encode({ type: 'input', data }));
  }

  resize(cols: number, rows: number): void {
    this.#socket.write(encode({ type: 'resize', cols, rows }));
  }

  /** Detaches; the session keeps running. */
  close(): void {
    this.#socket.destroy();
  }
}
