import type { LimitReading, Session, SessionLimit } from './model.js';
import type { Provider } from './settings.js';

// Imports only types, so the dock view and the browser can bundle it.

/** After a reset Claude Code continues by itself 47 to 93 s later (mechanics M100); the hub continues only a session that has not by then. */
export const CLI_MARGIN_MS = 180_000;
/** The hub continues a session Claude Code does not wait on this long after the reset. */
export const RESET_MARGIN_MS = 60_000;
/** A reset time read from text is cut to the minute, so it can be up to a minute early. */
export const TEXT_MARGIN_MS = 60_000;
/** The waits between attempts when no reset time is known, and after an attempt that did not start a turn. */
export const BACKOFF_MS = [5, 10, 20, 40, 60].map((minutes) => minutes * 60_000);
/** The hub gives up after this many attempts without a new turn. */
export const MAX_ATTEMPTS = 6;
/** Or this long after the first attempt was due. */
export const GIVE_UP_MS = 26 * 3_600_000;

/** The text the hub types to continue a session, Claude Code's own (mechanics M100). */
export const CONTINUE_TEXT = 'Your usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.';

/** The wait after `attempts` attempts with no reset time to wait for. */
export function backoff(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!;
}

/** When the first attempt is due for this reading, found at `now`. */
export function firstAttemptAt(reading: LimitReading, now: number): number {
  if (reading.resetsAt === null) {
    return now + backoff(0);
  }

  return Math.max(now, reading.resetsAt + (reading.cli ? CLI_MARGIN_MS : RESET_MARGIN_MS) + (reading.exact ? 0 : TEXT_MARGIN_MS));
}

/**
 * The limit to keep for a reading: a new reading of the same launch keeps the attempts and the first time, and moves the next attempt to the new
 * reset, so a limit hit again after an attempt counts that attempt.
 */
export function limitFor(reading: LimitReading, earlier: SessionLimit | null | undefined, launchId: string | null, now: number): SessionLimit {
  const same = earlier != null && earlier.launchId === launchId;

  return { ...reading, since: same ? earlier.since : now, at: now, launchId, attempts: same ? earlier.attempts : 0, nextAt: firstAttemptAt(reading, now) };
}

/**
 * A session waits on its limit while its turn has ended at it. The limit stays stored through the turn a resume starts, so a limit hit again counts
 * the attempts, and goes when a turn ends without one.
 */
export function waitsOnLimit(session: Pick<Session, 'state' | 'rateLimit'> | null | undefined): boolean {
  return session != null && session.rateLimit != null && (session.state === 'failed' || session.state === 'idle');
}

/** When a limit stops holding the session: its reset, else its next attempt. */
export function limitUntil(limit: Pick<SessionLimit, 'resetsAt' | 'nextAt'>): number {
  return limit.resetsAt ?? limit.nextAt;
}

/** Whether the hub should stop trying: the last attempt's wait passed with no new turn, or the first attempt was due too long ago. */
export function givesUp(limit: SessionLimit, now: number): boolean {
  return (limit.attempts >= MAX_ATTEMPTS && now >= limit.nextAt) || now - firstAttemptAt(limit, limit.since) > GIVE_UP_MS;
}

/** The latest time a live session of the provider stopped at a usage limit holds new starts until, or null when none does (PRD R38). */
export function providerLimitUntil(sessions: Array<Pick<Session, 'provider' | 'state' | 'rateLimit'>>, provider: Provider, now: number): number | null {
  let until: number | null = null;

  for (const session of sessions) {
    const limit = session.rateLimit;

    if (session.provider === provider && waitsOnLimit(session) && limit != null && limit.kind === 'usage' && limit.resetsAt !== null && limit.resetsAt > now) {
      until = Math.max(until ?? 0, limit.resetsAt);
    }
  }

  return until;
}
