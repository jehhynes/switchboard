import { loadConsole, loadDiff, loadMermaid, startPage } from './main.js';

// The page started: the boot screen in index.html (src/boot.js) gives way to the page's own.
(window as unknown as { switchboardStarted: boolean }).switchboardStarted = true;
document.getElementById('boot')?.remove();

startPage(document.getElementById('root')!, {
  fetch: (...args) => fetch(...args),
  EventSource,
  now: Date.now,
  loadMermaid,
  loadConsole,
  loadDiff,
  build: document.querySelector<HTMLMetaElement>('meta[name="switchboard-build"]')?.content || null,
  reload: () => location.reload(),
});

// The installed page's shell (architecture.md § Web page, App shell); a browser without service workers, or a refused one, loads the page from the hub each time.
void navigator.serviceWorker?.register('/page/sw.js', { scope: '/page/' }).catch(() => {});
