import type { ActiveReason, VoiceFocus, VoiceTarget } from './protocol.js';

/** The focus must rest this long on another scoped window before the voice follows it. */
export const FOCUS_DEBOUNCE_MS = 500;

export interface RouterDeps {
  /** The target changed: everything playing or waiting stops at once, before the report. */
  changed(gen: number, sessionId: string | null, reason: ActiveReason): void;
  /** The away timeout, `voice.awayMinutes`, read when it starts. */
  awayMs(): number;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}

/**
 * The voice target (voice-design § 2.3): one session per machine, with a generation that rises at each change. It follows the focused scoped
 * window's selected conversation after `FOCUS_DEBOUNCE_MS`, and focus moving to another session stops speech at once: the target is dropped
 * right away, so nothing plays until the new one is set. Talk here sets it at once. With the focus outside every scoped window the target stays
 * until the away timeout drops it. Only the hub's `targets` can be targets.
 */
export class Router {
  gen = 0;
  target: string | null = null;
  #targets = new Map<string, VoiceTarget>();
  #focus: VoiceFocus = null;
  #debounce: unknown = null;
  #away: unknown = null;

  constructor(private readonly deps: RouterDeps) {}

  /** The eligible targets and the focus, as the hub last sent them. */
  update(targets: VoiceTarget[], focus: VoiceFocus): void {
    const wasEligible = focus !== null && this.#targets.has(focus.sessionId);

    this.#targets = new Map(targets.map((target) => [target.sessionId, target]));

    if (this.target !== null && !this.#targets.has(this.target)) {
      this.#set(null, 'gone');
    }

    const moved = focus?.sessionId !== this.#focus?.sessionId;

    this.#focus = focus;

    if (focus === null) {
      this.#clear('debounce');

      if (this.target !== null) {
        this.#startAway();
      }

      return;
    }

    if (focus.sessionId === this.target) {
      this.#clear('debounce');
      this.#clear('away');
      return;
    }

    this.#clear('away');

    if (moved) {
      // The hard cut comes before the debounce.
      this.#set(null, 'focus');
      this.#clear('debounce');
    }

    // Only a move, or a focused session that just became a target, starts the debounce, so an unrelated change keeps Talk here's choice.
    if (this.#debounce === null && this.#targets.has(focus.sessionId) && (moved || !wasEligible)) {
      this.#debounce = this.#timer(() => {
        this.#debounce = null;

        if (this.#focus?.sessionId === focus.sessionId && this.#targets.has(focus.sessionId)) {
          this.#set(focus.sessionId, 'focus');
        }
      }, FOCUS_DEBOUNCE_MS);
    }
  }

  /** Talk here: the target moves to the session at once; false for a session that cannot be one. */
  talkHere(sessionId: string): boolean {
    if (!this.#targets.has(sessionId)) {
      return false;
    }

    this.#clear('debounce');
    this.#clear('away');
    this.#set(sessionId, 'talk-here');

    // Talk here with no scoped window focused still times out.
    if (this.#focus === null) {
      this.#startAway();
    }

    return true;
  }

  /** The operator spoke: an away timeout running counts again from now (voice-design § 11, decision 1). */
  spoke(): void {
    if (this.#away !== null) {
      this.#clear('away');
      this.#startAway();
    }
  }

  close(): void {
    this.#clear('debounce');
    this.#clear('away');
  }

  #startAway(): void {
    if (this.#away === null) {
      this.#away = this.#timer(() => {
        this.#away = null;
        this.#set(null, 'gone');
      }, this.deps.awayMs());
    }
  }

  #set(sessionId: string | null, reason: ActiveReason): void {
    if (sessionId === this.target) {
      return;
    }

    this.gen++;
    this.target = sessionId;
    this.deps.changed(this.gen, sessionId, reason);
  }

  #timer(run: () => void, ms: number): unknown {
    return this.deps.setTimer === undefined ? setTimeout(run, ms) : this.deps.setTimer(run, ms);
  }

  #clear(which: 'debounce' | 'away'): void {
    const timer = which === 'debounce' ? this.#debounce : this.#away;

    if (timer !== null) {
      if (this.deps.clearTimer === undefined) {
        clearTimeout(timer as NodeJS.Timeout);
      } else {
        this.deps.clearTimer(timer);
      }
    }

    if (which === 'debounce') {
      this.#debounce = null;
    } else {
      this.#away = null;
    }
  }
}
