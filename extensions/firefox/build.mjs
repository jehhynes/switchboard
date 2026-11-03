import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNumber, firefoxCss, firefoxManifest } from './src/firefox.mjs';

// dist/ is the unpacked extension that Firefox loads, built from the Chrome extension's source.
const chrome = '../chrome';

/** The folders and names of the Chrome files that are copied rather than bundled. */
export const copiedSources = { [`${chrome}/src`]: ['manifest.json', 'content.css'], [`${chrome}/assets`]: [16, 32, 48, 128].map((size) => `icon-${size}.png`) };

/** web-ext's command line script, which runs with Node itself, so no shell splits its arguments. */
export const webExt = join(dirname(fileURLToPath(import.meta.resolve('web-ext'))), 'bin/web-ext.js');

/** Writes the manifest, CSS, font and icons to dist/, with a new build number in the version. */
export function writeCopied() {
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/manifest.json', `${JSON.stringify(firefoxManifest(JSON.parse(readFileSync(`${chrome}/src/manifest.json`, 'utf8')), buildNumber(Date.now())), null, 2)}\n`);
  writeFileSync('dist/content.css', firefoxCss(readFileSync(`${chrome}/src/content.css`, 'utf8')));
  copyFileSync(createRequire(import.meta.url).resolve('@vscode/codicons/dist/codicon.ttf'), 'dist/codicon.ttf');

  for (const size of [16, 32, 48, 128]) {
    copyFileSync(`${chrome}/assets/icon-${size}.png`, `dist/icon-${size}.png`);
  }
}

/** @type {import('esbuild').BuildOptions} */
export const bundle = {
  entryPoints: { content: `${chrome}/src/main.ts`, background: `${chrome}/src/background.ts` },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'firefox140',
  // Firefox's `browser` namespace returns promises for every call; the source is written against `chrome`.
  define: { chrome: 'browser', FIREFOX: 'true' },
  outdir: 'dist',
  logLevel: 'info',
};
