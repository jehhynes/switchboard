import { defineConfig } from 'vitest/config';
import { testTemp } from '../../tools/vitest-temp.js';

// The page's model and DOM run in jsdom; the hub's routes are tested in packages/hub.
export default defineConfig({
  test: {
    env: testTemp(),
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The browser's entry points and the protocol's types have nothing to run.
      exclude: ['src/entry.ts', 'src/swEntry.ts', 'src/offlineEntry.ts', 'src/types.ts'],
      thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 },
    },
  },
});
