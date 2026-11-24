import { describe, expect, it, vi } from 'vitest';
import { stopHub } from '../src/client.js';
import { listenHub } from '../src/server.js';

const identity = { hub: 'switchboard', protocol: 1, version: '0.1.0', pid: 99 };

function recordFor(port: number, token: string) {
  return { protocol: 1, version: '', build: 'b1', configDir: 'C:/cfg', execPath: '', port, token, pid: 99, startedAt: '' };
}

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
