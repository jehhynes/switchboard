import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { firefoxCss, firefoxManifest } from './src/firefox.mjs';

// dist/ is the unpacked extension that Firefox loads, built from the Chrome extension's source.
const chrome = '../chrome';

mkdirSync('dist', { recursive: true });
writeFileSync('dist/manifest.json', `${JSON.stringify(firefoxManifest(JSON.parse(readFileSync(`${chrome}/src/manifest.json`, 'utf8'))), null, 2)}\n`);
writeFileSync('dist/content.css', firefoxCss(readFileSync(`${chrome}/src/content.css`, 'utf8')));
copyFileSync(createRequire(import.meta.url).resolve('@vscode/codicons/dist/codicon.ttf'), 'dist/codicon.ttf');

for (const size of [16, 32, 48, 128]) {
  copyFileSync(`${chrome}/assets/icon-${size}.png`, `dist/icon-${size}.png`);
}

await build({
  entryPoints: { content: `${chrome}/src/main.ts`, background: `${chrome}/src/background.ts` },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'firefox140',
  // Firefox's `browser` namespace returns promises for every call; the source is written against `chrome`.
  define: { chrome: 'browser', FIREFOX: 'true' },
  outdir: 'dist',
  logLevel: 'info',
});
