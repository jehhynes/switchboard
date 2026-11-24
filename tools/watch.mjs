import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// npm runs workspace scripts one after another and each watcher never exits, so start them side by side. They run
// under Node directly, without a shell, so stopping one process stops its compiler.
// `tsc -b` follows apps/hub's references to core and hub; apps/hub/build.cjs rebundles the standalone build when their output changes.
const watchers = [
  spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '-b', '-w', 'apps/hub'], { stdio: 'inherit' }),
  spawn(process.execPath, ['build.cjs', '--watch'], { cwd: 'apps/hub', stdio: 'inherit' }),
];

for (const watcher of watchers) {
  watcher.on('exit', (code) => {
    for (const other of watchers) other.kill();
    process.exit(code ?? 1);
  });
}
