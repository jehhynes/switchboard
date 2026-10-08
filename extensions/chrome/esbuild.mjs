import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// dist/ is the unpacked extension that Chrome loads.
mkdirSync('dist', { recursive: true });

for (const file of ['manifest.json', 'content.css']) {
  copyFileSync(`src/${file}`, `dist/${file}`);
}

copyFileSync(createRequire(import.meta.url).resolve('@vscode/codicons/dist/codicon.ttf'), 'dist/codicon.ttf');

await build({
  entryPoints: { content: 'src/main.ts', background: 'src/background.ts' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  outdir: 'dist',
  logLevel: 'info',
});
