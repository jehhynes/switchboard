// Builds the web page (architecture.md § Web page) and writes dist/index.js, which carries each of its files as a string, so the hub bundle
// serves the page that matches it without files of its own on disk.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const built = await esbuild.build({ entryPoints: ['src/entry.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true, write: false, logLevel: 'info' });
const codicons = dirname(require.resolve('@vscode/codicons/dist/codicon.css'));
const assets = {
  'index.html': { mime: 'text/html; charset=utf-8', body: readFileSync('src/index.html', 'utf8'), base64: false },
  'page.js': { mime: 'text/javascript; charset=utf-8', body: built.outputFiles[0].text, base64: false },
  'page.css': { mime: 'text/css; charset=utf-8', body: readFileSync('src/page.css', 'utf8'), base64: false },
  'theme.css': { mime: 'text/css; charset=utf-8', body: readFileSync('src/theme.css', 'utf8'), base64: false },
  'codicon.css': { mime: 'text/css; charset=utf-8', body: readFileSync(join(codicons, 'codicon.css'), 'utf8'), base64: false },
  'codicon.ttf': { mime: 'font/ttf', body: readFileSync(join(codicons, 'codicon.ttf')).toString('base64'), base64: true },
};

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.js', `/** The web page's files, by their name under /page/. Written by build.mjs. */\nexport const PAGE_ASSETS = ${JSON.stringify(assets)};\n`);
writeFileSync(
  'dist/index.d.ts',
  '/** The web page\'s files, by their name under /page/; a binary file\'s body is base64. */\nexport declare const PAGE_ASSETS: Record<string, { mime: string; body: string; base64: boolean }>;\n',
);
