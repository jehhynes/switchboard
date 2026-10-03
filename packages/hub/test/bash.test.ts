import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBash } from '../src/bash.js';

const files = (...paths: string[]) => (path: string) => paths.includes(path);

describe('findBash', () => {
  it('uses bash on PATH outside Windows', () => {
    expect(findBash('linux', { PATH: '/usr/bin' }, files())).toBe('bash');
  });

  it('on Windows, prefers CLAUDE_CODE_GIT_BASH_PATH, then the Git Bash beside git.exe on PATH, skipping WSL bash', () => {
    const configured = 'D:\\Tools\\bash.exe';
    const gitBash = win32.join('C:\\Git\\cmd', '..', 'bin', 'bash.exe');
    const env = { PATH: ['C:\\Windows\\System32', 'C:\\Git\\cmd'].join(';'), CLAUDE_CODE_GIT_BASH_PATH: configured };
    const exists = files(configured, 'C:\\Windows\\System32\\bash.exe', win32.join('C:\\Git\\cmd', 'git.exe'), gitBash);

    expect(findBash('win32', env, exists)).toBe(configured);
    expect(findBash('win32', { ...env, CLAUDE_CODE_GIT_BASH_PATH: 'D:\\missing.exe' }, exists)).toBe(gitBash);
  });

  it('finds Git Bash from git.exe in mingw64\\bin, and falls back to bash when no git.exe is on PATH', () => {
    const gitBash = win32.join('C:\\Git\\mingw64\\bin', '..', '..', 'bin', 'bash.exe');

    expect(findBash('win32', { Path: 'C:\\Git\\mingw64\\bin' }, files(win32.join('C:\\Git\\mingw64\\bin', 'git.exe'), gitBash))).toBe(gitBash);
    expect(findBash('win32', { PATH: 'C:\\Windows\\System32' }, files('C:\\Windows\\System32\\bash.exe'))).toBe('bash');
  });
});
