import { open } from 'node:fs/promises';
import { existsSync, readFileSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';

export const HUB_LOG_LINES = 500;
export const HUB_LOG_MAX_LINES = 20_000;
/** Bound both the work and the response, even for a file with no newlines. */
export const HUB_LOG_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A log tail: `file` names the file read (its inode and birth time), so a reader can tell a rotated or replaced file, and `size` its length
 * then, so it can tell a truncated one.
 */
export type LogTail = { text: string; more: boolean; limited: boolean; missing: boolean; file: string; size: number; withheld?: string; earlierWithheld?: boolean };

/** The logs the page can read, each a fixed file in the Switchboard home: the hub's, the voice process's and the terminal holder's. */
export const LOG_FILES = { hub: 'hub.log', voice: 'voice.log', holder: 'holder.log' } as const;
export type LogName = keyof typeof LOG_FILES;

/**
 * Written once voice.log was moved aside to voice.log.1 when a voice process of a build that keeps no spoken, heard or alert text in it started
 * (architecture.md § Hub log); until it exists the page is not given voice.log, whose older lines can hold that text.
 */
export const VOICE_LOG_MARKER = 'voice-log.json';
export const VOICE_LOG_WITHHELD = 'The voice log shows once the voice process restarts on this build, which keeps no spoken or heard words in it.';

/**
 * Names the hub.log file (its identity) and the byte in it where the first hub of a build that keeps no draft text, spoken words or Tailscale
 * login in hub.log started writing (architecture.md § Hub log); the page is not given that file's lines before it.
 */
export const HUB_LOG_MARKER = 'hub-log.json';
export const HUB_LOG_WITHHELD = `The Switchboard log cannot be shown: ${HUB_LOG_MARKER} in the Switchboard home, which marks where lines without draft or spoken text start, is missing or unreadable. Restarting the hub writes it again.`;
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;

/** Where a log's lines that may be shown start: byte `cleanFrom` of the file whose identity is `file`. */
export type CleanStart = { file: string; cleanFrom: number };

/** A file's identity, its inode and birth time, which a rotated or replaced file does not share. */
function fileIdentity(stat: Stats): string {
  return `${stat.ino}-${Math.round(stat.birthtimeMs)}`;
}

/** Writes the hub log's marker at a hub's start when it is missing, unreadable or in the earlier form that held a start time. */
export function markHubLog(home: string, logPath = join(home, LOG_FILES.hub)): void {
  if (cleanStart(home) !== null) {
    return;
  }

  let start: CleanStart;
  try {
    const stat = statSync(logPath);
    start = { file: fileIdentity(stat), cleanFrom: legacyStart(home, logPath) ?? stat.size };
  } catch (error) {
    // Any other failure leaves the marker unwritten, so the page gets none of hub.log's lines.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    // No hub.log yet: whatever file appears has a new identity and holds only this build's lines.
    start = { file: '', cleanFrom: 0 };
  }

  try {
    writeFileSync(join(home, HUB_LOG_MARKER), `${JSON.stringify(start)}\n`);
  } catch {
    // Without the marker, the page gets none of hub.log's lines.
  }
}

/**
 * For a marker of the earlier form, the byte after the last line stamped before its `cleanSince`, so the lines it showed stay shown while no
 * line after the cut is stamped before that time, which a clock moved back could cause; the end of the file when the last stamped line is. Any other marker that cannot be read gives null, and is written again from the end of the file,
 * which withholds more, never less.
 */
function legacyStart(home: string, logPath: string): number | null {
  let since: number;
  try {
    since = Date.parse((JSON.parse(readFileSync(join(home, HUB_LOG_MARKER), 'utf8')) as { cleanSince?: unknown }).cleanSince as string);
  } catch {
    return null;
  }
  if (Number.isNaN(since)) {
    return null;
  }

  const bytes = readFileSync(logPath);
  let cut: number | null = null;
  for (let at = 0; at < bytes.length; ) {
    const end = bytes.indexOf(10, at);
    const stamp = STAMP.exec(bytes.subarray(at, Math.min(at + 40, bytes.length)).toString('latin1'))?.[1];
    if (stamp !== undefined) {
      if (Date.parse(stamp) < since) cut = null;
      else cut ??= at;
    }
    if (end === -1) {
      break;
    }
    at = end + 1;
  }
  return cut ?? bytes.length;
}

function cleanStart(home: string): CleanStart | null {
  try {
    const { file, cleanFrom } = JSON.parse(readFileSync(join(home, HUB_LOG_MARKER), 'utf8')) as Partial<CleanStart>;
    return typeof file === 'string' && Number.isSafeInteger(cleanFrom) && cleanFrom! >= 0 ? { file, cleanFrom: cleanFrom! } : null;
  } catch {
    return null;
  }
}

/** Reads only the tail of one of the fixed logs; no caller-supplied path or writes. */
export async function readLog(home: string, name: LogName, lines: number): Promise<LogTail> {
  if (name === 'voice' && !existsSync(join(home, VOICE_LOG_MARKER))) {
    return { text: '', more: false, limited: false, missing: true, file: '', size: 0, withheld: VOICE_LOG_WITHHELD };
  }

  const start = name === 'hub' ? cleanStart(home) : null;

  // Without a valid marker, which lines older builds wrote is unknown, so none are given.
  if (name === 'hub' && start === null) {
    return { text: '', more: false, limited: false, missing: true, file: '', size: 0, withheld: HUB_LOG_WITHHELD };
  }

  return readTail(join(home, LOG_FILES[name]), lines, start ?? undefined);
}

/** Reads only the tail of this hub's log. */
export function readHubLog(home: string, lines: number): Promise<LogTail> {
  return readLog(home, 'hub', lines);
}

/**
 * The last `lines` complete lines of a file, read backwards within `HUB_LOG_MAX_BYTES`. With `start` naming this file, nothing before its
 * `cleanFrom` byte is read and the tail says earlier lines were withheld, so a file cut shorter than that gives no lines, since a cut keeps
 * the file's start; another file was created after the marker, so all of it is read.
 */
export async function readTail(path: string, lines: number, start?: CleanStart): Promise<LogTail> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', more: false, limited: false, missing: true, file: '', size: 0 };
    throw error;
  }

  try {
    const stat = await file.stat();
    const identity = fileIdentity(stat);
    const floor = start !== undefined && start.file === identity ? start.cleanFrom : 0;
    let position = stat.size;
    let bytes = 0;
    let newlines = 0;
    const chunks: Buffer[] = [];
    while (position > floor && bytes < HUB_LOG_MAX_BYTES && newlines <= lines) {
      const length = Math.min(64 * 1024, position - floor, HUB_LOG_MAX_BYTES - bytes);
      position -= length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      // The file shrank after stat. Do not walk its former size or retain empty buffers;
      // the next poll reads the new file from its current end.
      if (bytesRead < length) return { text: '', more: false, limited: false, missing: false, file: identity, size: 0, ...(floor > 0 ? { earlierWithheld: true } : {}) };
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      bytes += bytesRead;
      for (const byte of chunk) if (byte === 10) newlines++;
    }
    let text = Buffer.concat(chunks).toString('utf8');
    // A read starting inside a line (or a UTF-8 character) must not show a fabricated line.
    // `floor` is where a hub started writing, so a line starts there.
    const limited = position > floor && bytes >= HUB_LOG_MAX_BYTES && newlines <= lines;
    if (position > floor) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    const rows = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const more = position > floor || rows.length > lines;
    return { text: rows.slice(-lines).join(''), more, limited, missing: false, file: identity, size: stat.size, ...(floor > 0 ? { earlierWithheld: true } : {}) };
  } finally {
    await file.close();
  }
}
