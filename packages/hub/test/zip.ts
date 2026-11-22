import { inflateRawSync } from 'node:zlib';

/** The files of a zip by name, read through its central directory and checked against their local headers. */
export function unzip(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  const files = new Map<string, Buffer>();
  let at = archive.readUInt32LE(end + 16);

  for (let n = 0; n < count; n++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) {
      throw new Error(`no central directory entry at ${at}`);
    }

    const method = archive.readUInt16LE(at + 10);
    const packed = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const offset = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
    const body = method === 8 ? inflateRawSync(archive.subarray(start, start + packed)) : archive.subarray(start, start + packed);

    if (archive.readUInt32LE(offset) !== 0x04034b50 || body.length !== size) {
      throw new Error(`a bad entry for ${name}`);
    }

    files.set(name, body);
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }

  return files;
}
