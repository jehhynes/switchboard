// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PANE_EXTENSION_ID } from '@switchboard/core';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8')) as { key: string; externally_connectable: { matches: string[] } };

describe('manifest', () => {
  it('has the key whose ID the hub’s pane socket accepts', () => {
    // Chrome's ID is the first 32 hex digits of the key's SHA-256, each digit written as a letter from a to p.
    const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');

    expect(id).toBe(PANE_EXTENSION_ID);
  });

  it('lets only loopback pages message the extension', () => {
    expect(manifest.externally_connectable.matches).toEqual(['http://127.0.0.1/*', 'http://localhost/*']);
  });
});
