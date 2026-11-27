// Builds the web page (architecture.md § Web page) and writes dist/index.js, which carries each of its files as a string, so the hub bundle
// serves the page that matches it without files of its own on disk.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import esbuild from 'esbuild';
import { extraIconCss, ICON_FONT, ICONS_DIR } from '@switchboard/core/icons';

const require = createRequire(import.meta.url);

/**
 * The diff viewer (architecture.md § Web page): ES modules with code splitting in dist/diff, so each grammar and theme is a chunk of its own
 * that loads only when a file needs it, with `shiki/langs` swapped for the grammars in src/diff/langs.ts, and manifest.json naming the build
 * by a hash of every file's name and content and listing the files, which the extension installs in `<home>/web/diff/<build>/` and the hub
 * serves only by those names. Answers the build.
 */
async function buildDiff() {
  rmSync('dist/diff', { recursive: true, force: true });
  await esbuild.build({
    entryPoints: { diff: 'src/diff/viewer.ts', worker: 'src/diff/worker.ts' },
    bundle: true,
    format: 'esm',
    splitting: true,
    platform: 'browser',
    target: 'es2022',
    minify: true,
    outdir: 'dist/diff',
    chunkNames: 'chunks/[name]-[hash]',
    loader: { '.json': 'json' },
    logLevel: 'warning',
    plugins: [{ name: 'diff-langs', setup: (build) => build.onResolve({ filter: /^shiki\/langs$/ }, () => ({ path: join(process.cwd(), 'src', 'diff', 'langs.ts') })) }],
  });

  const files = readdirSync('dist/diff', { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice('dist/diff/'.length).replaceAll('\\', '/'))
    .sort();
  const hash = createHash('sha256');

  for (const file of files) {
    hash.update(file).update('\0').update(readFileSync(join('dist/diff', file))).update('\0');
  }

  const build = hash.digest('hex').slice(0, 16);

  writeFileSync('dist/diff/manifest.json', JSON.stringify({ build, files }, null, 2));
  return build;
}

const diffBuild = await buildDiff();
const bundle = async (entry, define = {}) =>
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
      define,
    })
  ).outputFiles[0].text;
// The phone's audio worklet (architecture.md § Remote access, Voice on a phone), named by a hash of its content, so the browser keeps it for good
// and a Mic on tap that opens the phone's audio loads it from the browser's cache, not over the network.
const worklet = await bundle('src/voiceWorklet.ts');
const workletName = `voice-worklet-${createHash('sha256').update(worklet).digest('hex').slice(0, 16)}.js`;
const codicons = dirname(require.resolve('@vscode/codicons/dist/codicon.css'));
const theme = readFileSync('src/theme.css', 'utf8');
// The installed page's window and splash take the colour of the page's bars and header, the side bar's: 2026 Dark's, the default, and in
// the pages' theme-color also 2026 Light's while the operating system is set to light. A manifest has no light variant.
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
const hashOf = (body) => createHash('sha256').update(body).digest('hex').slice(0, 16);
/** A shell file's name with its content's hash, as `page-<hash>.js`: the hub serves it gzipped for good under that name (architecture.md § Web page). */
const hashedName = (name, body) => name.replace(/(\.[a-z]+)$/, `-${hashOf(body)}$1`);
const ttf = readFileSync(join(codicons, 'codicon.ttf'));
// Switchboard's extra icons (architecture.md § Web page, Extra icons): their font is a second face of the codicon family, added to codicon.css.
const extraTtf = readFileSync(join(ICONS_DIR, ICON_FONT));
const shell = { 'codicon.ttf': hashedName('codicon.ttf', ttf), [ICON_FONT]: hashedName(ICON_FONT, extraTtf) };
const codiconCss = readFileSync(join(codicons, 'codicon.css'), 'utf8').replace(/url\("\.\/codicon\.ttf(\?[^"]*)?"\)/, `url("./${shell['codicon.ttf']}")`) + extraIconCss(`./${shell[ICON_FONT]}`);
// The page imports the diff viewer from the build it was built with (`__DIFF_BUILD__`), and the audio worklet by its name (`__VOICE_WORKLET__`).
const pageJs = await bundle('src/entry.ts', { __DIFF_BUILD__: JSON.stringify(diffBuild), __VOICE_WORKLET__: JSON.stringify(workletName) });
// The bubbles' and the composer's styles the Conversation view shares come first, so the page's own rules can build on them.
const pageCss = ['@switchboard/conversation/bubbles.css', '@switchboard/conversation/composer.css', '@switchboard/conversation/picker.css', '@switchboard/conversation/menu.css', '@switchboard/conversation/questionCard.css'].map((name) => readFileSync(require.resolve(name), 'utf8')).join('') + readFileSync('src/page.css', 'utf8') + readFileSync('src/settings.css', 'utf8') + readFileSync('src/changes.css', 'utf8');

shell['codicon.css'] = hashedName('codicon.css', codiconCss);
shell['theme.css'] = hashedName('theme.css', theme);
shell['page.css'] = hashedName('page.css', pageCss);
shell['page.js'] = hashedName('page.js', pageJs);

// The boot script, inline in index.html so it runs before any file loads, which the page's CSP allows by its hash: it shows Can't reach
// Switchboard when page.js or a stylesheet fails to load, or the page has not started within 8 s.
const boot = readFileSync('src/boot.js', 'utf8').trim();
const indexHtml = Object.entries(shell).reduce((page, [name, hashed]) => page.replaceAll(`{{${name}}}`, hashed), html('src/index.html').replace('{{boot}}', () => boot));
// What the service worker keeps for each build (src/sw.ts): the page and its shell's files, the icons and the manifest.
const precache = ['/page/', ...Object.values(shell).map((name) => `/page/${name}`), '/page/manifest.webmanifest', '/page/icon-192.png', '/page/icon-512.png', '/page/icon-maskable-512.png', '/page/apple-touch-icon.png'];
const shellVersion = hashOf(indexHtml + JSON.stringify(shell));
/** A shell file under its plain name, and the hashed name the page loads it by. */
const shellText = (name, mime, body) => ({ ...text(mime, body), hashed: shell[name] });
const assets = {
  'index.html': text('text/html; charset=utf-8', indexHtml),
  'page.js': shellText('page.js', 'text/javascript; charset=utf-8', pageJs),
  [workletName]: { ...text('text/javascript; charset=utf-8', worklet), immutable: true },
  // The console's script and xterm.js's styles, loaded only when a console first shows.
  'console.js': text('text/javascript; charset=utf-8', await bundle('src/consoleEntry.ts')),
  'xterm.css': text('text/css; charset=utf-8', readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8')),
  'page.css': shellText('page.css', 'text/css; charset=utf-8', pageCss),
  'theme.css': shellText('theme.css', 'text/css; charset=utf-8', theme),
  'codicon.css': shellText('codicon.css', 'text/css; charset=utf-8', codiconCss),
  'codicon.ttf': { ...binary('font/ttf', join(codicons, 'codicon.ttf')), hashed: shell['codicon.ttf'] },
  [ICON_FONT]: { ...binary('font/ttf', join(ICONS_DIR, ICON_FONT)), hashed: shell[ICON_FONT] },
  // VS Code's Seti file icons (src/seti/LICENSE.txt), which the page loads the first time it draws a file's icon (src/fileIcons.tsx).
  'file-icons.json': text('application/json', JSON.stringify({ ...JSON.parse(readFileSync('src/seti/file-icons.json', 'utf8')), license: readFileSync('src/seti/LICENSE.txt', 'utf8') })),
  'seti.woff': binary('font/woff', 'src/seti/seti.woff'),
  'manifest.webmanifest': text('application/manifest+json', JSON.stringify(manifest)),
  'sw.js': text('text/javascript; charset=utf-8', await bundle('src/swEntry.ts', { __SHELL__: JSON.stringify(precache), __SHELL_VERSION__: JSON.stringify(shellVersion) })),
  'icon-192.png': binary('image/png', 'src/icon-192.png'),
  'icon-512.png': binary('image/png', 'src/icon-512.png'),
  'icon-maskable-512.png': binary('image/png', 'src/icon-maskable-512.png'),
  // iOS takes the Home Screen icon from apple-touch-icon, not the manifest, and fills a transparent one with black, so it is the opaque
  // maskable icon at 180 px, the iPhone's size.
  'apple-touch-icon.png': binary('image/png', 'src/apple-touch-icon.png'),
};

mkdirSync('dist', { recursive: true });
writeFileSync(
  'dist/index.js',
  `/** The web page's files, by their name under /page/. Written by build.mjs. */\nexport const PAGE_ASSETS = ${JSON.stringify(assets)};\n/** The CSP sources of the page's inline scripts. */\nexport const PAGE_SCRIPT_HASHES = ${JSON.stringify([`'sha256-${createHash('sha256').update(boot).digest('base64')}'`])};\n`,
);
writeFileSync(
  'dist/index.d.ts',
  "/** The web page's files, by their name under /page/; a binary file's body is base64, an immutable one never changes under its name, and a shell file is also served for good under its `hashed` name. */\nexport declare const PAGE_ASSETS: Record<string, { mime: string; body: string; base64: boolean; immutable?: boolean; hashed?: string }>;\n/** The CSP sources of the page's inline scripts. */\nexport declare const PAGE_SCRIPT_HASHES: string[];\n",
);
