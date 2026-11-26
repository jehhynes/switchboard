import { afterEach, describe, expect, it } from 'vitest';
import { Attachment, HolderClient, HolderError } from '../src/client.js';
import { Raw, TOKEN, startHost, until } from './fakes.js';
import type { TestHost } from './fakes.js';

let current: TestHost | null = null;

afterEach(async () => {
  await current?.host.close();
  current = null;
});

async function started(options: Parameters<typeof startHost>[0] = {}): Promise<TestHost> {
  current = await startHost(options);

  return current;
}

const spawnRequest = (session: string, extra: Record<string, unknown> = {}) => ({ session, label: `label-${session}`, file: 'claude', args: ['--session-id', session], cwd: 'D:/work', env: { A: '1' }, cols: 100, rows: 30, ...extra });

describe('handshake', () => {
  it('welcomes a client with the right token with the protocol, build and pid', async () => {
    const { port } = await started();
    const client = await HolderClient.connect({ port, token: TOKEN });

    expect(client.welcome).toEqual({ protocol: 1, build: 'build-1', pid: 4242, features: ['snapshot', 'write', 'view'] });
    client.close();
  });

  it('allows only list, kill and shutdown, and no attach, to a holder of another protocol', async () => {
    const state = await started({ protocol: 2 });
    const { port } = state;
    const current = await HolderClient.connect({ port, token: TOKEN });

    // A session the other version spawned, which this client can still list and stop.
    current.welcome = { ...current.welcome, protocol: 1 };
    await current.spawn(spawnRequest('s1'));
    current.close();

    const client = await HolderClient.connect({ port, token: TOKEN });

    expect(client.compatible).toBe(false);
    expect((await client.list()).map((entry) => entry.session)).toEqual(['s1']);
    await expect(client.spawn(spawnRequest('s2'))).rejects.toThrow('The terminal holder speaks protocol 2, not 1.');
    await expect(client.screen('s1')).rejects.toThrow('The terminal holder speaks protocol 2, not 1.');
    expect(await client.kill('s1')).toBe(1);
    await client.shutdown();
    await expect(Attachment.open({ port, token: TOKEN, session: 's1', cols: 80, rows: 24, onData: () => undefined })).rejects.toThrow('The terminal holder speaks protocol 2, not 1.');
    client.close();
  });

  it('refuses a wrong token and closes the connection', async () => {
    const { port } = await started();

    await expect(HolderClient.connect({ port, token: 'b'.repeat(64) })).rejects.toThrow('Wrong token.');
  });

  it('cuts off a refused peer that keeps its side of the connection open', async () => {
    const state = await started();
    const raw = await Raw.open(state.port, true);

    raw.send({ type: 'hello', token: 'wrong' });
    await raw.until((m) => m.type === 'error');
    expect(state.host.connections()).toBe(1);
    await until(() => expect(state.host.connections()).toBe(0));
    expect(raw.messages).toEqual([{ type: 'error', message: 'Wrong token.' }]);
    raw.socket.destroy();
  });

  it('refuses a first message that is not hello', async () => {
    const { port } = await started();
    const raw = await Raw.open(port);

    raw.send({ type: 'list', id: 1 });
    await raw.untilClosed();
    expect(raw.messages).toEqual([{ type: 'error', message: 'The first message must be hello.' }]);
  });

  it('closes a connection that sends no hello within the deadline', async () => {
    const { port } = await started({ helloDeadlineMs: 100 });
    const raw = await Raw.open(port);

    await raw.untilClosed();
    expect(raw.messages).toEqual([{ type: 'error', message: 'No hello within the deadline.' }]);
  });

  it('closes a connection on a malformed message, an unknown type and a line over 1 MiB', async () => {
    const { port } = await started();

    for (const [line, error] of [
      ['not json', 'The message is not JSON.'],
      ['{"type":"teleport"}', 'Unknown message type "teleport".'],
      ['x'.repeat(1024 * 1024 + 1), 'The message is too long.'],
    ] as const) {
      const raw = await Raw.ready(port);

      raw.socket.write(line + '\n');
      await raw.untilClosed();
      expect(raw.messages.at(-1)).toEqual({ type: 'error', message: error });
    }
  });

  it('refuses a control request from an attached client', async () => {
    const { port } = await started();
    const client = await HolderClient.connect({ port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));

    const raw = await Raw.ready(port);

    raw.send({ type: 'attach', session: 's1', cols: 100, rows: 30 });
    await raw.until((m) => m.type === 'replayed');
    raw.send({ type: 'list', id: 9 });
    await raw.untilClosed();
    expect(raw.messages.at(-1)).toEqual({ type: 'error', message: 'An attached client cannot send list.' });
    client.close();
  });

  it('refuses input from a client that is not attached', async () => {
    const { port } = await started();
    const raw = await Raw.ready(port);

    raw.send({ type: 'input', data: 'x' });
    await raw.untilClosed();
    expect(raw.messages.at(-1)).toEqual({ type: 'error', message: 'input needs an attached session.' });
  });
});

describe('sessions', () => {
  it('spawns with the given file, arguments, folder, environment and size, and lists the session', async () => {
    const state = await started({ now: () => 5000 });
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    expect(await client.spawn(spawnRequest('s1'))).toEqual({ session: 's1', pid: 1000 });
    expect(state.ptys[0]).toMatchObject({ file: 'claude', args: ['--session-id', 's1'], options: { cwd: 'D:/work', env: { A: '1' }, cols: 100, rows: 30 } });
    expect(await client.list()).toEqual([
      { session: 's1', label: 'label-s1', pid: 1000, cwd: 'D:/work', startedAt: 5000, lastInputAt: null, lastOutputAt: null, exitedAt: null, exitCode: null, clients: 0, memoryBytes: null },
    ]);
    expect(state.live).toEqual([1]);
    client.close();
  });

  it('refuses to spawn a session it holds alive, and replaces one that exited', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    await expect(client.spawn(spawnRequest('s1'))).rejects.toThrow('Session s1 is already held.');
    state.ptys[0]!.exit(0);
    expect(await client.spawn(spawnRequest('s1'))).toEqual({ session: 's1', pid: 1001 });

    const list = await client.list();

    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ pid: 1001, exitedAt: null });
    client.close();
  });

  it('answers a spawn that fails with the reason and holds nothing', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await expect(client.spawn(spawnRequest('s1', { file: 'missing' }))).rejects.toThrow('missing could not be started: File not found');
    expect(await client.list()).toEqual([]);
    client.close();
  });

  it('reports memory from the memory reader for live sessions only', async () => {
    const state = await started({ memory: (pids) => new Map(pids.map((pid) => [pid, pid * 10])) });
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    await client.spawn(spawnRequest('s2'));
    state.ptys[1]!.exit(0);
    expect((await client.list()).map((entry) => entry.memoryBytes)).toEqual([10000, null]);
    client.close();
  });

  it('kills the process tree and answers with the exit code once it exited', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    expect(await client.kill('s1')).toBe(1);
    expect(state.killed).toEqual([1000]);
    expect((await client.list())[0]).toMatchObject({ exitCode: 1 });
    expect(state.live).toEqual([1, 0]);
    client.close();
  });

  it('answers a kill of an exited session at once, and refuses an unknown one', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    state.ptys[0]!.exit(3);
    expect(await client.kill('s1')).toBe(3);
    expect(state.killed).toEqual([]);
    await expect(client.kill('nope')).rejects.toThrow('No session nope is held.');
    client.close();
  });

  it('fails a kill whose process does not exit within the deadline, or whose tree kill fails', async () => {
    const state = await started({ exitOnKill: false, killDeadlineMs: 100 });
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    await expect(client.kill('s1')).rejects.toThrow('Session s1 did not exit within 0.1 seconds.');
    client.close();

    const failing = await startHost({ killTree: () => Promise.resolve({ error: 'Access is denied.' }) });
    const other = await HolderClient.connect({ port: failing.port, token: TOKEN });

    await other.spawn(spawnRequest('s1'));
    await expect(other.kill('s1')).rejects.toThrow('Session s1 could not be ended: Access is denied.');
    other.close();
    await failing.host.close();
  });

  it('keeps an exited session for the retention time, then forgets it', async () => {
    const state = await started({ exitRetentionMs: 100 });
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    state.ptys[0]!.exit(0);
    expect((await client.list()).length).toBe(1);
    await until(async () => expect(await client.list()).toEqual([]));
    client.close();
  });

  it('returns the start of the output and the visible screen as text', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 40, rows: 3 }));
    state.ptys[0]!.emit('⚠ Code Mode (experimental) is on\r\n');

    for (let line = 1; line <= 5; line++) {
      state.ptys[0]!.emit(`line ${line}\r\n`);
    }

    const screen = await client.screen('s1');

    expect(screen.head).toBe('⚠ Code Mode (experimental) is on\r\nline 1\r\nline 2\r\nline 3\r\nline 4\r\nline 5\r\n');
    expect(screen.text).toBe('line 4\nline 5\n');
    await expect(client.screen('nope')).rejects.toThrow('No session nope is held.');
    client.close();
  });

  it('keeps only the first 64 Ki characters of output as the head', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    state.ptys[0]!.emit('a'.repeat(60 * 1024));
    state.ptys[0]!.emit('b'.repeat(10 * 1024));

    const { head } = await client.screen('s1');

    expect(head.length).toBe(64 * 1024);
    expect(head.endsWith('b'.repeat(4 * 1024))).toBe(true);
    client.close();
  });

  it('refuses shutdown while a session is live, and accepts it once none is', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    await expect(client.shutdown()).rejects.toThrow('The terminal holder holds 1 live session.');
    expect(state.shutdowns).toBe(0);
    state.ptys[0]!.exit(0);
    await client.shutdown();
    expect(state.shutdowns).toBe(1);
    client.close();
  });

  it('rejects pending and later requests once the connection closes', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });
    const closed: HolderError[] = [];

    client.onClose((error) => closed.push(error));
    await state.host.close();
    await until(() => expect(closed.map((error) => error.message)).toEqual(['The terminal holder closed the connection.']));
    await expect(client.list()).rejects.toThrow('The terminal holder closed the connection.');
    current = null;
  });
});

describe('watch', () => {
  it('streams exits, attaches and detaches to watching clients only', async () => {
    const state = await started();
    const watcher = await HolderClient.connect({ port: state.port, token: TOKEN });
    const other = await HolderClient.connect({ port: state.port, token: TOKEN });
    const unwatched = await Raw.ready(state.port);
    const events: unknown[] = [];

    await watcher.watch((event) => events.push(event));
    await other.spawn(spawnRequest('s1'));

    const attachment = await Attachment.open({ port: state.port, token: TOKEN, session: 's1', cols: 100, rows: 30, onData: () => undefined });

    await until(() => expect(events).toHaveLength(1));
    attachment.close();
    await until(() => expect(events).toHaveLength(2));
    state.ptys[0]!.exit(7);
    await until(() => expect(events).toHaveLength(3));
    expect(events).toEqual([
      { type: 'attached', session: 's1', clients: 1 },
      { type: 'detached', session: 's1', clients: 0 },
      { type: 'exited', session: 's1', exitCode: 7 },
    ]);
    expect(unwatched.messages).toEqual([{ type: 'welcome', protocol: 1, build: 'build-1', pid: 4242, features: ['snapshot', 'write', 'view'] }]);
    unwatched.socket.destroy();
    watcher.close();
    other.close();
  });
});
