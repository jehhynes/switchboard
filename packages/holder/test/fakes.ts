import { connect } from 'node:net';
import { vi } from 'vitest';
import type { Socket } from 'node:net';
import { Host } from '../src/host.js';
import type { HostOptions, Pty } from '../src/host.js';
import { LineReader } from '../src/protocol.js';

export class FakePty implements Pty {
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  /** Runs inside resize, as a program that redraws at once would. */
  onResize: ((pty: FakePty) => void) | null = null;
  #data: Array<(data: string) => void> = [];
  #exit: Array<(exit: { exitCode: number }) => void> = [];

  constructor(readonly pid: number, readonly file: string, readonly args: string[], readonly options: { cwd: string; env: Record<string, string>; cols: number; rows: number }) {}

  onData(listener: (data: string) => void): void {
    this.#data.push(listener);
  }

  onExit(listener: (exit: { exitCode: number }) => void): void {
    this.#exit.push(listener);
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
    this.onResize?.(this);
  }

  emit(data: string): void {
    for (const listener of this.#data) {
      listener(data);
    }
  }

  exit(exitCode: number): void {
    for (const listener of this.#exit) {
      listener({ exitCode });
    }
  }
}

export interface TestHost {
  host: Host;
  port: number;
  ptys: FakePty[];
  killed: number[];
  shutdowns: number;
  live: number[];
}

export const TOKEN = 'a'.repeat(64);

export async function startHost(options: Partial<HostOptions> & { exitOnKill?: boolean } = {}): Promise<TestHost> {
  const state: TestHost = { host: null as unknown as Host, port: 0, ptys: [], killed: [], shutdowns: 0, live: [] };
  let nextPid = 1000;

  state.host = new Host({
    token: TOKEN,
    build: 'build-1',
    pid: 4242,
    spawnPty: (file, args, ptyOptions) => {
      if (file === 'missing') {
        throw new Error('File not found');
      }

      const pty = new FakePty(nextPid++, file, args, ptyOptions);

      state.ptys.push(pty);

      return pty;
    },
    killTree: (pid) => {
      state.killed.push(pid);

      if (options.exitOnKill !== false) {
        state.ptys.find((pty) => pty.pid === pid)?.exit(1);
      }

      return Promise.resolve(null);
    },
    onShutdown: () => state.shutdowns++,
    onLiveChange: (live) => state.live.push(live),
    ...options,
  });
  state.port = await state.host.listen();

  return state;
}

/** A raw protocol connection that records every message it receives. */
export class Raw {
  readonly messages: Array<Record<string, unknown>> = [];
  closed = false;
  readonly #reader = new LineReader(64 * 1024 * 1024);
  readonly #waiters: Array<() => void> = [];

  private constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      const lines = this.#reader.push(chunk);

      for (const line of Array.isArray(lines) ? lines : []) {
        this.messages.push(JSON.parse(line) as Record<string, unknown>);
      }

      this.#wake();
    });
    socket.on('close', () => {
      this.closed = true;
      this.#wake();
    });
    socket.on('error', () => undefined);
  }

  static open(port: number, allowHalfOpen = false): Promise<Raw> {
    return new Promise((resolve, reject) => {
      const socket = connect({ port, host: '127.0.0.1', allowHalfOpen }, () => resolve(new Raw(socket)));

      socket.once('error', reject);
    });
  }

  static async ready(port: number): Promise<Raw> {
    const raw = await Raw.open(port);

    raw.send({ type: 'hello', token: TOKEN });
    await raw.until((m) => m.type === 'welcome');

    return raw;
  }

  send(message: Record<string, unknown>): void {
    this.socket.write(JSON.stringify(message) + '\n');
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0)) {
      waiter();
    }
  }

  /** Waits for a message that matches, failing after 3 seconds. */
  async until(match: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 3000;

    for (;;) {
      const found = this.messages.find(match);

      if (found !== undefined) {
        return found;
      }

      if (this.closed || Date.now() > deadline) {
        throw new Error(`No matching message; got ${JSON.stringify(this.messages).slice(0, 500)}`);
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);

        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async untilClosed(): Promise<void> {
    const deadline = Date.now() + 3000;

    while (!this.closed) {
      if (Date.now() > deadline) {
        throw new Error('The connection stayed open.');
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** Waits until `check` passes, within the test's own 5-second timeout, for work the host does on its own sockets and timers. */
export const until = (check: () => unknown): Promise<unknown> => vi.waitFor(check, { timeout: 4_500, interval: 5 });
