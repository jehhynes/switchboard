import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { HIDDEN_MS, MIC_CONSTRAINTS, MIC_FRAME, PING_MS, PhoneVoice, RECONNECT_RETRY_MS, RECOVER_MS, RESUME_WELCOME_MS, RESUME_MS, RESUME_RETRY_MS } from '../src/phoneVoice.js';
import type { PhoneAudioContext, PhoneAudioNode, PhoneCaptureNode, PhoneMicStream, PhoneMicTrack } from '../src/phoneVoice.js';
import type { PlayCommand, PlayReport } from '../src/voiceWorklet.js';

/** A WebSocket the test drives: what the page sent, and the hub's side as calls. */
class FakeSocket {
  binaryType = 'blob';
  readonly sent: unknown[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {}

  /** Binary frames the page sent, as bytes. */
  readonly binary: number[][] = [];

  send(data: string | ArrayBuffer): void {
    if (typeof data === 'string') {
      this.sent.push(JSON.parse(data));
    } else {
      this.binary.push([...new Uint8Array(data)]);
    }
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

const flush = () => new Promise((done) => setImmediate(done));

/** A page's post with the hub's voice ticket given at once, in the same call, and every other command sent on to `post`. */
function ticketing(post: (name: string, body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>) {
  let given = 0;

  return (name: string, body: Record<string, unknown>) => {
    if (name !== 'page-voice-ticket') {
      return post(name, body);
    }

    const answer = { status: 200, body: { ticket: `ticket-${++given}` } };

    return { then: (ok: (one: typeof answer) => unknown) => (ok(answer), undefined) } as unknown as Promise<typeof answer>;
  };
}

/** An audio context the test reads: what was resumed, loaded and closed. */
class FakeContext implements PhoneAudioContext {
  state = 'running';
  baseLatency = 0.005;
  outputLatency = 0.015;
  readonly destination = 'speaker';
  readonly loaded: string[] = [];
  resumed = 0;
  closed = false;
  onstatechange: (() => void) | null = null;
  readonly audioWorklet = { addModule: async (url: string) => void this.loaded.push(url) };

  async resume(): Promise<void> {
    this.resumed++;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  change(state: string): void {
    this.state = state;
    this.onstatechange?.();
  }
}

class FakeNode implements PhoneAudioNode {
  readonly commands: PlayCommand[] = [];
  connected: unknown = null;
  disconnected = false;
  readonly port = {
    postMessage: (message: PlayCommand) => void this.commands.push(message),
    onmessage: null as ((event: { data: PlayReport }) => void) | null,
  };

  connect(destination: unknown): void {
    this.connected = destination;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  report(report: PlayReport): void {
    this.port.onmessage?.({ data: report });
  }
}

class FakeTrack implements PhoneMicTrack {
  muted = false;
  readyState = 'live';
  stopped = false;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  onended: (() => void) | null = null;

  stop(): void {
    this.stopped = true;
    this.readyState = 'ended';
  }

  mute(on: boolean): void {
    this.muted = on;
    (on ? this.onmute : this.onunmute)?.();
  }
}

class FakeCaptureNode implements PhoneCaptureNode {
  readonly port = { onmessage: null as ((event: { data: Int16Array }) => void) | null };
  disconnected = false;

  disconnect(): void {
    this.disconnected = true;
  }

  frame(samples: number[]): void {
    this.port.onmessage?.({ data: Int16Array.from(samples) });
  }
}

describe('voice on this phone (architecture.md § Remote access)', () => {
  afterEach(() => vi.useRealTimers());

  function setup(key: string | null = 'page-7') {
    const sockets: FakeSocket[] = [];
    const posts: Array<{ name: string; body: Record<string, unknown> }> = [];
    // The page-voice-ticket posts, apart from the others; while `holding`, each waits for the test to answer it.
    const tickets: Array<Record<string, unknown>> = [];
    let holding = false;
    const held: Array<{ resolve(answer: { status: number; body: Record<string, unknown> }): void; reject(error: Error): void }> = [];
    let answer = { status: 200, body: { allowed: false, error: 'Voice is not allowed on this device.' } as Record<string, unknown> };
    let now = 1_000;
    let changes = 0;
    let hidden = false;
    let visibility: () => void = () => undefined;
    let pageHide: () => void = () => undefined;
    const contexts: FakeContext[] = [];
    const nodes: FakeNode[] = [];
    const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
    const tracks: FakeTrack[] = [];
    const captures: FakeCaptureNode[] = [];
    const asked: unknown[] = [];
    const fetched: string[] = [];
    let fetchFails = false;
    let media: () => Promise<PhoneMicStream> = async () => {
      const track = new FakeTrack();

      tracks.push(track);
      return { getAudioTracks: () => [track] };
    };
    const voice = new PhoneVoice({
      media: (constraints) => {
        asked.push(constraints);
        return media();
      },
      capture: () => {
        const node = new FakeCaptureNode();

        captures.push(node);
        return node;
      },
      context: () => {
        const context = new FakeContext();

        contexts.push(context);
        return context;
      },
      node: () => {
        const node = new FakeNode();

        nodes.push(node);
        return node;
      },
      hidden: () => hidden,
      onVisibility: (changed) => (visibility = changed),
      onPageHide: (hidden) => (pageHide = hidden),
      setTimer: (run, ms) => {
        const timer = { run, ms, cleared: false };

        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => void ((timer as { cleared: boolean }).cleared = true),
      key: () => key,
      post: (name, body) => {
        if (name !== 'page-voice-ticket') {
          posts.push({ name, body });
          return Promise.resolve(answer);
        }

        tickets.push(body);

        if (holding) {
          return new Promise((resolve, reject) => held.push({ resolve, reject }));
        }

        // A ticket the hub gives at once is handed over in the same call, so a test sees the socket as soon as the tap opened it.
        const given = { status: 200, body: { ticket: `ticket-${tickets.length}` } };

        return { then: (ok: (answer: typeof given) => unknown) => (ok(given), undefined) } as unknown as Promise<typeof given>;
      },
      changed: () => changes++,
      now: () => now,
      origin: () => 'https://pc.tail.ts.net',
      fetch: async (url) => {
        fetched.push(url);

        if (fetchFails) {
          throw new Error('offline');
        }
      },
      socket: (url) => {
        const socket = new FakeSocket(url);

        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    return {
      voice,
      tracks,
      captures,
      asked,
      fetched,
      failFetch: () => (fetchFails = true),
      media: (next: () => Promise<PhoneMicStream>) => (media = next),
      sockets,
      posts,
      tickets,
      held,
      holdTickets: () => (holding = true),
      contexts,
      nodes,
      timers,
      changes: () => changes,
      advance: (ms: number) => (now += ms),
      answer: (next: typeof answer) => (answer = next),
      hide: (on: boolean) => {
        hidden = on;
        visibility();
      },
      /** The page unloads, as by a reload. */
      unload: () => pageHide(),
      /** The page's stream got a new key, as after a hub restart. */
      setKey: (next: string) => (key = next),
    };
  }

  it('opens the voice socket on the page origin with its page key, says hello, and is on at the welcome', () => {
    vi.useFakeTimers();

    const { voice, sockets, advance } = setup();

    voice.start();
    expect(sockets.map((one) => one.url)).toEqual(['wss://pc.tail.ts.net/v1/voice/socket?window=page-7&ticket=ticket-1']);
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
    // Voice off is the operator's choice: the page says it leaves before it closes, so the hub notes no lost phone.
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'leave' });
    expect(sockets[0]!.closedWith).toBe(1000);
    expect([voice.state, voice.error]).toEqual(['off', null]);
    // Pings stop with it.
    const sent = sockets[0]!.sent.length;

    vi.advanceTimersByTime(PING_MS * 2);
    expect(sockets[0]!.sent).toHaveLength(sent);
  });

  it('asks the hub for a ticket for its page key before it opens the socket, and opens nothing for a ticket that comes after Voice off or a newer tap', async () => {
    const { voice, sockets, tickets, held, holdTickets } = setup();

    holdTickets();
    voice.start();
    expect(tickets).toEqual([{ window: 'page-7' }]);
    expect([voice.state, sockets.length]).toEqual(['connecting', 0]);
    // A second tap while the ticket is asked for asks nothing more.
    voice.start();
    expect(tickets).toHaveLength(1);
    held[0]!.resolve({ status: 200, body: { ticket: 'abc' } });
    await flush();
    expect(sockets.map((one) => one.url)).toEqual(['wss://pc.tail.ts.net/v1/voice/socket?window=page-7&ticket=abc']);
    sockets[0]!.open();
    sockets[0]!.message({ type: 'welcome', at: 0 });
    expect(voice.state).toBe('on');
    voice.stop();

    // Voice off while the ticket is asked for: the late ticket opens nothing.
    voice.start();
    voice.stop();
    expect([voice.state, voice.error]).toEqual(['off', null]);
    held[1]!.resolve({ status: 200, body: { ticket: 'late' } });
    await flush();
    expect(sockets).toHaveLength(1);

    // A tap after Voice off asks again, and the earlier tap's ticket, coming last, opens nothing.
    voice.start();
    voice.stop();
    voice.start();
    held[3]!.resolve({ status: 200, body: { ticket: 'new' } });
    held[2]!.resolve({ status: 200, body: { ticket: 'old' } });
    await flush();
    expect(sockets.map((one) => one.url.split('ticket=')[1])).toEqual(['abc', 'new']);
  });

  it('says why when the hub refuses the ticket or does not answer, and tries a resume again', async () => {
    const { voice, sockets, tickets, held, holdTickets, timers } = setup();

    holdTickets();
    voice.start();
    held[0]!.resolve({ status: 403, body: { error: "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page." } });
    await flush();
    expect([voice.state, voice.error, sockets.length]).toEqual(['off', "This page's connection to Switchboard ended, so that was not done. Try again once it reconnects, or reload the page.", 0]);

    voice.start();
    held[1]!.reject(new Error('offline'));
    await flush();
    expect([voice.state, voice.error]).toEqual(['off', 'Switchboard did not answer.']);

    // A ticket that never comes gives the tap up at the welcome's limit.
    voice.start();
    timers.filter((one) => one.ms === RESUME_WELCOME_MS).at(-1)!.run();
    expect([voice.state, voice.error]).toEqual(['off', 'Voice did not start. Try again.']);
    held[2]!.resolve({ status: 200, body: { ticket: 'late' } });
    await flush();
    expect(sockets).toHaveLength(0);

    // A resume whose ticket is refused waits and asks again.
    voice.start();
    held[3]!.resolve({ status: 200, body: { ticket: 'one' } });
    await flush();
    sockets[0]!.open();
    sockets[0]!.message({ type: 'welcome', at: 0 });
    sockets[0]!.closeFromHub(1006);
    expect(tickets).toHaveLength(4);
    timers.filter((one) => one.ms === RECONNECT_RETRY_MS && !one.cleared).forEach((one) => (one.cleared = true, one.run()));
    expect(tickets).toHaveLength(5);
    held[4]!.resolve({ status: 503, body: { error: 'Switchboard is restarting onto a new build; try again in a few seconds.' } });
    await flush();
    expect([voice.state, voice.error, sockets.length]).toEqual(['connecting', null, 1]);
    timers.filter((one) => one.ms === RECONNECT_RETRY_MS && !one.cleared).forEach((one) => (one.cleared = true, one.run()));
    expect(tickets).toHaveLength(6);
    held[5]!.resolve({ status: 200, body: { ticket: 'two' } });
    await flush();
    expect(sockets[1]!.url).toMatch(/ticket=two$/);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([{ type: 'hello', resume: true }]);
  });

  it('drops an answer about an earlier refused socket that comes while the next tap waits for its ticket', async () => {
    const { voice, sockets, held, holdTickets } = setup();
    let late!: (answer: { status: number; body: Record<string, unknown> }) => void;
    const slow = new PhoneVoice({
      context: () => new FakeContext(),
      node: () => new FakeNode(),
      onVisibility: () => undefined,
      onPageHide: () => undefined,
      key: () => 'page-8',
      post: (name) => (name === 'page-voice-ticket' ? new Promise((resolve) => held.push({ resolve, reject: () => undefined })) : new Promise((resolve) => (late = resolve))),
      changed: () => undefined,
      now: () => 0,
      origin: () => 'https://pc.tail.ts.net',
      socket: (url) => {
        const made = new FakeSocket(url);

        sockets.push(made);
        return made as unknown as WebSocket;
      },
    });

    void voice;
    holdTickets();
    slow.start();
    held[0]!.resolve({ status: 200, body: { ticket: 'one' } });
    await flush();
    sockets[0]!.closeFromHub(1006);
    // The next tap waits for its ticket when the hub's answer about the refused socket comes.
    slow.start();
    late({ status: 200, body: { allowed: false, error: 'Voice is off.' } });
    await flush();
    expect([slow.state, slow.error]).toEqual(['connecting', null]);
    held[1]!.resolve({ status: 200, body: { ticket: 'two' } });
    await flush();
    sockets[1]!.open();
    sockets[1]!.message({ type: 'welcome', at: 0 });
    expect([slow.state, slow.error]).toEqual(['on', null]);
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
    sockets[1]!.closeFromHub(4001, 'Voice is now on another device.');
    expect(voice.error).toBe('Voice is now on another device.');

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
    // A welcomed socket that drops is no loss yet: the page takes the voice back by itself (the drop tests below).
    sockets[3]!.closeFromHub(1006);
    await flush();
    expect([voice.state, voice.error]).toEqual(['connecting', null]);
    voice.stop();

    answer({ status: 0, body: {} });
    voice.start();
    sockets[4]!.closeFromHub(1006);
    await flush();
    expect(voice.error).toBe('Voice did not start.');

    // An answer about a refused socket that comes after the voice was asked for again is dropped.
    let late!: (answer: { status: number; body: Record<string, unknown> }) => void;
    const slow = new PhoneVoice({
      context: () => new FakeContext(),
      node: () => new FakeNode(),
      onVisibility: () => undefined,
      key: () => 'page-8',
      post: ticketing(() => new Promise((resolve) => (late = resolve))),
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

  it('fetches the audio worklet ahead of a tap once, opening no audio, microphone or socket, and a failed fetch leaves the tap to load it', async () => {
    const { voice, fetched, failFetch, contexts, sockets, asked } = setup();

    failFetch();
    voice.preload();
    voice.preload();
    await flush();
    expect(fetched).toEqual(['https://pc.tail.ts.net/page/voice-worklet.js']);
    expect([contexts.length, sockets.length, asked.length, voice.state]).toEqual([0, 0, 0, 'off']);
    // The tap loads the same file into its audio context, from the cache when the fetch kept it.
    voice.start();
    expect(contexts[0]!.loaded).toEqual(fetched);
    expect(fetched).toHaveLength(1);
  });

  it('opens the phone\'s speaker in the tap and plays the hub\'s playbacks through the worklet in order, reporting heard time less the output latency', async () => {
    const { voice, sockets, contexts, nodes, timers } = setup();

    voice.start();
    // The context is made and resumed in the tap itself, as iOS needs.
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.resumed).toBe(1);
    expect(contexts[0]!.loaded).toEqual(['https://pc.tail.ts.net/page/voice-worklet.js']);

    const socket = sockets[0]!;

    socket.open();
    socket.message({ type: 'welcome', at: 0 });
    // Commands sent before the worklet loaded wait for it, in order.
    socket.message({ type: 'play', id: 3 });

    const frame = new ArrayBuffer(5 + 6);
    const view = new DataView(frame);

    view.setUint8(0, 1);
    view.setUint32(1, 3, true);
    view.setInt16(5, 100, true);
    view.setInt16(7, -100, true);
    view.setInt16(9, 32767, true);
    socket.onmessage?.({ data: frame });
    // Another kind of frame, or one too short, is dropped.
    socket.onmessage?.({ data: new ArrayBuffer(3) });
    socket.message({ type: 'end', id: 3 });
    socket.message({ type: 'flush', id: 3 });
    await flush();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.connected).toBe('speaker');
    expect(nodes[0]!.commands.map((one) => (one.type === 'pcm' ? ['pcm', one.id, [...one.samples]] : [one.type, one.id]))).toEqual([
      ['open', 3],
      ['pcm', 3, [100, -100, 32767]],
      ['end', 3],
      ['flush', 3],
    ]);

    // 4800 frames at 24 kHz is 200 ms; the output's 20 ms latency is not heard yet.
    nodes[0]!.report({ type: 'played', id: 3, frames: 4_800, done: false, underruns: 0 });
    // What the output took goes too, as `out`, for the voice's lead.
    expect(socket.sent.at(-1)).toEqual({ type: 'played', id: 3, ms: 180, done: false, out: 200 });
    // The end is reported once the latency passed.
    nodes[0]!.report({ type: 'played', id: 3, frames: 7_200, done: true, underruns: 1 });
    expect(socket.sent.at(-1)).toEqual({ type: 'played', id: 3, ms: 180, done: false, out: 200 });
    expect(timers.at(-1)!.ms).toBeCloseTo(20);
    timers.at(-1)!.run();
    expect(socket.sent.at(-1)).toEqual({ type: 'played', id: 3, ms: 300, done: true, out: 300 });

    voice.stop();
    await flush();
    expect(contexts[0]!.closed).toBe(true);
    expect(nodes[0]!.disconnected).toBe(true);
  });

  it('tells the hub it leaves when the page unloads while the voice is on, and nothing while it is off', () => {
    const { voice, sockets, unload } = setup();

    unload();
    voice.start();
    sockets[0]!.open();
    unload();
    expect(sockets[0]!.sent).toEqual([{ type: 'hello' }]);
    sockets[0]!.message({ type: 'welcome', at: 0 });
    unload();
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'leave' });
  });

  it('loses the voice without an error when the page stays hidden, with why when the phone takes its audio for good, and keeps it when the page comes back in time', async () => {
    const { voice, sockets, contexts, timers, hide, advance } = setup();

    voice.start();
    sockets[0]!.open();
    sockets[0]!.message({ type: 'welcome', at: 0 });
    hide(true);
    expect(timers.at(-1)!.ms).toBe(HIDDEN_MS);
    hide(false);
    expect(timers.at(-1)!.cleared).toBe(true);
    expect(voice.state).toBe('on');

    hide(true);
    timers.at(-1)!.run();
    // Leaving the page plainly ends talking, so nothing says why, here or on the computer.
    expect([voice.state, voice.error]).toEqual(['off', null]);
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'leave' });
    expect(sockets[0]!.closedWith).toBe(1000);
    expect(contexts[0]!.closed).toBe(true);
    // It stays off when the page shows again.
    hide(false);
    expect(voice.state).toBe('off');

    voice.start();
    sockets[1]!.open();
    sockets[1]!.message({ type: 'welcome', at: 0 });
    // A call holds the audio: the page asks it back until `RECOVER_MS` passed, then the voice leaves.
    contexts[1]!.change('interrupted');
    expect(voice.state).toBe('on');

    for (let waited = 0; waited < RECOVER_MS; waited += RESUME_RETRY_MS) {
      advance(RESUME_RETRY_MS);
      timers.at(-1)!.run();
    }

    expect([voice.state, voice.error]).toEqual(['off', 'Voice stopped because this device\'s audio did not resume.']);
    // A loss with a reason is a failure: no leave, so the computer notes the lost phone.
    expect(sockets[1]!.sent).not.toContainEqual({ type: 'leave' });
    expect(sockets[1]!.closedWith).toBe(1000);
  });

  it('resumes an audio context that iOS interrupts or suspends for a route change, as Bluetooth earbuds cause, and plays on with the voice and the mic kept', async () => {
    const { voice, sockets, contexts, nodes, timers, tracks, advance } = setup();
    const opened = voice.micOn();

    sockets[0]!.open();
    sockets[0]!.message({ type: 'welcome', at: 0 });
    expect(await opened).toBeNull();
    sockets[0]!.message({ type: 'play', id: 1 });
    await flush();

    const context = contexts[0]!;
    const resumed = context.resumed;

    for (const state of ['interrupted', 'suspended']) {
      context.change(state);
      // Asked to resume at once, and again while it stays stopped.
      expect(context.resumed).toBe(resumed + 1);
      advance(RESUME_RETRY_MS);
      timers.at(-1)!.run();
      expect(context.resumed).toBe(resumed + 2);
      context.resumed = resumed;
      context.change('running');
      // Running again ends the wait: its timer is cleared, and nothing is lost even past `RECOVER_MS`.
      expect(timers.at(-1)!.cleared).toBe(true);
      advance(RECOVER_MS);
      timers.at(-1)!.run();
      expect([voice.state, voice.error, voice.micOpen, tracks[0]!.stopped, context.closed]).toEqual(['on', null, true, false, false]);
    }

    // The same worklet plays on, reporting from where it stopped.
    nodes[0]!.report({ type: 'played', id: 1, frames: 24_000, done: false, underruns: 1 });
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'played', id: 1, ms: 980, done: false, out: 1_000 });
    expect(nodes).toHaveLength(1);
  });

  it('drops a report from a context it closed since, and loses the voice when the phone does not start its audio', async () => {
    const { voice, sockets, contexts, nodes } = setup();

    voice.start();
    sockets[0]!.open();
    sockets[0]!.message({ type: 'welcome', at: 0 });
    await flush();
    voice.stop();
    voice.start();
    sockets[1]!.open();
    sockets[1]!.message({ type: 'welcome', at: 0 });
    await flush();
    nodes[0]!.report({ type: 'played', id: 1, frames: 2_400, done: false, underruns: 0 });
    expect(sockets[1]!.sent.filter((one) => (one as { type: string }).type === 'played')).toEqual([]);
    voice.stop();

    // A resume the phone refuses.
    contexts.length = 0;
    const refusing = new FakeContext();

    // A refused resume leaves the context suspended.
    refusing.state = 'suspended';
    refusing.resume = () => Promise.reject(new Error('not allowed'));
    const refusals: Array<() => void> = [];
    let clock = 0;
    const failing = new PhoneVoice({
      context: () => refusing,
      node: () => new FakeNode(),
      onVisibility: () => undefined,
      // The welcome's own limit is not the audio's.
      setTimer: (run, ms) => (ms === RESUME_WELCOME_MS ? 0 : refusals.push(run)),
      clearTimer: () => undefined,
      key: () => 'page-9',
      post: ticketing(async () => ({ status: 200, body: {} })),
      changed: () => undefined,
      now: () => clock,
      origin: () => 'https://pc.tail.ts.net',
      socket: (url) => new FakeSocket(url) as unknown as WebSocket,
    });

    failing.start();
    await flush();
    // It may be an interruption's refusal, so it is asked again until `RECOVER_MS` passed.
    expect(failing.state).toBe('connecting');

    while (failing.state !== 'off' && clock <= RECOVER_MS) {
      clock += RESUME_RETRY_MS;
      refusals.shift()!();
    }

    expect([failing.state, failing.error, clock]).toEqual(['off', 'Audio did not start on this device.', RECOVER_MS]);

    // A tap's resume that an interruption, as a Bluetooth route change, makes fail is waited out, and the voice stays once the audio runs.
    const interrupted = new FakeContext();
    let refuse!: () => void;
    const retries: Array<() => void> = [];

    interrupted.resume = () => {
      interrupted.resumed++;
      return interrupted.resumed === 1 ? new Promise((_, reject) => (refuse = () => reject(new Error('interrupted')))) : Promise.resolve();
    };
    const kept = new PhoneVoice({
      context: () => interrupted,
      node: () => new FakeNode(),
      onVisibility: () => undefined,
      setTimer: (run) => retries.push(run),
      clearTimer: () => undefined,
      key: () => 'page-9',
      post: ticketing(async () => ({ status: 200, body: {} })),
      changed: () => undefined,
      now: () => 0,
      origin: () => 'https://pc.tail.ts.net',
      socket: (url) => new FakeSocket(url) as unknown as WebSocket,
    });

    kept.start();
    interrupted.change('interrupted');
    refuse();
    await flush();
    expect(kept.state).toBe('connecting');
    expect(interrupted.resumed).toBeGreaterThanOrEqual(2);
    interrupted.change('running');
    retries.at(-1)!();
    expect([kept.state, kept.error]).toEqual(['connecting', null]);

    // A refusal that lands after the interruption already ended keeps the context that runs; one that lands while it is still suspended, after
    // a state change, is waited out too.
    for (const after of ['running', 'suspended', 'suspended, unseen']) {
      const context = new FakeContext();
      let reject!: () => void;
      const timers: Array<() => void> = [];

      context.resume = () => {
        context.resumed++;
        return context.resumed === 1 ? new Promise((_, no) => (reject = () => no(new Error('interrupted')))) : Promise.resolve();
      };
      const voice = new PhoneVoice({
        context: () => context,
        node: () => new FakeNode(),
        onVisibility: () => undefined,
        setTimer: (run) => timers.push(run),
        clearTimer: () => undefined,
        key: () => 'page-9',
        post: ticketing(async () => ({ status: 200, body: {} })),
        changed: () => undefined,
        now: () => 0,
        origin: () => 'https://pc.tail.ts.net',
        socket: (url) => new FakeSocket(url) as unknown as WebSocket,
      });

      voice.start();

      if (after === 'suspended, unseen') {
        // Suspended, its state change not delivered yet when the refusal lands.
        context.state = 'suspended';
      } else {
        context.change('interrupted');
        context.change(after);
      }

      reject();
      await flush();
      expect([after, voice.state, voice.error]).toEqual([after, 'connecting', null]);
    }
  });

  describe('the phone\'s microphone (PRD R119)', () => {
    it('keeps its audio and microphone when the hub closes the voice to restart, and takes the voice back over the new stream\'s key without a tap', async () => {
      const { voice, sockets, tracks, captures, contexts, timers, setKey } = setup();
      const opened = voice.micOn();

      sockets[0]!.open();
      sockets[0]!.message({ type: 'welcome', at: 0 });
      expect(await opened).toBeNull();
      sockets[0]!.message({ type: 'capture', on: true });
      sockets[0]!.closeFromHub(4002, 'Switchboard is restarting.');
      expect([voice.state, voice.error, voice.micOpen]).toEqual(['connecting', null, true]);
      expect([contexts[0]!.closed, tracks[0]!.stopped, captures[0]!.disconnected]).toEqual([false, false, false]);

      // The old key belongs to the hub that stopped: nothing opens until the page's stream has a new one.
      voice.keyChanged();
      expect(sockets).toHaveLength(1);
      captures[0]!.frame([1]);
      expect(sockets[0]!.binary).toEqual([]);
      setKey('page-8');
      voice.keyChanged();
      expect(sockets.map((one) => one.url)).toEqual(['wss://pc.tail.ts.net/v1/voice/socket?window=page-7&ticket=ticket-1', 'wss://pc.tail.ts.net/v1/voice/socket?window=page-8&ticket=ticket-2']);
      sockets[1]!.open();
      expect(sockets[1]!.sent).toEqual([{ type: 'hello', resume: true }]);
      sockets[1]!.message({ type: 'welcome', at: 0 });
      expect([voice.state, voice.error, voice.micOpen]).toEqual(['on', null, true]);
      expect(sockets[1]!.sent.filter((one) => (one as { type: string }).type === 'state')).toEqual([{ type: 'state', busy: false }]);

      // Frames wait for the voice process's capture, which the hub that took over sends again.
      captures[0]!.frame([1]);
      expect(sockets[1]!.binary).toEqual([]);
      sockets[1]!.message({ type: 'capture', on: true });
      captures[0]!.frame([1, -2]);
      expect(sockets[1]!.binary).toEqual([[MIC_FRAME, 1, 0, 254, 255]]);
      // The same audio and microphone throughout, and the wait's timer is gone.
      expect([contexts.length, tracks.length, captures.length]).toEqual([1, 1, 1]);
      expect(timers.filter((one) => one.ms === RESUME_MS).map((one) => one.cleared)).toEqual([true]);
    });

    it('keeps its audio and microphone when the connection drops, takes the voice back on the same key with no tap, and tries again until it gets through', async () => {
      const { voice, sockets, tracks, contexts, timers } = setup();
      const opened = voice.micOn();
      const retries = () => timers.filter((one) => one.ms === RECONNECT_RETRY_MS && !one.cleared);
      const runRetry = () => {
        const timer = retries().at(-1)!;

        timer.cleared = true;
        timer.run();
      };

      sockets[0]!.open();
      sockets[0]!.message({ type: 'welcome', at: 0 });
      expect(await opened).toBeNull();
      // A cellular blip: the socket closes abnormally, with no word.
      sockets[0]!.closeFromHub(1006);
      expect([voice.state, voice.error, voice.micOpen]).toEqual(['connecting', null, true]);
      expect([contexts[0]!.closed, tracks[0]!.stopped]).toEqual([false, false]);

      // Still down: the attempt fails without a welcome and is tried again.
      runRetry();
      expect(sockets).toHaveLength(2);
      sockets[1]!.closeFromHub(1006);
      expect(voice.state).toBe('connecting');
      runRetry();
      sockets[2]!.open();
      expect(sockets[2]!.url).toMatch(/window=page-7&ticket=ticket-\d+$/);
      expect(sockets[2]!.sent).toEqual([{ type: 'hello', resume: true }]);
      sockets[2]!.message({ type: 'welcome', at: 0 });
      expect([voice.state, voice.error, voice.micOpen]).toEqual(['on', null, true]);
      expect([contexts.length, tracks.length]).toEqual([1, 1]);

      // The page's stream dropped too: the hub closes the socket as going away, and not back within the wait, the voice leaves with why.
      sockets[2]!.closeFromHub(1001, 'The page that opened the voice closed.');
      expect(voice.state).toBe('connecting');
      timers.filter((one) => one.ms === RESUME_MS && !one.cleared).at(-1)!.run();
      expect([voice.state, voice.error, voice.micOpen]).toEqual(['off', 'Voice did not come back after the connection dropped. Select Voice on this device to start it here.', false]);
      // Nothing is tried after that.
      runRetry();
      expect(sockets).toHaveLength(3);
    });

    it('gives up a resume that is not welcomed in time, and one still opening on an old key for the new key', async () => {
      const { voice, sockets, timers, setKey } = setup();

      voice.start();
      sockets[0]!.open();
      sockets[0]!.message({ type: 'welcome', at: 0 });
      sockets[0]!.closeFromHub(1006);
      timers.filter((one) => one.ms === RECONNECT_RETRY_MS && !one.cleared).at(-1)!.run();
      expect(sockets).toHaveLength(2);
      // Never connects: given up after the welcome's time, and tried again.
      timers.filter((one) => one.ms === RESUME_WELCOME_MS && !one.cleared).at(-1)!.run();
      expect(sockets[1]!.closedWith).toBe(1000);
      timers.filter((one) => one.ms === RECONNECT_RETRY_MS && !one.cleared).at(-1)!.run();
      expect(sockets).toHaveLength(3);
      // The page's stream came back with a new key while that one still opens: the new key's socket replaces it.
      setKey('page-8');
      voice.keyChanged();
      expect(sockets[2]!.closedWith).toBe(1000);
      expect(sockets.at(-1)!.url).toMatch(/window=page-8&ticket=ticket-\d+$/);
      sockets.at(-1)!.open();
      sockets.at(-1)!.message({ type: 'welcome', at: 0 });
      expect(voice.state).toBe('on');

      // A tap's start that is never welcomed fails with why rather than wait for good.
      voice.stop();
      voice.start();
      timers.filter((one) => one.ms === RESUME_WELCOME_MS && !one.cleared).at(-1)!.run();
      expect([voice.state, voice.error]).toEqual(['off', 'Voice did not start. Try again.']);
    });

    it('takes a socket that brought nothing for three pings for dropped, as a half-open connection, and takes the voice back', async () => {
      vi.useFakeTimers();
      onTestFinished(() => void vi.useRealTimers());

      const { voice, sockets, advance } = setup();

      voice.start();
      sockets[0]!.open();
      sockets[0]!.message({ type: 'welcome', at: 0 });
      // Pongs keep it: each answer counts.
      advance(PING_MS);
      vi.advanceTimersByTime(PING_MS);
      sockets[0]!.message({ type: 'pong', t: 0, at: 0 });
      advance(PING_MS * 3);
      vi.advanceTimersByTime(PING_MS);
      expect(voice.state).toBe('on');
      // Nothing more arrives: the page gives the socket up and asks for the voice back on a new one.
      advance(PING_MS);
      vi.advanceTimersByTime(PING_MS);
      expect(voice.state).toBe('connecting');
      expect(sockets[0]!.closedWith).toBe(1000);
    });

    it('lets go of the audio and microphone when the voice does not come back in time, the hub refuses it, or the voice is turned off meanwhile', async () => {
      const { voice, sockets, tracks, contexts, timers, setKey } = setup();
      const turnOn = async (socket: number): Promise<void> => {
        const opened = voice.micOn();

        sockets[socket]!.open();
        sockets[socket]!.message({ type: 'welcome', at: 0 });
        expect(await opened).toBeNull();
        sockets[socket]!.closeFromHub(4002, 'Switchboard is restarting.');
      };

      await turnOn(0);
      timers.find((one) => one.ms === RESUME_MS)!.run();
      expect([voice.state, voice.error, voice.micOpen]).toEqual(['off', 'Voice did not resume after Switchboard restarted. Select Voice on this device to start it here.', false]);
      expect([contexts[0]!.closed, tracks[0]!.stopped]).toEqual([true, true]);

      await turnOn(1);
      setKey('page-8');
      voice.keyChanged();
      sockets[2]!.open();
      sockets[2]!.closeFromHub(4003, 'Voice did not resume after Switchboard restarted. Select Voice on this device to start it here.');
      expect([voice.state, voice.error]).toEqual(['off', 'Voice did not resume after Switchboard restarted. Select Voice on this device to start it here.']);
      expect([contexts[1]!.closed, tracks[1]!.stopped]).toEqual([true, true]);

      setKey('page-7');
      await turnOn(3);
      voice.stop();
      expect([voice.state, voice.error, contexts[2]!.closed, tracks[2]!.stopped]).toEqual(['off', null, true, true]);
      setKey('page-9');
      voice.keyChanged();
      expect(sockets).toHaveLength(4);
    });

    /** The audio session, with each type the page set. */
    const types: string[] = [];
    let current = 'auto';
    const session = {
      get type(): string {
        return current;
      },
      set type(type: string) {
        current = type;
        types.push(type);
      },
    };

    function withSession(): void {
      current = 'auto';
      types.length = 0;
      Object.defineProperty(navigator, 'audioSession', { value: session, configurable: true });
    }

    afterEach(() => void Reflect.deleteProperty(navigator, 'audioSession'));

    it('opens in the mic\'s tap, taking the voice here first, and sends 20 ms frames only while the voice captures and the phone can hear', async () => {
      withSession();

      const { voice, sockets, tracks, captures, asked } = setup();
      const steps: string[] = [];
      const opened = voice.micOn((name) => steps.push(name));

      // The socket, the audio and the microphone are all asked for in the tap itself, the session set to record first.
      expect(sockets).toHaveLength(1);
      expect(asked).toEqual([MIC_CONSTRAINTS]);
      expect(session.type).toBe('play-and-record');
      // Set to record from the start, never to playback first, so iOS does not move a Bluetooth route under the voice.
      expect(types.every((type) => type === 'play-and-record')).toBe(true);
      await flush();
      expect(captures).toEqual([]);
      sockets[0]!.open();
      sockets[0]!.message({ type: 'welcome', at: 0 });
      expect(await opened).toBeNull();
      expect(voice.micOpen).toBe(true);
      expect(captures).toHaveLength(1);
      // Each part the tap started is timed for the hub log, the microphone's permission first here and the capture last.
      expect(steps[0]).toBe('microphone allowed');
      expect(steps.slice(1, -1).sort()).toEqual(['audio resumed', 'audio worklet loaded', 'voice socket welcomed']);
      expect(steps.at(-1)).toBe('capture connected');
      expect(sockets[0]!.sent.filter((one) => (one as { type: string }).type === 'state')).toEqual([{ type: 'state', busy: false }]);

      // Frames wait for the voice process's capture.
      captures[0]!.frame([1, -2]);
      expect(sockets[0]!.binary).toEqual([]);
      sockets[0]!.message({ type: 'capture', on: true });
      captures[0]!.frame([1, -2]);
      expect(sockets[0]!.binary).toEqual([[MIC_FRAME, 1, 0, 254, 255]]);

      // A call mutes the track: the hub hears it is busy and no frame goes out until it is back.
      tracks[0]!.mute(true);
      captures[0]!.frame([3]);
      expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'state', busy: true });
      tracks[0]!.mute(false);
      expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'state', busy: false });
      sockets[0]!.message({ type: 'capture', on: false });
      captures[0]!.frame([4]);
      expect(sockets[0]!.binary).toHaveLength(1);

      // Mic off releases the microphone and plays at full loudness again; the voice stays on the phone.
      voice.micOff();
      expect([tracks[0]!.stopped, captures[0]!.disconnected, voice.micOpen, voice.state]).toEqual([true, true, false, 'on']);
      expect(session.type).toBe('playback');
      expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'state', busy: true });
    });

    it('tells the hub at once when the page is hidden, and releases the microphone when the voice leaves the phone', async () => {
      const { voice, sockets, tracks, hide } = setup();

      voice.start();
      sockets[0]!.open();
      sockets[0]!.message({ type: 'welcome', at: 0 });

      const steps: string[] = [];

      expect(await voice.micOn((name) => steps.push(name))).toBeNull();
      // The voice was on this phone before the tap: only the microphone's parts are timed.
      expect(steps).toEqual(['microphone allowed', 'capture connected']);
      // Whether the page is hidden goes too, so the hub notes no lost phone for a socket that closes while it is, as when the app is closed.
      hide(true);
      expect(sockets[0]!.sent.slice(-2)).toEqual([{ type: 'state', busy: true }, { type: 'visibility', hidden: true }]);
      hide(false);
      expect(sockets[0]!.sent.slice(-2)).toEqual([{ type: 'state', busy: false }, { type: 'visibility', hidden: false }]);

      sockets[0]!.closeFromHub(4001, 'Voice is now on another device.');
      expect(tracks[0]!.stopped).toBe(true);
      expect(voice.micOpen).toBe(false);
    });

    it('says nothing of a Mic on still opening when a hidden page loses the voice', async () => {
      const { voice, sockets, timers, hide, media } = setup();

      voice.start();
      sockets[0]!.open();
      sockets[0]!.message({ type: 'welcome', at: 0 });

      let open!: (stream: PhoneMicStream) => void;

      media(() => new Promise((resolve) => (open = resolve)));

      const late = voice.micOn();

      hide(true);
      timers.at(-1)!.run();

      const track = new FakeTrack();

      open({ getAudioTracks: () => [track] });
      // Empty: the voice left without a word, so the page shows no reason.
      expect(await late).toBe('');
      expect([voice.state, voice.error, track.stopped, voice.micOpen]).toEqual(['off', null, true, false]);

      // So too when the microphone's request then fails.
      hide(false);
      voice.start();
      sockets[1]!.open();
      sockets[1]!.message({ type: 'welcome', at: 0 });

      let refuse!: (error: Error) => void;

      media(() => new Promise((_resolve, reject) => (refuse = reject)));

      const refused = voice.micOn();

      hide(true);
      timers.at(-1)!.run();
      refuse(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
      expect(await refused).toBe('');

      // Voice off, the operator's own action, cuts a Mic on short with nothing to say.
      hide(false);
      voice.start();
      sockets[2]!.open();
      sockets[2]!.message({ type: 'welcome', at: 0 });
      media(() => new Promise((resolve) => (open = resolve)));

      const stopped = voice.micOn();

      voice.stop();
      open({ getAudioTracks: () => [new FakeTrack()] });
      expect(await stopped).toBe('');

      // So too one whose microphone request then fails.
      voice.start();
      sockets[3]!.open();
      sockets[3]!.message({ type: 'welcome', at: 0 });
      media(() => new Promise((_resolve, reject) => (refuse = reject)));

      const stoppedRefused = voice.micOn();

      voice.stop();
      refuse(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
      expect(await stoppedRefused).toBe('');
    });

    it('releases the microphone when the hub\'s mic turns off after it was on, and says why it could not open', async () => {
      const { voice, sockets, tracks, media } = setup();

      voice.start();
      sockets[0]!.open();
      sockets[0]!.message({ type: 'welcome', at: 0 });
      expect(await voice.micOn()).toBeNull();
      // Off before the hub's mic came on is the hub catching up, not a release.
      voice.viewMic('off');
      expect(voice.micOpen).toBe(true);
      voice.viewMic('listening');
      voice.viewMic('off');
      expect([voice.micOpen, tracks[0]!.stopped]).toEqual([false, true]);

      media(() => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })));
      expect(await voice.micOn()).toBe('Microphone access was not allowed on this device.');
      media(() => Promise.reject(new Error('no device')));
      expect(await voice.micOn()).toBe("The microphone did not open on this device.");
      expect(voice.micOpen).toBe(false);

      // Mic off while the microphone is still opening keeps nothing of it.
      let open!: (stream: PhoneMicStream) => void;

      media(() => new Promise((resolve) => (open = resolve)));

      const late = voice.micOn();

      voice.micOff();

      const track = new FakeTrack();

      open({ getAudioTracks: () => [track] });
      expect(await late).toBe('');
      expect([track.stopped, voice.micOpen]).toEqual([true, false]);
    });

    it('releases the microphone when the capture worklet cannot connect it, and when the phone gives no track', async () => {
      withSession();

      const failing = new PhoneVoice({
        context: () => new FakeContext(),
        node: () => new FakeNode(),
        media: async () => ({ getAudioTracks: () => [track] }),
        capture: () => {
          throw new Error('no worklet');
        },
        onVisibility: () => undefined,
        hidden: () => false,
        key: () => 'page-10',
        post: ticketing(async () => ({ status: 200, body: {} })),
        changed: () => undefined,
        now: () => 0,
        origin: () => 'https://pc.tail.ts.net',
        socket: (url) => {
          const made = new FakeSocket(url);

          queueMicrotask(() => {
            made.open();
            made.message({ type: 'welcome', at: 0 });
          });
          return made as unknown as WebSocket;
        },
      });
      const track = new FakeTrack();

      expect(await failing.micOn()).toBe('Switchboard could not start microphone capture on this device.');
      expect([track.stopped, failing.micOpen, session.type]).toEqual([true, false, 'playback']);

      const { voice, media } = setup();

      media(async () => ({ getAudioTracks: () => [] }));
      expect(await voice.micOn()).toBe('No microphone audio was available on this device.');
      expect(session.type).toBe('playback');
    });

    it('leaves a newer Mic on\'s microphone alone when an older one, released meanwhile, finishes last', async () => {
      const { voice, sockets, tracks, captures } = setup();
      const first = voice.micOn();

      await flush();
      // Released before the socket is welcomed, then opened again.
      voice.micOff();

      const second = voice.micOn();

      await flush();
      sockets[0]!.open();
      sockets[0]!.message({ type: 'welcome', at: 0 });
      expect(await second).toBeNull();
      expect(await first).toBe('');
      expect(tracks.map((one) => one.stopped)).toEqual([true, false]);
      expect(voice.micOpen).toBe(true);
      expect(captures).toHaveLength(1);
    });

    it('opens no microphone when the voice cannot open on this phone', async () => {
      const { voice, sockets, tracks, captures } = setup();
      const opened = voice.micOn();

      sockets[0]!.closeFromHub(4003, 'Voice is not allowed on this device.');
      expect(await opened).toBe('Voice is not allowed on this device.');
      expect(tracks.every((one) => one.stopped)).toBe(true);
      expect(captures).toEqual([]);
    });
  });
});
