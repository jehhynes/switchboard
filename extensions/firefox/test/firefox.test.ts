import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { firefoxCss, firefoxManifest } from '../src/firefox.mjs';

const chromeManifest = JSON.parse(readFileSync(new URL('../../chrome/src/manifest.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const chromeCss = readFileSync(new URL('../../chrome/src/content.css', import.meta.url), 'utf8');

describe('firefoxManifest', () => {
  it('runs the background as a script, adds the add-on ID, drops the host permission port and keeps every other key of the Chrome manifest', () => {
    const { background, browser_specific_settings, host_permissions, ...rest } = firefoxManifest(chromeManifest);
    const { background: _chromeBackground, host_permissions: chromeHosts, ...chromeRest } = chromeManifest;

    expect(chromeHosts).toEqual(['http://127.0.0.1:47615/*']);
    expect(host_permissions).toEqual(['http://127.0.0.1/*']);
    expect(background).toEqual({ scripts: ['background.js'] });
    expect(browser_specific_settings).toEqual({ gecko: { id: 'switchboard@switchboard', strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } } });
    expect(rest).toEqual(chromeRest);
    expect(rest.permissions).toEqual(['storage', 'tabs', 'tabGroups', 'webNavigation']);
  });

  it('refuses a manifest without a background service worker', () => {
    expect(() => firefoxManifest({ ...chromeManifest, background: { scripts: ['background.js'] } })).toThrow('no background service worker');
    expect(() => firefoxManifest({ name: 'x' })).toThrow('no background service worker');
  });

  it('drops only a port, and refuses a manifest without host permissions', () => {
    const manifest = (hosts: unknown) => ({ ...chromeManifest, host_permissions: hosts });

    expect(firefoxManifest(manifest(['http://localhost:8080/a/*', 'https://github.com/*', 'http://127.0.0.1/*'])).host_permissions).toEqual(['http://localhost/a/*', 'https://github.com/*', 'http://127.0.0.1/*']);
    expect(() => firefoxManifest(manifest(undefined))).toThrow('no host permissions');
    expect(() => firefoxManifest(manifest([7]))).toThrow('no host permissions');
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
