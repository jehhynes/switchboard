import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';
import { acceptPaneSocket } from './paneSocket.js';
import type { PaneSocket } from './paneSocket.js';

/** How long a pairing token from the page is good for. */
export const PAIRING_MS = 2 * 60_000;
/** How long a new socket has to say `hello`, and how long a paired one may stay silent; the extension sends a message every 20 s. */
export const HELLO_MS = 5_000;
export const SILENT_MS = 90_000;

/** Whether a paired extension is connected, an unpaired one, or none. */
export type PaneLinkState = 'none' | 'unpaired' | 'paired';

export interface PaneLinkDeps {
  /** The one extension origin the socket accepts, `chrome-extension://<PANE_EXTENSION_ID>`. */
  origin: string;
  /** `<Switchboard home>/chrome-pane.json`, which keeps the paired credential's SHA-256. */
  file: string;
  enabled(): boolean;
  now(): number;
  log(line: string): void;
  /** A paired extension's message other than `hello`, `pair` and `ping`. */
  message(data: Record<string, unknown>): void;
  /** The link's state changed. */
  changed(state: PaneLinkState): void;
}

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
const same = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/**
 * The hub's end of the Chrome pane's socket (architecture.md § Pane socket): the upgrade on the browser endpoint from the one extension origin,
 * the pairing token the page asks for, the credential it is exchanged for, and the one paired socket that receives the pane's messages.
 */
export class PaneLink {
  #paired: PaneSocket | null = null;
  /** Unpaired sockets, and whether each said `hello`. */
  readonly #waiting = new Map<PaneSocket, boolean>();
  #token: { hash: Buffer; expires: number } | null = null;

  constructor(private readonly deps: PaneLinkDeps) {}

  state(): PaneLinkState {
    return this.#paired !== null ? 'paired' : this.#waiting.size > 0 ? 'unpaired' : 'none';
  }

  /** A one-time pairing token, good for {@link PAIRING_MS}; a new one replaces the last. */
  pairingToken(): string {
    const token = randomBytes(32).toString('base64url');

    this.#token = { hash: sha256(token), expires: this.deps.now() + PAIRING_MS };
    return token;
  }

  /** Sends a message to the paired extension; false when none is connected. */
  send(message: Record<string, unknown>): boolean {
    this.#paired?.send(message);
    return this.#paired !== null;
  }

  /** An upgrade on the browser endpoint: refused with 403 while the pane is off or from any other origin. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.deps.enabled()) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    let pane: PaneSocket | null = null;
    let silence: NodeJS.Timeout | null = null;
    const quiet = (ms: number): void => {
      if (silence !== null) {
        clearTimeout(silence);
      }

      silence = setTimeout(() => pane?.close(1001), ms);
      silence.unref();
    };

    pane = acceptPaneSocket(request, socket, head, this.deps.origin, {
      message: (data) => {
        if (pane === null) {
          return;
        }

        this.#read(pane, data);

        // Until a valid hello or pair, the first deadline stands, so pings cannot hold a socket open.
        if (this.#paired === pane || this.#waiting.get(pane) === true) {
          quiet(SILENT_MS);
        }
      },
      closed: () => {
        if (silence !== null) {
          clearTimeout(silence);
        }

        this.#dropped(pane!);
      },
    });

    if (pane === null) {
      this.deps.log('pane socket refused: not the Switchboard extension');
      return;
    }

    // A few unpaired sockets at most: the oldest goes first.
    if (this.#waiting.size >= 4) {
      [...this.#waiting.keys()][0]!.close(1008);
    }

    this.#waiting.set(pane, false);
    quiet(HELLO_MS);
    this.deps.changed(this.state());
  }

  /** Closes every socket, as when the pane is turned off. */
  closeAll(): void {
    for (const socket of [...this.#waiting.keys(), ...(this.#paired === null ? [] : [this.#paired])]) {
      socket.close(1001);
    }
  }

  #read(socket: PaneSocket, data: unknown): void {
    const message = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    const type = message?.['type'];

    if (this.#paired === socket) {
      if (message !== null && type !== 'ping' && type !== 'hello' && type !== 'pair') {
        this.deps.message(message);
      }

      return;
    }

    if (type === 'hello') {
      this.#waiting.set(socket, true);
    }

    if (type === 'hello' && typeof message!['credential'] === 'string' && this.#credentialMatches(message!['credential'])) {
      this.#pair(socket, null);
    } else if (type === 'hello') {
      socket.send({ type: 'unpaired' });
    } else if (type === 'pair' && typeof message!['token'] === 'string' && this.#tokenMatches(message!['token'])) {
      this.#token = null;
      this.#pair(socket, this.#newCredential());
    } else if (type === 'pair') {
      this.deps.log('pane pairing refused: the token is unknown, used or expired');
      socket.send({ type: 'unpaired', error: 'The pairing token is unknown, used or expired. Pair again from the page.' });
    } else if (type !== 'ping') {
      socket.close(1008);
    }
  }

  #pair(socket: PaneSocket, credential: string | null): void {
    const before = this.#paired;

    this.#waiting.delete(socket);
    this.#paired = socket;
    // A second paired extension, such as after the service worker restarted, replaces the first.
    before?.close(1000);
    socket.send(credential === null ? { type: 'paired' } : { type: 'paired', credential });
    this.deps.log(credential === null ? 'pane extension connected' : 'pane extension paired');
    this.deps.changed(this.state());
  }

  #dropped(socket: PaneSocket): void {
    const was = this.state();

    this.#waiting.delete(socket);

    if (this.#paired === socket) {
      this.#paired = null;
    }

    if (this.state() !== was) {
      this.deps.changed(this.state());
    }
  }

  #tokenMatches(token: string): boolean {
    const pending = this.#token;

    return pending !== null && pending.expires > this.deps.now() && same(sha256(token), pending.hash);
  }

  #credentialMatches(credential: string): boolean {
    try {
      const kept = JSON.parse(readFileSync(this.deps.file, 'utf8')) as { credentialSha256?: unknown };

      return typeof kept.credentialSha256 === 'string' && same(sha256(credential), Buffer.from(kept.credentialSha256, 'hex'));
    } catch {
      return false;
    }
  }

  /** A new credential, whose SHA-256 replaces the kept one, so an earlier pairing stops working. */
  #newCredential(): string {
    const credential = randomBytes(32).toString('base64url');
    const temporary = `${this.deps.file}.${process.pid}.tmp`;

    mkdirSync(dirname(this.deps.file), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ credentialSha256: sha256(credential).toString('hex'), pairedAt: new Date(this.deps.now()).toISOString() }), { mode: 0o600 });
    renameSync(temporary, this.deps.file);
    return credential;
  }
}
