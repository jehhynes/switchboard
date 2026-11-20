import type { VoiceSettings } from '@switchboard/core/settings';
import { DEFAULT_SETTINGS } from '@switchboard/core/settings';
import { pcm24to16, splitSaid } from './barge.js';
import type { Dictation } from './dictation.js';
import type { Output } from './output.js';
import type { LockEvent, LockWatch } from './lockWatch.js';
import type { AwayReason, HubMessage, Interrupted, VoiceMessage, VoiceTarget } from './protocol.js';
import { PlayedReference } from './reference.js';
import { Router } from './routing.js';
import { Speech } from './speech.js';
import { BYTES_PER_MS } from './tts.js';
import type { Speaking, SpeechVoice, TtsVoiceSettings } from './tts.js';
import type { Voiceprint } from './voiceprint.js';

/** The first 3 s of each reply's audio teach barge-in that reply voice's print. */
const LEARN_BYTES = 3_000 * BYTES_PER_MS;

/** What `voice.log` says when the operator leaves the computer, and when each reason ends. */
const AWAY_TEXT: Record<AwayReason, string> = { locked: 'computer locked', asleep: 'computer going to sleep', disconnected: 'session disconnected' };
const AWAY_ERROR: Record<AwayReason, string> = { locked: 'The computer is locked.', asleep: 'The computer is going to sleep.', disconnected: 'The session is disconnected.' };
const BACK_TEXT: Record<'unlocked' | 'awake' | 'connected', string> = { unlocked: 'computer unlocked', awake: 'computer awake', connected: 'session connected' };

export interface VoiceServiceDeps {
  tts: { configure(settings: TtsVoiceSettings): void; warm(): void; speak(text: string, tone: string | null, onAudio: (pcm: Buffer) => void, as?: SpeechVoice): Speaking; close(): void };
  output: Output;
  /** Dictation (architecture.md § Dictation), made with the service's hooks; without it the mic stays off. */
  dictation?: (hooks: {
    changed(): void;
    spoke(): void;
    send(message: VoiceMessage): void;
    playing(): { replyId: string; text: string; voice: string } | null;
    playedUntil(): number;
    interrupt(): Interrupted | null;
  }) => Dictation;
  /** Learns the reply voices' prints from the audio played, for barge-in; none when left out. */
  voiceprint?: Voiceprint;
  /** A reply's heard tag, for the glossary. */
  heard?(heard: string, meant: string): void;
  /** Starts watching for the operator leaving the computer: a lock, sleep or a disconnected session; null or left out where nothing watches. */
  watchLock?(changed: (event: LockEvent) => void): LockWatch | null;
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
  readonly #dictation: Dictation | null;
  #targets = new Map<string, VoiceTarget>();
  /** The audio of the reply playing, kept until there is enough to learn its voice from. */
  #learning: { replyId: string; voice: string; chunks: Buffer[]; bytes: number } | null = null;
  /** Why the operator is away from the computer; while any holds, the mic stays off and nothing plays. */
  readonly #away = new Set<AwayReason>();
  /** Why the process last turned the mic off on its own, until the operator sets the mic again; a restored mic stays off meanwhile. */
  #turnedOff: AwayReason | null = null;
  readonly #lockWatch: LockWatch | null;

  constructor(private readonly deps: VoiceServiceDeps) {
    this.#dictation =
      deps.dictation?.({
        changed: () => deps.send(this.#audio()),
        spoke: () => this.#router.spoke(),
        send: (message) => deps.send(message),
        playing: () => {
          const item = this.#speech.playing;

          return item === null ? null : { replyId: item.replyId, text: item.text, voice: item.as?.voice ?? this.#settings.voice };
        },
        playedUntil: () => this.#speech.playedUntil,
        interrupt: () => {
          const stopped = this.#speech.interrupt();

          return stopped === null ? null : { replyId: stopped.item.replyId, ...splitSaid(stopped.item.text, stopped.said) };
        },
      }) ?? null;
    // What plays is also the echo canceller's reference, handed over as it plays, so a reply played aloud is not heard as the operator.
    const output: Output = {
      engine: deps.output.engine,
      open: async (device) => {
        const playback = await deps.output.open(device);
        const reference = new PlayedReference({
          push: (pcm) => this.#dictation?.reference(pcm),
          now: deps.now,
          ...(deps.every === undefined ? {} : { every: deps.every }),
        });

        return {
          write: (pcm) => {
            reference.written(pcm);
            this.#learn(pcm);
            return playback.write(pcm);
          },
          drain: () => playback.drain(),
          stop: () => {
            reference.stop();
            playback.stop();
          },
        };
      },
    };

    this.#speech = new Speech({
      tts: deps.tts,
      output,
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
        this.#dictation?.target(gen, sessionId, sessionId === null ? null : (this.#targets.get(sessionId)?.repo ?? null));

        if (sessionId !== null) {
          deps.tts.warm();
        }
      },
      awayMs: () => this.#settings.awayMinutes * 60_000,
      ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
      ...(deps.clearTimer === undefined ? {} : { clearTimer: deps.clearTimer }),
    });
    this.#lockWatch = deps.watchLock?.((event) => this.#lockChanged(event)) ?? null;
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
        this.#targets = new Map(message.targets.map((target) => [target.sessionId, target]));
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
        this.#dictation?.settingsChanged();

        // With voice turned off nothing listens, whatever the mic was set to.
        if (!this.#settings.enabled) {
          this.#dictation?.mic(false);
        }

        return;
      case 'mic':
        if (message.on && (this.#away.size > 0 || (message.restore === true && this.#turnedOff !== null))) {
          const reason = [...this.#away][0] ?? this.#turnedOff!;

          this.deps.log(`mic stays off: ${AWAY_TEXT[reason]}`);
          this.deps.send({ type: 'mic-off', reason });
          return;
        }

        if (message.restore !== true) {
          this.#turnedOff = null;
        }

        this.#dictation?.mic(message.on);
        return;
      case 'typing':
        this.#dictation?.typing(message.on);
        return;
      case 'context':
        this.#dictation?.context(message.sessionId, message.lastReply);
        return;
      case 'heard':
        this.deps.heard?.(message.heard, message.meant);
        return;
      case 'enroll':
        if (message.action === 'start' && this.#away.size > 0) {
          this.deps.send({ type: 'enrollment', state: 'failed', error: AWAY_ERROR[[...this.#away][0]!] });
          return;
        }

        if (this.#dictation === null) {
          if (message.action === 'start') {
            this.deps.send({ type: 'enrollment', state: 'failed', error: 'Capture is not available.' });
          }
        } else {
          this.#dictation.enroll(message.action);
        }

        return;
      case 'speak':
        if (message.gen !== this.#router.gen || message.sessionId !== this.#router.target) {
          this.deps.log(`reply ${message.replyId} dropped: generation ${message.gen} is not ${this.#router.gen}`);
          return;
        }

        this.#speech.speak({ gen: message.gen, replyId: message.replyId, sessionId: message.sessionId, text: message.text, tone: message.tone, turn: message.turn, as: { voice: message.voice, style: message.style, personality: message.personality } });
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

  /** The settings, as the hub last sent them, for dictation. */
  get settings(): VoiceSettings {
    return this.#settings;
  }

  close(): void {
    this.#lockWatch?.close();
    this.#dictation?.close();
    this.#router.close();
    this.#speech.halt();
    this.deps.tts.close();
  }

  /** Collects the first 3 s of the playing reply's audio, then learns its voice's print from it. */
  #learn(pcm: Buffer): void {
    const item = this.#speech.playing;

    if (this.deps.voiceprint === undefined || item === null) {
      return;
    }

    if (this.#learning?.replyId !== item.replyId) {
      this.#learning = { replyId: item.replyId, voice: item.as?.voice ?? this.#settings.voice, chunks: [], bytes: 0 };
    }

    const learning = this.#learning;

    if (learning.bytes >= LEARN_BYTES) {
      return;
    }

    learning.chunks.push(pcm);
    learning.bytes += pcm.length;

    if (learning.bytes >= LEARN_BYTES) {
      this.deps.voiceprint.learnVoice(learning.voice, pcm24to16(Buffer.concat(learning.chunks).subarray(0, LEARN_BYTES)));
      learning.chunks = [];
    }
  }

  /**
   * The operator left the computer (architecture.md § Dictation): the mic goes off, with any enrolment, and speech stops and stays silent until
   * every reason has ended; an unlock ends them all, since the operator is back at an unlocked session. The mic stays off until they turn it on.
   */
  #lockChanged(event: LockEvent): void {
    if (event === 'locked' || event === 'asleep' || event === 'disconnected') {
      if (this.#away.has(event)) {
        return;
      }

      this.#away.add(event);
      this.#turnedOff = event;
      this.deps.log(`mic off: ${AWAY_TEXT[event]}`);
      this.#dictation?.enroll('cancel');
      this.#dictation?.mic(false);
      this.#speech.mute(true);
      this.deps.send({ type: 'mic-off', reason: event });
      return;
    }

    const size = this.#away.size;

    if (event === 'unlocked') {
      this.#away.clear();
    } else {
      this.#away.delete(event === 'awake' ? 'asleep' : 'disconnected');
    }

    if (this.#away.size === size) {
      return;
    }

    if (this.#away.size === 0) {
      this.#speech.mute(false);
      this.deps.log(`${BACK_TEXT[event]}: speech resumes; the mic stays off until it is turned on`);
    } else {
      this.deps.log(`${BACK_TEXT[event]}: still ${[...this.#away].map((reason) => AWAY_TEXT[reason]).join(', ')}`);
    }
  }

  #failed(error: string | null): void {
    if (error !== this.#error) {
      this.#error = error;
      this.deps.send(this.#audio());
    }
  }

  #audio(): VoiceMessage {
    const halfDuplex = this.#dictation?.halfDuplex ?? null;

    return {
      type: 'audio',
      mic: this.#dictation?.state ?? 'off',
      engine: this.deps.output.engine,
      device: this.#dictation === null ? this.#settings.outputDevice : this.#settings.inputDevice,
      recognizer: this.#dictation?.recognizer ?? null,
      error: this.#dictation?.error ?? this.#error,
      ...(halfDuplex === null ? {} : { halfDuplex }),
    };
  }
}
