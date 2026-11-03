import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { context } from 'esbuild';
import { bundle, copiedSources, webExt, writeCopied } from './build.mjs';

// Snap Firefox cannot read hidden folders in the home folder, so its profile goes in the snap's own folder.
const profile =
  process.env.SWITCHBOARD_FIREFOX_PROFILE ??
  (existsSync('/snap/firefox/current') ? join(homedir(), 'snap/firefox/common/switchboard-dev') : join(homedir(), '.switchboard/firefox-dev'));

writeCopied();

const builder = await context(bundle);

await builder.rebuild();
await builder.watch();

// A folder watch, unlike a file watch, still sees a file that an editor saves by replacing it. An event without a name may be any file.
const watchers = Object.entries(copiedSources).map(([folder, names]) =>
  watch(folder, (_event, name) => {
    if (name !== null && !names.includes(name)) {
      return;
    }

    try {
      writeCopied();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
  }),
);

mkdirSync(profile, { recursive: true });

// web-ext installs dist/ as a temporary add-on and reloads it whenever dist/ changes. The profile keeps sign-ins between runs.
const firefox = spawn(process.execPath, [webExt, 'run', '--source-dir', 'dist', '--firefox-profile', profile, '--keep-profile-changes', ...process.argv.slice(2)], {
  stdio: 'inherit',
});

let stopping = false;

const stop = async (code) => {
  if (stopping) {
    return;
  }

  stopping = true;

  for (const watcher of watchers) {
    watcher.close();
  }

  await builder.dispose();
  process.exit(code);
};

// web-ext closes Firefox only on SIGINT, so SIGTERM is passed on as SIGINT; Ctrl+C reaches it directly too. On Windows, Ctrl+C
// reaches every process in the console and kill() ends web-ext at once, before it closes Firefox, so nothing is passed on.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (process.platform !== 'win32') {
      firefox.kill('SIGINT');
    }
  });
}

firefox.on('error', (error) => {
  console.error(`Could not start web-ext: ${error.message}`);
  void stop(1);
});
firefox.on('exit', (code) => void stop(code ?? 1));
