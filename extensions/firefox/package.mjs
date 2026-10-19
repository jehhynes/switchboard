import { createWriteStream, readdirSync, renameSync, rmSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import yazl from 'yazl';

// An .xpi is a zip of the unpacked extension with the manifest at its root. Packaging does not build.
const target = 'switchboard-firefox.xpi';
const partial = `${target}.partial`;
const zip = new yazl.ZipFile();

for (const file of readdirSync('dist')) {
  zip.addFile(`dist/${file}`, file);
}

zip.end();

try {
  await finished(zip.outputStream.pipe(createWriteStream(partial)));
  renameSync(partial, target);
} catch (error) {
  rmSync(partial, { force: true });
  throw error;
}
