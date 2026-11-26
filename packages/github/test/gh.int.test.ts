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
