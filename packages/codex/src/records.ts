import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where an earlier hub kept its Codex exec runs' records, which the Codex hook still reads to know Switchboard's threads. */
export function codexDir(home: string): string {
  return join(home, 'codex');
}

export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
