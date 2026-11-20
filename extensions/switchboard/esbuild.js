const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { version } = require('./package.json');

// Bundle workspace packages, because vsce excludes files outside this directory.
// The hub bundle ships inside the extension and is copied to the Switchboard home at activation.
const options = {
  entryPoints: [
    { in: 'src/extension.ts', out: 'extension' },
    { in: '../../apps/hub/src/main.ts', out: 'hub' },
  ],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['vscode'],
  define: { __SWITCHBOARD_VERSION__: JSON.stringify(version) },
  outdir: 'dist',
  sourcemap: true,
  logLevel: 'info',
};

// The terminal holder runs on the operator's Node.js, not VS Code's, because node-pty is a native module (mechanics M76).
// node-pty stays outside the bundle: it loads its binaries, a worker script and a console-list agent from its own folder.
const holder = {
  entryPoints: { holder: '../../packages/holder/src/main.ts' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['node-pty'],
  outdir: 'dist/holder',
  logLevel: 'info',
  // After each build, watch mode included, the folder gets node-pty and a new manifest, so it can be installed.
  plugins: [{ name: 'holder-files', setup: (build) => build.onEnd((result) => { if (result.errors.length === 0) { copyNodePty(); writeHolderManifest(); } }) }],
};

// The History, pane and conversation scripts run in webviews, and the Mermaid script in the Markdown preview: browsers.
const webview = {
  entryPoints: { history: 'src/webview/historyMain.ts', pane: 'src/webview/paneMain.ts', conversation: 'src/webview/conversationMain.ts', mermaidPreview: 'src/webview/mermaidPreviewMain.ts' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outdir: 'dist',
  sourcemap: true,
  logLevel: 'info',
};

function copyAssets() {
  const codicons = path.dirname(require.resolve('@vscode/codicons/dist/codicon.css'));

  fs.mkdirSync('dist/codicons', { recursive: true });

  for (const file of ['codicon.css', 'codicon.ttf']) {
    fs.copyFileSync(path.join(codicons, file), path.join('dist/codicons', file));
  }

  fs.copyFileSync('src/webview/history.css', 'dist/history.css');
  fs.copyFileSync('src/webview/pane.css', 'dist/pane.css');
  fs.copyFileSync('src/webview/conversation.css', 'dist/conversation.css');
  fs.copyFileSync('src/webview/mermaidPreview.css', 'dist/mermaidPreview.css');

  // Mermaid's self-contained build, which sets `globalThis.mermaid`, so the Markdown preview draws diagrams offline.
  fs.mkdirSync('dist/mermaid', { recursive: true });
  fs.copyFileSync(path.join(path.dirname(require.resolve('mermaid/package.json')), 'dist', 'mermaid.min.js'), 'dist/mermaid/mermaid.min.js');
}

/** Every file under a folder, relative with forward slashes, sorted. */
function filesUnder(root, dir = root) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(root, path.join(dir, entry.name)) : [path.relative(root, path.join(dir, entry.name)).replaceAll('\\', '/')]))
    .sort();
}

/**
 * Copies the files node-pty loads at run time for this platform: its package.json, its lib scripts without tests, and its binaries without
 * debug symbols, from the prebuilds or, where npm built it from source, build/Release.
 */
function copyNodePty() {
  let source;

  try {
    source = path.dirname(require.resolve('node-pty/package.json'));
  } catch {
    // An optional dependency npm could not build here; Code Mode starts then fail with the holder's load error.
    console.warn('node-pty is not installed, so the terminal holder has no pseudo-terminals.');
    return;
  }

  const target = 'dist/holder/node_modules/node-pty';
  const prebuilds = `prebuilds/${process.platform}-${process.arch}`;
  const wanted = (file) =>
    file === 'package.json' ||
    (file.startsWith('lib/') && file.endsWith('.js') && !file.endsWith('.test.js')) ||
    ((file.startsWith(`${prebuilds}/`) || file.startsWith('build/Release/')) && !/\.(pdb|lib|exp|iobj|ipdb|obj|tlog|lastbuildstate|recipe)$/.test(file) && !file.includes('/obj/'));
  const files = filesUnder(source).filter(wanted);

  if (!files.some((file) => file.endsWith('.node'))) {
    console.warn(`node-pty has no binary for ${process.platform}-${process.arch}, so the terminal holder has no pseudo-terminals.`);
  }

  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
}

/** Names the holder build by a hash of every file's path and content, so any change installs a new folder (architecture.md § Terminal holder). */
function writeHolderManifest() {
  const dir = 'dist/holder';
  const files = filesUnder(dir).filter((file) => file !== 'manifest.json');
  const hash = crypto.createHash('sha256');

  for (const file of files) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(dir, file))).update('\0');
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ build: hash.digest('hex').slice(0, 16), files }, null, 2));
}

async function main() {
  // A file left from an earlier build, such as a removed webview, would ship in the package.
  fs.rmSync('dist', { recursive: true, force: true });
  copyAssets();

  if (process.argv.includes('--watch')) {
    for (const config of [options, webview, holder]) {
      await (await esbuild.context(config)).watch();
    }

    return;
  }

  await Promise.all([esbuild.build(options), esbuild.build(webview), esbuild.build(holder)]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
