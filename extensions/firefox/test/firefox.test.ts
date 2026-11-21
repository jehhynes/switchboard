import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildNumber, firefoxCss, firefoxManifest, releaseTag, releasedVersions, signingRefusal } from '../src/firefox.mjs';

const chromeManifest = JSON.parse(readFileSync(new URL('../../chrome/src/manifest.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const chromeCss = readFileSync(new URL('../../chrome/src/content.css', import.meta.url), 'utf8');

describe('firefoxManifest', () => {
  it('runs the background as a script, adds the add-on ID, drops the host permission port and the Chrome pane, and keeps every other key of the Chrome manifest', () => {
    const { background, browser_specific_settings, host_permissions, version, ...rest } = firefoxManifest(chromeManifest, 446_400);
    const { background: _chromeBackground, host_permissions: chromeHosts, version: chromeVersion, key, externally_connectable, ...chromeRest } = chromeManifest;

    expect([chromeVersion, version]).toEqual(['0.0.1', '0.0.1.446400']);

    expect(chromeHosts).toEqual(['http://127.0.0.1:47615/*']);
    expect(host_permissions).toEqual(['http://127.0.0.1/*']);
    expect(background).toEqual({ scripts: ['background.js'] });
    expect(browser_specific_settings).toEqual({ gecko: { id: 'switchboard@switchboard', strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } } });
    expect(rest).toEqual(chromeRest);
    expect([typeof key, externally_connectable]).toEqual(['string', { matches: ['http://127.0.0.1/*', 'http://localhost/*'] }]);
    expect(rest.permissions).toEqual(['storage', 'tabs', 'tabGroups', 'webNavigation']);
  });

  it('refuses a manifest without a background service worker', () => {
    expect(() => firefoxManifest({ ...chromeManifest, background: { scripts: ['background.js'] } }, 1)).toThrow('no background service worker');
    expect(() => firefoxManifest({ version: '1', name: 'x' }, 1)).toThrow('no background service worker');
  });

  it('drops only a port, and refuses a manifest without host permissions', () => {
    const manifest = (hosts: unknown) => ({ ...chromeManifest, host_permissions: hosts });

    expect(firefoxManifest(manifest(['http://localhost:8080/a/*', 'https://github.com/*', 'http://127.0.0.1/*']), 1).host_permissions).toEqual(['http://localhost/a/*', 'https://github.com/*', 'http://127.0.0.1/*']);
    expect(() => firefoxManifest(manifest(undefined), 1)).toThrow('no host permissions');
    expect(() => firefoxManifest(manifest([7]), 1)).toThrow('no host permissions');
  });
});

describe('buildNumber', () => {
  it('counts whole minutes since 2026-01-01 UTC, so a build in a later minute has a higher version', () => {
    expect(buildNumber(Date.UTC(2026, 0, 1))).toBe(0);
    expect(buildNumber(Date.UTC(2026, 0, 1, 0, 1, 59))).toBe(1);
    expect(buildNumber(Date.UTC(2026, 10, 3, 12, 0))).toBe(441_360);
  });

  it('refuses a Chrome version with no room for the build number', () => {
    expect(() => firefoxManifest({ ...chromeManifest, version: '1.2.3.4' }, 1)).toThrow('no room for the build number');
    expect(() => firefoxManifest({ ...chromeManifest, version: '1.x' }, 1)).toThrow('no room for the build number');
    expect(() => firefoxManifest({ ...chromeManifest, version: undefined }, 1)).toThrow('no room for the build number');
    expect(() => firefoxManifest({ ...chromeManifest, version: '01.2' }, 1)).toThrow('no room for the build number');
    expect(() => firefoxManifest({ ...chromeManifest, version: '1000000000.2' }, 1)).toThrow('no room for the build number');
    expect(firefoxManifest({ ...chromeManifest, version: '3' }, 7).version).toBe('3.7');
    expect(firefoxManifest({ ...chromeManifest, version: '999999999.0' }, 0).version).toBe('999999999.0.0');
  });

  it('refuses a build number from a clock before 2026 or far ahead', () => {
    expect(() => firefoxManifest(chromeManifest, buildNumber(Date.UTC(2025, 11, 31, 23, 59)))).toThrow('build number -1 is not a whole number');
    expect(() => firefoxManifest(chromeManifest, 1_000_000_000)).toThrow('build number 1000000000');
    expect(() => firefoxManifest(chromeManifest, 1.5)).toThrow('build number 1.5');
    expect(firefoxManifest(chromeManifest, 999_999_999).version).toBe('0.0.1.999999999');
  });
});

describe('releasedVersions', () => {
  it('reads the version from each Firefox release tag and ignores other tags', () => {
    expect(releaseTag('0.0.1.441360')).toBe('firefox-v0.0.1.441360');
    expect(releasedVersions([releaseTag('0.0.1.441360'), 'firefox-v0.0.1.9', 'v1.0.0', 'chrome-v0.0.1.5', 'firefox-v0.0.1.x', 'firefox-v', 'xfirefox-v1'])).toEqual(['0.0.1.441360', '0.0.1.9']);
  });
});

describe('signingRefusal', () => {
  it('refuses a version already signed, as from a build in the same minute, or lower than a signed one', () => {
    expect(signingRefusal('0.0.1.441360', [])).toBeNull();
    expect(signingRefusal('0.0.1.441360', ['0.0.1.441359', '0.0.1.9'])).toBeNull();
    expect(signingRefusal('0.0.2.5', ['0.0.1.441360'])).toBeNull();
    expect(signingRefusal('0.0.1.441360', ['0.0.1.441359', '0.0.1.441360'])).toBe('Version 0.0.1.441360 is already signed. Builds in the same minute get the same version: wait a minute and sign again.');
    expect(signingRefusal('0.0.1.441360', ['0.0.1.441361'])).toBe('Version 0.0.1.441360 is lower than the signed version 0.0.1.441361. Check the clock.');
    expect(signingRefusal('0.0.1.9', ['0.0.1.10'])).toBe('Version 0.0.1.9 is lower than the signed version 0.0.1.10. Check the clock.');
    expect(signingRefusal('0.0.2', ['0.0.1.441360'])).toBeNull();
  });
});

describe('firefoxCss', () => {
  it('loads the codicon font from the moz-extension URL and changes nothing else', () => {
    const [before, after, ...more] = chromeCss.split("url('chrome-extension://__MSG_@@extension_id__/codicon.ttf')");

    expect(more).toEqual([]);
    expect(firefoxCss(chromeCss)).toBe(`${before}url('moz-extension://__MSG_@@extension_id__/codicon.ttf')${after}`);
  });

  it('refuses CSS that no longer loads the font from the Chrome URL', () => {
    expect(() => firefoxCss(chromeCss.replace('chrome-extension://', 'other://'))).toThrow('no longer loads the font');
  });
});
