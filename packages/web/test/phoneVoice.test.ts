import { afterEach, describe, expect, it, vi } from 'vitest';
import { PING_MS, PhoneVoice } from '../src/phoneVoice.js';

/** A WebSocket the test drives: what the page sent, and the hub's side as calls. */
class FakeSocket {
  binaryType = 'blob';
  readonly sent: unknown[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code: number): void {
    this.closedWith = code;
  }

  open(): void {
    this.onopen?.();
  }

  message(data: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  closeFromHub(code: number, reason = ''): void {
    this.onclose?.({ code, reason });
  }
}

const flush = () => new Promise((done) => setTimeout(done, 0));

describe('voice on this phone (architecture.md § Remote access)', () => {
  afterEach(() => vi.useRealTimers());

  function setup(key: string | null = 'page-7') {
    const sockets: FakeSocket[] = [];
    const posts: Array<{ name: string; body: Record<string, unknown> }> = [];
    let answer = { status: 200, body: { allowed: false, error: 'Voice is not allowed on this device.' } as Record<string, unknown> };
    let now = 1_000;
    let changes = 0;
    const voice = new PhoneVoice({
      key: () => key,
      post: async (name, body) => {
        posts.push({ name, body });
        return answer;
      },
      changed: () => changes++,
      now: () => now,
      origin: () => 'https://pc.tail.ts.net',
      socket: (url) => {
        const socket = new FakeSocket(url);

        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    return { voice, sockets, posts, changes: () => changes, advance: (ms: number) => (now += ms), answer: (next: typeof answer) => (answer = next) };
  }

  it('opens the voice socket on the page origin with its page key, says hello, and is on at the welcome', () => {
    vi.useFakeTimers();

    const { voice, sockets, advance } = setup();

    voice.start();
    expect(sockets.map((one) => one.url)).toEqual(['wss://pc.tail.ts.net/v1/voice/socket?window=page-7']);
    expect(sockets[0]!.binaryType).toBe('arraybuffer');
    expect(voice.state).toBe('connecting');
    // A second tap while it opens opens nothing more.
    voice.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([{ type: 'hello' }]);
    sockets[0]!.message({ type: 'welcome', at: 5_000 });
    expect(voice.state).toBe('on');
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'ping', t: 1_000 });

    // The hub's clock from the fastest round trip: sent at 1000, answered at 1040 with the hub's 6020, so the hub is 5000 ahead.
    advance(40);
    sockets[0]!.message({ type: 'pong', t: 1_000, at: 6_020 });
    expect(voice.offset).toBe(5_000);
    advance(PING_MS);
    vi.advanceTimersByTime(PING_MS);
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'ping', t: 1_000 + 40 + PING_MS });
    // A slower answer does not replace it.
    advance(400);
    sockets[0]!.message({ type: 'pong', t: 1_040 + PING_MS, at: 99_999 });
    expect(voice.offset).toBe(5_000);

    voice.stop();
    expect(sockets[0]!.closedWith).toBe(1000);
    expect([voice.state, voice.error]).toEqual(['off', null]);
    // Pings stop with it.
    const sent = sockets[0]!.sent.length;

    vi.advanceTimersByTime(PING_MS * 2);
    expect(sockets[0]!.sent).toHaveLength(sent);
  });

  it('opens nothing before the page has a key', () => {
    const { voice, sockets } = setup(null);

    voice.start();
    expect(sockets).toEqual([]);
    expect(voice.state).toBe('off');
  });

  it('says why the voice left: the hub\'s close reason, another device taking it, or the hub\'s answer for a refused upgrade', async () => {
    const { voice, sockets, posts, answer } = setup();

    voice.start();
    sockets[0]!.open();
    sockets[0]!.message({ type: 'welcome', at: 0 });
    sockets[0]!.closeFromHub(4003, 'Voice is no longer allowed on this device.');
    expect([voice.state, voice.error]).toEqual(['off', 'Voice is no longer allowed on this device.']);

    voice.start();
    expect(voice.error).toBeNull();
    sockets[1]!.closeFromHub(4001, 'Voice moved to another device.');
    expect(voice.error).toBe('Voice moved to another device.');

    // A refused upgrade closes with no reason, so the page asks the hub.
    voice.start();
    sockets[2]!.closeFromHub(1006);
    await flush();
    expect(posts).toEqual([{ name: 'page-voice-state', body: {} }]);
    expect(voice.error).toBe('Voice is not allowed on this device.');

    answer({ status: 200, body: { allowed: true, error: null } });
    voice.start();
    sockets[3]!.open();
    sockets[3]!.message({ type: 'welcome', at: 0 });
    sockets[3]!.closeFromHub(1006);
    await flush();
    expect(voice.error).toBe('The voice connection closed.');

    answer({ status: 0, body: {} });
    voice.start();
    sockets[4]!.closeFromHub(1006);
    await flush();
    expect(voice.error).toBe('Switchboard did not open the voice.');

    // An answer about a refused socket that comes after the voice was asked for again is dropped.
    let late!: (answer: { status: number; body: Record<string, unknown> }) => void;
    const slow = new PhoneVoice({
      key: () => 'page-8',
      post: () => new Promise((resolve) => (late = resolve)),
      changed: () => undefined,
      now: () => 0,
      origin: () => 'https://pc.tail.ts.net',
      socket: (url) => {
        const made = new FakeSocket(url);

        sockets.push(made);
        return made as unknown as WebSocket;
      },
    });

    slow.start();
    sockets.at(-1)!.closeFromHub(1006);
    slow.start();
    sockets.at(-1)!.open();
    sockets.at(-1)!.message({ type: 'welcome', at: 0 });
    late({ status: 200, body: { allowed: false, error: 'Voice is off.' } });
    await flush();
    expect([slow.state, slow.error]).toEqual(['on', null]);

    // A socket the page already stopped reports nothing.
    voice.start();
    voice.stop();
    sockets[5]!.closeFromHub(1000, 'late');
    expect(voice.error).toBeNull();
  });
});
