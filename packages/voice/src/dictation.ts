import type { VoiceSettings } from '@switchboard/core/settings';
import { pcmToSamples, Transcriber } from './asr.js';
import type { AsrEngine } from './asr.js';
import type { MicUse } from './micUse.js';
import type { Capture, CaptureStream } from './output.js';
import type { MicState, VoiceMessage } from './protocol.js';
import { pauseWait, textWait } from './turn.js';
import type { TurnModel } from './turn.js';

/** How often an open message is checked for its end. */
export const TURN_TICK_MS = 100;

export interface DictationDeps {
  capture: Capture;
  /** Loads the recogniser biased toward the terms, or says why it cannot run; it blocks while the model loads, about 2 seconds. */
  recognizer(terms: string[]): AsrEngine | { error: string };
  vocabulary: { terms(repo: string | null): string[]; used(text: string): void };
  turn: TurnModel | null;
  /** Starts watching other apps' recording; null where nothing can watch, and the voice never pauses for another app. */
  watchMicUse(changed: (busy: boolean, apps: string[]) => void, failed: () => void): MicUse | null;
  settings(): VoiceSettings;
  /** `words`, `piece` and `utterance` to the hub. */
  send(message: Extract<VoiceMessage, { type: 'words' | 'piece' | 'utterance' }>): void;
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
  #engine: { key: string; engine: AsrEngine } | null = null;
  #transcriber: Transcriber | null = null;
  #utterance: Utterance | null = null;
  readonly #contexts = new Map<string, string>();
  #checks = 0;
  #watch: MicUse | null = null;
  #idle: unknown = null;
  #ticker: { stop(): void } | null = null;
  #reported = '';

  constructor(private readonly deps: DictationDeps) {}

  get state(): MicState {
    if (!this.#micOn) {
      return 'off';
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

    if (this.#typing) {
      return 'typing';
    }

    if (this.#stream === null) {
      return 'starting';
    }

    return this.#utterance === null ? 'listening' : 'hearing';
  }

  /** Why capture or recognition cannot run; null while they can. */
  get error(): string | null {
    return this.#error;
  }

  /** The operator turned the mic on or off. Turning it on starts again after the idle timeout or an error. */
  mic(on: boolean): void {
    if (on === this.#micOn) {
      if (on && (this.#idleOff || this.#error !== null)) {
        this.#idleOff = false;
        this.#error = null;
        this.#sync();
      }

      return;
    }

    this.#micOn = on;

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
  }

  close(): void {
    this.#micOn = false;
    this.#watch?.close();
    this.#watch = null;
    this.#stopCapture();
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

  /** Starts or stops capture for the current state, and reports the state when it changed. */
  #sync(): void {
    const wanted = this.#micOn && this.#error === null && this.#otherApp === false && !this.#idleOff && this.#target !== null && !this.#typing;

    if (wanted && this.#stream === null && !this.#opening) {
      void this.#startCapture();
    } else if (!wanted && this.#stream !== null) {
      this.#stopCapture();
    }

    this.#report();
  }

  #report(): void {
    const text = `${this.state} ${this.#error ?? ''}`;

    if (text !== this.#reported) {
      this.#reported = text;
      this.deps.changed();
    }
  }

  /** Loads the recogniser for the target's terms when they changed; false, with the error kept, when it cannot run. */
  #loadEngine(): boolean {
    const terms = this.deps.vocabulary.terms(this.#target?.repo ?? null);
    const key = terms.join('\n');

    if (this.#engine?.key === key) {
      return true;
    }

    const engine = this.deps.recognizer(terms);

    if ('error' in engine) {
      this.#error = engine.error;
      this.deps.log(engine.error);
      return false;
    }

    this.#engine = { key, engine };
    this.#transcriber = new Transcriber(engine, {
      onWords: (text) => this.#words(text),
      onPiece: (text) => this.#piece(text),
      onQuiet: () => void this.#checkTurn(),
    });
    return true;
  }

  async #startCapture(): Promise<void> {
    if (!this.#loadEngine()) {
      this.#report();
      return;
    }

    this.#opening = true;
    this.#report();

    let stream: CaptureStream;

    try {
      stream = await this.deps.capture.open(
        this.deps.settings().inputDevice,
        (pcm) => this.#transcriber?.feed(pcmToSamples(pcm)),
        (error) => this.#failed(error),
      );
    } catch (error) {
      this.#opening = false;
      this.#failed(error as Error);
      return;
    }

    this.#opening = false;

    // The state moved on while the device opened.
    if (!this.#micOn || this.#error !== null || this.#otherApp !== false || this.#idleOff || this.#target === null || this.#typing) {
      stream.stop();
      this.#sync();
      return;
    }

    this.#stream = stream;
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

  #failed(error: Error): void {
    this.#error = `The microphone failed: ${error.message}`;
    this.deps.log(this.#error);
    this.#cut(false);
    this.#stopCapture();
    this.#report();
  }

  #words(text: string): void {
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

  #piece(text: string): void {
    const utterance = this.#open();

    if (utterance === null) {
      return;
    }

    utterance.pieces.push(text);
    this.deps.vocabulary.used(text);
    this.deps.send({ type: 'piece', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, pieceId: this.deps.newId(), text, score: null, f0: null, dropped: false });
  }

  /** Speech came: the open utterance, opened now if none is; null with no target to hear it for. */
  #spoke(): void {
    this.#open();
    this.#armIdle();
    this.deps.spoke();
  }

  #open(): Utterance | null {
    if (this.#utterance === null && this.#target !== null) {
      this.#utterance = { id: this.deps.newId(), gen: this.#target.gen, sessionId: this.#target.sessionId, pieces: [], lastActivity: this.deps.now(), completeAt: null, waitMs: 0, words: '' };
      this.#report();
    }

    return this.#utterance;
  }

  /** The words said so far, settled and live. */
  #said(): string {
    return [...(this.#utterance?.pieces ?? []), this.#transcriber?.words ?? ''].join(' ').trim();
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
    const utterance = this.#utterance;

    if (utterance === null) {
      return;
    }

    const quiet = this.deps.now() - utterance.lastActivity;

    if (utterance.completeAt === utterance.lastActivity && quiet >= utterance.waitMs) {
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
      this.#piece(rest);
    }

    if (utterance !== null) {
      if (utterance.words !== '') {
        this.deps.send({ type: 'words', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text: '' });
      }

      if (utterance.pieces.length > 0 || !final) {
        this.deps.send({ type: 'utterance', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text: utterance.pieces.join(' '), final, interrupted: null });
      }
    }

    transcriber?.end(!drain);
    this.#utterance = null;
    this.#checks++;
    this.#report();
  }

  /** Cuts the open utterance short: the composer took the focus, the mic went off, the voice moved or the device failed. Nothing is sent. */
  #cut(drain: boolean): void {
    if (this.#utterance !== null || (this.#transcriber?.words ?? '') !== '') {
      this.#close(false, drain);
    }
  }

  /** Another app started recording: the audio heard and the recognition in flight are dropped; the pieces already sent stay in the draft. */
  #discard(): void {
    const utterance = this.#utterance;

    this.#transcriber?.take();

    if (utterance !== null) {
      if (utterance.words !== '') {
        this.deps.send({ type: 'words', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text: '' });
      }

      this.deps.send({ type: 'utterance', gen: utterance.gen, utteranceId: utterance.id, sessionId: utterance.sessionId, text: utterance.pieces.join(' '), final: false, interrupted: null });
    }

    this.#transcriber?.end(false);
    this.#utterance = null;
    this.#checks++;
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
