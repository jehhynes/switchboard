import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hubBundlePath, hubLogPath, hubRecordPath, parseHubRecord, switchboardHome } from '@switchboard/core';
import { buildOf, findHub, holdLock, keepHub, makeEnsure, openEvents, releaseLock, stopHub } from '@switchboard/hub';
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

  const child = spawn(process.execPath, [entry, ...args, `--home=${home}`, ...(['report', 'register', 'attach', 'holder'].includes(args[0] ?? '') ? [] : ['--browser-port=0', '--page-port=0'])], { windowsHide: true, env });
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

/** The status a stream answers, closed once its headers arrive. */
function streamStatus(found: HubRecord, path: string): Promise<number> {
  return new Promise((resolve) => {
    const outbound = request({ host: '127.0.0.1', port: found.port, path, headers: { Authorization: `Bearer ${found.token}` } }, (response) => {
      resolve(response.statusCode ?? 0);
      outbound.destroy();
    });

    outbound.on('error', () => resolve(0));
    outbound.end();
  });
}

function get(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outbound = request({ host: '127.0.0.1', port, path }, (response) => {
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
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, port, token: 't', pid: process.pid, startedAt: 'now' }));
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
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, port, token: 't', pid: process.pid, startedAt: 'now' }));

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
            writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b2', configDir: home, port: ports[1], token: 'new', pid: process.pid, startedAt: 'now' }));
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
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b1', configDir: home, port: ports[0], token: 'old', pid: process.pid, startedAt: 'now' }));

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
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, port, token: 't', pid: process.pid, startedAt: 'now' }));

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
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, port, token: 't', pid: process.pid, startedAt: 'now' }));

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
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, port, token: 't', pid: process.pid, startedAt: 'now' }));

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
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, port, token: 't', pid: process.pid, startedAt: 'now' }));

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
    writeFileSync(hubRecordPath(home), JSON.stringify({ protocol: 1, version: '0.0.0', build: 'b', configDir: home, port, token: 't', pid: process.pid, startedAt: 'now' }));

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
  it('restarts onto another installed build once quiet, handing its record to the new hub, which windows, the dock and pages reach again', async () => {
    // The installed bundle loads the built entry point, so changing the file changes the installed build.
    const bundle = hubBundlePath(home);
    const shim = `import(${JSON.stringify(pathToFileURL(main).href)});\n`;

    mkdirSync(switchboardHome(home), { recursive: true });
    writeFileSync(bundle, shim);

    const first = launch(bundle, {}, ['--idle-ms=60000']);
    const before = await recorded();

    expect(before.build).toBe(buildOf(bundle));

    // A window: its keeper finds the hub of the installed build and opens /events again when the stream ends, starting no hub itself.
    const opened: string[] = [];
    const keeper = keepHub({
      ensure: makeEnsure({ find: () => findHub(home), build: () => buildOf(bundle), configDir: () => before.configDir, stop: stopHub, start: () => {}, now: Date.now, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), logPath: hubLogPath(home) }),
      open: (found, onEnd) => openEvents(found, onEnd, undefined, (event) => event === 'hello' && opened.push(found.token)),
      now: Date.now,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      onFailed: (message) => opened.push(`failed: ${message}`),
    });
    const dockEnded = new Promise<void>((done) => {
      const outbound = request({ host: '127.0.0.1', port: before.port, path: '/dock/events', headers: { Authorization: `Bearer ${before.token}` } }, (response) => {
        response.resume();
        response.on('close', () => done());
      });

      outbound.on('error', () => done());
      outbound.end();
    });

    try {
      await until(() => (opened.includes(before.token) ? true : null));

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

      // The window's keeper connected to the new hub; the dock's stream ended and a new one opens on the new record; a page's ping names the new build.
      await until(() => (opened.includes(after.token) ? true : null), 10_000);
      expect(opened.filter((entry) => entry.startsWith('failed'))).toEqual([]);
      expect(keeper.current()?.token).toBe(after.token);
      await dockEnded;
      expect(await streamStatus(after, '/dock/events')).toBe(200);
      expect(JSON.parse(await get(after.port, '/page/ping'))).toEqual({ build: after.build });
    } finally {
      keeper.dispose();
      await start('--stop').exited;
    }
  }, 60_000);
});
