// The builds hub.js install copies into the Switchboard home (architecture.md § Hub lifecycle): the hub bundle, the terminal holder and the
// voice process with their native modules, Mermaid, the web page's diff viewer and the browser extension. apps/hub/build.cjs writes them to
// apps/hub/dist/install for npm run install-local, and the VS Code extension's esbuild.js writes the same builds into its dist.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..', '..');

/** Every file under a folder, relative with forward slashes, sorted. */
function filesUnder(root, dir = root) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(root, path.join(dir, entry.name)) : [path.relative(root, path.join(dir, entry.name)).replaceAll('\\', '/')]))
    .sort();
}

/** Copies the files of a package folder that `wanted` keeps into a target folder. */
function copyFiles(source, target, wanted) {
  for (const file of filesUnder(source).filter(wanted)) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
}

/**
 * Copies the files node-pty loads at run time for this platform: its package.json, its lib scripts without tests, and its binaries without
 * debug symbols, from the prebuilds or, where npm built it from source, build/Release.
 */
function copyNodePty(holderDir) {
  let source;

  try {
    source = path.dirname(require.resolve('node-pty/package.json'));
  } catch {
    // An optional dependency npm could not build here; Code Mode starts then fail with the holder's load error.
    console.warn('node-pty is not installed, so the terminal holder has no pseudo-terminals.');
    return;
  }

  const prebuilds = `prebuilds/${process.platform}-${process.arch}`;
  const wanted = (file) =>
    file === 'package.json' ||
    (file.startsWith('lib/') && file.endsWith('.js') && !file.endsWith('.test.js')) ||
    ((file.startsWith(`${prebuilds}/`) || file.startsWith('build/Release/')) && !/\.(pdb|lib|exp|iobj|ipdb|obj|tlog|lastbuildstate|recipe)$/.test(file) && !file.includes('/obj/'));

  if (!filesUnder(source).filter(wanted).some((file) => file.endsWith('.node'))) {
    console.warn(`node-pty has no binary for ${process.platform}-${process.arch}, so the terminal holder has no pseudo-terminals.`);
  }

  copyFiles(source, path.join(holderDir, 'node_modules', 'node-pty'), wanted);
}

/**
 * Copies what decibri loads at run time for this platform: its package.json, its scripts without the browser build, the models its capture
 * uses, and its platform package with the binary and the libraries beside it.
 */
function copyDecibri(voiceDir) {
  let source;

  try {
    // Its exports hide package.json; its main script is in src/.
    source = path.dirname(path.dirname(require.resolve('decibri')));
  } catch {
    // An optional dependency npm could not install here; playback then fails with the voice process's load error.
    console.warn('decibri is not installed, so the voice process cannot play speech.');
    return;
  }

  copyFiles(source, path.join(voiceDir, 'node_modules', 'decibri'), (file) => file === 'package.json' || file === 'index.js' || (file.startsWith('src/') && !file.startsWith('src/browser/') && file.endsWith('.js')) || file.startsWith('models/'));

  const abi = process.platform === 'win32' ? 'msvc' : process.platform === 'linux' ? 'gnu' : null;
  const name = `@decibri/decibri-${process.platform}-${process.arch}${abi === null ? '' : `-${abi}`}`;
  let binary;

  try {
    binary = path.dirname(require.resolve(name, { paths: [source] }));
  } catch {
    console.warn(`${name} is not installed, so the voice process cannot play speech.`);
    return;
  }

  copyFiles(binary, path.join(voiceDir, 'node_modules', name), (one) => !one.endsWith('.md'));
}

/** Copies the files of an installed package that `wanted` keeps into the voice build's node_modules; false when it is not installed. */
function copyPackage(voiceDir, name, wanted, from) {
  // Looked up by folder, since a package's exports can hide its package.json.
  const source = (require('node:module').createRequire(from === undefined ? __filename : path.join(from, 'x.js')).resolve.paths(name) ?? [])
    .map((dir) => path.join(dir, name))
    .find((dir) => fs.existsSync(path.join(dir, 'package.json')));

  if (source === undefined) {
    return false;
  }

  copyFiles(source, path.join(voiceDir, 'node_modules', name), wanted);

  return true;
}

/**
 * Copies what recognition and the turn model load at run time for this platform: sherpa-onnx-node's scripts and its platform package beside it
 * (`sherpa-onnx-win-x64` on Windows), and onnxruntime-node's scripts and this platform's binaries with onnxruntime-common.
 */
function copyRecognition(voiceDir) {
  const script = (file) => file === 'package.json' || (file.endsWith('.js') && !file.includes('/'));

  if (!copyPackage(voiceDir, 'sherpa-onnx-node', script)) {
    console.warn('sherpa-onnx-node is not installed, so the voice process cannot recognise speech.');
  } else if (!copyPackage(voiceDir, `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`, (file) => !file.endsWith('.md'), path.join(path.dirname(require.resolve('sherpa-onnx-node'))))) {
    console.warn('sherpa-onnx has no package for this platform, so the voice process cannot recognise speech.');
  }

  // The turn model's tokenizer, which the turn process loads by name.
  if (!copyPackage(voiceDir, '@huggingface/tokenizers', (file) => !file.endsWith('.md') && !file.startsWith('types/'))) {
    console.warn('@huggingface/tokenizers is not installed, so turn detection waits out the pause alone.');
  }

  const binaries = `bin/napi-v6/${process.platform}/${process.arch}/`;

  if (!copyPackage(voiceDir, 'onnxruntime-node', (file) => file === 'package.json' || (file.startsWith('dist/') && file.endsWith('.js')) || (file.startsWith(binaries) && !/onnxruntime_providers_(cuda|tensorrt)/.test(file)))) {
    console.warn('onnxruntime-node is not installed, so turn detection waits out the pause alone.');
  } else {
    copyPackage(voiceDir, 'onnxruntime-common', (file) => file === 'package.json' || (file.startsWith('dist/cjs/') && (file.endsWith('.js') || file.endsWith('/package.json'))), path.dirname(path.dirname(require.resolve('onnxruntime-node'))));
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

/**
 * Copies the files the home's web folder takes: Mermaid's self-contained build, which sets `globalThis.mermaid`, so diagrams draw offline;
 * the web page's diff viewer, built by packages/web into its own folder with a manifest; and the browser extension's unpacked build, which the
 * web page offers for download.
 */
function copyWebAssets(outdir) {
  fs.mkdirSync(path.join(outdir, 'mermaid'), { recursive: true });
  fs.copyFileSync(path.join(path.dirname(require.resolve('mermaid/package.json')), 'dist', 'mermaid.min.js'), path.join(outdir, 'mermaid', 'mermaid.min.js'));

  const diff = path.join(ROOT, 'packages', 'web', 'dist', 'diff');

  if (fs.existsSync(path.join(diff, 'manifest.json'))) {
    fs.cpSync(diff, path.join(outdir, 'diff'), { recursive: true });
  } else {
    console.warn('packages/web has not built its diff viewer, so the web page shows no diffs. Build packages/web first.');
  }

  const chrome = path.join(ROOT, 'extensions', 'chrome', 'dist');

  if (fs.existsSync(path.join(chrome, 'manifest.json'))) {
    fs.cpSync(chrome, path.join(outdir, 'chrome'), { recursive: true });
  } else {
    console.warn('extensions/chrome has not been built, so the web page offers no browser extension. Build extensions/chrome first.');
  }
}

/**
 * The esbuild configs of the hub bundle, the terminal holder and the voice process, written under `outdir`. Every config builds from
 * apps/hub, so the hub bundle is the same file, and the same build, wherever it is written.
 */
function carriedConfigs(outdir, version) {
  const out = path.resolve(outdir);
  const common = { absWorkingDir: __dirname, bundle: true, format: 'cjs', platform: 'node', target: 'node22', logLevel: 'info' };
  const holderDir = path.join(out, 'holder');
  const voiceDir = path.join(out, 'voice');
  const after = (name, done) => ({ name, setup: (build) => build.onEnd((result) => { if (result.errors.length === 0) done(); }) });

  return [
    { ...common, entryPoints: { hub: 'src/main.ts' }, define: { __SWITCHBOARD_VERSION__: JSON.stringify(version) }, outdir: out, sourcemap: true },
    // The terminal holder runs on the operator's Node.js, not VS Code's, because node-pty is a native module (mechanics M76).
    // node-pty stays outside the bundle: it loads its binaries, a worker script and a console-list agent from its own folder.
    // After each build, watch mode included, the folder gets node-pty and a new manifest, so it can be installed.
    { ...common, entryPoints: { holder: '../../packages/holder/src/main.ts' }, external: ['node-pty'], outdir: holderDir, plugins: [after('holder-files', () => { copyNodePty(holderDir); writeManifest(holderDir); })] },
    // The voice process runs on the operator's Node.js too, since decibri (capture and playback) and sherpa-onnx (recognition) are native modules
    // (architecture.md § Voice, § Dictation); turn.js is its turn model's process, which loads onnxruntime apart from sherpa-onnx's own runtime, and
    // gpucheck.js checks sherpa-onnx's CUDA build in a child process before the voice process loads it.
    // The native modules stay outside the bundle: each loads its binary from its own or its platform package.
    {
      ...common,
      entryPoints: { voice: '../../packages/voice/src/main.ts', turn: '../../packages/voice/src/turnWorker.ts', gpucheck: '../../packages/voice/src/gpuCheck.ts' },
      external: ['decibri', 'sherpa-onnx-node', 'onnxruntime-node'],
      outdir: voiceDir,
      plugins: [
        after('voice-files', () => {
          copyDecibri(voiceDir);
          copyRecognition(voiceDir);

          for (const script of ['micuse.ps1', 'commcapture.ps1', 'lockwatch.ps1']) {
            fs.copyFileSync(path.join(ROOT, 'packages', 'voice', 'assets', script), path.join(voiceDir, script));
          }

          writeManifest(voiceDir);
        }),
      ],
    },
  ];
}

/**
 * Writes the carried builds into `outdir`, in the layout installCarried reads (packages/hub/src/carried.ts). With `watch`, keeps rebuilding the
 * hub, holder and voice builds until the process ends.
 */
async function buildCarried(outdir, { version, watch = false }) {
  copyWebAssets(outdir);

  const configs = carriedConfigs(outdir, version);

  if (watch) {
    for (const config of configs) {
      await (await esbuild.context(config)).watch();
    }

    return;
  }

  await Promise.all(configs.map((config) => esbuild.build(config)));
}

module.exports = { buildCarried };
