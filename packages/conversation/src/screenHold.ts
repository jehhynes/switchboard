/**
 * The transcript's copy of a reply is the one to publish: it has the raw Markdown and is never a screen caught mid-redraw. The screen shows a reply
 * first, so a reply read off it is held for up to `TRANSCRIPT_WAIT_MS` for its transcript copy, which is then published alone. One that does not
 * come in time has its screen copy published, and the transcript copy replaces it later. From claude-collab's `screen-hold.js`: on 691 replies,
 * the transcript copy came a median 0.16 s after the screen's, 90% within 0.61 s and 5% over 9 s.
 */
export const TRANSCRIPT_WAIT_MS = 300;

/** Where a published copy came from. */
export type Via = 'screen' | 'transcript';

/**
 * Publishes a copy and returns its reply's ID: `replaces` names the reply a later copy of the same reply updates in place; `at` is when it was
 * written, epoch milliseconds.
 */
export type Publish = (text: string, at: number, aside: boolean, via: Via, replaces: string | undefined) => string;

export interface HoldOptions {
  wait?: number;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * Stands between the screen reader and the published replies: `screen` is the reader's push, and returns a handle in place of a reply ID, which
 * the reader keeps as the copy's ID.
 */
export class ScreenHold {
  /** A screen copy not yet published. */
  readonly #held = new Map<number, { text: string; aside: boolean; at: number; timer: unknown }>();
  /** A screen copy published as a reply. */
  readonly #replies = new Map<number, string>();
  #seq = 0;
  readonly #wait: number;
  readonly #now: () => number;
  readonly #setTimer: (run: () => void, ms: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;

  constructor(
    private readonly publish: Publish,
    options: HoldOptions = {},
  ) {
    this.#wait = options.wait ?? TRANSCRIPT_WAIT_MS;
    this.#now = options.now ?? Date.now;
    this.#setTimer =
      options.setTimer ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);

        timer.unref?.();

        return timer;
      });
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  /** A screen copy read; `replaces` is the handle of the copy it grew from. */
  screen(text: string, aside: boolean, replaces: number | undefined): number {
    const held = replaces === undefined ? undefined : this.#held.get(replaces);

    // Grown while held: still one copy, published or not when its time is up.
    if (held !== undefined) {
      held.text = text;
      held.aside = aside;

      return replaces!;
    }

    const handle = ++this.#seq;
    const was = replaces === undefined ? undefined : this.#replies.get(replaces);

    if (was !== undefined) {
      this.#replies.delete(replaces!);
      this.#replies.set(handle, this.publish(text, this.#now(), aside, 'screen', was));

      return handle;
    }

    this.#held.set(handle, { text, aside, at: this.#now(), timer: this.#setTimer(() => this.#release(handle), this.#wait) });

    return handle;
  }

  /** A screen copy published before, by an earlier hub process; returns its new handle. */
  adopt(replyId: string): number {
    const handle = ++this.#seq;

    this.#replies.set(handle, replyId);

    return handle;
  }

  /** No transcript copy in time: the screen copy is published. */
  #release(handle: number): void {
    const held = this.#held.get(handle);

    if (held === undefined) {
      return;
    }

    this.#held.delete(handle);
    this.#replies.set(handle, this.publish(held.text, held.at, held.aside, 'screen', undefined));
  }

  /** The transcript copy of a screen copy: published alone while that is held, or else in place of its reply. Returns the reply's ID. */
  transcript(handle: number | undefined, text: string, at: number, aside: boolean): string {
    const held = handle === undefined ? undefined : this.#held.get(handle);

    if (held !== undefined) {
      this.#clearTimer(held.timer);
      this.#held.delete(handle!);

      return this.publish(text, at, aside, 'transcript', undefined);
    }

    const reply = handle === undefined ? undefined : this.#replies.get(handle);

    this.#replies.delete(handle!);

    return this.publish(text, at, aside, 'transcript', reply);
  }

  /** A screen copy that was not a reply after all: the ID of its reply to withdraw, or null when it was never published. */
  withdraw(handle: number): string | null {
    const held = this.#held.get(handle);

    if (held !== undefined) {
      this.#clearTimer(held.timer);
      this.#held.delete(handle);

      return null;
    }

    const reply = this.#replies.get(handle);

    this.#replies.delete(handle);

    return reply ?? null;
  }
}
