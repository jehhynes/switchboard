import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// dist/ is the unpacked extension that Chrome loads.
mkdirSync('dist', { recursive: true });

for (const file of ['manifest.json', 'content.css']) {
  copyFileSync(`src/${file}`, `dist/${file}`);
}

copyFileSync(createRequire(import.meta.url).resolve('@vscode/codicons/dist/codicon.ttf'), 'dist/codicon.ttf');

for (const size of [16, 32, 48, 128]) {
  copyFileSync(`assets/icon-${size}.png`, `dist/icon-${size}.png`);
}

await build({
  entryPoints: { content: 'src/main.ts', background: 'src/background.ts' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  define: { FIREFOX: 'false' },
  outdir: 'dist',
  logLevel: 'info',
});
