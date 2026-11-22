/**
 * Voice on this phone (architecture.md § Remote access, Voice on a phone): the page of a paired device holds the hub's voice socket, through
 * which the voice process uses the phone's microphone and speaker. Only a device the computer allowed voice on may open it; the computer's
 * page never does, since its voice is the computer's own.
 */

import type { PlayCommand, PlayReport } from './voiceWorklet.js';
import { PLAY_RATE } from './voiceWorklet.js';

type Answer = { status: number; body: Record<string, unknown> };

/** A hidden page loses the voice after this long, since iOS soon suspends it and stops its audio (PRD R119). */
export const HIDDEN_MS = 3_000;
/** The first byte of the hub's binary frame of a playback's PCM, as `PHONE_PCM_FRAME` in the hub. */
const PCM_FRAME = 1;

/** The parts of the browser's audio the page uses; the browser's, fakes in tests. */
export interface PhoneAudioContext {
  readonly state: string;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  readonly destination: unknown;
  readonly audioWorklet: { addModule(url: string): Promise<void> };
  onstatechange: (() => void) | null;
  resume(): Promise<void>;
  close(): Promise<void>;
}

/** The playback worklet's node: its port and its connection to the speaker. */
export interface PhoneAudioNode {
  readonly port: { postMessage(message: PlayCommand, transfer?: Transferable[]): void; onmessage: ((event: { data: PlayReport }) => void) | null };
  connect(destination: unknown): void;
  disconnect(): void;
}

/** Where the phone's voice is: off, opening the socket, or on. */
export type PhoneVoiceState = 'off' | 'connecting' | 'on';

/** How often the page asks the hub's time, for the offset between the phone's clock and the hub's. */
export const PING_MS = 5_000;

/** The close codes the hub gives a reason with, as `VOICE_CLOSE` in the hub's voice socket. */
const MOVED = 4001;

export interface PhoneVoiceDeps {
  /** The page key the hub gave this page's stream, or null before its `hello`. */
  key(): string | null;
  post(name: string, body: Record<string, unknown>): Promise<Answer>;
  /** The state or the error changed. */
  changed(): void;
  now(): number;
  /** Opens a WebSocket; the browser's, a fake in tests. */
  socket?(url: string): WebSocket;
  /** The page's origin, `https://<host>` through a remote host. */
  origin?(): string;
  /** Makes the audio context in the tap; the browser's `AudioContext` when left out. */
  context?(): PhoneAudioContext;
  /** Makes the playback node once the worklet loaded; the browser's `AudioWorkletNode` when left out. */
  node?(context: PhoneAudioContext): PhoneAudioNode;
  /** Whether the page is hidden, and a way to hear it change; the document's when left out. */
  hidden?(): boolean;
  onVisibility?(changed: () => void): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}

/** The phone side of the voice socket: opening it, its `hello`, the clock pings and why it closed. */
export class PhoneVoice {
  state: PhoneVoiceState = 'off';
  /** Why the voice is off after it was on or asked for, or null. */
  error: string | null = null;
  /** The hub's clock less the phone's, from the fastest ping, or null before one. */
  offset: number | null = null;
  #socket: WebSocket | null = null;
  #ping: ReturnType<typeof setInterval> | null = null;
  #best = Infinity;
  /** Rises at each start and stop, so a late answer about an earlier socket changes nothing. */
  #run = 0;
  #context: PhoneAudioContext | null = null;
  /** The playback node once its worklet loaded; commands wait for it in order. */
  #node: Promise<PhoneAudioNode | null> = Promise.resolve(null);
  #hiddenTimer: unknown = null;

  constructor(private readonly deps: PhoneVoiceDeps) {
    const onVisibility = deps.onVisibility ?? ((changed: () => void) => document.addEventListener('visibilitychange', changed));

    onVisibility(() => this.#visibility());
  }

  /**
   * A hidden page loses the voice after {@link HIDDEN_MS}, and it stays off when the page comes back (PRD R119): iOS mutes and suspends a
   * hidden page's audio, so the phone could not play or hear.
   */
  #visibility(): void {
    const hidden = this.deps.hidden?.() ?? document.visibilityState === 'hidden';

    if (!hidden || this.state === 'off') {
      this.#clearHidden();
      return;
    }

    this.#hiddenTimer ??= (this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms)))(() => {
      this.#hiddenTimer = null;
      this.#lose('The page was hidden, so the voice left this phone.');
    }, HIDDEN_MS);
  }

  #clearHidden(): void {
    if (this.#hiddenTimer !== null) {
      (this.deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(this.#hiddenTimer);
      this.#hiddenTimer = null;
    }
  }

  /**
   * The phone's speaker, opened in the tap, as iOS requires: the audio context resumed in the tap's own call, the audio session set to
   * playback, and the playback worklet loaded.
   */
  #openAudio(origin: string): void {
    const context = this.deps.context?.() ?? (new AudioContext({ latencyHint: 'interactive' }) as unknown as PhoneAudioContext);
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;

    if (session !== undefined) {
      session.type = 'playback';
    }

    this.#context = context;
    void context.resume().catch(() => {
      if (this.#context === context) {
        this.#lose('The phone did not start its audio.');
      }
    });
    context.onstatechange = () => {
      // iOS interrupts the page's audio for a call or Siri: the voice leaves the phone, as when it is lost.
      if (this.#context === context && context.state === 'interrupted') {
        this.#lose('The phone took its audio, as for a call, so the voice left this phone.');
      }
    };
    this.#node = context.audioWorklet.addModule(`${origin}/page/voice-worklet.js`).then(
      () => {
        if (this.#context !== context) {
          return null;
        }

        const node = this.deps.node?.(context) ?? (new AudioWorkletNode(context as unknown as AudioContext, 'sb-play', { outputChannelCount: [1] }) as unknown as PhoneAudioNode);

        node.connect(context.destination);
        node.port.onmessage = (event) => this.#played(context, event.data);
        return node;
      },
      () => {
        if (this.#context === context) {
          this.#lose('The phone could not load the voice\'s audio.');
        }

        return null;
      },
    );
  }

  /** The worklet's report, sent to the hub as heard time: what it played less the output's latency, and the end once that latency passed. */
  #played(context: PhoneAudioContext, report: PlayReport): void {
    // A report of a context the page closed since belongs to no playback of the socket open now.
    if (this.#context !== context) {
      return;
    }

    const latencyMs = ((context.outputLatency ?? 0) + (context.baseLatency ?? 0)) * 1000;
    const ms = (report.frames * 1000) / PLAY_RATE;
    const socket = this.#socket;
    const send = (): void => {
      if (this.#socket === socket && this.#context === context && socket !== null) {
        socket.send(JSON.stringify({ type: 'played', id: report.id, ms: report.done ? ms : Math.max(0, ms - latencyMs), done: report.done }));
      }
    };

    if (report.done) {
      (this.deps.setTimer ?? ((run, wait) => setTimeout(run, wait)))(send, latencyMs);
    } else {
      send();
    }
  }

  /** A command for the playback worklet, after those before it. */
  #play(command: PlayCommand, transfer: Transferable[] = []): void {
    this.#node = this.#node.then((node) => {
      node?.port.postMessage(command, transfer);
      return node;
    });
  }

  /** The voice left this phone on its own: closed, with why. */
  #lose(why: string): void {
    const socket = this.#socket;

    this.#run++;
    this.#stopped();
    this.error = why;
    socket?.close(1000);
    this.deps.changed();
  }

  /** Opens the voice socket. Called from the tap that asks for the voice, where iOS lets audio start. */
  start(): void {
    const key = this.deps.key();

    if (this.state !== 'off' || key === null) {
      return;
    }

    const origin = this.deps.origin?.() ?? location.origin;
    const url = `${origin.replace(/^http/, 'ws')}/v1/voice/socket?window=${encodeURIComponent(key)}`;

    this.#openAudio(origin);
    const socket = this.deps.socket?.(url) ?? new WebSocket(url);
    let welcomed = false;

    this.#run++;
    this.#socket = socket;
    this.state = 'connecting';
    this.error = null;
    this.#best = Infinity;
    this.offset = null;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello' }));
    socket.onmessage = (event: MessageEvent) => {
      if (this.#socket !== socket) {
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        this.#binary(event.data);
        return;
      }

      if (typeof event.data !== 'string') {
        return;
      }

      const message = JSON.parse(event.data) as Record<string, unknown>;
      const type = message['type'];
      const id = message['id'];

      if ((type === 'play' || type === 'end' || type === 'flush') && typeof id === 'number') {
        this.#play({ type: type === 'play' ? 'open' : type, id });
        return;
      }

      if (message['type'] === 'welcome') {
        welcomed = true;
        this.state = 'on';
        this.#pings(socket);
        this.deps.changed();
      } else if (message['type'] === 'pong' && typeof message['t'] === 'number' && typeof message['at'] === 'number') {
        const now = this.deps.now();
        const trip = now - message['t'];

        // The fastest round trip gives the best estimate of the hub's clock.
        if (trip <= this.#best) {
          this.#best = trip;
          this.offset = message['at'] - (message['t'] + trip / 2);
        }
      }
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.#socket !== socket) {
        return;
      }

      this.#stopped();

      if (event.reason !== '') {
        this.error = event.code === MOVED ? 'Voice moved to another device.' : event.reason;
        this.deps.changed();
        return;
      }

      // A refused upgrade gives the page no reason, so it asks the hub why; an answer after the voice was asked for again is dropped.
      const run = this.#run;
      const why = (error: string): void => {
        if (run === this.#run) {
          this.error = error;
          this.deps.changed();
        }
      };

      void this.deps.post('page-voice-state', {}).then(
        (answer) => {
          const said = answer.status === 200 ? answer.body['error'] : null;

          why(typeof said === 'string' ? said : welcomed ? 'The voice connection closed.' : 'Switchboard did not open the voice.');
        },
        () => why('Switchboard did not answer.'),
      );
    };
    this.deps.changed();
  }

  /** Closes the voice socket, so the voice is no longer on this phone. */
  stop(): void {
    const socket = this.#socket;

    if (socket === null) {
      return;
    }

    this.#run++;
    this.#stopped();
    this.error = null;
    socket.close(1000);
    this.deps.changed();
  }

  /** A binary frame from the hub: a playback's PCM after its kind and number. */
  #binary(data: ArrayBuffer): void {
    const view = new DataView(data);

    if (data.byteLength < 5 || view.getUint8(0) !== PCM_FRAME) {
      return;
    }

    const samples = new Int16Array(data.slice(5, 5 + ((data.byteLength - 5) & ~1)));

    this.#play({ type: 'pcm', id: view.getUint32(1, true), samples }, [samples.buffer]);
  }

  #pings(socket: WebSocket): void {
    const ping = (): void => socket.send(JSON.stringify({ type: 'ping', t: this.deps.now() }));

    ping();
    this.#ping = setInterval(ping, PING_MS);
  }

  /** Ends the pings, the hidden wait and the audio: the node, the context, and the audio session back to the browser's choice. */
  #stopped(): void {
    if (this.#ping !== null) {
      clearInterval(this.#ping);
      this.#ping = null;
    }

    this.#clearHidden();

    const context = this.#context;

    this.#context = null;

    if (context !== null) {
      void this.#node.then((node) => node?.disconnect());
      this.#node = Promise.resolve(null);
      context.onstatechange = null;
      void context.close().catch(() => undefined);

      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;

      if (session !== undefined) {
        session.type = 'auto';
      }
    }

    this.#socket = null;
    this.state = 'off';
  }
}
