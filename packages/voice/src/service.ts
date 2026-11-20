import type { VoiceSettings } from '@switchboard/core/settings';
import { DEFAULT_SETTINGS } from '@switchboard/core/settings';
import type { Output } from './output.js';
import type { HubMessage, VoiceMessage } from './protocol.js';
import { Router } from './routing.js';
import { Speech } from './speech.js';
import type { Speaking, TtsVoiceSettings } from './tts.js';

export interface VoiceServiceDeps {
  tts: { configure(settings: TtsVoiceSettings): void; warm(): void; speak(text: string, tone: string | null, onAudio: (pcm: Buffer) => void): Speaking; close(): void };
  output: Output;
  send(message: VoiceMessage): void;
  now(): number;
  log(line: string): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
  every?(run: () => void, ms: number): { stop(): void };
}

/**
 * The voice process's work (architecture.md § Voice): the target, from the hub's targets and focus and Talk here, and speech of the replies the
 * hub offers for the current generation. A `speak` of an older generation, or for a session that is not the target, is dropped.
 */
export class VoiceService {
  #settings: VoiceSettings = DEFAULT_SETTINGS.voice;
  #error: string | null = null;
  readonly #router: Router;
  readonly #speech: Speech;

  constructor(private readonly deps: VoiceServiceDeps) {
    this.#speech = new Speech({
      tts: deps.tts,
      output: deps.output,
      device: () => this.#settings.outputDevice,
      report: (message) => deps.send(message),
      failed: (error) => this.#failed(error),
      now: deps.now,
      log: deps.log,
      ...(deps.every === undefined ? {} : { every: deps.every }),
    });
    this.#router = new Router({
      changed: (gen, sessionId, reason) => {
        this.#speech.halt();
        deps.log(`voice target ${sessionId ?? 'none'} (${reason}), generation ${gen}`);
        deps.send({ type: 'active', gen, sessionId, reason });

        if (sessionId !== null) {
          deps.tts.warm();
        }
      },
      awayMs: () => this.#settings.awayMinutes * 60_000,
      ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
      ...(deps.clearTimer === undefined ? {} : { clearTimer: deps.clearTimer }),
    });
  }

  /** What a newly connected hub is told: the target and the playback state. */
  greeting(): VoiceMessage[] {
    return [
      { type: 'active', gen: this.#router.gen, sessionId: this.#router.target, reason: this.#router.target === null ? 'gone' : 'focus' },
      this.#audio(),
    ];
  }

  receive(message: HubMessage): void {
    switch (message.type) {
      case 'targets':
        this.#router.update(message.targets, message.focus);
        return;
      case 'talk-here':
        if (!this.#router.talkHere(message.sessionId)) {
          this.deps.log(`talk here refused: session ${message.sessionId} is not a voice target`);
        }

        return;
      case 'settings':
        this.#settings = { ...DEFAULT_SETTINGS.voice, ...message.settings };
        this.deps.tts.configure({ voice: this.#settings.voice, style: this.#settings.style, speed: this.#settings.speed, expressive: this.#settings.expressive });
        return;
      case 'speak':
        if (message.gen !== this.#router.gen || message.sessionId !== this.#router.target) {
          this.deps.log(`reply ${message.replyId} dropped: generation ${message.gen} is not ${this.#router.gen}`);
          return;
        }

        this.#speech.speak({ gen: message.gen, replyId: message.replyId, sessionId: message.sessionId, text: message.text, tone: message.tone, turn: message.turn });
        return;
      case 'cancel':
        this.#speech.cancel(message.replyId);
        return;
      case 'stop':
        this.#speech.stop();
        return;
      case 'earcon':
        this.#speech.earcon();
        return;
      default:
        return;
    }
  }

  close(): void {
    this.#router.close();
    this.#speech.halt();
    this.deps.tts.close();
  }

  #failed(error: string | null): void {
    if (error !== this.#error) {
      this.#error = error;
      this.deps.send(this.#audio());
    }
  }

  #audio(): VoiceMessage {
    return { type: 'audio', mic: 'off', engine: this.deps.output.engine, device: this.#settings.outputDevice, error: this.#error };
  }
}
