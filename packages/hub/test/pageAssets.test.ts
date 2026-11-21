import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { installDiffViewer, pageAsset } from '../src/pageAssets.js';

/** An extension's `dist/diff` as packages/web builds it: two files and the manifest naming them. */
function carried(build: string, text = 'export const x = 1;'): string {
  const dir = mkdtempSync(join(tmpdir(), 'sb-diff-dist-'));

  mkdirSync(join(dir, 'chunks'));
  writeFileSync(join(dir, 'diff.js'), text);
  writeFileSync(join(dir, 'chunks', 'ts-1.js'), 'export const ts = 1;');
  writeFileSync(join(dir, 'secret.txt'), 'not listed');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ build, files: ['chunks/ts-1.js', 'diff.js'] }));
  return dir;
}

describe('the diff viewer in the home', () => {
  it('installs a build in a folder of its own and removes the build before it', () => {
    const home = mkdtempSync(join(tmpdir(), 'sb-diff-home-'));
    const web = join(home, 'web');

    expect(installDiffViewer(carried('aaaaaaaaaaaaaaaa'), web)).toBe('aaaaaaaaaaaaaaaa');
    expect(readFileSync(join(web, 'diff', 'aaaaaaaaaaaaaaaa', 'chunks', 'ts-1.js'), 'utf8')).toBe('export const ts = 1;');
    expect(installDiffViewer(carried('bbbbbbbbbbbbbbbb'), web)).toBe('bbbbbbbbbbbbbbbb');
    expect(existsSync(join(web, 'diff', 'aaaaaaaaaaaaaaaa'))).toBe(false);
    expect(existsSync(join(web, 'diff', 'bbbbbbbbbbbbbbbb', 'diff.js'))).toBe(true);
  });

  it('installs nothing from a dist that carries no diff viewer, or a manifest with a bad build or file name', () => {
    const web = join(mkdtempSync(join(tmpdir(), 'sb-diff-home-')), 'web');
    const badFile = carried('eeeeeeeeeeeeeeee');

    writeFileSync(join(badFile, 'manifest.json'), JSON.stringify({ build: 'eeeeeeeeeeeeeeee', files: ['../../hub.js'] }));
    expect(installDiffViewer(join(web, 'none'), web)).toBeNull();
    expect(installDiffViewer(carried('../escape'), web)).toBeNull();
    expect(installDiffViewer(badFile, web)).toBeNull();
    expect(existsSync(join(web, 'diff'))).toBe(false);
  });

  it('serves only the files its manifest lists, gzipped too, and kept by the browser', () => {
    const home = mkdtempSync(join(tmpdir(), 'sb-diff-home-'));

    installDiffViewer(carried('cccccccccccccccc', 'export const big = "' + 'x'.repeat(5000) + '";'), join(home, 'web'));

    const asset = pageAsset('diff/cccccccccccccccc/diff.js', home)!;

    expect(asset).toMatchObject({ mime: 'text/javascript; charset=utf-8', immutable: true });
    expect(gunzipSync(asset.gzip!).toString('utf8')).toBe(String(asset.body));
    expect(asset.gzip!.length).toBeLessThan(Buffer.byteLength(String(asset.body)));
    expect(pageAsset('diff/cccccccccccccccc/chunks/ts-1.js', home)).not.toBeNull();

    // A build named by the page but not installed is not remembered.
    expect(pageAsset('diff/ffffffffffffffff/diff.js', home)).toBeNull();

    for (const name of ['diff/cccccccccccccccc/secret.txt', 'diff/cccccccccccccccc/manifest.json', 'diff/cccccccccccccccc/../cccccccccccccccc/diff.js', 'diff/dddddddddddddddd/diff.js', 'diff/../web/diff.js', 'diff/cccccccccccccccc/missing.js']) {
      expect(pageAsset(name, home)).toBeNull();
    }
  });
});
