import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { join } from 'node:path';
import { recordPath } from '@switchboard/holder';
import type { SessionEntry } from '@switchboard/holder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findHeld, heldFromHolder, labelParts } from '../src/held.js';
import type { HeldSession } from '../src/held.js';
import { connectHolder, heldTable, idleText, runHolder } from '../src/holderCli.js';
import type { HolderCliDeps, HolderControl } from '../src/holderCli.js';
import { tempHome } from './helpers.js';

const NOW = Date.UTC(2026, 10, 18, 12);
const CLAUDE = '9273f594-1111-4222-8333-444455556666';

function entry(session: string, fields: Partial<SessionEntry> = {}): SessionEntry {
  return { session, label: `switchboard · ad-hoc · adhoc 1 ${CLAUDE}`, pid: 9, cwd: 'D:/git/widgets', startedAt: NOW - 3 * 60_000, lastInputAt: null, lastOutputAt: null, exitedAt: null, exitCode: null, clients: 0, memoryBytes: null, ...fields };
}

function hubSession(session: string, fields: Partial<HeldSession> = {}): HeldSession {
  return { ...heldFromHolder(entry(session)), ...fields };
}

type Reply = Awaited<ReturnType<HolderCliDeps['post']>>;

const CURRENT = { protocol: 1, build: 'aaaaaaaaaaaaaaaa', pid: 34000, features: ['snapshot', 'write'] };
const OLDER = { protocol: 1, build: '61663226176fa458', pid: 34000, features: ['snapshot'] };

/** A hub that answers with `reply` (per path when a function), or none when it is a string, and a holder that lists `entries`, or none when null. */
function cli(reply: Reply | ((path: string, body: unknown) => Reply), entries: SessionEntry[] | null, kill: (session: string) => Promise<number | null> = async () => 0, welcome = CURRENT) {
  const state = { out: '', err: '', posts: [] as unknown[], kills: [] as string[], closed: false, shutdowns: 0, alive: true, exitsOnShutdown: true, shutdownRefused: false, shutdownHangs: false, killedTrees: [] as number[], treeError: null as string | null };
  const holder: HolderControl = {
    welcome,
    list: async () => entries ?? [],
    kill: async (session) => {
      state.kills.push(session);
      return kill(session);
    },
    shutdown: async () => {
      state.shutdowns++;

      if (state.shutdownHangs) {
        return new Promise<void>(() => undefined);
      }

      if (state.shutdownRefused) {
        throw new Error('The terminal holder holds 1 live session.');
      }

      state.alive = !state.exitsOnShutdown;
    },
    close: () => (state.closed = true),
  };
  const deps: HolderCliDeps = {
    post: async (path, body) => {
      state.posts.push({ path, body });
      return typeof reply === 'function' ? reply(path, body) : reply;
    },
    holder: async () => (entries === null ? null : holder),
    alive: () => state.alive,
    killTree: async (pid) => {
      state.killedTrees.push(pid);

      if (state.treeError !== null) {
        return { error: state.treeError };
      }

      state.alive = false;
      return null;
    },
    sleep: async () => {},
    now: () => NOW,
    out: (text) => (state.out += text),
    err: (text) => (state.err += text),
  };

  return { state, run: (...argv: string[]) => runHolder(argv, deps) };
}

describe('held session IDs and labels', () => {
  it('reads the work item key and Claude session ID from a label', () => {
    expect(labelParts(`switchboard · dev:develop · gh 15619 ${CLAUDE}`)).toEqual({ key: 'gh 15619', nativeSessionId: CLAUDE });
    expect(labelParts('adhoc 3 abc')).toEqual({ key: 'adhoc 3', nativeSessionId: 'abc' });
    expect(labelParts('abc')).toEqual({ key: null, nativeSessionId: 'abc' });
    expect(labelParts('')).toEqual({ key: null, nativeSessionId: null });
    expect(labelParts('switchboard ·  abc')).toEqual({ key: null, nativeSessionId: 'abc' });
  });

  it('finds a session by its Switchboard ID, Claude ID, a retired ID or 8 characters of one, never by a Switchboard ID prefix', () => {
    const held = [hubSession('s1', { nativeSessionId: CLAUDE }), hubSession('session-2', { nativeSessionId: 'aaaabbbb-2' })];
    const retired = (one: HeldSession) => (one.session === 's1' ? ['old-id'] : []);

    expect(findHeld(held, 's1', retired)).toBe(held[0]);
    expect(findHeld(held, CLAUDE, retired)).toBe(held[0]);
    expect(findHeld(held, 'old-id', retired)).toBe(held[0]);
    expect(findHeld(held, 'aaaabbbb', retired)).toBe(held[1]);
    expect(findHeld(held, 'session-', retired)).toEqual({ refused: 'No held session session-.', status: 404 });
    expect(findHeld(held, '9273f59', retired)).toEqual({ refused: 'No held session 9273f59.', status: 404 });
    expect(findHeld([...held, hubSession('s3', { nativeSessionId: `${CLAUDE.slice(0, 8)}-x` })], CLAUDE.slice(0, 8))).toEqual({ refused: `${CLAUDE.slice(0, 8)} matches more than one held session: s1, s3.`, status: 409 });
  });
});

describe('hub.js holder (architecture.md § Visibility of held sessions)', () => {
  it('prints idle times in minutes and hours', () => {
    expect([idleText(-5), idleText(59_999), idleText(3 * 60_000), idleText(125 * 60_000)]).toEqual(['0m', '0m', '3m', '2h 5m']);
  });

  it("prints the hub's list as a table, orphans with no work item, exited sessions without idle time", async () => {
    const sessions = [
      hubSession('o1', { orphan: true, key: 'gh 7', nativeSessionId: null }),
      hubSession('s1', { workItemId: 1, state: 'idle', memoryBytes: 300 * 1024 * 1024, clients: 2 }),
      hubSession('s2', { workItemId: 2, key: null, state: 'exited', exitedAt: NOW, idleSince: NOW - 125 * 60_000 }),
    ];
    const { state, run } = cli({ status: 200, error: null, body: { sessions } }, null);

    expect(await run('list')).toBe(0);
    expect(state.posts).toEqual([{ path: '/holder/list', body: {} }]);
    expect(state.out).toBe(
      [
        'Work item     Switchboard ID  Claude ID                             Folder       State   Idle  Memory  Terminals',
        'No work item  o1              -                                     D:/git/widgets  live    3m    -       0',
        `adhoc 1       s1              ${CLAUDE}  D:/git/widgets  idle    3m    300 MB  2`,
        `No work item  s2              ${CLAUDE}  D:/git/widgets  exited  -     -       0`,
        '',
      ].join('\n'),
    );
    expect(heldTable([], NOW)).toBe('No held sessions.\n');
  });

  it("lists the holder's own view while the hub is down, and says when no holder runs", async () => {
    const down = cli('The Switchboard hub is not running', [entry('s1', { lastOutputAt: NOW - 60_000 }), entry('s2', { exitedAt: NOW, exitCode: 1 })]);

    expect(await down.run('list')).toBe(0);
    expect(down.state.out).toBe(
      [
        "The Switchboard hub is not running, so this is the terminal holder's own list.",
        'Work item  Switchboard ID  Claude ID                             Folder       State   Idle  Memory  Terminals',
        `adhoc 1    s1              ${CLAUDE}  D:/git/widgets  live    1m    -       0`,
        `adhoc 1    s2              ${CLAUDE}  D:/git/widgets  exited  -     -       0`,
        '',
      ].join('\n'),
    );
    expect(down.state.closed).toBe(true);

    const none = cli('The Switchboard hub is not running', null);

    expect(await none.run('list')).toBe(0);
    expect(none.state.out).toBe('No terminal holder is running.\n');
  });

  it('stops through the hub, printing its refusal with exit code 3, or 1 for a bad request', async () => {
    const stopped = cli({ status: 200, error: null, body: { stopped: 's1' } }, [entry('s1')]);

    expect(await stopped.run('stop', CLAUDE.slice(0, 8))).toBe(0);
    expect(stopped.state).toMatchObject({ out: 'Stopped held session s1.\n', posts: [{ path: '/holder/stop', body: { id: CLAUDE.slice(0, 8) } }], kills: [] });

    const refused = cli({ status: 404, error: 'No held session nope.', body: null }, [entry('s1')]);

    expect(await refused.run('stop', 'nope')).toBe(3);
    expect(refused.state.err).toBe('Refused: No held session nope.\n');

    const bad = cli({ status: 400, error: null, body: null }, null);

    expect(await bad.run('list')).toBe(1);
    expect(bad.state.err).toBe('Refused: status 400\n');
  });

  it("stops through the holder while the hub is down, by the Switchboard ID or the label's Claude ID or 8 characters of it", async () => {
    for (const id of ['s1', CLAUDE, CLAUDE.slice(0, 8)]) {
      const { state, run } = cli('The Switchboard hub is not running', [entry('s1'), entry('s2', { label: 'switchboard · ad-hoc · adhoc 2 other' })]);

      expect(await run('stop', id)).toBe(0);
      expect(state).toMatchObject({ out: 'Stopped held session s1.\n', kills: ['s1'], closed: true });
    }
  });

  it('refuses through the holder an unknown ID, an ambiguous prefix, an exited session and a failed kill, and exits 2 when nothing answers', async () => {
    const entries = [entry('s1'), entry('s2', { label: `x ${CLAUDE.slice(0, 8)}-other` }), entry('s3', { label: 'x done', exitedAt: NOW })];
    const cases: Array<[string, string]> = [
      ['nope', 'Refused: No held session nope.\n'],
      [CLAUDE.slice(0, 8), `Refused: ${CLAUDE.slice(0, 8)} matches more than one held session: s1, s2.\n`],
      ['s3', 'Refused: Held session s3 has exited.\n'],
    ];

    for (const [id, error] of cases) {
      const { state, run } = cli('The Switchboard hub is not running', entries);

      expect(await run('stop', id)).toBe(3);
      expect(state).toMatchObject({ err: error, kills: [] });
    }

    const failed = cli('The Switchboard hub is not running', entries, async () => Promise.reject(new Error('No session s1 is held.')));

    expect(await failed.run('stop', 's1')).toBe(3);
    expect(failed.state).toMatchObject({ err: 'The terminal holder failed: No session s1 is held.\n', closed: true });

    const nothing = cli('The Switchboard hub (pid 7) did not answer', null);

    expect(await nothing.run('stop', 's1')).toBe(2);
    expect(nothing.state.err).toBe('The Switchboard hub (pid 7) did not answer, and no terminal holder is running.\n');
  });

  it('marks a holder from an older build in the list, from the hub or the holder, and names no current one', async () => {
    const fromHub = cli({ status: 200, error: null, body: { sessions: [], holder: OLDER } }, null);

    expect(await fromHub.run('list')).toBe(0);
    expect(fromHub.state.out).toBe(
      'Terminal holder: pid 34000, build 61663226176fa458, protocol 1; it is from an older build and cannot type into sessions, and `holder stop --all` ends it so the next session starts this build.\nNo held sessions.\n',
    );

    const current = cli({ status: 200, error: null, body: { sessions: [], holder: CURRENT } }, null);

    expect(await current.run('list')).toBe(0);
    expect(current.state.out).toBe('No held sessions.\n');

    const down = cli('The Switchboard hub is not running', [entry('s1')], undefined, OLDER);

    expect(await down.run('list')).toBe(0);
    expect(down.state.out).toMatch(/^The Switchboard hub is not running, so this is the terminal holder's own list\.\nTerminal holder: pid 34000, build 61663226176fa458, protocol 1; it is from an older build .*\nWork item +Switchboard ID/);
  });

  it('stop --all names the holder and the live sessions that end with it, and ends nothing without --yes', async () => {
    const sessions = [hubSession('s1', { workItemId: 1 }), hubSession('s2', { workItemId: 2, state: 'exited', exitedAt: NOW })];
    const { state, run } = cli({ status: 200, error: null, body: { sessions, holder: OLDER } }, [entry('s1')], undefined, OLDER);

    expect(await run('stop', '--all')).toBe(0);
    expect(state.out).toMatch(/^Terminal holder: pid 34000, build 61663226176fa458, protocol 1; it is from an older build[^\n]*\nThis held session ends with it; each can be resumed afterwards:\nWork item +Switchboard ID[^\n]*\nadhoc 1 +s1 [^\n]*\nRun `holder stop --all --yes` to end them and the terminal holder\.\n$/);
    expect(state).toMatchObject({ posts: [{ path: '/holder/list', body: {} }], kills: [], shutdowns: 0, killedTrees: [], closed: true });
  });

  it('stop --all --yes stops each live session through the hub, then asks the holder to exit', async () => {
    const sessions = [hubSession('s1', { workItemId: 1 }), hubSession('o1', { orphan: true })];
    const { state, run } = cli((path, body) => (path === '/holder/list' ? { status: 200, error: null, body: { sessions, holder: OLDER } } : { status: 200, error: null, body: { stopped: (body as { id: string }).id } }), [entry('s1')], undefined, OLDER);

    expect(await run('stop', '--all', '--yes')).toBe(0);
    expect(state.posts).toEqual([
      { path: '/holder/list', body: {} },
      { path: '/holder/stop', body: { id: 's1' } },
      { path: '/holder/stop', body: { id: 'o1' } },
    ]);
    expect(state).toMatchObject({ kills: [], shutdowns: 1, killedTrees: [], err: '' });
    expect(state.out).toContain('Stopped held session s1.\nStopped held session o1.\nEnded the terminal holder (pid 34000). The next Code Mode session starts the installed build.\n');
  });

  it('stop --all --yes kills through the holder while the hub is down, and ends its process tree when it does not exit', async () => {
    const { state, run } = cli('The Switchboard hub is not running', [entry('s1'), entry('s2', { exitedAt: NOW })], async () => Promise.reject(new Error('No session s1 is held.')), OLDER);

    state.shutdownRefused = true;

    expect(await run('stop', '--all', '--yes')).toBe(0);
    expect(state).toMatchObject({ kills: ['s1'], shutdowns: 1, killedTrees: [34000], err: 'Held session s1 did not stop: No session s1 is held.\n' });
    expect(state.out).toContain('The terminal holder did not exit, so its process tree was ended.\nEnded the terminal holder (pid 34000).');

    const stuck = cli('The Switchboard hub is not running', [], undefined, OLDER);

    stuck.state.exitsOnShutdown = false;
    stuck.state.treeError = 'Access is denied.';
    expect(await stuck.run('stop', '--all', '--yes')).toBe(3);
    expect(stuck.state.err).toBe('The terminal holder (pid 34000) did not exit and could not be ended: Access is denied.\n');

    // A holder that stops answering `shutdown` is ended after 5 seconds rather than hang the command.
    const silent = cli('The Switchboard hub is not running', [], undefined, OLDER);

    silent.state.shutdownHangs = true;
    vi.useFakeTimers();

    try {
      const running = silent.run('stop', '--all', '--yes');

      await vi.advanceTimersByTimeAsync(5_000);
      expect(await running).toBe(0);
      expect(silent.state.killedTrees).toEqual([34000]);
    } finally {
      vi.useRealTimers();
    }

    const none = cli('The Switchboard hub is not running', null);

    expect(await none.run('stop', '--all', '--yes')).toBe(0);
    expect(none.state.out).toBe('No terminal holder is running.\n');
  });

  it('refuses usage errors with exit code 1 before asking anything', async () => {
    for (const argv of [[], ['list', 'extra'], ['stop'], ['stop', ''], ['stop', 'a', 'b'], ['kill', 's1'], ['stop', '--all', '--no'], ['stop', '--yes']]) {
      const { state, run } = cli({ status: 200, error: null, body: {} }, []);

      expect(await run(...argv)).toBe(1);
      expect(state.err).toContain('Usage:\n  holder list\n  holder stop');
      expect(state.posts).toEqual([]);
    }
  });
});

describe('connectHolder', () => {
  let temp: ReturnType<typeof tempHome>;
  let server: Server | null = null;

  beforeEach(() => {
    temp = tempHome();
    mkdirSync(join(temp.home, '.switchboard'), { recursive: true });
  });

  afterEach(async () => {
    await new Promise<void>((done) => (server === null ? done() : server.close(() => done())));
    server = null;
    temp.remove();
  });

  /** A loopback holder that welcomes as `pid` with protocol 7 and answers `list`. */
  async function holder(pid: number): Promise<number> {
    server = createServer((socket) => {
      socket.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split('\n').filter((one) => one !== '')) {
          const message = JSON.parse(line) as { type: string; id?: number };

          if (message.type === 'hello') {
            socket.write(JSON.stringify({ type: 'welcome', protocol: 7, build: 'old', pid }) + '\n');
          } else if (message.type === 'list') {
            socket.write(JSON.stringify({ type: 'sessions', re: message.id, sessions: [entry('s1')] }) + '\n');
          }
        }
      });
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));

    return (server!.address() as AddressInfo).port;
  }

  const writeRecord = (port: number, pid: number) => writeFileSync(recordPath(join(temp.home, '.switchboard')), JSON.stringify({ protocol: 7, build: 'old', port, token: 't', pid, startedAt: '2026-11-18T00:00:00.000Z' }));

  it('lists through a holder of another protocol whose pid matches the record', async () => {
    writeRecord(await holder(4243), 4243);

    const control = await connectHolder(join(temp.home, '.switchboard'));

    expect(await control!.list()).toEqual([entry('s1')]);
    control!.close();
  });

  it('answers null without a record, for a record that does not parse, for another pid and for a closed port', async () => {
    expect(await connectHolder(join(temp.home, '.switchboard'))).toBeNull();

    writeFileSync(recordPath(join(temp.home, '.switchboard')), '{');
    expect(await connectHolder(join(temp.home, '.switchboard'))).toBeNull();

    const port = await holder(1);

    writeRecord(port, 4243);
    expect(await connectHolder(join(temp.home, '.switchboard'))).toBeNull();

    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
    expect(await connectHolder(join(temp.home, '.switchboard'))).toBeNull();
  });
});
