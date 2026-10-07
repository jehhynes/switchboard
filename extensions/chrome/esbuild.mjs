import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

// dist/ is the unpacked extension that Chrome loads.
mkdirSync('dist', { recursive: true });

for (const file of ['manifest.json', 'content.css']) {
  copyFileSync(`src/${file}`, `dist/${file}`);
}

await build({
  entryPoints: { content: 'src/main.ts', background: 'src/background.ts' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  outdir: 'dist',
  logLevel: 'info',
});
