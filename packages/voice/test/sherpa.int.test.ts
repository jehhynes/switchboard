import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cudaPaths, gpuCheck } from '../src/sherpa.js';

describe('gpuCheck', () => {
  it('runs the check script with the CUDA runtime first on its PATH, and says so when the script is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gpucheck-'));
    const paths = { ...cudaPaths(dir), dlls: join(dir, 'dlls') };

    try {
      writeFileSync(join(dir, 'check.js'), `process.stdout.write(process.env.PATH.split(${JSON.stringify(delimiter)})[0] === ${JSON.stringify(paths.dlls)} && process.argv.includes('--model=' + ${JSON.stringify(paths.checkModel)}) ? 'ok' : 'wrong')`);
      expect(gpuCheck(join(dir, 'check.js'))(paths)).toBeNull();
      expect(process.env.PATH?.startsWith(paths.dlls)).toBe(false);
      expect(gpuCheck(join(dir, 'none.js'))(paths)).toBe(`no GPU check script at ${join(dir, 'none.js')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
