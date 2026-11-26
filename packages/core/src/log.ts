/**
 * Log levels (architecture.md § Hub log): error, something failed and needs the operator; warn, something degraded or was skipped but
 * Switchboard carried on; info, an event worth seeing; debug, timing and internals, hidden on the page by default.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

/** Writes one log line; info when no level is given. */
export type Log = (line: string, level?: LogLevel) => void;

/** `<ISO UTC> <level> <text>`, the level padded to five characters; text over several lines, such as a stack, keeps its later lines as they are. */
export function logLine(at: Date, level: LogLevel, text: string): string {
  return `${at.toISOString()} ${level.padEnd(5)} ${text}\n`;
}
