import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

/** The browser extension's folder in `<home>/web/`, which the extension installs from its `dist/chrome` (architecture.md § Browser extension). */
export const BROWSER_EXTENSION_DIR = 'chrome';

/** The download's file name, and the folder its files are in, which the operator chooses in Load unpacked. */
export const BROWSER_EXTENSION_NAME = 'switchboard-extension';

/** The file a copy for another device holds, naming the web page's origin; the extension's `REMOTE_FILE`. */
const REMOTE_FILE = 'remote.json';

/**
 * Installs the browser extension's unpacked build an extension carries in `<webDir>/chrome/`, whole or not at all: copied beside it first and
 * renamed into place, the installed copy kept aside until then and put back when the new one cannot take its place. False when the dist carries
 * none; throws when it cannot be copied.
 */
export function installBrowserExtension(source: string, webDir: string, rename: (from: string, to: string) => void = renameSync): boolean {
  if (!existsSync(join(source, 'manifest.json'))) {
    return false;
  }

  const target = join(webDir, BROWSER_EXTENSION_DIR);
  const temporary = `${target}.${process.pid}.tmp`;

  if (sameFiles(source, target)) {
    return true;
  }

  mkdirSync(webDir, { recursive: true });
  const previous = `${target}.${process.pid}.old`;

  rmSync(temporary, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
  cpSync(source, temporary, { recursive: true });

  const kept = existsSync(target);

  if (kept) {
    rename(target, previous);
  }

  try {
    rename(temporary, target);
  } catch (error) {
    if (kept) {
      rename(previous, target);
    }

    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }

  rmSync(previous, { recursive: true, force: true });
  return true;
}

/** Whether two folders hold the same files with the same bytes. */
function sameFiles(one: string, other: string): boolean {
  try {
    const names = filesUnder(one);

    return names.join('\0') === filesUnder(other).join('\0') && names.every((name) => readFileSync(join(one, name)).equals(readFileSync(join(other, name))));
  } catch {
    return false;
  }
}

/** The regular files under a folder, relative with forward slashes, sorted; links are left out. */
function filesUnder(root: string, dir = ''): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const name = dir === '' ? entry.name : `${dir}/${entry.name}`;

      return entry.isDirectory() ? filesUnder(root, name) : entry.isFile() ? [name] : [];
    })
    .sort();
}

/**
 * The installed browser extension as a zip of one folder (PRD R121), or null when none is installed. For another device, `origin` is the web
 * page's HTTPS origin: the copy names it in `remote.json`, and its manifest adds a host permission for that name, so the extension reaches the hub
 * through the page's origin with the page's sign-in, and lets the page there message it (`externally_connectable`), so the page's links open in
 * its tab group. With no origin the copy is the build as it is, which reaches the hub on this computer.
 */
export function browserExtensionZip(webDir: string, origin: string | null): Buffer | null {
  const dir = join(webDir, BROWSER_EXTENSION_DIR);
  let files: string[];

  try {
    if (!lstatSync(join(dir, 'manifest.json')).isFile()) {
      return null;
    }

    files = filesUnder(dir).filter((name) => name !== REMOTE_FILE);
  } catch {
    return null;
  }

  const entries = files.map((name) => {
    const body = readFileSync(join(dir, ...name.split('/')));

    if (name !== 'manifest.json' || origin === null) {
      return { name, body };
    }

    const manifest = JSON.parse(body.toString('utf8')) as { host_permissions?: string[]; externally_connectable?: { matches: string[] } };

    manifest.host_permissions = [...(manifest.host_permissions ?? []), `${origin}/*`];
    manifest.externally_connectable = { matches: [`${origin}/*`] };
    return { name, body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) };
  });

  if (origin !== null) {
    entries.push({ name: REMOTE_FILE, body: Buffer.from(`${JSON.stringify({ origin })}\n`) });
  }

  return zip(entries.map(({ name, body }) => ({ name: `${BROWSER_EXTENSION_NAME}/${name}`, body })));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;

  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }

  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;

  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }

  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive of the files, each deflated, with no time stamps (1980-01-01), so the same files always give the same bytes. */
export function zip(files: ReadonlyArray<{ name: string; body: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const { name, body } of files) {
    const path = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(body);
    const crc = crc32(body);
    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(path.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);

    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(body.length, 24);
    header.writeUInt16LE(path.length, 28);
    header.writeUInt32LE(offset, 42);
    parts.push(local, path, packed);
    central.push(header, path);
    offset += local.length + path.length + packed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
