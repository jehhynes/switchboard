import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOf, bundleHome, installBundle } from '../src/bundle.js';
import { tempHome } from './helpers.js';

let dir: string;
let remove: () => void;

beforeEach(() => {
  ({ home: dir, remove } = tempHome());
});

afterEach(() => remove());

describe('installBundle', () => {
  it('copies into a missing directory, skips an identical copy, and replaces a changed one', () => {
    const source = join(dir, 'hub.js');
    const target = join(dir, 'home', '.switchboard', 'hub.js');

    writeFileSync(source, 'one');
    expect(installBundle(source, target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('one');

    expect(installBundle(source, target)).toBe(false);

    writeFileSync(source, 'two');
    expect(installBundle(source, target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('two');
  });
});

describe('bundleHome', () => {
  it("names the home of a bundle in its .switchboard folder, and the fallback for any other bundle, such as the extension's", () => {
    expect(bundleHome(join(dir, '.switchboard', 'hub.js'), 'fallback')).toBe(dir);
    expect(bundleHome(join(dir, 'extensions', 'switchboard.switchboard-0.0.0', 'dist', 'hub.js'), 'fallback')).toBe('fallback');
    expect(bundleHome(undefined, 'fallback')).toBe('fallback');
  });
});

describe('buildOf', () => {
  it('is a 16-character hash that changes with the content', () => {
    const one = join(dir, 'one.js');
    const same = join(dir, 'same.js');
    const other = join(dir, 'other.js');

    writeFileSync(one, 'code');
    writeFileSync(same, 'code');
    writeFileSync(other, 'code2');

    expect(buildOf(one)).toMatch(/^[0-9a-f]{16}$/);
    expect(buildOf(same)).toBe(buildOf(one));
    expect(buildOf(other)).not.toBe(buildOf(one));
  });
});