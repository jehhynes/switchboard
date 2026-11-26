import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnGh } from '../src/gh.js';

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
