import { afterEach, describe, expect, it, vi } from 'vitest';
import headless from '@xterm/headless';
import { HolderClient } from '../src/client.js';
import { Raw, TOKEN, startHost } from './fakes.js';
import type { TestHost } from './fakes.js';

let current: TestHost | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await current?.host.close();
  current = null;
});

const spawnRequest = (session: string) => ({ session, label: `label-${session}`, file: 'claude', args: [], cwd: 'D:/work', env: {}, cols: 40, rows: 5 });

describe('reading a screen', () => {
  it('answers a screen, snapshot and view without waiting on the terminal when no output or resize is being parsed', async () => {
    current = await startHost();

    const client = await HolderClient.connect({ port: current.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    current.ptys[0]!.emit('ready');
    // This read waits for the output; the ones after it have nothing to wait for.
    expect((await client.screen('s1')).text).toContain('ready');

    const write = vi.spyOn(headless.Terminal.prototype, 'write');

    expect((await client.snapshot('s1', 0)).data).toContain('ready');
    expect((await client.screen('s1')).text).toContain('ready');

    const viewer = await Raw.ready(current.port);

    viewer.send({ type: 'view', session: 's1' });
    await viewer.until((m) => m.type === 'replayed');
    viewer.socket.destroy();
    expect(write).not.toHaveBeenCalled();
    client.close();
  });

  it('waits for the output and resizes already received, so a read includes them', async () => {
    current = await startHost();

    const client = await HolderClient.connect({ port: current.port, token: TOKEN });

    await client.spawn(spawnRequest('s1'));
    await client.screen('s1');
    // The program redraws as soon as it is resized, as Claude does.
    current.ptys[0]!.onResize = (pty) => pty.emit('redrawn');

    const write = vi.spyOn(headless.Terminal.prototype, 'write');
    const raw = await Raw.ready(current.port);

    // One chunk, so the snapshot is asked for while the resize and its output wait to be parsed.
    raw.socket.write(`${JSON.stringify({ type: 'size', id: 1, session: 's1', cols: 60, rows: 8 })}\n${JSON.stringify({ type: 'snapshot', id: 2, session: 's1', scrollback: 0 })}\n`);

    const snapshot = await raw.until((m) => m.type === 'snapshot');

    expect(snapshot).toMatchObject({ cols: 60, rows: 8 });
    expect(snapshot.data).toContain('redrawn');
    // The output, the resize after it, then the empty write the snapshot waited on.
    expect(write.mock.calls.map((call) => call[0])).toEqual(['redrawn', '', '']);
    raw.socket.destroy();
    client.close();
  });
});
