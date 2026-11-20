import { loadMermaid, startPage } from './main.js';

startPage(document.getElementById('root')!, { fetch: (...args) => fetch(...args), EventSource, now: Date.now, loadMermaid });
