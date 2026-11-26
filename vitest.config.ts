import { defineConfig } from 'vitest/config';

// Every workspace's tests in one run, sharing one pool of workers (npm run test:unit). Each workspace's own config
// still applies; `npm test --workspace <name>` runs one workspace alone, with coverage.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/hub', 'extensions/*'],
  },
});
