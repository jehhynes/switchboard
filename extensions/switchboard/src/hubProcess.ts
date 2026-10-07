import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { hubLogPath, switchboardHome } from '@switchboard/core';
import { spawnEnvironment } from '@switchboard/hub';

/**
 * Start a detached hub with VS Code's own executable in Node mode, so Node need not be on PATH. The hub outlives
 * the window and exits on its own once no client is connected.
 */
export function startHub(bundle: string, home: string, configDir: string): void {
  mkdirSync(switchboardHome(home), { recursive: true });

  const log = openSync(hubLogPath(home), 'a');

  try {
    spawn(process.execPath, [bundle, `--home=${home}`, `--config=${configDir}`], {
      env: spawnEnvironment(process.env),
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    }).unref();
  } finally {
    closeSync(log);
  }
}
