import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markHubLog, readHubLog, readLog, readTail, HUB_LOG_MARKER, HUB_LOG_WITHHELD, HUB_LOG_MAX_BYTES, VOICE_LOG_MARKER, VOICE_LOG_WITHHELD } from '../src/hubLog.js';
import { prepareVoiceLog } from '../src/voiceLink.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

let home: string;
// Every hub writes the marker at its start; the tests of what it withholds remove or replace it.
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'parity-hub-log-')); markHubLog(home, new Date(0)); });
afterEach(async () => { await rm(home, { recursive: true, force: true, maxRetries: 5 }); });

describe('the hub log tail', () => {
  it('stops after a short read when a large log shrinks after stat', async () => {
    const fs = await import('node:fs/promises');
    const read = vi.fn().mockResolvedValue({ bytesRead: 0 });
    const close = vi.fn();
    const file = { stat: async () => ({ size: 512 * 1024 * 1024 }), read, close } as unknown as Awaited<ReturnType<typeof fs.open>>;
    vi.mocked(fs.open).mockResolvedValueOnce(file).mockResolvedValueOnce(file);
    expect(await readTail(join(home, 'hub.log'), 500)).toMatchObject({ text: '', more: false, limited: false, missing: false });
    expect(read).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    read.mockResolvedValueOnce({ bytesRead: 10 });
    await readTail(join(home, 'hub.log'), 500);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('distinguishes missing and empty logs and preserves CRLF, timestamps, UTF-8 and partial final lines', async () => {
    expect(await readTail(join(home, 'hub.log'), 2)).toEqual({ text: '', more: false, limited: false, missing: true, file: '', size: 0 });
    await writeFile(join(home, 'hub.log'), '');
    expect(await readTail(join(home, 'hub.log'), 2)).toMatchObject({ text: '', more: false, limited: false, missing: false });
    await writeFile(join(home, 'hub.log'), 'old\r\n2026-11-22T10:00:00Z café\r\npartial');
    expect(await readTail(join(home, 'hub.log'), 2)).toMatchObject({ text: '2026-11-22T10:00:00Z café\r\npartial', more: true, limited: false, missing: false });
    expect((await readTail(join(home, 'hub.log'), 3)).more).toBe(false);
    await appendFile(join(home, 'hub.log'), '\r\n');
    expect((await readTail(join(home, 'hub.log'), 1)).text).toBe('partial\r\n');
  });

  it('reads backwards across blocks and sees appends, truncation and rotation on the next read', async () => {
    await writeFile(join(home, 'hub.log'), 'old\n'.repeat(40_000) + 'new\nlast\n');
    expect(await readTail(join(home, 'hub.log'), 2)).toMatchObject({ text: 'new\nlast\n', more: true, limited: false });
    await appendFile(join(home, 'hub.log'), 'appended');
    expect((await readTail(join(home, 'hub.log'), 2)).text).toBe('last\nappended');
    await writeFile(join(home, 'hub.log'), 'truncated\n');
    expect((await readTail(join(home, 'hub.log'), 2)).text).toBe('truncated\n');
    const truncated = await readTail(join(home, 'hub.log'), 2);
    expect(truncated.size).toBe(10);
    await rename(join(home, 'hub.log'), join(home, 'old.log'));
    await writeFile(join(home, 'hub.log'), 'rotated\n');
    const rotated = await readTail(join(home, 'hub.log'), 2);
    expect(rotated.text).toBe('rotated\n');
    // A new file has a new identity, so the page starts its view again.
    expect(rotated.file).not.toBe(truncated.file);
    expect(rotated.file).not.toBe('');
  });

  it('bounds a huge line and omits its partial beginning rather than fabricating text', async () => {
    await writeFile(join(home, 'hub.log'), 'é'.repeat(HUB_LOG_MAX_BYTES));
    expect(await readTail(join(home, 'hub.log'), 500)).toMatchObject({ text: '', more: true, limited: true, missing: false });
    await appendFile(join(home, 'hub.log'), '\nlast\n');
    expect(await readTail(join(home, 'hub.log'), 500)).toMatchObject({ text: 'last\n', more: true, limited: true, missing: false });
  });
});

describe('the voice and terminal holder logs', () => {
  it('reads holder.log, and never voice.log before the marker, whose older lines can hold spoken and alert text', async () => {
    await writeFile(join(home, 'holder.log'), '2026-11-26T01:00:00.000Z info  Listening\n');
    expect((await readLog(home, 'holder', 10)).text).toBe('2026-11-26T01:00:00.000Z info  Listening\n');
    await writeFile(join(home, 'voice.log'), '2026-11-20T01:00:00Z alert a1 for session s2 (turn-finished): "Hey Alex? Tinker finished Fix the badge."\n');
    expect(await readLog(home, 'voice', 10)).toEqual({ text: '', more: false, limited: false, missing: true, file: '', size: 0, withheld: VOICE_LOG_WITHHELD });
  });

  it('moves voice.log aside once before a voice process starts, then serves only the new lines and rotates it like hub.log', async () => {
    const path = join(home, 'voice.log');
    await writeFile(path, 'old private line\n');
    prepareVoiceLog(home, path);
    expect(existsSync(join(home, VOICE_LOG_MARKER))).toBe(true);
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('old private line\n');
    expect(await readLog(home, 'voice', 10)).toMatchObject({ text: '', missing: true });
    await writeFile(path, 'new line\n');
    expect((await readLog(home, 'voice', 10)).text).toBe('new line\n');
    // With the marker written, a later start keeps a small log where it is.
    prepareVoiceLog(home, path);
    expect(readFileSync(path, 'utf8')).toBe('new line\n');
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('old private line\n');
  });

  it('writes the marker with no voice.log yet', () => {
    prepareVoiceLog(home, join(home, 'voice.log'));
    expect(existsSync(join(home, VOICE_LOG_MARKER))).toBe(true);
  });
});

describe("hub.log's lines from before the cleaned log", () => {
  it('leaves out lines older builds wrote, with their stack frames, and says so; later lines and a later start keep the marker', async () => {
    await writeFile(join(home, 'hub.log'), [
      '2026-11-20T10:00:00.000Z session s1: a message waits, the input box holds a draft: "private draft"',
      '    at frame (hub.js:1)',
      '2026-11-26T09:59:59.999Z web page: served as https://pc to the Tailscale login someone@example.com',
      '2026-11-26T10:00:00.000Z info  hub: started on build b2, listening on 127.0.0.1:1 as pid 1',
      '2026-11-26T10:00:01.000Z info  page: served on http://127.0.0.1:2/page/',
      '',
    ].join('\n'));
    expect((await readHubLog(home, 10)).earlierWithheld).toBeUndefined();
    await rm(join(home, HUB_LOG_MARKER));
    markHubLog(home, new Date('2026-11-26T10:00:00.000Z'));
    markHubLog(home, new Date('2026-11-27T00:00:00.000Z'));
    expect(JSON.parse(readFileSync(join(home, HUB_LOG_MARKER), 'utf8'))).toEqual({ cleanSince: '2026-11-26T10:00:00.000Z' });
    const tail = await readHubLog(home, 10);
    expect(tail).toMatchObject({ more: false, earlierWithheld: true });
    expect(tail.text).toBe('2026-11-26T10:00:00.000Z info  hub: started on build b2, listening on 127.0.0.1:1 as pid 1\n2026-11-26T10:00:01.000Z info  page: served on http://127.0.0.1:2/page/\n');
    expect(tail.text).not.toMatch(/private draft|someone@example.com/);
    // A read that holds only new lines is left as it is.
    expect(await readHubLog(home, 1)).toMatchObject({ text: '2026-11-26T10:00:01.000Z info  page: served on http://127.0.0.1:2/page/\n', more: true });
    expect((await readHubLog(home, 1)).earlierWithheld).toBeUndefined();
    // A missing or broken marker gives nothing, rather than every line.
    await writeFile(join(home, HUB_LOG_MARKER), '{ broken');
    expect(await readHubLog(home, 10)).toEqual({ text: '', more: false, limited: false, missing: true, file: '', size: 0, withheld: HUB_LOG_WITHHELD });
    // A hub's start writes a readable marker again, from its own start time.
    markHubLog(home, new Date('2026-11-27T00:00:00.000Z'));
    expect(JSON.parse(readFileSync(join(home, HUB_LOG_MARKER), 'utf8'))).toEqual({ cleanSince: '2026-11-27T00:00:00.000Z' });
    expect(await readHubLog(home, 10)).toMatchObject({ text: '', earlierWithheld: true });
    await rm(join(home, HUB_LOG_MARKER));
    expect((await readHubLog(home, 10)).withheld).toBe(HUB_LOG_WITHHELD);
    // Holder and voice logs are not cut by the hub's marker.
    await writeFile(join(home, 'holder.log'), '2026-11-20T10:00:00.000Z Listening\n');
    expect((await readLog(home, 'holder', 10)).text).toBe('2026-11-20T10:00:00.000Z Listening\n');
  });
});
