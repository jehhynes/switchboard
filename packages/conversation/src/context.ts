import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { claudeContext } from './contextMeter.js';
import type { ContextView } from './contextMeter.js';

/** How much of a transcript's end the first read looks through for the latest request's usage. */
export const CONTEXT_TAIL_BYTES = 4 * 1024 * 1024;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * What a transcript line says about the context (architecture.md § Context meter): the size of the request a main-chain assistant line answered,
 * its input with the cache read and written plus its output, as Claude Code's own panel counts it, and its model; for a compaction's boundary
 * line, the size after it, null when it gives none, and for an automatic one, `autoAt`, the size it compacted at; null for any other line.
 */
export function contextOfLine(line: string): { used: number | null; model?: string | null; autoAt?: number } | null {
  if (!line.includes('"usage"') && !line.includes('compact_boundary')) {
    return null;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isObject(raw) || raw['isSidechain'] === true) {
    return null;
  }

  if (raw['type'] === 'system' && raw['subtype'] === 'compact_boundary') {
    const meta = isObject(raw['compactMetadata']) ? raw['compactMetadata'] : {};
    const after = meta['postTokens'];
    const before = meta['preTokens'];

    return { used: typeof after === 'number' && after > 0 ? after : null, ...(meta['trigger'] === 'auto' && typeof before === 'number' && before > 0 ? { autoAt: before } : {}) };
  }

  const message = isObject(raw['message']) ? raw['message'] : null;
  const usage = message !== null && isObject(message['usage']) ? message['usage'] : null;

  if (raw['type'] !== 'assistant' || usage === null || message?.['model'] === '<synthetic>' || raw['isApiErrorMessage'] === true) {
    return null;
  }

  const used = count(usage['input_tokens']) + count(usage['cache_creation_input_tokens']) + count(usage['cache_read_input_tokens']) + count(usage['output_tokens']);

  return used === 0 ? null : { used, model: typeof message!['model'] === 'string' ? message!['model'] : null };
}

/**
 * A Claude session's context size, read from its transcript (architecture.md § Context meter): the latest main-chain request's size, the first
 * time from the last `CONTEXT_TAIL_BYTES` of the file and then from what was appended, so a hub restart reads it again without a turn, and the
 * size its latest automatic compaction happened at, the session's own threshold. A new transcript file, after `/clear` or a resume, starts
 * unknown.
 */
export class TranscriptContext {
  #path: string | null = null;
  #offset = 0;
  #used: number | null = null;
  #model: string | null = null;
  #autoAt: number | null = null;

  read(path: string | null): ContextView | null {
    if (path !== this.#path) {
      this.#path = path;
      this.#offset = -1;
      this.#used = null;
      this.#model = null;
      this.#autoAt = null;
    }

    if (path === null) {
      return null;
    }

    let size: number;

    try {
      size = statSync(path).size;
    } catch {
      return this.#view();
    }

    // The file was replaced by a shorter one, or is read for the first time: from its end.
    if (this.#offset < 0 || size < this.#offset) {
      this.#offset = Math.max(0, size - CONTEXT_TAIL_BYTES);
      this.#used = null;
    }

    if (size > this.#offset) {
      const buffer = Buffer.alloc(size - this.#offset);
      const fd = openSync(path, 'r');

      try {
        readSync(fd, buffer, 0, buffer.length, this.#offset);
      } finally {
        closeSync(fd);
      }

      const end = buffer.lastIndexOf(10);

      if (end !== -1) {
        // A first read from inside the file starts mid-line; that line does not parse and is passed over.
        for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
          const found = contextOfLine(line);

          if (found !== null) {
            this.#used = found.used;
            this.#model = found.model ?? this.#model;
            this.#autoAt = found.autoAt ?? this.#autoAt;
          }
        }

        this.#offset += end + 1;
      }
    }

    return this.#view();
  }

  #view(): ContextView | null {
    return this.#used === null ? null : claudeContext(this.#used, this.#model, this.#autoAt);
  }
}
