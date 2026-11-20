import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listenHub } from '../src/server.js';
import type { HubServer, PageRoutes } from '../src/server.js';
import { artifactFile, cookieValue, findFiles, loopbackHost, PageAccess, PAGE_LINK_MS, pageGroups } from '../src/page.js';
import { pageAsset } from '../src/pageAssets.js';
import { item, session, snapshot } from './views.js';
import { until } from './helpers.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-page-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PageAccess', () => {
  it('exchanges a token once, before it expires, for a cookie it then recognises', () => {
    let now = 1_000;
    const access = new PageAccess(() => now);
    const token = access.token();
    const cookie = access.exchange(token);

    expect(cookie).toMatch(/^[0-9a-f]{64}$/);
    expect(access.exchange(token)).toBeNull();
    expect(access.allows(`a=1; sb_page=${cookie}`)).toBe(true);
    expect(access.allows('sb_page=forged')).toBe(false);
    expect(access.allows(undefined)).toBe(false);

    const late = access.token();

    now += PAGE_LINK_MS + 1;
    expect(access.exchange(late)).toBeNull();
    expect(access.exchange('never-given')).toBeNull();
  });

  it('reads a cookie by its name and answers the loopback names only', () => {
    expect(cookieValue('x=1; sb_page=abc=; y=2', 'sb_page')).toBe('abc=');
    expect(cookieValue('x=1', 'sb_page')).toBeNull();
    expect(loopbackHost('127.0.0.1:5000', 5000)).toBe(true);
    expect(loopbackHost('localhost:5000', 5000)).toBe(true);
    expect(loopbackHost('evil.example:5000', 5000)).toBe(false);
    expect(loopbackHost('127.0.0.1:5001', 5000)).toBe(false);
  });
});

describe('pageGroups', () => {
  it("lists each item work item with the conversations its window hosts, a folder's under the folder, and leaves done work out", () => {
    const own = item(1, { ticket: { ...item(1).ticket, title: 'Fix the badge' }, sessions: [session({ id: 's1', workItemId: 1, cwd: 'D:/w1' })] });
    const done = item(2, { status: 'done' });
    const view = snapshot([own, done]);
    const file = 'C:/sb/windows/x.code-workspace';
    const hostedByItem = item(3, { ticket: { ...item(3).ticket, title: 'Aside', hostWindow: file } });
    const hostedByFolder = item(4, { ticket: { ...item(4).ticket, title: 'Folder chat', hostWindow: 'D:/git/support' } });
    const groups = pageGroups(snapshot([own, done, hostedByItem, hostedByFolder]), 'C:/sb/windows');

    expect(groups.map((group) => group.ids).flat()).not.toContain(2);
    expect(groups.find((group) => group.kind === 'folder')).toEqual({ kind: 'folder', title: 'support', ids: [4] });
    // The hosted conversation's host window is not one of the listed work items' windows, so it is a group of its own.
    expect(groups.find((group) => group.ids.includes(3))?.kind).toBe('window');
    expect(groups.find((group) => group.ids.includes(1))).toEqual({ kind: 'item', title: 'Fix the badge', ids: [1] });
    expect(view.workItems).toHaveLength(2);
  });
});

describe('artifactFile', () => {
  it('serves a file inside the artifact folder and refuses names and links that leave it', () => {
    const folder = join(dir, 'w1');

    mkdirSync(join(folder, 'chat', 'page'), { recursive: true });
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(folder, 'chat', 'page.html'), '<p>hi</p>');
    writeFileSync(join(folder, 'chat', 'page', 'pic.svg'), '<svg/>');
    writeFileSync(join(folder, 'chat', 'notes.md'), '# n');
    writeFileSync(join(dir, 'outside', 'secret.md'), 'secret');
    symlinkSync(join(dir, 'outside'), join(folder, 'chat', 'link'), 'junction');

    expect(artifactFile(folder, 'chat/page.html')).toMatchObject({ mime: 'text/html; charset=utf-8', sandboxed: true });
    expect(artifactFile(folder, 'chat/page/pic.svg')).toMatchObject({ mime: 'image/svg+xml', sandboxed: true });
    expect(artifactFile(folder, 'chat/notes.md')).toMatchObject({ sandboxed: false });
    expect(artifactFile(folder, '../outside/secret.md')).toBeNull();
    expect(artifactFile(folder, 'chat/link/secret.md')).toBeNull();
    expect(artifactFile(folder, 'chat/.hidden')).toBeNull();
    expect(artifactFile(folder, 'chat')).toBeNull();
    expect(artifactFile(folder, 'chat/missing.md')).toBeNull();
  });
});

describe('findFiles', () => {
  it('finds files and folders holding the query, name matches first, and never walks into skipped folders', async () => {
    mkdirSync(join(dir, 'src', 'hello'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'hello'), { recursive: true });
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'src', 'hello', 'index.ts'), '');
    writeFileSync(join(dir, 'src', 'say-hello.ts'), '');
    writeFileSync(join(dir, 'node_modules', 'hello', 'hello.js'), '');
    writeFileSync(join(dir, '.git', 'hello'), '');

    expect(await findFiles(dir, 'HELLO')).toEqual([
      { path: 'src/hello/', dir: true },
      { path: 'src/say-hello.ts', dir: false },
      { path: 'src/hello/index.ts', dir: false },
    ]);
    expect(await findFiles(join(dir, 'missing'), '')).toEqual([]);
  });
});

describe('pageAsset', () => {
  it("serves the page's own files and Mermaid from the home, and nothing else", () => {
    expect(pageAsset('index.html', dir)?.mime).toBe('text/html; charset=utf-8');
    expect(Buffer.isBuffer(pageAsset('codicon.ttf', dir)?.body)).toBe(true);
    expect(pageAsset('mermaid.min.js', dir)).toBeNull();
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'mermaid.min.js'), 'mermaid');
    expect(String(pageAsset('mermaid.min.js', dir)?.body)).toBe('mermaid');
    expect(pageAsset('toString', dir)).toBeNull();
    expect(pageAsset('../hub.json', dir)).toBeNull();
  });
});

/** A request with chosen headers, answering its status, headers and body. */
function send(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const outbound = request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      let text = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
    });

    outbound.on('error', reject);
    outbound.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe('the web page routes', () => {
  let server: HubServer;

  afterEach(async () => {
    await server.close();
  });

  async function serve() {
    const posted: unknown[] = [];
    const closed: string[] = [];
    const pages = new Set<string>();
    let keys = 0;
    const folder = join(dir, 'w1');

    mkdirSync(join(folder, 'chat'), { recursive: true });
    writeFileSync(join(folder, 'chat', 'page.html'), '<script>1</script>');

    const page: PageRoutes = {
      access: new PageAccess(),
      asset: (name) => (name === 'index.html' ? { mime: 'text/html; charset=utf-8', body: '<html>page</html>' } : null),
      opened: () => {
        const key = `page-${++keys}`;

        pages.add(key);
        return key;
      },
      isPage: (key) => pages.has(key),
      list: () => [{ kind: 'item', title: 'T', conversations: [] }],
      files: async (key) => (key === 'page-1' ? [{ path: 'a.ts', dir: false }] : null),
      artifact: (key, name) => (key === 'page-1' ? artifactFile(folder, name) : null),
    };

    server = await listenHub({
      identity: { hub: 'switchboard', protocol: 1, version: '0', pid: 1 },
      onShutdown: () => {},
      page,
      windowClosed: (key) => closed.push(key),
      conversation: (key, write) => {
        write(`event: hello\ndata: {"key":"${key}"}\n\n`);
        return { close: () => {} };
      },
      post: {
        '/v1/conversation/select': async (body) => {
          posted.push(body);
          return { status: 200, body: { scopeGen: 1 } };
        },
        '/v1/conversation/new-conversation': async () => ({ status: 200, body: {} }),
      },
    });

    const link = await send(server.port, 'POST', '/page/link', { Authorization: `Bearer ${server.token}` });
    const url = new URL(JSON.parse(link.body).url as string);

    return { posted, closed, url, folder, open: () => page.opened() };
  }

  it('exchanges a one-time link for an HttpOnly, SameSite=Strict cookie and serves the page only with it, under its own CSP', async () => {
    const { url } = await serve();

    expect(url.host).toBe(`127.0.0.1:${server.port}`);
    expect((await send(server.port, 'POST', '/page/link', {})).status).toBe(401);

    const exchange = await send(server.port, 'GET', `${url.pathname}${url.search}`, {});
    const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;

    expect(exchange.status).toBe(303);
    expect(exchange.headers['location']).toBe('/page/');
    expect(String(exchange.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict; Path=\//);
    expect((await send(server.port, 'GET', `${url.pathname}${url.search}`, {})).status).toBe(403);
    expect((await send(server.port, 'GET', '/page/', {})).status).toBe(401);
    expect((await send(server.port, 'GET', '/page/', { Cookie: 'sb_page=forged' })).status).toBe(401);

    const shown = await send(server.port, 'GET', '/page/', { Cookie: cookie });

    expect(shown).toMatchObject({ status: 200, body: '<html>page</html>' });
    expect(shown.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await send(server.port, 'GET', '/page/missing.js', { Cookie: cookie })).status).toBe(404);
    // Another name for this machine, as DNS rebinding gives, is refused even with the cookie.
    expect((await send(server.port, 'GET', '/page/', { Cookie: cookie, Host: `evil.example:${server.port}` })).status).toBe(403);
    expect(JSON.parse((await send(server.port, 'GET', '/v1/page/list', { Cookie: cookie })).body)).toEqual({ groups: [{ kind: 'item', title: 'T', conversations: [] }] });
    expect((await send(server.port, 'GET', '/v1/page/list', {})).status).toBe(401);
  });

  it("gives a page stream a page key that dies with it, and takes a page's commands only from its origin, for its key and the commands a page may send", async () => {
    const { url, posted, closed } = await serve();
    const exchange = await send(server.port, 'GET', `${url.pathname}${url.search}`, {});
    const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
    const chunks: string[] = [];
    const stream = request({ host: '127.0.0.1', port: server.port, path: '/v1/conversation/events?page=1', headers: { Host: `127.0.0.1:${server.port}`, Cookie: cookie } }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => chunks.push(chunk));
    });

    stream.on('error', () => {});
    stream.end();
    await until(() => (chunks.join('').includes('page-1') ? true : null));

    const origin = `http://127.0.0.1:${server.port}`;
    const post = (path: string, body: unknown, headers: Record<string, string> = { Cookie: cookie, Origin: origin }) => send(server.port, 'POST', path, { 'Content-Type': 'application/json', ...headers }, body);

    expect((await post('/v1/conversation/select', { window: 'page-1', workItemId: 4 })).status).toBe(200);
    expect(posted).toEqual([{ window: 'page-1', workItemId: 4 }]);
    expect((await post('/v1/conversation/select', { window: 'page-1', workItemId: 4 }, { Cookie: cookie, Origin: 'http://127.0.0.1:8766' })).status).toBe(403);
    expect((await post('/v1/conversation/select', { window: 'page-1', workItemId: 4 }, { Cookie: cookie })).status).toBe(403);
    expect((await post('/v1/conversation/select', { window: 'a-window-key', workItemId: 4 })).status).toBe(403);
    expect((await post('/v1/conversation/new-conversation', { window: 'page-1' })).status).toBe(404);
    expect((await post('/v1/conversation/select', { window: 'page-1', workItemId: 4 }, { Cookie: 'sb_page=forged', Origin: origin })).status).toBe(401);
    expect(posted).toHaveLength(1);

    const files = await send(server.port, 'GET', '/v1/conversation/files?window=page-1&q=a', { Cookie: cookie });

    expect(JSON.parse(files.body)).toEqual({ files: [{ path: 'a.ts', dir: false }] });
    expect((await send(server.port, 'GET', '/v1/conversation/files?window=page-2&q=a', { Cookie: cookie })).status).toBe(403);

    stream.destroy();
    await until(() => (closed.includes('page-1') ? true : null));
  });

  it("serves a page's artifact by the page key alone, sandboxed with no network, and nothing outside its folder", async () => {
    const { open } = await serve();

    expect(open()).toBe('page-1');

    const served = await send(server.port, 'GET', '/v1/conversation/artifact/page-1/chat/page.html', {});

    expect(served.status).toBe(200);
    expect(served.body).toBe('<script>1</script>');
    expect(served.headers['content-security-policy']).toMatch(/^sandbox allow-scripts; default-src 'none'/);
    expect(served.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(served.headers['content-security-policy']).not.toContain('connect-src');
    expect(served.headers['referrer-policy']).toBe('no-referrer');
    expect((await send(server.port, 'GET', '/v1/conversation/artifact/page-2/chat/page.html', {})).status).toBe(404);
    expect((await send(server.port, 'GET', '/v1/conversation/artifact/page-1/..%2F..%2Fw1%2Fchat%2Fpage.html', {})).status).toBe(404);
  });
});
