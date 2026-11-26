import { afterEach, describe, expect, it } from 'vitest';
import { Attachment, HolderClient, Viewer } from '../src/client.js';
import { Raw, TOKEN, startHost, until } from './fakes.js';
import type { TestHost } from './fakes.js';
import type { Pty } from '../src/host.js';

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

describe('ending a session by closing its terminal', () => {
  /** A close that the program answers by exiting with 129 after `exitAfterMs`, or never when null. */
  function closer(state: { current: TestHost | null }, exitAfterMs: number | null, closes: number[]): (pty: Pty) => boolean {
    return (pty) => {
      closes.push(pty.pid);

      if (exitAfterMs !== null) {
        setTimeout(() => state.current!.ptys.find((one) => one.pid === pty.pid)!.exit(129), exitAfterMs);
      }

      return true;
    };
  }

  it('answers with the exit code of a program that exits after its terminal closed, without a tree kill', async () => {
    const ref: { current: TestHost | null } = { current: null };
    const closes: number[] = [];
    const logs: string[] = [];

    ref.current = await started({ closePty: closer(ref, 50, closes), closeGraceMs: 2_000, log: (message) => logs.push(message) });

    const client = await HolderClient.connect({ port: ref.current.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    expect(await client.kill('s1')).toBe(129);
    expect(closes).toEqual([1000]);
    expect(ref.current.killed).toEqual([]);
    expect(logs).toEqual([]);
    client.close();
  });

  it('stops passing input and sizes once the terminal is closed', async () => {
    const ref: { current: TestHost | null } = { current: null };
    const closes: number[] = [];

    ref.current = await started({ closePty: closer(ref, 300, closes), closeGraceMs: 2_000 });

    const client = await HolderClient.connect({ port: ref.current.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));

    const raw = await Raw.ready(ref.current.port);

    raw.send({ type: 'attach', session: 's1', cols: 100, rows: 30 });
    await raw.until((m) => m.type === 'replayed');

    const killed = client.kill('s1');

    // The terminal is closing; the program exits 300 ms later.
    await until(() => expect(closes).toEqual([1000]));
    raw.send({ type: 'resize', cols: 90, rows: 20 });
    raw.send({ type: 'input', data: 'typed' });
    expect(await killed).toBe(129);
    expect(ref.current.ptys[0]!.writes).toEqual([]);
    expect(ref.current.ptys[0]!.sizes).toEqual([]);
    raw.socket.destroy();
    client.close();
  });

  it('kills the process tree of a program that does not exit within the grace time after its terminal closed', async () => {
    const ref: { current: TestHost | null } = { current: null };
    const closes: number[] = [];
    const logs: string[] = [];

    ref.current = await started({ closePty: closer(ref, null, closes), closeGraceMs: 100, log: (message) => logs.push(message) });

    const client = await HolderClient.connect({ port: ref.current.port, token: TOKEN });
    const startedAt = Date.now();

    await client.spawn(spawnRequest('s1'));
    expect(await client.kill('s1')).toBe(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
    expect(closes).toEqual([1000]);
    expect(ref.current.killed).toEqual([1000]);
    expect(logs).toEqual(['Session s1 did not exit within 0.1 seconds of its terminal closing; ending its process tree.']);
    client.close();
  });

  it('kills the process tree at once when the terminal cannot be closed, or its close throws', async () => {
    const logs: string[] = [];
    const state = await started({ closePty: () => false, closeGraceMs: 10_000, log: (message) => logs.push(message) });
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    expect(await client.kill('s1')).toBe(1);
    expect(state.killed).toEqual([1000]);
    expect(logs).toEqual(['The terminal of session s1 cannot be closed; ending its process tree.']);
    client.close();

    const throwing = await startHost({
      closePty: () => {
        throw new Error('Usage: pty.kill(id, useConptyDll)');
      },
      closeGraceMs: 10_000,
      log: (message) => logs.push(message),
    });
    const other = await HolderClient.connect({ port: throwing.port, token: TOKEN });

    await other.spawn(spawnRequest('s1'));
    expect(await other.kill('s1')).toBe(1);
    expect(throwing.killed).toEqual([1000]);
    expect(logs.slice(1)).toEqual(['The terminal of session s1 could not be closed: Usage: pty.kill(id, useConptyDll)', 'The terminal of session s1 cannot be closed; ending its process tree.']);
    other.close();
    await throwing.host.close();
  });

  it('closes the terminal once when two kills overlap, and the second waits for the same exit', async () => {
    const ref: { current: TestHost | null } = { current: null };
    const closes: number[] = [];

    ref.current = await started({ closePty: closer(ref, 100, closes), closeGraceMs: 2_000 });

    const client = await HolderClient.connect({ port: ref.current.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    expect(await Promise.all([client.kill('s1'), client.kill('s1')])).toEqual([129, 129]);
    expect(closes).toEqual([1000]);
    expect(ref.current.killed).toEqual([]);
    client.close();
  });

  it('answers late when the deadline passes during the grace time', async () => {
    const ref: { current: TestHost | null } = { current: null };

    ref.current = await started({ closePty: closer(ref, null, []), closeGraceMs: 5_000, killDeadlineMs: 100 });

    const client = await HolderClient.connect({ port: ref.current.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    await expect(client.kill('s1')).rejects.toThrow('Session s1 did not exit within 0.1 seconds.');
    expect(ref.current.killed).toEqual([]);
    client.close();
  });

  it('ends every live session on endAll, and logs one that does not end', async () => {
    const ref: { current: TestHost | null } = { current: null };
    const closes: number[] = [];
    const logs: string[] = [];

    ref.current = await started({ closePty: closer(ref, 20, closes), closeGraceMs: 2_000, log: (message) => logs.push(message) });

    const client = await HolderClient.connect({ port: ref.current.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    await client.spawn(spawnRequest('s2'));
    await client.spawn(spawnRequest('s3'));
    ref.current.ptys[2]!.exit(0);
    await ref.current.host.endAll();
    expect(closes).toEqual([1000, 1001]);
    expect(ref.current.host.live()).toBe(0);
    expect(logs).toEqual([]);
    client.close();

    const failing = await startHost({ closePty: () => false, killTree: () => Promise.resolve({ error: 'Access is denied.' }), log: (message) => logs.push(message) });
    const other = await HolderClient.connect({ port: failing.port, token: TOKEN });

    await other.spawn(spawnRequest('s1'));
    await failing.host.endAll();
    await expect(other.spawn(spawnRequest('s2'))).rejects.toThrow('The terminal holder is exiting.');
    expect(failing.ptys).toHaveLength(1);
    expect(logs).toEqual(['The terminal of session s1 cannot be closed; ending its process tree.', 'Session s1 could not be ended: Access is denied.']);
    other.close();
    await failing.host.close();
  });
});

describe('snapshot', () => {
  it('serializes the screen with its colours and the asked scrollback, with a revision that rises on output, input and resize', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 20, rows: 3 }));
    state.ptys[0]!.emit('alpha\r\nbeta\r\ngamma\r\n\u001b[32m● done\u001b[0m');

    const first = await client.snapshot('s1', 0);

    expect(first).toMatchObject({ cols: 20, rows: 3, rev: 1 });
    // The green colour is kept, and the line scrolled off the screen is left out without scrollback.
    expect(first.data).toContain('\u001b[32m● done');
    expect(first.data).not.toContain('alpha');
    expect((await client.snapshot('s1', 10)).data).toContain('alpha');

    const raw = await Raw.ready(state.port);

    raw.send({ type: 'attach', session: 's1', cols: 30, rows: 3 });
    await raw.until((m) => m.type === 'replayed');
    raw.send({ type: 'input', data: 'x' });
    // The attach resized the terminal and the client typed.
    await until(async () => expect((await client.snapshot('s1', 0)).rev).toBe(3));
    raw.socket.destroy();
    client.close();
  });

  it('answers an unknown session with an error and keeps the connection', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await expect(client.snapshot('nope', 0)).rejects.toThrow('No session nope is held.');
    expect(await client.list()).toEqual([]);
    client.close();
  });

  it('closes the connection on a scrollback out of range', async () => {
    const { port } = await started();
    const raw = await Raw.ready(port);

    raw.send({ type: 'snapshot', id: 1, session: 's1', scrollback: 10_001 });
    await raw.untilClosed();
    expect(raw.messages.at(-1)).toEqual({ type: 'error', message: 'Invalid snapshot message.' });
  });

  it('is refused by the client, without a request, to a holder that does not name it', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    client.welcome = { ...client.welcome, features: [] };
    await expect(client.snapshot('s1', 0)).rejects.toThrow('The terminal holder does not serve snapshots; it is from an older build.');
    expect(await client.list()).toEqual([]);
    client.close();
  });
});

describe('write', () => {
  it('types into a session without attaching: no resize, no client, a new revision and lastInputAt, but no keyAt', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 20, rows: 3 }));
    expect(await client.write('s1', '\u001b[200~hello\u001b[201~')).toEqual({ rev: 1 });
    expect(await client.write('s1', '\r')).toEqual({ rev: 2 });
    expect(state.ptys[0]!.writes).toEqual(['\u001b[200~hello\u001b[201~', '\r']);
    expect(state.ptys[0]!.sizes).toEqual([]);

    const [entry] = await client.list();

    expect(entry).toMatchObject({ clients: 0, lastInputAt: expect.any(Number) });
    expect(await client.snapshot('s1', 0)).toMatchObject({ rev: 2, keyAt: null, cols: 20, rows: 3 });

    // A key typed in an attached terminal sets keyAt.
    const raw = await Raw.ready(state.port);

    raw.send({ type: 'attach', session: 's1', cols: 20, rows: 3 });
    await raw.until((m) => m.type === 'replayed');
    raw.send({ type: 'input', data: 'x' });
    await until(async () => expect((await client.snapshot('s1', 0)).keyAt).toEqual(expect.any(Number)));
    raw.socket.destroy();
    client.close();
  });

  it('refuses an unknown or ended session and keeps the connection', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await expect(client.write('nope', 'x')).rejects.toMatchObject({ message: 'No session nope is held.', refused: true });
    await client.spawn(spawnRequest('s1'));
    state.ptys[0]!.exit(0);
    await expect(client.write('s1', 'x')).rejects.toThrow('Session s1 has ended.');
    expect(state.ptys[0]!.writes).toEqual([]);
    expect((await client.list()).map((entry) => entry.session)).toEqual(['s1']);
    client.close();
  });

  it('closes the connection on empty data', async () => {
    const { port } = await started();
    const raw = await Raw.ready(port);

    raw.send({ type: 'write', id: 1, session: 's1', data: '' });
    await raw.untilClosed();
    expect(raw.messages.at(-1)).toEqual({ type: 'error', message: 'Invalid write message.' });
  });

  it('is refused by the client, without a request, to a holder that does not name it', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    client.welcome = { ...client.welcome, features: ['snapshot'] };
    await expect(client.write('s1', 'x')).rejects.toThrow('The terminal holder cannot type into sessions; it is from an older build.');
    expect(state.ptys[0]!.writes).toEqual([]);
    client.close();
  });
});

describe('view', () => {
  async function viewOf(state: TestHost, session: string) {
    const events: Array<string | [number, number]> = [];
    const exits: Array<number | null> = [];
    let replayed = false;
    const viewer = await Viewer.open({
      port: state.port,
      token: TOKEN,
      session,
      onSize: (cols, rows) => events.push([cols, rows]),
      onData: (data) => events.push(data),
      onReplayed: () => (replayed = true),
      onExit: (code) => exits.push(code),
    });

    return { viewer, events, exits, isReplayed: () => replayed };
  }

  it("replays the screen at the program's size without resizing it or counting a client, then streams output and each resize in order", async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 80, rows: 24 }));
    state.ptys[0]!.emit('hello');

    const one = await viewOf(state, 's1');

    await until(() => expect(one.isReplayed()).toBe(true));
    expect(one.events[0]).toEqual([80, 24]);
    expect(String(one.events[1])).toContain('hello');
    expect(state.ptys[0]!.sizes).toEqual([]);
    expect((await client.list())[0]).toMatchObject({ clients: 0 });

    state.ptys[0]!.emit('old size');
    const attached = await Attachment.open({ port: state.port, token: TOKEN, session: 's1', cols: 120, rows: 40, onData: () => undefined });

    await until(() => expect(one.events.at(-1)).toEqual([120, 40]));
    state.ptys[0]!.emit('new size');
    await until(() => expect(one.events.slice(-3)).toEqual(['old size', [120, 40], 'new size']));
    attached.close();
    one.viewer.close();
    client.close();
  });

  it('sends a resize that comes while the replay is prepared after the replay, in its place among the output', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 80, rows: 24 }));

    const raw = await Raw.ready(state.port);

    raw.send({ type: 'view', session: 's1' });
    state.ptys[0]!.emit('a');
    await client.size('s1', 100, 30);
    state.ptys[0]!.emit('b');
    await raw.until((m) => m.type === 'output' && m.data === 'b');

    const shown = raw.messages.slice(1).filter((m) => m.type !== 'replay').map((m) => (m.type === 'resized' ? [m.cols, m.rows] : m.type === 'output' ? m.data : m.type));

    // 'a' is in the replay or after it, depending on when the view was read; either way before the resize and 'b'.
    expect(shown.filter((one) => one !== 'a')).toEqual([[80, 24], 'replayed', [100, 30], 'b']);
    expect(shown.indexOf('a')).toBeLessThan(shown.findIndex((one) => Array.isArray(one) && one[0] === 100));
    expect(raw.messages.filter((m) => m.type === 'replay').map((m) => m.data as string).join('') + shown.join(' ')).toContain('a');
    raw.socket.destroy();
    client.close();
  });

  it('closes a viewer that sends input or a resize, and passes neither', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));

    for (const message of [{ type: 'input', data: 'x' }, { type: 'resize', cols: 10, rows: 10 }]) {
      const raw = await Raw.ready(state.port);

      raw.send({ type: 'view', session: 's1' });
      await raw.until((m) => m.type === 'replayed');
      raw.send(message);
      await raw.untilClosed();
      expect(raw.messages.at(-1)).toEqual({ type: 'error', message: `A viewing client cannot send ${message.type}.` });
    }

    expect(state.ptys[0]!.writes).toEqual([]);
    expect(state.ptys[0]!.sizes).toEqual([]);
    client.close();
  });

  it('tells a viewer that the program exited, and refuses a session it does not hold', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));

    const one = await viewOf(state, 's1');

    await until(() => expect(one.isReplayed()).toBe(true));
    state.ptys[0]!.exit(3);
    await until(() => expect(one.exits).toEqual([3]));

    const raw = await Raw.ready(state.port);

    raw.send({ type: 'view', session: 'nope' });
    await raw.untilClosed();
    expect(raw.messages.at(-1)).toEqual({ type: 'error', message: 'No session nope is held.' });
    client.close();
  });

  it('is refused by the client to a holder that does not name it', async () => {
    const state = await started({ protocol: 2 });

    await expect(Viewer.open({ port: state.port, token: TOKEN, session: 's1', onSize: () => undefined, onData: () => undefined })).rejects.toThrow('The terminal holder speaks protocol 2, not 1.');
  });
});

describe('view limits', () => {
  it('drops a viewer whose replay is read slowly while the output queued behind it passes the limit, and keeps the session', async () => {
    const state = await started({ clientQueueBytes: 4096 });
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 400, rows: 30 }));

    // A replay of megabytes, which the paused reader leaves waiting on the socket.
    for (let line = 0; line < 10_000; line++) {
      state.ptys[0]!.emit(`line ${line} ${'x'.repeat(380)}\r\n`);
    }

    const raw = await Raw.ready(state.port);

    raw.socket.pause();
    raw.send({ type: 'view', session: 's1' });
    expect(state.host.connections()).toBe(2);
    // Output before the host reads the view joins the replay; output after it queues behind the replay until the queue passes the limit.
    await until(() => {
      state.ptys[0]!.emit('y'.repeat(3000));
      expect(state.host.connections()).toBe(1);
    });
    raw.socket.resume();
    await raw.untilClosed();
    expect(raw.messages.some((m) => m.type === 'replayed')).toBe(false);
    expect((await client.list())[0]).toMatchObject({ exitedAt: null });
    client.close();
  });
});

describe('size', () => {
  it('resizes a session without attaching, and refuses an unknown or ended one', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 80, rows: 24 }));
    expect(await client.size('s1', 100, 30)).toEqual({ rev: 1 });
    expect(state.ptys[0]!.sizes).toEqual([[100, 30]]);
    expect((await client.list())[0]).toMatchObject({ clients: 0 });
    await expect(client.size('nope', 100, 30)).rejects.toMatchObject({ message: 'No session nope is held.', refused: true });
    state.ptys[0]!.exit(0);
    await expect(client.size('s1', 90, 30)).rejects.toThrow('Session s1 has ended.');
    client.welcome = { ...client.welcome, features: ['snapshot', 'write'] };
    await expect(client.size('s1', 90, 30)).rejects.toThrow('it is from an older build');
    client.close();
  });

  it('closes the connection on a size out of range', async () => {
    const { port } = await started();
    const raw = await Raw.ready(port);

    raw.send({ type: 'size', id: 1, session: 's1', cols: 0, rows: 30 });
    await raw.untilClosed();
    expect(raw.messages.at(-1)).toEqual({ type: 'error', message: 'Invalid size message.' });
  });
});

describe('write with key', () => {
  it('sets keyAt for a key typed in a terminal, and leaves it for other writes', async () => {
    const state = await started({ now: () => 7000 });
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    await client.write('s1', 'x');
    expect((await client.snapshot('s1', 0)).keyAt).toBeNull();
    await client.write('s1', 'y', true);
    expect((await client.snapshot('s1', 0)).keyAt).toBe(7000);
    expect(state.ptys[0]!.writes).toEqual(['x', 'y']);
    client.close();
  });
});
