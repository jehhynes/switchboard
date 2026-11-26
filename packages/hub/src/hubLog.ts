import { open } from 'node:fs/promises';
import { join } from 'node:path';

export const HUB_LOG_LINES = 500;
export const HUB_LOG_MAX_LINES = 20_000;
/** Bound both the work and the response, even for a file with no newlines. */
export const HUB_LOG_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A log tail: `file` names the file read (its inode and birth time), so a reader can tell a rotated or replaced file, and `size` its length
 * then, so it can tell a truncated one.
 */
export type LogTail = { text: string; more: boolean; limited: boolean; missing: boolean; file: string; size: number };

/** Reads only the tail of this hub's log; no caller-supplied path or writes. */
export async function readHubLog(home: string, lines: number): Promise<LogTail> {
  let file;
  try {
    file = await open(join(home, 'hub.log'), 'r');
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
