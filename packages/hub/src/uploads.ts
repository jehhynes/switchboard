import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the files a web page attaches are written, so a message can mention them (architecture.md § Web page). Outside Windows the temporary
 * folder is shared by every user, so the folder name carries the user ID.
 */
export const UPLOAD_DIR = join(tmpdir(), process.platform === 'win32' || process.getuid === undefined ? 'switchboard-pasted' : `switchboard-pasted-${process.getuid()}`);
/** The largest file a page attaches, the Conversation view's limit for a pasted image. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
/** The longest name an attached file keeps after its time and random part. */
const NAME_CHARS = 80;
/** The names Switchboard gives attached files and pasted images; cleanup deletes only these. */
const UPLOADED_NAME = /^(pasted-\d{8}-\d{6}-[0-9a-f]{6}\.(png|jpg|gif|webp)|attached-\d{8}-\d{6}-[0-9a-f]{6}-[A-Za-z0-9._-]+)$/;
/** Extensions Claude Code reads as a picture, so a file named with one must be a picture it can read. */
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;

/** The picture type a file's first bytes show, of those the composer takes (PNG, JPEG, GIF, WebP), as the extension it is written with; null for any other. */
export function imageType(bytes: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | null {
  const starts = (...values: number[]): boolean => values.every((value, index) => bytes[index] === value);
  const ascii = (at: number, text: string): boolean => [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));

  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'png';
  }

  if (starts(0xff, 0xd8, 0xff)) {
    return 'jpg';
  }

  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) {
    return 'gif';
  }

  return ascii(0, 'RIFF') && ascii(8, 'WEBP') ? 'webp' : null;
}

/**
 * A file name safe to write on any platform: its last path part, with every character but ASCII letters, digits, `.`, `_` and `-` made `_`,
 * no leading or trailing dot, and at most 80 characters, cut before its extension; `file` when nothing is left.
 */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const plain = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '');

  if (plain.length <= NAME_CHARS) {
    return plain === '' ? 'file' : plain;
  }

  const extension = /\.[A-Za-z0-9]{1,16}$/.exec(plain)?.[0] ?? '';

  return `${plain.slice(0, NAME_CHARS - extension.length)}${extension}`;
}

/**
 * Writes a file a web page attached to `dir` under a new name with its time and returns its path. A PNG, JPEG, GIF or WebP picture, known by its
 * first bytes, gets a pasted image's name, as the Conversation view writes one; any other file `attached-<time>-<random>-<its name>`. Refuses an
 * empty file, one larger than 10 MB, one named as a picture that is not one Claude can read, and a folder that is a link or junction, which could
 * point the cleanup elsewhere. Deletes the files it and the Conversation view wrote there that are older than a week, and only those.
 */
export function writeUpload(name: string, bytes: Uint8Array, now: number, dir = UPLOAD_DIR, uid: number | undefined = process.platform === 'win32' ? undefined : process.getuid?.()): { path: string; image: boolean } | { error: string } {
  const shown = name.trim() === '' ? 'The file' : name;

  if (bytes.length === 0) {
    return { error: `${shown} is empty.` };
  }

  if (bytes.length > MAX_UPLOAD_BYTES) {
    return { error: `${shown} is larger than 10 MB.` };
  }

  const image = imageType(bytes);

  // The name written, since a trailing dot or an invisible character can hide a picture's extension in the name given.
  if (image === null && IMAGE_EXTENSION.test(safeName(name))) {
    return { error: `${shown} is not a PNG, JPEG, GIF or WebP image.` };
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const folder = lstatSync(dir);

  if (folder.isSymbolicLink() || !folder.isDirectory()) {
    return { error: `${shown} was not saved: ${dir} is not a plain folder.` };
  }

  // Outside Windows, only this user may own or read the folder: another user could have made it first in a shared temporary folder.
  if (uid !== undefined) {
    if (folder.uid !== uid) {
      return { error: `${shown} was not saved: ${dir} belongs to another user.` };
    }

    if ((folder.mode & 0o077) !== 0) {
      chmodSync(dir, 0o700);
    }
  }

  for (const old of readdirSync(dir).filter((one) => UPLOADED_NAME.test(one))) {
    try {
      const file = lstatSync(join(dir, old));

      if (file.isFile() && now - file.mtimeMs > UPLOAD_KEPT_MS) {
        unlinkSync(join(dir, old));
      }
    } catch {
      // Gone already, or in use.
    }
  }

  const at = new Date(now);
  const two = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}-${randomBytes(3).toString('hex')}`;
  const path = join(dir, image === null ? `attached-${stamp}-${safeName(name)}` : `pasted-${stamp}.${image}`);

  // A new file only: never one already there.
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return { path, image: image !== null };
}
