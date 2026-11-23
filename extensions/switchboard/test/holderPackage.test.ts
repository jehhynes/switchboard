import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { describeBuiltPrograms } from '../../../apps/hub/test/builtPrograms.js';

// The packaged extension, extracted outside the checkout so no node_modules of the repository can be reached; npm run build writes dist.
const EXTENSION = join(import.meta.dirname, '..');
let root: string;
let extracted: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'holder-package-'));

  const vsix = join(root, 'switchboard.vsix');

  execFileSync(process.execPath, [join(EXTENSION, '..', '..', 'node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '--out', vsix], { cwd: EXTENSION, stdio: 'ignore' });
  extracted = join(root, 'vsix');
  mkdirSync(extracted);

  if (process.platform === 'win32') {
    execFileSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', vsix, '-C', extracted]);
  } else {
    execFileSync('unzip', ['-q', vsix, '-d', extracted]);
  }
}, 120_000);

afterAll(() => {
  // Windows releases a loaded native module's file a moment after its process exits.
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describeBuiltPrograms(() => join(extracted, 'extension', 'dist'), () => root);
