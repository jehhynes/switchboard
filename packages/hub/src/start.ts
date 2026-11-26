import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { hubLogPath, rotateLog, switchboardHome } from '@switchboard/core';
import { spawnEnvironment } from './spawn.js';

/** The serving flags `hub.js start` passes on to the hub it starts (architecture.md § Hub lifecycle). */
export const START_FLAGS = ['config', 'browser-port', 'page-port', 'idle-ms', 'code-mode-idle-ms'] as const;

/** How long `hub.js start` waits for the hub's record; longer than a window's wait, since a login start shares the disk with everything else. */
export const START_WAIT_MS = 15_000;

/**
 * Starts `<runtime> <bundle> <args>` detached and without a window, with VS Code's variables removed and its output appended to `hub.log`, so the hub
 * outlives the command that started it. With `rotate`, which a caller passes once it found no hub holding the lock, a full `hub.log` is first
 * rotated (architecture.md § Hub log).
 */
export function startDetached(runtime: string, bundle: string, home: string, args: readonly string[], options: { rotate?: boolean } = {}): ChildProcess {
  mkdirSync(switchboardHome(home), { recursive: true });

  // Only when no hub holds the lock: a running hub would go on writing to hub.log.1 while the page reads the new hub.log.
  if (options.rotate === true) {
    rotateLog(hubLogPath(home));
  }

  const log = openSync(hubLogPath(home), 'a');

  try {
    const child = spawn(runtime, [bundle, ...args], { env: spawnEnvironment(process.env), detached: true, stdio: ['ignore', log, log], windowsHide: true });

    child.unref();

    return child;
  } finally {
    closeSync(log);
  }
}

/**
 * The hub's log writer: its output, which its starter opened on hub.log, unless that file was rotated away, as when another start rotated it in
 * the moment before this hub took the lock; then the lines go to hub.log by path, so the page still sees them (architecture.md § Hub log). Checked
 * at each line, which costs two stats, so no line goes to the rotated file.
 */
export function logWriter(path: string, out: (text: string) => void, outFd = 1): (text: string) => void {
  return (text) => {
    let byPath: boolean;

    try {
      const output = fstatSync(outFd);
      const file = statSync(path);
      byPath = output.isFile() && (output.ino !== file.ino || output.dev !== file.dev);
    } catch {
      byPath = false;
    }

    if (byPath) {
      try {
        appendFileSync(path, text);
        return;
      } catch {
        // Written to the output instead.
      }
    }

    out(text);
  };
}
