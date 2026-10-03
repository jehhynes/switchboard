import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * The bash that runs source commands. On Windows, `bash` on PATH is usually WSL (System32), where the operator's runner
 * scripts and tools are missing, so Git Bash is found from `CLAUDE_CODE_GIT_BASH_PATH` or from git.exe on PATH, as Claude Code does.
 */
export function findBash(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): string {
  if (platform !== 'win32') {
    return 'bash';
  }

  const configured = env['CLAUDE_CODE_GIT_BASH_PATH'];

  if (configured !== undefined && configured !== '' && exists(configured)) {
    return configured;
  }

  for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(win32.delimiter).filter((entry) => entry !== '')) {
    if (!exists(win32.join(dir, 'git.exe'))) {
      continue;
    }

    // git.exe lives in <Git>\cmd, <Git>\bin or <Git>\mingw64\bin; bash.exe in <Git>\bin.
    for (const candidate of [win32.join(dir, '..', 'bin', 'bash.exe'), win32.join(dir, '..', '..', 'bin', 'bash.exe')]) {
      if (exists(candidate)) {
        return candidate;
      }
    }
  }

  return 'bash';
}
