/** The add-on ID, which Firefox needs for `storage` and which keeps one installed copy across reinstalls. */
export const GECKO_ID = 'switchboard@switchboard';

/** The first Firefox with `tabGroups` and `data_collection_permissions`. */
export const MIN_VERSION = '140.0';

const CHROME_FONT = "url('chrome-extension://__MSG_@@extension_id__/codicon.ttf')";

/**
 * The Chrome manifest changed for Firefox, which runs a background script instead of a service worker, needs an add-on ID, and
 * matches nothing with a match pattern that has a port, so the hub's host permission covers every port of its host (mechanics M42).
 * @param {Record<string, unknown>} chrome
 * @returns {Record<string, unknown>}
 */
export function firefoxManifest(chrome) {
  const background = /** @type {{ service_worker?: unknown } | undefined} */ (chrome.background);

  if (typeof background?.service_worker !== 'string') {
    throw new Error('The Chrome manifest has no background service worker.');
  }

  const hosts = /** @type {unknown} */ (chrome.host_permissions);

  if (!Array.isArray(hosts) || !hosts.every((host) => typeof host === 'string')) {
    throw new Error('The Chrome manifest has no host permissions.');
  }

  return {
    ...chrome,
    background: { scripts: [background.service_worker] },
    host_permissions: hosts.map((host) => host.replace(/^([a-z]+:\/\/[^/:]+):\d+\//, '$1/')),
    browser_specific_settings: {
      gecko: { id: GECKO_ID, strict_min_version: MIN_VERSION, data_collection_permissions: { required: ['none'] } },
    },
  };
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
