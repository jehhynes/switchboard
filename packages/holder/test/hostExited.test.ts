import { afterEach, describe, expect, it, vi } from 'vitest';
import headless from '@xterm/headless';
import { Attachment, HolderClient } from '../src/client.js';
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

describe('an exited session', () => {
  async function attachTo(state: TestHost, session: string, cols: number, rows: number): Promise<{ received: string[]; exits: Array<number | null> }> {
    const received: string[] = [];
    const exits: Array<number | null> = [];

    await Attachment.open({ port: state.port, token: TOKEN, session, cols, rows, onData: (data) => received.push(data), onExit: (code) => exits.push(code) });

    return { received, exits };
  }

  /** What a session serves: its screen, snapshots of several scrollbacks, and the size and replay a viewer gets. */
  async function served(state: TestHost, client: HolderClient, session: string): Promise<unknown> {
    const raw = await Raw.ready(state.port);

    raw.send({ type: 'view', session });
    await raw.until((m) => m.type === 'replayed');
    raw.socket.destroy();

    return {
      screen: await client.screen(session),
      snapshots: await Promise.all([0, 400, 10_000].map((scrollback) => client.snapshot(session, scrollback))),
      view: raw.messages.filter((m) => m.type === 'resized' || m.type === 'replay'),
    };
  }

  /** Lines in colour that scroll 20 lines off a 40×5 screen, a long line that wraps, and SGR mouse reporting. */
  const OUTPUT = Array.from({ length: 24 }, (_, line) => `\u001b[3${line % 8}mline ${line}\u001b[0m ${'wide '.repeat(line % 3 === 0 ? 12 : 1)}\r\n`).join('') + '\u001b[?1000h\u001b[?1006h\u001b[1mbold prompt';

  it.each([
    ['the normal screen', OUTPUT],
    ['the alternate screen', `${OUTPUT}\u001b[?1049h\u001b[44mfull-screen app\r\nsecond row`],
  ])('serves %s, its snapshots and its replay as before the exit, and frees its terminal at the exit', async (_name, output) => {
    // Terminals an earlier test rebuilt are disposed a turn of the event loop after its last answer.
    await new Promise((resolve) => setImmediate(resolve));

    const dispose = vi.spyOn(headless.Terminal.prototype, 'dispose');

    try {
      const state = await started();
      const client = await HolderClient.connect({ port: state.port, token: TOKEN });

      await client.spawn(spawnRequest('s1', { cols: 40, rows: 5 }));
      state.ptys[0]!.emit(output);

      const before = await served(state, client, 's1');

      expect(dispose).not.toHaveBeenCalled();
      state.ptys[0]!.exit(5);
      // The session's terminal is gone before anything asked for the exited screen.
      await until(() => expect(dispose).toHaveBeenCalledTimes(1));
      expect(await served(state, client, 's1')).toEqual(before);
      client.close();
    } finally {
      dispose.mockRestore();
    }
  });

  it('answers another scrollback with the smallest kept snapshot that holds at least as much, and builds no terminal for it', async () => {
    await new Promise((resolve) => setImmediate(resolve));

    const dispose = vi.spyOn(headless.Terminal.prototype, 'dispose');

    try {
      const state = await started();
      const client = await HolderClient.connect({ port: state.port, token: TOKEN });

      await client.spawn(spawnRequest('s1', { cols: 40, rows: 5 }));
      state.ptys[0]!.emit(Array.from({ length: 600 }, (_, line) => `\u001b[3${line % 8}mline ${line}\r\n`).join(''));

      const live = Object.fromEntries(await Promise.all([0, 3, 400, 401, 10_000].map(async (scrollback) => [scrollback, (await client.snapshot('s1', scrollback)).data] as const)));

      state.ptys[0]!.exit(0);
      await until(() => expect(dispose).toHaveBeenCalledTimes(1));
      expect((await client.snapshot('s1', 0)).data).toBe(live[0]);
      expect((await client.snapshot('s1', 3)).data).toBe(live[400]);
      expect((await client.snapshot('s1', 400)).data).toBe(live[400]);
      expect((await client.snapshot('s1', 401)).data).toBe(live[10_000]);
      expect((await client.snapshot('s1', 10_000)).data).toBe(live[10_000]);
      expect(live[3]).not.toBe(live[400]);
      // A terminal built for an answer would be disposed before the answer to a later request.
      await client.list();
      expect(dispose).toHaveBeenCalledTimes(1);
      client.close();
    } finally {
      dispose.mockRestore();
    }
  });

  it('answers a kept size with the snapshot serialized from the terminal, whose cursor a terminal rebuilt from the whole screen moves', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 10, rows: 4 }));
    // Wrapped lines that scroll, a scroll region reset and a cursor restore: rebuilt in a new terminal, the cursor ends a column to the left.
    state.ptys[0]!.emit('\nqrstuvwxyz0123  \n\n\u001b[r\n qrstuvwxyz0123\u001b8 abcdefghijklmnopTOP');

    const before = (await client.snapshot('s1', 0)).data;

    expect(before.endsWith('\u001b[1A\u001b[5C')).toBe(true);
    state.ptys[0]!.exit(0);
    await until(async () => expect((await client.list())[0]?.exitedAt).not.toBeNull());
    expect((await client.snapshot('s1', 0)).data).toBe(before);
    client.close();
  });

  it('tells a client attached at the exit after the output before the exit, and replays it to a client attaching later', async () => {
    const state = await started();
    const client = await HolderClient.connect({ port: state.port, token: TOKEN });

    await client.spawn(spawnRequest('s1', { cols: 40, rows: 5 }));

    const attached = await attachTo(state, 's1', 40, 5);

    // The last output and the exit come together, as from a program that prints and exits.
    state.ptys[0]!.emit('goodbye');
    state.ptys[0]!.exit(2);
    await until(() => expect(attached.exits).toEqual([2]));
    expect(attached.received.join('')).toContain('goodbye');
    expect((await client.screen('s1')).text).toContain('goodbye');

    const late = await attachTo(state, 's1', 80, 24);

    await until(() => expect(late.exits).toEqual([2]));
    expect(late.received.join('')).toContain('goodbye');
    client.close();
  });
});
