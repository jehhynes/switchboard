import { defineConfig } from 'vitest/config';
import { lowPriority } from '../../tools/low-priority.mjs';
import { testTemp } from '../../tools/vitest-temp.js';
import { ciTimeouts } from '../../tools/vitest-timeouts.js';

lowPriority();

// The extension's behavior is tested in extensions/chrome; this package tests only what the Firefox build changes.
export default defineConfig({
  test: {
    env: testTemp(),
    ...ciTimeouts,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.mjs'],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
    },
  },
});
