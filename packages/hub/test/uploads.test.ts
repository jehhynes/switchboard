import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { imageType, MAX_UPLOAD_BYTES, safeName, UPLOAD_DIR, writeUpload } from '../src/uploads.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const NOW = new Date(2026, 10, 19, 21, 5, 9).getTime();
const WEEK_AGO = new Date(NOW - 8 * 86_400_000);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-uploads-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('files a web page attaches', () => {
  it.runIf(process.platform !== 'win32')('keeps the folder and its files private to the user, in a folder named for the user, tightening a folder others can read', () => {
    expect(UPLOAD_DIR).toBe(join(tmpdir(), `switchboard-pasted-${process.getuid!()}`));
    const fresh = join(dir, 'fresh');
    const notes = writeUpload('notes.txt', Buffer.from('hello'), NOW, fresh);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    expect(statSync((notes as { path: string }).path).mode & 0o777).toBe(0o600);
    chmodSync(fresh, 0o775);
    expect(writeUpload('more.txt', Buffer.from('hello'), NOW, fresh)).toHaveProperty('path');
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform !== 'win32')('refuses a folder another user owns, writing, tightening and deleting nothing there', () => {
    const theirs = join(dir, 'theirs');
    mkdirSync(theirs, { mode: 0o777 });
    chmodSync(theirs, 0o777);
    writeFileSync(join(theirs, 'pasted-20261101-000000-abcdef.png'), PNG);
    utimesSync(join(theirs, 'pasted-20261101-000000-abcdef.png'), WEEK_AGO, WEEK_AGO);

    expect(writeUpload('notes.txt', Buffer.from('hello'), NOW, theirs, process.getuid!() + 1)).toEqual({ error: `notes.txt was not saved: ${theirs} belongs to another user.` });
    expect(readdirSync(theirs)).toEqual(['pasted-20261101-000000-abcdef.png']);
    expect(statSync(theirs).mode & 0o777).toBe(0o777);
  });

  it('knows PNG, JPEG, GIF and WebP pictures by their first bytes, and nothing else', () => {
    expect(imageType(PNG)).toBe('png');
    expect(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(imageType(Buffer.from('GIF89a...'))).toBe('gif');
    expect(imageType(Buffer.from('GIF87a...'))).toBe('gif');
    expect(imageType(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 '))).toBe('webp');
    expect(imageType(Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt '))).toBeNull();
    expect(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(imageType(Buffer.from('BM'))).toBeNull();
    expect(imageType(Buffer.alloc(0))).toBeNull();
  });

  it('keeps a name to its last part in plain characters, with no leading or trailing dot, cut before its extension', () => {
    expect(safeName('report.pdf')).toBe('report.pdf');
    expect(safeName('C:\\Users\\me\\..\\secret notes (1).txt')).toBe('secret_notes_1_.txt');
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('.bashrc')).toBe('bashrc');
    expect(safeName('CON.')).toBe('CON');
    expect(safeName('résumé.md')).toBe('r_sum_.md');
    expect(safeName('a"b<c>|d?*.txt')).toBe('a_b_c_d_.txt');
    expect(safeName('')).toBe('file');
    expect(safeName('...')).toBe('file');
    expect(safeName(`${'x'.repeat(200)}.json`)).toBe(`${'x'.repeat(75)}.json`);
  });

  it('writes a picture under a pasted image name and any other file under its own name, never over a file, and refuses what Claude cannot read', () => {
    const picture = writeUpload('Screenshot 2026.png', PNG, NOW, dir);

    expect(picture).toEqual({ path: expect.stringMatching(/[\\/]pasted-20261119-210509-[0-9a-f]{6}\.png$/), image: true });
    expect(readFileSync((picture as { path: string }).path)).toEqual(PNG);
    // A picture is known by its bytes, whatever its name says.
    expect(writeUpload('clipboard', Buffer.from('GIF89a..'), NOW, dir)).toEqual({ path: expect.stringMatching(/pasted-20261119-210509-[0-9a-f]{6}\.gif$/), image: true });

    const notes = writeUpload('my notes.txt', Buffer.from('hello'), NOW, dir);

    expect(notes).toEqual({ path: expect.stringMatching(/[\\/]attached-20261119-210509-[0-9a-f]{6}-my_notes\.txt$/), image: false });
    expect(readFileSync((notes as { path: string }).path, 'utf8')).toBe('hello');
    expect(writeUpload('fake.png', Buffer.from('not a picture'), NOW, dir)).toEqual({ error: 'fake.png is not a PNG, JPEG, GIF or WebP image.' });
    expect(writeUpload('photo.JPEG', Buffer.from('not a picture'), NOW, dir)).toEqual({ error: 'photo.JPEG is not a PNG, JPEG, GIF or WebP image.' });
    // An extension hidden behind a trailing dot or an invisible character is the one the file would be written with.
    expect(writeUpload('fake.png.', Buffer.from('not a picture'), NOW, dir)).toEqual({ error: 'fake.png. is not a PNG, JPEG, GIF or WebP image.' });
    expect(writeUpload('fake.png\u200b', Buffer.from('not a picture'), NOW, dir)).toEqual({ error: 'fake.png\u200b is not a PNG, JPEG, GIF or WebP image.' });
    expect(writeUpload('empty.txt', Buffer.alloc(0), NOW, dir)).toEqual({ error: 'empty.txt is empty.' });
    expect(writeUpload('', Buffer.alloc(0), NOW, dir)).toEqual({ error: 'The file is empty.' });
    expect(writeUpload('big.bin', Buffer.alloc(MAX_UPLOAD_BYTES + 1), NOW, dir)).toEqual({ error: 'big.bin is larger than 10 MB.' });
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(readdirSync(dir)).toHaveLength(3);
  });

  it('deletes only its own and the Conversation view\'s files older than a week, never another file, a folder or anything through a link', () => {
    const target = mkdtempSync(join(tmpdir(), 'hub-uploads-target-'));

    try {
      for (const name of ['attached-20261101-101010-abcdef-a.txt', 'pasted-20261101-101010-abcdef.png', 'important.txt', 'pasted-20261101-101010-abcdef.png.bak']) {
        writeFileSync(join(dir, name), 'x');
        utimesSync(join(dir, name), WEEK_AGO, WEEK_AGO);
      }

      writeFileSync(join(dir, 'attached-20261118-101010-abcdef-b.txt'), 'x');
      mkdirSync(join(dir, 'attached-20261101-101010-aaaaaa-folder'));
      writeUpload('c.txt', Buffer.from('c'), NOW, dir);
      expect(readdirSync(dir).filter((name) => !name.startsWith('attached-20261119')).sort()).toEqual(['attached-20261101-101010-aaaaaa-folder', 'attached-20261118-101010-abcdef-b.txt', 'important.txt', 'pasted-20261101-101010-abcdef.png.bak']);

      // A folder that is a link or junction is refused before anything in its target is read or deleted.
      const old = join(target, 'attached-20261101-101010-abcdef-a.txt');

      writeFileSync(old, 'x');
      utimesSync(old, WEEK_AGO, WEEK_AGO);
      symlinkSync(target, join(dir, 'linked'), 'junction');
      expect(writeUpload('c.txt', Buffer.from('c'), NOW, join(dir, 'linked'))).toEqual({ error: `c.txt was not saved: ${join(dir, 'linked')} is not a plain folder.` });
      expect(readdirSync(target)).toEqual(['attached-20261101-101010-abcdef-a.txt']);
    } finally {
      rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
