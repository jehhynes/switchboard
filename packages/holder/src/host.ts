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

/** A listener registration that `dispose` removes, as node-pty returns. */
export interface Disposable {
  dispose(): void;
}

/** The part of a node-pty process the host uses, so tests can pass a fake. */
export interface Pty {
  readonly pid: number;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (exit: { exitCode: number }) => void): Disposable;
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
  /** Frees what the pseudo-terminal library keeps after the program exited, such as node-pty's output thread on Windows (mechanics M168). */
  releasePty?: (pty: Pty) => void;
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
  /** When an attached client last typed; a `write` changes `lastInputAt` only. */
  keyAt: number | null;
  lastOutputAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  /** When the holder closed the pseudo-terminal to end the program (`performance.now()`); input and resizes stop then. */
  closedAt: number | null;
  pty: Pty;
  /** The `onData` and `onExit` registrations, removed when the session is forgotten so the pseudo-terminal cannot keep it. */
  listeners: Disposable[];
  /** The screen and scrollback, until the program's last output is parsed after its exit; then `ended` keeps what it still serves. */
  term: InstanceType<typeof headless.Terminal> | null;
  serializer: InstanceType<typeof serializeAddon.SerializeAddon> | null;
  /** Set once the terminal is being disposed, which waits for the writes queued before it. */
  disposing: boolean;
  ended: Ended | null;
  head: string;
  /** The size last given to the pseudo-terminal; the headless screen follows once the output before it is parsed. */
  cols: number;
  rows: number;
  clients: Set<Connection>;
  /** Clients that watch the screen without attaching (`view`): they get its output and sizes, and set neither its size nor `clients`. */
  viewers: Set<Connection>;
  /** Rises on every output, resize and input, so a snapshot reader can tell a screen it has already read. */
  rev: number;
  exitWaiters: Set<() => void>;
  removal: NodeJS.Timeout | null;
}

/**
 * What an exited session still serves, serialized once the program's last output is parsed, so the terminal and its scrollback are freed at
 * the exit rather than when the session is forgotten (mechanics M168).
 */
interface Ended {
  /** The visible screen as plain text, as `screen` answers it. */
  text: string;
  /** The screen and all its scrollback serialized, as a replay sends it. */
  data: string;
  /** What a replay needs after `data` to leave mouse reporting as the program set it. */
  mouse: string;
  cols: number;
  rows: number;
  /** Snapshots by the scrollback they hold, fewest first, the last of them `data` with all of it. */
  snapshots: Array<{ scrollback: number; data: string }>;
}

/**
 * The string as one flat copy. The serializer builds its result by concatenation, which V8 keeps as a tree of pieces, about ten times the
 * size of the text, until something reads the characters (mechanics M168); reading one makes V8 flatten it.
 */
function flat(text: string): string {
  text.charCodeAt(0);

  return text;
}

/**
 * The scrollbacks an exited session keeps a snapshot of besides all of it: the sizes the hub reads, the screen alone and the conversation's
 * 400 lines (`SNAPSHOT_SCROLLBACK` in packages/conversation). A snapshot of another size gets the next larger one kept.
 */
const KEPT_SCROLLBACKS = [0, 400];

interface Connection {
  socket: Socket;
  state: 'hello' | 'ready' | 'attach' | 'view' | 'closed';
  watching: boolean;
  held: Held | null;
  /** Output, and for a viewer the sizes, that arrive while the replay is being prepared; sent after it. */
  pending: Array<string | { cols: number; rows: number }> | null;
  /** The replay is being written with backpressure, so the queue limit does not apply to it. */
  replaying: boolean;
  /** The characters held in `pending`, which the queue limit bounds as it bounds the socket's queue. */
  pendingChars: number;
  cols: number;
  rows: number;
}

const TRACKING_MODES: Record<string, number> = { x10: 9, vt200: 1000, drag: 1002, any: 1003 };
const ENCODING_MODES: Record<string, string> = { DEFAULT: '', SGR: '\u001b[?1006h', SGR_PIXELS: '\u001b[?1016h' };

/**
 * Turns off the modes that make a terminal send reports: mouse tracking and its encodings, and focus reports. A replay starts with it,
 * because the attach client reuses its terminal and the serialized screen only turns modes on (mechanics M101).
 */
export const REPORTS_OFF = '\u001b[?9l\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1004l\u001b[?1005l\u001b[?1006l\u001b[?1015l\u001b[?1016l';

/**
 * What a replay needs after `SerializeAddon.serialize` to leave a terminal's mouse reporting as the program set it. The addon restores
 * mouse tracking (DECSET 9, 1000, 1002, 1003) but not its encoding, so a terminal fed the replay alone sends legacy `ESC [ M` reports
 * that a program which asked for SGR reports (DECSET 1006) reads as Esc and typed text. This adds the program's encoding, read from
 * xterm's mouse service, which has no public API; when that cannot be read it turns the tracking off instead (mechanics M101).
 */
export function mouseEncoding(term: { modes: { mouseTrackingMode: string } }): string {
  const tracking = TRACKING_MODES[term.modes.mouseTrackingMode];

  if (tracking === undefined) {
    return '';
  }

  const encoding = (term as { _core?: { coreMouseService?: { activeEncoding?: unknown } } })._core?.coreMouseService?.activeEncoding;

  return typeof encoding === 'string' && Object.hasOwn(ENCODING_MODES, encoding) ? ENCODING_MODES[encoding]! : `\u001b[?${tracking}l`;
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
    const connection: Connection = { socket, state: 'hello', watching: false, held: null, pending: null, replaying: false, pendingChars: 0, cols: 0, rows: 0 };
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

    held?.viewers.delete(connection);

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

    if (connection.state === 'view') {
      this.#refuse(connection, `A viewing client cannot send ${message.type}.`);
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
      case 'write':
        this.#write(connection, message.id, message.session, message.data, message.key === true);
        return;
      case 'size':
        this.#size(connection, message.id, message.session, message.cols, message.rows);
        return;
      case 'view':
        this.#view(connection, message.session);
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
      keyAt: null,
      lastOutputAt: null,
      exitedAt: null,
      exitCode: null,
      closedAt: null,
      pty,
      listeners: [],
      term,
      serializer,
      disposing: false,
      ended: null,
      head: '',
      cols: request.cols,
      rows: request.rows,
      clients: new Set(),
      viewers: new Set(),
      rev: 0,
      exitWaiters: new Set(),
      removal: null,
    };

    this.#sessions.set(request.session, held);
    held.listeners.push(
      pty.onData((data) => this.#output(held, data)),
      pty.onExit(({ exitCode }) => this.#exited(held, exitCode)),
    );
    this.#send(connection, { type: 'spawned', re: id, session: held.session, pid: held.pid });
    this.#options.onLiveChange?.(this.live());
  }

  #output(held: Held, data: string): void {
    if (held.ended === null) {
      held.term?.write(data);
    }

    held.lastOutputAt = this.#now();
    held.rev++;

    if (held.head.length < HEAD_CHARS) {
      held.head += data.slice(0, HEAD_CHARS - held.head.length);
    }

    for (const client of [...held.clients, ...held.viewers]) {
      if (client.pending !== null) {
        client.pending.push(data);
        client.pendingChars += data.length;

        // A client whose replay is read slowly while the program writes much is dropped, as one that does not read its output is.
        if (client.pendingChars > (this.#options.clientQueueBytes ?? CLIENT_QUEUE_BYTES)) {
          client.state = 'closed';
          client.pending = null;
          client.socket.destroy();
        }
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

    try {
      this.#options.releasePty?.(held.pty);
    } catch (error) {
      this.#options.log?.(`The terminal of session ${held.session} could not be released: ${(error as Error).message}`);
    }

    // A client still waiting for its replay is told after it; the others once the output still being parsed is on the last screen.
    const ready = [...held.clients, ...held.viewers].filter((client) => client.pending === null);

    this.#parsed(held, () => {
      this.#keepEnded(held);

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

    for (const listener of held.listeners.splice(0)) {
      listener.dispose();
    }

    this.#dispose(held);
  }

  /** Runs `read` once the output already received is parsed; at once for an exited session, whose screen no longer changes. */
  #parsed(held: Held, read: () => void): void {
    if (held.ended !== null || held.term === null) {
      read();
      return;
    }

    held.term.write('', read);
  }

  /** Keeps what an exited session serves as text and disposes its terminal. */
  #keepEnded(held: Held): void {
    const term = held.term;

    if (held.ended !== null || term === null || held.disposing) {
      return;
    }

    const serializer = held.serializer!;
    const data = flat(serializer.serialize({ scrollback: SCROLLBACK_LINES }));
    // A smaller snapshot is kept only when the buffer has more scrollback than it, since it would be `data` otherwise.
    const above = term.buffer.normal.length - term.rows;

    held.ended = {
      text: flat(this.#screenText(held)),
      data,
      mouse: mouseEncoding(term),
      cols: term.cols,
      rows: term.rows,
      snapshots: [
        ...KEPT_SCROLLBACKS.filter((scrollback) => scrollback < above).map((scrollback) => ({ scrollback, data: flat(serializer.serialize({ scrollback })) })),
        { scrollback: SCROLLBACK_LINES, data },
      ],
    };
    this.#dispose(held);
  }

  /** Disposes the terminal after the writes and reads already queued on it. */
  #dispose(held: Held): void {
    const term = held.term;

    if (term === null || held.disposing) {
      return;
    }

    held.disposing = true;
    // Outside xterm's write loop, which runs this callback.
    term.write('', () =>
      setImmediate(() => {
        held.term = null;
        held.serializer = null;
        term.dispose();
      }),
    );
  }

  #screenText(held: Held): string {
    if (held.ended !== null) {
      return held.ended.text;
    }

    const term = held.term!;
    const buffer = term.buffer.active;
    const lines: string[] = [];

    for (let row = buffer.baseY; row < buffer.baseY + term.rows; row++) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
    }

    return lines.join('\n');
  }

  /** The size the screen is drawn at. */
  #drawn(held: Held): { cols: number; rows: number } {
    const { cols, rows } = held.ended ?? held.term!;

    return { cols, rows };
  }

  /** An exited session's snapshot of at least `scrollback` lines: the smallest it kept, which can hold more scrollback than asked. */
  #endedSnapshot(ended: Ended, scrollback: number): string {
    return (ended.snapshots.find((kept) => kept.scrollback >= scrollback) ?? ended.snapshots.at(-1)!).data;
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

    this.#parsed(held, () => this.#send(connection, { type: 'screen', re: id, session, head: held.head, text: this.#screenText(held) }));
  }

  /** The screen and `scrollback` lines above it with their attributes, once the output already received is parsed. */
  #snapshot(connection: Connection, id: number, session: string, scrollback: number): void {
    const held = this.#sessions.get(session);

    if (held === undefined) {
      this.#send(connection, { type: 'error', re: id, message: `No session ${session} is held.` });
      return;
    }

    const rev = held.rev;

    this.#parsed(held, () => {
      const data = held.ended === null ? held.serializer!.serialize({ scrollback }) : this.#endedSnapshot(held.ended, scrollback);

      this.#send(connection, { type: 'snapshot', re: id, session, data, ...this.#drawn(held), rev, keyAt: held.keyAt });
    });
  }

  /**
   * Input from a client that is not attached, such as the hub typing a message: no resize and no `clients` count. It counts as input for
   * `lastInputAt` and the revision, and as a key typed in a terminal (`keyAt`) only with `key`, as the web page's console sends its keys.
   */
  #write(connection: Connection, id: number, session: string, data: string, key: boolean): void {
    const held = this.#sessions.get(session);

    if (held === undefined) {
      this.#send(connection, { type: 'error', re: id, message: `No session ${session} is held.` });
      return;
    }

    if (held.exitedAt !== null || held.closedAt !== null) {
      this.#send(connection, { type: 'error', re: id, message: `Session ${session} has ended.` });
      return;
    }

    held.lastInputAt = this.#now();

    if (key) {
      held.keyAt = held.lastInputAt;
    }

    held.rev++;
    held.pty.write(data);
    this.#send(connection, { type: 'written', re: id, session, rev: held.rev });
  }

  /** Resizes a session's pseudo-terminal for a client that is not attached and types through `write`, so the program draws for its screen. */
  #size(connection: Connection, id: number, session: string, cols: number, rows: number): void {
    const held = this.#sessions.get(session);

    if (held === undefined) {
      this.#send(connection, { type: 'error', re: id, message: `No session ${session} is held.` });
      return;
    }

    if (held.exitedAt !== null || held.closedAt !== null) {
      this.#send(connection, { type: 'error', re: id, message: `Session ${session} has ended.` });
      return;
    }

    this.#resize(held, cols, rows);
    this.#send(connection, { type: 'sized', re: id, session, rev: held.rev });
  }

  /**
   * Watches a session without attaching: the screen at the size the program draws it, then its output and each resize, so a reader that must not
   * change the session's size, such as the web page's console, can show it. Input and resizes from it close the connection.
   */
  #view(connection: Connection, session: string): void {
    const held = this.#sessions.get(session);

    if (held === undefined) {
      this.#refuse(connection, `No session ${session} is held.`);
      return;
    }

    connection.state = 'view';
    connection.held = held;
    connection.pending = [];

    if (held.exitedAt === null) {
      held.viewers.add(connection);
    }

    this.#parsed(held, () => void this.#replay(connection, held));
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
    this.#parsed(held, () => void this.#replay(connection, held));
  }

  /** Writes the replay at the pace the client reads it, then the output that arrived meanwhile. */
  async #replay(connection: Connection, held: Held): Promise<void> {
    connection.replaying = true;

    // A viewer draws at the program's size, which is the screen's once the output and resizes queued before it are parsed.
    if (connection.state === 'view') {
      this.#send(connection, { type: 'resized', ...this.#drawn(held) });
    }

    const screen = held.ended === null ? held.serializer!.serialize({ scrollback: SCROLLBACK_LINES }) + mouseEncoding(held.term!) : held.ended.data + held.ended.mouse;

    for (const part of chunkData(REPORTS_OFF + screen)) {
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
      if (typeof data !== 'string') {
        this.#send(connection, { type: 'resized', ...data });
        continue;
      }

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
    held.keyAt = held.lastInputAt;
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

    // A viewer gets the size in order with the output, which from here is drawn at it.
    for (const viewer of held.viewers) {
      if (viewer.pending !== null) {
        viewer.pending.push({ cols, rows });
      } else {
        this.#send(viewer, { type: 'resized', cols, rows });
      }
    }

    // Output already queued was drawn at the old size, so the screen resizes after it is parsed.
    held.term?.write('', () => held.term?.resize(cols, rows));
  }
}
