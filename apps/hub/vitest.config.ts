import { defineConfig } from 'vitest/config';
import { lowPriority } from '../../tools/low-priority.mjs';
import { testTemp } from '../../tools/vitest-temp.js';

lowPriority();

// Spawn tests run the built entry point; package logic has its own coverage floors.
export default defineConfig({
  test: { env: testTemp(), include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
