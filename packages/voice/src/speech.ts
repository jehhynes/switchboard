import type { Output, Playback } from './output.js';
import { needsYouChime } from './output.js';
import type { SpeechState, VoiceMessage } from './protocol.js';
import { BYTES_PER_MS } from './tts.js';
import type { Speaking, SpeechVoice } from './tts.js';

/** How often a playing reply reports its position. */
export const PROGRESS_MS = 150;
/** Speech's pace at speed 1, for the share of a passage said before its audio has all come. */
const MS_PER_CHAR = 65;

/** A reply's passage to speak, of the generation it was offered in. */
export interface SpeechItem {
  gen: number;
  replyId: string;
  sessionId: string;
  text: string;
  tone: string | null;
  /** The message it answers: the replies of one turn play in order, and a reply of a newer turn waiting skips the older ones (decision 24). */
  turn: string | null;
  /** Its persona's voice, style and personality; the settings' when left out. */
  as?: SpeechVoice;
}

export interface SpeechDeps {
  tts: { speak(text: string, tone: string | null, onAudio: (pcm: Buffer) => void, as?: SpeechVoice): Speaking };
  output: Output;
  /** The playback device, read at each playback. */
  device(): string | null;
  report(message: Extract<VoiceMessage, { type: 'speech' | 'progress' }>): void;
  /** Playback or speech failed with why, or worked again (null), for the `audio` report. */
  failed(error: string | null): void;
  now(): number;
  log(line: string): void;
  every?(run: () => void, ms: number): { stop(): void };
}

interface Current {
  item: SpeechItem;
  speaking: Speaking | null;
  playback: Playback | null;
  startedAt: number | null;
  writtenMs: number;
  /** All its audio came, so `writtenMs` is its length. */
  complete: boolean;
  ended: boolean;
  ticker: { stop(): void } | null;
}

/**
 * Speaks the offered replies one at a time (voice-design § 2.3): each to its end, the replies of one turn in order, and when a reply's turn
 * comes while a reply of a newer turn waits, it is skipped. The needs-you sound plays between replies, never over one. It holds no conversation
 * state: it reports what it did, by reply ID and generation.
 */
export class Speech {
  readonly #queue: SpeechItem[] = [];
  #current: Current | null = null;
  #chimePending = false;
  #chiming = false;

  constructor(private readonly deps: SpeechDeps) {}

  /** The reply playing now, or null. */
  get playing(): SpeechItem | null {
    return this.#current?.item ?? null;
  }

  /** The replies waiting their turn. */
  get queued(): readonly SpeechItem[] {
    return this.#queue;
  }

  speak(item: SpeechItem): void {
    this.#queue.push(item);
    this.#next();
  }

  /** An offered reply must not play: stopped if it plays, dropped if it waits, and reported `skipped`. */
  cancel(replyId: string): void {
    const current = this.#current;

    if (current?.item.replyId === replyId) {
      this.#end(current, 'skipped');
      this.#next();
      return;
    }

    const at = this.#queue.findIndex((item) => item.replyId === replyId);

    if (at !== -1) {
      const [item] = this.#queue.splice(at, 1);

      this.#report(item!, 'skipped', null, null);
    }
  }

  /** Stop speaking: the playing reply is `interrupted` where it stopped, and the waiting ones `skipped`. */
  stop(): void {
    const current = this.#current;

    if (current !== null) {
      const { atMs, said } = this.#position(current);

      this.#end(current, 'interrupted', atMs, said);
    }

    for (const item of this.#queue.splice(0)) {
      this.#report(item, 'skipped', null, null);
    }

    this.#next();
  }

  /** The voice target moved: everything stops and is dropped unreported; the hub marks it stopped by the move. */
  halt(): void {
    const current = this.#current;

    if (current !== null) {
      this.#end(current, null);
    }

    this.#queue.splice(0);
    this.#next();
  }

  /** The needs-you sound: now, or after the reply playing now. */
  earcon(): void {
    this.#chimePending = true;
    this.#next();
  }

  #next(): void {
    if (this.#current !== null || this.#chiming) {
      return;
    }

    if (this.#chimePending) {
      this.#chimePending = false;
      void this.#chime();
      return;
    }

    const item = this.#queue.shift();

    if (item === undefined) {
      return;
    }

    // A reply of a newer turn is waiting: this one's moment has passed.
    if (this.#queue.some((later) => later.turn !== item.turn)) {
      this.#report(item, 'skipped', null, null);
      this.#next();
      return;
    }

    this.#play(item);
  }

  async #chime(): Promise<void> {
    this.#chiming = true;

    try {
      const playback = await this.deps.output.open(this.deps.device());

      await playback.write(needsYouChime());
      await playback.drain();
      playback.stop();
    } catch (error) {
      this.deps.log(`the needs-you sound did not play: ${(error as Error).message}`);
      this.deps.failed((error as Error).message);
    } finally {
      this.#chiming = false;
      this.#next();
    }
  }

  #play(item: SpeechItem): void {
    const current: Current = { item, speaking: null, playback: null, startedAt: null, writtenMs: 0, complete: false, ended: false, ticker: null };
    let chain: Promise<void> = this.deps.output.open(this.deps.device()).then((playback) => {
      current.playback = playback;

      if (current.ended) {
        playback.stop();
      }
    });

    this.#current = current;

    try {
      current.speaking = this.deps.tts.speak(item.text, item.tone, (pcm) => {
        chain = chain.then(async () => {
          if (current.ended || current.playback === null) {
            return;
          }

          await current.playback.write(pcm);
          current.writtenMs += pcm.length / BYTES_PER_MS;

          if (current.startedAt === null) {
            current.startedAt = this.deps.now();
            this.#report(item, 'playing', 0, 0);
            current.ticker = (this.deps.every ?? every)(() => this.#progress(current), PROGRESS_MS);
          }
        });
      }, item.as);
    } catch (error) {
      this.#fail(current, error as Error);
      return;
    }

    current.speaking.done
      .then(() => {
        current.complete = true;

        return chain;
      })
      .then(() => current.playback?.drain())
      .then(
        () => {
          if (!current.ended) {
            this.deps.failed(null);
            this.#end(current, 'played', Math.round(current.writtenMs), item.text.length);
            this.#next();
          }
        },
        (error: unknown) => this.#fail(current, error as Error),
      );
    // The playback failing to open fails the reply even while its speech still streams.
    chain.catch((error: unknown) => this.#fail(current, error as Error));
  }

  #fail(current: Current, error: Error): void {
    if (current.ended) {
      return;
    }

    this.deps.log(`reply ${current.item.replyId} was not spoken: ${error.message}`);
    this.deps.failed(error.message);
    this.#end(current, 'failed');
    this.#next();
  }

  /** Where playback stands: how long it has played and how much of the passage that covers. */
  #position(current: Current): { atMs: number; said: number } {
    const playedMs = current.startedAt === null ? 0 : Math.min(this.deps.now() - current.startedAt, current.writtenMs);
    const totalMs = current.complete ? current.writtenMs : Math.max(current.writtenMs, current.item.text.length * MS_PER_CHAR);
    const said = totalMs <= 0 ? 0 : Math.min(current.item.text.length, Math.round((current.item.text.length * playedMs) / totalMs));

    return { atMs: Math.round(playedMs), said };
  }

  #progress(current: Current): void {
    if (current.ended || current.startedAt === null) {
      return;
    }

    const { atMs, said } = this.#position(current);

    this.deps.report({ type: 'progress', gen: current.item.gen, replyId: current.item.replyId, sessionId: current.item.sessionId, chars: said, atMs });
  }

  /** Ends the current reply, stopping its speech and playback; reports `state` unless it is null. */
  #end(current: Current, state: SpeechState | null, atMs: number | null = null, said: number | null = null): void {
    current.ended = true;
    current.ticker?.stop();
    current.speaking?.cancel();
    current.playback?.stop();

    if (this.#current === current) {
      this.#current = null;
    }

    if (state !== null) {
      this.#report(current.item, state, atMs, said);
    }
  }

  #report(item: SpeechItem, state: SpeechState, atMs: number | null, said: number | null): void {
    this.deps.report({ type: 'speech', gen: item.gen, replyId: item.replyId, sessionId: item.sessionId, state, atMs, said });
  }
}

function every(run: () => void, ms: number): { stop(): void } {
  const timer = setInterval(run, ms);

  return { stop: () => clearInterval(timer) };
}
