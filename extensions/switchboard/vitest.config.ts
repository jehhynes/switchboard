import { defineConfig } from 'vitest/config';
import { testTemp } from '../../tools/vitest-temp.js';

// Package logic and webview DOM run here; vscode wiring runs in the real-host suite (test-integration).
export default defineConfig({
  test: {
    env: testTemp(),
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      exclude: ['src/webview/mermaidPreviewMain.ts'],
      include: ['src/webview/**/*.ts', 'src/changes.ts', 'src/search.ts', 'src/tabs.ts', 'src/claims.ts', 'src/hubLog.ts', 'src/paneModel.ts', 'src/sideBars.ts', 'src/conversationModel.ts', 'src/links.ts', 'src/artifactModel.ts', 'src/markdownMermaid.ts'],
      thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 },
    },
  },
});
