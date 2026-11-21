import { defineConfig } from 'vitest/config';
import { testTemp } from '../../tools/vitest-temp.js';

// extension.js only wires windows.js to GNOME Shell, which Node cannot load; the live run checks it (testing.md).
export default defineConfig({
  test: {
    env: testTemp(),
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: ['src/extension.js'],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
    },
  },
});
