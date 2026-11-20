import type { VoiceSettings } from '@switchboard/core/settings';
import { ASR_RATE, pcmToSamples, Transcriber } from './asr.js';
import { BargeIn, gate } from './barge.js';
import type { AsrEngine } from './asr.js';
import type { AsrDevice } from './sherpa.js';
import type { MicUse } from './micUse.js';
import type { Capture, CaptureStream } from './output.js';
import { ENROLL_SECONDS } from './protocol.js';
import type { Interrupted, MicState, SpokenCommand, VoiceMessage } from './protocol.js';
import { hotwordList } from './hotwords.js';
import { pauseWait, textWait } from './turn.js';
import type { TurnModel } from './turn.js';
import { loudness } from './voiceprint.js';
import type { Voiceprint } from './voiceprint.js';

/** How often an open message is checked for its end. */
export const TURN_TICK_MS = 100;
/** A barge-in's words are recognised again from this long before the voice that passed the check. */
const BARGE_PREROLL = 0.3 * ASR_RATE;
/** After a reply ends, audio still this loud in its last 0.6 s keeps the words held and checked for up to `TAIL_HOLD_MS`. */
const TAIL_KEEP = 0.6 * ASR_RATE;
const TAIL_HOLD_MS = 1_500;
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
  /** Loads the recogniser biased toward the terms, or says why it cannot run; it blocks while the model loads, about 2 seconds. */
  recognizer(terms: string[]): AsrEngine | { error: string };
  vocabulary: { terms(repo: string | null): string[]; used(text: string): void };
  turn: TurnModel | null;
  /** Starts watching other apps' recording; null where nothing can watch, and the voice never pauses for another app. */
  watchMicUse(changed: (busy: boolean, apps: string[]) => void, failed: () => void): MicUse | null;
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
  /** Words shown and not settled yet. */
  words: string;
  /** The reply it spoke over, when a barge-in opened it. */
  interrupted: Interrupted | null;
  /** Its first pieces while they are a spoken command or its start: not reported until the utterance ends or another piece follows. */
  pending: Array<Extract<VoiceMessage, { type: 'piece' }>>;
}

/** A reply being played while capture runs: words heard then are held back, since they may be its echo, until barge-in says they are the operator's. */
interface Playback {
  replyId: string;
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
  #typing = false;
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
  /** The capture mode last logged: a half-duplex reason, or null for full duplex; undefined before the first open. */
  #loggedDuplex: string | null | undefined = undefined;
  /** When the room hold ends (epoch milliseconds), while one runs: the voice check heard someone else (`voice.roomHold`). */
  #roomHoldUntil: number | null = null;
  #roomTimer: unknown = null;
  /** "Stop listening" paused dictation: the recogniser runs, but only "start listening" is heard. */
  #pausedByVoice = false;
  /** The pieces in the operator's voice heard while paused, until the words have been quiet for `voice.endPauseMs`; null with none. */
  #paused: { texts: string[]; checks: Array<{ score: number | null; f0: number | null }>; lastAt: number } | null = null;

  constructor(private readonly deps: DictationDeps) {}

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

    if (this.#idleOff || this.#target === null) {
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
    return this.#stream?.halfDuplex ?? null;
  }

  /** When the room hold ends, while one runs, else null (architecture.md § Voice check and barge-in). */
  get roomHold(): number | null {
    return this.#roomHoldUntil;
  }

  /** Why capture or recognition cannot run; null while they can. */
  get error(): string | null {
    return this.#error;
  }

  /** Where the recogniser loaded last runs, or null before one loads. */
  get recognizer(): AsrDevice | null {
    return this.#engine?.engine.device ?? null;
  }

  /** The operator turned the mic on or off. Turning it on starts again after the idle timeout, an error or a pause by voice. */
  mic(on: boolean): void {
    if (on === this.#micOn) {
      if (on && (this.#idleOff || this.#error !== null || this.#pausedByVoice)) {
        if (this.#pausedByVoice) {
          this.deps.log('listening resumed: the mic was turned on');
          this.#leavePause();
        }

        this.#idleOff = false;
        this.#error = null;
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
      this.#watch = this.deps.watchMicUse(
        (busy, apps) => this.#otherAppChanged(busy, apps),
        () => this.#otherAppChanged(false, []),
      );

      if (this.#watch === null) {
        this.#otherApp = false;
      }
    } else {
      this.#cut(true);
      this.#watch?.close();
      this.#watch = null;
      this.#otherApp = null;
    }

    this.#sync();
  }

  /** The here window's composer gained or lost the focus: recognition in flight is finished into the draft and listening pauses. */
  typing(on: boolean): void {
    if (on === this.#typing) {
      return;
    }

    this.#typing = on;

    if (on) {
      this.#cut(true);
    }

    this.#sync();
  }

  /** The voice target changed: an utterance open for the earlier one is closed unsent, and the recogniser loads the new one's terms. */
  target(gen: number, sessionId: string | null, repo: string | null): void {
    if (this.#utterance !== null && (this.#utterance.gen !== gen || this.#utterance.sessionId !== sessionId)) {
      this.#cut(true);
    }

    this.#target = sessionId === null ? null : { gen, sessionId, repo };

    if (this.#target !== null && this.#stream !== null && !this.#loadEngine()) {
      this.#stopCapture();
    }

    this.#sync();
  }

  /** A session's latest reply, which the turn model reads. */
  context(sessionId: string, lastReply: string): void {
    this.#contexts.set(sessionId, lastReply);
  }

  /** Audio being played, for echo cancellation. */
  reference(pcm: Buffer): void {
    this.#stream?.reference(pcm);
  }

  /** The settings were reloaded: the idle timeout starts again with its new length. */
  settingsChanged(): void {
    if (this.#stream !== null) {
      this.#armIdle();
    }

    if (!this.deps.settings().roomHold && this.#roomHoldUntil !== null) {
      this.#endRoomHold();
      this.deps.log('room hold ended: voice.roomHold is off');
      this.deps.changed();
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
  }

  close(): void {
    if (this.#enrollment !== null) {
      this.#clearTimer(this.#enrollment.timer);
      this.#enrollment = null;
    }

    this.#micOn = false;
    this.#watch?.close();
    this.#watch = null;
    this.#stopCapture();
    this.#endRoomHold();
    this.deps.turn?.close();
  }

  #otherAppChanged(busy: boolean, apps: string[]): void {
    const was = this.#otherApp;

    if (busy === was) {
      return;
    }

    this.#otherApp = busy;


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
    return this.#micOn && this.#otherApp === false && !this.#idleOff && this.#target !== null && !this.#typing;
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
    const text = `${this.state} ${this.recognizer ?? ''} ${this.#error ?? ''} ${this.halfDuplex ?? ''}`;

    if (text !== this.#reported) {
      this.#reported = text;
      this.deps.changed();
    }
  }

  /** Loads the recogniser for the target's terms when they changed; false, with the error kept, when it cannot run. */
  #loadEngine(): boolean {
    // The spoken commands are boosted, so they are heard as said.
    const terms = hotwordList(this.deps.vocabulary.terms(this.#target?.repo ?? null), Object.keys(SPOKEN_COMMANDS));
    const key = terms.join('\n');

    if (this.#engine?.key === key) {
      return true;
    }

    const engine = this.deps.recognizer(terms);

    if ('error' in engine) {
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
    });
    return true;
  }

  async #startCapture(): Promise<void> {
    const forEnrollment = this.#enrollment !== null;

    if (!forEnrollment && !this.#loadEngine()) {
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

    if (!forEnrollment && stream.halfDuplex !== this.#loggedDuplex) {
      this.#loggedDuplex = stream.halfDuplex;
      this.deps.log(stream.halfDuplex === null ? 'listening: full duplex (echo cancelled)' : `listening: half-duplex (${stream.halfDuplex})`);
    }

    this.#ticker = (this.deps.every ?? every)(() => this.#tick(), TURN_TICK_MS);
    this.#armIdle();
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

    if (this.#stream?.halfDuplex != null && this.#halfDuplexDeaf()) {
      return;
    }

    this.#trackPlayback();
    this.#transcriber?.feed(samples);

    // Paused by voice, a reply is not stopped by talking over it.
    if (this.#holding() && !this.#pausedByVoice) {
      this.#checkBarge();
    }
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
        this.#playback = { replyId: playing.replyId, barge: new BargeIn(this.deps.voiceprint ?? null, playing.text, playing.voice), barged: false, endedAt: null, held: playback?.held ?? '' };
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
    }

    this.deps.send({ type: 'words', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text });
  }

  /**
   * A piece settled: the voice check judges its audio (architecture.md § Voice check and barge-in), and only a piece that passes joins the
   * utterance, so someone else's words neither reach the session nor end the operator's turn.
   */
  #piece(text: string, audio: Float32Array): boolean {
    if (this.#holding()) {
      this.#playback!.held = [this.#playback!.held, text].filter((one) => one !== '').join(' ');
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

    this.deps.send(piece);

    if (check.dropped) {
      this.deps.log(`piece dropped by the voice check (${check.reason === 'pitch' ? 'pitch' : 'score'} ${check.reason === 'pitch' ? `${check.f0} Hz` : check.score}): ${text}`);
      this.#roomVoice(audio);

      // An end the turn model judged on words that included these is judged again without them.
      if (utterance.completeAt !== null) {
        utterance.completeAt = null;
        void this.#checkTurn();
      }

      return false;
    }

    utterance.pieces.push(text);
    this.deps.vocabulary.used(text);
    return true;
  }

  /** The pieces held as a possible spoken command are dictation after all: they are reported and join the utterance. */
  #release(utterance: Utterance): void {
    for (const piece of utterance.pending.splice(0)) {
      this.deps.send(piece);
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
    if (this.#utterance === null && this.#target !== null) {
      this.#utterance = { id: this.deps.newId(), gen: this.#target.gen, sessionId: this.#target.sessionId, pieces: [], lastActivity: this.deps.now(), completeAt: null, waitMs: 0, words: '', interrupted: null, pending: [] };
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

    utterance.waitMs = textWait(words, p, this.deps.turn.threshold, this.deps.settings().endPauseMs);
    utterance.completeAt = utterance.waitMs > 0 ? at : null;
  }

  /** Closes the open utterance once its words have been quiet for the wait the turn model earned, or for the end-of-message pause. */
  #tick(): void {
    // The voice may have started playing since the last audio came: an utterance open then is cut, never ended as final.
    if (this.#stream?.halfDuplex != null && this.#halfDuplexDeaf()) {
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
      // The words the turn model judged finished are checked first: when they fail the voice check, the turn is judged again without them.
      const rest = this.#transcriber?.take() ?? null;
      const kept = rest === null || this.#piece(rest.text, rest.audio);

      if (rest !== null && utterance.words !== '') {
        utterance.words = '';
        this.deps.send({ type: 'words', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text: '' });
      }

      if (!kept) {
        return;
      }

      this.#close(true);
    } else if (quiet >= pauseWait(this.#said(), this.deps.settings().endPauseMs)) {
      this.#close(true);
    }
  }

  /**
   * Ends the open utterance: its last words become a piece and the utterance is reported, `final` when turn detection ended it. After a stop
   * (`drain`), the recogniser first gives up the words it held back, and the next message starts with no preroll.
   */
  #close(final: boolean, drain = false): void {
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

    if (utterance !== null) {
      if (utterance.words !== '') {
        this.deps.send({ type: 'words', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text: '' });
      }

      // An utterance that kept nothing, all of it dropped by the voice check, ends as cut, so the hub sends nothing and forgets it.
      this.deps.send({ type: 'utterance', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text: utterance.pieces.join(' '), final: final && utterance.pieces.length > 0, interrupted: utterance.interrupted });
    }

    transcriber?.end(!drain);
    this.#utterance = null;
    this.#checks++;
    this.#report();
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
        this.deps.send({ type: 'words', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text: '' });
      }

      this.deps.send({ type: 'utterance', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text: utterance.pieces.join(' '), final: false, interrupted: utterance.interrupted });
    }

    this.#transcriber?.end(false);
    this.#utterance = null;
    this.#checks++;
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

function every(run: () => void, ms: number): { stop(): void } {
  const timer = setInterval(run, ms);

  return { stop: () => clearInterval(timer) };
}
