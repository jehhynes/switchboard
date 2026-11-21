import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedProviders, onPath } from '../src/installed.js';
import { tempHome } from './helpers.js';

let temp: ReturnType<typeof tempHome>;

beforeEach(() => {
  temp = tempHome();
});

afterEach(() => {
  temp.remove();
});

describe('installedProviders', () => {
  it('finds a bare name on PATH, with a PATHEXT extension on Windows, and a path as given', async () => {
    const bin = join(temp.home, 'bin');
    const other = join(temp.home, 'other');
    mkdirSync(bin);
    mkdirSync(join(other, 'codex'), { recursive: true });
    writeFileSync(join(bin, 'claude.CMD'), '');
    writeFileSync(join(bin, 'codex'), '');
    chmodSync(join(bin, 'codex'), 0o755);

    const env = { PATH: [other, bin].join(delimiter), PATHEXT: '.EXE;.CMD' };

    expect(await onPath('claude', env, 'win32')).toBe(true);
    expect(await onPath('claude', { PATH: bin, PATHEXT: '.EXE' }, 'win32')).toBe(false);
    expect(await onPath('codex', env, 'win32')).toBe(true);
    expect(await onPath(join(bin, 'codex'), {}, 'win32')).toBe(true);
    expect(await onPath(join(bin, 'claude'), {}, 'win32')).toBe(true);
    expect(await onPath(join(bin, 'claude'), { PATHEXT: '.EXE' }, 'win32')).toBe(false);
    // A folder with the command's name is not the command.
    expect(await onPath('codex', { PATH: other }, 'win32')).toBe(false);
    expect(await installedProviders({ claudePath: 'claude', codexPath: join(temp.home, 'missing') }, env, 'win32')).toEqual(['claude']);
    expect(await installedProviders({ claudePath: 'nothing', codexPath: 'codex' }, env, 'win32')).toEqual(['codex']);
  });
});
