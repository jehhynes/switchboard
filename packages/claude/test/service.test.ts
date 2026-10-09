import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jobStatePath, readJobQuestion, replyToSession } from '../src/service.js';
import type { ServiceDeps } from '../src/service.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const PIPE = 'cc-daemon-0123abcd-control';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'switchboard-service-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function jobState(shortId: string, fixture: string): void {
  mkdirSync(join(configDir, 'jobs', shortId), { recursive: true });
  copyFileSync(join(FIXTURES, fixture), jobStatePath(configDir, shortId));
}

function writeState(shortId: string, state: unknown): void {
  mkdirSync(join(configDir, 'jobs', shortId), { recursive: true });
  writeFileSync(jobStatePath(configDir, shortId), typeof state === 'string' ? state : JSON.stringify(state));
}

describe('readJobQuestion', () => {
  it('reads the question and options of a recorded blocked job state', () => {
    jobState('d3302c76', 'job-state-one-question.json');

    expect(readJobQuestion(configDir, 'd3302c76')).toEqual({
      questions: [
        {
          question: 'Which fruit should I record?',
          options: [
            { label: 'Apple', description: 'crunchy' },
            { label: 'Mango', description: 'tropical' },
            { label: 'Plum', description: 'purple' },
          ],
        },
      ],
    });
  });

  it('reads every part of a call with two questions', () => {
    jobState('44ad47cf', 'job-state-two-questions.json');

    const result = readJobQuestion(configDir, '44ad47cf');

    expect(result?.questions.map((entry) => entry.question)).toEqual(['Which color?', 'Which shape?']);
    expect(result?.questions[1]?.options).toEqual([
      { label: 'Circle', description: 'Round shape' },
      { label: 'Square', description: 'Shape with corners' },
    ]);
  });

  it('takes a missing description as empty', () => {
    writeState('aaaa0001', { tempo: 'blocked', block: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } });

    expect(readJobQuestion(configDir, 'aaaa0001')).toEqual({ questions: [{ question: 'Which?', options: [{ label: 'A', description: '' }] }] });
  });

  it('returns null for a job that is not blocked, a missing or malformed file, and any other shape', () => {
    const question = { question: 'Which?', options: [{ label: 'A', description: 'a' }] };
    const cases: [string, unknown][] = [
      ['idle', { tempo: 'idle', block: { questions: [question] } }],
      ['noblock', { tempo: 'blocked' }],
      ['empty', { tempo: 'blocked', block: { questions: [] } }],
      ['notlist', { tempo: 'blocked', block: { questions: question } }],
      ['noquestion', { tempo: 'blocked', block: { questions: [{ ...question, question: ' ' }] } }],
      ['nooptions', { tempo: 'blocked', block: { questions: [{ question: 'Which?' }] } }],
      ['badoption', { tempo: 'blocked', block: { questions: [question, { question: 'Then?', options: [{ description: 'no label' }] }] } }],
      ['array', [question]],
      ['notjson', '{"tempo": "blocked", '],
    ];

    for (const [shortId, state] of cases) {
      writeState(shortId, state);
      expect(readJobQuestion(configDir, shortId), shortId).toBeNull();
    }

    expect(readJobQuestion(configDir, 'missing0')).toBeNull();
  });
});

/** A test-owned pipe server standing in for the background service's control pipe. */
async function serve(answer: (frame: string, socket: import('node:net').Socket) => void): Promise<{ server: Server; path: string; frames: string[] }> {
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\switchboard-test-${process.pid}-${Math.random().toString(16).slice(2)}` : join(configDir, 'control.sock');
  const frames: string[] = [];
  const server = createServer((socket) => {
    let buffer = '';

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;

      if (buffer.includes('\n')) {
        frames.push(buffer);
        answer(buffer, socket);
      }
    });
    socket.on('error', () => {});
  });

  await new Promise<void>((done) => server.listen(path, done));

  return { server, path, frames };
}

function deps(path: string, pipes: string[] = ['other-pipe', PIPE]): ServiceDeps & { connected: string[] } {
  const connected: string[] = [];

  return { connected, listPipes: () => pipes, connect: (name) => (connected.push(name), connect(path)) };
}

function writeKey(): void {
  mkdirSync(join(configDir, 'daemon'), { recursive: true });
  writeFileSync(join(configDir, 'daemon', 'control.key'), 'secret-key\r\n');
}

describe('replyToSession', () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((done) => (server === null ? done() : server.close(() => done())));
    server = null;
  });

  it('sends one reply frame with the trimmed key to the control pipe and accepts ok', async () => {
    writeKey();
    const service = await serve((_frame, socket) => socket.write('{"ok":true,"op":"reply"}\n'));
    server = service.server;
    const injected = deps(service.path);

    expect(await replyToSession(configDir, 'c960d7d4', 'Birch "white"', injected)).toBeNull();
    expect(injected.connected).toEqual([`\\\\.\\pipe\\${PIPE}`]);
    expect(service.frames).toEqual(['{"proto":1,"op":"reply","short":"c960d7d4","text":"Birch \\"white\\"","auth":"secret-key"}\n']);
  });

  it("returns the service's error", async () => {
    writeKey();
    const service = await serve((_frame, socket) => socket.write('{"ok":false,"error":"no such session: c960d7d4"}\n'));
    server = service.server;

    expect(await replyToSession(configDir, 'c960d7d4', 'Birch', deps(service.path))).toEqual({ error: 'no such session: c960d7d4' });
  });

  it('names an answer that is neither ok nor an error, or not JSON', async () => {
    writeKey();
    const replies = ['{"ok":false}\n', 'busy\n'];
    const service = await serve((_frame, socket) => socket.write(replies.shift()!));
    server = service.server;

    expect(await replyToSession(configDir, 'c960d7d4', 'Birch', deps(service.path))).toEqual({ error: `Claude's background service refused the answer: {"ok":false}` });
    expect(await replyToSession(configDir, 'c960d7d4', 'Birch', deps(service.path))).toEqual({ error: `Claude's background service answered with text that is not JSON: busy` });
  });

  it('refuses when no control pipe or several are listed, and sends nothing', async () => {
    writeKey();
    const none = deps('unused', ['other-pipe', 'cc-daemon-xyz-control']);
    const two = deps('unused', [PIPE, 'cc-daemon-99-control']);

    expect(await replyToSession(configDir, 'c960d7d4', 'Birch', none)).toEqual({ error: "Claude's background service is not running." });
    expect(await replyToSession(configDir, 'c960d7d4', 'Birch', two)).toEqual({
      error: `Several Claude background services are running (${PIPE}, cc-daemon-99-control), so Switchboard cannot tell which one holds the session.`,
    });
    expect([...none.connected, ...two.connected]).toEqual([]);
  });

  it('says why the pipes could not be listed', async () => {
    const failing: ServiceDeps = {
      listPipes: () => {
        throw new Error('ENOTDIR');
      },
      connect: () => {
        throw new Error('unexpected connect');
      },
    };

    expect(await replyToSession(configDir, 'c960d7d4', 'Birch', failing)).toEqual({ error: 'Switchboard could not list the named pipes: ENOTDIR' });
  });

  it('refuses without the control key, and sends nothing', async () => {
    const injected = deps('unused');
    const result = await replyToSession(configDir, 'c960d7d4', 'Birch', injected);

    expect(result?.error).toMatch(/^Switchboard could not read .*control\.key: ENOENT/);
    expect(injected.connected).toEqual([]);
  });

  it('gives up when the service does not answer in time, or closes without answering', async () => {
    writeKey();
    const silent = await serve(() => {});
    server = silent.server;

    expect(await replyToSession(configDir, 'c960d7d4', 'Birch', deps(silent.path), 50)).toEqual({ error: "Claude's background service did not answer within 0.05 seconds." });

    await new Promise<void>((done) => silent.server.close(() => done()));
    const closing = await serve((_frame, socket) => socket.end('{"ok":true}'));
    server = closing.server;

    expect(await replyToSession(configDir, 'c960d7d4', 'Birch', deps(closing.path))).toEqual({ error: "Claude's background service closed the connection without answering." });
  });

  it('says when the pipe refuses the connection', async () => {
    writeKey();
    const path = process.platform === 'win32' ? `\\\\.\\pipe\\switchboard-test-${process.pid}-absent` : join(configDir, 'absent.sock');
    const result = await replyToSession(configDir, 'c960d7d4', 'Birch', deps(path));

    expect(result?.error).toMatch(/^Claude's background service did not take the answer: .*ENOENT/);
  });
});
