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

// The panel, settings editor and History scripts run in webviews, a browser.
const webview = {
  entryPoints: { webview: 'src/webview/main.ts', settings: 'src/webview/settingsMain.ts', history: 'src/webview/historyMain.ts' },
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

  fs.copyFileSync('src/webview/webview.css', 'dist/webview.css');
  fs.copyFileSync('src/webview/settings.css', 'dist/settings.css');
  fs.copyFileSync('src/webview/history.css', 'dist/history.css');
}

async function main() {
  copyAssets();

  if (process.argv.includes('--watch')) {
    for (const config of [options, webview]) {
      await (await esbuild.context(config)).watch();
    }

    return;
  }

  await Promise.all([esbuild.build(options), esbuild.build(webview)]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
