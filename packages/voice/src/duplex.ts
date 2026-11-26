import { novelWords } from './barge.js';
import { ECHO_FRAME_MS, MIN_ACTIVE_FRAMES } from './echoCheck.js';
import type { EchoMeasure } from './echoCheck.js';

/** Measurements in a row that hear no echo before capture with no echo cancellation listens while the voice plays. */
export const CLEARS_NEEDED = 2;
/** Words of the reply heard while it plays, enough to call it echo at once. */
export const ECHO_WORDS = 3;

/** What the playback device says it is: headphones or a headset, which hint at no echo, or anything else; null when unknown. */
export interface OutputHint {
  headphones: boolean;
  /** For the voice log, such as `form factor Headphones of "Headphones (WH-1000XM4)"`. */
  why: string;
}

/**
 * Whether capture with no echo cancellation may listen while the voice plays, under `voice.duplex` `auto` (architecture.md § Dictation):
 * half-duplex until echo checks hear none `CLEARS_NEEDED` times in a row (once when the playback device on this computer is headphones or a
 * headset), then full duplex until a check hears echo or the reply's words are heard while it plays. `reset` starts over, half-duplex, as
 * when the capture path or the devices change.
 */
export class AutoDuplex {
  #full = false;
  #clears = 0;
  #heard: 'none' | 'echo' | null = null;
  #hint: OutputHint | null = null;
  #remote = false;

  constructor(private readonly log: (line: string) => void) {}

  /** Whether capture listens while the voice plays. */
  get full(): boolean {
    return this.#full;
  }

  /** The echo check's state, for the mic's tooltip and the voice log. */
  get reason(): string {
    if (this.#full) {
      return 'echo check: no echo detected';
    }

    return this.#heard === 'echo' ? 'echo check: echo detected' : 'echo check: not measured yet';
  }

  /** The measurements of no echo still needed before full duplex. */
  get needed(): number {
    return this.#hint?.headphones === true && !this.#remote ? 1 : CLEARS_NEEDED;
  }

  /** Starts over, half-duplex until measured again; logs why when it was not already there. */
  reset(why: string): void {
    if (this.#full || this.#clears > 0 || this.#heard !== null) {
      this.log(`echo check starts over: ${why}`);
    }

    this.#full = false;
    this.#clears = 0;
    this.#heard = null;
  }

  /**
   * The playback device's hint and whether this is a Remote Desktop session, where the device is the client's "Remote Audio" and says nothing
   * of its headphones, so the hint is not used.
   */
  context(hint: OutputHint | null, remote: boolean): void {
    this.#hint = hint;
    this.#remote = remote;
  }

  /** The hint as the voice log names it. */
  get hintText(): string {
    if (this.#remote) {
      return 'hint: none over Remote Desktop, whose Remote Audio says nothing of headphones';
    }

    return this.#hint === null ? 'hint: none' : `hint: ${this.#hint.headphones ? 'headphones' : 'no headphones'} (${this.#hint.why})`;
  }

  /** A measurement of one stretch of playback; true when the mode or its reason changed. */
  measured(measure: EchoMeasure): boolean {
    const numbers = `r ${measure.r} at ${measure.lagMs} ms, level ${measure.levelDb} dBFS, range ${measure.rangeDb} dB, ${measure.activeSeconds} s played`;
    const was = this.#full;
    const reason = this.reason;

    if (measure.verdict === 'echo') {
      this.#clears = 0;
      this.#heard = 'echo';
      this.#full = false;
      this.log(`echo check: echo (${numbers}; ${this.hintText})${was ? ': half-duplex again' : ''}`);
    } else if (measure.verdict === 'none') {
      this.#clears++;
      this.#heard ??= 'none';

      if (!this.#full && this.#clears >= this.needed) {
        this.#full = true;
      }

      this.log(`echo check: none (${numbers}; ${this.hintText}; ${Math.min(this.#clears, this.needed)} of ${this.needed} in a row)`);
    } else if (measure.activeSeconds * 1000 >= MIN_ACTIVE_FRAMES * ECHO_FRAME_MS) {
      this.log(`echo check: unclear, sound that is not the reply's echo, such as talk (${numbers}); nothing changes`);
    }

    return this.reason !== reason;
  }

  /**
   * Words heard while a reply plays: `ECHO_WORDS` or more of them standing in the reply as heard (`novelWords`) are its echo, and capture is
   * half-duplex again at once. True when the mode changed.
   */
  heardWhilePlaying(words: string, replyText: string): boolean {
    const heard = words.split(/\s+/).filter(Boolean);
    const echo = heard.length - novelWords(heard, replyText).count;

    if (!this.#full || echo < ECHO_WORDS) {
      return false;
    }

    this.#full = false;
    this.#clears = 0;
    this.#heard = 'echo';
    this.log(`echo check: ${echo} of ${heard.length} words heard over the reply are its own (${words}): half-duplex again`);
    return true;
  }
}
