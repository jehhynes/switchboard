import { readRoutes, REMOTE_FILE } from './hub.js';
import { iframeEnabled, iframePage } from './iframe.js';
import { IframeHostController } from './iframeHostView.js';
const app = document.querySelector<HTMLIFrameElement>('#app')!;
const browser = document.querySelector<HTMLIFrameElement>('#browser')!;
const note = document.querySelector<HTMLElement>('#note')!;
const origin = new URL(location.href).searchParams.get('origin');
const controller = new IframeHostController({
  origin: origin ?? '',
  appWindow: () => app.contentWindow,
  now: Date.now,
  viewport: () => ({ width: innerWidth, height: innerHeight }),
  title: (value) => {
    document.title = `${value} (iframe experiment)`;
  },
  leave: () => location.replace(`${origin}/page/`),
  show: (view) => {
    browser.hidden = view === null;
    if (view === null) return;
    Object.assign(browser.style, { left: `${view.left}px`, top: `${view.top}px`, width: `${view.width}px`, height: `${view.height}px` });
    if (browser.getAttribute('src') !== view.url || view.reload) browser.src = view.url;
  },
});
window.addEventListener('message', (event) => controller.message(event));
setInterval(() => controller.tick(), 5_000);
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
  app.src = `${origin}/page/`;
  app.hidden = false;
  note.hidden = true;
})();
