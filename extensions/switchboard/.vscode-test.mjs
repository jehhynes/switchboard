import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

// `test-integration/run.mjs` creates these directories and removes them after the window exits.
const home = process.env.SWITCHBOARD_TEST_HOME;
const profile = process.env.SWITCHBOARD_TEST_PROFILE;
const portable = process.env.SWITCHBOARD_TEST_PORTABLE;

if (!home || !profile || !portable) {
  throw new Error('Run the integration suite with `npm run test:integration`, which creates its own home.');
}

export default defineConfig({
  label: 'integration',
  files: 'test-integration/**/*.test.cjs',
  workspaceFolder: './test-integration/workspace',
  launchArgs: [`--user-data-dir=${profile}`, `--extensions-dir=${join(profile, 'extensions')}`],
  // The extension reads os.homedir(); an isolated home keeps the test hub away from the developer's.
  env: { USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), SWITCHBOARD_TEST_HOME: home, VSCODE_PORTABLE: portable },
  mocha: { timeout: 60_000, ui: 'bdd' },
});
