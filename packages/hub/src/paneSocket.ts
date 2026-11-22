import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/** The largest message either side sends on the pane socket; a bigger frame closes it. */
export const PANE_FRAME_LIMIT = 65_535;

const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** One open WebSocket with the browser extension: JSON text messages only. */
export interface PaneSocket {
  send(message: unknown): void;
  close(code?: number): void;
}

export interface PaneSocketHandlers {
  message(data: unknown): void;
  closed(): void;
}

/** One open WebSocket of the hub's own (architecture.md § Pane socket, § Remote access): JSON text messages and, where taken, binary ones. */
export interface HubSocket extends PaneSocket {
  /** Sends one binary message; dropped when the socket is closed or the message is over the frame limit. */
  sendBinary(data: Buffer): void;
  /** Closes with a code and a reason the peer reads, at most 123 bytes of it. */
  close(code?: number, reason?: string): void;
  /** Bytes written and not yet sent, for a sender that must not queue audio ahead of a slow peer. */
  queued(): number;
}

export interface HubSocketHandlers extends PaneSocketHandlers {
  /** A binary message; without it a binary frame closes the socket with 1003. */
  binary?(data: Buffer): void;
}

/** Whether an upgrade request is a well-formed WebSocket version 13 handshake. */
export function isWebSocketUpgrade(request: IncomingMessage): boolean {
  const key = request.headers['sec-websocket-key'];

  return request.method === 'GET' && String(request.headers.upgrade ?? '').toLowerCase() === 'websocket' && request.headers['sec-websocket-version'] === '13' && typeof key === 'string' && Buffer.from(key, 'base64').length === 16;
}

/**
 * Accepts a WebSocket upgrade on the browser endpoint (RFC 6455, version 13) when its `Origin` is exactly `origin`, or refuses it with 403 and
 * closes the connection. Only what the pane needs: unfragmented text frames of JSON up to {@link PANE_FRAME_LIMIT}, masked as the standard
 * requires of a client, ping, pong and close; anything else closes the socket.
 */
export function acceptPaneSocket(request: IncomingMessage, socket: Duplex, head: Buffer, origin: string, handlers: PaneSocketHandlers): PaneSocket | null {
  if (!isWebSocketUpgrade(request) || request.headers.origin !== origin) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }

  return acceptWebSocket(request, socket, head, handlers);
}

/**
 * Accepts a WebSocket upgrade whose checks the caller made, with {@link isWebSocketUpgrade} among them: unfragmented text frames of JSON and,
 * with `handlers.binary`, binary frames, each up to {@link PANE_FRAME_LIMIT} and masked as the standard requires of a client, ping, pong and
 * close; anything else closes the socket.
 */
export function acceptWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer, handlers: HubSocketHandlers): HubSocket {
  const accept = createHash('sha1')
    .update(String(request.headers['sec-websocket-key']) + ACCEPT_GUID)
    .digest('base64');

  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

  let buffered: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  let open = true;
  const decoder = new TextDecoder('utf-8', { fatal: true });

  const frame = (opcode: number, payload: Buffer): Buffer => {
    const length = payload.length;
    const header = length < 126 ? Buffer.from([0x80 | opcode, length]) : Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);

    return Buffer.concat([header, payload]);
  };
  const end = (code: number, reason = ''): void => {
    if (!open) {
      return;
    }

    open = false;

    const text = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + text.length);

    payload.writeUInt16BE(code);
    text.copy(payload, 2);
    socket.end(frame(0x8, payload));
    handlers.closed();
  };

  const read = (): void => {
    while (open && buffered.length >= 2) {
      const first = buffered[0]!;
      const second = buffered[1]!;
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;

      // Extensions would set the reserved bits; none was negotiated. A client must mask every frame.
      if ((first & 0x70) !== 0 || (second & 0x80) === 0) {
        end(1002);
        return;
      }

      if (length === 126) {
        if (buffered.length < 4) {
          return;
        }

        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        end(1009);
        return;
      }

      if (length > PANE_FRAME_LIMIT) {
        end(1009);
        return;
      }

      if (buffered.length < offset + 4 + length) {
        return;
      }

      const mask = buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));

      buffered = buffered.subarray(offset + 4 + length);

      for (let index = 0; index < payload.length; index++) {
        payload[index] = payload[index]! ^ mask[index % 4]!;
      }

      if ((first & 0x80) === 0 || opcode === 0x0 || (opcode === 0x2 && handlers.binary === undefined)) {
        end(1003);
        return;
      }

      if (opcode === 0x8) {
        end(1000);
        return;
      }

      if (opcode === 0x9) {
        socket.write(frame(0xa, payload.subarray(0, 125)));
        continue;
      }

      if (opcode === 0x2) {
        handlers.binary!(payload);
        continue;
      }

      if (opcode !== 0x1) {
        if (opcode !== 0xa) {
          end(1002);
          return;
        }

        continue;
      }

      let data: unknown;

      try {
        data = JSON.parse(decoder.decode(payload));
      } catch {
        end(1007);
        return;
      }

      handlers.message(data);
    }
  };

  socket.on('data', (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    read();

    // What is left is part of one frame, which with its header and mask is never longer than this.
    if (buffered.length > PANE_FRAME_LIMIT + 8) {
      end(1009);
    }
  });
  socket.on('error', () => undefined);
  // The browser endpoint keeps half-open sockets, so the peer's end must close this side too.
  socket.on('end', () => {
    if (open) {
      open = false;
      handlers.closed();
    }

    socket.end();
  });
  socket.on('close', () => {
    if (open) {
      open = false;
      handlers.closed();
    }
  });
  setImmediate(read);

  return {
    send: (message) => {
      const payload = Buffer.from(JSON.stringify(message), 'utf8');

      if (open && payload.length <= PANE_FRAME_LIMIT) {
        socket.write(frame(0x1, payload));
      }
    },
    sendBinary: (data) => {
      if (open && data.length <= PANE_FRAME_LIMIT) {
        socket.write(frame(0x2, data));
      }
    },
    close: (code = 1000, reason = '') => end(code, reason),
    queued: () => socket.writableLength,
  };
}
