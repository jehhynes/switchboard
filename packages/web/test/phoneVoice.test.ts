import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIDDEN_MS, MIC_CONSTRAINTS, MIC_FRAME, PING_MS, PhoneVoice } from '../src/phoneVoice.js';
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

const flush = () => new Promise((done) => setTimeout(done, 0));

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
    let answer = { status: 200, body: { allowed: false, error: 'Voice is not allowed on this device.' } as Record<string, unknown> };
    let now = 1_000;
    let changes = 0;
    let hidden = false;
    let visibility: () => void = () => undefined;
    const contexts: FakeContext[] = [];
    const nodes: FakeNode[] = [];
    const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
    const tracks: FakeTrack[] = [];
    const captures: FakeCaptureNode[] = [];
    const asked: unknown[] = [];
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
      setTimer: (run, ms) => {
        const timer = { run, ms, cleared: false };

        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => void ((timer as { cleared: boolean }).cleared = true),
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

    return {
      voice,
      tracks,
      captures,
      asked,
      media: (next: () => Promise<PhoneMicStream>) => (media = next),
      sockets,
      posts,
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
    };
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
      context: () => new FakeContext(),
      node: () => new FakeNode(),
      onVisibility: () => undefined,
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
    expect(socket.sent.at(-1)).toEqual({ type: 'played', id: 3, ms: 180, done: false });
    // The end is reported once the latency passed.
    nodes[0]!.report({ type: 'played', id: 3, frames: 7_200, done: true, underruns: 1 });
    expect(socket.sent.at(-1)).toEqual({ type: 'played', id: 3, ms: 180, done: false });
    expect(timers.at(-1)!.ms).toBeCloseTo(20);
    timers.at(-1)!.run();
    expect(socket.sent.at(-1)).toEqual({ type: 'played', id: 3, ms: 300, done: true });

    voice.stop();
    await flush();
    expect(contexts[0]!.closed).toBe(true);
    expect(nodes[0]!.disconnected).toBe(true);
  });

  it('loses the voice when the page stays hidden or the phone takes its audio, and keeps it when the page comes back in time', async () => {
    const { voice, sockets, contexts, timers, hide } = setup();

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
    expect([voice.state, voice.error]).toEqual(['off', 'The page was hidden, so the voice left this phone.']);
    expect(sockets[0]!.closedWith).toBe(1000);
    expect(contexts[0]!.closed).toBe(true);
    // It stays off when the page shows again.
    hide(false);
    expect(voice.state).toBe('off');

    voice.start();
    sockets[1]!.open();
    sockets[1]!.message({ type: 'welcome', at: 0 });
    contexts[1]!.change('suspended');
    expect(voice.state).toBe('on');
    contexts[1]!.change('interrupted');
    expect([voice.state, voice.error]).toEqual(['off', 'The phone took its audio, as for a call, so the voice left this phone.']);
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

    refusing.resume = () => Promise.reject(new Error('not allowed'));
    const failing = new PhoneVoice({
      context: () => refusing,
      node: () => new FakeNode(),
      onVisibility: () => undefined,
      key: () => 'page-9',
      post: async () => ({ status: 200, body: {} }),
      changed: () => undefined,
      now: () => 0,
      origin: () => 'https://pc.tail.ts.net',
      socket: (url) => new FakeSocket(url) as unknown as WebSocket,
    });

    failing.start();
    await flush();
    expect([failing.state, failing.error]).toEqual(['off', 'The phone did not start its audio.']);
  });

  describe('the phone\'s microphone (PRD R119)', () => {
    const session = { type: 'auto' };

    function withSession(): void {
      session.type = 'auto';
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
      hide(true);
      expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'state', busy: true });
      hide(false);
      expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'state', busy: false });

      sockets[0]!.closeFromHub(4001, 'Voice moved to another device.');
      expect(tracks[0]!.stopped).toBe(true);
      expect(voice.micOpen).toBe(false);
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
      expect(await voice.micOn()).toBe('The phone did not allow the microphone.');
      media(() => Promise.reject(new Error('no device')));
      expect(await voice.micOn()).toBe("The phone's microphone did not open.");
      expect(voice.micOpen).toBe(false);

      // Mic off while the microphone is still opening keeps nothing of it.
      let open!: (stream: PhoneMicStream) => void;

      media(() => new Promise((resolve) => (open = resolve)));

      const late = voice.micOn();

      voice.micOff();

      const track = new FakeTrack();

      open({ getAudioTracks: () => [track] });
      expect(await late).toBe('The mic was turned off.');
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
        post: async () => ({ status: 200, body: {} }),
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

      expect(await failing.micOn()).toBe('The phone could not connect its microphone to the voice.');
      expect([track.stopped, failing.micOpen, session.type]).toEqual([true, false, 'playback']);

      const { voice, media } = setup();

      media(async () => ({ getAudioTracks: () => [] }));
      expect(await voice.micOn()).toBe("The phone's microphone did not open.");
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
      expect(await first).toBe('The mic was turned off.');
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
