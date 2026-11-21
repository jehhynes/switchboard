import { waitForHub } from './offline.js';

waitForHub({ fetch: (url) => fetch(url, { cache: 'no-store' }), reload: () => location.reload(), setTimeout: (run, ms) => setTimeout(run, ms) });
