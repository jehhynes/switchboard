import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { cliEnvironment, executableDirOnPath } from '@switchboard/core';

export type Json = Record<string, unknown>;
export const object = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};

/** A refused request is known not to have succeeded; a lost connection or timeout is not. */
export class AppServerError extends Error {
  constructor(message: string, readonly refused = false, readonly notSent = false) { super(message); }
}

export interface RpcConnection {
  send(message: Json): void | Promise<void>;
  close(): void;
}

export interface AppServerDeps {
  codexPath(): string;
  codexHome: string;
  env: Record<string, string>;
  log(line: string): void;
  timeoutMs?: number;
  /** Tests supply a recorded-protocol peer, never a developer daemon. */
  connect?(receive: (message: Json) => void, closed: (error: string) => void): Promise<RpcConnection>;
}

/** One reconnectable client of Codex's built-in daemon. Closing it never stops the daemon or its threads. */
export class AppServer {
  #connection: RpcConnection | null = null;
  #connecting: Promise<RpcConnection> | null = null;
  #generation = 0;
  #seq = 0;
  #pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  #listeners = new Set<(message: Json) => void>();
  #closed = false;

  constructor(private readonly deps: AppServerDeps) {}

  listen(listener: (message: Json) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get generation(): number { return this.#generation; }

  async request(method: string, params: Json = {}): Promise<Json> {
    const connection = await this.#find();
    return this.#request(connection, method, params);
  }

  async respond(id: string | number, result: unknown): Promise<void> {
    // A response belongs to this connection; reconnecting cannot answer a stale request.
    if (this.#connection === null) throw new AppServerError('Codex disconnected; reopen the pending request.');
    await this.#connection.send({ id, result });
  }

  close(): void {
    this.#closed = true;
    this.#lost('Switchboard disconnected from Codex.');
  }

  async #find(): Promise<RpcConnection> {
    if (this.#closed) throw new AppServerError('The Codex client has closed.');
    if (this.#connecting !== null) return this.#connecting;
    if (this.#connection !== null) return this.#connection;
    this.#connecting ??= this.#connect().finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async #connect(): Promise<RpcConnection> {
    const generation = ++this.#generation;
    const receive = (message: Json): void => {
      if (generation !== this.#generation) return;
      if (typeof message['id'] === 'number' && message['method'] === undefined) {
        const pending = this.#pending.get(message['id']);
        if (pending === undefined) return;
        this.#pending.delete(message['id']);
        clearTimeout(pending.timer);
        if (message['error'] !== undefined) pending.reject(new AppServerError(String(object(message['error'])['message'] ?? 'Codex refused the request.'), true));
        else pending.resolve(object(message['result']));
      } else {
        for (const listener of this.#listeners) listener(message);
      }
    };
    const closed = (error: string): void => { if (generation === this.#generation) this.#lost(error); };
    const connection = await (this.deps.connect?.(receive, closed) ?? connectDaemon(this.deps, receive, closed));
    if (this.#closed || generation !== this.#generation) { connection.close(); throw new AppServerError('Codex disconnected while connecting.'); }
    this.#connection = connection;
    try {
      await this.#request(connection, 'initialize', { clientInfo: { name: 'switchboard', version: '0.0.0' }, capabilities: { experimentalApi: true } });
      await connection.send({ method: 'initialized' });
      return connection;
    } catch (error) {
      this.#lost(String(error));
      throw error;
    }
  }

  #request(connection: RpcConnection, method: string, params: Json): Promise<Json> {
    return new Promise((resolve, reject) => {
      const id = ++this.#seq;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AppServerError(`Codex did not answer ${method}; its outcome is unknown.`));
      }, this.deps.timeoutMs ?? 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      try { Promise.resolve(connection.send({ id, method, params })).catch(error => { clearTimeout(timer); this.#pending.delete(id); reject(error instanceof AppServerError ? error : new AppServerError(String(error))); }); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error instanceof AppServerError ? error : new AppServerError(String(error))); }
    });
  }

  #lost(error: string): void {
    const connection = this.#connection;
    this.#connection = null;
    ++this.#generation;
    connection?.close();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppServerError(error));
    }
    this.#pending.clear();
  }
}

async function connectDaemon(deps: AppServerDeps, receive: (message: Json) => void, closed: (error: string) => void): Promise<RpcConnection> {
  const env = { ...cliEnvironment(process.env), ...deps.env, ...executableDirOnPath(deps.codexPath()), CODEX_HOME: deps.codexHome };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(deps.codexPath(), ['app-server', 'daemon', 'start'], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4096); });
    const timer = setTimeout(() => { child.kill(); reject(new AppServerError('Codex daemon did not start within 30 seconds.')); }, 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new AppServerError(`Codex daemon failed: ${stderr.trim() || `exit ${code}`}`)); });
  });
  const proxy = spawn(deps.codexPath(), ['app-server', 'proxy'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const socket = new WebSocket('ws://localhost', {
    // proxy forwards the control socket, including the WebSocket handshake and framing.
    createConnection: () => Duplex.from({ readable: proxy.stdout, writable: proxy.stdin }) as never,
    handshakeTimeout: 10_000,
    maxPayload: 64 * 1024 * 1024,
  });
  proxy.stderr.on('data', (data: Buffer) => deps.log(`Codex proxy: ${data.toString().trim()}`));
  proxy.on('error', (error) => { socket.terminate(); closed(error.message); });
  proxy.on('exit', () => { socket.terminate(); closed('The connection to Codex closed.'); });
  socket.on('message', (data) => {
    try { receive(object(JSON.parse(data.toString()))); }
    catch (error) { deps.log(`Codex event failed: ${String(error)}`); }
  });
  socket.on('close', () => closed('The connection to Codex closed.'));
  socket.on('error', (error) => closed(error.message));
  try { await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }); }
  catch (error) { proxy.kill(); throw error; }
  return { send: message => writeSocket(socket, message), close: () => { socket.terminate(); proxy.kill(); } };
}

export function writeSocket(socket: Pick<WebSocket, 'readyState' | 'send'>, message: Json): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(new AppServerError('The connection to Codex is not open.', false, true)); return; }
    socket.send(JSON.stringify(message), error => error == null ? resolve() : reject(error));
  });
}
