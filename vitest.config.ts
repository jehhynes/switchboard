import { defineConfig } from 'vitest/config';
import { lowPriority } from './tools/low-priority.mjs';

lowPriority();

// Every workspace's tests in one run (npm run test:unit). Each workspace's own config still applies; `npm test --workspace <name>`
// runs one workspace alone, with coverage.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/hub', 'extensions/*'],
    // Per pool: the projects use two, forks and vmForks, which run at once. Vitest's default of one worker per core but one, per
    // pool, starts about twice as many workers as cores; on 24 cores they spent three times the CPU time of 8 per pool, loading
    // modules and jsdom, and finished no sooner.
    maxWorkers: '33%',
  },
});
