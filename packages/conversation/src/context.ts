import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { claudeContext } from './contextMeter.js';
import type { ContextParts, ContextView } from './contextMeter.js';

/** How much of a transcript's end the first read looks through for the latest request's usage. */
export const CONTEXT_TAIL_BYTES = 4 * 1024 * 1024;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * What a transcript line says about the context (architecture.md § Context meter): the size of the request a main-chain assistant line answered,
 * its input with the cache read and written plus its output, as Claude Code's own panel counts it, and its model; for a compaction's boundary
 * line, the size after it, null when it gives none, and for an automatic one, `autoAt`, the size it compacted at; null for any other line. A
 * request also gives its tokens by kind and its effort where the line has one (undocumented); a boundary, when it was written and its trigger.
 */
export function contextOfLine(line: string): {
  used: number | null;
  model?: string | null;
  autoAt?: number;
  parts?: ContextParts;
  effort?: string | null;
  compacted?: { at: number; trigger: 'auto' | 'manual' | null };
} | null {
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

    const at = typeof raw['timestamp'] === 'string' ? Date.parse(raw['timestamp']) : NaN;
    const trigger = meta['trigger'] === 'auto' || meta['trigger'] === 'manual' ? meta['trigger'] : null;

    return {
      used: typeof after === 'number' && after > 0 ? after : null,
      ...(trigger === 'auto' && typeof before === 'number' && before > 0 ? { autoAt: before } : {}),
      ...(Number.isNaN(at) ? {} : { compacted: { at, trigger } }),
    };
  }

  const message = isObject(raw['message']) ? raw['message'] : null;
  const usage = message !== null && isObject(message['usage']) ? message['usage'] : null;

  if (raw['type'] !== 'assistant' || usage === null || message?.['model'] === '<synthetic>' || raw['isApiErrorMessage'] === true) {
    return null;
  }

  const parts = { cacheRead: count(usage['cache_read_input_tokens']), cacheWrite: count(usage['cache_creation_input_tokens']), input: count(usage['input_tokens']), output: count(usage['output_tokens']), reasoning: null };
  const used = parts.input + parts.cacheWrite + parts.cacheRead + parts.output;

  return used === 0 ? null : { used, model: typeof message!['model'] === 'string' ? message!['model'] : null, parts, effort: typeof raw['effort'] === 'string' ? raw['effort'] : null };
}

/**
 * The context meter's details from a Claude transcript (architecture.md § Context meter), read when the page asks for them: the latest
 * main-chain request's model, effort and tokens by kind, and the latest compaction, each from the last `CONTEXT_TAIL_BYTES` of the file only,
 * null when not there.
 */
export function transcriptDetails(path: string | null): { model: string | null; effort: string | null; parts: ContextParts | null; compacted: { at: number; trigger: 'auto' | 'manual' | null } | null } {
  const details = { model: null as string | null, effort: null as string | null, parts: null as ContextParts | null, compacted: null as { at: number; trigger: 'auto' | 'manual' | null } | null };

  if (path === null) {
    return details;
  }

  let text: string;

  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - CONTEXT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(path, 'r');

    try {
      readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }

    text = buffer.toString('utf8');
  } catch {
    return details;
  }

  // A read from inside the file starts mid-line; that line does not parse and is passed over.
  for (const line of text.split('\n')) {
    const found = contextOfLine(line);

    if (found?.parts !== undefined) {
      details.model = found.model ?? details.model;
      details.effort = found.effort ?? null;
      details.parts = found.parts;
    } else if (found?.compacted !== undefined) {
      details.compacted = found.compacted;
    }
  }

  return details;
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
