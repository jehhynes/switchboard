import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PAGE_ASSETS } from '@switchboard/web';

/** Mermaid's self-contained build, which the extension installs in `<home>/web/` beside the hub bundle, since it is too large to carry in it. */
export const PAGE_MERMAID = 'mermaid.min.js';

/** A page file the hub serves: its type and bytes, and for the diff viewer's files that they never change under their name and go gzipped. */
export interface PageFileAsset {
  mime: string;
  body: Buffer | string;
  immutable?: boolean;
  /** The body gzipped, for a client that takes gzip. */
  gzip?: Buffer;
}

/** A diff viewer build's name: 16 hex characters, a hash of its files (`packages/web/build.mjs`). */
const DIFF_BUILD = /^[0-9a-f]{16}$/;
const DIFF_MIME: Record<string, string> = { js: 'text/javascript; charset=utf-8', json: 'application/json' };

/** A diff viewer file's name in its manifest: a plain relative path of a script or JSON file, as the build writes them. */
function diffFileName(file: unknown): file is string {
  return typeof file === 'string' && /^[\w.-]+(\/[\w.-]+)*\.(js|json)$/.test(file) && !file.split('/').some((part) => part === '.' || part === '..');
}

interface DiffManifest {
  build: string;
  files: string[];
}

function readDiffManifest(dir: string): DiffManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Partial<DiffManifest>;

    return typeof raw.build === 'string' && DIFF_BUILD.test(raw.build) && Array.isArray(raw.files) && raw.files.every(diffFileName) ? { build: raw.build, files: raw.files } : null;
  } catch {
    return null;
  }
}

/**
 * Installs the diff viewer an extension carries (`<dist>/diff`) in `<home>/web/diff/<build>/` (architecture.md § Web page), whole or not at all:
 * copied beside it first and renamed into place, then every other build's folder removed. Answers the build, or null when the dist carries
 * none; throws when it cannot be copied.
 */
export function installDiffViewer(source: string, webDir: string): string | null {
  const manifest = readDiffManifest(source);

  if (manifest === null) {
    return null;
  }

  const root = join(webDir, 'diff');
  const target = join(root, manifest.build);

  if (readDiffManifest(target)?.build !== manifest.build || !manifest.files.every((file) => existsSync(join(target, file)))) {
    const temporary = `${target}.${process.pid}.tmp`;

    mkdirSync(root, { recursive: true });
    rmSync(temporary, { recursive: true, force: true });
    cpSync(source, temporary, { recursive: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(temporary, target);
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name !== manifest.build && entry.isDirectory()) {
      rmSync(join(root, entry.name), { recursive: true, force: true });
    }
  }

  return manifest.build;
}

/** Each installed diff viewer build's manifest and gzipped files, read once; only builds with a manifest are kept, so unknown names add nothing. */
const diffBuilds = new Map<string, { manifest: DiffManifest; gzipped: Map<string, Buffer> }>();

/** A file of an installed diff viewer build, `diff/<build>/<file>`, only by a name its manifest lists; null for any other. */
function diffAsset(name: string, home: string): PageFileAsset | null {
  const [, build = '', ...rest] = name.split('/');
  const file = rest.join('/');

  if (!DIFF_BUILD.test(build)) {
    return null;
  }

  const dir = join(home, 'web', 'diff', build);
  let known = diffBuilds.get(build);

  if (known === undefined) {
    const manifest = readDiffManifest(dir);

    if (manifest === null || manifest.build !== build) {
      return null;
    }

    known = { manifest, gzipped: new Map() };
    diffBuilds.set(build, known);
  }

  const mime = DIFF_MIME[file.slice(file.lastIndexOf('.') + 1)];

  if (!known.manifest.files.includes(file) || mime === undefined) {
    return null;
  }

  try {
    const path = join(dir, ...file.split('/'));

    // A regular file only, never a link the folder holds.
    if (!lstatSync(path).isFile()) {
      return null;
    }

    const body = readFileSync(path);
    const gzip = known.gzipped.get(file) ?? gzipSync(body, { level: 9 });

    known.gzipped.set(file, gzip);
    return { mime, body, immutable: true, gzip };
  } catch {
    return null;
  }
}

/**
 * A file of the web page (architecture.md § Web page): the page's own files, carried in the hub bundle so they always match the hub, Mermaid
 * and the diff viewer's files from the Switchboard home; null for any other name.
 */
export function pageAsset(name: string, home: string): PageFileAsset | null {
  if (name === PAGE_MERMAID) {
    try {
      return { mime: 'text/javascript; charset=utf-8', body: readFileSync(join(home, 'web', PAGE_MERMAID)) };
    } catch {
      return null;
    }
  }

  if (name.startsWith('diff/')) {
    return diffAsset(name, home);
  }

  const asset = Object.hasOwn(PAGE_ASSETS, name) ? PAGE_ASSETS[name] : undefined;

  return asset === undefined ? null : { mime: asset.mime, body: asset.base64 ? Buffer.from(asset.body, 'base64') : asset.body };
}
