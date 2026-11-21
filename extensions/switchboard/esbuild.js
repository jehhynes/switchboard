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
  plugins: [{ name: 'holder-files', setup: (build) => build.onEnd((result) => { if (result.errors.length === 0) { copyNodePty(); writeManifest('dist/holder'); } }) }],
};

// The voice process runs on the operator's Node.js too, since decibri (capture and playback) and sherpa-onnx (recognition) are native modules
// (architecture.md § Voice, § Dictation); turn.js is its turn model's process, which loads onnxruntime apart from sherpa-onnx's own runtime, and
// gpucheck.js checks sherpa-onnx's CUDA build in a child process before the voice process loads it.
// The native modules stay outside the bundle: each loads its binary from its own or its platform package.
const voice = {
  entryPoints: { voice: '../../packages/voice/src/main.ts', turn: '../../packages/voice/src/turnWorker.ts', gpucheck: '../../packages/voice/src/gpuCheck.ts' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['decibri', 'sherpa-onnx-node', 'onnxruntime-node'],
  outdir: 'dist/voice',
  logLevel: 'info',
  plugins: [
    {
      name: 'voice-files',
      setup: (build) =>
        build.onEnd((result) => {
          if (result.errors.length === 0) {
            copyDecibri();
            copyRecognition();
            fs.copyFileSync('../../packages/voice/assets/micuse.ps1', 'dist/voice/micuse.ps1');
            fs.copyFileSync('../../packages/voice/assets/commcapture.ps1', 'dist/voice/commcapture.ps1');
            fs.copyFileSync('../../packages/voice/assets/lockwatch.ps1', 'dist/voice/lockwatch.ps1');
            writeManifest('dist/voice');
          }
        }),
    },
  ],
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
  // The bubbles' and the composer's styles the web page shares come first, so the view's own rules can build on them.
  const shared = ['@switchboard/conversation/bubbles.css', '@switchboard/conversation/composer.css', '@switchboard/conversation/picker.css', '@switchboard/conversation/menu.css'].map((name) => fs.readFileSync(require.resolve(name), 'utf8')).join('');
  fs.writeFileSync('dist/conversation.css', shared + fs.readFileSync('src/webview/conversation.css', 'utf8'));
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

/**
 * Copies what decibri loads at run time for this platform: its package.json, its scripts without the browser build, the models its capture
 * uses, and its platform package with the binary and the libraries beside it.
 */
function copyDecibri() {
  let source;

  try {
    // Its exports hide package.json; its main script is in src/.
    source = path.dirname(path.dirname(require.resolve('decibri')));
  } catch {
    // An optional dependency npm could not install here; playback then fails with the voice process's load error.
    console.warn('decibri is not installed, so the voice process cannot play speech.');
    return;
  }

  const target = 'dist/voice/node_modules/decibri';
  const wanted = (file) => file === 'package.json' || file === 'index.js' || (file.startsWith('src/') && !file.startsWith('src/browser/') && file.endsWith('.js')) || file.startsWith('models/');

  for (const file of filesUnder(source).filter(wanted)) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }

  const abi = process.platform === 'win32' ? 'msvc' : process.platform === 'linux' ? 'gnu' : null;
  const name = `@decibri/decibri-${process.platform}-${process.arch}${abi === null ? '' : `-${abi}`}`;
  let binary;

  try {
    binary = path.dirname(require.resolve(name, { paths: [source] }));
  } catch {
    console.warn(`${name} is not installed, so the voice process cannot play speech.`);
    return;
  }

  for (const file of filesUnder(binary).filter((one) => !one.endsWith('.md'))) {
    fs.mkdirSync(path.dirname(path.join('dist/voice/node_modules', name, file)), { recursive: true });
    fs.copyFileSync(path.join(binary, file), path.join('dist/voice/node_modules', name, file));
  }
}

/** Copies the files of an installed package that `wanted` keeps into the voice build's node_modules; false when it is not installed. */
function copyPackage(name, wanted, from) {
  // Looked up by folder, since a package's exports can hide its package.json.
  const source = (require('node:module').createRequire(from === undefined ? __filename : path.join(from, 'x.js')).resolve.paths(name) ?? [])
    .map((dir) => path.join(dir, name))
    .find((dir) => fs.existsSync(path.join(dir, 'package.json')));

  if (source === undefined) {
    return false;
  }

  for (const file of filesUnder(source).filter(wanted)) {
    fs.mkdirSync(path.dirname(path.join('dist/voice/node_modules', name, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join('dist/voice/node_modules', name, file));
  }

  return true;
}

/**
 * Copies what recognition and the turn model load at run time for this platform: sherpa-onnx-node's scripts and its platform package beside it
 * (`sherpa-onnx-win-x64` on Windows), and onnxruntime-node's scripts and this platform's binaries with onnxruntime-common.
 */
function copyRecognition() {
  const script = (file) => file === 'package.json' || (file.endsWith('.js') && !file.includes('/'));

  if (!copyPackage('sherpa-onnx-node', script)) {
    console.warn('sherpa-onnx-node is not installed, so the voice process cannot recognise speech.');
  } else if (!copyPackage(`sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`, (file) => !file.endsWith('.md'), path.join(path.dirname(require.resolve('sherpa-onnx-node'))))) {
    console.warn('sherpa-onnx has no package for this platform, so the voice process cannot recognise speech.');
  }

  // The turn model's tokenizer, which the turn process loads by name.
  if (!copyPackage('@huggingface/tokenizers', (file) => !file.endsWith('.md') && !file.startsWith('types/'))) {
    console.warn('@huggingface/tokenizers is not installed, so turn detection waits out the pause alone.');
  }

  const binaries = `bin/napi-v6/${process.platform}/${process.arch}/`;

  if (!copyPackage('onnxruntime-node', (file) => file === 'package.json' || (file.startsWith('dist/') && file.endsWith('.js')) || file.startsWith(binaries))) {
    console.warn('onnxruntime-node is not installed, so turn detection waits out the pause alone.');
  } else {
    copyPackage('onnxruntime-common', (file) => file === 'package.json' || (file.startsWith('dist/cjs/') && (file.endsWith('.js') || file.endsWith('/package.json'))), path.dirname(path.dirname(require.resolve('onnxruntime-node'))));
  }
}

/** Names a holder or voice build by a hash of every file's path and content, so any change installs a new folder (architecture.md § Terminal holder). */
function writeManifest(dir) {
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
    for (const config of [options, webview, holder, voice]) {
      await (await esbuild.context(config)).watch();
    }

    return;
  }

  await Promise.all([esbuild.build(options), esbuild.build(webview), esbuild.build(holder), esbuild.build(voice)]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
