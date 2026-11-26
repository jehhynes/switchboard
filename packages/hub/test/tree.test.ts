import { describe, expect, it } from 'vitest';
import { globPattern } from '../src/tree.js';

describe('globPattern', () => {
  it('matches a name at any depth without a slash, and a whole path with one', () => {
    expect(globPattern('*.ts')!.test('src/deep/a.ts')).toBe(true);
    expect(globPattern('*.ts')!.test('src/a.tsx')).toBe(false);
    expect(globPattern('src/*.ts')!.test('src/a.ts')).toBe(true);
    expect(globPattern('src/*.ts')!.test('src/deep/a.ts')).toBe(false);
    expect(globPattern('src/**/*.ts')!.test('src/deep/a.ts')).toBe(true);
    expect(globPattern('src/**/*.ts')!.test('src/a.ts')).toBe(true);
    expect(globPattern('a?.md')!.test('ab.md')).toBe(true);
    expect(globPattern('a+(b).md')!.test('a+(b).md')).toBe(true);
    expect(globPattern(' ')).toBeNull();
  });
});
