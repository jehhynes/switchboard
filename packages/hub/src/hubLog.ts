import { open } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
 * Names the time the first hub of a build that keeps no draft text, spoken words or Tailscale login in hub.log started (architecture.md § Hub
 * log); the page is not given hub.log's lines from before it.
 */
export const HUB_LOG_MARKER = 'hub-log.json';
export const HUB_LOG_WITHHELD = `The Switchboard log cannot be shown: ${HUB_LOG_MARKER} in the Switchboard home, which marks where lines without draft or spoken text start, is missing or unreadable. Restarting the hub writes it again.`;
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;

/** Writes the hub log's marker when it is missing or unreadable, at a hub's start. */
export function markHubLog(home: string, at: Date): void {
  const path = join(home, HUB_LOG_MARKER);

  // A marker that cannot be read is written again: its time is now, so it withholds more, never less.
  if (cleanSince(home) === null) {
    try {
      writeFileSync(path, `${JSON.stringify({ cleanSince: at.toISOString() })}\n`);
    } catch {
      // Without the marker, the page gets none of hub.log's lines.
    }
  }
}

function cleanSince(home: string): number | null {
  try {
    const since = Date.parse((JSON.parse(readFileSync(join(home, HUB_LOG_MARKER), 'utf8')) as { cleanSince?: string }).cleanSince ?? '');
    return Number.isNaN(since) ? null : since;
  } catch {
    return null;
  }
}

/** Reads only the tail of one of the fixed logs; no caller-supplied path or writes. */
export async function readLog(home: string, name: LogName, lines: number): Promise<LogTail> {
  if (name === 'voice' && !existsSync(join(home, VOICE_LOG_MARKER))) {
    return { text: '', more: false, limited: false, missing: true, file: '', size: 0, withheld: VOICE_LOG_WITHHELD };
  }

  const since = name === 'hub' ? cleanSince(home) : null;

  // Without a valid marker, which lines older builds wrote is unknown, so none are given.
  if (name === 'hub' && since === null) {
    return { text: '', more: false, limited: false, missing: true, file: '', size: 0, withheld: HUB_LOG_WITHHELD };
  }

  const tail = await readTail(join(home, LOG_FILES[name]), lines);

  if (since === null || tail.text === '') {
    return tail;
  }

  // The log is in time order, so the lines older builds wrote are at its start.
  const rows = tail.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const first = rows.findIndex((row) => {
    const at = STAMP.exec(row)?.[1];
    return at !== undefined && Date.parse(at) >= since;
  });

  return first === 0 ? tail : { ...tail, text: first === -1 ? '' : rows.slice(first).join(''), more: false, earlierWithheld: true };
}

/** Reads only the tail of this hub's log. */
export function readHubLog(home: string, lines: number): Promise<LogTail> {
  return readLog(home, 'hub', lines);
}

/** The last `lines` complete lines of a file, read backwards within `HUB_LOG_MAX_BYTES`. */
export async function readTail(path: string, lines: number): Promise<LogTail> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', more: false, limited: false, missing: true, file: '', size: 0 };
    throw error;
  }

  try {
    const stat = await file.stat();
    const identity = `${stat.ino}-${Math.round(stat.birthtimeMs)}`;
    let position = stat.size;
    let bytes = 0;
    let newlines = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && bytes < HUB_LOG_MAX_BYTES && newlines <= lines) {
      const length = Math.min(64 * 1024, position, HUB_LOG_MAX_BYTES - bytes);
      position -= length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      // The file shrank after stat. Do not walk its former size or retain empty buffers;
      // the next poll reads the new file from its current end.
      if (bytesRead < length) return { text: '', more: false, limited: false, missing: false, file: identity, size: 0 };
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      bytes += bytesRead;
      for (const byte of chunk) if (byte === 10) newlines++;
    }
    let text = Buffer.concat(chunks).toString('utf8');
    // A read starting inside a line (or a UTF-8 character) must not show a fabricated line.
    const limited = position > 0 && bytes >= HUB_LOG_MAX_BYTES && newlines <= lines;
    if (position > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    const rows = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const more = position > 0 || rows.length > lines;
    return { text: rows.slice(-lines).join(''), more, limited, missing: false, file: identity, size: stat.size };
  } finally {
    await file.close();
  }
}
