// npm run build in apps/hub, after tsc: writes the carried builds to dist/install, from which npm run install-local runs hub.js install.
const fs = require('node:fs');
const path = require('node:path');
const { buildCarried } = require('./carried.cjs');
const { version } = require('./package.json');

const outdir = path.join(__dirname, 'dist', 'install');

// A file left from an earlier build would be installed with the new one.
fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });
// The builds are CommonJS, and apps/hub's package.json makes .js files modules, so npm run install-local could not run hub.js here without this.
fs.writeFileSync(path.join(outdir, 'package.json'), '{ "type": "commonjs" }\n');
// With --watch (npm run watch), keeps rebuilding the hub, holder and voice builds.
buildCarried(outdir, { version, watch: process.argv.includes('--watch') }).catch((error) => {
  console.error(error);
  process.exit(1);
});
