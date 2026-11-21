import { loadMermaid, startPage } from './main.js';

startPage(document.getElementById('root')!, {
  fetch: (...args) => fetch(...args),
  EventSource,
  now: Date.now,
  loadMermaid,
  build: document.querySelector<HTMLMetaElement>('meta[name="switchboard-build"]')?.content || null,
  reload: () => location.reload(),
});

// The installed page's offline page (architecture.md § Web page); a browser without service workers, or a refused one, shows the page without it.
void navigator.serviceWorker?.register('/page/sw.js', { scope: '/page/' }).catch(() => {});
