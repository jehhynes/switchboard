/** The add-on ID, which keeps one installed copy across reinstalls. */
export const GECKO_ID = 'switchboard@switchboard';

/** The first Firefox with `data_collection_permissions`. */
export const MIN_VERSION = '140.0';

/** Builds are numbered by the minutes since this time, so a build in a later minute has a higher version. */
const BUILD_EPOCH = Date.UTC(2026, 0, 1);

/** A part of a Firefox version: at most nine digits, with no leading zero. */
const VERSION_PART = /^(0|[1-9]\d{0,8})$/;

/**
 * The permissions only embedded tabs and the Switchboard tab group use, which take messages from the web page that Firefox does not deliver:
 * `storage` for their state and pairing, `tabs` to read tab URLs, `tabGroups` to find and name the group.
 */
const CHROME_PERMISSIONS = ['storage', 'tabs', 'tabGroups', 'alarms', 'declarativeNetRequestWithHostAccess'];

const CHROME_FONT = "url('chrome-extension://__MSG_@@extension_id__/codicon.ttf')";

/**
 * The Chrome manifest changed for Firefox, which runs a background script instead of a service worker, needs an add-on ID, and
 * matches nothing with a match pattern that has a port, so the hub's host permission covers every port of its host (mechanics M52). The Chrome
 * pane's `key`, `externally_connectable` and the permissions of the pane and the tab group are left out: Firefox has neither a key-derived ID nor messages
 * from web pages, so it has no pane and does not group the page's links.
 * The version adds the build number to Chrome's, because addons.mozilla.org signs each version once.
 * @param {Record<string, unknown>} chrome
 * @param {number} build
 * @returns {Record<string, unknown>}
 */
export function firefoxManifest(chrome, build) {
  const parts = typeof chrome.version === 'string' ? chrome.version.split('.') : [];

  if (parts.length < 1 || parts.length > 3 || !parts.every((part) => VERSION_PART.test(part))) {
    throw new Error('The Chrome manifest version is not 1 to 3 numbers, so it has no room for the build number.');
  }

  if (!VERSION_PART.test(String(build))) {
    throw new Error(`The build number ${build} is not a whole number of at most nine digits; check the clock.`);
  }

  const background = /** @type {{ service_worker?: unknown } | undefined} */ (chrome.background);

  if (typeof background?.service_worker !== 'string') {
    throw new Error('The Chrome manifest has no background service worker.');
  }

  const hosts = /** @type {unknown} */ (chrome.host_permissions);

  if (!Array.isArray(hosts) || !hosts.every((host) => typeof host === 'string')) {
    throw new Error('The Chrome manifest has no host permissions.');
  }

  const { key: _key, externally_connectable: _pages, permissions, ...kept } = chrome;
  const firefoxPermissions = Array.isArray(permissions) ? permissions.filter((permission) => !CHROME_PERMISSIONS.includes(permission)) : [];

  return {
    ...kept,
    ...(firefoxPermissions.length === 0 ? {} : { permissions: firefoxPermissions }),
    version: `${chrome.version}.${build}`,
    background: { scripts: [background.service_worker] },
    // Broad website access is only needed by Chrome's embedded tabs.
    host_permissions: [...new Set([...(hosts.some((host) => host === 'http://*/*' || host === 'https://*/*') ? ['http://127.0.0.1/*'] : []), ...hosts.filter((host) => !['http://*/*', 'https://*/*', 'https://github.com/*', 'http://localhost/*'].includes(host)).map((host) => host.replace(/^([a-z]+:\/\/[^/:]+):\d+\//, '$1/'))])],
    browser_specific_settings: {
      gecko: { id: GECKO_ID, strict_min_version: MIN_VERSION, data_collection_permissions: { required: ['none'] } },
    },
  };
}

/**
 * The build number at a time: whole minutes since 2026-01-01 UTC.
 * @param {number} now
 * @returns {number}
 */
export function buildNumber(now) {
  return Math.floor((now - BUILD_EPOCH) / 60_000);
}

/** The GitHub release tag of a signed version. */
const RELEASE_TAG = /^firefox-v(\d+(?:\.\d+)*)$/;

/**
 * The GitHub release tag of a signed version.
 * @param {string} version
 * @returns {string}
 */
export function releaseTag(version) {
  return `firefox-v${version}`;
}

/**
 * The signed versions among GitHub release tags; other tags are ignored.
 * @param {string[]} tags
 * @returns {string[]}
 */
export function releasedVersions(tags) {
  return tags.flatMap((tag) => RELEASE_TAG.exec(tag)?.slice(1) ?? []);
}

/**
 * Why addons.mozilla.org would refuse to sign `version`, given the versions already released, or null. It signs each version once,
 * and a version lower than the last signed one would not update an installed copy.
 * @param {string} version
 * @param {string[]} signedVersions
 * @returns {string | null}
 */
export function signingRefusal(version, signedVersions) {
  if (signedVersions.includes(version)) {
    return `Version ${version} is already signed. Builds in the same minute get the same version: wait a minute and sign again.`;
  }

  const newer = signedVersions.find((signed) => compareVersions(signed, version) > 0);

  return newer === undefined ? null : `Version ${version} is lower than the signed version ${newer}. Check the clock.`;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

/**
 * The content CSS with the codicon font loaded from the extension's own URL in Firefox.
 * @param {string} css
 * @returns {string}
 */
export function firefoxCss(css) {
  if (!css.includes(CHROME_FONT)) {
    throw new Error(`content.css no longer loads the font from ${CHROME_FONT}.`);
  }

  return css.replaceAll(CHROME_FONT, "url('moz-extension://__MSG_@@extension_id__/codicon.ttf')");
}
