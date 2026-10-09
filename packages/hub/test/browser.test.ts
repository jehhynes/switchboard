import { request } from 'node:http';
import { createServer } from 'node:net';
import type { Card } from '@switchboard/core';
import { afterEach, describe, expect, it } from 'vitest';
import { listenBrowser } from '../src/browser.js';
import type { BrowserServer } from '../src/browser.js';

let server: BrowserServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function get(port: number, path: string, host = `127.0.0.1:${port}`, method = 'GET'): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const outbound = request({ host: '127.0.0.1', port, method, path, headers: { Host: host, Origin: 'https://evil.example' } }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });

    outbound.on('error', reject);
    outbound.end();
  });
}

describe('listenBrowser', () => {
  it('lists the snoozed URLs on each request, with no CORS header', async () => {
    let urls = ['https://github.com/o/r/issues/1'];

    server = await listenBrowser(0, () => urls, () => []);

    const first = await get(server.port, '/snoozed');

    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ urls: ['https://github.com/o/r/issues/1'] });
    expect(first.headers['access-control-allow-origin']).toBeUndefined();
    expect(first.headers['cache-control']).toBe('no-store');

    urls = [];
    expect(JSON.parse((await get(server.port, '/snoozed', `localhost:${server.port}`)).body)).toEqual({ urls: [] });
  });

  it('lists the cards on each request, with no CORS header', async () => {
    let cards: Card[] = [
      { url: 'https://github.com/o/r/issues/1', playbook: 'dev:review-pr', group: 'blocked', snoozed: false, links: ['https://github.com/o/r/pull/3'] },
      { url: 'https://github.com/o/r/issues/2', playbook: null, group: 'unstarted', snoozed: true, links: [] },
    ];

    server = await listenBrowser(0, () => [], () => cards);

    const first = await get(server.port, '/cards');

    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({
      cards: [
        { url: 'https://github.com/o/r/issues/1', playbook: 'dev:review-pr', group: 'blocked', snoozed: false, links: ['https://github.com/o/r/pull/3'] },
        { url: 'https://github.com/o/r/issues/2', playbook: null, group: 'unstarted', snoozed: true, links: [] },
      ],
    });
    expect(first.headers['access-control-allow-origin']).toBeUndefined();
    expect(first.headers['cache-control']).toBe('no-store');

    cards = [];
    expect(JSON.parse((await get(server.port, '/cards?x=1', `localhost:${server.port}`)).body)).toEqual({ cards: [] });
    expect((await get(server.port, '/cards', `rebound.example:${server.port}`)).status).toBe(403);
    expect((await get(server.port, '/cards', undefined, 'POST')).status).toBe(404);
  });

  it('refuses another Host, another path and another method', async () => {
    server = await listenBrowser(0, () => ['https://github.com/o/r/issues/1'], () => []);

    expect((await get(server.port, '/snoozed', `rebound.example:${server.port}`)).status).toBe(403);
    expect((await get(server.port, '/snoozed', '127.0.0.1:1')).status).toBe(403);
    expect((await get(server.port, '/status')).status).toBe(404);
    expect((await get(server.port, '/snoozed', undefined, 'POST')).status).toBe(404);
    expect((await get(server.port, '//[')).status).toBe(404);
    expect((await get(server.port, '//[', 'rebound.example')).status).toBe(403);
    expect((await get(server.port, '/snoozed?x=1')).status).toBe(200);
  });

  describe('POST /snooze (PRD R66)', () => {
    const EXTENSION = 'chrome-extension://abcdefghijklmnop';
    const JSON_TYPE = 'application/json';
    const ISSUE = 'https://github.com/o/r/issues/1';

    function post(port: number, body: string, headers: Record<string, string>, path = '/snooze'): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
      return new Promise((resolve, reject) => {
        const outbound = request({ host: '127.0.0.1', port, method: 'POST', path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (response) => {
          let text = '';

          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (text += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
        });

        outbound.on('error', reject);
        outbound.end(body);
      });
    }

    function snoozing(answer: (url: string, until: number | null) => { refused: string | null } | null) {
      const calls: [string, number | null][] = [];

      return { calls, snooze: (url: string, until: number | null) => (calls.push([url, until]), answer(url, until)) };
    }

    it('snoozes the ticket for an extension origin with a JSON body, with no CORS header', async () => {
      const fake = snoozing(() => ({ refused: null }));

      server = await listenBrowser(0, () => [], () => [], fake.snooze);

      const timed = await post(server.port, JSON.stringify({ url: ISSUE, until: 1_800_000_000_000 }), { Origin: EXTENSION, 'Content-Type': JSON_TYPE });
      const indefinite = await post(server.port, JSON.stringify({ url: ISSUE, until: null }), { Origin: EXTENSION, 'Content-Type': 'application/json; charset=utf-8' });

      expect([timed.status, JSON.parse(timed.body)]).toEqual([200, { done: true }]);
      expect(timed.headers['access-control-allow-origin']).toBeUndefined();
      expect(indefinite.status).toBe(200);
      expect(fake.calls).toEqual([
        [ISSUE, 1_800_000_000_000],
        [ISSUE, null],
      ]);
    });

    it('answers 404 for an unknown URL and 409 with the core refusal', async () => {
      server = await listenBrowser(0, () => [], () => [], (url) => (url === ISSUE ? { refused: 'The snooze time has passed.' } : null));

      const unknown = await post(server.port, JSON.stringify({ url: 'https://github.com/o/r/issues/2', until: null }), { Origin: EXTENSION, 'Content-Type': JSON_TYPE });
      const past = await post(server.port, JSON.stringify({ url: ISSUE, until: 1 }), { Origin: EXTENSION, 'Content-Type': JSON_TYPE });

      expect([unknown.status, JSON.parse(unknown.body)]).toEqual([404, { error: 'Switchboard has no ticket for https://github.com/o/r/issues/2.' }]);
      expect([past.status, JSON.parse(past.body)]).toEqual([409, { error: 'The snooze time has passed.' }]);
    });

    it('refuses a web page origin, a missing origin, a form content type and another Host before snoozing', async () => {
      const fake = snoozing(() => ({ refused: null }));
      const body = JSON.stringify({ url: ISSUE, until: null });

      server = await listenBrowser(0, () => [], () => [], fake.snooze);

      expect((await post(server.port, body, { Origin: 'https://github.com', 'Content-Type': JSON_TYPE })).status).toBe(403);
      expect((await post(server.port, body, { Origin: 'null', 'Content-Type': JSON_TYPE })).status).toBe(403);
      expect((await post(server.port, body, { 'Content-Type': JSON_TYPE })).status).toBe(403);
      expect((await post(server.port, body, { Origin: EXTENSION, 'Content-Type': 'text/plain;charset=UTF-8' })).status).toBe(415);
      expect((await post(server.port, body, { Origin: EXTENSION, 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
      expect((await post(server.port, body, { Origin: EXTENSION })).status).toBe(415);
      expect((await post(server.port, body, { Origin: EXTENSION, 'Content-Type': JSON_TYPE, Host: `rebound.example:${server.port}` })).status).toBe(403);
      expect(fake.calls).toEqual([]);
    });

    it('refuses a body without a URL or with a wake time that is not a number or null', async () => {
      const fake = snoozing(() => ({ refused: null }));
      const headers = { Origin: EXTENSION, 'Content-Type': JSON_TYPE };

      server = await listenBrowser(0, () => [], () => [], fake.snooze);

      for (const body of ['{', '[]', 'null', JSON.stringify({ until: null }), JSON.stringify({ url: '', until: null }), JSON.stringify({ url: ISSUE }), JSON.stringify({ url: ISSUE, until: 'tomorrow' }), `{"url":"${ISSUE}","until":1e999}`, JSON.stringify({ url: ISSUE, until: null, pad: 'x'.repeat(20_000) })]) {
        const reply = await post(server.port, body, headers);

        expect([body.slice(0, 40), reply.status]).toEqual([body.slice(0, 40), 400]);
      }

      expect(fake.calls).toEqual([]);
    });

    it('serves no snooze route when the hub gives no snooze handler', async () => {
      server = await listenBrowser(0, () => [], () => []);

      expect((await post(server.port, JSON.stringify({ url: ISSUE, until: null }), { Origin: EXTENSION, 'Content-Type': JSON_TYPE })).status).toBe(404);
      expect((await post(server.port, JSON.stringify({ url: ISSUE }), { Origin: EXTENSION, 'Content-Type': JSON_TYPE }, '/unsnooze')).status).toBe(404);
    });

    describe('POST /unsnooze', () => {
      function unsnoozing(answer: (url: string) => { refused: string | null } | null) {
        const calls: string[] = [];

        return { calls, unsnooze: (url: string) => (calls.push(url), answer(url)) };
      }

      it('ends the snooze for an extension origin, and answers 404 for an unknown URL and 409 with the core refusal', async () => {
        const fake = unsnoozing((url) => (url === ISSUE ? { refused: null } : url.endsWith('/3') ? { refused: 'Unknown ticket.' } : null));
        const headers = { Origin: EXTENSION, 'Content-Type': JSON_TYPE };

        server = await listenBrowser(0, () => [], () => [], () => null, fake.unsnooze);

        const done = await post(server.port, JSON.stringify({ url: ISSUE }), headers, '/unsnooze');
        const unknown = await post(server.port, JSON.stringify({ url: 'https://github.com/o/r/issues/2' }), headers, '/unsnooze');
        const refused = await post(server.port, JSON.stringify({ url: 'https://github.com/o/r/issues/3' }), headers, '/unsnooze');

        expect([done.status, JSON.parse(done.body)]).toEqual([200, { done: true }]);
        expect(done.headers['access-control-allow-origin']).toBeUndefined();
        expect([unknown.status, JSON.parse(unknown.body)]).toEqual([404, { error: 'Switchboard has no ticket for https://github.com/o/r/issues/2.' }]);
        expect([refused.status, JSON.parse(refused.body)]).toEqual([409, { error: 'Unknown ticket.' }]);
        expect(fake.calls).toEqual([ISSUE, 'https://github.com/o/r/issues/2', 'https://github.com/o/r/issues/3']);
      });

      it('refuses a web page origin, a missing origin, a form content type and a body without a URL before unsnoozing', async () => {
        const fake = unsnoozing(() => ({ refused: null }));
        const body = JSON.stringify({ url: ISSUE });

        server = await listenBrowser(0, () => [], () => [], () => null, fake.unsnooze);

        expect((await post(server.port, body, { Origin: 'https://github.com', 'Content-Type': JSON_TYPE }, '/unsnooze')).status).toBe(403);
        expect((await post(server.port, body, { 'Content-Type': JSON_TYPE }, '/unsnooze')).status).toBe(403);
        expect((await post(server.port, body, { Origin: EXTENSION, 'Content-Type': 'text/plain;charset=UTF-8' }, '/unsnooze')).status).toBe(415);

        for (const bad of ['{', '[]', 'null', JSON.stringify({ url: '' }), JSON.stringify({ url: 7 }), JSON.stringify({ url: ISSUE, pad: 'x'.repeat(20_000) })]) {
          const reply = await post(server.port, bad, { Origin: EXTENSION, 'Content-Type': JSON_TYPE }, '/unsnooze');

          expect([bad.slice(0, 40), reply.status]).toEqual([bad.slice(0, 40), 400]);
        }

        expect(fake.calls).toEqual([]);
      });
    });
  });

  it('rejects when the port is taken', async () => {
    const holder = createServer();

    await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done));

    const port = (holder.address() as { port: number }).port;

    await expect(listenBrowser(port, () => [], () => [])).rejects.toThrow(/EADDRINUSE/);
    await new Promise((done) => holder.close(done));
  });
});
