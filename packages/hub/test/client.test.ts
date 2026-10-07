import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { openEvents, stopHub } from '../src/client.js';
import { listenHub } from '../src/server.js';
import { until } from './helpers.js';

const identity = { hub: 'switchboard', protocol: 1, version: '0.1.0', pid: 99 };

function recordFor(port: number, token: string) {
  return { protocol: 1, version: '', build: 'b1', configDir: 'C:/cfg', port, token, pid: 99, startedAt: '' };
}

describe('openEvents', () => {
  it('returns null when the token is wrong', async () => {
    const server = await listenHub({ identity, onShutdown: () => {} });

    try {
      const onEnd = vi.fn();

      expect(await openEvents(recordFor(server.port, 'wrong'), onEnd)).toBeNull();
      expect(onEnd).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('returns null when nothing listens', async () => {
    const server = await listenHub({ identity, onShutdown: () => {} });
    const port = server.port;

    await server.close();

    expect(await openEvents(recordFor(port, 't'), () => {})).toBeNull();
  });

  it('returns null when the listener never sends headers', async () => {
    const sockets: Socket[] = [];
    const silent = createServer((socket) => {
      sockets.push(socket);
    });
    const port = await new Promise<number>((resolve) => {
      silent.listen(0, '127.0.0.1', () => resolve((silent.address() as AddressInfo).port));
    });

    try {
      const started = Date.now();

      expect(await openEvents(recordFor(port, 't'), () => {}, 100)).toBeNull();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => silent.close(done));
    }
  });

  it('calls onEnd once when the hub closes the stream', async () => {
    const server = await listenHub({ identity, onShutdown: () => {} });
    const onEnd = vi.fn();
    const stream = await openEvents(recordFor(server.port, server.token), onEnd);

    expect(stream).not.toBeNull();
    await server.close();
    await until(() => (onEnd.mock.calls.length > 0 ? true : null));
    await new Promise((done) => setTimeout(done, 50));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('does not call onEnd after close()', async () => {
    const server = await listenHub({ identity, onShutdown: () => {} });
    const onEnd = vi.fn();

    try {
      const stream = await openEvents(recordFor(server.port, server.token), onEnd);

      expect(server.clients()).toBe(1);
      stream!.close();
      await until(() => (server.clients() === 0 ? true : null));
      await new Promise((done) => setTimeout(done, 50));
      expect(onEnd).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

describe('stopHub', () => {
  it('is false with the wrong token and true when the hub agrees', async () => {
    const onShutdown = vi.fn();
    const server = await listenHub({ identity, onShutdown });

    try {
      expect(await stopHub(recordFor(server.port, 'wrong'))).toBe(false);
      expect(onShutdown).not.toHaveBeenCalled();
      expect(await stopHub(recordFor(server.port, server.token))).toBe(true);
      expect(onShutdown).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});
