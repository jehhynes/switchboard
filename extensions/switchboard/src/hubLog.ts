import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** How much of the log's end a new reader shows first. */
export const LOG_TAIL_BYTES = 64 * 1024;

/**
 * Follows a log file that grows by appends: the first read gives its last `tailBytes` from a line start, each later read the
 * whole lines added since. A file smaller than at the last read, such as one deleted and started again, is read again from its start.
 */
export class LogTail {
  /** Where the next read starts, after the last whole line written; null before the first tail. */
  #offset: number | null = null;
  /** The file's size at the last read. */
  #size = 0;

  constructor(
    private readonly path: string,
    private readonly write: (text: string) => void,
    private readonly tailBytes = LOG_TAIL_BYTES,
  ) {}

  /** Writes the whole lines added since the last read; a missing file writes nothing. */
  read(): void {
    let size: number;

    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }

    if (this.#offset !== null && size < this.#size) {
      this.write('--- hub.log was replaced; reading it from the start ---\n');
      this.#offset = 0;
    }

    this.#size = size;

    const tail = this.#offset === null;
    // A tail reads one byte before its start, so it can tell whether the start is a line start.
    const start = this.#offset ?? Math.max(0, size - this.tailBytes - 1);

    if (size === start) {
      this.#offset = start;
      return;
    }

    let buffer = Buffer.alloc(size - start);

    // The file can be deleted or cut between the size check and the read.
    try {
      const fd = openSync(this.path, 'r');

      try {
        buffer = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, start));
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }

    let first = 0;

    // A tail that starts inside a line drops that line's end; one with no line start yet waits for more.
    if (tail && start > 0) {
      first = buffer.indexOf(0x0a) + 1;

      if (first === 0) {
        return;
      }
    }

    // Only whole lines are written, so a line still being written and a split UTF-8 character wait for the next read.
    const end = buffer.lastIndexOf(0x0a) + 1;

    if (end > first) {
      this.write(buffer.subarray(first, end).toString('utf8'));
    }

    this.#offset = start + end;
  }
}
