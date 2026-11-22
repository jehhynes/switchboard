/**
 * Voice on this phone (architecture.md § Remote access, Voice on a phone): the page of a paired device holds the hub's voice socket, through
 * which the voice process uses the phone's microphone and speaker. Only a device the computer allowed voice on may open it; the computer's
 * page never does, since its voice is the computer's own.
 */

type Answer = { status: number; body: Record<string, unknown> };

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

  constructor(private readonly deps: PhoneVoiceDeps) {}

  /** Opens the voice socket. Called from the tap that asks for the voice, where iOS lets audio start. */
  start(): void {
    const key = this.deps.key();

    if (this.state !== 'off' || key === null) {
      return;
    }

    const origin = this.deps.origin?.() ?? location.origin;
    const url = `${origin.replace(/^http/, 'ws')}/v1/voice/socket?window=${encodeURIComponent(key)}`;
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
      if (typeof event.data !== 'string' || this.#socket !== socket) {
        return;
      }

      const message = JSON.parse(event.data) as Record<string, unknown>;

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

  #pings(socket: WebSocket): void {
    const ping = (): void => socket.send(JSON.stringify({ type: 'ping', t: this.deps.now() }));

    ping();
    this.#ping = setInterval(ping, PING_MS);
  }

  #stopped(): void {
    if (this.#ping !== null) {
      clearInterval(this.#ping);
      this.#ping = null;
    }

    this.#socket = null;
    this.state = 'off';
  }
}
