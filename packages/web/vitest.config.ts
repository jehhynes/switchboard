import { defineConfig } from 'vitest/config';
import { testTemp } from '../../tools/vitest-temp.js';
import { ciTimeouts } from '../../tools/vitest-timeouts.js';

// The page's model and DOM run in jsdom; the hub's routes are tested in packages/hub.
export default defineConfig({
  // The page's .tsx parts are Preact components, compiled as build.mjs compiles them.
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    env: testTemp(),
    ...ciTimeouts,
    environment: 'jsdom',
    // A fresh context per file in a kept worker: jsdom costs far less to set up there than in a new process.
    pool: 'vmForks',
    // @pierre/diffs loads its themes with a dynamic import, which fails in a vm context, so the diff viewer's tests run in their own process.
    poolMatchGlobs: [['**/test/{changesViewer,diffCacheKeys,diffViewer}.test.ts', 'forks']],
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
