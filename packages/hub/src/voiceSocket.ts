import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { acceptWebSocket } from './paneSocket.js';
import type { HubSocket } from './paneSocket.js';

/** The path of the voice socket on the page's origin (architecture.md § Remote access, Voice on a phone). */
export const VOICE_SOCKET_PATH = '/v1/voice/socket';
/** How long a voice socket may stay open without the page's `hello`. */
export const VOICE_HELLO_MS = 5_000;
/** Bytes a second of the phone's audio: 16 kHz mono 16-bit PCM. */
export const UPLINK_BYTES_PER_SECOND = 16_000 * 2;
/** The phone may send audio at most this many times faster than real time, with a second of it as a burst. */
export const UPLINK_RATE_LIMIT = 2;
/** A voice socket that sends nothing for this long is closed; the page pings every 5 s, and each message checks its sign-in again. */
export const VOICE_IDLE_MS = 20_000;
/** JSON messages a second the page may send, with twice as many as a burst. */
export const CONTROL_RATE = 20;
/** Sockets that may wait for their `hello` at once; a newer one closes the oldest. */
export const VOICE_PENDING_MAX = 4;
/** Bytes queued to a page that does not read them, past which its socket is closed. */
export const VOICE_QUEUE_MAX = 1024 * 1024;

/** Close codes of the voice socket the page reads as reasons, beside the standard ones. */
export const VOICE_CLOSE = {
  /** Another device or page took the voice. */
  moved: 4001,
  /** The hub restarts onto a new build: the page may take the voice back from the hub that takes over without a tap (architecture.md § Hub lifecycle). */
  restarting: 4002,
  /** The device lost its permission: voice forbidden on it, its sign-in revoked, remote access or voice turned off, or its page key ended. */
  refused: 4003,
} as const;

/** The paired device a voice socket belongs to: its sign-in's stored key, the page key it named, and where it came from. */
export interface VoiceDevice {
  hash: string;
  key: string;
  host: string;
  login: string;
  label: string;
  /** Why the device may no longer hold the socket, checked at each message it sends: its sign-in gone or expired, voice forbidden or off; null while it may. */
  allowed?(): string | null;
}

export interface VoiceSocketDeps {
  now(): number;
  /** How long a silent socket stays open; {@link VOICE_IDLE_MS} when left out. */
  idleMs?: number;
  log(line: string): void;
  /** The device's page said `hello`: it has the voice socket; `resumed` when it asked to take the voice back. */
  opened?(device: VoiceDevice, resumed: boolean): void;
  /** Why the device's page may not take the voice back after a hub restart, as its `hello {resume: true}` asks; null when it may. */
  resumable?(device: VoiceDevice): string | null;
  /** A JSON message from the page after `hello` other than `ping`. */
  message?(device: VoiceDevice, data: Record<string, unknown>): void;
  /** A binary message from the page after `hello`, within the rate limit. */
  audio?(device: VoiceDevice, data: Buffer): void;
  /** The device's socket closed, after `hello`, with why; `refused` when the hub closed it with {@link VOICE_CLOSE.refused}. */
  closed?(device: VoiceDevice, reason: string, refused: boolean): void;
}

interface Open {
  device: VoiceDevice;
  socket: HubSocket;
  hello: boolean;
  /** Bytes the uplink may still send now, refilled at {@link UPLINK_RATE_LIMIT} times real time up to a second's worth. */
  allowance: number;
  at: number;
  /** JSON messages the page may still send now, refilled at {@link CONTROL_RATE} a second up to twice that. */
  messages: number;
  messagesAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The hub's voice sockets (architecture.md § Remote access, Voice on a phone): one paired device's page at a time holds the voice socket. Its
 * page must say `hello` first; audio before it, audio faster than {@link UPLINK_RATE_LIMIT} times real time, or no `hello` within
 * {@link VOICE_HELLO_MS} closes the socket, and a newer socket that says `hello` closes the older one with {@link VOICE_CLOSE.moved}.
 */
export class VoiceSockets {
  readonly #open = new Set<Open>();
  #current: Open | null = null;

  constructor(private readonly deps: VoiceSocketDeps) {}

  /** Accepts an upgrade whose request the server checked: its origin, sign-in, page key and the device's voice permission. */
  accept(request: IncomingMessage, socket: Duplex, head: Buffer, device: VoiceDevice): void {
    const allowance = UPLINK_BYTES_PER_SECOND * UPLINK_RATE_LIMIT;
    const one: Open = {
      device,
      socket: null as unknown as HubSocket,
      hello: false,
      allowance,
      at: this.deps.now(),
      messages: CONTROL_RATE * 2,
      messagesAt: this.deps.now(),
      timer: setTimeout(() => one.socket.close(1008, 'No hello.'), VOICE_HELLO_MS),
    };
    let reason = 'closed by the page';
    let refused = false;
    // Any message from the page puts off the idle close.
    const heard = (): void => {
      if (one.hello) {
        clearTimeout(one.timer);
        one.timer = setTimeout(() => one.socket.close(1001, 'The page stopped answering.'), this.deps.idleMs ?? VOICE_IDLE_MS);
        one.timer.unref?.();
      }
    };
    // The sign-in, its voice permission and voice itself, checked again as the page goes on using the socket.
    const stillAllowed = (): boolean => {
      const why = device.allowed?.() ?? null;

      if (why !== null) {
        one.socket.close(VOICE_CLOSE.refused, why);
      }

      return why === null;
    };

    one.timer.unref?.();

    // Sockets waiting for their `hello` are few: a newer one closes the oldest.
    const pending = [...this.#open].filter((other) => !other.hello);

    if (pending.length >= VOICE_PENDING_MAX) {
      pending[0]!.socket.close(1008, 'Too many voice sockets waiting.');
    }

    one.socket = acceptWebSocket(request, socket, head, {
      message: (data) => {
        const now = this.deps.now();

        one.messages = Math.min(CONTROL_RATE * 2, one.messages + ((now - one.messagesAt) / 1000) * CONTROL_RATE) - 1;
        one.messagesAt = now;

        if (one.messages < 0) {
          one.socket.close(1008, 'Too many messages.');
          return;
        }

        if (!stillAllowed()) {
          return;
        }

        heard();

        const message = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
        const type = message?.['type'];

        if (message === null || typeof type !== 'string') {
          one.socket.close(1008, 'Not a message.');
          return;
        }

        if (type === 'hello') {
          if (!one.hello) {
            this.#hello(one, message['resume'] === true);
            heard();
          }

          return;
        }

        if (type === 'ping') {
          one.socket.send({ type: 'pong', t: message['t'] ?? null, at: this.deps.now() });
          return;
        }

        if (one.hello && one === this.#current) {
          this.deps.message?.(device, message);
        }
      },
      binary: (data) => {
        if (!one.hello) {
          one.socket.close(1008, 'Audio before hello.');
          return;
        }

        // Audio alone keeps a socket busy, so it too checks the sign-in and its voice permission again.
        if (!stillAllowed()) {
          return;
        }

        const now = this.deps.now();
        const limit = UPLINK_BYTES_PER_SECOND * UPLINK_RATE_LIMIT;

        one.allowance = Math.min(limit, one.allowance + ((now - one.at) / 1000) * limit) - data.length;
        one.at = now;

        if (one.allowance < 0) {
          one.socket.close(1008, 'Audio faster than real time.');
          return;
        }

        heard();

        if (one === this.#current) {
          this.deps.audio?.(device, data);
        }
      },
      closed: () => {
        clearTimeout(one.timer);
        this.#open.delete(one);

        if (this.#current === one) {
          this.#current = null;
          this.deps.log(`voice socket: ${device.label || 'a device'} (${device.hash.slice(0, 8)}) closed: ${reason}`);
          this.deps.closed?.(device, reason, refused);
        }
      },
    });
    this.#open.add(one);
    // The socket's own close, by any of the hub's reasons, names its reason before it closes.
    const close = one.socket.close;

    one.socket.close = (code, why) => {
      reason = why === undefined || why === '' ? reason : why;
      refused ||= code === VOICE_CLOSE.refused;
      close(code, why);
    };
  }

  #hello(one: Open, resume: boolean): void {
    // A page taking the voice back after a hub restart takes it only from the hub that waits for it, never as a new tap would.
    const refused = !resume ? null : this.deps.resumable === undefined ? 'Voice did not resume after Switchboard restarted.' : this.deps.resumable(one.device);

    if (refused !== null) {
      this.deps.log(`voice socket: ${one.device.label || 'a device'} (${one.device.hash.slice(0, 8)}) did not take the voice back: ${refused}`);
      one.socket.close(VOICE_CLOSE.refused, refused);
      return;
    }

    clearTimeout(one.timer);
    one.hello = true;

    const previous = this.#current;

    this.#current = one;
    one.socket.send({ type: 'welcome', at: this.deps.now() });
    this.deps.log(`voice socket: ${one.device.label || 'a device'} (${one.device.hash.slice(0, 8)}) opened from ${one.device.host}`);

    if (previous !== null) {
      previous.socket.close(VOICE_CLOSE.moved, 'Voice is now on another device.');
    }

    this.deps.opened?.(one.device, resume);
  }

  /** The device whose page holds the voice socket, or null. */
  current(): VoiceDevice | null {
    return this.#current?.device ?? null;
  }

  /** Sends the page that holds the voice socket a JSON message; false with none. */
  send(message: Record<string, unknown>): boolean {
    this.#current?.socket.send(message);
    return this.#reading();
  }

  /** Sends the page that holds the voice socket a binary message; false with none. */
  sendBinary(data: Buffer): boolean {
    this.#current?.socket.sendBinary(data);
    return this.#reading();
  }

  /** Whether the page that holds the socket reads what it is sent; one that leaves over {@link VOICE_QUEUE_MAX} queued is closed. */
  #reading(): boolean {
    const current = this.#current;

    if (current !== null && current.socket.queued() > VOICE_QUEUE_MAX) {
      current.socket.close(1008, 'Voice stopped because audio could not be sent to this device in time.');
    }

    return this.#current !== null;
  }

  /** Bytes queued to the page that holds the voice socket and not yet sent. */
  queued(): number {
    return this.#current?.socket.queued() ?? 0;
  }

  /** Closes every voice socket, open or still waiting for `hello`, whose device `match` picks, with `code` ({@link VOICE_CLOSE.refused}) and `reason`. */
  close(match: (device: VoiceDevice) => boolean, reason: string, code: number = VOICE_CLOSE.refused): void {
    for (const one of [...this.#open]) {
      if (match(one.device)) {
        one.socket.close(code, reason);
      }
    }
  }
}
