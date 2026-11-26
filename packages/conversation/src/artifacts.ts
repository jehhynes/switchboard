import type { LogLevel } from '@switchboard/core';
import { readdirSync, readFileSync, realpathSync, statSync, watch } from 'node:fs';
import type { Dirent, FSWatcher } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

/** How the web page opens an artifact (architecture.md § Artifacts): by its file's extension. */
export type ArtifactType = 'markdown' | 'html' | 'image' | 'audio' | 'video' | 'file';

/**
 * An artifact of a work item: a file one level down in its artifact folder, `<owner>/<file>`, from claude-collab's `artifacts.js`. `path` is that
 * relative name with forward slashes; `updatedAt` is when it or a file it uses last changed, epoch milliseconds.
 */
export interface Artifact {
  path: string;
  owner: string;
  kind: string;
  title: string;
  ext: string;
  type: ArtifactType;
  updatedAt: number;
  /** For a file outside the artifact folder that an artifact tag named (`ExternalArtifacts`), its real path with forward slashes. */
  file?: string;
}

/** A folder segment or file name: no segment starts with a dot, so neither `..` nor a dotfile such as `.gitignore` is an artifact. */
const SEGMENT = '[\\w-][\\w.-]*';
/** An artifact's name, `<owner>/<file>`. */
export const ARTIFACT_NAME = new RegExp(`^${SEGMENT}/${SEGMENT}$`);

const TYPES: Record<string, ArtifactType> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  flac: 'audio',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
};

export function artifactType(name: string): ArtifactType {
  return TYPES[extname(name).slice(1).toLowerCase()] ?? 'file';
}

/** Only text types are read for a title, and only up to this size. */
const TITLE_READ_BYTES = 4_000_000;

/** A read artifact's stat stamp and, for a file up to `DIGEST_MAX_BYTES`, its content's SHA-256. */
type Stamped = { stamp: string; digest: string | null };

/** Larger files, such as videos, are not hashed, so a rewrite of one counts as a change whatever its bytes. */
const DIGEST_MAX_BYTES = 8 * 1024 * 1024;

function contentDigest(path: string, size: number): string | null {
  if (size > DIGEST_MAX_BYTES) {
    return null;
  }

  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * An artifact's kind and title: a Markdown file's front matter `kind` and `title`, else its first `#` heading, an HTML page's `<title>`; the
 * kind else the file name's first word, as `comparison` of `comparison-speech.md`; the title else the file name without its extension.
 */
export function parseArtifact(text: string, name: string): { owner: string; kind: string; title: string } {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta: Record<string, string> = {};

  for (const line of front?.[1]?.split(/\r?\n/) ?? []) {
    const field = /^(\w+):\s*(.*?)\s*$/.exec(line);

    if (field !== null) {
      meta[field[1]!] = field[2]!.replace(/^["']|["']$/g, '');
    }
  }

  const body = front === null ? text : text.slice(front[0].length);
  const [owner = '', file = ''] = name.split('/');
  const kind = meta['kind'] || /^[a-z]+/i.exec(file)?.[0]?.toLowerCase() || 'note';
  const title = meta['title'] || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || /<title>([^<]+)<\/title>/i.exec(body)?.[1]?.trim() || file.replace(/\.[^.]+$/, '');

  return { owner, kind, title };
}

/**
 * The real path of `rel`, a path with forward slashes under `dir`, or null when there is none or a link on the way, a symlink or a junction,
 * takes it out of `dir` (claude-collab's real-path containment).
 */
export function realInside(dir: string, rel: string): string | null {
  try {
    const real = realpathSync.native(join(dir, ...rel.split('/')));
    const inside = relative(realpathSync.native(dir), real);

    return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? real : null;
  } catch {
    return null;
  }
}

export interface ArtifactFolderDeps {
  /** An artifact written, rewritten or changed through a file it uses, or removed. */
  onChange(change: { artifact: Artifact } | { path: string; removed: true }): void;
  now(): number;
  log(line: string, level?: LogLevel): void;
  /** How long a file's changes settle before it is read; 150 ms by default. */
  settleMs?: number;
  /** How often a missing folder is looked for; a second by default. */
  lookMs?: number;
}

/**
 * A work item's artifact folder (architecture.md § Artifacts), watched recursively: each `<owner>/<file>` is an artifact, and a change under
 * `<owner>/<stem>/`, the folder of files it uses, is a change to it. A folder that does not exist, or is deleted, is looked for each second.
 */
export class ArtifactFolder {
  readonly #items = new Map<string, Artifact & Stamped>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  #watcher: FSWatcher | null = null;
  #look: NodeJS.Timeout | null = null;
  #id: string | null = null;
  #closed = false;
  /** While the folder is first read, which the owner reads with `list`, nothing is published. */
  #quiet = true;

  constructor(
    readonly dir: string,
    private readonly deps: ArtifactFolderDeps,
  ) {
    this.#watch();
    this.#quiet = false;
  }

  /** The artifacts, newest first. */
  list(): Artifact[] {
    return [...this.#items.values()].map(({ stamp: _stamp, digest: _digest, meta: _meta, ...artifact }: Artifact & Stamped & { meta?: string }) => artifact).sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
  }

  /** Reads every artifact again, as when the folder appears. */
  rescan(): void {
    for (const name of [...this.#items.keys()]) {
      this.#scan(name);
    }

    let owners: string[] = [];

    try {
      owners = readdirSync(this.dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return;
    }

    for (const owner of owners) {
      this.#scanOwner(owner);
    }
  }

  close(): void {
    this.#closed = true;
    this.#watcher?.close();
    this.#watcher = null;

    if (this.#look !== null) {
      clearInterval(this.#look);
      this.#look = null;
    }

    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }

    this.#timers.clear();
  }

  /** Which folder is at `dir`: deleted and made again, it is another one. */
  #folderId(): string | null {
    try {
      const stat = statSync(this.dir, { bigint: true });

      return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
    } catch {
      return null;
    }
  }

  #watch(): void {
    this.#id = this.#folderId();

    if (this.#id === null) {
      this.#lost();
      return;
    }

    try {
      this.#watcher = watch(this.dir, { recursive: true }, (_event, name) => this.#event(name));
      this.#watcher.on('error', () => this.#lost());
      this.#watcher.unref();
    } catch {
      this.#lost();
      return;
    }

    this.rescan();
  }

  /** The folder is gone or cannot be watched: its artifacts are removed, and it is looked for until it is back. */
  #lost(): void {
    this.#watcher?.close();
    this.#watcher = null;

    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }

    this.#timers.clear();

    for (const name of [...this.#items.keys()]) {
      this.#items.delete(name);
      this.deps.onChange({ path: name, removed: true });
    }

    if (this.#look !== null || this.#closed) {
      return;
    }

    this.#look = setInterval(() => {
      if (this.#folderId() === null) {
        return;
      }

      clearInterval(this.#look!);
      this.#look = null;
      this.#watch();
    }, this.deps.lookMs ?? 1_000);
    this.#look.unref();
  }

  #event(raw: string | Buffer | null): void {
    // Windows repeats events for a deleted folder until its watch is closed, even after a folder of the same name is made.
    if (this.#folderId() !== this.#id) {
      this.#lost();
      return;
    }

    const name = raw?.toString().replaceAll('\\', '/');

    if (name === undefined || name === '') {
      return;
    }

    const parts = name.split('/');

    // An owner folder made, renamed or deleted arrives as one event for the folder.
    if (parts.length === 1) {
      this.#settle(`owner:${name}`, () => this.#scanOwner(name));
      return;
    }

    if (ARTIFACT_NAME.test(name)) {
      this.#settle(name, () => this.#scan(name));
    }

    // A file or folder an artifact uses, `<owner>/<stem>/...`, or that folder itself made, renamed or deleted, changes every artifact of that stem.
    for (const user of [...this.#items.keys()].filter((key) => key !== name && key.replace(/\.[^./]+$/, '') === `${parts[0]}/${parts[1]}`)) {
      this.#settle(`uses:${user}`, () => this.#touch(user));
    }
  }

  /** Runs `then` once a key's changes have settled, since one write arrives as several events. */
  #settle(key: string, then: () => void): void {
    clearTimeout(this.#timers.get(key));
    this.#timers.set(
      key,
      setTimeout(() => {
        this.#timers.delete(key);

        if (!this.#closed) {
          then();
        }
      }, this.deps.settleMs ?? 150),
    );
  }

  #scanOwner(owner: string): void {
    for (const name of [...this.#items.keys()].filter((key) => key.startsWith(`${owner}/`))) {
      this.#scan(name);
    }

    let files: string[] = [];

    try {
      files = readdirSync(join(this.dir, owner));
    } catch {
      return;
    }

    for (const file of files) {
      if (ARTIFACT_NAME.test(`${owner}/${file}`)) {
        this.#scan(`${owner}/${file}`);
      }
    }
  }

  /**
   * Reads one artifact: added or changed when its file did, removed when its file is gone, not a file, or reached through a link outside. A file
   * whose time, change time and size are the ones read before is unchanged, so a rewrite that keeps the file's time still counts.
   */
  #scan(name: string): void {
    const real = realInside(this.dir, name);
    let stat;

    try {
      stat = real === null ? null : statSync(real);
    } catch {
      stat = null;
    }

    if (stat === null || !stat.isFile()) {
      if (this.#items.delete(name)) {
        this.deps.onChange({ path: name, removed: true });
      }

      return;
    }

    const known = this.#items.get(name);

    const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;

    if (known?.stamp === stamp) {
      return;
    }

    const digest = contentDigest(real!, stat.size);

    // The same bytes written again, as a git checkout or rebase does, are not a new version.
    if (known !== undefined && digest !== null && known.digest === digest) {
      known.stamp = stamp;
      return;
    }

    const type = artifactType(name);
    let text = '';

    if ((type === 'markdown' || type === 'html') && stat.size < TITLE_READ_BYTES) {
      try {
        text = readFileSync(real!, 'utf8');
      } catch {
        return;
      }
    }

    const artifact = { path: name, ...parseArtifact(text, name), ext: extname(name).slice(1).toLowerCase(), type, updatedAt: Math.max(stat.mtimeMs, known?.updatedAt ?? 0), stamp, digest };

    // A rewrite with an older time, as a copy that keeps its time, still counts as a change.
    if (known !== undefined && artifact.updatedAt === known.updatedAt) {
      artifact.updatedAt = this.deps.now();
    }

    this.#items.set(name, artifact);
    this.#publish(artifact);
  }

  /** A file the artifact uses changed. */
  #touch(name: string): void {
    const known = this.#items.get(name);

    if (known !== undefined) {
      known.updatedAt = Math.max(this.deps.now(), known.updatedAt + 1);
      this.#publish(known);
    }
  }

  #publish({ stamp: _stamp, digest: _digest, ...artifact }: Artifact & Stamped): void {
    if (!this.#quiet) {
      this.deps.log(`artifact updated: ${artifact.path}`);
      this.deps.onChange({ artifact });
    }
  }
}


/** A file outside the artifact folder that a reply's artifact tag named (architecture.md § Artifacts), as the store keeps it: `path` is its real path. */
export interface ExternalEntry {
  id: number;
  path: string;
  title: string | null;
  kind: string | null;
}

/** The owner an external artifact shows. */
export const EXTERNAL_OWNER = 'external';

/**
 * An external artifact's name, `@<id>/<file name>`, which a file it uses extends, as `@<id>/screenshots/a.png`. No owner folder starts with `@`,
 * so it never names an artifact of the folder.
 */
export const externalName = (entry: ExternalEntry): string => `@${entry.id}/${basename(entry.path)}`;

/** An external artifact's name or the name of a file it uses: the store's ID, and the rest. */
export const EXTERNAL_NAME = /^@(\d{1,15})\/(.+)$/;

/** Whether a real path lies in or is a `.git` folder, which is never read. */
export const inGit = (real: string): boolean => real.split(/[\\/]/).some((part) => part.toLowerCase() === '.git');

/**
 * A segment of an artifact's file, or of a file an artifact uses, as the page names it. It does not start with a dot, end with a dot or a space,
 * which Windows drops, hold a backslash, a colon (a drive or an NTFS stream) or a control character, or name a Windows device such as `nul.png`;
 * spaces, `#` and other letters are allowed, as in a screenshot's name.
 */
export const ARTIFACT_SEGMENT = /^(?!(?:con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(?:\.|$))[^./\\:\x00-\x1f](?:[^/\\:\x00-\x1f]*[^/\\:\x00-\x1f. ])?$/i;

/**
 * The real path of a file an external artifact uses: `rest` is a path under the folder the artifact's file is in, the file itself included,
 * as an HTML page's pictures beside it (the operator's decision, architecture.md § Artifacts). Null for a segment that is no
 * `ARTIFACT_SEGMENT`, so no `..` or dot segment, a link or junction out of that folder, or a `.git` path.
 */
export function externalFile(entry: ExternalEntry, rest: string): string | null {
  const parts = rest.split('/');

  if (!parts.every((part) => ARTIFACT_SEGMENT.test(part))) {
    return null;
  }

  // Resolved inside the file's own folder, so a link or junction in it leads nowhere else.
  const real = realInside(dirname(entry.path), parts.join('/'));

  return real === null || inGit(real) ? null : real;
}

/** The most files and folders of an external artifact's `<stem>/` folder read for its version; a change past them shows only with the artifact's own. */
const USES_MAX = 500;

/** The names, times and sizes of the files an external artifact uses, in its `<stem>/` folder, so a change to one is a new version. */
function usesStamp(entry: ExternalEntry): string {
  // Only a folder in the file's own folder by real path, never one a link or junction leads elsewhere.
  const root = realInside(dirname(entry.path), basename(entry.path).replace(/\.[^.]+$/, ''));
  const seen: string[] = [];
  let visited = 0;

  if (root === null) {
    return '';
  }

  const walk = (dir: string): void => {
    let names: Dirent[];

    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const one of names) {
      if (++visited > USES_MAX || one.name.startsWith('.')) {
        continue;
      }

      const path = join(dir, one.name);

      if (one.isDirectory()) {
        walk(path);
      } else if (one.isFile()) {
        try {
          const stat = statSync(path);

          seen.push(`${relative(root, path)}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`);
        } catch {
          // A file gone since its folder was read counts for nothing.
        }
      }
    }
  };

  walk(root);

  return seen.join('|');
}

export interface ExternalArtifactsDeps {
  onChange(change: { artifact: Artifact } | { path: string; removed: true }): void;
  now(): number;
  log(line: string, level?: LogLevel): void;
  /** How often every file is read again, for a change its folder's watch missed; two seconds by default. */
  pollMs?: number;
  /** How long a file's changes settle before it is read; 150 ms by default. */
  settleMs?: number;
}

/**
 * A work item's external artifacts (architecture.md § Artifacts): the files its sessions' artifact tags named, each listed while it is a file
 * at the real path it was named by, with its type by extension, its kind and title from the tag, else as an artifact of the folder, and its
 * time from the file's. Each file's folder is watched, and every file read again every `pollMs`, so a folder that cannot be watched or
 * comes back still updates.
 */
export class ExternalArtifacts {
  readonly #items = new Map<number, Artifact & Stamped & { meta: string }>();
  #entries = new Map<number, ExternalEntry>();
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #timers = new Map<number, NodeJS.Timeout>();
  readonly #poll: NodeJS.Timeout;
  #closed = false;
  #quiet = true;

  constructor(entries: ExternalEntry[], private readonly deps: ExternalArtifactsDeps) {
    this.set(entries);
    this.#quiet = false;
    this.#poll = setInterval(() => this.#entries.forEach((entry) => this.#scan(entry)), deps.pollMs ?? 2_000);
    this.#poll.unref();
  }

  /** The work item's entries now, as the store lists them: new ones are read, and ones no longer listed removed. */
  set(entries: ExternalEntry[]): void {
    const next = new Map(entries.map((entry) => [entry.id, entry]));

    for (const id of [...this.#entries.keys()].filter((one) => !next.has(one))) {
      this.#remove(id);
    }

    this.#entries = next;
    next.forEach((entry) => this.#scan(entry));
    this.#follow();
  }

  /** The external artifacts, newest first. */
  list(): Artifact[] {
    return [...this.#items.values()].map(({ stamp: _stamp, digest: _digest, meta: _meta, ...artifact }: Artifact & Stamped & { meta?: string }) => artifact).sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
  }

  /** An entry by its ID, while it is listed. */
  entry(id: number): ExternalEntry | null {
    return this.#items.has(id) ? (this.#entries.get(id) ?? null) : null;
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#poll);
    this.#watchers.forEach((watcher) => watcher.close());
    this.#watchers.clear();
    this.#timers.forEach((timer) => clearTimeout(timer));
    this.#timers.clear();
  }

  /** Watches the folder of each entry's file, and stops watching folders no entry is in. */
  #follow(): void {
    const dirs = new Set([...this.#entries.values()].map((entry) => dirname(entry.path)));

    for (const [dir, watcher] of this.#watchers) {
      if (!dirs.has(dir)) {
        watcher.close();
        this.#watchers.delete(dir);
      }
    }

    for (const dir of dirs) {
      if (this.#watchers.has(dir)) {
        continue;
      }

      try {
        const watcher = watch(dir, (_event, name) => this.#event(dir, name?.toString() ?? null));

        watcher.on('error', () => {
          watcher.close();
          this.#watchers.delete(dir);
        });
        watcher.unref();
        this.#watchers.set(dir, watcher);
      } catch {
        // A folder that cannot be watched is still read every `pollMs`.
      }
    }
  }

  #event(dir: string, name: string | null): void {
    for (const entry of this.#entries.values()) {
      const file = basename(entry.path);

      if (dirname(entry.path) === dir && (name === null || name === file || name === file.replace(/\.[^.]+$/, ''))) {
        clearTimeout(this.#timers.get(entry.id));
        this.#timers.set(
          entry.id,
          setTimeout(() => {
            this.#timers.delete(entry.id);

            if (!this.#closed && this.#entries.get(entry.id) === entry) {
              this.#scan(entry);
            }
          }, this.deps.settleMs ?? 150),
        );
      }
    }
  }

  #remove(id: number): void {
    const known = this.#items.get(id);

    if (known !== undefined) {
      this.#items.delete(id);
      this.deps.onChange({ path: known.path, removed: true });
    }
  }

  /** Reads one entry: listed while it is a file at the real path it was named by, outside any `.git` folder; removed otherwise. */
  #scan(entry: ExternalEntry): void {
    let stat;

    try {
      stat = !inGit(entry.path) && realpathSync.native(entry.path) === entry.path ? statSync(entry.path) : null;
    } catch {
      stat = null;
    }

    if (stat === null || !stat.isFile()) {
      this.#remove(entry.id);
      return;
    }

    const known = this.#items.get(entry.id);
    const meta = JSON.stringify([entry.title, entry.kind, usesStamp(entry)]);
    const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${meta}`;

    if (known?.stamp === stamp) {
      return;
    }

    const digest = contentDigest(entry.path, stat.size);

    // The same bytes written again, as a git checkout or rebase does, are not a new version.
    if (known !== undefined && digest !== null && known.digest === digest && known.meta === meta) {
      known.stamp = stamp;
      return;
    }

    const name = basename(entry.path);
    const type = artifactType(name);
    let text = '';

    if ((type === 'markdown' || type === 'html') && stat.size < TITLE_READ_BYTES) {
      try {
        text = readFileSync(entry.path, 'utf8');
      } catch {
        return;
      }
    }

    const read = parseArtifact(text, `${EXTERNAL_OWNER}/${name}`);
    const artifact = {
      path: externalName(entry),
      owner: EXTERNAL_OWNER,
      kind: entry.kind ?? read.kind,
      title: entry.title ?? read.title,
      ext: extname(name).slice(1).toLowerCase(),
      type,
      updatedAt: Math.max(stat.mtimeMs, known?.updatedAt ?? 0),
      file: entry.path.split(sep).join('/'),
      stamp,
      digest,
      meta,
    };

    // A rewrite that kept the file's time, or a change to a file it uses, is still a newer version.
    if (known !== undefined && artifact.updatedAt === known.updatedAt) {
      artifact.updatedAt = Math.max(this.deps.now(), known.updatedAt + 1);
    }

    this.#items.set(entry.id, artifact);

    if (!this.#quiet) {
      const { stamp: _stamp, digest: _digest, meta: _meta, ...view } = artifact;

      this.deps.log(`artifact updated: ${entry.path}`);
      this.deps.onChange({ artifact: view });
    }
  }
}
