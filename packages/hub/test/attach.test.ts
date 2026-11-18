import type { AttachOptions } from '@switchboard/holder';
import { describe, expect, it, vi } from 'vitest';
import { runAttach } from '../src/attach.js';
import type { AttachDeps } from '../src/attach.js';

type Reply = Awaited<ReturnType<AttachDeps['post']>>;

const HOLDER: Reply = { status: 200, error: null, body: { port: 4100, token: 'holder-token', session: 's1' } };
const RETRY = 'Press Enter to try again, or close this terminal.';

interface FakeLink {
  options: AttachOptions;
  inputs: string[];
  sizes: Array<[number, number]>;
  closed: boolean;
  input(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** A terminal and hub the test drives: `replies` answers each `POST /attach` in turn. */
function terminal(replies: Reply[], open?: (options: AttachOptions) => Promise<FakeLink>) {
  const state = {
    out: [] as string[],
    raw: [] as boolean[],
    posts: [] as unknown[],
    links: [] as FakeLink[],
    size: { cols: 100, rows: 30 },
    type: (_data: string): void => {},
    resized: (): void => {},
    end: (): void => {},
  };
  const deps: AttachDeps = {
    sessionId: 's1',
    post: async (body) => {
      state.posts.push(body);
      return replies.shift() ?? 'No reply left.';
    },
    open:
      open ??
      (async (options) => {
        const link: FakeLink = {
          options,
          inputs: [],
          sizes: [],
          closed: false,
          input: (data) => link.inputs.push(data),
          resize: (cols, rows) => link.sizes.push([cols, rows]),
          close: () => (link.closed = true),
        };

        state.links.push(link);
        return link;
      }),
    size: () => state.size,
    write: (text) => state.out.push(text),
    raw: (on) => state.raw.push(on),
    onInput: (listener) => (state.type = listener),
    onResize: (listener) => (state.resized = listener),
    onEnd: (listener) => (state.end = listener),
  };

  return { state, run: runAttach(deps) };
}

describe('hub.js attach (architecture.md § Attach client)', () => {
  it('attaches at the terminal size in raw mode, writes the replay and output, and passes input and size changes', async () => {
    const { state, run } = terminal([HOLDER]);

    await vi.waitFor(() => expect(state.links).toHaveLength(1));
    const [link] = state.links;

    expect(link!.options).toMatchObject({ port: 4100, token: 'holder-token', session: 's1', cols: 100, rows: 30 });
    expect(state.posts).toEqual([{ sessionId: 's1' }]);
    expect(state.raw).toEqual([true]);

    link!.options.onData('screen');
    link!.options.onData('more');
    state.type('ls\r');
    state.size = { cols: 80, rows: 20 };
    state.resized();

    expect(state.out).toEqual(['screen', 'more']);
    expect(link!.inputs).toEqual(['ls\r']);
    expect(link!.sizes).toEqual([[80, 20]]);

    state.end();
    expect(await run).toBe(0);
    expect(link!.closed).toBe(true);
  });

  it('says the session ended with its exit code, leaves raw mode, and attaches again on Enter, which resumes it', async () => {
    const { state, run } = terminal([HOLDER, HOLDER]);

    await vi.waitFor(() => expect(state.links).toHaveLength(1));
    state.links[0]!.options.onExit?.(3);
    state.links[0]!.options.onClose?.(null);

    await vi.waitFor(() => expect(state.out).toEqual(['\r\nThe session ended (exit code 3). Press Enter to resume it, or close this terminal.\r\n']));
    expect(state.raw).toEqual([true, false]);
    expect(state.links[0]!.closed).toBe(true);

    state.type('x');
    expect(state.posts).toHaveLength(1);

    state.type('\r\n');
    await vi.waitFor(() => expect(state.links).toHaveLength(2));
    expect(state.posts).toHaveLength(2);
    expect(state.raw).toEqual([true, false, true]);

    state.end();
    expect(await run).toBe(0);
  });

  it('says when the hub is not running and asks it again on Enter', async () => {
    const { state, run } = terminal(['The Switchboard hub is not running.', HOLDER]);

    await vi.waitFor(() => expect(state.out).toEqual([`The Switchboard hub is not running. ${RETRY}\r\n`]));
    expect(state.links).toEqual([]);

    state.type('\n');
    await vi.waitFor(() => expect(state.links).toHaveLength(1));
    state.end();
    expect(await run).toBe(0);
  });

  it("prints the hub's refusal, and waits for Enter", async () => {
    const { state, run } = terminal([{ status: 409, error: 'Session abc still has 1 process from its previous run (pid 7). Stop them or wait for them to end.', body: null }, { status: 404, error: null, body: null }]);

    await vi.waitFor(() => expect(state.out).toEqual([`Refused: Session abc still has 1 process from its previous run (pid 7). Stop them or wait for them to end.\r\n${RETRY}\r\n`]));
    state.type('\r');
    await vi.waitFor(() => expect(state.out[1]).toBe(`Refused: status 404\r\n${RETRY}\r\n`));
    expect(state.raw).toEqual([]);
    state.end();
    expect(await run).toBe(0);
  });

  it('says why the holder closed the connection or could not be reached', async () => {
    const lost = terminal([HOLDER]);

    await vi.waitFor(() => expect(lost.state.links).toHaveLength(1));
    lost.state.links[0]!.options.onClose?.(new Error('The terminal holder closed the connection.') as never);
    await vi.waitFor(() => expect(lost.state.out).toEqual([`\r\nThe terminal holder closed the connection. ${RETRY}\r\n`]));
    expect(lost.state.raw).toEqual([true, false]);
    lost.state.end();
    expect(await lost.run).toBe(0);

    const unreachable = terminal([HOLDER], () => Promise.reject(new Error('The terminal holder could not be reached: connect ECONNREFUSED 127.0.0.1:4100')));

    await vi.waitFor(() => expect(unreachable.state.out).toEqual([`The terminal holder could not be reached: connect ECONNREFUSED 127.0.0.1:4100 ${RETRY}\r\n`]));
    expect(unreachable.state.raw).toEqual([false]);
    unreachable.state.end();
    expect(await unreachable.run).toBe(0);
  });
});
