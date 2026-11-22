import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_PORT as HUB_BROWSER_PORT } from '@switchboard/core';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_PORT, LOCAL_ROUTES, readPaneEnabled, readRoutes, readSnoozed, remoteRoutes } from '../src/hub.js';

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

  it('reads whether the Chrome pane is on, and null for anything else', async () => {
    const fetchUrl = vi.fn(reply(200, '{"enabled":true}'));

    expect(await readPaneEnabled(fetchUrl)).toBe(true);
    expect(fetchUrl).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:47615/pane');
    expect(await readPaneEnabled(reply(200, '{"enabled":false}'))).toBe(false);
    expect(await readPaneEnabled(async () => Promise.reject(new TypeError('Failed to fetch')))).toBeNull();
    expect(await readPaneEnabled(reply(404, '{"enabled":true}'))).toBeNull();
    expect(await readPaneEnabled(reply(200, 'not json'))).toBeNull();
    expect(await readPaneEnabled(reply(200, 'null'))).toBeNull();
    expect(await readPaneEnabled(reply(200, '{"enabled":"yes"}'))).toBeNull();
  });

  it('reads the hub through the page\'s origin for a copy another computer\'s hub gave (PRD R121)', async () => {
    const fetchUrl = vi.fn(reply(200, '{"urls":[]}'));

    expect(await readSnoozed(fetchUrl, remoteRoutes('https://pc.tail.ts.net'))).toEqual([]);
    expect(fetchUrl).toHaveBeenCalledExactlyOnceWith('https://pc.tail.ts.net/v1/browser/snoozed');
    expect(remoteRoutes('https://pc.tail.ts.net')).toEqual({ origin: 'https://pc.tail.ts.net', snoozed: 'https://pc.tail.ts.net/v1/browser/snoozed', cards: 'https://pc.tail.ts.net/v1/browser/cards', snooze: 'https://pc.tail.ts.net/v1/browser/snooze', unsnooze: 'https://pc.tail.ts.net/v1/browser/unsnooze' });
  });

  it('takes the remote routes from remote.json only for an HTTPS origin, and the loopback ones otherwise', async () => {
    const url = 'chrome-extension://id/remote.json';
    const fetchUrl = vi.fn(reply(200, '{"origin":"https://PC.tail.ts.net"}'));

    expect(await readRoutes(fetchUrl, url)).toEqual(remoteRoutes('https://pc.tail.ts.net'));
    expect(fetchUrl).toHaveBeenCalledExactlyOnceWith(url);
    // The build loaded from dist has no remote.json, which Chrome fails to fetch.
    expect(await readRoutes(async () => Promise.reject(new TypeError('Failed to fetch')), url)).toBe(LOCAL_ROUTES);
    expect(await readRoutes(reply(404, ''), url)).toBe(LOCAL_ROUTES);
    expect(await readRoutes(reply(200, 'not json'), url)).toBe(LOCAL_ROUTES);

    for (const origin of ['http://pc.tail.ts.net', 'https://pc.tail.ts.net/path', 'https://pc.tail.ts.net:8443', 'https://user@pc.tail.ts.net', 'javascript:alert(1)', '']) {
      expect(await readRoutes(reply(200, JSON.stringify({ origin })), url)).toBe(LOCAL_ROUTES);
    }

    expect(LOCAL_ROUTES.origin).toBeNull();
  });

  it('uses the hub\'s port, which the manifest permits', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src', 'manifest.json'), 'utf8'));

    expect(BROWSER_PORT).toBe(HUB_BROWSER_PORT);
    expect(manifest.host_permissions).toEqual([`http://127.0.0.1:${HUB_BROWSER_PORT}/*`]);
  });
});
