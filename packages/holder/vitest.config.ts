import { defineConfig } from 'vitest/config';
import { testTemp } from '../../tools/vitest-temp.js';

export default defineConfig({
  test: {
    env: testTemp(),
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts runs only in the built holder, which test/built.int.test.ts spawns.
      exclude: ['src/index.ts', 'src/main.ts'],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
    },
  },
});
