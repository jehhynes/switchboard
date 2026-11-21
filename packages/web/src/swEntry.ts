import { startWorker } from './sw.js';

startWorker(self as unknown as Parameters<typeof startWorker>[0], caches, (request) => fetch(request));
