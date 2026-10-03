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

async function main() {
  if (process.argv.includes('--watch')) {
    const context = await esbuild.context(options);

    await context.watch();

    return;
  }

  await esbuild.build(options);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
