import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { hubLogPath, switchboardHome } from '@switchboard/core';
import { spawnEnvironment } from './spawn.js';

/** The serving flags `hub.js start` passes on to the hub it starts (architecture.md § Hub lifecycle). */
export const START_FLAGS = ['config', 'browser-port', 'page-port', 'idle-ms', 'code-mode-idle-ms'] as const;

/** How long `hub.js start` waits for the hub's record; longer than a window's wait, since a login start shares the disk with everything else. */
export const START_WAIT_MS = 15_000;

/**
 * Starts `<runtime> <bundle> <args>` detached and without a window, with VS Code's variables removed and its output appended to `hub.log`, so the hub
 * outlives the command that started it.
 */
export function startDetached(runtime: string, bundle: string, home: string, args: readonly string[]): ChildProcess {
  mkdirSync(switchboardHome(home), { recursive: true });

  const log = openSync(hubLogPath(home), 'a');

  try {
    const child = spawn(runtime, [bundle, ...args], { env: spawnEnvironment(process.env), detached: true, stdio: ['ignore', log, log], windowsHide: true });

    child.unref();

    return child;
  } finally {
    closeSync(log);
  }
}
