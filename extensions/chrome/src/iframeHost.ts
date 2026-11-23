import { readRoutes, REMOTE_FILE } from './hub.js';
import { iframeEnabled, iframePage } from './iframe.js';
import { HostFocus } from './hostFocus.js';
import { consumeSelection } from './iframeSelection.js';
import { IframeFrames } from './iframeFrames.js';
import { IframeHostController } from './iframeHostView.js';
const app = document.querySelector<HTMLIFrameElement>('#app')!;
const frames = new IframeFrames(document.body);
const note = document.querySelector<HTMLElement>('#note')!;
const origin = new URL(location.href).searchParams.get('origin');
const controller = new IframeHostController({
  origin: origin ?? '',
  appWindow: () => app.contentWindow,
  now: Date.now,
  viewport: () => ({ width: innerWidth, height: innerHeight }),
  title: (value) => {
    document.title = value;
  },
  leave: () => location.replace(`${origin}/page/`),
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
  () => appLoaded && document.visibilityState !== 'hidden' && document.hasFocus(),
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
  if (
    origin === null ||
    iframePage(`${origin}/page/`, routes.origin) !== origin ||
    !(await iframeEnabled((url) => fetch(url, { credentials: 'include', cache: 'no-store' }), origin, routes.origin))
  ) {
    note.textContent = 'Sign in to the Switchboard page and enable the GitHub iframe experiment, then reopen it from that page.';
    return;
  }
  controller.allow();
  const workItemId = new URLSearchParams(location.hash.slice(1)).get('workItemId');
  app.src = `${origin}/page/${workItemId !== null && /^[1-9]\d*$/.test(workItemId) ? `#w=${workItemId}&t=browser` : ''}`;
  app.hidden = false;
  note.hidden = true;
})();
