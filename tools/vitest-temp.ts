import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Put test temp files, and those of processes tests start, in one folder that can be excluded from antivirus scans.
 * Claude's and Codex's homes point there too, so a test that forgets to isolate them cannot install hooks in the operator's.
 */
export function testTemp(): Record<string, string> {
  const base = tmpdir();
  const dir = basename(base) === 'switchboard-tests' ? base : join(base, 'switchboard-tests');

  mkdirSync(dir, { recursive: true });

  return { TEMP: dir, TMP: dir, TMPDIR: dir, CLAUDE_CONFIG_DIR: join(dir, 'claude-home'), CODEX_HOME: join(dir, 'codex-home') };
}
