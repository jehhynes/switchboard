import { afterEach, describe, expect, it } from 'vitest';
import { Attachment, HolderClient, HolderError, Viewer } from '../src/client.js';
import { Raw, TOKEN, startHost, until } from './fakes.js';
import type { TestHost } from './fakes.js';
import headless from '@xterm/headless';
import { mouseEncoding } from '../src/host.js';
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

describe('attach', () => {
  async function attachTo(state: TestHost, session: string, cols: number, rows: number) {
    const received: string[] = [];
    const exits: Array<number | null> = [];
    const closes: Array<string | null> = [];
    let replayed = false;
    const attachment = await Attachment.open({
      port: state.port,
      token: TOKEN,
      session,
      cols,
      rows,
      onData: (data) => received.push(data),
      onReplayed: () => (replayed = true),
      onExit: (code) => exits.push(code),
      onClose: (error) => closes.push(error === null ? null : error.message),
    });

    return { attachment, received, exits, closes, isReplayed: () => replayed };
  }

  it('resizes to the client, replays the screen, then streams output and passes input', async () => {
    const state = await started({ now: () => 9000 });
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 80, rows: 24 }));
    state.ptys[0]!.emit('hello \u001b[1mworld\u001b[0m\r\n');

    const one = await attachTo(state, 's1', 120, 40);

    await until(() => expect(one.isReplayed()).toBe(true));
    expect(state.ptys[0]!.sizes).toEqual([[120, 40]]);
    expect(one.received.join('')).toContain('hello \u001b[1mworld');
    state.ptys[0]!.emit('more');
    one.attachment.input('\u001b[200~pasted\u001b[201~\r');
    await until(() => expect(state.ptys[0]!.writes).toEqual(['\u001b[200~pasted\u001b[201~\r']));
    await until(() => expect(one.received.at(-1)).toBe('more'));
    expect((await client.list())[0]).toMatchObject({ clients: 1, lastInputAt: 9000, lastOutputAt: 9000 });
    one.attachment.close();
    client.close();
  });

  it('lets the later client set the size, and the client that types take it back', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 80, rows: 24 }));

    const wide = await attachTo(state, 's1', 120, 40);

    await until(() => expect(wide.isReplayed()).toBe(true));

    const narrow = await attachTo(state, 's1', 80, 30);

    await until(() => expect(narrow.isReplayed()).toBe(true));
    state.ptys[0]!.emit('to both');
    wide.attachment.input('k');
    await until(() => expect(state.ptys[0]!.writes).toEqual(['k']));
    expect(state.ptys[0]!.sizes).toEqual([[120, 40], [80, 30], [120, 40]]);
    await until(() => expect([wide.received.at(-1), narrow.received.at(-1)]).toEqual(['to both', 'to both']));
    narrow.attachment.resize(90, 30);
    await until(() => expect(state.ptys[0]!.sizes.at(-1)).toEqual([90, 30]));
    wide.attachment.close();
    narrow.attachment.close();
    client.close();
  });

  it('tells an attached client that the program exited and closes it', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));

    const one = await attachTo(state, 's1', 100, 30);

    await until(() => expect(one.isReplayed()).toBe(true));
    state.ptys[0]!.emit('bye\r\n');
    state.ptys[0]!.exit(2);
    await until(() => expect(one.closes).toEqual([null]));
    expect(one.exits).toEqual([2]);
    expect(one.received.at(-1)).toBe('bye\r\n');
    client.close();
  });

  it('replays mouse tracking with the encoding the program set, and none once the program turned it off, into a terminal left with other modes', async () => {
    const cases: Array<[string, string, string]> = [
      ['\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1015h\u001b[?1006h', 'any', 'SGR'],
      ['\u001b[?1002h\u001b[?1016h', 'drag', 'SGR_PIXELS'],
      ['\u001b[?1003h\u001b[?1006h\u001b[?1006l', 'any', 'DEFAULT'],
      ['\u001b[?1003h\u001b[?1006h\u001b[?1003l\u001b[?1006l', 'none', 'DEFAULT'],
    ];
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    for (const [index, [modes, tracking, encoding]] of cases.entries()) {
      await client.spawn(spawnRequest(`s${index}`));
      state.ptys[index]!.emit(`screen${modes}`);

      const one = await attachTo(state, `s${index}`, 100, 30);

      await until(() => expect(one.isReplayed()).toBe(true));

      const terminal = new headless.Terminal({ cols: 100, rows: 30, allowProposedApi: true });

      // A terminal the attach client reused after another program turned on any-event tracking, SGR pixels and focus reports.
      await new Promise<void>((resolve) => terminal.write('\u001b[?1003h\u001b[?1016h\u001b[?1004h', resolve));
      await new Promise<void>((resolve) => terminal.write(one.received.join(''), resolve));
      expect(terminal.modes.sendFocusMode).toBe(false);
      expect([terminal.modes.mouseTrackingMode, (terminal as unknown as { _core: { coreMouseService: { activeEncoding: string } } })._core.coreMouseService.activeEncoding]).toEqual([tracking, encoding]);
      terminal.dispose();
      one.attachment.close();
    }

    client.close();
  });

  it('turns mouse tracking off after the replay when the encoding cannot be read', () => {
    expect(mouseEncoding({ modes: { mouseTrackingMode: 'any' } })).toBe('\u001b[?1003l');
    expect(mouseEncoding({ modes: { mouseTrackingMode: 'vt200' }, _core: { coreMouseService: { activeEncoding: 'URXVT' } } } as never)).toBe('\u001b[?1000l');
    expect(mouseEncoding({ modes: { mouseTrackingMode: 'none' } })).toBe('');
  });

  it('replays the last screen and the exit code to a client attaching after the exit, and ignores its input', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    state.ptys[0]!.emit('last words');
    state.ptys[0]!.exit(5);

    const late = await attachTo(state, 's1', 100, 30);

    late.attachment.input('typed after the exit');
    // The host closes the attachment after the exit, so the input before it was read and ignored.
    await until(() => expect(late.closes).toEqual([null]));
    expect(late.received.join('')).toContain('last words');
    expect(late.exits).toEqual([5]);
    expect(state.ptys[0]!.sizes).toEqual([]);
    expect(state.ptys[0]!.writes).toEqual([]);
    client.close();
  });

  it('refuses to attach to a session it does not hold', async () => {
    const state = await started();
    const one = await attachTo(state, 'nope', 100, 30);

    await until(() => expect(one.closes).toEqual(['No session nope is held.']));
  });

  it('sends a replay over 512 KiB as several replay messages in order, each line under 1 MiB, at the pace the client reads', async () => {
    // A queue limit far below the replay's size: the replay waits for the client instead of dropping it.
    const state = await started({ clientQueueBytes: 64 * 1024 });
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 100, rows: 30 }));

    for (let line = 0; line < 6000; line++) {
      state.ptys[0]!.emit(`\u001b[3${line % 8}m${String(line).padStart(5, '0')} ${'x'.repeat(90)}\u001b[0m\r\n`);
    }

    const raw = await Raw.ready(state.port);

    raw.send({ type: 'attach', session: 's1', cols: 100, rows: 30 });
    await raw.until((m) => m.type === 'replayed');

    const replays = raw.messages.filter((m) => m.type === 'replay');
    const replay = replays.map((m) => m.data as string).join('');

    expect(replays.length).toBeGreaterThan(1);

    for (const message of replays) {
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(1024 * 1024);
    }

    expect(replay).toContain('00000 ');
    expect(replay).toContain('05999 ');
    expect(replay.indexOf('01000 ')).toBeLessThan(replay.indexOf('02000 '));
    raw.socket.destroy();
    client.close();
  });

  it('sends output that arrives while the replay is prepared after the replay', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 80, rows: 24 }));
    state.ptys[0]!.emit('before');
    state.ptys[0]!.onResize = (pty) => queueMicrotask(() => pty.emit('redrawn'));

    const raw = await Raw.ready(state.port);

    raw.send({ type: 'attach', session: 's1', cols: 100, rows: 30 });
    await raw.until((m) => m.type === 'output');

    const types = raw.messages.slice(1).map((m) => m.type);

    expect(types.indexOf('replayed')).toBeLessThan(types.indexOf('output'));
    expect(raw.messages.filter((m) => m.type === 'replay').map((m) => m.data as string).join('')).not.toContain('redrawn');
    expect(raw.messages.find((m) => m.type === 'output')).toEqual({ type: 'output', data: 'redrawn' });
    raw.socket.destroy();
    client.close();
  });

  it('resizes the screen after the output already queued, which was drawn at the old size', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 80, rows: 5 }));
    // Output that arrives with the attach, before it is parsed: a mark at column 70 of an 80-column screen.
    state.ptys[0]!.onResize = (pty) => pty.emit('\u001b[1;70HX');

    const one = await attachTo(state, 's1', 40, 5);

    await until(() => expect(one.isReplayed()).toBe(true));

    const screen = await client.screen('s1');

    // Drawn at 80 columns, the mark lies past the 40 columns the screen shrinks to; drawn at 40, it would end the first row.
    expect(screen.text.split('\n')[0]).toBe('');
    one.attachment.close();
    client.close();
  });

  it('answers a kill whose tree kill never returns once the deadline passes', async () => {
    const state = await started({ killTree: () => new Promise(() => undefined), killDeadlineMs: 50 });
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    await expect(client.kill('s1')).rejects.toThrow('Session s1 did not exit within 0.05 seconds.');
    client.close();
  });

  it('answers a screen reply over 1 MiB, and refuses a label over 1000 characters', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 1000, rows: 1000 }));
    state.ptys[0]!.emit('é'.repeat(1000 * 999));
    expect((await client.screen('s1')).text.length).toBeGreaterThan(999_000);
    await expect(client.spawn(spawnRequest('s2', { label: 'l'.repeat(1001) }))).rejects.toThrow('Invalid spawn message.');
  });

  it('lists the process tree of a live session from the tree reader', async () => {
    const state = await started({ tree: (pid) => [{ pid, created: '7' }, { pid: pid + 1, created: '8' }] });
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    await client.spawn(spawnRequest('s2'));
    state.ptys[1]!.exit(0);

    const list = await client.list();

    expect(list[0]!.tree).toEqual([{ pid: 1000, created: '7' }, { pid: 1001, created: '8' }]);
    expect(list[1]!.tree).toBeUndefined();
    client.close();
  });

  it('drops a client whose queued output passes the limit, and keeps the session and other clients', async () => {
    const state = await started({ clientQueueBytes: 64 * 1024 });
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));

    const slow = await Raw.ready(state.port);

    slow.send({ type: 'attach', session: 's1', cols: 100, rows: 30 });
    await slow.until((m) => m.type === 'replayed');
    slow.socket.pause();

    const fast = await attachTo(state, 's1', 100, 30);

    await until(() => expect(fast.isReplayed()).toBe(true));

    // Fill the paused client's kernel buffer, whose size differs by platform, while the reader keeps up.
    let bytes = 0;

    await expect.poll(async () => {
      for (let index = 0; index < 10; index++) {
        state.ptys[0]!.emit('y'.repeat(4096));
        bytes += 4096;
      }

      await expect.poll(() => fast.received.join('').length).toBeGreaterThanOrEqual(bytes);
      return (await client.list())[0]?.clients;
    }, { timeout: 15_000 }).toBe(1);
    expect((await client.list())[0]).toMatchObject({ clients: 1, exitedAt: null });
    fast.attachment.close();
    slow.socket.destroy();
    client.close();
  }, 20_000);
});

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
    // The replay has started to arrive, so the output below queues behind it.
    await until(() => expect(raw.socket.readableLength).toBeGreaterThan(0));
    state.ptys[0]!.emit('y'.repeat(3000));
    state.ptys[0]!.emit('z'.repeat(3000));
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
