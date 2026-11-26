/**
 * Log levels (architecture.md § Hub log): error, something failed and needs the operator; warn, something degraded or was skipped but
 * Switchboard carried on; info, an event worth seeing; debug, timing and internals, hidden on the page by default.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

/** Writes one log line; info when no level is given. */
export type Log = (line: string, level?: LogLevel) => void;

/**
 * Repeated warnings (architecture.md § Hub log): the first is logged in full; repeats are counted, and at most one line an hour says how many
 * came since; `recovered` logs one info line once the warning stops.
 */
export class RepeatedLog {
  readonly #seen = new Map<string, { count: number; loggedAt: number }>();

  constructor(
    private readonly log: Log,
    private readonly now: () => number,
    private readonly everyMs = 60 * 60 * 1000,
  ) {}

  warn(key: string, line: string, level: LogLevel = 'warn'): void {
    const now = this.now();
    const seen = this.#seen.get(key);

    if (seen === undefined) {
      this.log(line, level);
      this.#seen.set(key, { count: 0, loggedAt: now });
      return;
    }

    seen.count += 1;

    if (now - seen.loggedAt >= this.everyMs) {
      this.log(`${line} (${seen.count} times since ${new Date(seen.loggedAt).toISOString().slice(11, 16)} UTC)`, level);
      seen.count = 0;
      seen.loggedAt = now;
    }
  }

  /** The warning under `key` stopped: logs `line` when it had been logged, and forgets it. */
  recovered(key: string, line: string): void {
    if (this.#seen.delete(key)) {
      this.log(line, 'info');
    }
  }
}

/** A duration for a log line: `0.9 s`. */
export function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/** An error's message without its `Error:` prefix, for a log line that says what failed in its own words. */
export function plainError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `<ISO UTC> <level> <text>`, the level padded to five characters; text over several lines, such as a stack, keeps its later lines as they are. */
export function logLine(at: Date, level: LogLevel, text: string): string {
  return `${at.toISOString()} ${level.padEnd(5)} ${text}\n`;
}
