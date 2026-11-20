import { readdirSync, readFileSync, realpathSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';

/** How the extension opens an artifact (architecture.md § Artifacts): by its file's extension. */
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
  log(line: string): void;
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
  readonly #items = new Map<string, Artifact & { stamp: string }>();
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
    return [...this.#items.values()].map(({ stamp: _stamp, ...artifact }) => artifact).sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
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

    const type = artifactType(name);
    let text = '';

    if ((type === 'markdown' || type === 'html') && stat.size < TITLE_READ_BYTES) {
      try {
        text = readFileSync(real!, 'utf8');
      } catch {
        return;
      }
    }

    const artifact = { path: name, ...parseArtifact(text, name), ext: extname(name).slice(1).toLowerCase(), type, updatedAt: Math.max(stat.mtimeMs, known?.updatedAt ?? 0), stamp };

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

  #publish({ stamp: _stamp, ...artifact }: Artifact & { stamp: string }): void {
    if (!this.#quiet) {
      this.deps.log(`artifact changed: ${artifact.path}`);
      this.deps.onChange({ artifact });
    }
  }
}
