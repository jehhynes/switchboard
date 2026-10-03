import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Copy the hub bundle to the Switchboard home, so the running hub does not depend on the extension's install
 * directory. True when the file changed.
 */
export function installBundle(source: string, target: string): boolean {
  const carried = readFileSync(source);

  let onDisk: Buffer | null = null;

  try {
    onDisk = readFileSync(target);
  } catch {
    // Not installed yet.
  }

  if (onDisk?.equals(carried)) {
    return false;
  }

  mkdirSync(dirname(target), { recursive: true });

  const temporary = `${target}.${process.pid}.tmp`;

  writeFileSync(temporary, carried);
  renameSync(temporary, target);

  return true;
}

/** The hub's build identity: a hash of its bundle, so a rebuilt hub differs even when the version does not. */
export function buildOf(bundle: string): string {
  return createHash('sha256').update(readFileSync(bundle)).digest('hex').slice(0, 16);
}
