import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hubRunning, stoppedHomes } from '@switchboard/core';
import { CONTRACT_HOOK_SOURCE, HOOK_SOURCE, planHooks } from './hooks.js';
import type { Marker } from './hooks.js';

/** Claude's settings file: under CLAUDE_CONFIG_DIR when the operator set it, else `~/.claude`. */
export function claudeSettingsPath(home: string, env: NodeJS.ProcessEnv): string {
  return join(env['CLAUDE_CONFIG_DIR'] || join(home, '.claude'), 'settings.json');
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

/** Windows refuses a rename over a file another process has open, as Claude sessions often have settings.json (mechanics M8). */
const RENAME_ATTEMPTS = 10;
const RENAME_WAIT_MS = 100;

function writeAtomically(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;

  writeFileSync(tmp, text);

  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (error) {
      if (attempt === RENAME_ATTEMPTS || (error as NodeJS.ErrnoException).code !== 'EPERM') {
        rmSync(tmp, { force: true });
        throw error;
      }

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_WAIT_MS);
    }
  }
}

/**
 * Writes `<switchboard home>/hook.mjs` and `contract.mjs`, adds their entries to Claude's settings, and removes the entries of other
 * Switchboard homes whose hub does not run (`running`). Returns why settings were left alone, or null.
 */
export async function installHooks(
  switchboardHome: string,
  settingsPath: string,
  nodePath: string,
  running: (home: string) => Promise<boolean> = hubRunning,
): Promise<string | null> {
  const hookPath = join(switchboardHome, 'hook.mjs').replaceAll('\\', '/');
  const contractPath = join(switchboardHome, 'contract.mjs').replaceAll('\\', '/');

  mkdirSync(switchboardHome, { recursive: true });

  for (const [path, source] of [
    [hookPath, HOOK_SOURCE],
    [contractPath, CONTRACT_HOOK_SOURCE],
  ] as const) {
    if (readText(path) !== source) {
      writeAtomically(path, source);
    }
  }

  const text = readText(settingsPath);
  const stopped = await stoppedHomes((stale) => planHooks(text, hookPath, contractPath, nodePath, stale), running);
  const plan = planHooks(text, hookPath, contractPath, nodePath, (other) => stopped.has(other));

  if ('error' in plan) {
    return plan.error;
  }

  if ('text' in plan) {
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeAtomically(settingsPath, plan.text);
  }

  return null;
}

/**
 * A marker file as last read: its stat, when it was read, and its marker. The file ID is read as a bigint, since a Windows file ID can pass 2^53
 * and lose its last digits as a number.
 */
interface ReadFile {
  mtimeMs: number;
  size: bigint;
  ino: bigint;
  readAt: number;
  marker: Marker;
}

/**
 * A file written this close to its read is read again, because a rewrite in the same file-system tick can keep its mtime and size (Linux
 * stamps files from a coarse clock).
 */
const RECENT_WRITE_MS = 2_000;

/** Each activity folder's files as last read, by file name. */
const folders = new Map<string, Map<string, ReadFile>>();
/** The markers read during the current `markerPass`, by folder. */
let pass: Map<string, Map<string, Marker>> | null = null;

function readFolder(dir: string): Map<string, Marker> {
  const markers = new Map<string, Marker>();
  let files: string[];

  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.json'));
  } catch {
    folders.delete(dir);
    return markers;
  }

  const before = folders.get(dir);
  const after = new Map<string, ReadFile>();

  for (const file of files) {
    const path = join(dir, file);
    let entry = before?.get(file);

    try {
      const stat = statSync(path, { bigint: true, throwIfNoEntry: false });

      if (stat === undefined) {
        continue;
      }

      const mtimeMs = Number(stat.mtimeNs / 1_000_000n);

      // The hook writes a temporary file and renames it over the marker, which gives the marker a new file ID even when its size and mtime
      // are the old ones (mechanics M165); an in-place rewrite with the same size and mtime, which the hook never makes, would not be read.
      if (entry === undefined || entry.mtimeMs !== mtimeMs || entry.size !== stat.size || entry.ino !== stat.ino || entry.readAt - entry.mtimeMs < RECENT_WRITE_MS) {
        const readAt = Date.now();
        // A failed read or parse is not kept, so the next read tries the file again.
        const marker = JSON.parse(readFileSync(path, 'utf8')) as Marker;

        entry = { mtimeMs, size: stat.size, ino: stat.ino, readAt, marker };
      }

      markers.set(entry.marker.sessionId, entry.marker);
      after.set(file, entry);
    } catch {
      continue;
    }
  }

  folders.set(dir, after);

  return markers;
}

/**
 * Hook markers by native session ID. An unreadable marker is skipped; the next hook event rewrites it. Only files whose stat changed are read
 * again, and inside a {@link markerPass} the folder is read once.
 */
export function readMarkers(switchboardHome: string): Map<string, Marker> {
  const dir = join(switchboardHome, 'activity');
  let markers = pass?.get(dir);

  if (markers === undefined) {
    markers = readFolder(dir);
    pass?.set(dir, markers);
  }

  return new Map(markers);
}

/** Runs `read` with every `readMarkers` inside it answered from one read of each folder, as a marker tick's callers share one. */
export function markerPass<T>(read: () => T): T {
  if (pass !== null) {
    return read();
  }

  pass = new Map();

  try {
    return read();
  } finally {
    pass = null;
  }
}
