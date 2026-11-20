import { defineConfig } from 'vitest/config';
import { testTemp } from '../../tools/vitest-temp.js';

export default defineConfig({
  test: {
    env: testTemp(),
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts runs only as the built voice process, and decibri.ts loads the native playback module.
      exclude: ['src/index.ts', 'src/main.ts', 'src/decibri.ts'],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
    },
  },
});
