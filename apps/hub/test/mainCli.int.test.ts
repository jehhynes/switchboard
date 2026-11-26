import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { hubRecordPath } from '@switchboard/core';
import { describe, expect, it } from 'vitest';
import { home, useTestHome, start, startWith } from './hubProcess.js';

useTestHome();

describe('hub entry point', () => {
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

  it('refuses hub.js autostart usage errors before reading or changing any login start', async () => {
    for (const args of [['autostart', 'maybe'], ['autostart', 'on', 'off'], ['autostart', 'on', '--force']]) {
      expect(await start(...args).exited).toMatchObject({ code: 1, stdout: '', stderr: 'Usage: hub.js autostart [on | off] [--dry-run]\n' });
    }
  });
});
