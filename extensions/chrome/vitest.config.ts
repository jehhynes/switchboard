import { defineConfig } from 'vitest/config';
import { testTemp } from '../../tools/vitest-temp.js';

// Board DOM and hub reads run in jsdom; main.ts and background.ts only wire them to Chrome.
export default defineConfig({
  test: {
    env: testTemp(),
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/background.ts', 'src/panePage.ts', 'src/iframeHost.ts', 'src/chrome.d.ts'],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
    },
  },
});
