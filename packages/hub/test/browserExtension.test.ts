import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserExtensionZip, installBrowserExtension, zip } from '../src/browserExtension.js';
import { unzip } from './zip.js';

/** An extension's `dist/chrome` as extensions/chrome builds it. */
function built(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sb-chrome-dist-'));

  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Switchboard', host_permissions: ['http://127.0.0.1:47615/*'] }));
  writeFileSync(join(dir, 'background.js'), 'console.log(1);');
  mkdirSync(join(dir, 'icons'));
  writeFileSync(join(dir, 'icons', 'icon-16.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
  return dir;
}

describe('the browser extension download (PRD R121)', () => {
  it('installs the carried build in the home, and nothing from a dist that carries none', () => {
    const web = join(mkdtempSync(join(tmpdir(), 'sb-chrome-home-')), 'web');

    expect(installBrowserExtension(join(web, 'none'), web)).toBe(false);
    expect(existsSync(join(web, 'chrome'))).toBe(false);
    expect(browserExtensionZip(web, null)).toBeNull();

    const source = built();

    expect(installBrowserExtension(source, web)).toBe(true);
    expect(readFileSync(join(web, 'chrome', 'background.js'), 'utf8')).toBe('console.log(1);');
    writeFileSync(join(source, 'background.js'), 'console.log(2);');
    expect(installBrowserExtension(source, web)).toBe(true);
    expect(readFileSync(join(web, 'chrome', 'background.js'), 'utf8')).toBe('console.log(2);');
  });

  it('keeps the installed copy when the new one cannot take its place', () => {
    const web = join(mkdtempSync(join(tmpdir(), 'sb-chrome-home-')), 'web');
    const source = built();

    installBrowserExtension(source, web);
    writeFileSync(join(source, 'background.js'), 'console.log(2);');

    let calls = 0;
    const failing = (from: string, to: string): void => {
      if (++calls === 2) {
        throw new Error('EPERM: in use');
      }

      renameSync(from, to);
    };

    expect(() => installBrowserExtension(source, web, failing)).toThrow('EPERM: in use');
    expect(readFileSync(join(web, 'chrome', 'background.js'), 'utf8')).toBe('console.log(1);');
    expect(readdirSync(web)).toEqual(['chrome']);
  });

  it("zips this computer's copy as built, in one folder, the same bytes each time", () => {
    const web = join(mkdtempSync(join(tmpdir(), 'sb-chrome-home-')), 'web');

    installBrowserExtension(built(), web);

    const archive = browserExtensionZip(web, null)!;
    const files = unzip(archive);

    expect([...files.keys()]).toEqual(['switchboard-extension/background.js', 'switchboard-extension/icons/icon-16.png', 'switchboard-extension/manifest.json']);
    expect(files.get('switchboard-extension/icons/icon-16.png')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
    expect(JSON.parse(files.get('switchboard-extension/manifest.json')!.toString('utf8')).host_permissions).toEqual(['http://127.0.0.1:47615/*']);
    expect(browserExtensionZip(web, null)!.equals(archive)).toBe(true);
  });

  it("gives another device a copy that names the page's origin and may reach it, and leaves out links and a stale remote.json", () => {
    const web = join(mkdtempSync(join(tmpdir(), 'sb-chrome-home-')), 'web');
    const source = built();

    writeFileSync(join(source, 'remote.json'), '{"origin":"https://old.example.ts.net"}');
    installBrowserExtension(source, web);

    try {
      symlinkSync(join(web, 'chrome', 'background.js'), join(web, 'chrome', 'linked.js'));
    } catch {
      // Windows without the right to make links: nothing to leave out.
    }

    const files = unzip(browserExtensionZip(web, 'https://pc.tail.ts.net')!);

    expect([...files.keys()]).toEqual(['switchboard-extension/background.js', 'switchboard-extension/icons/icon-16.png', 'switchboard-extension/manifest.json', 'switchboard-extension/remote.json']);
    expect(JSON.parse(files.get('switchboard-extension/remote.json')!.toString('utf8'))).toEqual({ origin: 'https://pc.tail.ts.net' });
    expect(JSON.parse(files.get('switchboard-extension/manifest.json')!.toString('utf8')).host_permissions).toEqual(['http://127.0.0.1:47615/*', 'https://pc.tail.ts.net/*']);
    // The installed build is unchanged.
    expect(JSON.parse(readFileSync(join(web, 'chrome', 'manifest.json'), 'utf8')).host_permissions).toEqual(['http://127.0.0.1:47615/*']);
  });

  it('writes an empty file and a name outside ASCII', () => {
    const files = unzip(zip([{ name: 'a/empty.txt', body: Buffer.alloc(0) }, { name: 'a/café.txt', body: Buffer.from('é') }]));

    expect(files.get('a/empty.txt')).toEqual(Buffer.alloc(0));
    expect(files.get('a/café.txt')!.toString('utf8')).toBe('é');
  });
});
