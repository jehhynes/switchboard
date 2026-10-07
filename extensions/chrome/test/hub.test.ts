import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_PORT as HUB_BROWSER_PORT } from '@switchboard/core';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_PORT, readSnoozed } from '../src/hub.js';

const reply = (status: number, body: string) => async () => new Response(body, { status });

describe('readSnoozed', () => {
  it('reads the URL list from the hub\'s browser endpoint', async () => {
    const fetchUrl = vi.fn(reply(200, '{"urls":["https://github.com/o/r/issues/1"]}'));

    expect(await readSnoozed(fetchUrl)).toEqual(['https://github.com/o/r/issues/1']);
    expect(fetchUrl).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:47615/snoozed');
  });

  it('returns null for a failed request, an error status or another body', async () => {
    expect(await readSnoozed(async () => Promise.reject(new TypeError('Failed to fetch')))).toBeNull();
    expect(await readSnoozed(reply(404, '{"urls":[]}'))).toBeNull();
    expect(await readSnoozed(reply(200, 'not json'))).toBeNull();
    expect(await readSnoozed(reply(200, 'null'))).toBeNull();
    expect(await readSnoozed(reply(200, '{"urls":[1]}'))).toBeNull();
    expect(await readSnoozed(reply(200, '{}'))).toBeNull();
  });

  it('uses the hub\'s port, which the manifest permits', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src', 'manifest.json'), 'utf8'));

    expect(BROWSER_PORT).toBe(HUB_BROWSER_PORT);
    expect(manifest.host_permissions).toEqual([`http://127.0.0.1:${HUB_BROWSER_PORT}/*`]);
  });
});
