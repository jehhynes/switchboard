import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openEvents } from '../src/client.js';
import { call } from '../src/http.js';
import { listenHub } from '../src/server.js';
import type { HubServer } from '../src/server.js';
import { until } from './helpers.js';

const identity = { hub: 'switchboard', protocol: 1, version: '0.1.0', pid: 99 };

let server: HubServer;

afterEach(async () => {
  await server.close();
});

function recordOf(s: HubServer) {
  return { protocol: 1, version: '0.1.0', build: 'b1', configDir: 'C:/cfg', execPath: '', port: s.port, token: s.token, pid: 99, startedAt: '' };
}

describe('listenHub', () => {
  it('sends the latest theme to the dock, rejects invalid reports and ignores late reports', async () => {
    server = await listenHub({ identity, onShutdown: () => {}, dock: () => ({}) });
    const chunks: string[] = [];
    const outbound = request({ host: '127.0.0.1', port: server.port, path: '/dock/events', headers: { Authorization: `Bearer ${server.token}` } }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => chunks.push(chunk));
    });
    outbound.on('error', () => {});
    outbound.end();
    const report = (body: unknown, token: string | null = server.token) => call(server.port, 'POST', '/window/theme', token, 2000, body);
    const latest = () => chunks.join('').split('\n').filter(line => line.startsWith('data: ')).at(-1);
    try {
      await until(() => latest()?.includes('windows') ? true : null);
      expect(latest()).not.toContain('theme');
      expect((await report({ theme: 'dark', at: 20 }, null))?.status).toBe(401);
      for (const body of [null, {}, { theme: 'blue', at: 20 }, { theme: 'light', at: '20' }, { theme: 'light', at: null }]) {
        expect((await report(body))?.status).toBe(400);
      }
      expect((await report({ theme: 'dark', at: 20 }))?.status).toBe(200);
      await until(() => latest()?.includes('"theme":"dark"') ? true : null);
      expect((await report({ theme: 'light', at: 19 }))?.status).toBe(200);
      const before = chunks.join('').split('event: dock').length;
      server.update();
      await until(() => chunks.join('').split('event: dock').length > before ? true : null);
      expect(latest()).toContain('"theme":"dark"');
      expect((await report({ theme: 'light', at: 21 }))?.status).toBe(200);
      await until(() => latest()?.includes('"theme":"light"') ? true : null);
    } finally {
      outbound.destroy();
    }
  });

  it("gives each window a key in its hello and its own state, refuses a conversation stream for a key no window holds, and ends the key with the stream", async () => {
    const closed: string[] = [];
    const conversations: string[] = [];
    let keys = 0;

    server = await listenHub({
      identity,
      onShutdown: () => {},
      windowOpened: (workspace) => `key-${++keys}-${workspace ?? 'folder'}`,
      windowClosed: (key) => closed.push(key),
      snapshot: ({ key }) => ({ shownTo: key }),
      conversation: (key, write) => {
        if (!key.startsWith('key-')) {
          return null;
        }

        write(`event: hello\ndata: {"to":"${key}"}\n\n`);
        conversations.push(key);

        return { close: () => conversations.push(`closed ${key}`) };
      },
    });

    const events: Array<[string, string]> = [];
    const stream = await openEvents(recordOf(server), () => undefined, 2000, (event, data) => events.push([event, data]), { workspace: 'C:/w/a.code-workspace', focused: '0' });

    await until(() => (events.length >= 2 ? true : null));
    expect(events.map(([event, data]) => [event, JSON.parse(data)])).toEqual([
      ['hello', { ...identity, window: 'key-1-C:/w/a.code-workspace' }],
      ['state', { shownTo: 'key-1-C:/w/a.code-workspace' }],
    ]);

    expect(await call(server.port, 'GET', '/v1/conversation/events?window=forged', server.token)).toMatchObject({ status: 403, body: JSON.stringify({ error: 'Not in this window.' }) });
    expect((await call(server.port, 'GET', '/v1/conversation/events?window=key-1', null))?.status).toBe(401);

    const chunks: string[] = [];
    const outbound = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/events?window=key-1-C%3A%2Fw%2Fa.code-workspace', headers: { Authorization: `Bearer ${server.token}` } }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => chunks.push(chunk));
    });

    outbound.on('error', () => {});
    outbound.end();
    await until(() => (chunks.join('').includes('"to"') ? true : null));
    expect(server.clients()).toBe(2);
    outbound.destroy();
    await until(() => (conversations.includes('closed key-1-C:/w/a.code-workspace') ? true : null));
    stream?.close();
    await until(() => (closed.length === 1 ? true : null));
    expect(closed).toEqual(['key-1-C:/w/a.code-workspace']);
  });

  it('answers /hub without a token', async () => {
    server = await listenHub({ identity, onShutdown: () => {} });

    const reply = await call(server.port, 'GET', '/hub', null);

    expect(reply?.status).toBe(200);
    expect(JSON.parse(reply!.body)).toEqual(identity);
  });

  it('refuses other paths without the token', async () => {
    const onShutdown = vi.fn();

    server = await listenHub({ identity, onShutdown });

    expect((await call(server.port, 'GET', '/status', null))?.status).toBe(401);
    expect((await call(server.port, 'GET', '/status', 'wrong'))?.status).toBe(401);
    expect((await call(server.port, 'GET', '/events', null))?.status).toBe(401);
    expect((await call(server.port, 'POST', '/shutdown', `${server.token}x`))?.status).toBe(401);
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('answers /status with the token', async () => {
    server = await listenHub({ identity, onShutdown: () => {} });

    const reply = await call(server.port, 'GET', '/status', server.token);

    expect(reply?.status).toBe(200);
    expect(JSON.parse(reply!.body)).toEqual(identity);
  });

  it('returns 404 for an unknown path or method with the token', async () => {
    server = await listenHub({ identity, onShutdown: () => {} });

    expect((await call(server.port, 'GET', '/nothing', server.token))?.status).toBe(404);
    expect((await call(server.port, 'POST', '/status', server.token))?.status).toBe(404);
  });

  it('calls onShutdown for an authorized shutdown', async () => {
    const onShutdown = vi.fn();

    server = await listenHub({ identity, onShutdown });

    expect((await call(server.port, 'POST', '/shutdown', server.token))?.status).toBe(200);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('tracks connected event streams', async () => {
    let time = 1000;

    server = await listenHub({ identity, onShutdown: () => {}, now: () => time });

    expect(server.clients()).toBe(0);
    expect(server.emptySince()).toBe(1000);

    const first = await openEvents(recordOf(server), () => {});
    const second = await openEvents(recordOf(server), () => {});

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(server.clients()).toBe(2);
    expect(server.emptySince()).toBeNull();

    time = 2000;
    first!.close();
    await until(() => (server.clients() === 1 ? true : null));
    expect(server.emptySince()).toBeNull();

    time = 3000;
    second!.close();
    await until(() => (server.clients() === 0 ? true : null));
    expect(server.emptySince()).toBe(3000);
  });

  it('sends a hello event and heartbeats on open streams', async () => {
    server = await listenHub({ identity, onShutdown: () => {}, heartbeatMs: 20 });

    let text = '';

    await new Promise<void>((resolve) => {
      const outbound = request(
        { host: '127.0.0.1', port: server.port, path: '/events', headers: { Authorization: `Bearer ${server.token}` } },
        (response) => {
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            text += chunk;

            if (text.includes(': ping')) {
              outbound.destroy();
              resolve();
            }
          });
        },
      );

      outbound.end();
    });

    expect(text).toContain(`event: hello\ndata: ${JSON.stringify(identity)}\n\n`);
    expect(text).toContain(': ping\n\n');
  });
});

describe('listenHub routes and state', () => {
  it('sends JSON bodies to POST handlers, refuses bad JSON, and reports handler errors', async () => {
    server = await listenHub({
      identity,
      onShutdown: () => {},
      post: { '/echo': async (body) => ({ status: 200, body: { got: body } }), '/boom': async () => Promise.reject(new Error('broken')) },
    });

    expect(await call(server.port, 'POST', '/echo', server.token, 2000, { a: 1 })).toEqual({ status: 200, body: '{"got":{"a":1}}' });
    expect((await call(server.port, 'POST', '/boom', server.token, 2000, {}))?.status).toBe(500);
    expect((await call(server.port, 'POST', '/echo', server.token))?.body).toBe('{"error":"body is not JSON"}');
    expect((await call(server.port, 'POST', '/echo', null, 2000, {}))?.status).toBe(401);
  });

  it('sends each stream its view when it opens and again on update: the state to /events, the dock view to /dock/events', async () => {
    let state = { n: 1 };
    let dock = { d: 1 };
    server = await listenHub({ identity, onShutdown: () => {}, snapshot: () => state, dock: () => dock });

    const read = (path: string) => {
      const chunks: string[] = [];
      const outbound = request({ host: '127.0.0.1', port: server.port, path, headers: { Authorization: `Bearer ${server.token}` } }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => chunks.push(chunk));
      });

      outbound.on('error', () => {});
      outbound.end();

      return { text: () => chunks.join(''), close: () => outbound.destroy() };
    };
    const panel = read('/events');
    const docked = read('/dock/events');

    await until(() => (panel.text().includes('event: state\ndata: {"n":1}') && docked.text().includes('event: dock\ndata: {"d":1,"windows":') ? true : null));
    expect(server.clients()).toBe(2);
    state = { n: 2 };
    dock = { d: 2 };
    server.update();
    await until(() => (panel.text().includes('event: state\ndata: {"n":2}') && docked.text().includes('event: dock\ndata: {"d":2,"windows":') ? true : null));
    expect(panel.text()).not.toContain('event: dock');
    expect(docked.text()).not.toContain('event: state');
    expect(docked.text()).toMatch(/^event: hello\ndata: \{"hub":"switchboard"/);
    panel.close();
    docked.close();
  });

  it('sends a window event named for a workspace file only to the streams of that window, by any spelling of the file', async () => {
    server = await listenHub({ identity, onShutdown: () => {}, snapshot: () => ({}), dock: () => ({}) });

    const chunks: Record<string, string[]> = { a: [], b: [] };

    for (const [name, file] of [['a', 'C:/h/windows/zoho-1.code-workspace'], ['b', 'C:/h/windows/zoho-2.code-workspace']] as const) {
      const outbound = request({ host: '127.0.0.1', port: server.port, path: `/events?workspace=${encodeURIComponent(file)}`, headers: { Authorization: `Bearer ${server.token}` } }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => chunks[name]!.push(chunk));
      });

      outbound.on('error', () => {});
      outbound.end();
    }

    await until(() => (server.clients() === 2 ? true : null));
    expect(server.notifyWindows('claim', { workspace: 'one' }, 'c:\\h\\windows\\ZOHO-1.code-workspace')).toBe(1);
    await until(() => (chunks['a']!.join('').includes('event: claim') ? true : null));
    expect(chunks['b']!.join('')).not.toContain('event: claim');
    expect(server.notifyWindows('claim', { workspace: 'none' }, 'C:/h/windows/zoho-3.code-workspace')).toBe(0);
  });

  it('sends a window event to the /events streams only, and counts them', async () => {
    server = await listenHub({ identity, onShutdown: () => {}, snapshot: () => ({}), dock: () => ({}) });

    expect(server.notifyWindows('claim', {})).toBe(0);

    const chunks: Record<string, string[]> = { '/events': [], '/dock/events': [] };

    for (const path of Object.keys(chunks)) {
      const outbound = request({ host: '127.0.0.1', port: server.port, path, headers: { Authorization: `Bearer ${server.token}` } }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => chunks[path]!.push(chunk));
      });

      outbound.on('error', () => {});
      outbound.end();
    }

    await until(() => (server.clients() === 2 ? true : null));
    expect(server.notifyWindows('claim', { workspace: 'C:/w.code-workspace' })).toBe(1);
    await until(() => (chunks['/events']!.join('').includes('event: claim\ndata: {"workspace":"C:/w.code-workspace"}\n\n') ? true : null));
    expect(chunks['/dock/events']!.join('')).not.toContain('event: claim');
  });

  it('sends a dock event to the dock streams only, and counts them', async () => {
    server = await listenHub({ identity, onShutdown: () => {}, snapshot: () => ({}), dock: () => ({}) });

    expect(server.notifyDock('show', {})).toBe(0);

    const chunks: Record<string, string[]> = { '/events': [], '/dock/events': [] };

    for (const path of Object.keys(chunks)) {
      const outbound = request({ host: '127.0.0.1', port: server.port, path, headers: { Authorization: `Bearer ${server.token}` } }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => chunks[path]!.push(chunk));
      });

      outbound.on('error', () => {});
      outbound.end();
    }

    await until(() => (server.clients() === 2 ? true : null));
    expect(server.notifyDock('show', { a: 1 })).toBe(1);
    await until(() => (chunks['/dock/events']!.join('').includes('event: show\ndata: {"a":1}\n\n') ? true : null));
    expect(chunks['/events']!.join('')).not.toContain('event: show');
  });

  it('sends a forwarded click to the newest dock stream that asked for clicks, and to no other stream (PRD R65, R69)', async () => {
    server = await listenHub({ identity, onShutdown: () => {}, snapshot: () => ({}), dock: () => ({}) });

    const open = (path: string) => {
      const chunks: string[] = [];
      const outbound = request({ host: '127.0.0.1', port: server.port, path, headers: { Authorization: `Bearer ${server.token}` } }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => chunks.push(chunk));
      });

      outbound.on('error', () => {});
      outbound.end();

      return { text: () => chunks.join(''), close: () => outbound.destroy() };
    };

    expect(server.clickDock({ rowKey: 'item:1' })).toBe(false);

    const old = open('/dock/events');
    const first = open('/dock/events?click=1');
    const second = open('/dock/events?click=1');

    await until(() => (server.clients() === 3 ? true : null));
    expect(server.clickDock({ rowKey: 'item:2' })).toBe(true);
    await until(() => (second.text().includes('event: click\ndata: {"rowKey":"item:2"}\n\n') ? true : null));

    second.close();
    await until(() => (server.clients() === 2 ? true : null));
    expect(server.clickDock({ rowKey: 'item:3' })).toBe(true);
    await until(() => (first.text().includes('"rowKey":"item:3"') ? true : null));
    expect(first.text()).not.toContain('"rowKey":"item:2"');
    expect(old.text()).not.toContain('event: click');

    first.close();
    await until(() => (server.clients() === 1 ? true : null));
    expect(server.clickDock({ rowKey: 'item:4' })).toBe(false);
    old.close();
  });

  it('tells the dock which item windows are open and which has focus, as windows connect, report focus and close', async () => {
    server = await listenHub({ identity, onShutdown: () => {}, snapshot: () => ({}), dock: () => ({ d: 1 }) });

    const open = (path: string) => {
      const chunks: string[] = [];
      const outbound = request({ host: '127.0.0.1', port: server.port, path, headers: { Authorization: `Bearer ${server.token}` } }, (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => chunks.push(chunk));
      });

      outbound.on('error', () => {});
      outbound.end();

      return { text: () => chunks.join(''), close: () => outbound.destroy() };
    };
    const docked = open('/dock/events');
    const sees = (windows: object) => until(() => (docked.text().endsWith(`event: dock\ndata: ${JSON.stringify({ d: 1, windows })}\n\n`) ? true : null));
    const focus = (body: unknown) => call(server.port, 'POST', '/window/focus', server.token, 2000, body);
    const item = '/home/op/.switchboard/windows/gh-107-58c609.code-workspace';

    await sees({ open: [], front: null, count: 0 });

    const itemWindow = open(`/events?workspace=${encodeURIComponent(item)}&focused=1`);

    await sees({ open: [item], front: item, count: 1 });

    const other = open('/events');

    await sees({ open: [item], front: item, count: 2 });
    expect((await focus({ workspace: null, focused: true }))?.status).toBe(200);
    await sees({ open: [item], front: null, count: 2 });
    // The item window's late blur does not clear the other window's focus.
    await focus({ workspace: item, focused: false });
    await sees({ open: [item], front: null, count: 2 });
    await focus({ workspace: item, focused: true });
    await sees({ open: [item], front: item, count: 2 });

    // A reload opens the window's new stream before the old one closes; the window stays listed once and keeps its focus.
    const reloaded = open(`/events?workspace=${encodeURIComponent(item)}&focused=1`);

    await sees({ open: [item], front: item, count: 3 });
    itemWindow.close();
    await sees({ open: [item], front: item, count: 2 });
    reloaded.close();
    await sees({ open: [], front: null, count: 1 });

    // A report of an earlier change that arrives late changes nothing.
    const later = Date.now() + 60_000;
    const messages = () => docked.text().split('event: dock').length;
    const resent = async () => {
      const before = messages();

      server.update();
      await until(() => (messages() > before ? true : null));
    };
    const again = open(`/events?workspace=${encodeURIComponent(item)}&focused=0&at=${later - 100}`);

    await sees({ open: [item], front: null, count: 2 });
    await focus({ workspace: item, focused: true, at: later });
    await sees({ open: [item], front: item, count: 2 });
    expect((await focus({ workspace: null, focused: true, at: later - 1 }))?.status).toBe(200);
    expect((await focus({ workspace: item, focused: false, at: later - 1 }))?.status).toBe(200);
    await resent();
    await sees({ open: [item], front: item, count: 2 });
    await focus({ workspace: null, focused: true, at: later + 1 });
    await sees({ open: [item], front: null, count: 2 });

    // A window that is not an item window has no workspace, as no front has none; its blur does not hold back the item window's earlier focus.
    await focus({ workspace: null, focused: false, at: later + 30 });
    await focus({ workspace: item, focused: true, at: later + 20 });
    await sees({ open: [item], front: item, count: 2 });

    // A window's blur that arrives before its own earlier focus leaves that focus ignored.
    await focus({ workspace: item, focused: false, at: later + 50 });
    await focus({ workspace: item, focused: true, at: later + 40 });
    await resent();
    await sees({ open: [item], front: null, count: 2 });

    // A stream opens with the time the window read its focus, so an older reading does not take the front.
    const stale = open(`/events?workspace=${encodeURIComponent(item)}&focused=1&at=${later}`);

    await sees({ open: [item], front: null, count: 3 });
    stale.close();
    await sees({ open: [item], front: null, count: 2 });

    // A report that arrives after its window's stream closed does not bring the window back.
    again.close();
    await sees({ open: [], front: null, count: 1 });
    expect((await focus({ workspace: item, focused: true, at: later + 100 }))?.status).toBe(200);
    await resent();
    await sees({ open: [], front: null, count: 1 });

    expect((await focus({ workspace: item, focused: true, at: 'now' }))?.status).toBe(400);
    expect((await focus({ workspace: 3, focused: true }))?.status).toBe(400);
    expect((await focus({ workspace: item }))?.status).toBe(400);
    expect((await call(server.port, 'POST', '/window/focus', null, 2000, { workspace: item, focused: true }))?.status).toBe(401);
    other.close();
    docked.close();
  });

  it("drops a closed window from the front, and still takes another window's focus that happened before the close but arrives after it", async () => {
    let clock = 1_000;
    server = await listenHub({ identity, onShutdown: () => {}, snapshot: () => ({}), dock: () => ({}), now: () => clock });

    const chunks: string[] = [];
    const docked = request({ host: '127.0.0.1', port: server.port, path: '/dock/events', headers: { Authorization: `Bearer ${server.token}` } }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => chunks.push(chunk));
    });

    docked.on('error', () => {});
    docked.end();

    const sees = (windows: object) => until(() => (chunks.join('').endsWith(`data: ${JSON.stringify({ windows })}\n\n`) ? true : null));
    const a = '/w/a.code-workspace';
    const itemWindow = request({ host: '127.0.0.1', port: server.port, path: `/events?workspace=${encodeURIComponent(a)}&focused=1&at=1000`, headers: { Authorization: `Bearer ${server.token}` } });

    itemWindow.on('error', () => {});
    itemWindow.end();
    await sees({ open: [a], front: a, count: 1 });

    const b = '/w/b.code-workspace';
    const other = request({ host: '127.0.0.1', port: server.port, path: `/events?workspace=${encodeURIComponent(b)}&focused=0&at=1010`, headers: { Authorization: `Bearer ${server.token}` } });

    other.on('error', () => {});
    other.end();
    await sees({ open: [a, b], front: a, count: 2 });
    clock = 1_100;
    itemWindow.destroy();
    await sees({ open: [b], front: null, count: 1 });
    // B gained focus at 1060, before A's stream closed at 1100.
    await call(server.port, 'POST', '/window/focus', server.token, 2000, { workspace: b, focused: true, at: 1_060 });
    await sees({ open: [b], front: b, count: 1 });
    other.destroy();
    docked.destroy();
  });

  it('builds no view once views stop, because the hub then closes the app that builds them', async () => {
    let appClosed = false;
    let builtAfterClose = 0;
    const local = await listenHub({
      identity,
      onShutdown: () => {},
      snapshot: () => {
        builtAfterClose += appClosed ? 1 : 0;
        return {};
      },
      dock: () => {
        builtAfterClose += appClosed ? 1 : 0;
        return {};
      },
    });
    const connect = (path: string) => {
      const outbound = request({ host: '127.0.0.1', port: local.port, path, headers: { Authorization: `Bearer ${local.token}` } }, (response) => response.resume());

      outbound.on('error', () => {});
      outbound.end();
    };

    connect('/dock/events');
    connect(`/events?workspace=${encodeURIComponent('/w/a.code-workspace')}&focused=1`);
    await until(() => (local.clients() === 2 ? true : null));
    // The hub's stop: views stop, the app closes, and requests on open connections still arrive before the server closes.
    local.stopViews();
    appClosed = true;
    connect(`/events?workspace=${encodeURIComponent('/w/b.code-workspace')}&focused=1`);
    await until(() => (local.clients() === 3 ? true : null));
    expect((await call(local.port, 'POST', '/window/focus', local.token, 2000, { workspace: '/w/a.code-workspace', focused: false }))?.status).toBe(200);
    await local.close();
    await new Promise((done) => setTimeout(done, 100));
    expect(builtAfterClose).toBe(0);
    server = await listenHub({ identity, onShutdown: () => {} });
  });

  it('refuses the dock stream without the token', async () => {
    server = await listenHub({ identity, onShutdown: () => {}, dock: () => ({}) });

    expect((await call(server.port, 'GET', '/dock/events', null))?.status).toBe(401);
  });
});
