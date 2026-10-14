import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import type { CopyRelation, Session } from '@switchboard/core';
import { projectSlug } from './debrief.js';
import type { RosterEntry } from './runner.js';

/** How long a transcript that was not found waits before it is looked for again. */
export const MISSING_RETRY_MS = 60_000;

/** What a transcript says about its copy: a fork copies its source's `requestId`s with new uuids and session ID (mechanics M36). */
interface Index {
  path: string;
  /** The project directory, by its lowercased name. */
  project: string;
  /** The file's identity, so a replaced file is read again from the start. */
  ino: number;
  createdAt: number;
  /** Bytes read, and the bytes of an incomplete last line. */
  offset: number;
  rest: Buffer;
  /** The first assistant `requestId` outside a subagent. */
  key: string | null;
  ids: Set<string>;
}

/**
 * Transcript indexes by native session ID. Transcripts are append-only, so each read takes only the bytes written since the last one,
 * and a transcript is read at most once per pass. A transcript that was not found is looked for again after {@link MISSING_RETRY_MS}.
 */
export class Transcripts {
  readonly #indexes = new Map<string, Index>();
  readonly #missing = new Map<string, number>();
  #read = new Set<string>();

  constructor(
    private readonly projectsDir: string,
    private readonly now: () => number,
  ) {}

  /** Starts a pass, after which each transcript is read again once. */
  pass(): void {
    this.#read = new Set();
  }

  /** The index of a session's transcript, looked for in the project directory of `cwd`, or in every project directory without it. */
  index(sessionId: string, cwd: string | null): Index | null {
    let index = this.#indexes.get(sessionId) ?? null;

    if (index === null) {
      if ((this.#missing.get(sessionId) ?? 0) > this.now()) {
        return null;
      }

      const path = this.locate(sessionId, cwd);

      if (path === null) {
        this.#missing.set(sessionId, this.now() + MISSING_RETRY_MS);
        return null;
      }

      this.#missing.delete(sessionId);
      index = { path, project: path.slice(this.projectsDir.length + 1, path.lastIndexOf('/')).toLowerCase(), ino: -1, createdAt: 0, offset: 0, rest: Buffer.alloc(0), key: null, ids: new Set() };
      this.#indexes.set(sessionId, index);
    }

    if (!this.#read.has(sessionId)) {
      this.#read.add(sessionId);
      this.read(index);
    }

    return index;
  }

  /** The transcript's path: in the exact project directory first, then one that differs only in case, or in any without `cwd`. */
  private locate(sessionId: string, cwd: string | null): string | null {
    const slug = cwd === null ? null : projectSlug(cwd);
    const exists = (name: string) => {
      try {
        statSync(`${this.projectsDir}/${name}/${sessionId}.jsonl`);
        return true;
      } catch {
        return false;
      }
    };

    if (slug !== null && exists(slug)) {
      return `${this.projectsDir}/${slug}/${sessionId}.jsonl`;
    }

    const names = this.list().filter((name) => slug === null || (name !== slug && name.toLowerCase() === slug.toLowerCase()));
    const name = names.find(exists);

    return name === undefined ? null : `${this.projectsDir}/${name}/${sessionId}.jsonl`;
  }

  private list(): string[] {
    try {
      return readdirSync(this.projectsDir);
    } catch {
      return [];
    }
  }

  /** Reads the bytes written since the last read; a replaced or shorter file is read again from the start. */
  private read(index: Index): void {
    let fd: number;

    try {
      fd = openSync(index.path, 'r');
    } catch {
      return;
    }

    try {
      const stat = fstatSync(fd);

      if (stat.ino !== index.ino || stat.birthtimeMs !== index.createdAt || stat.size < index.offset) {
        Object.assign(index, { ino: stat.ino, createdAt: stat.birthtimeMs, offset: 0, rest: Buffer.alloc(0), key: null, ids: new Set<string>() });
      }

      const size = stat.size - index.offset;

      if (size <= 0) {
        return;
      }

      const chunk = Buffer.alloc(size);
      const read = readSync(fd, chunk, 0, size, index.offset);
      const bytes = Buffer.concat([index.rest, chunk.subarray(0, read)]);
      const end = bytes.lastIndexOf(0x0a);

      index.offset += read;
      index.rest = Buffer.from(bytes.subarray(end + 1));

      for (const line of bytes.subarray(0, end + 1).toString('utf8').split('\n')) {
        const id = requestIdOf(line);

        if (id !== null) {
          index.key ??= id;
          index.ids.add(id);
        }
      }
    } finally {
      closeSync(fd);
    }
  }
}

function requestIdOf(line: string): string | null {
  if (!line.includes('"requestId"')) {
    return null;
  }

  try {
    const entry = JSON.parse(line) as { type?: unknown; isSidechain?: unknown; requestId?: unknown };
    return entry.type === 'assistant' && entry.isSidechain !== true && typeof entry.requestId === 'string' ? entry.requestId : null;
  } catch {
    return null;
  }
}

type Current = Session & { nativeSessionId: string };

/**
 * How `nativeSessionId` relates to the session's current copy: `older` for a retired copy or a fork of the family created before the
 * current copy, `newer` for one created after it, else `unrelated`. A fork belongs to the family when its first `requestId` is in the
 * transcript of the current copy or of a retired one, in the same project directory.
 */
export function relationOf(transcripts: Transcripts, nativeSessionId: string, cwd: string | null, session: Current): CopyRelation {
  if (session.retiredIds.includes(nativeSessionId)) {
    return 'older';
  }

  const copy = transcripts.index(nativeSessionId, cwd);
  const current = copy?.key == null ? null : transcripts.index(session.nativeSessionId, session.cwd);

  if (copy?.key == null || current === null || copy.project !== current.project) {
    return 'unrelated';
  }

  const family = [current, ...session.retiredIds.flatMap((id) => transcripts.index(id, session.cwd) ?? [])];

  if (!family.some((member) => member.ids.has(copy.key!))) {
    return 'unrelated';
  }

  return copy.createdAt > current.createdAt ? 'newer' : 'older';
}

/** Each work item's latest Claude session with a native ID, which a fork may replace; the flow checks it is the work item's latest. */
export function forkTargets(sessions: Session[]): Current[] {
  const latest = new Map<number, Current>();

  for (const session of sessions) {
    if (session.provider === 'claude' && session.nativeSessionId !== null && session.state !== 'starting') {
      latest.set(session.workItemId, session as Current);
    }
  }

  return [...latest.values()];
}

/**
 * The newest live fork of each session: an interactive roster entry with a pid whose copy is `newer` than the session's current one.
 * VS Code writes a fork into its window's project directory, so only entries in a session's project directory are read.
 */
export function findForks(transcripts: Transcripts, entries: RosterEntry[], sessions: Session[]): Map<string, RosterEntry> {
  const known = new Set(sessions.flatMap((session) => [...(session.nativeSessionId === null ? [] : [session.nativeSessionId]), ...session.retiredIds]));
  const targets = forkTargets(sessions);
  const forks = new Map<string, { entry: RosterEntry; createdAt: number }>();

  transcripts.pass();

  for (const entry of entries) {
    if (entry.pid === undefined || entry.kind === 'background' || known.has(entry.sessionId)) {
      continue;
    }

    const project = projectSlug(entry.cwd).toLowerCase();

    for (const session of targets) {
      if (projectSlug(session.cwd).toLowerCase() !== project || relationOf(transcripts, entry.sessionId, entry.cwd, session) !== 'newer') {
        continue;
      }

      const createdAt = transcripts.index(entry.sessionId, entry.cwd)!.createdAt;
      const prior = forks.get(session.id);

      if (prior === undefined || createdAt > prior.createdAt) {
        forks.set(session.id, { entry, createdAt });
      }
    }
  }

  return new Map([...forks].map(([sessionId, fork]) => [sessionId, fork.entry]));
}
