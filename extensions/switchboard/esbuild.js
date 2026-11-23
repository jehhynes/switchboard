const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { buildCarried } = require('../../apps/hub/carried.cjs');
const { version } = require('./package.json');

// Bundle workspace packages, because vsce excludes files outside this directory.
const options = {
  entryPoints: [{ in: 'src/extension.ts', out: 'extension' }],
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
  const shared = ['@switchboard/conversation/bubbles.css', '@switchboard/conversation/composer.css', '@switchboard/conversation/picker.css', '@switchboard/conversation/menu.css', '@switchboard/conversation/questionCard.css'].map((name) => fs.readFileSync(require.resolve(name), 'utf8')).join('');
  fs.writeFileSync('dist/conversation.css', shared + fs.readFileSync('src/webview/conversation.css', 'utf8'));
  fs.copyFileSync('src/webview/mermaidPreview.css', 'dist/mermaidPreview.css');
}

async function main() {
  // A file left from an earlier build, such as a removed webview, would ship in the package.
  fs.rmSync('dist', { recursive: true, force: true });
  copyAssets();

  // The builds activation installs in the Switchboard home, from the same configs as apps/hub's standalone build (apps/hub/carried.cjs);
  // the Markdown preview also loads the Mermaid build from dist/mermaid.
  const watch = process.argv.includes('--watch');
  const carried = buildCarried('dist', { version, watch });

  if (watch) {
    for (const config of [options, webview]) {
      await (await esbuild.context(config)).watch();
    }

    await carried;
    return;
  }

  await Promise.all([esbuild.build(options), esbuild.build(webview), carried]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
