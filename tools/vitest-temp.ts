import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/** Put test temp files, and those of processes tests start, in one folder that can be excluded from antivirus scans. */
export function testTemp(): Record<string, string> {
  const base = tmpdir();
  const dir = basename(base) === 'switchboard-tests' ? base : join(base, 'switchboard-tests');

  mkdirSync(dir, { recursive: true });

  return { TEMP: dir, TMP: dir, TMPDIR: dir };
}
