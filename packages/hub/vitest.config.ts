import { defineConfig } from 'vitest/config';
import { testTemp } from '../../tools/vitest-temp.js';
import { ciTimeouts } from '../../tools/vitest-timeouts.js';

export default defineConfig({
  test: {
    env: testTemp(),
    ...ciTimeouts,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
    },
  },
});
