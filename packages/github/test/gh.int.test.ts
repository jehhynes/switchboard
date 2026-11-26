import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnGh } from '../src/gh.js';

describe('spawnGh', () => {
  it('reports a missing executable', async () => {
    expect(await spawnGh('D:/no/such/gh.exe')('query', {})).toEqual({ error: 'The GitHub CLI was not found at D:/no/such/gh.exe. Install it or set ghPath in the source\'s settings.' });
  });

  it("passes gh's error output through", async () => {
    // Node stands in for gh and fails on the unknown script "api".
    expect(await spawnGh(process.execPath)('query', {})).toEqual({ error: expect.stringMatching(/Cannot find module .*api/) });
  });
});

describe.runIf(process.platform !== 'win32')('spawnGh', () => {
  it('stops gh when its signal aborts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-'));
    const slow = join(dir, 'gh');

    writeFileSync(slow, '#!/bin/sh\nsleep 10\n');
    chmodSync(slow, 0o755);

    const controller = new AbortController();
    const started = Date.now();
    const answer = spawnGh(slow)('query { viewer { login } }', {}, controller.signal);

    setTimeout(() => controller.abort(), 50);
    expect(await answer).toEqual({ error: 'Stopped before GitHub answered.' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('answers gh output as JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-'));
    const fake = join(dir, 'gh');

    writeFileSync(fake, '#!/bin/sh\necho \'{"data":{"ok":true}}\'\n');
    chmodSync(fake, 0o755);
    expect(await spawnGh(fake)('query { ok }', {})).toEqual({ json: { data: { ok: true } } });
  });
});
