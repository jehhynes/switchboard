import { defineConfig } from 'vitest/config';
import { testTemp } from '../../tools/vitest-temp.js';

// The page's model and DOM run in jsdom; the hub's routes are tested in packages/hub.
export default defineConfig({
  // The page's .tsx parts are Preact components, compiled as build.mjs compiles them.
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    env: testTemp(),
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // The browser's entry points have nothing to run.
      exclude: ['src/entry.ts', 'src/swEntry.ts', 'src/offlineEntry.ts', 'src/consoleEntry.ts'],
      thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 },
    },
  },
});
