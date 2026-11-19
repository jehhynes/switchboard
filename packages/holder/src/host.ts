import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import headless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import {
  CLIENT_QUEUE_BYTES,
  EXIT_RETENTION_MS,
  FEATURES,
  HEAD_CHARS,
  HELLO_DEADLINE_MS,
  CLOSE_GRACE_MS,
  KILL_DEADLINE_MS,
  LineReader,
  PROTOCOL,
  SCROLLBACK_LINES,
  chunkData,
  encode,
  parseClientMessage,
} from './protocol.js';
import type { ClientMessage, HostMessage, SessionEntry, SpawnRequest } from './protocol.js';

/** The part of a node-pty process the host uses, so tests can pass a fake. */
export interface Pty {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (exit: { exitCode: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

export type PtyFactory = (file: string, args: string[], options: { cwd: string; env: Record<string, string>; cols: number; rows: number }) => Pty;

export interface HostOptions {
  token: string;
  build: string;
  pid?: number;
  /** The protocol to announce; tests set another to stand for a holder of another version. */
  protocol?: number;
  spawnPty: PtyFactory;
  /** Ends a process and its descendants. */
  killTree: (pid: number) => Promise<{ error: string } | null>;
  /**
   * Closes a session's pseudo-terminal without killing its program, so the program runs its own cleanup (mechanics M78); false when it cannot.
   * Without it, or when it fails, an end kills the process tree at once.
   */
  closePty?: (pty: Pty) => boolean;
  /** How long a program has to exit after its pseudo-terminal closed before its process tree is killed. */
  closeGraceMs?: number;
  log?: (message: string) => void;
  /** The memory of each live session's process tree, by pid; called by `list`. */
  memory?: (pids: number[]) => Map<number, number>;
  /** The members of a live session's process tree as last read, with their creation times; called by `list`. */
  tree?: (pid: number) => Array<{ pid: number; created: string }>;
  now?: () => number;
  /** Called after a `shutdown` request was accepted and answered. */
  onShutdown?: () => void;
  /** Called when the number of live sessions changes. */
  onLiveChange?: (live: number) => void;
  helloDeadlineMs?: number;
  clientQueueBytes?: number;
  killDeadlineMs?: number;
  exitRetentionMs?: number;
}

interface Held {
  session: string;
  label: string;
  pid: number;
  cwd: string;
  startedAt: number;
  lastInputAt: number | null;
  lastOutputAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  /** When the holder closed the pseudo-terminal to end the program (`performance.now()`); input and resizes stop then. */
  closedAt: number | null;
  pty: Pty;
  term: InstanceType<typeof headless.Terminal>;
  serializer: InstanceType<typeof serializeAddon.SerializeAddon>;
  head: string;
  /** The size last given to the pseudo-terminal; the headless screen follows once the output before it is parsed. */
  cols: number;
  rows: number;
  clients: Set<Connection>;
  /** Rises on every output, resize and input, so a snapshot reader can tell a screen it has already read. */
  rev: number;
  exitWaiters: Set<() => void>;
  removal: NodeJS.Timeout | null;
}

interface Connection {
  socket: Socket;
  state: 'hello' | 'ready' | 'attach' | 'closed';
  watching: boolean;
  held: Held | null;
  /** Output that arrives while the replay is being prepared; sent after it. */
  pending: string[] | null;
  /** The replay is being written with backpressure, so the queue limit does not apply to it. */
  replaying: boolean;
  cols: number;
  rows: number;
}

/** Holds programs in pseudo-terminals and serves the holder protocol on loopback. */
export class Host {
  readonly #options: HostOptions;
  readonly #now: () => number;
  readonly #sessions = new Map<string, Held>();
  readonly #connections = new Set<Connection>();
  #server: Server | null = null;
  /** Set once the holder ends its sessions to exit; spawns are refused from then on. */
  #exiting = false;

  constructor(options: HostOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Listens on 127.0.0.1 and resolves the port. */
  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.#accept(socket));

      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.#server = server;
        resolve((server.address() as { port: number }).port);
      });
    });
  }

  /** Stops listening and drops every client. Held programs keep running. */
  close(): Promise<void> {
    for (const connection of this.#connections) {
      connection.socket.destroy();
    }

    for (const held of this.#sessions.values()) {
      if (held.removal !== null) {
        clearTimeout(held.removal);
      }
    }

    return new Promise((resolve) => (this.#server === null ? resolve() : this.#server.close(() => resolve())));
  }

  /** The number of open client connections. */
  connections(): number {
    return this.#connections.size;
  }

  /** The number of sessions whose program is running. */
  live(): number {
    return [...this.#sessions.values()].filter((held) => held.exitedAt === null).length;
  }

  list(): SessionEntry[] {
    const held = [...this.#sessions.values()];
    const memory = this.#options.memory?.(held.filter((one) => one.exitedAt === null).map((one) => one.pid)) ?? new Map<number, number>();

    return held.map((one) => ({
      session: one.session,
      label: one.label,
      pid: one.pid,
      cwd: one.cwd,
      startedAt: one.startedAt,
      lastInputAt: one.lastInputAt,
      lastOutputAt: one.lastOutputAt,
      exitedAt: one.exitedAt,
      exitCode: one.exitCode,
      clients: one.clients.size,
      memoryBytes: one.exitedAt === null ? (memory.get(one.pid) ?? null) : null,
      ...(one.exitedAt === null && this.#options.tree !== undefined ? { tree: this.#options.tree(one.pid) } : {}),
    }));
  }

  #accept(socket: Socket): void {
    const connection: Connection = { socket, state: 'hello', watching: false, held: null, pending: null, replaying: false, cols: 0, rows: 0 };
    const reader = new LineReader();
    const deadline = setTimeout(() => this.#refuse(connection, 'No hello within the deadline.'), this.#options.helloDeadlineMs ?? HELLO_DEADLINE_MS);

    this.#connections.add(connection);
    socket.on('data', (chunk: Buffer) => {
      const lines = reader.push(chunk);

      if (!Array.isArray(lines)) {
        this.#refuse(connection, lines.error);
        return;
      }

      for (const line of lines) {
        if (connection.state === 'closed') {
          return;
        }

        const message = parseClientMessage(line);

        if ('error' in message) {
          this.#refuse(connection, message.error);
        } else {
          if (message.type === 'hello') {
            clearTimeout(deadline);
          }

          this.#handle(connection, message);
        }
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(deadline);
      this.#drop(connection);
    });
  }

  #send(connection: Connection, message: HostMessage): void {
    if (connection.state === 'closed' || connection.socket.destroyed) {
      return;
    }

    connection.socket.write(encode(message));

    // A client that does not read is dropped, so the session's output never waits on it.
    if (!connection.replaying && connection.socket.writableLength > (this.#options.clientQueueBytes ?? CLIENT_QUEUE_BYTES)) {
      connection.state = 'closed';
      connection.socket.destroy();
    }
  }

  #refuse(connection: Connection, message: string): void {
    this.#send(connection, { type: 'error', message });
    this.#end(connection);
  }

  #end(connection: Connection): void {
    connection.state = 'closed';
    connection.socket.end();
    // A peer that never closes its side is cut off once the last message had time to leave.
    setTimeout(() => connection.socket.destroy(), 1_000).unref();
  }

  #drop(connection: Connection): void {
    connection.state = 'closed';
    this.#connections.delete(connection);

    const held = connection.held;

    if (held !== null && held.clients.delete(connection)) {
      this.#broadcast({ type: 'detached', session: held.session, clients: held.clients.size });
    }
  }

  #broadcast(message: HostMessage): void {
    for (const connection of this.#connections) {
      if (connection.watching) {
        this.#send(connection, message);
      }
    }
  }

  #handle(connection: Connection, message: ClientMessage): void {
    if (connection.state === 'hello') {
      if (message.type !== 'hello' || !this.#tokenMatches(message.token)) {
        this.#refuse(connection, message.type === 'hello' ? 'Wrong token.' : 'The first message must be hello.');
        return;
      }

      connection.state = 'ready';
      this.#send(connection, { type: 'welcome', protocol: this.#options.protocol ?? PROTOCOL, build: this.#options.build, pid: this.#options.pid ?? process.pid, features: [...FEATURES] });
      return;
    }

    if (connection.state === 'attach') {
      if (message.type === 'input') {
        this.#input(connection, message.data);
      } else if (message.type === 'resize') {
        connection.cols = message.cols;
        connection.rows = message.rows;
        this.#resize(connection.held!, message.cols, message.rows);
      } else {
        this.#refuse(connection, `An attached client cannot send ${message.type}.`);
      }

      return;
    }

    switch (message.type) {
      case 'spawn':
        this.#spawn(connection, message.id, message);
        return;
      case 'list':
        this.#send(connection, { type: 'sessions', re: message.id, sessions: this.list() });
        return;
      case 'kill':
        void this.#kill(connection, message.id, message.session);
        return;
      case 'screen':
        this.#screen(connection, message.id, message.session);
        return;
      case 'snapshot':
        this.#snapshot(connection, message.id, message.session, message.scrollback);
        return;
      case 'watch':
        connection.watching = true;
        this.#send(connection, { type: 'watching', re: message.id });
        return;
      case 'shutdown':
        this.#shutdown(connection, message.id);
        return;
      case 'attach':
        this.#attach(connection, message.session, message.cols, message.rows);
        return;
      default:
        this.#refuse(connection, `${message.type} needs an attached session.`);
    }
  }

  #tokenMatches(token: string): boolean {
    const given = Buffer.from(token);
    const expected = Buffer.from(this.#options.token);

    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  #spawn(connection: Connection, id: number, request: SpawnRequest): void {
    if (this.#exiting) {
      this.#send(connection, { type: 'error', re: id, message: 'The terminal holder is exiting.' });
      return;
    }

    const existing = this.#sessions.get(request.session);

    if (existing !== undefined && existing.exitedAt === null) {
      this.#send(connection, { type: 'error', re: id, message: `Session ${request.session} is already held.` });
      return;
    }

    let pty: Pty;

    try {
      pty = this.#options.spawnPty(request.file, request.args, { cwd: request.cwd, env: request.env, cols: request.cols, rows: request.rows });
    } catch (error) {
      this.#send(connection, { type: 'error', re: id, message: `${request.file} could not be started: ${(error as Error).message}` });
      return;
    }

    if (existing !== undefined) {
      this.#forget(existing);
    }

    const term = new headless.Terminal({ cols: request.cols, rows: request.rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    const serializer = new serializeAddon.SerializeAddon();

    term.loadAddon(serializer);

    const held: Held = {
      session: request.session,
      label: request.label,
      pid: pty.pid,
      cwd: request.cwd,
      startedAt: this.#now(),
      lastInputAt: null,
      lastOutputAt: null,
      exitedAt: null,
      exitCode: null,
      closedAt: null,
      pty,
      term,
      serializer,
      head: '',
      cols: request.cols,
      rows: request.rows,
      clients: new Set(),
      rev: 0,
      exitWaiters: new Set(),
      removal: null,
    };

    this.#sessions.set(request.session, held);
    pty.onData((data) => this.#output(held, data));
    pty.onExit(({ exitCode }) => this.#exited(held, exitCode));
    this.#send(connection, { type: 'spawned', re: id, session: held.session, pid: held.pid });
    this.#options.onLiveChange?.(this.live());
  }

  #output(held: Held, data: string): void {
    held.term.write(data);
    held.lastOutputAt = this.#now();
    held.rev++;

    if (held.head.length < HEAD_CHARS) {
      held.head += data.slice(0, HEAD_CHARS - held.head.length);
    }

    for (const client of held.clients) {
      if (client.pending !== null) {
        client.pending.push(data);
      } else {
        for (const part of chunkData(data)) {
          this.#send(client, { type: 'output', data: part });
        }
      }
    }
  }

  #exited(held: Held, exitCode: number): void {
    if (held.exitedAt !== null) {
      return;
    }

    held.exitedAt = this.#now();
    held.exitCode = exitCode;

    // A client still waiting for its replay is told after it; the others once the output still being parsed is on the last screen.
    const ready = [...held.clients].filter((client) => client.pending === null);

    held.term.write('', () => {
      for (const client of ready) {
        this.#send(client, { type: 'exited', exitCode });
        this.#end(client);
      }
    });
    this.#broadcast({ type: 'exited', session: held.session, exitCode });

    for (const waiter of held.exitWaiters) {
      waiter();
    }

    held.removal = setTimeout(() => this.#forget(held), this.#options.exitRetentionMs ?? EXIT_RETENTION_MS);
    held.removal.unref();
    this.#options.onLiveChange?.(this.live());
  }

  #forget(held: Held): void {
    if (held.removal !== null) {
      clearTimeout(held.removal);
    }

    if (this.#sessions.get(held.session) === held) {
      this.#sessions.delete(held.session);
    }

    held.term.dispose();
  }

  async #kill(connection: Connection, id: number, session: string): Promise<void> {
    const held = this.#sessions.get(session);

    if (held === undefined) {
      this.#send(connection, { type: 'error', re: id, message: `No session ${session} is held.` });
      return;
    }

    if (held.exitedAt === null) {
      const deadlineMs = this.#options.killDeadlineMs ?? KILL_DEADLINE_MS;
      const outcome = await this.#endProgram(held, deadlineMs);

      if (outcome === 'late') {
        this.#send(connection, { type: 'error', re: id, message: `Session ${session} did not exit within ${deadlineMs / 1000} seconds.` });
        return;
      }

      if (outcome !== 'exited' && held.exitedAt === null) {
        this.#send(connection, { type: 'error', re: id, message: `Session ${session} could not be ended: ${outcome.error}` });
        return;
      }
    }

    this.#send(connection, { type: 'killed', re: id, session, exitCode: held.exitCode });
  }

  /** Refuses spawns from now on and ends every live session as `kill` does, before the holder exits. */
  async endAll(): Promise<void> {
    this.#exiting = true;

    const deadlineMs = this.#options.killDeadlineMs ?? KILL_DEADLINE_MS;

    await Promise.all(
      [...this.#sessions.values()]
        .filter((held) => held.exitedAt === null)
        .map(async (held) => {
          const outcome = await this.#endProgram(held, deadlineMs);

          if (outcome !== 'exited' && held.exitedAt === null) {
            this.#options.log?.(`Session ${held.session} could not be ended: ${outcome === 'late' ? `it did not exit within ${deadlineMs / 1000} seconds` : outcome.error}`);
          }
        }),
    );
  }

  /**
   * Closes the pseudo-terminal, so the program can end its own children, and kills the process tree if the program has not exited within the
   * grace time, or at once when the pseudo-terminal cannot be closed. One deadline covers both, so an end that hangs is answered too.
   */
  async #endProgram(held: Held, deadlineMs: number): Promise<'exited' | 'late' | { error: string }> {
    const timers: NodeJS.Timeout[] = [];
    const after = <T>(ms: number, value: T): Promise<T> => new Promise((resolve) => timers.push(setTimeout(() => resolve(value), Math.max(0, ms))));
    let waiter: (() => void) | undefined;
    const exited = new Promise<'exited'>((resolve) => {
      waiter = () => resolve('exited');
      held.exitWaiters.add(waiter);
    });
    const deadline = after(deadlineMs, 'late' as const);

    try {
      if (this.#close(held)) {
        const graceMs = this.#options.closeGraceMs ?? CLOSE_GRACE_MS;
        const first = await Promise.race([exited, deadline, after(graceMs - (performance.now() - held.closedAt!), 'grace' as const)]);

        if (first !== 'grace') {
          return first;
        }

        this.#options.log?.(`Session ${held.session} did not exit within ${graceMs / 1000} seconds of its terminal closing; ending its process tree.`);
      }

      return await Promise.race([exited, deadline, this.#options.killTree(held.pid).then((failed) => (failed === null ? new Promise<never>(() => undefined) : failed))]);
    } finally {
      for (const timer of timers) {
        clearTimeout(timer);
      }

      held.exitWaiters.delete(waiter!);
    }
  }

  /** Closes the session's pseudo-terminal once; true when it is closed. */
  #close(held: Held): boolean {
    if (held.closedAt !== null) {
      return true;
    }

    let closed = false;

    try {
      closed = this.#options.closePty?.(held.pty) ?? false;
    } catch (error) {
      this.#options.log?.(`The terminal of session ${held.session} could not be closed: ${(error as Error).message}`);
    }

    if (closed) {
      held.closedAt = performance.now();
    } else if (this.#options.closePty !== undefined) {
      this.#options.log?.(`The terminal of session ${held.session} cannot be closed; ending its process tree.`);
    }

    return closed;
  }

  #screen(connection: Connection, id: number, session: string): void {
    const held = this.#sessions.get(session);

    if (held === undefined) {
      this.#send(connection, { type: 'error', re: id, message: `No session ${session} is held.` });
      return;
    }

    held.term.write('', () => {
      const buffer = held.term.buffer.active;
      const lines: string[] = [];

      for (let row = buffer.baseY; row < buffer.baseY + held.term.rows; row++) {
        lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
      }

      this.#send(connection, { type: 'screen', re: id, session, head: held.head, text: lines.join('\n') });
    });
  }

  /** The screen and `scrollback` lines above it with their attributes, once the output already received is parsed. */
  #snapshot(connection: Connection, id: number, session: string, scrollback: number): void {
    const held = this.#sessions.get(session);

    if (held === undefined) {
      this.#send(connection, { type: 'error', re: id, message: `No session ${session} is held.` });
      return;
    }

    const rev = held.rev;

    held.term.write('', () =>
      this.#send(connection, { type: 'snapshot', re: id, session, data: held.serializer.serialize({ scrollback }), cols: held.term.cols, rows: held.term.rows, rev }),
    );
  }

  #shutdown(connection: Connection, id: number): void {
    const live = this.live();

    if (live > 0) {
      this.#send(connection, { type: 'error', re: id, message: `The terminal holder holds ${live} live session${live === 1 ? '' : 's'}.` });
      return;
    }

    this.#send(connection, { type: 'bye', re: id });
    this.#options.onShutdown?.();
  }

  #attach(connection: Connection, session: string, cols: number, rows: number): void {
    const held = this.#sessions.get(session);

    if (held === undefined) {
      this.#refuse(connection, `No session ${session} is held.`);
      return;
    }

    connection.state = 'attach';
    connection.held = held;
    connection.cols = cols;
    connection.rows = rows;
    connection.pending = [];

    if (held.exitedAt === null) {
      // Claude redraws at the client's size, so the replay matches the client's terminal (mechanics M72).
      this.#resize(held, cols, rows);
      held.clients.add(connection);
      this.#broadcast({ type: 'attached', session, clients: held.clients.size });
    }

    // Output queued before this point is in the replay; output after it goes to pending.
    held.term.write('', () => void this.#replay(connection, held));
  }

  /** Writes the replay at the pace the client reads it, then the output that arrived meanwhile. */
  async #replay(connection: Connection, held: Held): Promise<void> {
    connection.replaying = true;

    for (const part of chunkData(held.serializer.serialize({ scrollback: SCROLLBACK_LINES }))) {
      if (connection.state === 'closed' || connection.socket.destroyed) {
        return;
      }

      if (!connection.socket.write(encode({ type: 'replay', data: part }))) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            connection.socket.off('drain', done);
            connection.socket.off('close', done);
            resolve();
          };

          connection.socket.on('drain', done);
          connection.socket.on('close', done);
        });
      }
    }

    connection.replaying = false;
    this.#send(connection, { type: 'replayed' });

    for (const data of connection.pending ?? []) {
      for (const part of chunkData(data)) {
        this.#send(connection, { type: 'output', data: part });
      }
    }

    connection.pending = null;

    if (held.exitedAt !== null) {
      this.#send(connection, { type: 'exited', exitCode: held.exitCode });
      this.#end(connection);
    }
  }

  #input(connection: Connection, data: string): void {
    const held = connection.held!;

    if (held.exitedAt !== null || held.closedAt !== null) {
      return;
    }

    // The client that types sets the size, so the screen fits the terminal in use.
    if (held.cols !== connection.cols || held.rows !== connection.rows) {
      this.#resize(held, connection.cols, connection.rows);
    }

    held.lastInputAt = this.#now();
    held.rev++;
    held.pty.write(data);
  }

  #resize(held: Held, cols: number, rows: number): void {
    if (held.exitedAt !== null || held.closedAt !== null || (held.cols === cols && held.rows === rows)) {
      return;
    }

    held.cols = cols;
    held.rows = rows;
    held.rev++;
    held.pty.resize(cols, rows);
    // Output already queued was drawn at the old size, so the screen resizes after it is parsed.
    held.term.write('', () => held.term.resize(cols, rows));
  }
}
