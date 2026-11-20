import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { LimitReading } from '@switchboard/core';

/** How much of a transcript's end is read for the current turn's limit lines (mechanics M100). */
const TAIL_BYTES = 512 * 1024;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The offset of `zone` from UTC at `at`, in milliseconds, or null for a zone this runtime does not know. */
function zoneOffset(at: number, zone: string): number | null {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
        .formatToParts(new Date(at))
        .map((part) => [part.type, Number(part.value)]),
    );

    return Date.UTC(parts['year']!, parts['month']! - 1, parts['day']!, parts['hour']!, parts['minute']!, parts['second']!) - Math.floor(at / 1000) * 1000;
  } catch {
    return null;
  }
}

/** The date of `at` in a zone `offset` from UTC. */
function wallClock(at: number, offset: number): { year: number; month: number; day: number } {
  const local = new Date(at + offset);

  return { year: local.getUTCFullYear(), month: local.getUTCMonth(), day: local.getUTCDate() };
}

/** The epoch time of a wall-clock time in `zone`. */
function fromWallClock(year: number, month: number, day: number, hour: number, minute: number, zone: string): number | null {
  const guess = Date.UTC(year, month, day, hour, minute);
  const first = zoneOffset(guess, zone);

  if (first === null) {
    return null;
  }

  const second = zoneOffset(guess - first, zone) ?? first;

  return guess - second;
}

/**
 * The reset time in Claude Code's limit text, such as `resets 1:20pm (America/New_York)` or `resets Nov 24, 4am (America/New_York)`, as epoch
 * milliseconds: the next such time after `now` less a minute, since the text has no date when the reset is today (mechanics M100). Null without one.
 */
export function resetFromText(text: string, now: number): number | null {
  const match = /resets (?:([A-Z][a-z]{2}) (\d{1,2}), )?(\d{1,2})(?::(\d{2}))?\s?(am|pm) \(([^)]+)\)/i.exec(text);

  if (match !== null) {
    const [, monthName, dayText, hourText, minuteText, half, zone] = match;
    const hour = (Number(hourText) % 12) + (half!.toLowerCase() === 'pm' ? 12 : 0);
    const minute = Number(minuteText ?? 0);
    const offset = zoneOffset(now, zone!);

    if (offset === null) {
      return null;
    }

    const today = wallClock(now, offset);

    if (monthName !== undefined) {
      const month = MONTHS.indexOf(monthName.toLowerCase());

      if (month < 0) {
        return null;
      }

      const at = fromWallClock(today.year, month, Number(dayText), hour, minute, zone!);

      return at === null ? null : at < now - 86_400_000 ? fromWallClock(today.year + 1, month, Number(dayText), hour, minute, zone!) : at;
    }

    const at = fromWallClock(today.year, today.month, today.day, hour, minute, zone!);

    return at === null ? null : at < now - 60_000 ? fromWallClock(today.year, today.month, today.day + 1, hour, minute, zone!) : at;
  }

  const after = /reset after (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(text);

  if (after !== null && (after[1] ?? after[2] ?? after[3]) !== undefined) {
    return now + ((Number(after[1] ?? 0) * 60 + Number(after[2] ?? 0)) * 60 + Number(after[3] ?? 0)) * 1000;
  }

  return null;
}

/** The time in the CLI's own wait line, `continuing automatically at 2:19pm`, in this machine's zone, which the CLI writes it in. */
function waitTime(text: string, now: number): number | null {
  const match = /continuing automatically at (\d{1,2})(?::(\d{2}))?\s?(am|pm)/i.exec(text);

  if (match === null) {
    return null;
  }

  const date = new Date(now);

  date.setHours((Number(match[1]) % 12) + (match[3]!.toLowerCase() === 'pm' ? 12 : 0), Number(match[2] ?? 0), 0, 0);

  return date.getTime() < now - 60_000 ? date.getTime() + 86_400_000 : date.getTime();
}

type Line = Record<string, unknown>;

function record(value: unknown): Line {
  return typeof value === 'object' && value !== null ? (value as Line) : {};
}

/** When the line was written, which a time in its text is relative to, else `now`. */
function writtenAt(line: Line, now: number): number {
  const at = typeof line['timestamp'] === 'string' ? Date.parse(line['timestamp']) : NaN;

  return Number.isNaN(at) ? now : at;
}

function textOf(line: Line): string {
  const content = record(line['message'])['content'] ?? line['content'];

  if (typeof content === 'string') {
    return content;
  }

  return Array.isArray(content) ? content.map((part) => (typeof record(part)['text'] === 'string' ? (record(part)['text'] as string) : '')).join(' ') : '';
}

/** A line that starts a turn: a prompt, a task notification or Claude Code's own continue, not a tool result or a note. */
function startsTurn(line: Line): boolean {
  if (line['type'] !== 'user' || line['isSidechain'] === true) {
    return false;
  }

  const content = record(line['message'])['content'];

  if (Array.isArray(content) && content.some((part) => record(part)['type'] === 'tool_result')) {
    return false;
  }

  const origin = record(line['origin'])['kind'];

  return typeof origin === 'string' ? origin !== 'system' : line['isMeta'] !== true;
}

/** The limit a usage-limit or throttle line names, from its fields, else its text (mechanics M100). */
function limitLine(line: Line, now: number): LimitReading | null {
  if (line['isApiErrorMessage'] !== true || line['error'] !== 'rate_limit' || line['isSidechain'] === true) {
    return null;
  }

  const text = textOf(line);
  const info = record(record(line['apiErrorParams'])['rate_limit_info']);
  const quota = record(line['quotaLimits']);
  const seconds = typeof info['resetsAt'] === 'number' ? info['resetsAt'] : typeof quota['resetsAt'] === 'number' ? quota['resetsAt'] : null;
  const usage = line['apiError'] === 'usage_limit_reached' || /hit your .*limit/i.test(text);
  const window = typeof info['rateLimitType'] === 'string' ? info['rateLimitType'] : typeof quota['rateLimitType'] === 'string' ? quota['rateLimitType'] : null;
  const fromText = seconds === null ? resetFromText(text, writtenAt(line, now)) : null;

  return { kind: usage ? 'usage' : 'throttle', window, resetsAt: seconds === null ? fromText : seconds * 1000, exact: seconds !== null, cli: false, message: text.slice(0, 500) || null };
}

/**
 * The limit the transcript's current turn ended at, or null (mechanics M100): a refused request's line, or the grace allowance's note before a turn
 * that ended normally, with `cli` when Claude Code then wrote its own wait. A continue Claude Code already sent starts a new turn.
 */
export function limitFromTranscript(lines: Line[], now: number): LimitReading | null {
  let start = lines.length - 1;

  while (start >= 0 && !startsTurn(lines[start]!)) {
    start--;
  }

  let reading: LimitReading | null = null;
  let waitAt: number | null = null;
  let cli = false;

  for (const line of lines.slice(start + 1)) {
    const found = limitLine(line, now);

    if (found !== null) {
      reading = found;
    } else if (line['type'] === 'user' && typeof line['usageLimitNote'] === 'string' && reading === null) {
      reading = { kind: 'usage', window: null, resetsAt: null, exact: false, cli: false, message: null };
    } else if (line['type'] === 'system' && line['subtype'] === 'informational') {
      const text = textOf(line);

      if (/^Usage limit reached/i.test(text) && /continuing automatically/i.test(text)) {
        cli = true;
        waitAt = waitTime(text, writtenAt(line, now));
      } else if (/^Usage limit reset/i.test(text)) {
        cli = false;
      }
    }
  }

  if (reading === null) {
    return null;
  }

  return { ...reading, cli, ...(reading.resetsAt === null && waitAt !== null ? { resetsAt: waitAt, exact: false } : {}) };
}

/** Reads the end of the transcript at `path` and its current turn's limit, or null when there is none or the file cannot be read. */
export function readTranscriptLimit(path: string, now: number): LimitReading | null {
  let fd: number | null = null;

  try {
    fd = openSync(path, 'r');

    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);

    readSync(fd, buffer, 0, length, size - length);

    const text = buffer.toString('utf8');
    const lines = (length < size ? text.slice(text.indexOf('\n') + 1) : text).split('\n').flatMap((line) => {
      try {
        return line.trim() === '' ? [] : [record(JSON.parse(line))];
      } catch {
        return [];
      }
    });

    return limitFromTranscript(lines, now);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}
