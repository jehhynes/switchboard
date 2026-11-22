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
/**
 * How long an interrupted or suspended audio context may take to run again before the voice leaves this phone. iOS interrupts or suspends
 * the page's audio briefly when the route changes, as Bluetooth earbuds move between playback and play-and-record; a call or Siri keeps it
 * longer. It is shorter than the voice's own stall limit (`PHONE_STALL_MS`), so a phone that recovers keeps the voice and the mic.
 */
export const RECOVER_MS = 5_000;
/** How often the page asks an interrupted or suspended audio context to resume while it waits. */
export const RESUME_RETRY_MS = 500;
/** The first byte of the hub's binary frame of a playback's PCM, as `PHONE_PCM_FRAME` in the hub. */
const PCM_FRAME = 1;
/** The first byte of the page's binary frame of its microphone's PCM, as `PHONE_MIC_FRAME` in the hub. */
export const MIC_FRAME = 2;
/** What the page asks of the phone's microphone: iOS's voice processing, which cancels the page's own playback, at the hardware's rate. */
export const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } } as const;

/** The microphone's track: whether iOS muted it (a call, Siri), and the way to release it. */
export interface PhoneMicTrack {
  readonly muted: boolean;
  readonly readyState: string;
  onmute: (() => void) | null;
  onunmute: (() => void) | null;
  onended: (() => void) | null;
  stop(): void;
}

/** The microphone's stream, as `getUserMedia` gives it. */
export interface PhoneMicStream {
  getAudioTracks(): PhoneMicTrack[];
}

/** The capture worklet's node with the microphone connected: its 16 kHz frames, and the way to disconnect both. */
export interface PhoneCaptureNode {
  readonly port: { onmessage: ((event: { data: Int16Array }) => void) | null };
  disconnect(): void;
}

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
const RESTARTING = 4002;
/**
 * How long the page tries to take the voice back after the hub closed its socket to restart, keeping its audio and microphone meanwhile; the
 * hub that takes over waits 30 s for it (architecture.md § Hub lifecycle).
 */
export const RESUME_MS = 45_000;

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
  /** Opens the microphone; `navigator.mediaDevices.getUserMedia` when left out. */
  media?(constraints: typeof MIC_CONSTRAINTS): Promise<PhoneMicStream>;
  /** Connects the microphone to the capture worklet once it loaded; the browser's nodes when left out. */
  capture?(context: PhoneAudioContext, stream: PhoneMicStream): PhoneCaptureNode;
  /** Whether the page is hidden, and a way to hear it change; the document's when left out. */
  hidden?(): boolean;
  onVisibility?(changed: () => void): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}

/** The phone side of the voice socket: opening it, its `hello`, the clock pings and why it closed. */
export class PhoneVoice {
  state: PhoneVoiceState = 'off';
  /** Why the voice is off after it was on or asked for, or null, as after a hidden page lost it, which needs no word: leaving the page plainly ends talking. */
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
  /** The voice ended with nothing to say, as when a hidden page loses it or the operator turns it off, so a Mic on it cuts short says nothing either. */
  #quiet = false;
  /** While the audio context is interrupted or suspended: since when, and the next resume's timer. */
  #recovering: { since: number; timer: unknown; why: string } | null = null;
  /** The microphone while Mic on holds it, and its capture node once connected. */
  #mic: { stream: PhoneMicStream; track: PhoneMicTrack; node: PhoneCaptureNode | null } | null = null;
  /** Rises at each microphone open and release, so a late open after a release keeps nothing. */
  #micRun = 0;
  /** The hub's voice has the phone's capture open, so frames go out. */
  #capturing = false;
  /** The busy state the hub was last told: true until the page says otherwise. */
  #busySent = true;
  /** The hub's mic was seen on since this microphone opened, so a later off releases it. */
  #micSeenOn = false;
  /** The socket's welcome, which a microphone opened in the same tap waits for. */
  #welcome: { promise: Promise<boolean>; resolve(on: boolean): void } | null = null;
  /** When the audio context resumed, the worklet loaded and the socket was welcomed, for Mic on's timing; null before. */
  #resumedAt: number | null = null;
  #workletAt: number | null = null;
  #welcomedAt: number | null = null;
  /** After the hub closed the socket to restart: the page key the closed socket named, and the timer that gives up taking the voice back. */
  #resuming: { from: string; timer: unknown } | null = null;

  constructor(private readonly deps: PhoneVoiceDeps) {
    const onVisibility = deps.onVisibility ?? ((changed: () => void) => document.addEventListener('visibilitychange', changed));

    onVisibility(() => this.#visibility());
  }

  /**
   * A hidden page loses the voice after {@link HIDDEN_MS}, and it stays off when the page comes back (PRD R119): iOS mutes and suspends a
   * hidden page's audio, so the phone could not play or hear. It goes without an error, since leaving the page plainly ends talking.
   */
  #visibility(): void {
    const hidden = this.deps.hidden?.() ?? document.visibilityState === 'hidden';

    // A hidden page cannot be heard: nothing of what it hears goes on, at once, before the voice leaves it.
    this.#sendBusy();

    if (!hidden || this.state === 'off') {
      this.#clearHidden();
      return;
    }

    this.#hiddenTimer ??= (this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms)))(() => {
      this.#hiddenTimer = null;
      this.#lose(null);
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
   * playback, or to play and record when the tap is Mic on's, so the session's mode never changes under a playback, and the playback worklet
   * loaded.
   */
  #openAudio(origin: string, record: boolean): void {
    const context = this.deps.context?.() ?? (new AudioContext({ latencyHint: 'interactive' }) as unknown as PhoneAudioContext);
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;

    if (session !== undefined) {
      session.type = record ? 'play-and-record' : 'playback';
    }

    this.#context = context;
    this.#resumedAt = null;
    this.#workletAt = null;
    void context.resume().then(() => void (this.#context === context && (this.#resumedAt = this.deps.now()))).catch(() => {
      if (this.#context !== context) {
        return;
      }

      // A route change or a call that interrupts the tap's resume is waited out as any interruption is, and a context that runs since is
      // kept; one that never runs loses the voice once the wait is over, saying the phone did not start its audio.
      if (context.state === 'running') {
        this.#resumedAt ??= this.deps.now();
      } else {
        this.#recover(context, 'Audio did not start on this device.');
      }
    });
    context.onstatechange = () => {
      if (this.#context !== context) {
        return;
      }

      // iOS interrupts or suspends the page's audio when the route changes, as Bluetooth earbuds do, and for a call or Siri: the page resumes
      // it and the worklet plays on from where it stopped; only one that stays stopped loses the voice.
      if (context.state === 'running') {
        this.#clearRecovering();
      } else if (context.state === 'interrupted' || context.state === 'suspended') {
        this.#recover(context);
      }
    };
    this.#node = context.audioWorklet.addModule(`${origin}/page/voice-worklet.js`).then(
      () => {
        if (this.#context !== context) {
          return null;
        }

        this.#workletAt = this.deps.now();

        const node = this.deps.node?.(context) ?? (new AudioWorkletNode(context as unknown as AudioContext, 'sb-play', { outputChannelCount: [1] }) as unknown as PhoneAudioNode);

        node.connect(context.destination);
        node.port.onmessage = (event) => this.#played(context, event.data);
        return node;
      },
      () => {
        if (this.#context === context) {
          this.#lose('Voice audio did not load on this device.');
        }

        return null;
      },
    );
  }

  /**
   * Asks a stopped audio context to resume, again every {@link RESUME_RETRY_MS}, and loses the voice once it stayed stopped for
   * {@link RECOVER_MS}, as when a call holds the phone's audio.
   */
  #recover(context: PhoneAudioContext, why = 'Voice stopped because this device\'s audio did not resume.'): void {
    const recovering = (this.#recovering ??= { since: this.deps.now(), timer: null, why });

    void context.resume().catch(() => undefined);

    if (recovering.timer !== null) {
      return;
    }

    recovering.timer = (this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms)))(() => {
      recovering.timer = null;

      if (this.#context !== context || this.#recovering !== recovering) {
        return;
      }

      if (context.state === 'running') {
        this.#clearRecovering();
      } else if (this.deps.now() - recovering.since >= RECOVER_MS) {
        this.#lose(recovering.why);
      } else {
        this.#recover(context);
      }
    }, RESUME_RETRY_MS);
  }

  #clearRecovering(): void {
    const recovering = this.#recovering;

    this.#recovering = null;

    if (recovering?.timer != null) {
      (this.deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(recovering.timer);
    }
  }

  /**
   * The worklet's report, sent to the hub as heard time: what it played less the output's latency, and the end once that latency passed. It
   * also says what the output took (`out`), from which the voice counts how far ahead it may send, since a Bluetooth output's latency can be
   * longer than that lead.
   */
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
        socket.send(JSON.stringify({ type: 'played', id: report.id, ms: report.done ? ms : Math.max(0, ms - latencyMs), done: report.done, out: ms }));
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

  /** Why Mic on did not open: the voice's error, an empty string when the voice ended with nothing to say, else `fallback`. */
  #why(fallback: string): string {
    return this.error ?? (this.#quiet && this.state === 'off' ? '' : fallback);
  }

  /** The voice left this phone on its own: closed, with why, or null when that needs no word. */
  #lose(why: string | null): void {
    const socket = this.#socket;

    this.#run++;
    this.#stopped();
    this.error = why;
    this.#quiet = why === null;
    socket?.close(1000);
    this.deps.changed();
  }

  /** Opens the voice socket. Called from the tap that asks for the voice, where iOS lets audio start. */
  start(): void {
    this.#start(false);
  }

  /** Opens the voice socket, with the audio session ready to record when `record`, for Mic on's tap. */
  #start(record: boolean): void {
    const key = this.deps.key();

    if (this.state !== 'off' || key === null) {
      return;
    }

    const origin = this.deps.origin?.() ?? location.origin;

    this.#openAudio(origin, record);
    this.#welcome = deferred();
    this.#connect(origin, key, false);
  }

  /**
   * The page's stream has a new key, as after a hub restart: while the voice waits to come back to this phone, the socket opens again with it and
   * asks to take the voice back, with the audio and microphone the tap opened (architecture.md § Hub lifecycle).
   */
  keyChanged(): void {
    const key = this.deps.key();

    if (this.#resuming === null || this.#socket !== null || key === null || key === this.#resuming.from) {
      return;
    }

    this.#connect(this.deps.origin?.() ?? location.origin, key, true);
  }

  /** The hub closed the socket to restart: the audio, the microphone and the welcome a Mic on waits for stay, until the voice comes back or {@link RESUME_MS} passes. */
  #suspend(key: string): void {
    this.#capturing = false;

    if (this.#ping !== null) {
      clearInterval(this.#ping);
      this.#ping = null;
    }

    this.#socket = null;
    this.#welcome = deferred();
    this.state = 'connecting';
    this.error = null;
    this.#quiet = false;
    this.#resuming = {
      from: key,
      timer: (this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms)))(() => this.#lose('Voice did not resume after Switchboard restarted. Select Voice on this device to start it here.'), RESUME_MS),
    };
    this.deps.changed();
    this.keyChanged();
  }

  #clearResuming(): void {
    if (this.#resuming !== null) {
      (this.deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(this.#resuming.timer);
      this.#resuming = null;
    }
  }

  /** Opens the voice socket with the page key; `resume` asks the hub to take the voice back after its restart rather than as a new tap. */
  #connect(origin: string, key: string, resume: boolean): void {
    const url = `${origin.replace(/^http/, 'ws')}/v1/voice/socket?window=${encodeURIComponent(key)}`;
    const socket = this.deps.socket?.(url) ?? new WebSocket(url);
    let welcomed = false;

    this.#run++;
    this.#socket = socket;
    this.state = 'connecting';
    this.error = null;
    this.#quiet = false;
    this.#best = Infinity;
    this.offset = null;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => socket.send(JSON.stringify(resume ? { type: 'hello', resume: true } : { type: 'hello' }));
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

      if (type === 'capture' && typeof message['on'] === 'boolean') {
        this.#capturing = message['on'];
        return;
      }

      if (message['type'] === 'welcome') {
        welcomed = true;
        this.#welcomedAt = this.deps.now();
        this.#clearResuming();
        this.state = 'on';
        this.#pings(socket);
        this.#welcome?.resolve(true);
        this.#busySent = true;
        this.#sendBusy();
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

      // The hub restarts: the voice comes back to this phone from the hub that takes over, with nothing to tap.
      if (event.code === RESTARTING && welcomed) {
        this.#suspend(key);
        return;
      }

      this.#stopped();

      if (event.reason !== '') {
        this.error = event.code === MOVED ? 'Voice is now on another device.' : event.reason;
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

          why(typeof said === 'string' ? said : welcomed ? 'The voice connection closed.' : 'Voice did not start.');
        },
        () => why('Switchboard did not answer.'),
      );
    };
    this.deps.changed();
  }

  /** Closes the voice socket, so the voice is no longer on this phone. */
  stop(): void {
    const socket = this.#socket;

    if (socket === null && this.#resuming === null) {
      return;
    }

    this.#run++;
    this.#stopped();
    this.error = null;
    // Voice off is the operator's own action: a Mic on it cuts short says nothing.
    this.#quiet = true;
    socket?.close(1000);
    this.deps.changed();
  }

  /** Whether the phone's microphone is open, as Mic on opened it. */
  get micOpen(): boolean {
    return this.#mic !== null;
  }

  /**
   * Mic on on this phone, called from its tap (PRD R119): takes the voice to this phone first when it is not here, sets the audio session to
   * play and record before asking for the microphone, as iOS needs to keep replies on the loudspeaker, opens it with iOS's echo cancellation,
   * and connects it to the capture worklet. Resolves null once the microphone is open and the voice socket welcomed, else why not, which is
   * empty when the voice left without a word, as a hidden page loses it. `step` hears when each part was done, for the hub log's timing of the
   * start: those this tap started, and the microphone's permission.
   */
  async micOn(step: (name: string, at: number) => void = () => undefined): Promise<string | null> {
    if (this.#mic !== null) {
      return null;
    }

    const opened = this.state === 'off';

    if (opened) {
      this.#start(true);
    }

    const welcome = this.#welcome;

    if (this.state === 'off' || welcome === null) {
      return this.#why('Voice did not start on this device.');
    }

    const run = ++this.#micRun;
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;

    if (session !== undefined) {
      session.type = 'play-and-record';
    }

    let stream: PhoneMicStream;

    try {
      stream = await (this.deps.media?.(MIC_CONSTRAINTS) ?? (navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS) as unknown as Promise<PhoneMicStream>));
    } catch (error) {
      if (run === this.#micRun) {
        this.#playbackSession();
      } else if (this.error === null && this.#quiet && (this.state as PhoneVoiceState) === 'off') {
        // The voice left without a word while the microphone was asked for, so its refusal says nothing either.
        return '';
      }

      return (error as Error).name === 'NotAllowedError' ? 'Microphone access was not allowed on this device.' : 'The microphone did not open on this device.';
    }

    step('microphone allowed', this.deps.now());

    const track = stream.getAudioTracks()[0];

    if (run !== this.#micRun || track === undefined) {
      for (const one of stream.getAudioTracks()) {
        one.stop();
      }

      if (run === this.#micRun) {
        this.#playbackSession();
      }

      if (run !== this.#micRun) {
        return this.#why('');
      }

      return 'No microphone audio was available on this device.';
    }

    const mic: { stream: PhoneMicStream; track: PhoneMicTrack; node: PhoneCaptureNode | null } = { stream, track, node: null };

    this.#mic = mic;
    this.#micSeenOn = false;
    track.onmute = () => this.#sendBusy();
    track.onunmute = () => this.#sendBusy();
    track.onended = () => this.#sendBusy();

    const welcomed = await welcome.promise;

    // Released meanwhile, perhaps with a newer attempt holding the microphone now: that one is left alone.
    if (this.#mic !== mic) {
      return this.#why('');
    }

    if (!welcomed) {
      this.micOff();
      return this.#why('Voice did not start on this device.');
    }

    const context = this.#context;
    const loaded = await this.#node;

    if (this.#mic !== mic) {
      return this.#why('');
    }

    // The parts the tap that took the voice to this phone started, in the order they were done.
    if (opened) {
      const parts: Array<[string, number | null]> = [['audio resumed', this.#resumedAt], ['voice socket welcomed', this.#welcomedAt], ['audio worklet loaded', this.#workletAt]];

      for (const [name, at] of parts.filter((part): part is [string, number] => part[1] !== null).sort((a, b) => a[1] - b[1])) {
        step(name, at);
      }
    }

    if (context === null || loaded === null) {
      this.micOff();
      return this.#why('Voice audio did not start on this device.');
    }

    let node: PhoneCaptureNode;

    try {
      node = this.deps.capture?.(context, stream) ?? browserCapture(context, stream);
    } catch {
      this.micOff();
      return 'Switchboard could not start microphone capture on this device.';
    }

    node.port.onmessage = (event) => this.#frame(mic, event.data);
    mic.node = node;
    step('capture connected', this.deps.now());
    this.#sendBusy();
    this.deps.changed();
    return null;
  }

  /** Mic off on this phone: the microphone is released, so iOS's indicator and audio routing match, and the audio session plays again. */
  micOff(): void {
    this.#micRun++;
    this.#releaseMic();
    this.#sendBusy();
    this.deps.changed();
  }

  /** The hub's mic as this page's voice view shows it: off after it was on while this phone's microphone is open releases the microphone. */
  viewMic(mic: string): void {
    if (this.#mic === null) {
      return;
    }

    if (mic !== 'off') {
      this.#micSeenOn = true;
    } else if (this.#micSeenOn) {
      this.micOff();
    }
  }

  #releaseMic(): void {
    const mic = this.#mic;

    this.#mic = null;
    this.#micSeenOn = false;

    if (mic === null) {
      return;
    }

    mic.node?.disconnect();
    mic.track.onmute = null;
    mic.track.onunmute = null;
    mic.track.onended = null;

    for (const track of mic.stream.getAudioTracks()) {
      track.stop();
    }

    this.#playbackSession();
  }

  /** Back to playback only, so replies play at full loudness once the microphone is closed, while the voice stays on this phone. */
  #playbackSession(): void {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;

    if (session !== undefined && this.#context !== null) {
      session.type = 'playback';
    }
  }

  /** Whether nothing of the phone's microphone can be heard: none open, its track muted or ended, or the page hidden. */
  #busy(): boolean {
    const mic = this.#mic;
    const hidden = this.deps.hidden?.() ?? document.visibilityState === 'hidden';

    return mic === null || mic.node === null || mic.track.muted || mic.track.readyState === 'ended' || hidden;
  }

  /** Tells the hub when the busy state changed, once the socket is welcomed. */
  #sendBusy(): void {
    const busy = this.#busy();

    if (this.state === 'on' && this.#socket !== null && busy !== this.#busySent) {
      this.#busySent = busy;
      this.#socket.send(JSON.stringify({ type: 'state', busy }));
    }
  }

  /** A 20 ms frame from the capture worklet: sent while the hub's voice has the phone's capture open and the microphone can be heard. */
  #frame(mic: { node: PhoneCaptureNode | null }, samples: Int16Array): void {
    const socket = this.#socket;

    if (this.#mic !== mic || socket === null || this.state !== 'on' || !this.#capturing || this.#busy()) {
      return;
    }

    const frame = new Uint8Array(1 + samples.byteLength);

    frame[0] = MIC_FRAME;
    frame.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 1);
    socket.send(frame.buffer);
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

  /** Ends the pings, the hidden wait and the audio: the microphone, the node, the context, and the audio session back to the browser's choice. */
  #stopped(): void {
    this.#micRun++;
    this.#releaseMic();
    this.#capturing = false;
    this.#clearResuming();
    this.#welcome?.resolve(false);
    this.#welcome = null;

    if (this.#ping !== null) {
      clearInterval(this.#ping);
      this.#ping = null;
    }

    this.#clearHidden();
    this.#clearRecovering();

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

function deferred(): { promise: Promise<boolean>; resolve(on: boolean): void } {
  let resolve!: (on: boolean) => void;
  const promise = new Promise<boolean>((done) => (resolve = done));

  return { promise, resolve };
}

/** The browser's microphone source connected to the capture worklet, whose silent output keeps it pulled by the speaker. */
function browserCapture(context: PhoneAudioContext, stream: PhoneMicStream): PhoneCaptureNode {
  const audio = context as unknown as AudioContext;
  const source = audio.createMediaStreamSource(stream as unknown as MediaStream);
  const node = new AudioWorkletNode(audio, 'sb-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });

  source.connect(node);
  node.connect(audio.destination);

  return {
    port: node.port as unknown as PhoneCaptureNode['port'],
    disconnect: () => {
      source.disconnect();
      node.disconnect();
    },
  };
}
