import type { VoiceSettings } from '@switchboard/core/settings';
import { ASR_RATE, pcmToSamples, Transcriber } from './asr.js';
import { BargeIn, gate } from './barge.js';
import { AutoDuplex } from './duplex.js';
import type { OutputHint } from './duplex.js';
import { EchoCheck } from './echoCheck.js';
import type { AsrEngine } from './asr.js';
import type { AsrDevice } from './sherpa.js';
import type { AudioDevices, MicUse } from './micUse.js';
import type { Capture, CaptureStream } from './output.js';
import { ENROLL_SECONDS } from './protocol.js';
import type { EndedBy, Interrupted, MicState, SpokenCommand, UtteranceTiming, VoiceMessage } from './protocol.js';
import { hotwordList } from './hotwords.js';
import { pauseWait, textWait } from './turn.js';
import type { TurnModel } from './turn.js';
import { loudness } from './voiceprint.js';
import type { Voiceprint } from './voiceprint.js';

/** How often an open message is checked for its end. */
export const TURN_TICK_MS = 100;
/**
 * A reply waits to start until the operator has said nothing for this long, and while an utterance is open, so it never starts over the
 * operator mid-thought (mechanics.md M127); a reply playing is stopped by talking over it instead.
 */
export const REPLY_HOLD_MS = 1_500;
/** A barge-in's words are recognised again from this long before the voice that passed the check. */
const BARGE_PREROLL = 0.3 * ASR_RATE;
/** After a reply ends, audio still this loud in its last 0.6 s keeps the words held and checked for up to `TAIL_HOLD_MS`. */
const TAIL_KEEP = 0.6 * ASR_RATE;
const TAIL_HOLD_MS = 1_500;
/** The recogniser loads ahead of Mic on once the target has stayed this long, since focus moves it several times a second. */
export const WARM_SETTLE_MS = 2_000;
/** A load ahead of Mic on waiting for a reply or an utterance to end tries again after this long. */
export const WARM_RETRY_MS = 5_000;
/** After a phone takes the voice, the recogniser loads this soon, once the hub's target for the phone's conversation has come. */
export const WARM_SOON_MS = 50;
/** A load ahead waits this long after freeing the recogniser it replaces, whose memory goes a few turns of the event loop later (M131). */
export const WARM_RELEASE_MS = 100;
/**
 * The recogniser is freed once capture has not been open or wanted for this long, since it holds gigabytes of memory (mechanics.md M131), and
 * no load ahead runs again until listening is asked for or a phone takes the voice.
 */
export const RECOGNISER_IDLE_MS = 30 * 60_000;
/** The recogniser's dropped streams are collected this long after the last one was dropped, once nothing is being heard (mechanics.md M166). */
export const COLLECT_AFTER_DROP_MS = 1_000;
/** The spoken commands (architecture.md § Dictation), recognised only as a whole utterance in the operator's voice and never sent. */
export const SPOKEN_COMMANDS: Readonly<Record<string, SpokenCommand>> = {
  'stop listening': 'stop-listening',
  'pause listening': 'stop-listening',
  'start listening': 'start-listening',
  'resume listening': 'start-listening',
};

/** Recognised words as a command's words are written: lower case, no punctuation. */
const commandWords = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .join(' ');

/** The spoken command that the whole text is, or null. */
export function spokenCommand(text: string): SpokenCommand | null {
  return SPOKEN_COMMANDS[commandWords(text)] ?? null;
}

/** Whether the text is a spoken command or its first words, so a piece may still turn out to be one. */
function commandStart(text: string): boolean {
  const words = commandWords(text);

  return words !== '' && Object.keys(SPOKEN_COMMANDS).some((command) => command === words || command.startsWith(`${words} `));
}

/** A piece dropped this soon after a reply stopped playing may be its echo, so it starts no room hold. */
export const ROOM_ECHO_GUARD_MS = 2_000;

export interface DictationDeps {
  capture: Capture;
  /** Loads the recogniser biased toward the terms, or says why it cannot run; it blocks while the model loads, 2 to 5 seconds. */
  recognizer(terms: string[]): AsrEngine | { error: string };
  vocabulary: { terms(repo: string | null): string[]; used(text: string): void };
  turn: TurnModel | null;
  /**
   * Starts watching other apps' recording, and on Windows the devices and the Remote Desktop session the echo check depends on; null where
   * nothing can watch, and the voice never pauses for another app.
   */
  watchMicUse(changed: (busy: boolean, apps: string[]) => void, failed: () => void, devices: (devices: AudioDevices) => void): MicUse | null;
  settings(): VoiceSettings;
  /** The voice check and enrolment; without it every piece passes unscored and enrolment fails. */
  voiceprint?: Voiceprint | null;
  /** The reply being played, its spoken passage and voice, for barge-in; null while none plays. */
  playing?(): { replyId: string; text: string; voice: string } | null;
  /** Until when the voice plays: `Infinity` while it plays, else when it last stopped (`Speech.playedUntil`), for half-duplex capture. */
  playedUntil?(): number;
  /** Barge-in: stops the reply playing, and says how much of its passage was heard; null when none was playing. */
  interrupt?(): Interrupted | null;
  /** `words`, `piece`, `utterance` and `enrollment` to the hub. */
  send(message: Extract<VoiceMessage, { type: 'words' | 'piece' | 'utterance' | 'enrollment' | 'command' }>): void;
  /** The mic state or the capture error changed. */
  changed(): void;
  /** The operator spoke: the away timeout counts again. */
  spoke(): void;
  newId(): string;
  now(): number;
  log(line: string): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
  every?(run: () => void, ms: number): { stop(): void };
}

interface Target {
  gen: number;
  sessionId: string;
  repo: string | null;
}

interface Utterance {
  id: string;
  gen: number;
  sessionId: string;
  pieces: string[];
  /** When its words last changed. */
  lastActivity: number;
  /** The words judged finished at `lastActivity`, and the quiet that earned; null while not judged so. */
  completeAt: number | null;
  waitMs: number;
  /** The turn model's last answer for it and how long it took, for the end's timing line; null before one. */
  turn: { p: number; ms: number } | null;
  /** Words shown and not settled yet. */
  words: string;
  /** The reply it spoke over, when a barge-in opened it. */
  interrupted: Interrupted | null;
  /** Its first pieces while they are a spoken command or its start: not reported until the utterance ends or another piece follows. */
  pending: Array<Extract<VoiceMessage, { type: 'piece' }>>;
  /** An answer to a spoken alert: nothing of it goes to the hub, and its words go to the alert (architecture.md § Spoken alerts). */
  answer: boolean;
}

/** A reply being played while capture runs: words heard then are held back, since they may be its echo, until barge-in says they are the operator's. */
interface Playback {
  replyId: string;
  /** Its spoken passage, which words heard over it are compared with. */
  text: string;
  barge: BargeIn;
  barged: boolean;
  /** When it stopped playing, while its tail is still checked. */
  endedAt: number | null;
  /** The pieces held back as its possible echo. */
  held: string;
}

/**
 * Dictation in the voice process (architecture.md § Dictation): capture while the mic is on, a session is the target, its window's composer does
 * not have the focus, no other app records and the mic idle timeout has not run out; recognition of each utterance into live words and pieces;
 * and its end by turn detection. It holds no message or draft: the hub turns pieces into the composer's draft and an utterance's end into a
 * message, by the focus rule.
 */
export class Dictation {
  #micOn = false;
  /** The here window's composer has the focus and listening pauses. */
  #typing = false;
  /** The here window's composer has the focus, listening or not, so no spoken alert's answer is heard. */
  #composing = false;
  /** Whether another app records; null until the watcher first says. */
  #otherApp: boolean | null = null;
  #idleOff = false;
  #target: Target | null = null;
  #stream: CaptureStream | null = null;
  #opening = false;
  #error: string | null = null;
  /** The error is the recogniser's, which each attempt to listen loads again, so a model put back needs no restart. */
  #recognizerFailed = false;
  #loggedRecognizerError: string | null = null;
  #engine: { key: string; engine: AsrEngine } | null = null;
  /** A freed recogniser whose memory has not gone yet; the next one loads once it resolves. */
  #released: Promise<void> | null = null;
  /** The open capture's recogniser loads once `#released` resolves. */
  #reloading = false;
  #transcriber: Transcriber | null = null;
  #utterance: Utterance | null = null;
  readonly #contexts = new Map<string, string>();
  #checks = 0;
  #watch: MicUse | null = null;
  #idle: unknown = null;
  #ticker: { stop(): void } | null = null;
  #reported = '';
  /** Voiceprint enrolment's recording, while one runs: capture goes to it instead of the recogniser. */
  #enrollment: { chunks: Float32Array[]; timer: unknown } | null = null;
  #playback: Playback | null = null;
  /** Half-duplex capture is not listening: the voice plays, or played within `voice.halfDuplexTailMs`. */
  #deaf = false;
  /** Why the open capture is half-duplex, or null while it listens as the voice plays (`duplexMode`). */
  #halfDuplex: string | null = null;
  /** When the operator's words last changed, for {@link REPLY_HOLD_MS}, and when words that then passed the voice check last did. */
  #lastWordAt = -Infinity;
  #keptWordAt = -Infinity;
  /** Why the open capture listens while the voice plays though it cancels no echo; null otherwise. */
  #fullDuplex: string | null = null;
  /** Under `voice.duplex` `auto`, capture that cancels no echo checks whether the voice's playback reaches it. */
  readonly #echo = new EchoCheck();
  readonly #auto: AutoDuplex;
  /** The capture path the echo check last measured: its reason, Remote Desktop and the devices; a change starts the check over. */
  #echoPath: string | null = null;
  /** The devices and the Remote Desktop session as the watcher last reported them; null until it does, and where it cannot. */
  #devices: AudioDevices | null = null;
  /** The playback device the watcher was started for, and its generation, which rises when it is replaced or closed. */
  #watchOutput: string | null = null;
  #watchGen = 0;
  /** The echo check heard the reply's own words inside the recogniser's feed; the audio is dropped once it returns. */
  #echoHeard = false;
  /** The capture mode last logged; undefined before the first open. */
  #loggedDuplex: string | undefined = undefined;
  /** When the room hold ends (epoch milliseconds), while one runs: the voice check heard someone else (`voice.roomHold`). */
  #roomHoldUntil: number | null = null;
  #roomTimer: unknown = null;
  /** "Stop listening" paused dictation: the recogniser runs, but only "start listening" is heard. */
  #pausedByVoice = false;
  /** The pieces in the operator's voice heard while paused, until the words have been quiet for `voice.endPauseMs`; null with none. */
  #paused: { texts: string[]; checks: Array<{ score: number | null; f0: number | null }>; lastAt: number } | null = null;
  /** A spoken alert waits for its answer: capture runs even with no target or after the idle timeout, and the next utterance is the answer. */
  #answer: ((text: string | null, cut: boolean) => void) | null = null;
  /** Mic on until capture opens: when it came and each step it waited for, for the voice log's timing line; null otherwise. */
  #starting: { at: number; last: number; steps: string[]; engine: boolean; failed?: { key: string; error: string } } | null = null;
  /** The recogniser's load ahead of Mic on, waiting for the target to settle or for nothing to play. */
  #warmTimer: unknown = null;
  /** A phone took the voice: the next target loads its recogniser at once rather than after it settles. */
  #warmUrgent = false;
  /** Frees the recogniser once capture has not been in use for {@link RECOGNISER_IDLE_MS}. */
  #unloadTimer: unknown = null;
  /** The recogniser was freed for disuse: no load ahead runs until Mic on, a spoken alert's answer, capture for dictation or `warmSoon`. */
  #unloaded = false;
  /** Collects the recogniser's dropped streams, {@link COLLECT_AFTER_DROP_MS} after the last was dropped. */
  #collectTimer: unknown = null;
  #closed = false;

  constructor(private readonly deps: DictationDeps) {
    this.#auto = new AutoDuplex(deps.log);
  }

  get state(): MicState {
    if (!this.#micOn) {
      return 'off';
    }

    // Enrolment speech is not dictation.
    if (this.#enrollment !== null) {
      return 'idle-off';
    }

    if (this.#error !== null) {
      return 'unavailable';
    }

    if (this.#otherApp === true) {
      return 'paused-other-app';
    }

    if ((this.#idleOff || this.#target === null) && this.#answer === null) {
      return 'idle-off';
    }

    if (this.#pausedByVoice) {
      return 'paused-by-voice';
    }

    if (this.#typing) {
      return 'typing';
    }

    if (this.#stream === null) {
      return 'starting';
    }

    return this.#utterance === null ? 'listening' : 'hearing';
  }

  /** Why the open capture has no working echo cancellation, so listening pauses while the voice plays; null with none or with no capture. */
  get halfDuplex(): string | null {
    return this.#stream === null ? null : this.#halfDuplex;
  }

  /** When the room hold ends, while one runs, else null (architecture.md § Voice check and barge-in). */
  get roomHold(): number | null {
    return this.#roomHoldUntil;
  }

  /** Why the open capture listens while the voice plays though it cancels no echo, such as "echo check: no echo detected"; null otherwise. */
  get fullDuplex(): string | null {
    return this.#stream === null ? null : this.#fullDuplex;
  }

  /** Why capture or recognition cannot run; null while they can. */
  get error(): string | null {
    return this.#error;
  }

  /** Where the recogniser loaded last runs, or null before one loads. */
  get recognizer(): AsrDevice | null {
    return this.#engine?.engine.device ?? null;
  }

  /** Whether the operator is speaking: an utterance is open or words are being recognised. */
  get hearing(): boolean {
    return this.#utterance !== null || (this.#transcriber?.words ?? '') !== '';
  }

  /**
   * How long a reply about to start waits for the operator, in milliseconds, 0 when it may start: while an utterance is open or words are being
   * recognised, and until {@link REPLY_HOLD_MS} after the last word heard.
   */
  replyHold(): { ms: number; verified: boolean } {
    // Paused by voice, nothing heard is dictation, so nothing holds a reply.
    if (this.#stream === null || this.#pausedByVoice) {
      return { ms: 0, verified: false };
    }

    const now = this.deps.now();
    const quiet = Math.max(0, this.#lastWordAt + REPLY_HOLD_MS - now);
    const utterance = this.#utterance;
    // An utterance with words that passed the voice check is the operator's; one holding only another voice's pieces does not count.
    const open = utterance !== null && utterance.pieces.length + utterance.pending.length > 0;
    const live = (this.#transcriber?.words ?? '') !== '';

    return { ms: open || live ? Math.max(quiet, TURN_TICK_MS * 2) : quiet, verified: open || this.#keptWordAt + REPLY_HOLD_MS > now };
  }

  /** Another app records from a microphone, as far as the watcher has said. */
  get otherAppRecording(): boolean {
    return this.#otherApp === true;
  }

  /** Voiceprint enrolment records. */
  get enrolling(): boolean {
    return this.#enrollment !== null;
  }

  /**
   * Whether a spoken alert's answer can be heard (architecture.md § Spoken alerts): the mic is on, with no error, not paused by voice, no other
   * app recording, the composer not focused and no enrolment. The away and idle timeouts do not count: an answer window listens through them.
   */
  get answerable(): boolean {
    return this.#micOn && this.#error === null && !this.#pausedByVoice && this.#otherApp !== true && !this.#composing && this.#enrollment === null;
  }

  /**
   * Listens for a spoken alert's answer: the next utterance goes to `answer` with its words, or null when it was cut off (`cut`) or kept
   * nothing, and to no session. Null stops listening for one, dropping an answer still open, and capture returns to what it was; `accepted` also ends the idle
   * stop, since the operator is back.
   */
  listen(answer: ((text: string | null, cut: boolean) => void) | null, accepted = false): void {
    if (answer === null && this.#utterance?.answer === true) {
      this.#answer = null;
      this.#cut(true);
    }

    this.#answer = answer;

    if (answer !== null) {
      this.#unloaded = false;
    }

    if (accepted) {
      this.#idleOff = false;
      this.#armIdle();
    }

    this.#sync();
  }

  /** The operator turned the mic on or off. Turning it on starts again after the idle timeout, an error or a pause by voice. */
  mic(on: boolean): void {
    if (on) {
      this.#unloaded = false;
    }

    if (on === this.#micOn) {
      if (on && (this.#idleOff || this.#error !== null || this.#pausedByVoice)) {
        if (this.#pausedByVoice) {
          this.deps.log('listening resumed: the mic was turned on');
          this.#leavePause();
        }

        this.#idleOff = false;
        this.#error = null;

        if (this.#stream === null) {
          this.#starting = { at: this.deps.now(), last: this.deps.now(), steps: [], engine: false };
        }

        this.#sync();
      }

      return;
    }

    this.#micOn = on;

    if (this.#pausedByVoice) {
      this.#leavePause();
    }

    if (on) {
      this.#idleOff = false;
      this.#error = null;
      this.#otherApp = null;
      this.#starting = { at: this.deps.now(), last: this.deps.now(), steps: [], engine: false };
      // The headphones may have come off since: the echo check starts over.
      this.#resetEcho('the mic was turned on');
      this.#startWatch();

      if (this.#watch === null) {
        this.#otherApp = false;
      }

      // The recogniser loads while the other-app watcher starts, not after its first answer; a failure is reported by the attempt to listen.
      // One for other terms is freed now, and the attempt to listen loads the new one once its memory has gone.
      if (this.#target !== null && this.#enrollment === null && !this.#recognizerFailed) {
        if (this.#engine !== null && this.#engine.key !== this.#termsKey()) {
          this.#releaseEngine();
        } else if (this.#released === null) {
          this.#loadEngine(true);
        }
      }
    } else {
      this.#starting = null;
      this.#cut(true);
      this.#watchGen++;
      this.#watch?.close();
      this.#watch = null;
      this.#otherApp = null;
      this.#devices = null;
    }

    this.#sync();
  }

  /**
   * The here window's composer gained or lost the focus: recognition in flight is finished into the draft and listening pauses, unless it
   * asks to `listen` on, as the web page's composer does.
   */
  typing(on: boolean, listen = false): void {
    const typing = on && !listen;

    // A spoken alert's answer being waited for ends cut, as when listening pauses, so the words said next go to the draft.
    if (on && !this.#composing && !typing && this.#answer !== null) {
      if (this.#utterance?.answer === true) {
        this.#cut(true);
      } else {
        this.#answer(null, true);
      }
    }

    this.#composing = on;

    if (typing === this.#typing) {
      return;
    }

    this.#typing = typing;

    if (typing) {
      this.#cut(true);
    }

    this.#sync();
  }

  /** The voice target changed: an utterance open for the earlier one is closed unsent, and the recogniser loads the new one's terms. */
  target(gen: number, sessionId: string | null, repo: string | null): void {
    if (this.#utterance !== null && !this.#utterance.answer && (this.#utterance.gen !== gen || this.#utterance.sessionId !== sessionId)) {
      this.#cut(true);
    }

    this.#target = sessionId === null ? null : { gen, sessionId, repo };

    if (this.#target !== null && this.#stream !== null) {
      this.#reloadListening();
    }

    // Focus moves the target several times a second: the recogniser loads once it settles.
    if (this.#target !== null) {
      if (this.#warmTimer !== null) {
      this.#clearTimer(this.#warmTimer);
    }

      this.#warmTimer = this.#timer(() => this.warm(), this.#warmUrgent ? WARM_SOON_MS : WARM_SETTLE_MS);
    }

    this.#sync();
  }

  /**
   * A phone took the voice in the tap that turns its mic on next: the recogniser loads at once, for the target the hub sets right after the
   * move, while the page opens the phone's microphone.
   */
  warmSoon(): void {
    this.#unloaded = false;
    this.#warmUrgent = true;

    if (this.#warmTimer !== null) {
      this.#clearTimer(this.#warmTimer);
    }

    this.#warmTimer = this.#timer(() => this.warm(), WARM_SOON_MS);
  }

  /**
   * Loads the recogniser for the target's terms ahead of Mic on (architecture.md § Dictation), so turning the mic on does not wait seconds for
   * the model: once the process has its settings, and again for each target, whether or not a device has the voice, since a phone's first tap
   * takes the voice and turns its mic on at once (mechanics.md M129). Loading blocks the process, so it waits while a reply plays or an
   * utterance is open, and it runs a second of silence through the new recogniser, whose first decode on the GPU is several times slower than
   * later ones.
   */
  warm(): void {
    if (this.#warmTimer !== null) {
      this.#clearTimer(this.#warmTimer);
    }

    this.#warmTimer = null;
    this.#warmUrgent = false;

    // With no target yet, as when the process has just started, the recogniser loads for no repository's terms, so the first Mic on after a
    // restart finds one; a target's terms load it again only when they differ.
    // After a free for disuse nothing loads ahead, so moving the focus between pages does not load gigabytes back.
    if (this.#unloaded || (this.#target === null && this.#engine !== null) || this.#enrollment !== null || this.#recognizerFailed || !this.deps.settings().enabled || this.#engine?.key === this.#termsKey()) {
      return;
    }

    if ((this.deps.playing?.() ?? null) !== null || this.#utterance !== null) {
      this.#warmTimer = this.#timer(() => this.warm(), WARM_RETRY_MS);
      return;
    }

    // The recogniser for other terms goes first, and the new one loads once its memory is released, so two never coexist. With capture open,
    // the target's change and the open itself replace it; while the device opens, or a freed one's memory has not gone, the load waits.
    if (this.#engine !== null || this.#released !== null) {
      if (this.#stream !== null && this.#engine !== null) {
        return;
      }

      if (this.#engine !== null && this.#stream === null && !this.#opening) {
        this.#releaseEngine();
      }

      this.#warmTimer = this.#timer(() => this.warm(), WARM_RELEASE_MS);
      return;
    }

    const at = this.deps.now();

    if (!this.#loadEngine(true)) {
      return;
    }

    const loaded = this.deps.now();

    this.#engine!.engine.stream().accept(new Float32Array(ASR_RATE));
    this.deps.log(`recogniser loaded ahead of the mic in ${Math.round(loaded - at)} ms, its first decode ${Math.round(this.deps.now() - loaded)} ms`);
    this.#armUnload();
  }

  /** The words the recogniser is biased toward for the target: its repository's terms and the spoken commands, which are heard as said. */
  #terms(): string[] {
    return hotwordList(this.deps.vocabulary.terms(this.#target?.repo ?? null), Object.keys(SPOKEN_COMMANDS));
  }

  #termsKey(): string {
    return this.#terms().join('\n');
  }

  /** A step of Mic on's start done, for its timing line. */
  #step(name: string): void {
    const starting = this.#starting;

    if (starting !== null) {
      const now = this.deps.now();

      starting.steps.push(`${name} ${Math.round(now - starting.last)} ms`);
      starting.last = now;
    }
  }

  /** Mic on's start ended, opened or failed: one voice log line with how long each step took. */
  #started(outcome: string): void {
    const starting = this.#starting;

    if (starting !== null) {
      this.#starting = null;
      this.deps.log(`mic on → ${outcome} in ${Math.round(this.deps.now() - starting.at)} ms${starting.steps.length === 0 ? '' : `: ${starting.steps.join(', ')}`}`);
    }
  }

  /** A session's latest reply, which the turn model reads. */
  context(sessionId: string, lastReply: string): void {
    this.#contexts.set(sessionId, lastReply);
  }

  /** The voice targets changed: the latest replies of sessions no longer among them go, and the hub sends one again if a session returns. */
  keepContexts(sessionIds: ReadonlySet<string>): void {
    for (const sessionId of this.#contexts.keys()) {
      if (!sessionIds.has(sessionId)) {
        this.#contexts.delete(sessionId);
      }
    }
  }

  /** Audio being played, for echo cancellation and the echo check. */
  reference(pcm: Buffer): void {
    this.#stream?.reference(pcm);

    if (this.#checking()) {
      this.#echo.played(pcm, this.deps.now());
    }
  }

  /** The settings were reloaded: the idle timeout starts again with its new length, and `voice.duplex` applies to the open capture. */
  settingsChanged(): void {
    // The Windows watcher reports the playback device `voice.outputDevice` names, so another one needs another watcher; its hint is gone.
    if (this.#watch !== null && this.deps.settings().outputDevice !== this.#watchOutput) {
      const old = this.#watch;

      // The old device's hint goes; whether this is a Remote Desktop session stays known until the new watcher says.
      this.#devices = this.#devices === null ? null : { ...this.#devices, output: '', outputId: '', formFactor: 'unknown' };
      this.#startWatch();
      old.close();
    }

    if (this.#stream !== null) {
      this.#armIdle();
      this.#applyDuplex();
    }

    if (!this.deps.settings().roomHold && this.#roomHoldUntil !== null) {
      this.#endRoomHold();
      this.deps.log('room hold ended: voice.roomHold is off');
      this.deps.changed();
    }

    // The process started, as onto a new build, or voice was turned on: the recogniser loads before the first Mic on asks for it.
    this.#warmUnloaded();
    this.#armUnload();
  }

  /** Schedules the load ahead when no recogniser is loaded or due, as after the settings come or an enrolment that put it off. */
  #warmUnloaded(): void {
    if (this.#engine === null && this.#warmTimer === null && !this.#unloaded && this.deps.settings().enabled) {
      this.#warmTimer = this.#timer(() => this.warm(), WARM_SETTLE_MS);
    }
  }

  /**
   * Voiceprint enrolment (architecture.md § Voice check and barge-in): `start` cuts any utterance short and records `ENROLL_SECONDS` of
   * capture, which goes to no session, then saves the print from it; `cancel` stops recording and saves nothing. Each change is reported.
   */
  enroll(action: 'start' | 'cancel'): void {
    if (action === 'cancel') {
      if (this.#enrollment !== null) {
        this.deps.log('voiceprint enrolment cancelled');
        this.#endEnrollment();
        this.deps.send({ type: 'enrollment', state: 'cancelled', error: null });
      }

      return;
    }

    if (this.#enrollment !== null) {
      this.deps.send({ type: 'enrollment', state: 'recording', error: null });
      return;
    }

    const unavailable = this.deps.voiceprint == null ? 'The voice check is not available.' : this.deps.voiceprint.unavailable();

    if (unavailable !== null) {
      this.deps.log(`voiceprint enrolment failed: ${unavailable}`);
      this.deps.send({ type: 'enrollment', state: 'failed', error: unavailable });
      return;
    }

    this.#cut(true);
    this.#enrollment = { chunks: [], timer: this.#timer(() => this.#finishEnrollment(), ENROLL_SECONDS * 1000) };
    this.deps.log('voiceprint enrolment started');
    this.deps.send({ type: 'enrollment', state: 'recording', error: null });
    // Capture open for dictation opens again for the recording, which needs no recogniser.
    this.#stopCapture();
    this.#sync();
  }

  #finishEnrollment(): void {
    const chunks = this.#enrollment?.chunks ?? [];
    const samples = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;

    for (const chunk of chunks) {
      samples.set(chunk, at);
      at += chunk.length;
    }

    this.#endEnrollment();

    try {
      const result = this.deps.voiceprint!.enroll(samples);

      this.deps.log(`voiceprint enrolled from ${result.windows} windows, median pitch ${result.f0 ?? 'unknown'} Hz`);
      this.deps.send({ type: 'enrollment', state: 'enrolled', error: null });
    } catch (error) {
      this.deps.log(`voiceprint enrolment failed: ${(error as Error).message}`);
      this.deps.send({ type: 'enrollment', state: 'failed', error: (error as Error).message });
    }
  }

  #endEnrollment(): void {
    if (this.#enrollment !== null) {
      this.#clearTimer(this.#enrollment.timer);
      this.#enrollment = null;
    }

    this.#stopCapture();
    this.#sync();
    // A load ahead that waited for the enrolment runs now.
    this.#warmUnloaded();
  }

  close(): void {
    if (this.#warmTimer !== null) {
      this.#clearTimer(this.#warmTimer);
    }

    this.#warmTimer = null;

    if (this.#enrollment !== null) {
      this.#clearTimer(this.#enrollment.timer);
      this.#enrollment = null;
    }

    this.#micOn = false;
    this.#watchGen++;
    this.#watch?.close();
    this.#watch = null;
    this.#stopCapture();
    this.#endRoomHold();
    this.#closed = true;
    this.#clearUnload();

    if (this.#collectTimer !== null) {
      this.#clearTimer(this.#collectTimer);
      this.#collectTimer = null;
    }

    this.deps.turn?.close();
  }

  #otherAppChanged(busy: boolean, apps: string[]): void {
    const was = this.#otherApp;

    if (busy === was) {
      return;
    }

    this.#otherApp = busy;

    if (was === null) {
      this.#step(busy ? `other-app check (${apps.join(', ') || 'another app'} records)` : 'other-app check');
    }


    if (busy) {
      this.deps.log(`listening paused: ${apps.join(', ') || 'another app'} is recording`);
      this.#discard();
    } else if (was === true) {
      this.deps.log('listening resumes: no other app is recording');
    }

    this.#sync();
  }

  /** Whether dictation could listen, whatever the last error. */
  #ready(): boolean {
    return this.#micOn && this.#otherApp === false && !this.#typing && (this.#answer !== null || (!this.#idleOff && this.#target !== null));
  }

  /** Whether capture should run: for enrolment, or for dictation. */
  #wanted(): boolean {
    return this.#enrollment !== null || (this.#ready() && this.#error === null);
  }

  /** Starts or stops capture for the current state, and reports the state when it changed. */
  #sync(): void {
    // A recogniser that failed to load is tried again at each attempt to listen.
    if (this.#ready() && this.#recognizerFailed) {
      this.#error = null;
    }

    const wanted = this.#wanted();

    if (wanted && this.#stream === null && !this.#opening) {
      void this.#startCapture();
    } else if (!wanted && this.#stream !== null) {
      this.#stopCapture();
    }

    this.#report();
  }

  #report(): void {
    const text = `${this.state} ${this.recognizer ?? ''} ${this.#error ?? ''} ${this.halfDuplex ?? ''} ${this.fullDuplex ?? ''}`;

    if (text !== this.#reported) {
      this.#reported = text;
      this.deps.changed();
    }

    this.#armUnload();
  }

  /**
   * Whether capture is in use: open, opening or reloading, wanted for dictation or an enrolment, about to be wanted once the other-app watcher first answers, or waiting for a spoken alert's answer. A pause
   * for the composer or another app, and a failed capture, close it, so they count as unused; a pause by voice keeps it open.
   */
  #inUse(): boolean {
    return this.#wanted() || this.#awaitingWatcher() || this.#stream !== null || this.#opening || this.#reloading || this.#answer !== null;
  }

  /** Mic on for a target waits for the other-app watcher's first answer before capture opens. */
  #awaitingWatcher(): boolean {
    return this.#micOn && this.#otherApp === null && !this.#idleOff && this.#target !== null;
  }

  /** Stops the disuse clock while capture is in use, and starts it, once, when capture is not. */
  #armUnload(): void {
    if (this.#inUse()) {
      this.#clearUnload();
    } else if (this.#unloadTimer === null && !this.#unloaded && !this.#closed) {
      this.#unloadTimer = this.#timer(() => this.#unloadIdle(), RECOGNISER_IDLE_MS);
    }
  }

  #clearUnload(): void {
    if (this.#unloadTimer !== null) {
      this.#clearTimer(this.#unloadTimer);
      this.#unloadTimer = null;
    }
  }

  /** Capture was not in use for {@link RECOGNISER_IDLE_MS}: the recogniser is freed, the turn model's process closed and no load ahead waiting runs. */
  #unloadIdle(): void {
    this.#unloadTimer = null;

    if (this.#inUse()) {
      return;
    }

    this.#unloaded = true;
    this.#warmUrgent = false;
    // The turn model's process holds about 670 MB (mechanics.md M166); it starts again at its next request.
    this.deps.turn?.close();

    if (this.#warmTimer !== null) {
      this.#clearTimer(this.#warmTimer);
      this.#warmTimer = null;
    }

    if (this.#engine !== null) {
      this.#releaseEngine();
      this.deps.log(`recogniser freed: capture was not used for ${RECOGNISER_IDLE_MS / 60_000} minutes; it loads again at Mic on`);
      this.#report();
    }
  }

  /**
   * Loads the recogniser for the target's terms when they changed; false, with the error kept, when it cannot run. A load ahead of listening
   * (`ahead`) keeps no error: the attempt to listen loads it again and reports why.
   */
  #loadEngine(ahead = false): boolean {
    const terms = this.#terms();
    const key = terms.join('\n');
    const starting = this.#starting;

    if (this.#engine?.key === key) {
      if (starting !== null && !starting.engine) {
        starting.engine = true;
        this.#step('recogniser ready');
      }

      return true;
    }

    // Mic on's load ahead failed for these terms: its attempt to listen reports that, rather than paying for the load again.
    const failed = !ahead && starting?.failed?.key === key ? starting.failed : null;

    // One recogniser at a time: each holds gigabytes of GPU memory (mechanics.md M131).
    if (failed === null) {
      this.#releaseEngine();
    }

    const engine = failed === null ? this.deps.recognizer(terms) : { error: failed.error };

    if (starting !== null && !starting.engine) {
      starting.engine = true;
      this.#step('recogniser loaded');
    }

    if ('error' in engine) {
      if (ahead) {
        if (starting !== null) {
          starting.failed = { key, error: engine.error };
        }

        return false;
      }

      if (this.#loggedRecognizerError !== engine.error) {
        this.#loggedRecognizerError = engine.error;
        this.deps.log(engine.error);
      }

      this.#error = engine.error;
      this.#recognizerFailed = true;
      return false;
    }

    this.#recognizerFailed = false;
    this.#loggedRecognizerError = null;
    this.#engine = { key, engine };
    this.#transcriber = new Transcriber(engine, {
      onWords: (text) => this.#words(text),
      onPiece: (text, audio) => this.#piece(text, audio),
      onQuiet: () => {
        if (!this.#holding()) {
          void this.#checkTurn();
        }
      },
      onDropped: () => this.#collectSoon(),
    });
    return true;
  }

  /**
   * Collects the dropped streams' native memory {@link COLLECT_AFTER_DROP_MS} after the last drop, waiting while the operator is heard so the
   * pause of a full collection never falls inside an utterance; a timer never runs inside a decode, which is synchronous.
   */
  #collectSoon(): void {
    if (this.#collectTimer !== null) {
      this.#clearTimer(this.#collectTimer);
    }

    this.#collectTimer = this.#timer(() => {
      this.#collectTimer = null;

      if (this.hearing) {
        this.#collectSoon();
      } else {
        this.#engine?.engine.collect?.();
      }
    }, COLLECT_AFTER_DROP_MS);
  }

  /** Frees the loaded recogniser, if any; its transcriber goes with it, and `#released` resolves once its memory has gone. */
  #releaseEngine(): void {
    if (this.#engine === null) {
      return;
    }

    this.#engine.engine.free();
    this.#engine = null;
    this.#transcriber = null;

    let done = (): void => undefined;

    const released = new Promise<void>((resolve) => (done = resolve));

    this.#released = released;
    this.#timer(() => {
      if (this.#released === released) {
        this.#released = null;
      }

      done();
    }, WARM_RELEASE_MS);
  }

  /**
   * With capture open, loads the recogniser for the target's terms when they changed: the old one is freed first and the new one loads once its
   * memory has gone, the audio until then heard by none; capture stops when it cannot load.
   */
  #reloadListening(): void {
    if (this.#engine !== null && this.#engine.key === this.#termsKey()) {
      return;
    }

    this.#releaseEngine();

    const stream = this.#stream;
    // One load for the capture, for the terms of the target then; a new capture, or an enrolment's, loads its own.
    const load = (): void => {
      this.#reloading = false;

      if (this.#stream !== stream || stream === null || this.#enrollment !== null || this.#engine !== null) {
        return;
      }

      if ((this.#target !== null || this.#answer !== null) && !this.#loadEngine()) {
        this.#stopCapture();
      }

      this.#sync();
    };

    if (this.#released === null) {
      load();
    } else if (!this.#reloading) {
      this.#reloading = true;
      void this.#released.then(load);
    }
  }

  async #startCapture(): Promise<void> {
    const forEnrollment = this.#enrollment !== null;

    // Capture for dictation is use, as when a target comes while the mic is on; an enrolment's needs no recogniser.
    if (!forEnrollment) {
      this.#unloaded = false;
    }

    // A recogniser for other terms is freed, and one being freed has gone, before this one loads.
    if (!forEnrollment && (this.#engine?.key !== this.#termsKey() || this.#released !== null)) {
      this.#releaseEngine();

      if (this.#released !== null) {
        this.#opening = true;
        await this.#released;
        this.#opening = false;

        if (!this.#wanted() || this.#enrollment !== null) {
          this.#sync();
          return;
        }
      }
    }

    if (!forEnrollment && !this.#loadEngine()) {
      this.#started('unavailable');
      this.#report();
      return;
    }

    this.#opening = true;
    this.#report();

    let stream: CaptureStream;

    try {
      stream = await this.deps.capture.open(
        this.deps.settings().inputDevice,
        (pcm) => this.#audio(pcm),
        (error) => this.#failed(error),
      );
    } catch (error) {
      this.#opening = false;
      this.#step('capture open');
      this.#started('failed');
      this.#failed(error as Error);
      return;
    }

    this.#opening = false;

    // The state moved on while the device opened, or it opened for enrolment, with no recogniser, and dictation now wants it.
    if (!this.#wanted() || forEnrollment !== (this.#enrollment !== null)) {
      stream.stop();
      this.#sync();
      return;
    }

    this.#stream = stream;
    this.#deaf = false;
    this.#echo.restart();

    // The target moved to other terms while the device opened.
    if (!forEnrollment && this.#target !== null) {
      this.#reloadListening();

      if (this.#stream !== stream) {
        return;
      }
    }

    if (!forEnrollment) {
      this.#step('capture open');
      this.#started('listening');
    }

    this.#applyDuplex();

    this.#ticker = (this.deps.every ?? every)(() => this.#tick(), TURN_TICK_MS);
    this.#armIdle();
    this.#report();
  }

  /**
   * Sets whether the open capture listens while the voice plays, from `voice.duplex` and its echo cancellation, and logs the mode when it
   * changed. Leaving half-duplex while deaf starts the recogniser afresh.
   */
  #applyDuplex(): void {
    const stream = this.#stream!;
    const settings = this.deps.settings();

    const remote = this.#remote(stream);

    if (this.#enrollment === null && stream.halfDuplex !== null) {
      const path = JSON.stringify([stream.halfDuplex, remote, settings.inputDevice, settings.outputDevice]);

      if (this.#echoPath !== null && path !== this.#echoPath) {
        this.#resetEcho('the capture or playback device changed');
      }

      this.#echoPath = path;
    }

    this.#auto.context(outputHint(this.#devices), remote);

    const mode = duplexMode(settings.duplex, { halfDuplex: stream.halfDuplex, remote }, this.#auto);

    this.#halfDuplex = mode.halfDuplex;
    this.#fullDuplex = mode.fullDuplex;

    if (mode.halfDuplex === null && this.#deaf) {
      this.#deaf = false;
      this.deps.log('listening resumes');
      this.#transcriber?.end(false);
    }

    const line = mode.halfDuplex === null ? `listening: full duplex (${mode.why})` : `listening: half-duplex (${mode.why})`;

    if (this.#enrollment === null && line !== this.#loggedDuplex) {
      this.#loggedDuplex = line;
      this.deps.log(line);
    }

    this.#report();
  }

  #stopCapture(): void {
    this.#stream?.stop();
    this.#stream = null;
    this.#ticker?.stop();
    this.#ticker = null;
    this.#clearIdle();
  }

  /** Captured audio: to enrolment's recording while one runs, else to the recogniser. */
  #audio(pcm: Buffer): void {
    const samples = pcmToSamples(pcm);

    if (this.#enrollment !== null) {
      this.#enrollment.chunks.push(samples);
      return;
    }

    if (this.#checking()) {
      this.#echo.captured(pcm, this.deps.now());
    }

    if (this.#halfDuplex !== null && this.#halfDuplexDeaf()) {
      return;
    }

    this.#trackPlayback();
    this.#transcriber?.feed(samples);

    // The reply's own words were just heard over it: half-duplex again, and nothing of this audio, its words or a barge-in, goes on.
    if (this.#echoHeard) {
      this.#echoHeard = false;
      this.#dropEcho();
      return;
    }

    // Paused by voice, a reply is not stopped by talking over it.
    if (this.#holding() && !this.#pausedByVoice && this.#transcriber !== null) {
      this.#checkBarge();
    }
  }

  /** Drops the words held over the reply playing as its echo, and stops listening until the voice stops playing, as half-duplex capture does. */
  #dropEcho(): void {
    const held = [this.#playback?.held ?? '', this.#transcriber?.take()?.text ?? ''].filter((text) => text !== '').join(' ');

    this.#transcriber?.end(false);
    this.#playback = null;
    this.#deaf = true;
    this.deps.log(`listening paused while the voice plays (half-duplex): words heard over the reply dropped as its echo: ${held}`);
  }

  /**
   * Half-duplex capture (architecture.md § Dictation): while the voice plays and for `voice.halfDuplexTailMs` after, audio is dropped unheard,
   * so there is no barge-in. Going deaf cuts the open utterance as the composer's focus does, its words kept in the draft and nothing sent;
   * hearing again starts the recogniser afresh, with nothing of the time before.
   */
  #halfDuplexDeaf(): boolean {
    const deaf = this.deps.now() < (this.deps.playedUntil?.() ?? -Infinity) + this.deps.settings().halfDuplexTailMs;

    if (deaf && !this.#deaf) {
      this.#deaf = true;
      this.#playback = null;

      if (this.#utterance !== null || (this.#transcriber?.words ?? '') !== '') {
        this.deps.log('listening paused while the voice plays (half-duplex): the utterance being heard is cut and kept in the draft');
        this.#cut(true);
      } else {
        this.deps.log('listening paused while the voice plays (half-duplex)');
        this.#transcriber?.end(false);
      }
    } else if (!deaf && this.#deaf) {
      this.#deaf = false;
      this.deps.log('listening resumes');
      this.#transcriber?.end(false);
    }

    return deaf;
  }

  /** Under `voice.duplex` `auto`, whether the open capture, which cancels no echo, is checked for the voice's echo. */
  #checking(): boolean {
    const stream = this.#stream;

    return stream !== null && this.#enrollment === null && stream.halfDuplex !== null && this.deps.settings().duplex[this.#remote(stream) ? 'remote' : 'local'] === 'auto';
  }

  /** Whether the voice process runs in a Remote Desktop session: as the watcher last said, else as the capture said when it opened. */
  #remote(stream: CaptureStream): boolean {
    return this.#devices?.remote ?? stream.remote === true;
  }

  /**
   * The devices or the Remote Desktop session changed: the echo check starts over, since the headphones or the speakers may be others now,
   * and `voice.duplex` follows a session that switched between this computer and Remote Desktop.
   */
  #devicesChanged(devices: AudioDevices): void {
    const was = this.#devices;

    this.#devices = devices;
    this.deps.log(`devices: playback "${devices.output}" (${devices.formFactor}), capture "${devices.input}", ${devices.remote ? 'over Remote Desktop' : 'on this computer'}`);

    if (was !== null && JSON.stringify(was) !== JSON.stringify(devices)) {
      this.#resetEcho(was.remote !== devices.remote ? (devices.remote ? 'a Remote Desktop session started' : 'the Remote Desktop session ended') : 'the playback or capture device changed');
    }

    if (this.#stream !== null) {
      this.#applyDuplex();
    }
  }

  /** Words held over the reply playing, on full-duplex capture that cancels no echo: the reply's own words are its echo, and half-duplex returns. */
  #echoWords(words: string): void {
    if (this.#checking() && this.#playback !== null && this.#auto.heardWhilePlaying(words, this.#playback.text)) {
      // Heard inside the recogniser's feed: the audio's caller drops the words once the feed returns.
      this.#echoHeard = true;
      this.#applyDuplex();
    }
  }

  /** Starts the echo check over, half-duplex, with nothing measured before kept: the devices or the path it measured may be others now. */
  #resetEcho(why: string): void {
    this.#auto.reset(why);
    this.#echo.restart();
  }

  /** Starts watching other apps' recording and, on Windows, the devices, for the playback device the settings name now. */
  #startWatch(): void {
    // A watcher closed since may still deliver what it had buffered: only the current one counts.
    const gen = ++this.#watchGen;
    const current = (): boolean => gen === this.#watchGen;

    this.#watchOutput = this.deps.settings().outputDevice;
    this.#watch = this.deps.watchMicUse(
      (busy, apps) => current() && this.#otherAppChanged(busy, apps),
      () => current() && this.#otherAppChanged(false, []),
      (devices) => current() && this.#devicesChanged(devices),
    );
  }

  /** Words are held back while a reply plays and no utterance is open: until barge-in fires, they may be its echo. */
  #holding(): boolean {
    return this.#playback !== null && !this.#playback.barged && this.#utterance === null;
  }

  /** Follows the reply being played; after it ends, its tail is checked while the audio stays loud, then the words held over it are dropped. */
  #trackPlayback(): void {
    const playing = this.deps.playing?.() ?? null;
    const playback = this.#playback;

    if (playing !== null) {
      if (playback?.replyId !== playing.replyId) {
        // A reply played straight after another keeps the words held so far.
        this.#playback = { replyId: playing.replyId, text: playing.text, barge: new BargeIn(this.deps.voiceprint ?? null, playing.text, playing.voice), barged: false, endedAt: null, held: playback?.held ?? '' };
      }

      return;
    }

    if (playback === null) {
      return;
    }

    const transcriber = this.#transcriber;

    if (!playback.barged && this.#utterance === null && transcriber !== null) {
      playback.endedAt ??= this.deps.now();

      const loud = transcriber.total >= TAIL_KEEP && loudness(transcriber.samples(transcriber.total - TAIL_KEEP)) >= gate(this.deps.voiceprint?.level ?? 0);

      if (loud && this.deps.now() - playback.endedAt < TAIL_HOLD_MS) {
        return;
      }

      const rest = transcriber.take();
      const dropped = [playback.held, rest?.text ?? ''].filter((text) => text !== '').join(' ');

      if (dropped !== '') {
        this.deps.log(`words heard over reply ${playback.replyId} dropped as its echo: ${dropped}`);
      }

      transcriber.end(false);
    }

    this.#playback = null;
  }

  /**
   * Barge-in (architecture.md § Voice check and barge-in): once the operator's voice is confirmed over the reply, the reply stops, recognition
   * starts again from just before that voice, and an utterance opens that names the reply it spoke over.
   */
  #checkBarge(): void {
    const playback = this.#playback!;
    const transcriber = this.#transcriber!;
    const barge = playback.barge.check({ total: transcriber.total, samples: (from) => transcriber.samples(from), words: transcriber.words }, this.deps.settings());

    if (barge === null) {
      return;
    }

    playback.barged = true;

    const interrupted = this.deps.interrupt?.() ?? null;

    this.deps.log(`barge-in on reply ${playback.replyId} (${barge.trigger}, score ${barge.score ?? 'none'}, reply voice ${barge.ttsScore ?? 'none'}): ${barge.words}`);
    transcriber.restartFrom(barge.from - BARGE_PREROLL);
    this.#spoke();

    const utterance = this.#utterance;

    if (utterance !== null) {
      utterance.interrupted = interrupted;
      utterance.lastActivity = this.deps.now();
      this.#lastWordAt = utterance.lastActivity;

      if (transcriber.words !== '') {
        this.#words(transcriber.words);
      }
    }
  }

  #failed(error: Error): void {
    this.#recognizerFailed = false;
    this.#error = `The microphone failed: ${error.message}`;
    this.deps.log(this.#error);

    if (this.#enrollment !== null) {
      this.#clearTimer(this.#enrollment.timer);
      this.#enrollment = null;
      this.deps.send({ type: 'enrollment', state: 'failed', error: this.#error });
    }

    this.#cut(false);
    this.#stopCapture();
    this.#report();
  }

  #words(text: string): void {
    if (this.#holding()) {
      this.#echoWords(text);
      return;
    }

    // Paused by voice: nothing is shown or sent, but talking keeps the mic from its idle stop and the voice from the away timeout.
    if (this.#pausedByVoice) {
      if (text !== '') {
        this.#armIdle();
        this.deps.spoke();

        if (this.#paused !== null) {
          this.#paused.lastAt = this.deps.now();
        }
      }

      return;
    }

    if (text !== '') {
      this.#spoke();
    }

    const utterance = this.#utterance;

    if (utterance === null || utterance.words === text) {
      return;
    }

    utterance.words = text;

    // Words settling into a piece are not speech: counting them would put off every message's end by the piece's pause.
    if (text !== '') {
      utterance.lastActivity = this.deps.now();
      this.#lastWordAt = utterance.lastActivity;
    }

    this.#sendWords(utterance, { type: 'words', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text });
  }

  /**
   * A piece settled: the voice check judges its audio (architecture.md § Voice check and barge-in), and only a piece that passes joins the
   * utterance, so someone else's words neither reach the session nor end the operator's turn.
   */
  #piece(text: string, audio: Float32Array): boolean {
    if (this.#holding()) {
      this.#playback!.held = [this.#playback!.held, text].filter((one) => one !== '').join(' ');
      this.#echoWords(this.#playback!.held);
      return false;
    }

    if (this.#pausedByVoice) {
      this.#pausedPiece(text, audio);
      return false;
    }

    const utterance = this.#open();

    if (utterance === null) {
      return false;
    }

    const check = this.deps.voiceprint?.check(audio, text, this.deps.settings()) ?? { score: null, f0: null, dropped: false, reason: null };
    const piece = { type: 'piece' as const, gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, pieceId: this.deps.newId(), text, score: check.score, f0: check.f0, dropped: check.dropped };

    // A spoken command counts only as a whole utterance: its pieces wait until the utterance ends or turns out to be dictation.
    if (!check.dropped && utterance.pieces.length === 0 && commandStart([...utterance.pending.map((one) => one.text), text].join(' '))) {
      utterance.pending.push(piece);
      return true;
    }

    if (!check.dropped) {
      this.#release(utterance);
    }

    if (!utterance.answer) {
      this.deps.send(piece);
    }

    if (check.dropped) {
      this.deps.log(`piece dropped by the voice check (${check.reason === 'pitch' ? 'pitch' : 'score'} ${check.reason === 'pitch' ? `${check.f0} Hz` : check.score}): ${text}`);
      this.#roomVoice(audio);
      // Another voice's words hold no reply.
      this.#lastWordAt = this.#keptWordAt;

      // An end the turn model judged on words that included these is judged again without them.
      if (utterance.completeAt !== null) {
        utterance.completeAt = null;
        void this.#checkTurn();
      }

      return false;
    }

    utterance.pieces.push(text);
    this.deps.vocabulary.used(text);
    this.#keptWordAt = this.#lastWordAt;
    return true;
  }

  /** The pieces held as a possible spoken command are dictation after all: they are reported and join the utterance. */
  #release(utterance: Utterance): void {
    for (const piece of utterance.pending.splice(0)) {
      if (!utterance.answer) {
        this.deps.send(piece);
      }

      utterance.pieces.push(piece.text);
      this.deps.vocabulary.used(piece.text);
    }
  }

  /**
   * Paused by voice: the pieces in the operator's voice gather until the words have been quiet for `voice.endPauseMs`, so a resume command
   * counts only as a whole utterance; another voice's pieces do not join and start a room hold.
   */
  #pausedPiece(text: string, audio: Float32Array): void {
    const check = this.deps.voiceprint?.check(audio, text, this.deps.settings()) ?? { score: null, f0: null, dropped: false, reason: null };

    if (check.dropped) {
      this.#roomVoice(audio);
      return;
    }

    this.#paused ??= { texts: [], checks: [], lastAt: this.deps.now() };
    this.#paused.texts.push(text);
    this.#paused.checks.push(check);
    this.#paused.lastAt = this.deps.now();
  }

  /** The words heard while paused by voice have been quiet long enough: a resume command among them alone resumes; the rest is forgotten. */
  #pausedQuiet(): void {
    const paused = this.#paused;

    if (paused === null || (this.#transcriber?.words ?? '') !== '' || this.deps.now() - paused.lastAt < this.deps.settings().endPauseMs) {
      return;
    }

    this.#paused = null;
    // Nothing of what was said while paused is kept: the recogniser starts afresh.
    this.#transcriber?.end(false);

    const text = paused.texts.join(' ');
    const command = spokenCommand(text);

    if (command === 'start-listening' && !paused.checks.every((check) => this.#fullMatch(check.score))) {
      // Two words pass the voice check with its short-piece allowance even in other voices (0.54 to 0.59 for synthetic ones), so resuming,
      // which lets dictation through again, needs the full voice.matchThreshold.
      this.deps.log(`"${text}" not taken: its voice match ${paused.checks.map((check) => check.score ?? 'unknown').join(', ')} is under voice.matchThreshold`);
    } else if (command !== null) {
      this.#command(command, text, null, paused.checks[0]!);
    }
  }

  /** Leaves the pause by voice, dropping what was heard during it, so none of it reaches the draft. */
  #leavePause(): void {
    this.#pausedByVoice = false;
    this.#paused = null;
    this.#transcriber?.take();
    this.#transcriber?.end(false);
  }

  /** Whether a voice check score clears `voice.matchThreshold` without the short-piece allowance; anything does without an enrolment. */
  #fullMatch(score: number | null): boolean {
    return this.deps.voiceprint?.enrolled !== true || (score !== null && score >= this.deps.settings().matchThreshold);
  }

  /** Does a spoken command, logs it and tells the hub; it goes to no session. */
  #command(command: SpokenCommand, text: string, utteranceId: string | null, check: { score: number | null; f0: number | null }): void {
    if (command === 'stop-listening' && !this.#pausedByVoice) {
      this.#pausedByVoice = true;
      this.deps.log(`listening paused by voice ("${text}"): only "start listening" is heard until then`);
    } else if (command === 'start-listening' && this.#pausedByVoice) {
      this.#pausedByVoice = false;
      this.deps.log(`listening resumed by voice ("${text}")`);
    } else {
      this.deps.log(`spoken command "${text}" heard: listening is already ${this.#pausedByVoice ? 'paused' : 'on'}`);
    }

    this.deps.send({ type: 'command', command, text, sessionId: this.#target?.sessionId ?? null, utteranceId, score: check.score, f0: check.f0 });
    this.#report();
  }

  /** Speech came: the open utterance, opened now if none is; null with no target to hear it for. */
  #spoke(): void {
    this.#open();
    this.#armIdle();
    this.deps.spoke();
  }

  #open(): Utterance | null {
    // While a spoken alert waits for its answer, whatever is said next is that answer, for no session.
    if (this.#utterance === null && (this.#target !== null || this.#answer !== null)) {
      const answer = this.#answer !== null;

      this.#utterance = { id: this.deps.newId(), gen: this.#target?.gen ?? 0, sessionId: answer ? '' : this.#target!.sessionId, pieces: [], lastActivity: this.deps.now(), completeAt: null, waitMs: 0, turn: null, words: '', interrupted: null, pending: [], answer };
      this.#report();
    }

    return this.#utterance;
  }

  /** The words said so far, settled and live. */
  #said(): string {
    return [...(this.#utterance?.pieces ?? []), ...(this.#utterance?.pending.map((one) => one.text) ?? []), this.#transcriber?.words ?? ''].join(' ').trim();
  }

  /** Asks the turn model whether the words so far are a finished turn; only the newest check of the open utterance counts. */
  async #checkTurn(): Promise<void> {
    const utterance = this.#utterance;
    const words = this.#said();

    if (this.deps.turn === null || utterance === null || words === '') {
      return;
    }

    const check = ++this.#checks;
    const at = utterance.lastActivity;
    const asked = this.deps.now();
    let p: number;

    try {
      p = await this.deps.turn.probability([
        { role: 'assistant', content: this.#contexts.get(utterance.sessionId) ?? '' },
        { role: 'user', content: words },
      ]);
    } catch (error) {
      this.deps.log(`turn model: ${(error as Error).message}`);
      return;
    }

    if (check !== this.#checks || this.#utterance !== utterance) {
      return;
    }

    utterance.turn = { p, ms: this.deps.now() - asked };
    utterance.waitMs = textWait(words, p, this.deps.turn.threshold, this.deps.settings().endPauseMs);
    utterance.completeAt = utterance.waitMs > 0 ? at : null;
  }

  /** Closes the open utterance once its words have been quiet for the wait the turn model earned, or for the end-of-message pause. */
  #tick(): void {
    if (this.#checking()) {
      for (const measure of this.#echo.due(this.deps.now())) {
        if (this.#auto.measured(measure)) {
          this.#applyDuplex();
        }
      }
    }

    // The voice may have started playing since the last audio came: an utterance open then is cut, never ended as final.
    if (this.#stream !== null && this.#halfDuplex !== null && this.#halfDuplexDeaf()) {
      return;
    }

    if (this.#pausedByVoice) {
      this.#pausedQuiet();
      return;
    }

    const utterance = this.#utterance;

    if (utterance === null) {
      return;
    }

    const quiet = this.deps.now() - utterance.lastActivity;

    if (utterance.completeAt === utterance.lastActivity && quiet >= utterance.waitMs) {
      const decidedAt = this.deps.now();
      // The words the turn model judged finished are checked first: when they fail the voice check, the turn is judged again without them.
      const rest = this.#transcriber?.take() ?? null;
      const kept = rest === null || this.#piece(rest.text, rest.audio);

      if (rest !== null && utterance.words !== '') {
        utterance.words = '';
        this.#sendWords(utterance, { type: 'words', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text: '' });
      }

      if (!kept) {
        return;
      }

      this.#close(true, false, { by: 'turn model', at: decidedAt });
    } else if (quiet >= pauseWait(this.#said(), this.deps.settings().endPauseMs)) {
      this.#close(true, false, { by: 'pause', at: this.deps.now() });
    }
  }

  /**
   * Ends the open utterance: its last words become a piece and the utterance is reported, `final` when turn detection ended it, by `ended`,
   * with a timing line in the voice log. After a stop (`drain`), the recogniser first gives up the words it held back, and the next message
   * starts with no preroll.
   */
  #close(final: boolean, drain = false, ended: { by: EndedBy; at: number } | null = null): void {
    const utterance = this.#utterance;
    const transcriber = this.#transcriber;

    if (transcriber !== null && drain) {
      transcriber.drain();
    }

    const rest = transcriber?.take() ?? null;

    if (rest !== null) {
      this.#piece(rest.text, rest.audio);
    }

    // An utterance that turn detection ended and that is only a spoken command is done, not sent; cut short, its words are dictation.
    if (utterance !== null && utterance.pending.length > 0) {
      const text = utterance.pending.map((one) => one.text).join(' ');
      const command = final && utterance.pieces.length === 0 ? spokenCommand(text) : null;

      if (command === null) {
        this.#release(utterance);
      } else {
        const [first] = utterance.pending.splice(0);

        this.#command(command, text, utterance.id, first!);
      }
    }

    const answer = utterance?.answer === true ? this.#answer : null;

    if (utterance !== null) {
      if (utterance.words !== '') {
        this.#sendWords(utterance, { type: 'words', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text: '' });
      }

      const endedAt = this.deps.now();
      const timing = ended === null ? undefined : { lastWordAt: utterance.lastActivity, decidedAt: ended.at, endedAt, endedBy: ended.by };

      if (timing !== undefined) {
        this.deps.log(`utterance ${utterance.id} ended ${endTiming(timing, utterance)}`);
      }

      // An utterance that kept nothing, all of it dropped by the voice check, ends as cut, so the hub sends nothing and forgets it.
      this.#sendWords(utterance, {
        type: 'utterance',
        gen: utterance.gen,
        utteranceId: utterance.id,
        sessionId: utterance.sessionId,
        text: utterance.pieces.join(' '),
        final: final && utterance.pieces.length > 0,
        interrupted: utterance.interrupted,
        ...(timing === undefined ? {} : { timing }),
      });
    }

    transcriber?.end(!drain);
    this.#utterance = null;
    this.#checks++;
    this.#report();

    if (answer !== null && utterance !== null) {
      const text = utterance.pieces.join(' ');

      this.deps.log(`alert answer ${utterance.id}: ${final && text !== '' ? `"${text}"` : 'none'}`);
      answer(final && text !== '' ? text : null, !final);
    }
  }

  /** Sends an utterance's report to the hub, unless it is an alert's answer, which goes to no session. */
  #sendWords(utterance: Utterance, message: Extract<VoiceMessage, { type: 'words' | 'utterance' }>): void {
    if (!utterance.answer) {
      this.deps.send(message);
    }
  }

  /** Cuts the open utterance short: the composer took the focus, the mic went off, the voice moved or the device failed. Nothing is sent. */
  #cut(drain: boolean): void {
    // Paused by voice: words cut short are no command, and nothing of them is kept.
    if (this.#pausedByVoice) {
      this.#paused = null;
      this.#transcriber?.take();
      this.#transcriber?.end(false);
      return;
    }

    if (this.#utterance !== null || (this.#transcriber?.words ?? '') !== '') {
      this.#close(false, drain);
    }
  }

  /** Another app started recording: the audio heard and the recognition in flight are dropped; the pieces already sent stay in the draft. */
  #discard(): void {
    const utterance = this.#utterance;

    this.#paused = null;
    this.#transcriber?.take();

    if (utterance !== null) {
      if (utterance.words !== '') {
        this.#sendWords(utterance, { type: 'words', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text: '' });
      }

      this.#sendWords(utterance, { type: 'utterance', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text: utterance.pieces.join(' '), final: false, interrupted: utterance.interrupted });
    }

    this.#transcriber?.end(false);
    this.#utterance = null;
    this.#checks++;

    if (utterance?.answer === true && this.#answer !== null) {
      this.#answer(null, true);
    }
  }

  /**
   * The room hold (architecture.md § Voice check and barge-in): a piece the voice check dropped is someone else in the room, unless a reply was
   * playing or stopped within `ROOM_ECHO_GUARD_MS`, or it sounds like a learnt reply voice, both its possible echo. While `voice.roomHold` is on,
   * dictated turns are held for `voice.roomHoldSeconds` after the latest such voice; the hub keeps them in the composer unsent.
   */
  #roomVoice(audio: Float32Array): void {
    const settings = this.deps.settings();
    const now = this.deps.now();

    if (!settings.roomHold) {
      return;
    }

    if (this.deps.playing?.() != null || now < (this.deps.playedUntil?.() ?? -Infinity) + ROOM_ECHO_GUARD_MS) {
      return;
    }

    const reply = this.deps.voiceprint?.replyVoiceScore(audio) ?? null;

    if (reply !== null && reply >= settings.matchThreshold) {
      this.deps.log(`no room hold: the dropped piece sounds like a reply voice (${reply})`);
      return;
    }

    const extended = this.#roomHoldUntil !== null;

    this.#roomHoldUntil = now + settings.roomHoldSeconds * 1000;

    if (this.#roomTimer !== null) {
      this.#clearTimer(this.#roomTimer);
    }

    this.#roomTimer = this.#timer(() => {
      this.#roomTimer = null;
      this.#roomHoldUntil = null;
      this.deps.log('room hold ended: dictated messages send on their own again');
      this.deps.changed();
    }, settings.roomHoldSeconds * 1000);
    this.deps.log(`room hold ${extended ? 'extended' : 'started'}: someone else is talking, so dictated messages stay in the composer for ${settings.roomHoldSeconds} s`);
    this.deps.changed();
  }

  #endRoomHold(): void {
    if (this.#roomTimer !== null) {
      this.#clearTimer(this.#roomTimer);
      this.#roomTimer = null;
    }

    this.#roomHoldUntil = null;
  }

  /** The mic idle timeout, `voice.micIdleMinutes` of silence; 0 never stops capture. */
  #armIdle(): void {
    this.#clearIdle();

    const minutes = this.deps.settings().micIdleMinutes;

    if (minutes > 0) {
      this.#idle = (this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms)))(() => {
        this.#idle = null;
        this.deps.log(`capture stopped after ${minutes} minutes of silence`);
        this.#cut(true);
        this.#idleOff = true;
        this.#sync();
      }, minutes * 60_000);
    }
  }

  #timer(run: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? ((call, wait) => setTimeout(call, wait)))(run, ms);
  }

  #clearTimer(timer: unknown): void {
    (this.deps.clearTimer ?? ((one) => clearTimeout(one as NodeJS.Timeout)))(timer);
  }

  #clearIdle(): void {
    if (this.#idle !== null) {
      (this.deps.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout)))(this.#idle);
      this.#idle = null;
    }
  }
}

/**
 * Whether capture listens while the voice plays (architecture.md § Dictation): `voice.duplex` for this computer or, when the capture runs in
 * a Remote Desktop session, for Remote Desktop, decides first. Under `auto`, capture that cancels the echo listens; capture that does not
 * listens only once the echo check (`auto`) heard no echo. `halfDuplex` is why listening pauses, null when it does not; `fullDuplex` why
 * capture that cancels no echo listens anyway, else null; `why` says what decided it, for the voice log.
 */
export function duplexMode(
  setting: VoiceSettings['duplex'],
  stream: Pick<CaptureStream, 'halfDuplex' | 'remote'>,
  auto: Pick<AutoDuplex, 'full' | 'reason'>,
): { halfDuplex: string | null; fullDuplex: string | null; why: string } {
  const where = stream.remote === true ? 'over Remote Desktop' : 'on this computer';
  const mode = setting[stream.remote === true ? 'remote' : 'local'];

  if (mode === 'half') {
    return { halfDuplex: `set to half duplex ${where}`, fullDuplex: null, why: `set to half duplex ${where}` };
  }

  if (stream.halfDuplex === null) {
    return { halfDuplex: null, fullDuplex: null, why: 'echo cancelled' };
  }

  if (mode === 'full') {
    return { halfDuplex: null, fullDuplex: `set ${where}`, why: `set to full duplex ${where}; ${stream.halfDuplex}` };
  }

  return auto.full
    ? { halfDuplex: null, fullDuplex: auto.reason, why: `${auto.reason}; ${stream.halfDuplex}` }
    : { halfDuplex: `${stream.halfDuplex}; ${auto.reason}`, fullDuplex: null, why: `${stream.halfDuplex}; ${auto.reason}` };
}

/** What the playback device's form factor hints of headphones; null when the watcher has not said or does not know. */
function outputHint(devices: AudioDevices | null): OutputHint | null {
  if (devices === null || devices.formFactor === 'unknown') {
    return null;
  }

  return { headphones: devices.formFactor === 'headphones' || devices.formFactor === 'headset', why: `form factor ${devices.formFactor} of "${devices.output}"` };
}

/**
 * An utterance end's timing line: what ended it, the quiet since the last recognised word, the turn model's answer, and the time the last piece's
 * voice check took, which runs before the end is sent.
 */
function endTiming(timing: UtteranceTiming, utterance: Utterance): string {
  const model = utterance.turn === null ? 'no turn model answer' : `turn model p ${utterance.turn.p.toFixed(3)} in ${utterance.turn.ms} ms`;
  const wait = timing.endedBy === 'turn model' ? `, earned quiet ${utterance.waitMs} ms` : '';

  return `by the ${timing.endedBy}: last word → decision ${timing.decidedAt - timing.lastWordAt} ms (${model}${wait}), decision → sent ${timing.endedAt - timing.decidedAt} ms (the last piece's voice check)`;
}

function every(run: () => void, ms: number): { stop(): void } {
  const timer = setInterval(run, ms);

  return { stop: () => clearInterval(timer) };
}
