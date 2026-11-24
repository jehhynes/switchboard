import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hubBundlePath, hubLogPath, hubRecordPath, parseHubRecord, switchboardHome } from '@switchboard/core';
import { buildOf, findHub, holdLock, installLockAddress, releaseLock, serveHub, stopHub, stopSupervisor, supervisorAddress, supervisorOffPath, vscodeSettingsPath } from '@switchboard/hub';
import type { HubRecord } from '@switchboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const main = join(import.meta.dirname, '..', 'dist', 'main.js');

let home: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'switchboard-app-'));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill();
  }

  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function start(...args: string[]): { child: ChildProcess; exited: Promise<{ code: number | null; stdout: string; stderr: string; pid: number | undefined }> } {
  return startWith({}, ...args);
}

function startWith(extra: Record<string, string | undefined>, ...args: string[]): { child: ChildProcess; exited: Promise<{ code: number | null; stdout: string; stderr: string; pid: number | undefined }> } {
  return launch(main, extra, args);
}

function launch(entry: string, extra: Record<string, string | undefined>, args: string[]): { child: ChildProcess; exited: Promise<{ code: number | null; stdout: string; stderr: string; pid: number | undefined }> } {
  // CLAUDE_CONFIG_DIR and CODEX_HOME keep hook installation inside the temporary home. PATH holds only Node and Windows, so the hub runs no
  // real Claude or Codex: an orphaned Codex app-server from the hook trust exchange held <home>/.codex past the cleanup.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  const env: Record<string, string | undefined> = { ...inherited, PATH: [dirname(process.execPath), join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')].join(delimiter), CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), ...extra };

  // A variable set to undefined is removed, such as the CLAUDE_CODE_SESSION_ID of a Claude session running the tests.
  for (const key of Object.keys(extra).filter((name) => extra[name] === undefined)) {
    delete env[key];
  }

  const child = spawn(process.execPath, [entry, ...args, `--home=${home}`, ...(['report', 'register', 'attach', 'holder', 'restart', 'install', 'autostart', 'config'].includes(args[0] ?? '') ? [] : ['--browser-port=0', '--page-port=0'])], { windowsHide: true, env });
  let stdout = '';
  let stderr = '';

  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  children.push(child);

  return { child, exited: new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr, pid: child.pid }))) };
}

function record(): HubRecord | null {
  try {
    return parseHubRecord(readFileSync(hubRecordPath(home), 'utf8'));
  } catch {
    return null;
  }
}

async function recorded(): Promise<HubRecord> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
    const found = record();

    if (found !== null) {
      return found;
    }

    await new Promise((done) => setTimeout(done, 50));
  }

  throw new Error('no hub.json was written');
}

function status(found: HubRecord): Promise<number> {
  return new Promise((resolve) => {
    const outbound = request(
      { host: '127.0.0.1', port: found.port, path: '/status', headers: { Authorization: `Bearer ${found.token}` } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );

    outbound.on('error', () => resolve(0));
    outbound.end();
  });
}

async function until<T>(check: () => T | null, within = 10_000): Promise<T> {
  for (const deadline = Date.now() + within; Date.now() < deadline; ) {
    const found = check();

    if (found !== null) {
      return found;
    }

    await new Promise((done) => setTimeout(done, 50));
  }

  throw new Error('condition not met in time');
}

/** The status a page's conversation stream answers with `cookie`, closed once its headers arrive. */
function pageStreamStatus(found: HubRecord, cookie: string): Promise<number> {
  return new Promise((resolve) => {
    const outbound = request({ host: '127.0.0.1', port: found.port, path: '/v1/conversation/events?page=1', headers: { Host: `127.0.0.1:${found.port}`, Cookie: cookie } }, (response) => {
      resolve(response.statusCode ?? 0);
      outbound.destroy();
    });

    outbound.on('error', () => resolve(0));
    outbound.end();
  });
}

/** Signs a browser in to the hub's page with a one-time link, answering its cookie. */
async function pageCookie(found: HubRecord): Promise<string> {
  const link = await new Promise<string>((resolve, reject) => {
    const outbound = request({ host: '127.0.0.1', port: found.port, method: 'POST', path: '/page/link', headers: { Authorization: `Bearer ${found.token}` } }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve((JSON.parse(body) as { url: string }).url));
    });

    outbound.on('error', reject);
    outbound.end();
  });
  const url = new URL(link);

  return new Promise((resolve, reject) => {
    const outbound = request({ host: '127.0.0.1', port: Number(url.port), path: `${url.pathname}${url.search}` }, (response) => {
      response.resume();
      resolve(String(response.headers['set-cookie']).split(';')[0]!);
    });

    outbound.on('error', reject);
    outbound.end();
  });
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const outbound = request({ host: '127.0.0.1', port, path, headers }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve(body));
    });

    outbound.on('error', reject);
    outbound.end();
  });
}

describe('hub entry point', () => {
  it('serves, refuses a second hub, and stops on --stop', async () => {
    const first = start('--idle-ms=60000');
    const found = await recorded();

    expect(found.pid).toBe(first.child.pid);
    expect(found.configDir).toBe(resolve(home, '.switchboard'));
    expect(await status(found)).toBe(200);

    const second = await start().exited;

    expect(second.code).toBe(0);
    expect(second.stdout).toBe(`A hub is already running for this home on port ${found.port}; pid ${second.pid} exiting.\n`);

    const stop = await start('--stop').exited;

    expect(stop.stdout).toBe('Stopped the hub.\n');
    expect((await first.exited).code).toBe(0);
    expect(record()).toBeNull();
  });

  it('creates the --config folder, and records it', async () => {
    const configDir = join(home, 'repo', 'switchboard');
    const first = start('--idle-ms=60000', `--config=${configDir}`);
    const found = await recorded();

    expect(found.configDir).toBe(resolve(configDir));
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(join(configDir, 'playbooks'))).toBe(false);

    await start('--stop').exited;
    expect((await first.exited).code).toBe(0);
  });

  it('imports --config into config.json once, then serves the folder config.json names, and refuses a config.json it cannot use', async () => {
    const imported = join(home, 'imported');
    const first = start('--idle-ms=60000', `--config=${imported}`);

    expect((await recorded()).configDir).toBe(resolve(imported));
    expect(JSON.parse(readFileSync(join(switchboardHome(home), 'config.json'), 'utf8'))).toEqual({ configDir: resolve(imported) });
    await start('--stop').exited;
    expect((await first.exited).code).toBe(0);

    const chosen = join(home, 'chosen');

    mkdirSync(chosen);
    expect(await start('config', 'set', 'configDir', chosen).exited).toMatchObject({ code: 0, stdout: `The config folder is now ${resolve(chosen)}.\nThe hub reads it when it starts.\n` });
    expect(await start('config', 'get', 'configDir').exited).toMatchObject({ code: 0, stdout: `${resolve(chosen)}\n` });

    // A stale --config, such as an older login entry's, does not move the hub off the folder config.json names.
    const second = start('--idle-ms=60000', `--config=${imported}`);

    expect((await recorded()).configDir).toBe(resolve(chosen));
    await start('--stop').exited;
    expect((await second.exited).code).toBe(0);
    await until(() => (record() === null ? true : null));

    writeFileSync(join(switchboardHome(home), 'config.json'), '{');

    const refused = await start('--idle-ms=60000').exited;

    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(`Not starting: ${join(switchboardHome(home), 'config.json')} is not valid JSON; fix it, or run hub.js config set configDir <folder>; pid ${refused.pid} exiting.\n`);
    expect(record()).toBeNull();
  }, 60_000);

  it('sends handled registration and release through the CLI and prints the returned key', async () => {
    expect((await start('report', 'handled', 's1').exited).code).toBe(1);
    expect((await start('report', 'handled', 's1', 'https://github.com/o/r/issues/7').exited).code).toBe(2);
    const bodies: unknown[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        if (req.method === 'GET') { res.end(JSON.stringify({ hub: 'switchboard', protocol: 1, version: '0.0.0', pid: process.pid })); return; }
        expect(req.url).toBe('/handled');
        const parsed = JSON.parse(body) as { releaseKey: string | null };
        bodies.push(parsed);
        res.end(JSON.stringify({ assignmentKey: parsed.releaseKey === null ? 'I:A' : null }));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    mkdirSync(dirname(hubRecordPath(home)), { recursive: true });
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, execPath: process.execPath, port, token: 't', pid: process.pid, startedAt: 'now' }));
    try {
      const registered = await startWith({ CLAUDE_CODE_SESSION_ID: 'native' }, 'report', 'handled', 's1', 'https://github.com/o/r/issues/7').exited;
      expect(registered).toMatchObject({ code: 0, stdout: '{"assignmentKey":"I:A"}\n' });
      const released = await start('report', 'handled', 's1', 'https://github.com/o/r/issues/7', '--release', 'I:A').exited;
      expect(released).toMatchObject({ code: 0, stdout: '{"assignmentKey":null}\n' });
      expect(bodies[0]).toEqual({ sessionId: 's1', url: 'https://github.com/o/r/issues/7', releaseKey: null, nativeSessionId: 'native' });
      expect(bodies[1]).toMatchObject({ releaseKey: 'I:A' });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('reports when there is no hub to stop', async () => {
    const stop = await start('--stop').exited;

    expect(stop.code).toBe(0);
    expect(stop.stdout).toBe('No hub is running for this home.\n');
  });

  it('exits 1 when another process holds the lock and no hub answers', async () => {
    mkdirSync(switchboardHome(home), { recursive: true });

    const lock = await holdLock(home);

    try {
      const refused = await start().exited;

      expect(refused.code).toBe(1);
      expect(refused.stderr).toBe(`Not starting: another process holds the hub lock but no hub answers; pid ${refused.pid} exiting.\n`);
      expect(record()).toBeNull();
    } finally {
      await releaseLock(lock!);
    }
  });

  it('records reports through the running hub, with exit codes for usage, refusal and no hub', async () => {
    const usage = await start('report', 'stage', 's1').exited;

    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain('report stage <sessionId> <stage>');

    const noHub = await start('report', 'stage', 's1', 'Planning').exited;

    expect(noHub).toMatchObject({ code: 2, stderr: 'The Switchboard hub is not running, so the report was not recorded.\n' });

    const hub = start('--idle-ms=60000');
    await recorded();

    const refused = await start('report', 'stage', 's1', 'Planning').exited;

    expect(refused).toMatchObject({ code: 3, stderr: 'Refused: Unknown session s1.\n' });
    expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks.Stop).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).hooks.Stop).toHaveLength(1);

    await start('--stop').exited;
    expect((await hub.exited).code).toBe(0);
  });

  it('waits longer than a second for a slow hub to answer its status check', async () => {
    const server = createServer((req, res) => {
      if (req.method === 'GET') {
        setTimeout(() => res.end(JSON.stringify({ hub: 'switchboard', protocol: 1, version: '0.0.0', pid: process.pid })), 1500);
        return;
      }

      req.resume();
      req.on('end', () => res.end('{}'));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    mkdirSync(dirname(hubRecordPath(home)), { recursive: true });
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, execPath: process.execPath, port, token: 't', pid: process.pid, startedAt: 'now' }));

    try {
      expect(await start('report', 'stage', 's1', 'Planning').exited).toMatchObject({ code: 0, stdout: 'recorded\n' });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('posts a report again to the hub that takes over when the running hub answers that it is restarting', async () => {
    const posts: string[] = [];
    const fake = (answer: number, token: string) =>
      createServer((req, res) => {
        if (req.method === 'GET') {
          res.end(JSON.stringify({ hub: 'switchboard', protocol: 1, version: '0.0.0', pid: process.pid }));
          return;
        }

        req.resume();
        req.on('end', () => {
          posts.push(`${token} ${answer}`);
          res.writeHead(answer, { 'Content-Type': 'application/json' });
          res.end(answer === 503 ? JSON.stringify({ error: 'The hub is restarting onto a new build; try again in a few seconds.' }) : '{}');

          if (answer === 503) {
            writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b2', configDir: home, execPath: process.execPath, port: ports[1], token: 'new', pid: process.pid, startedAt: 'now' }));
          }
        });
      });
    const servers = [fake(503, 'old'), fake(200, 'new')];
    const ports: number[] = [];

    for (const server of servers) {
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      ports.push((server.address() as AddressInfo).port);
    }

    mkdirSync(dirname(hubRecordPath(home)), { recursive: true });
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b1', configDir: home, execPath: process.execPath, port: ports[0], token: 'old', pid: process.pid, startedAt: 'now' }));

    try {
      expect(await start('report', 'stage', 's1', 'Planning').exited).toMatchObject({ code: 0, stdout: 'recorded\n' });
      expect(posts).toEqual(['old 503', 'new 200']);
    } finally {
      for (const server of servers) {
        server.closeAllConnections();
        server.close();
      }
    }
  });

  it('says a hub whose recorded process runs did not answer, rather than that none runs', async () => {
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((done) => closed.close(() => done()));
    mkdirSync(dirname(hubRecordPath(home)), { recursive: true });
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, execPath: process.execPath, port, token: 't', pid: process.pid, startedAt: 'now' }));

    expect(await start('report', 'stage', 's1', 'Planning').exited).toMatchObject({ code: 2, stderr: `The Switchboard hub (pid ${process.pid}) did not answer, so the report was not recorded.\n` });
    expect(await start('report', 'handled', 's1', 'https://github.com/o/r/issues/7').exited).toMatchObject({ code: 2, stderr: `The Switchboard hub (pid ${process.pid}) did not answer.\n` });
  });

  it("sends the reporting Claude copy from CLAUDE_CODE_SESSION_ID, and prints the hub's refusal (PRD R78)", async () => {
    const bodies: unknown[] = [];
    const server = createServer((req, res) => {
      let text = '';
      req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      req.on('end', () => {
        if (req.method === 'GET') {
          res.end(JSON.stringify({ hub: 'switchboard', protocol: 1, version: '0.0.0', pid: process.pid }));
          return;
        }

        bodies.push(JSON.parse(text));
        res.statusCode = 409;
        res.end(JSON.stringify({ error: 'Session old was replaced by fork new, so the report was not recorded.' }));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    mkdirSync(dirname(hubRecordPath(home)), { recursive: true });
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, execPath: process.execPath, port, token: 't', pid: process.pid, startedAt: 'now' }));

    try {
      const refused = await startWith({ CLAUDE_CODE_SESSION_ID: 'old-copy' }, 'report', 'stage', 's1', 'Planning').exited;
      await startWith({ CLAUDE_CODE_SESSION_ID: undefined }, 'report', 'stage', 's1', 'Planning').exited;

      expect(refused).toMatchObject({ code: 3, stderr: 'Refused: Session old was replaced by fork new, so the report was not recorded.\n' });
      expect(bodies).toEqual([
        { sessionId: 's1', kind: 'stage', stage: 'Planning', nativeSessionId: 'old-copy' },
        { sessionId: 's1', kind: 'stage', stage: 'Planning' },
      ]);
    } finally {
      server.close();
    }
  });

  it('registers the Claude session from CLAUDE_CODE_SESSION_ID and prints its contract, with exit codes for usage, no hub and refusal (PRD R81)', async () => {
    const native = { CLAUDE_CODE_SESSION_ID: '9273f594-1111-4222-8333-444455556666' };

    expect(await startWith(native, 'register').exited).toMatchObject({ code: 1, stderr: 'Usage: register --title <text>\n' });
    expect(await startWith({ CLAUDE_CODE_SESSION_ID: undefined }, 'register', '--title', 'Fix it').exited).toMatchObject({ code: 1, stderr: 'Only a Claude Code session can register: CLAUDE_CODE_SESSION_ID is not set.\n' });
    expect(await startWith(native, 'register', '--title', 'Fix it').exited).toMatchObject({ code: 2, stderr: 'The Switchboard hub is not running; run the command again, which answers the contract of a session it registered.\n' });

    const bodies: unknown[] = [];
    const replies = [
      { status: 200, body: { key: 'adhoc 4', already: false, contract: 'Report to Switchboard with these commands:\n- node hub.js report done s9, when the entire work item is done: every part of the task is complete, and this session has nothing left to do and can be retired.' } },
      { status: 200, body: { key: 'adhoc 4', already: true, contract: 'Report to Switchboard with these commands:' } },
      { status: 409, body: { error: 'This session is a copy of adhoc 4, which Switchboard continues in its latest copy.' } },
    ];
    const server = createServer((req, res) => {
      let text = '';
      req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      req.on('end', () => {
        if (req.method === 'GET') {
          res.end(JSON.stringify({ hub: 'switchboard', protocol: 1, version: '0.0.0', pid: process.pid }));
          return;
        }

        bodies.push({ path: req.url, body: JSON.parse(text) });
        const reply = replies.shift()!;
        res.statusCode = reply.status;
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    mkdirSync(dirname(hubRecordPath(home)), { recursive: true });
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, execPath: process.execPath, port, token: 't', pid: process.pid, startedAt: 'now' }));

    try {
      expect(await startWith(native, 'register', '--title', 'Fix the badge').exited).toMatchObject({
        code: 0,
        stdout: 'Registered as adhoc 4.\n\nReport to Switchboard with these commands:\n- node hub.js report done s9, when the entire work item is done: every part of the task is complete, and this session has nothing left to do and can be retired.\n',
      });
      expect(await startWith(native, 'register', '--title=Again').exited).toMatchObject({ code: 0, stdout: 'Already registered as adhoc 4.\n\nReport to Switchboard with these commands:\n' });
      expect(await startWith(native, 'register', '--title', 'Copy').exited).toMatchObject({ code: 3, stderr: 'Refused: This session is a copy of adhoc 4, which Switchboard continues in its latest copy.\n' });
      expect(bodies.map((entry) => (entry as { body: { title: string } }).body.title)).toEqual(['Fix the badge', 'Again', 'Copy']);
      expect(bodies[0]).toEqual({ path: '/register', body: { nativeSessionId: native.CLAUDE_CODE_SESSION_ID, title: 'Fix the badge' } });
    } finally {
      server.close();
    }
  });

  it('prints a web page link, pairs, lists and signs browsers out through the hub, with exit codes for usage, refusals and no hub', async () => {
    const usage = 'Usage: hub.js web [pair | devices | revoke [<device ID>]]\n';

    expect(await start('web', 'now').exited).toMatchObject({ code: 1, stderr: usage });
    expect(await start('web', 'pair', 'now').exited).toMatchObject({ code: 1, stderr: usage });
    expect(await start('web', 'revoke', 'a', 'b').exited).toMatchObject({ code: 1, stderr: usage });
    expect((await start('web').exited).code).toBe(2);
    expect((await start('web', 'revoke').exited).code).toBe(2);
    expect(await start('--page-port=soon').exited).toMatchObject({ code: 1, stderr: '--page-port takes a port number, not "soon".\n' });

    const hub = start('--idle-ms=60000');
    const found = await recorded();
    const link = await start('web').exited;

    expect(link.code).toBe(0);
    expect(link.stdout).toMatch(new RegExp(`http://127\\.0\\.0\\.1:${found.port}/page\\?t=[0-9a-f]{64}`));
    expect(await start('web', 'revoke').exited).toMatchObject({ code: 0, stdout: 'Signed out every browser (0 sign-ins). Open a new link to use the web page again.\n' });
    expect(await start('web', 'devices').exited).toMatchObject({ code: 0, stdout: 'No device is signed in.\n' });
    // No remote host is set, so there is nothing to pair through.
    expect(await start('web', 'pair').exited).toMatchObject({ code: 3, stderr: expect.stringContaining('Refused: Pairing a device needs remote access') });
    expect(await start('web', 'revoke', 'abcdef12').exited).toMatchObject({ code: 3, stderr: 'Refused: No device has the ID abcdef12.\n' });
    expect(await start('web', 'revoke', 'nope').exited).toMatchObject({ code: 3, stderr: 'Refused: Expected {id}, a device ID of 8 hex characters.\n' });

    await start('--stop').exited;
    expect((await hub.exited).code).toBe(0);
  });

  it('takes --code-mode-idle-ms as a whole number of milliseconds and refuses anything else', async () => {
    expect(await start('--code-mode-idle-ms=soon').exited).toMatchObject({ code: 1, stderr: '--code-mode-idle-ms takes a whole number of milliseconds above 0, not "soon".\n' });

    const hub = start('--idle-ms=60000', '--code-mode-idle-ms=60000');

    await recorded();
    await start('--stop').exited;
    expect(await hub.exited).toMatchObject({ code: 0, stdout: expect.stringContaining('Code Mode idle limit: 60000 ms') });
  });

  it('attaches by session ID through the hub, printing a refusal and asking again on Enter until input ends', async () => {
    expect(await start('attach').exited).toMatchObject({ code: 1, stderr: 'Usage: attach <session ID>\n' });

    const down = start('attach', 's1');

    down.child.stdin!.end();
    expect(await down.exited).toMatchObject({ code: 0, stdout: 'The Switchboard hub is not running. Press Enter to try again, or close this terminal.\r\n' });

    const bodies: unknown[] = [];
    const server = createServer((req, res) => {
      let text = '';
      req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      req.on('end', () => {
        if (req.method === 'GET') {
          res.end(JSON.stringify({ hub: 'switchboard', protocol: 1, version: '0.0.0', pid: process.pid }));
          return;
        }

        bodies.push({ path: req.url, body: JSON.parse(text) });
        res.statusCode = 409;
        res.end(JSON.stringify({ error: 'Session abc is still ending; try again.' }));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    mkdirSync(dirname(hubRecordPath(home)), { recursive: true });
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, execPath: process.execPath, port, token: 't', pid: process.pid, startedAt: 'now' }));

    try {
      const attach = start('attach', 's1');
      const refusal = 'Refused: Session abc is still ending; try again.\r\nPress Enter to try again, or close this terminal.\r\n';

      for (const deadline = Date.now() + 10_000; bodies.length === 0 && Date.now() < deadline; ) {
        await new Promise((done) => setTimeout(done, 50));
      }

      attach.child.stdin!.write('\n');

      for (const deadline = Date.now() + 10_000; bodies.length < 2 && Date.now() < deadline; ) {
        await new Promise((done) => setTimeout(done, 50));
      }

      attach.child.stdin!.end();
      expect(await attach.exited).toMatchObject({ code: 0, stdout: refusal + refusal });
      expect(bodies).toEqual([
        { path: '/attach', body: { sessionId: 's1' } },
        { path: '/attach', body: { sessionId: 's1' } },
      ]);
    } finally {
      server.close();
    }
  });

  it('lists and stops held sessions through the hub, with exit codes for usage, refusal and nothing answering', async () => {
    expect(await start('holder').exited).toMatchObject({ code: 1, stderr: expect.stringContaining('Usage:\n  holder list\n') });
    expect(await start('holder', 'list').exited).toMatchObject({ code: 0, stdout: 'No terminal holder is running.\n' });
    expect(await start('holder', 'stop', 's1').exited).toMatchObject({ code: 2, stderr: 'The Switchboard hub is not running, and no terminal holder is running.\n' });

    const bodies: unknown[] = [];
    const replies = [
      { status: 200, body: { sessions: [{ session: 's1', label: 'l', workItemId: 1, key: 'gh 7', nativeSessionId: 'n1', cwd: 'D:/git/widgets', state: 'idle', idleSince: Date.now(), memoryBytes: null, clients: 1, exitedAt: null, exitCode: null, orphan: false }] } },
      { status: 404, body: { error: 'No held session nope.' } },
      { status: 200, body: { stopped: 's1' } },
    ];
    const server = createServer((req, res) => {
      let text = '';
      req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      req.on('end', () => {
        if (req.method === 'GET') {
          res.end(JSON.stringify({ hub: 'switchboard', protocol: 1, version: '0.0.0', pid: process.pid }));
          return;
        }

        bodies.push({ path: req.url, body: JSON.parse(text) });
        const reply = replies.shift()!;
        res.statusCode = reply.status;
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    mkdirSync(dirname(hubRecordPath(home)), { recursive: true });
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, execPath: process.execPath, port, token: 't', pid: process.pid, startedAt: 'now' }));

    try {
      expect(await start('holder', 'list').exited).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Work item +Switchboard ID.*\ngh 7 +s1 +n1 +D:\/git\/widgets +idle +0m +- +1\n$/) });
      expect(await start('holder', 'stop', 'nope').exited).toMatchObject({ code: 3, stderr: 'Refused: No held session nope.\n' });
      expect(await start('holder', 'stop', 's1').exited).toMatchObject({ code: 0, stdout: 'Stopped held session s1.\n' });
      expect(bodies).toEqual([
        { path: '/holder/list', body: {} },
        { path: '/holder/stop', body: { id: 'nope' } },
        { path: '/holder/stop', body: { id: 's1' } },
      ]);
    } finally {
      server.close();
    }
  });

  it('exits after the idle time with no client and removes its record', async () => {
    const hub = start('--idle-ms=200');

    await recorded();

    expect((await hub.exited).code).toBe(0);
    expect(record()).toBeNull();
  });
  it('restarts onto another installed build once quiet, handing its record to the new hub, which pages reach again', async () => {
    // The installed bundle loads the built entry point, so changing the file changes the installed build.
    const bundle = hubBundlePath(home);
    const shim = `import(${JSON.stringify(pathToFileURL(main).href)});\n`;

    mkdirSync(switchboardHome(home), { recursive: true });
    writeFileSync(bundle, shim);

    const first = launch(bundle, {}, ['--idle-ms=60000']);
    const before = await recorded();

    expect(before.build).toBe(buildOf(bundle));

    // A page's stream: it ends when the hub hands over, and a new one opens on the new record.
    const cookie = await pageCookie(before);
    let pageOpened = false;
    const pageEnded = new Promise<void>((done) => {
      const outbound = request({ host: '127.0.0.1', port: before.port, path: '/v1/conversation/events?page=1', headers: { Host: `127.0.0.1:${before.port}`, Cookie: cookie } }, (response) => {
        pageOpened = response.statusCode === 200;
        response.resume();
        response.on('close', () => done());
      });

      outbound.on('error', () => done());
      outbound.end();
    });

    try {
      await until(() => (pageOpened ? true : null));

      writeFileSync(bundle, `${shim}// another build\n`);

      const after = await until(() => {
        const found = record();

        return found !== null && found.pid !== before.pid ? found : null;
      }, 30_000);
      const old = await first.exited;

      expect(old.code).toBe(0);
      expect(after.build).toBe(buildOf(bundle));
      expect(after.build).not.toBe(before.build);
      expect(old.stdout).toContain(`restarting the hub from build ${before.build} onto build ${after.build}, which is installed`);
      expect(old.stdout).toContain(`hub restart: pid ${after.pid} took over with build ${after.build}`);
      expect(readFileSync(hubLogPath(home), 'utf8')).toContain(`listening on 127.0.0.1:${after.port} as pid ${after.pid}, build ${after.build}`);
      // The successor took the lock: a hub started meanwhile waited for it instead.
      expect(readFileSync(hubLogPath(home), 'utf8')).not.toContain('A hub is already running');

      // The page's stream ended and a new one opens on the new record with the same sign-in; a page's ping names the new build.
      await pageEnded;
      expect(await pageStreamStatus(after, cookie)).toBe(200);
      expect(JSON.parse(await get(after.port, '/page/ping', { Host: `127.0.0.1:${after.port}`, Cookie: cookie }))).toEqual({ build: after.build, signedIn: true });
      expect(JSON.parse(await get(after.port, '/page/ping'))).toEqual({ build: after.build, signedIn: false });
    } finally {
      await start('--stop').exited;
    }
  }, 60_000);
  it('waits on hub.js install --wait through a restart the hub begins by itself while the programs install, when no hub answers for a moment', async () => {
    // The old hub, in this process, restarts onto the new bundle as soon as it is copied; the holder's install lock, held here, keeps the
    // command installing until the old hub has stopped and removed its record, and the successor starts only once the command waits.
    const board = switchboardHome(home);
    const bundle = hubBundlePath(home);
    const dist = join(home, 'build');

    for (const dir of [join(board, 'holder'), join(dist, 'holder'), join(dist, 'voice')]) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(bundle, 'old build');
    writeFileSync(join(dist, 'hub.js'), `import(${JSON.stringify(pathToFileURL(main).href)});\n`);

    for (const [program, build] of [['holder', '0123456789abcdef'], ['voice', 'fedcba9876543210']] as const) {
      writeFileSync(join(dist, program, `${program}.js`), '');
      writeFileSync(join(dist, program, 'manifest.json'), JSON.stringify({ build, files: [`${program}.js`] }));
    }

    const installLock = createNetServer();

    await new Promise<void>((done) => installLock.listen(installLockAddress(board), done));

    let handingOver!: () => void;
    let oldExited!: () => void;
    const handedOver = new Promise<void>((done) => (handingOver = done));
    const exitedOld = new Promise<void>((done) => (oldExited = done));
    const old = await serveHub({
      home,
      version: 'test',
      build: buildOf(bundle),
      configDir: board,
      browserPort: null,
      pagePort: 0,
      exit: () => oldExited(),
      log: (line) => line === 'stopping: restarting onto the installed build' && handingOver(),
      restart: { bundle, checkMs: 10, takeoverWaitMs: 5000, successor: async () => ({ pid: process.pid, cancel: () => undefined }) },
    });

    expect('served' in old).toBe(true);

    const installing = launch(join(dist, 'hub.js'), {}, ['install', '--wait']);
    const waiting = new Promise<void>((done) => installing.child.stdout?.on('data', (chunk: string) => chunk.includes('waiting for that.') && done()));

    await handedOver;
    await (old as { served: { stop(reason: string): Promise<void> } }).served.stop('test handover');
    expect(record()).toBeNull();
    await new Promise<void>((done) => installLock.close(() => done()));
    expect(await Promise.race([waiting.then(() => 'waiting'), installing.exited.then(() => 'exited')])).toBe('waiting');

    const successor = await serveHub({ home, takeover: process.pid, version: 'test', build: buildOf(bundle), configDir: board, browserPort: null, pagePort: 0, log: () => undefined });

    try {
      const result = await installing.exited;

      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Restarted: pid ${process.pid}, build ${buildOf(bundle)}.\n`);
      await exitedOld;
    } finally {
      if ('served' in successor) {
        await successor.served.stop('test done');
      }
    }
  }, 30_000);
  it('restarts the hub on hub.js restart and waits for the new one, with exit codes for no hub and no installed bundle', async () => {
    const none = await start('restart').exited;

    expect(none.code).toBe(2);
    expect(none.stderr).toBe('The Switchboard hub is not running.\n');

    // A hub run from the built entry point, with nothing installed in its home, has no bundle to restart onto.
    start('--idle-ms=60000');

    const plain = await recorded();
    const refused = await start('restart').exited;

    expect(refused.code).toBe(3);
    expect(refused.stderr).toBe('Refused: No hub bundle is installed.\n');
    expect((await start('restart', 'now').exited).code).toBe(1);
    await start('--stop').exited;
    await until(() => (record() === null ? true : null));

    const bundle = hubBundlePath(home);

    writeFileSync(bundle, `import(${JSON.stringify(pathToFileURL(main).href)});\n`);
    launch(bundle, {}, ['--idle-ms=60000']);

    const before = await until(() => {
      const found = record();

      return found !== null && found.pid !== plain.pid ? found : null;
    });

    try {
      const restarted = await start('restart').exited;
      const after = record()!;

      expect(restarted.code).toBe(0);
      expect(after.pid).not.toBe(before.pid);
      expect(after.build).toBe(before.build);
      expect(restarted.stdout).toBe(`Restarting the hub (pid ${before.pid}, build ${before.build}) onto build ${before.build}.\nRestarted: pid ${after.pid}, build ${after.build}.\n`);
    } finally {
      await start('--stop').exited;
    }
  }, 60_000);
  it('starts the installed hub detached on hub.js start, with this runtime and the --config folder, and reports a running one', async () => {
    const missing = await start('start').exited;

    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe(`No hub is installed in ${hubBundlePath(home)}; run npm run install-local in the repository, or hub.js install from a build folder, first.\n`);
    expect((await start('start', '--takeover=1').exited).code).toBe(1);

    mkdirSync(switchboardHome(home), { recursive: true });
    writeFileSync(hubBundlePath(home), `import(${JSON.stringify(pathToFileURL(main).href)});\n`);

    const configDir = join(home, 'config');
    const started = await start('start', `--config=${configDir}`).exited;
    const found = record()!;

    try {
      expect(started.stderr).toBe('');
      expect(started.code).toBe(0);
      expect(started.stdout).toBe(`Started the hub: pid ${found.pid}, build ${buildOf(hubBundlePath(home))}, config folder ${resolve(configDir)}.\n`);
      // The hub outlives the command, runs on its runtime rather than VS Code's, and logs to hub.log.
      expect(found.pid).not.toBe(started.pid);
      expect(found.execPath).toBe(process.execPath);
      expect(await status(found)).toBe(200);
      await until(() => (readFileSync(hubLogPath(home), 'utf8').includes(`as pid ${found.pid}`) ? true : null));

      const again = await start('start').exited;

      expect(again).toMatchObject({ code: 0, stdout: `The hub is already running: pid ${found.pid}, build ${found.build}, config folder ${resolve(configDir)}.\n` });
    } finally {
      await start('--stop').exited;
    }

    await until(() => (record() === null ? true : null));

    const quick = await start('start', '--no-wait').exited;

    try {
      expect(quick.code).toBe(0);
      expect(quick.stdout).toMatch(/^Starting the hub \(pid \d+\); its output goes to /);
      // The first start imported its --config into config.json, which every later start reads.
      expect((await recorded()).configDir).toBe(resolve(configDir));
    } finally {
      await until(() => (record() !== null ? true : null));
      await start('--stop').exited;
    }
  }, 60_000);
  it('starts the hub again on hub.js supervise when it is killed, not when it restarts onto a new build or is stopped with --stop, runs one supervisor per home, and stops when asked', async () => {
    mkdirSync(switchboardHome(home), { recursive: true });
    writeFileSync(hubBundlePath(home), `import(${JSON.stringify(pathToFileURL(main).href)});\n`);

    const usage = await start('supervise', '--grace-ms=soon').exited;

    expect(usage.code).toBe(1);
    expect(usage.stderr).toMatch(/^Usage: hub\.js supervise \[--config=<dir>\]/);

    // The supervisor passes the serving flags on, here those that keep the test's hubs off the fixed ports.
    const supervisor = start('supervise', '--grace-ms=0', '--check-ms=200');
    const log = (): string => (existsSync(hubLogPath(home)) ? readFileSync(hubLogPath(home), 'utf8') : '');

    try {
      const first = await recorded();

      expect(first.pid).not.toBe(supervisor.child.pid);
      expect(await status(first)).toBe(200);

      const second = await start('supervise').exited;

      expect(second).toMatchObject({ code: 0, stdout: `A supervisor is already running for this home on ${supervisorAddress(home)}.\n` });

      // A forced exit is a crash: the supervisor starts the hub again.
      process.kill(first.pid, 'SIGKILL');

      const again = await until(() => {
        const found = record();

        return found !== null && found.pid !== first.pid ? found : null;
        // The hub ran only briefly, so the supervisor waits before this second start.
      }, 40_000);

      expect(await status(again)).toBe(200);
      expect(log()).toContain('supervisor: the hub stopped without hub.js --stop; starting it again');

      // A restart onto a new build hands over to a successor; the supervisor starts no hub of its own meanwhile.
      const starts = (): number => log().split('\n').filter((line) => /supervisor: (no hub is running; starting one|the hub stopped without hub\.js --stop; starting it again)/.test(line)).length;
      const before = starts();
      const restarted = await start('restart').exited;

      expect(restarted.code).toBe(0);
      await new Promise((done) => setTimeout(done, 1_000));
      expect(starts()).toBe(before);
      expect(log()).not.toContain('A hub is already running');

      // A deliberate stop stays stopped.
      await start('--stop').exited;
      await until(() => (log().includes('was stopped on purpose (a client asked it to stop)') ? true : null));
      await new Promise((done) => setTimeout(done, 1_000));
      expect(record()).toBeNull();
      expect(starts()).toBe(before);

      expect(await stopSupervisor(home)).toBe(true);
      expect((await supervisor.exited).code).toBe(0);
      expect(log()).toContain('supervisor: stopping: asked by hub.js autostart');

      // After hub.js autostart off, a supervisor its task had already launched exits once it holds its lock.
      writeFileSync(supervisorOffPath(home), 'off\n');

      const late = await start('supervise', '--grace-ms=0', '--check-ms=200').exited;

      expect(late).toMatchObject({ code: 0, stdout: 'hub.js autostart off removed the supervisor; run hub.js autostart on to turn it on again.\n' });
      expect(record()).toBeNull();
    } finally {
      await stopSupervisor(home).catch(() => false);
      await start('--stop').exited;
    }
  }, 90_000);

  it('refuses hub.js autostart usage errors before reading or changing any login start', async () => {
    for (const args of [['autostart', 'maybe'], ['autostart', 'on', 'off'], ['autostart', 'on', '--force']]) {
      expect(await start(...args).exited).toMatchObject({ code: 1, stdout: '', stderr: 'Usage: hub.js autostart [on | off] [--dry-run]\n' });
    }
  });
  it("installs the builds a build folder carries on hub.js install, and refuses to run from another folder", async () => {
    const refused = await start('install').exited;

    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe(`Run the hub.js of a Switchboard build folder, such as apps/hub/dist/install; ${dirname(main)} carries no terminal holder build.\n`);
    expect(await start('install', '--now').exited).toMatchObject({ code: 1, stderr: 'Usage: <build folder>/hub.js install [--wait] [--home=<dir>]\n' });

    const dist = join(home, 'extension', 'dist');
    const holderBuild = '0123456789abcdef';

    mkdirSync(join(dist, 'holder'), { recursive: true });
    mkdirSync(join(dist, 'voice'), { recursive: true });
    writeFileSync(join(dist, 'hub.js'), `import(${JSON.stringify(pathToFileURL(main).href)});\n`);
    writeFileSync(join(dist, 'holder', 'holder.js'), '');
    writeFileSync(join(dist, 'holder', 'manifest.json'), JSON.stringify({ build: holderBuild, files: ['holder.js'] }));
    writeFileSync(join(dist, 'voice', 'voice.js'), '');
    writeFileSync(join(dist, 'voice', 'manifest.json'), JSON.stringify({ build: 'fedcba9876543210', files: ['voice.js'] }));

    // A scratch VS Code setting under the test home, and a running hub on another folder: the install imports the running hub's folder, which
    // its restart onto the new build then reads, rather than the setting.
    const vscode = vscodeSettingsPath({ home: resolve(home), osHome: homedir(), platform: process.platform, env: process.env });

    mkdirSync(dirname(vscode), { recursive: true });
    writeFileSync(vscode, JSON.stringify({ 'switchboard.configDir': '~/cfg' }));

    const server = createServer((_req, res) => res.end(JSON.stringify({ hub: 'switchboard', protocol: 1, version: '0.0.0', pid: process.pid })));

    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    mkdirSync(switchboardHome(home), { recursive: true });
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'old', configDir: resolve(home, 'running'), execPath: process.execPath, port: (server.address() as AddressInfo).port, token: 't', pid: process.pid, startedAt: 'now' }));

    let installed: Awaited<ReturnType<typeof launch>['exited']>;

    try {
      installed = await launch(join(dist, 'hub.js'), {}, ['install']).exited;
    } finally {
      server.close();
      rmSync(hubRecordPath(home));
    }

    expect(installed.stderr).toBe('');
    expect(installed.code).toBe(0);
    expect(installed.stdout).toBe(`Installed hub build ${buildOf(join(dist, 'hub.js'))} in ${hubBundlePath(home)}.\nConfig folder: ${resolve(home, 'running')}.\nThe running hub (pid ${process.pid}, build old) restarts onto it once it is quiet; hub.js restart waits for that.\n`);
    expect(JSON.parse(readFileSync(join(switchboardHome(home), 'config.json'), 'utf8'))).toEqual({ configDir: resolve(home, 'running') });
    expect(readFileSync(hubBundlePath(home), 'utf8')).toBe(readFileSync(join(dist, 'hub.js'), 'utf8'));
    expect(JSON.parse(readFileSync(join(switchboardHome(home), 'holder', 'current.json'), 'utf8'))).toEqual({ build: holderBuild });

    const again = await launch(join(dist, 'hub.js'), {}, ['install']).exited;

    expect(again.stdout).toBe(`Already installed: hub build ${buildOf(join(dist, 'hub.js'))} in ${hubBundlePath(home)}.\nConfig folder: ${resolve(home, 'running')}.\n`);
    // The installed copy is not a build folder.
    expect((await launch(hubBundlePath(home), {}, ['install']).exited).code).toBe(1);
  });
  it('waits on hub.js install --wait for the running hub to restart onto the installed build, and not when it already runs that build', async () => {
    const dist = join(home, 'build');
    const shim = `import(${JSON.stringify(pathToFileURL(main).href)});\n`;

    mkdirSync(join(dist, 'holder'), { recursive: true });
    mkdirSync(join(dist, 'voice'), { recursive: true });
    writeFileSync(join(dist, 'hub.js'), shim);
    writeFileSync(join(dist, 'holder', 'holder.js'), '');
    writeFileSync(join(dist, 'holder', 'manifest.json'), JSON.stringify({ build: '0123456789abcdef', files: ['holder.js'] }));
    writeFileSync(join(dist, 'voice', 'voice.js'), '');
    writeFileSync(join(dist, 'voice', 'manifest.json'), JSON.stringify({ build: 'fedcba9876543210', files: ['voice.js'] }));

    const first = await launch(join(dist, 'hub.js'), {}, ['install', '--wait']).exited;

    // No hub runs, so there is nothing to wait for.
    expect(first).toMatchObject({ code: 0, stderr: '', stdout: `Installed hub build ${buildOf(join(dist, 'hub.js'))} in ${hubBundlePath(home)}.\nConfig folder: ${switchboardHome(home)}.\n` });

    launch(hubBundlePath(home), {}, ['--idle-ms=60000']);

    const before = await recorded();

    try {
      const same = await launch(join(dist, 'hub.js'), {}, ['install', '--wait']).exited;

      expect(same).toMatchObject({ code: 0, stdout: `Already installed: hub build ${before.build} in ${hubBundlePath(home)}.\nConfig folder: ${switchboardHome(home)}.\n` });
      expect(record()?.pid).toBe(before.pid);

      writeFileSync(join(dist, 'hub.js'), `${shim}// another build\n`);

      const next = buildOf(join(dist, 'hub.js'));
      const waited = await launch(join(dist, 'hub.js'), {}, ['install', '--wait']).exited;
      const after = record()!;

      expect(waited.stderr).toBe('');
      expect(waited.code).toBe(0);
      expect(after.pid).not.toBe(before.pid);
      expect(after.build).toBe(next);
      expect(waited.stdout).toMatch(new RegExp(`^Installed hub build ${next} in .*\\.\\nConfig folder: .*\\.\\nThe running hub \\(pid ${before.pid}, build ${before.build}\\) restarts onto it once it is quiet; waiting for that\\.\\n(It waits until it is quiet: .*\\.\\n)?Restarted: pid ${after.pid}, build ${next}\\.\\n$`));
    } finally {
      await start('--stop').exited;
    }
  }, 60_000);
});
