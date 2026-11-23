import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readHubLog, HUB_LOG_MAX_BYTES } from '../src/hubLog.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'parity-hub-log-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true, maxRetries: 5 }); });

describe('the hub log tail', () => {
  it('stops after a short read when a large log shrinks after stat', async () => {
    const fs = await import('node:fs/promises');
    const read = vi.fn().mockResolvedValue({ bytesRead: 0 });
    const close = vi.fn();
    const file = { stat: async () => ({ size: 512 * 1024 * 1024 }), read, close } as unknown as Awaited<ReturnType<typeof fs.open>>;
    vi.mocked(fs.open).mockResolvedValueOnce(file).mockResolvedValueOnce(file);
    expect(await readHubLog(home, 500)).toEqual({ text: '', more: false, limited: false, missing: false });
    expect(read).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    read.mockResolvedValueOnce({ bytesRead: 10 });
    await readHubLog(home, 500);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('distinguishes missing and empty logs and preserves CRLF, timestamps, UTF-8 and partial final lines', async () => {
    expect(await readHubLog(home, 2)).toEqual({ text: '', more: false, limited: false, missing: true });
    await writeFile(join(home, 'hub.log'), '');
    expect(await readHubLog(home, 2)).toEqual({ text: '', more: false, limited: false, missing: false });
    await writeFile(join(home, 'hub.log'), 'old\r\n2026-11-22T10:00:00Z café\r\npartial');
    expect(await readHubLog(home, 2)).toEqual({ text: '2026-11-22T10:00:00Z café\r\npartial', more: true, limited: false, missing: false });
    expect((await readHubLog(home, 3)).more).toBe(false);
    await appendFile(join(home, 'hub.log'), '\r\n');
    expect((await readHubLog(home, 1)).text).toBe('partial\r\n');
  });

  it('reads backwards across blocks and sees appends, truncation and rotation on the next read', async () => {
    await writeFile(join(home, 'hub.log'), 'old\n'.repeat(40_000) + 'new\nlast\n');
    expect(await readHubLog(home, 2)).toMatchObject({ text: 'new\nlast\n', more: true, limited: false });
    await appendFile(join(home, 'hub.log'), 'appended');
    expect((await readHubLog(home, 2)).text).toBe('last\nappended');
    await writeFile(join(home, 'hub.log'), 'truncated\n');
    expect((await readHubLog(home, 2)).text).toBe('truncated\n');
    await rename(join(home, 'hub.log'), join(home, 'old.log'));
    await writeFile(join(home, 'hub.log'), 'rotated\n');
    expect((await readHubLog(home, 2)).text).toBe('rotated\n');
  });

  it('bounds a huge line and omits its partial beginning rather than fabricating text', async () => {
    await writeFile(join(home, 'hub.log'), 'é'.repeat(HUB_LOG_MAX_BYTES));
    expect(await readHubLog(home, 500)).toEqual({ text: '', more: true, limited: true, missing: false });
    await appendFile(join(home, 'hub.log'), '\nlast\n');
    expect(await readHubLog(home, 500)).toEqual({ text: 'last\n', more: true, limited: true, missing: false });
  });
});
