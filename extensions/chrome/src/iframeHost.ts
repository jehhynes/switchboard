import { HostStartup } from './hostStartup.js';
import { readRoutes, REMOTE_FILE } from './hub.js';
import { iframeAccess, iframePage } from './iframe.js';
import { HostFocus } from './hostFocus.js';
import { consumeSelection } from './iframeSelection.js';
import { IframeFrames } from './iframeFrames.js';
import { IframeHostController } from './iframeHostView.js';
const app = document.querySelector<HTMLIFrameElement>('#app')!;
const frames = new IframeFrames(document.body);
const note = document.querySelector<HTMLElement>('#note')!;
const origin = new URL(location.href).searchParams.get('origin');
let startup: HostStartup | null = null;
const controller = new IframeHostController({
  origin: origin ?? '',
  appWindow: () => app.contentWindow,
  now: Date.now,
  viewport: () => ({ width: innerWidth, height: innerHeight }),
  title: (value) => {
    document.title = value;
  },
  leave: () => void startup?.leave(),
  show: (view) => frames.show(view),
  reconcile: (item, urls) => frames.reconcile(item, urls),
});
let appLoaded = false;
function selectFromHash(): void {
  if (origin === null || !appLoaded) return;
  consumeSelection(location.href, (selection) => app.contentWindow?.postMessage({ type: 'switchboard-iframe-select', ...selection }, origin), (url) => history.replaceState(null, '', url));
}
app.addEventListener('load', () => {
  if (app.getAttribute('src') === null) return;
  appLoaded = true;
  selectFromHash();
  reportFocus(true);
});
window.addEventListener('hashchange', selectFromHash);
window.addEventListener('message', (event) => controller.message(event));
setInterval(() => controller.tick(), 5_000);
const focus = new HostFocus(
  () => appLoaded && !app.hidden && document.visibilityState !== 'hidden' && document.hasFocus(),
  (focused) => { if (origin !== null) app.contentWindow?.postMessage({ type: 'switchboard-iframe-focus', focused }, origin); },
);
const reportFocus = (force = false): void => focus.report(force);
setInterval(() => reportFocus(), 250);
window.addEventListener('focus', () => reportFocus());
window.addEventListener('blur', () => setTimeout(() => reportFocus(), 0));
document.addEventListener('visibilitychange', () => reportFocus());
const resume = (): void => {
  if (document.visibilityState !== 'hidden' && origin !== null) app.contentWindow?.postMessage({ type: 'switchboard-iframe-resume' }, origin);
};
window.addEventListener('focus', resume);
document.addEventListener('visibilitychange', resume);
void (async () => {
  const routes = await readRoutes((url) => fetch(url), chrome.runtime.getURL(REMOTE_FILE));
  if (origin === null || iframePage(`${origin}/page/`, routes.origin) !== origin) {
    note.textContent = 'This is not a configured Switchboard hub. Open the app from its signed-in page.';
    return;
  }
  const saved = `iframe-host:${origin}`;
  startup = new HostStartup({
    probe: () => iframeAccess((url) => fetch(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(3_000) }), origin, routes.origin),
    remembered: async () => (await chrome.storage.local.get(saved))[saved] === true,
    remember: async (value) => value ? chrome.storage.local.set({ [saved]: true }) : chrome.storage.local.remove(saved),
    authority: (enabled) => enabled ? controller.allow() : controller.block(),
    shell: (visible) => {
      if (visible && app.getAttribute('src') === null) {
        const workItemId = new URLSearchParams(location.hash.slice(1)).get('workItemId');
        app.src = `${origin}/page/${workItemId !== null && /^[1-9]\d*$/.test(workItemId) ? `#w=${workItemId}&t=browser` : ''}`;
      }
      app.hidden = !visible;
    },
    note: (text) => { note.textContent = text ?? ''; note.hidden = text === null; },
    leave: () => location.replace(`${origin}/page/`),
  });
  await startup.check();
  setInterval(() => void startup?.check(), 5_000);
  window.addEventListener('online', () => void startup?.check());
})();
