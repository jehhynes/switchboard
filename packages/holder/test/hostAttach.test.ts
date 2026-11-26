import { afterEach, describe, expect, it } from 'vitest';
import { Attachment, HolderClient } from '../src/client.js';
import { Raw, TOKEN, startHost, until } from './fakes.js';
import type { TestHost } from './fakes.js';
import headless from '@xterm/headless';
import { mouseEncoding } from '../src/host.js';

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
