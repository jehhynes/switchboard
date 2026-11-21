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

/**
 * Accepts a WebSocket upgrade on the browser endpoint (RFC 6455, version 13) when its `Origin` is exactly `origin`, or refuses it with 403 and
 * closes the connection. Only what the pane needs: unfragmented text frames of JSON up to {@link PANE_FRAME_LIMIT}, masked as the standard
 * requires of a client, ping, pong and close; anything else closes the socket.
 */
export function acceptPaneSocket(request: IncomingMessage, socket: Duplex, head: Buffer, origin: string, handlers: PaneSocketHandlers): PaneSocket | null {
  const key = request.headers['sec-websocket-key'];
  const upgrade = String(request.headers.upgrade ?? '').toLowerCase();

  if (request.method !== 'GET' || upgrade !== 'websocket' || request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16 || request.headers.origin !== origin) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }

  const accept = createHash('sha1').update(key + ACCEPT_GUID).digest('base64');

  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

  let buffered: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  let open = true;
  const decoder = new TextDecoder('utf-8', { fatal: true });

  const frame = (opcode: number, payload: Buffer): Buffer => {
    const length = payload.length;
    const header = length < 126 ? Buffer.from([0x80 | opcode, length]) : Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);

    return Buffer.concat([header, payload]);
  };
  const end = (code: number): void => {
    if (!open) {
      return;
    }

    open = false;

    const payload = Buffer.alloc(2);

    payload.writeUInt16BE(code);
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

      if ((first & 0x80) === 0 || opcode === 0x0 || opcode === 0x2) {
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
    close: (code = 1000) => end(code),
  };
}
