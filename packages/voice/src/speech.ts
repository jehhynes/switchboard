import type { Output, Playback } from './output.js';
import { needsYouChime } from './output.js';
import type { SpeechState, VoiceMessage } from './protocol.js';
import { BYTES_PER_MS } from './tts.js';
import type { Speaking, SpeechVoice } from './tts.js';

/** How often a playing reply reports its position. */
export const PROGRESS_MS = 150;
/** Speech's pace at speed 1, for the share of a passage said before its audio has all come. */
const MS_PER_CHAR = 65;
/** Why a reply did not play, or stopped, as its speech outcome says it. */
const SPOKEN_OVER = 'its turn was spoken over';
const CANCELLED = 'cancelled by the hub';
const SPEAK_REPLIES_OFF = 'Speak replies turned off';

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
  /**
   * Set on a spoken alert's line (architecture.md § Spoken alerts), which is no reply: what became of it goes to this callback instead of the
   * hub, a move of the voice target does not stop it, and it never makes a reply of another turn skip.
   */
  line?: (state: SpeechState) => void;
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
  /** The turn whose reply the operator spoke over: its later replies are skipped, so only the answer to what they said is heard. */
  #bargedTurn: string | null = null;
  /** When the last reply or needs-you sound stopped playing. */
  #quietSince = -Infinity;
  /** Why nothing may play now, or null while it may. */
  #muted: string | null = null;
  /** The needs-you sound's playback while it plays, and a count that muting raises so a sound still opening never plays. */
  #chimePlayback: Playback | null = null;
  #chimeRun = 0;

  constructor(private readonly deps: SpeechDeps) {}

  /** The reply playing now, or null. */
  get playing(): SpeechItem | null {
    return this.#current?.item ?? null;
  }

  /**
   * Until when the voice plays: `Infinity` while a reply (from its request, before its audio comes) or the needs-you sound plays, else when the
   * last one stopped, `-Infinity` before any; half-duplex dictation does not listen until a tail after it (architecture.md § Dictation).
   */
  get playedUntil(): number {
    return this.#current !== null || this.#chiming ? Infinity : this.#quietSince;
  }

  /** The replies waiting their turn. */
  get queued(): readonly SpeechItem[] {
    return this.#queue;
  }

  /** Nothing plays or waits: no reply, alert line or needs-you sound. */
  get idle(): boolean {
    return this.#current === null && this.#queue.length === 0 && !this.#chiming && !this.#chimePending;
  }

  /** A spoken alert's line: it waits for what plays or waits before it, as a reply does; while muted it is `skipped`. */
  say(item: SpeechItem & { line: (state: SpeechState) => void }): void {
    if (this.#muted !== null) {
      this.#unplayed(item, 'skipped', this.#muted);
      return;
    }

    this.#queue.push(item);
    this.#next();
  }

  speak(item: SpeechItem): void {
    if (this.#muted !== null) {
      this.#unplayed(item, 'skipped', this.#muted);
      return;
    }

    if (this.#bargedTurn !== null && item.turn === this.#bargedTurn) {
      this.#unplayed(item, 'skipped', SPOKEN_OVER);
      return;
    }

    this.#bargedTurn = null;
    this.#queue.push(item);
    this.#next();
  }

  /**
   * An offered reply must not play: stopped if it plays, dropped if it waits, and reported `skipped`. With `off`, Speak replies was turned off, and
   * a reply that started playing is `interrupted` where it stopped, as Stop speaking leaves it, since the operator heard part of it; nothing else
   * is touched.
   */
  cancel(replyId: string, off = false): void {
    const current = this.#current;

    if (current?.item.replyId === replyId) {
      if (off && current.startedAt !== null) {
        const { atMs, said } = this.#position(current);

        this.#end(current, 'interrupted', atMs, said, SPEAK_REPLIES_OFF);
      } else if (off) {
        // Nothing of it played yet.
        this.#end(current, 'skipped', null, null, SPEAK_REPLIES_OFF);
      } else {
        this.#end(current, 'skipped', null, null, CANCELLED);
      }

      this.#next();
      return;
    }

    const at = this.#queue.findIndex((item) => item.replyId === replyId);

    if (at !== -1) {
      const [item] = this.#queue.splice(at, 1);

      this.#unplayed(item!, 'skipped', CANCELLED);
    }
  }

  /** Stop speaking: the playing reply is `interrupted` where it stopped, and the waiting ones `skipped`. */
  stop(): void {
    this.#stop('Stop speaking');
  }

  /**
   * Barge-in (architecture.md § Voice check and barge-in): stops as Stop speaking does, and skips the later replies of the turn spoken over, so
   * only the answer to what the operator said is heard. The playing reply and how much of its passage played, or null with none playing.
   */
  interrupt(): { item: SpeechItem; atMs: number; said: number } | null {
    const stopped = this.#stop(SPOKEN_OVER);

    this.#bargedTurn = stopped?.item.turn ?? null;
    return stopped;
  }

  #stop(why: string): { item: SpeechItem; atMs: number; said: number } | null {
    const current = this.#current;
    let stopped: { item: SpeechItem; atMs: number; said: number } | null = null;

    if (current !== null) {
      const { atMs, said } = this.#position(current);

      stopped = { item: current.item, atMs, said };
      this.#end(current, 'interrupted', atMs, said, why);
    }

    for (const item of this.#queue.splice(0)) {
      this.#unplayed(item, 'skipped', why);
    }

    this.#next();
    return stopped;
  }

  /**
   * The voice target moved: every reply stops and is dropped unreported; the hub marks it stopped by the move. An alert line belongs to no target,
   * so it plays on.
   */
  halt(): void {
    const current = this.#current;

    this.#bargedTurn = null;

    if (current !== null && current.item.line === undefined) {
      this.#end(current, null);
    }

    for (const item of this.#queue.splice(0)) {
      if (item.line === undefined) {
        this.#logEnd(item, 'stopped-moved', 0, 0);
      } else {
        this.#queue.push(item);
      }
    }

    this.#next();
  }

  /**
   * Nothing plays while muted, as while the operator is away from the computer (architecture.md § Dictation): muting stops as Stop speaking does
   * and drops a waiting needs-you sound; a reply offered while muted is `skipped` and a needs-you sound dropped. `why` names the cause in what
   * it stops or skips, such as "no device: the phone that had the voice left"; null unmutes.
   */
  mute(why: string | null): void {
    const was = this.#muted;

    this.#muted = why;

    if (why !== null && was === null) {
      this.#chimePending = false;
      this.#chimeRun++;
      this.#chimePlayback?.stop();
      this.#stop(why);
    }
  }

  /** The needs-you sound: now, or after the reply playing now. */
  earcon(): void {
    if (this.#muted !== null) {
      return;
    }

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
    if (item.line === undefined && this.#queue.some((later) => later.line === undefined && later.turn !== item.turn)) {
      this.#unplayed(item, 'skipped', 'a reply of a newer turn waits');
      this.#next();
      return;
    }

    this.#play(item);
  }

  async #chime(): Promise<void> {
    this.#chiming = true;

    const run = this.#chimeRun;

    try {
      const playback = await this.deps.output.open(this.deps.device());

      if (run === this.#chimeRun) {
        this.#chimePlayback = playback;
        await playback.write(needsYouChime());
        await playback.drain();
      }

      playback.stop();
    } catch (error) {
      this.deps.log(`the needs-you sound did not play: ${(error as Error).message}`);
      this.deps.failed((error as Error).message);
    } finally {
      this.#chimePlayback = null;
      this.#chiming = false;
      this.#quietSince = this.deps.now();
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

          const start = (): void => {
            if (current.startedAt === null) {
              current.startedAt = this.deps.now();
              this.#report(item, 'playing', 0, 0);
              current.ticker = (this.deps.every ?? every)(() => this.#progress(current), PROGRESS_MS);
            }
          };

          // A playback that reports its own position, as a phone's, plays while a long write still waits on it, so it counts from the start.
          if (current.playback.position !== undefined) {
            start();
          }

          await current.playback.write(pcm);
          current.writtenMs += pcm.length / BYTES_PER_MS;
          start();
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
    // A phone reports what it played; elsewhere playback is timed from its first write.
    const reported = current.playback?.position?.();
    const playedMs = current.startedAt === null ? 0 : (reported ?? Math.min(this.deps.now() - current.startedAt, current.writtenMs));
    const totalMs = current.complete ? current.writtenMs : Math.max(current.writtenMs, current.item.text.length * MS_PER_CHAR);
    const said = totalMs <= 0 ? 0 : Math.min(current.item.text.length, Math.round((current.item.text.length * playedMs) / totalMs));

    return { atMs: Math.round(playedMs), said };
  }

  #progress(current: Current): void {
    if (current.ended || current.startedAt === null || current.item.line !== undefined) {
      return;
    }

    const { atMs, said } = this.#position(current);

    this.deps.report({ type: 'progress', gen: current.item.gen, replyId: current.item.replyId, sessionId: current.item.sessionId, chars: said, atMs });
  }

  /** Ends the current reply, stopping its speech and playback; reports `state` unless it is null, which a move's stop is. */
  #end(current: Current, state: SpeechState | null, atMs: number | null = null, said: number | null = null, why: string | null = null): void {
    const at = this.#position(current);

    this.#logEnd(current.item, state ?? 'stopped-moved', atMs ?? at.atMs, said ?? at.said, why);
    current.ended = true;
    current.ticker?.stop();
    current.speaking?.cancel();
    current.playback?.stop();

    if (this.#current === current) {
      this.#current = null;
      this.#quietSince = this.deps.now();
    }

    if (state !== null) {
      this.#report(current.item, state, atMs, said, why);
    }
  }

  /** A waiting reply dropped before it played. */
  #unplayed(item: SpeechItem, state: SpeechState, why: string): void {
    this.#logEnd(item, state, 0, 0, why);
    this.#report(item, state, null, null, why);
  }

  /** One line in the voice log for each reply whose speech ended, so the operator can see what was spoken, cut off, skipped or failed. */
  #logEnd(item: SpeechItem, state: SpeechState | 'stopped-moved', playedMs: number, said: number, why: string | null = null): void {
    const outcome = state === 'stopped-moved' ? 'stopped: voice moved' : why === null ? state : `${state} (${why})`;

    this.deps.log(`speech: ${item.line === undefined ? 'reply' : 'alert line'} ${item.replyId} of session ${item.sessionId} ${outcome}, voice ${item.as?.voice ?? 'default'}, ${playedMs} ms played, ${said} of ${item.text.length} characters`);
  }

  #report(item: SpeechItem, state: SpeechState, atMs: number | null, said: number | null, why: string | null = null): void {
    if (item.line !== undefined) {
      if (state !== 'playing') {
        item.line(state);
      }

      return;
    }

    this.deps.report({ type: 'speech', gen: item.gen, replyId: item.replyId, sessionId: item.sessionId, state, atMs, said, ...(why === null ? {} : { reason: why }) });
  }
}

function every(run: () => void, ms: number): { stop(): void } {
  const timer = setInterval(run, ms);

  return { stop: () => clearInterval(timer) };
}
