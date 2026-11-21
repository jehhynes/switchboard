// Builds the web page (architecture.md § Web page) and writes dist/index.js, which carries each of its files as a string, so the hub bundle
// serves the page that matches it without files of its own on disk.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const bundle = async (entry) =>
  (
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      write: false,
      logLevel: 'info',
      // The page's .tsx parts are Preact components (architecture.md § Web page).
      jsx: 'automatic',
      jsxImportSource: 'preact',
    })
  ).outputFiles[0].text;
const codicons = dirname(require.resolve('@vscode/codicons/dist/codicon.css'));
const theme = readFileSync('src/theme.css', 'utf8');
// The installed page's window and splash take the colour of the page's side bar and header: Dark Modern's, the default, and in the pages'
// theme-color also Light Modern's while the operating system is set to light. A manifest has no light variant.
const sideBar = (css) => /--vscode-sideBar-background:\s*(#[0-9a-fA-F]{6})/.exec(css)[1];
const lightStart = theme.indexOf('@media (prefers-color-scheme: light)');
const themeColor = sideBar(theme.slice(0, lightStart));
const themeColorLight = sideBar(theme.slice(lightStart));
const html = (file) => readFileSync(file, 'utf8').replaceAll('{{themeColorLight}}', themeColorLight).replaceAll('{{themeColor}}', themeColor);
const text = (mime, body) => ({ mime, body, base64: false });
const binary = (mime, file) => ({ mime, body: readFileSync(file).toString('base64'), base64: true });
const manifest = {
  id: '/page/',
  name: 'Switchboard',
  short_name: 'Switchboard',
  description: "Switchboard's work items and conversations.",
  start_url: '/page/',
  scope: '/page/',
  display: 'standalone',
  background_color: themeColor,
  theme_color: themeColor,
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
const assets = {
  'index.html': text('text/html; charset=utf-8', html('src/index.html')),
  'page.js': text('text/javascript; charset=utf-8', await bundle('src/entry.ts')),
  // The console's script and xterm.js's styles, loaded only when a console first shows.
  'console.js': text('text/javascript; charset=utf-8', await bundle('src/consoleEntry.ts')),
  'xterm.css': text('text/css; charset=utf-8', readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8')),
  // The bubbles' and the composer's styles the Conversation view shares come first, so the page's own rules can build on them.
  'page.css': text('text/css; charset=utf-8', ['@switchboard/conversation/bubbles.css', '@switchboard/conversation/composer.css', '@switchboard/conversation/picker.css', '@switchboard/conversation/menu.css'].map((name) => readFileSync(require.resolve(name), 'utf8')).join('') + readFileSync('src/page.css', 'utf8') + readFileSync('src/settings.css', 'utf8') + readFileSync('src/changes.css', 'utf8')),
  'theme.css': text('text/css; charset=utf-8', theme),
  'codicon.css': text('text/css; charset=utf-8', readFileSync(join(codicons, 'codicon.css'), 'utf8')),
  'codicon.ttf': binary('font/ttf', join(codicons, 'codicon.ttf')),
  // VS Code's Seti file icons (src/seti/LICENSE.txt), which the page loads the first time it draws a file's icon (src/fileIcons.tsx).
  'file-icons.json': text('application/json', JSON.stringify({ ...JSON.parse(readFileSync('src/seti/file-icons.json', 'utf8')), license: readFileSync('src/seti/LICENSE.txt', 'utf8') })),
  'seti.woff': binary('font/woff', 'src/seti/seti.woff'),
  'manifest.webmanifest': text('application/manifest+json', JSON.stringify(manifest)),
  'sw.js': text('text/javascript; charset=utf-8', await bundle('src/swEntry.ts')),
  'offline.html': text('text/html; charset=utf-8', html('src/offline.html')),
  'offline.js': text('text/javascript; charset=utf-8', await bundle('src/offlineEntry.ts')),
  'icon-192.png': binary('image/png', 'src/icon-192.png'),
  'icon-512.png': binary('image/png', 'src/icon-512.png'),
  'icon-maskable-512.png': binary('image/png', 'src/icon-maskable-512.png'),
};

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.js', `/** The web page's files, by their name under /page/. Written by build.mjs. */\nexport const PAGE_ASSETS = ${JSON.stringify(assets)};\n`);
writeFileSync(
  'dist/index.d.ts',
  '/** The web page\'s files, by their name under /page/; a binary file\'s body is base64. */\nexport declare const PAGE_ASSETS: Record<string, { mime: string; body: string; base64: boolean }>;\n',
);
