import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_PORT as HUB_BROWSER_PORT } from '@switchboard/core';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_PORT, LOCAL_ROUTES, readLocalPage, readRoutes, readSnoozed, remoteRoutes } from '../src/hub.js';

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


  it('reads the hub through the page\'s origin for a copy another computer\'s hub gave (PRD R121)', async () => {
    const fetchUrl = vi.fn(reply(200, '{"urls":[]}'));

    expect(await readSnoozed(fetchUrl, remoteRoutes('https://pc.tail.ts.net'))).toEqual([]);
    expect(fetchUrl).toHaveBeenCalledExactlyOnceWith('https://pc.tail.ts.net/v1/browser/snoozed');
    expect(remoteRoutes('https://pc.tail.ts.net')).toEqual({ origin: 'https://pc.tail.ts.net', snoozed: 'https://pc.tail.ts.net/v1/browser/snoozed', cards: 'https://pc.tail.ts.net/v1/browser/cards', snooze: 'https://pc.tail.ts.net/v1/browser/snooze', unsnooze: 'https://pc.tail.ts.net/v1/browser/unsnooze' });
  });

  it('takes the remote routes from remote.json only for an HTTPS origin, and the loopback ones otherwise', async () => {
    const url = 'chrome-extension://id/remote.json';
    const fetchUrl = vi.fn(reply(200, '{"origin":"https://PC.tail.ts.net"}'));

    expect(await readRoutes(fetchUrl, url)).toEqual({ origin: 'https://pc.tail.ts.net', snoozed: 'https://pc.tail.ts.net/v1/browser/snoozed', cards: 'https://pc.tail.ts.net/v1/browser/cards', snooze: 'https://pc.tail.ts.net/v1/browser/snooze', unsnooze: 'https://pc.tail.ts.net/v1/browser/unsnooze' });
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
    expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });
});

describe('readLocalPage (PRD R69)', () => {
  it("names this computer's page by the first origin the hub's /iframe vouches for", async () => {
    const fetchUrl = vi.fn(reply(200, '{"enabled":false,"origins":["http://127.0.0.1:47616","http://localhost:47616"]}'));

    expect(await readLocalPage(fetchUrl)).toBe('http://127.0.0.1:47616');
    expect(fetchUrl).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:47615/iframe');
  });

  it('returns null without a hub, for an error status, and for an origin that is not loopback http', async () => {
    expect(await readLocalPage(async () => Promise.reject(new TypeError('Failed to fetch')))).toBeNull();
    expect(await readLocalPage(reply(503, '{"origins":["http://127.0.0.1:47616"]}'))).toBeNull();
    expect(await readLocalPage(reply(200, '{"origins":[]}'))).toBeNull();
    expect(await readLocalPage(reply(200, '{"origins":["https://evil.example"]}'))).toBeNull();
    expect(await readLocalPage(reply(200, 'not json'))).toBeNull();
  });
});
