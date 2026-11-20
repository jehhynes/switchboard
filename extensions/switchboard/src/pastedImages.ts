import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where pasted images are written, so a message can mention them; files older than `PASTED_KEPT_MS` are deleted when one is written. */
export const PASTED_DIR = join(tmpdir(), 'switchboard-pasted');
const PASTED_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
/** The names Switchboard gives pasted images; cleanup deletes only these. */
const PASTED_NAME = /^pasted-\d{8}-\d{6}-[0-9a-f]{6}\.(png|jpg|gif|webp)$/;
/** The pasted image types and the extension each is written with. */
const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** The largest pasted image written, as base64 grows it by a third. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Writes a pasted image to `dir` under a new name with its time and returns its path, deleting the pasted images there older than a week, and
 * only those: regular files with the names it gives. Refuses a type that is not an image the composer takes, an empty one, one larger than 10 MB,
 * and a folder that is a link or junction, which could point the cleanup elsewhere.
 */
export function writePastedImage(mime: string, data: string, now: number, dir = PASTED_DIR): { path: string } | { error: string } {
  const extension = IMAGE_EXTENSIONS[mime];

  if (extension === undefined) {
    return { error: 'Only PNG, JPEG, GIF and WebP images can be pasted.' };
  }

  const bytes = Buffer.from(data, 'base64');

  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    return { error: bytes.length === 0 ? 'The pasted image is empty.' : 'The pasted image is larger than 10 MB.' };
  }

  mkdirSync(dir, { recursive: true });

  const folder = lstatSync(dir);

  if (folder.isSymbolicLink() || !folder.isDirectory()) {
    return { error: `The pasted image was not saved: ${dir} is not a plain folder.` };
  }

  for (const name of readdirSync(dir).filter((one) => PASTED_NAME.test(one))) {
    try {
      const file = lstatSync(join(dir, name));

      if (file.isFile() && now - file.mtimeMs > PASTED_KEPT_MS) {
        unlinkSync(join(dir, name));
      }
    } catch {
      // Gone already, or in use.
    }
  }

  const at = new Date(now);
  const two = (value: number): string => String(value).padStart(2, '0');
  const path = join(dir, `pasted-${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}-${randomBytes(3).toString('hex')}.${extension}`);

  // A new file only: never one already there.
  writeFileSync(path, bytes, { flag: 'wx' });
  return { path };
}
