// The name each CLI gives a session (architecture.md § Web page, Earlier sessions), read from the files the CLI keeps and cached by file size, so
// only what was appended since is read and a rename shows on the page's next poll.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findTranscript } from '@switchboard/claude';
import type { Session } from '@switchboard/core';

/** How long a Claude session whose transcript was not found waits before it is looked for again. */
export const TRANSCRIPT_RETRY_MS = 10_000;
/** The most read from a file at once. */
const CHUNK = 1 << 20;
/** How much of a file's start is kept to tell a replaced file from a grown one. */
const HEAD = 1024;

/** A file read up to `offset`, the end of its last whole line, and what was read from it. */
interface Tail {
  path: string;
  offset: number;
  size: number;
  mtimeMs: number;
  /** The file's inode and its first bytes (up to `HEAD`) as last read, which tell a replaced file from a grown one. */
  ino?: string;
  head?: Buffer;
}

/** A Claude transcript's names so far: the latest `custom-title` (from /rename or a launch's --name) and the latest `ai-title`. */
interface ClaudeTail extends Tail {
  manual: string | null;
  auto: string | null;
}

/** Codex's `session_index.jsonl`: one line per name it gives a thread, the latest a thread's name. */
interface CodexIndex extends Tail {
  names: Map<string, string>;
}

export interface SessionTitlesDeps {
  /** Claude's `projects` folder. */
  projectsDir: string;
  /** Codex's home, `CODEX_HOME` or `~/.codex`; without it no Codex session has a name. */
  codexHome?: string;
  now(): number;
}

/**
 * Each session's name as its CLI shows it: for Claude Code its transcript's latest `custom-title`, else its latest `ai-title`; for Codex the
 * thread's latest `thread_name` in `session_index.jsonl`; null while the CLI has named it nothing. `version` rises whenever a name changes.
 */
export class SessionTitles {
  #claude = new Map<string, ClaudeTail | { missingAt: number }>();
  #codex: CodexIndex | null = null;
  #shown = new Map<string, string | null>();
  version = 0;

  constructor(private readonly deps: SessionTitlesDeps) {}

  title(session: Pick<Session, 'id' | 'provider' | 'nativeSessionId' | 'retiredIds' | 'cwd'>): string | null {
    const title = session.provider === 'codex' ? this.#codexTitle(session.nativeSessionId) : this.#claudeTitle(session);

    if (this.#shown.has(session.id) && this.#shown.get(session.id) !== title) {
      this.version++;
    }

    this.#shown.set(session.id, title);
    return title;
  }

  /** The newest transcript of the session that has a name: its own, else one it was resumed or forked from. */
  #claudeTitle(session: Pick<Session, 'nativeSessionId' | 'retiredIds' | 'cwd'>): string | null {
    const ids = [...(session.nativeSessionId === null ? [] : [session.nativeSessionId]), ...[...session.retiredIds].reverse()];

    for (const id of ids) {
      const tail = this.#claudeTail(id, session.cwd);
      const title = tail === null ? null : (tail.manual ?? tail.auto);

      if (title !== null) {
        return title;
      }
    }

    return null;
  }

  #claudeTail(nativeId: string, cwd: string): ClaudeTail | null {
    let tail = this.#claude.get(nativeId);

    if (tail === undefined || ('missingAt' in tail && this.deps.now() - tail.missingAt >= TRANSCRIPT_RETRY_MS)) {
      const found = findTranscript(this.deps.projectsDir, cwd, nativeId);

      tail = found === null ? { missingAt: this.deps.now() } : { path: found.path, offset: 0, size: -1, mtimeMs: -1, manual: null, auto: null };
      this.#claude.set(nativeId, tail);
    }

    if ('missingAt' in tail) {
      return null;
    }

    const claude = tail;

    readTail(claude, () => { claude.manual = null; claude.auto = null; }, (line) => {
      if (!line.includes('-title"')) return;
      const entry = parse(line);
      const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

      if (entry?.['type'] === 'custom-title') claude.manual = text(entry['customTitle']) ?? claude.manual;
      else if (entry?.['type'] === 'ai-title') claude.auto = text(entry['aiTitle']) ?? claude.auto;
    });

    return claude;
  }

  #codexTitle(threadId: string | null): string | null {
    if (threadId === null || this.deps.codexHome === undefined) {
      return null;
    }

    const index = (this.#codex ??= { path: join(this.deps.codexHome, 'session_index.jsonl'), offset: 0, size: -1, mtimeMs: -1, names: new Map() });

    readTail(index, () => index.names.clear(), (line) => {
      const entry = parse(line);

      if (typeof entry?.['id'] === 'string' && typeof entry['thread_name'] === 'string' && entry['thread_name'].trim() !== '') {
        index.names.set(entry['id'], entry['thread_name'].trim());
      }
    });

    return index.names.get(threadId) ?? null;
  }
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);

    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Hands `line` each whole line appended to the file since it was last read, or every line from the start after `reset` when it is not the
 * file last read grown: another inode, the same size with a new time, or other first bytes. A file that is gone or unchanged reads nothing.
 */
function readTail(tail: Tail, reset: () => void, line: (text: string) => void): void {
  let stat;

  try {
    // NTFS file IDs pass 2^53, so a number can round two files' IDs to one; the inode is compared as read in full.
    const read = statSync(tail.path, { bigint: true });

    stat = { size: Number(read.size), mtimeMs: Number(read.mtimeNs) / 1e6, ino: String(read.ino) };
  } catch {
    return;
  }

  if (stat.size === tail.size && stat.mtimeMs === tail.mtimeMs && (tail.ino === undefined || stat.ino === tail.ino)) {
    return;
  }

  let handle;

  try {
    handle = openSync(tail.path, 'r');
  } catch {
    return;
  }

  try {
    const start = Buffer.alloc(Math.min(HEAD, stat.size));
    const head = start.subarray(0, readSync(handle, start, 0, start.length, 0));
    const kept = tail.head ?? Buffer.alloc(0);
    const replaced = (tail.ino !== undefined && tail.ino !== stat.ino) || stat.size < tail.offset || (stat.size === tail.size && stat.mtimeMs !== tail.mtimeMs) || !head.subarray(0, kept.length).equals(kept);

    if (replaced) {
      tail.offset = 0;
      reset();
    }

    tail.size = stat.size;
    tail.mtimeMs = stat.mtimeMs;
    tail.ino = stat.ino;
    tail.head = head;
    let rest = Buffer.alloc(0);

    while (tail.offset + rest.length < stat.size) {
      const buffer = Buffer.alloc(Math.min(CHUNK, stat.size - tail.offset - rest.length));
      const count = readSync(handle, buffer, 0, buffer.length, tail.offset + rest.length);

      if (count === 0) break;
      const data = Buffer.concat([rest, buffer.subarray(0, count)]);
      const end = data.lastIndexOf(10);

      if (end < 0) {
        rest = data;
        continue;
      }

      for (const text of data.toString('utf8', 0, end).split('\n')) line(text);
      tail.offset += end + 1;
      rest = data.subarray(end + 1);
    }
  } finally {
    closeSync(handle);
  }
}
