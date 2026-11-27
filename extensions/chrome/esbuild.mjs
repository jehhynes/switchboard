import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { ICON_FONT, ICON_LICENSE, ICONS_DIR } from '@switchboard/core/icons';

// dist/ is the unpacked extension that Chrome loads.
mkdirSync('dist', { recursive: true });

for (const file of ['manifest.json', 'content.css', 'iframeHost.html']) {
  copyFileSync(`src/${file}`, `dist/${file}`);
}

copyFileSync(createRequire(import.meta.url).resolve('@vscode/codicons/dist/codicon.ttf'), 'dist/codicon.ttf');
// Switchboard's extra icons, a second face of the codicon family in content.css, with their licence.
copyFileSync(join(ICONS_DIR, ICON_FONT), `dist/${ICON_FONT}`);
copyFileSync(join(ICONS_DIR, ICON_LICENSE), 'dist/switchboard-icons-LICENSE.txt');

copyFileSync('assets/switchboard.ico', 'dist/switchboard.ico');

for (const size of [16, 32, 48, 128, 256]) {
  copyFileSync(`assets/icon-${size}.png`, `dist/icon-${size}.png`);
}

await build({
  entryPoints: { content: 'src/main.ts', layoutStart: 'src/layoutStart.ts', background: 'src/background.ts', iframeHost: 'src/iframeHost.ts' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  define: { FIREFOX: 'false' },
  outdir: 'dist',
  logLevel: 'info',
});
