import type { VoiceSettings } from '@switchboard/core/settings';
import { DEFAULT_SETTINGS } from '@switchboard/core/settings';
import { Alerts } from './alerts.js';
import { pcm24to16, splitSaid } from './barge.js';
import type { Dictation, DictationDeps } from './dictation.js';
import type { Capture, Output } from './output.js';
import type { LockEvent, LockWatch } from './lockWatch.js';
import type { AwayReason, HubMessage, Interrupted, VoiceDevice, VoiceFocus, VoiceMessage, VoiceTarget } from './protocol.js';
import { PhoneCapture, PhoneOutput } from './phone.js';
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
/** Why nothing plays or listens after the phone that had the voice disconnected. */
const PHONE_GONE = 'Voice is off.';
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
    /** The capture to use: this computer's, or the phone's while the phone has the voice (architecture.md § Remote access, Voice on a phone). */
    capture(computer: Capture): Capture;
    /** The other-app watcher to use: this computer's, or the phone's own busy state while the phone has the voice. */
    watchMicUse(computer: DictationDeps['watchMicUse']): DictationDeps['watchMicUse'];
    /** Whether a device has the voice: none after the phone left. */
    listenable(): boolean;
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
  readonly #alerts: Alerts;
  #targets = new Map<string, VoiceTarget>();
  #focus: VoiceFocus = null;
  /** The audio of the reply playing, kept until there is enough to learn its voice from. */
  #learning: { replyId: string; voice: string; chunks: Buffer[]; bytes: number } | null = null;
  /** Why the operator is away from the computer; while any holds, the mic stays off and nothing plays. */
  readonly #away = new Set<AwayReason>();
  /** Why the process last turned the mic off on its own, until the operator sets the mic again; a restored mic stays off meanwhile. */
  #turnedOff: AwayReason | null = null;
  readonly #lockWatch: LockWatch | null;
  /** Where the voice's microphone and speaker are (architecture.md § Remote access, Voice on a phone). */
  #device: VoiceDevice = 'computer';
  /** The phone's speaker, used while the phone has the voice. */
  readonly #phone: PhoneOutput;
  /** The phone's microphone, used while the phone has the voice. */
  readonly #phoneCapture: PhoneCapture;
  /** Whether the phone's microphone cannot be heard, as its page last said: true until it says otherwise, and after each move. */
  #phoneBusy = true;
  /** The phone's busy state's listener while dictation watches it, in place of this computer's other-app watcher. */
  #phoneWatch: ((busy: boolean, apps: string[]) => void) | null = null;

  constructor(private readonly deps: VoiceServiceDeps) {
    this.#phone = new PhoneOutput({
      send: (message) => deps.send(message),
      now: deps.now,
      ...(deps.every === undefined ? {} : { every: deps.every }),
      stalled: (reason) => deps.send({ type: 'phone-stalled', reason }),
    });
    this.#phoneCapture = new PhoneCapture({ send: (message) => deps.send(message) });
    this.#dictation =
      deps.dictation?.({
        changed: () => deps.send(this.#audio()),
        spoke: () => this.#router.spoke(),
        send: (message) => deps.send(message),
        playing: () => {
          const item = this.#speech.playing;

          // An alert line counts too, so words heard over it are held as its possible echo and it never answers itself.
          return item === null ? null : { replyId: item.replyId, text: item.text, voice: item.as?.voice ?? this.#settings.voice };
        },
        playedUntil: () => this.#speech.playedUntil,
        interrupt: () => {
          // The operator talking over an alert line is its answer: the line plays on, and the utterance names no reply.
          if (this.#speech.playing?.line !== undefined) {
            return null;
          }

          const stopped = this.#speech.interrupt();

          return stopped === null ? null : { replyId: stopped.item.replyId, ...splitSaid(stopped.item.text, stopped.said) };
        },
        capture: (computer) => ({
          open: (device, onPcm, onError) => {
            if (this.#device === 'none') {
              return Promise.reject(new Error(PHONE_GONE));
            }

            return this.#device === 'phone' ? this.#phoneCapture.open(device, onPcm, onError) : computer.open(device, onPcm, onError);
          },
        }),
        watchMicUse: (computer) => (changed, failed, devices) => (this.#device === 'phone' ? this.#watchPhone(changed) : computer(changed, failed, devices)),
        listenable: () => this.#device !== 'none',
      }) ?? null;
    // What plays is also the echo canceller's reference, handed over as it plays, so a reply played aloud is not heard as the operator.
    const output: Output = {
      engine: deps.output.engine,
      open: async (device) => {
        if (this.#device === 'none') {
          throw new Error(PHONE_GONE);
        }

        const playback = this.#device === 'phone' ? await this.#phone.open() : await deps.output.open(device);
        // A phone's playback is timed by what the phone reports heard, not by when it was written (Voice on a phone).
        const reference = new PlayedReference({
          push: (pcm) => this.#dictation?.reference(pcm),
          now: deps.now,
          ...(playback.position === undefined ? {} : { played: () => playback.position!() }),
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
          ...(playback.position === undefined ? {} : { position: () => playback.position!() }),
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
      hold: () => this.#dictation?.replyHold?.() ?? { ms: 0, verified: false },
      ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
      ...(deps.clearTimer === undefined ? {} : { clearTimer: deps.clearTimer }),
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
    this.#alerts = new Alerts({
      say: (id, text, as, done) => this.#speech.say({ gen: this.#router.gen, replyId: id, sessionId: id, text, tone: null, turn: null, as, line: done }),
      unsay: (id) => this.#speech.cancel(id),
      quiet: () => this.#speech.idle,
      playedUntil: () => this.#speech.playedUntil,
      hearing: () => this.#dictation?.hearing ?? false,
      waitReason: () => this.#alertWait(),
      answerable: () => this.#settings.enabled && this.#away.size === 0 && (this.#dictation?.answerable ?? false),
      listen: (answer, accepted) => this.#dictation?.listen(answer, accepted),
      talkHere: (sessionId) => this.#router.talkHere(sessionId),
      inFocus: (sessionId) => this.#router.target === sessionId || this.#focus?.sessionId === sessionId,
      settings: () => this.#settings,
      send: (message) => deps.send(message),
      now: deps.now,
      log: deps.log,
      ...(deps.every === undefined ? {} : { every: deps.every }),
    });
    this.#lockWatch = deps.watchLock?.((event) => this.#lockChanged(event)) ?? null;
  }

  /** Why spoken alerts wait now: someone else is talking in the room, another app records, or an enrolment records; null when they may play. */
  #alertWait(): string | null {
    const dictation = this.#dictation;

    if (dictation === null) {
      return null;
    }

    return dictation.roomHold != null ? 'room hold' : dictation.otherAppRecording ? 'another app is recording' : dictation.enrolling ? 'enrolment' : null;
  }

  /**
   * What a newly connected hub is told: the target, the playback state and the device. A hub that started again knows no device of its own, so
   * it learns here that the phone that had the voice left (PRD R119, decision 1).
   */
  greeting(): VoiceMessage[] {
    return [
      { type: 'active', gen: this.#router.gen, sessionId: this.#router.target, reason: this.#router.target === null ? 'gone' : 'focus' },
      this.#audio(),
      { type: 'device', device: this.#device },
    ];
  }

  receive(message: HubMessage): void {
    switch (message.type) {
      case 'targets':
        this.#targets = new Map(message.targets.map((target) => [target.sessionId, target]));
        this.#focus = message.focus;
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

        if (!this.#settings.enabled || !this.#settings.spokenAlerts) {
          this.#alerts.cancelAll('spoken alerts are off');
        }

        return;
      case 'mic':
        if (message.on && this.#device === 'none') {
          this.deps.log('mic stays off: the phone that had the voice left');
          return;
        }

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
        // Enrolment records this computer's microphone only (PRD R119).
        if (message.action === 'start' && this.#device !== 'computer') {
          this.deps.send({ type: 'enrollment', state: 'failed', error: 'Select Voice on the computer before recording your voice.' });
          return;
        }

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
        this.#speech.cancel(message.replyId, message.off === true);
        return;
      case 'stop':
        this.#speech.stop();
        return;
      case 'earcon':
        this.#speech.earcon();
        return;
      case 'alert':
        if (this.#away.size > 0) {
          this.deps.send({ type: 'alert-done', alertId: message.alertId, sessionId: message.sessionId, outcome: 'cancelled' });
          return;
        }

        this.#alerts.add({ alertId: message.alertId, sessionId: message.sessionId, cause: message.cause, title: message.title, persona: message.persona, detail: message.detail, as: { voice: message.voice, style: message.style, personality: message.personality } });
        return;
      case 'alert-cancel':
        this.#alerts.cancel(message.alertId);
        return;
      case 'device':
        this.#deviceChanged(message.device);
        return;
      case 'phone-played':
        this.#phone.played(message.id, message.ms, message.done, message.out);
        return;
      case 'phone-mic':
        if (this.#device === 'phone') {
          this.#phoneCapture.pcm(Buffer.from(message.pcm, 'base64'));
        }

        return;
      case 'phone-state':
        if (this.#device === 'phone' && message.busy !== this.#phoneBusy) {
          this.#phoneBusy = message.busy;
          this.#phoneWatch?.(message.busy, message.busy ? ['the phone'] : []);
        }

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
    this.#alerts.close();
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
      // Leaving the computer is the point of the voice on the phone: only sleep, which stops the hub too, stops it there (PRD R119).
      if (this.#device === 'phone' && event !== 'asleep') {
        this.deps.log(`${AWAY_TEXT[event]}: the voice stays on the phone`);
        return;
      }

      if (this.#away.has(event)) {
        return;
      }

      this.#away.add(event);
      this.#turnedOff = event;
      this.deps.log(`mic off: ${AWAY_TEXT[event]}`);
      this.#dictation?.enroll('cancel');
      this.#dictation?.mic(false);
      this.#syncMute();
      this.#alerts.cancelAll(AWAY_TEXT[event]);
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
      this.#syncMute();
      this.deps.log(`${BACK_TEXT[event]}: speech resumes; the mic stays off until it is turned on`);
    } else {
      this.deps.log(`${BACK_TEXT[event]}: still ${[...this.#away].map((reason) => AWAY_TEXT[reason]).join(', ')}`);
    }
  }

  /**
   * The voice moved to another device: what plays stops where it is, as Stop speaking stops it, and nothing plays on the new device until the
   * next reply. With none, after the phone left, nothing plays or listens until the operator moves the voice (PRD R119).
   */
  #deviceChanged(device: VoiceDevice): void {
    if (device === this.#device) {
      return;
    }

    const from = this.#device;

    this.#device = device;
    this.deps.log(`voice device: ${device === 'none' ? 'none, the phone left' : device === 'phone' ? 'the phone' : 'this computer'} (was ${from})`);
    // Muting stops what plays, the needs-you sound too, and drops what waits; the new device's mute follows below.
    this.#speech.mute('the voice moved');

    // The mic goes off with any move, and with it the device it captured from: the operator turns it on where the voice is now.
    this.#dictation?.enroll('cancel');
    this.#dictation?.mic(false);
    this.#phoneBusy = true;
    this.#phoneWatch = null;

    if (from === 'phone') {
      const why = device === 'none' ? PHONE_GONE : 'Voice is now on this computer.';

      this.#phone.lost(why);
      this.#phoneCapture.lost(why);
    }

    if (device === 'none') {
      this.#alerts.cancelAll('the phone left');
    }

    // A lock of this computer before the voice moved to the phone does not keep the phone silent.
    if (device === 'phone') {
      this.#away.delete('locked');
      this.#away.delete('disconnected');
      this.#turnedOff = this.#turnedOff === 'asleep' ? 'asleep' : null;
    }

    this.#syncMute();

    // The phone's tap that took the voice turns the mic on next: the recogniser loads while the page opens the phone's microphone.
    if (device === 'phone') {
      this.#dictation?.warmSoon();
    }
  }

  /**
   * The phone's busy state as dictation's other-app watcher: a muted track (a call, Siri), a hidden page or no track open pauses listening and
   * discards what was being heard, as another app recording on this computer does. It answers at once with the state the page last sent.
   */
  #watchPhone(changed: (busy: boolean, apps: string[]) => void): { close(): void } {
    this.#phoneWatch = changed;
    queueMicrotask(() => {
      if (this.#phoneWatch === changed) {
        changed(this.#phoneBusy, this.#phoneBusy ? ['the phone'] : []);
      }
    });

    return {
      close: () => {
        if (this.#phoneWatch === changed) {
          this.#phoneWatch = null;
        }
      },
    };
  }

  /** Nothing plays while the operator is away from the device that has the voice, or no device has it. */
  #syncMute(): void {
    const away = [...this.#away][0];

    this.#speech.mute(this.#device === 'none' ? 'no device: the phone that had the voice left' : away !== undefined ? `away: ${AWAY_TEXT[away]}` : null);
  }

  #failed(error: string | null): void {
    if (error !== this.#error) {
      this.#error = error;
      this.deps.send(this.#audio());
    }
  }

  #audio(): VoiceMessage {
    const halfDuplex = this.#dictation?.halfDuplex ?? null;
    const roomHold = this.#dictation?.roomHold ?? null;
    const fullDuplex = this.#dictation?.fullDuplex ?? null;

    return {
      type: 'audio',
      mic: this.#dictation?.state ?? 'off',
      engine: this.#device === 'phone' ? 'phone' : this.deps.output.engine,
      device: this.#device === 'phone' ? 'phone' : this.#dictation === null ? this.#settings.outputDevice : this.#settings.inputDevice,
      recognizer: this.#dictation?.recognizer ?? null,
      error: this.#dictation?.error ?? this.#error,
      ...(halfDuplex === null ? {} : { halfDuplex }),
      ...(roomHold === null ? {} : { roomHold }),
      ...(fullDuplex === null ? {} : { fullDuplex }),
    };
  }
}
