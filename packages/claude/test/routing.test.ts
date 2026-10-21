import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeRouting } from '../src/routing.js';

let dir: string;
const settingsWith = (text: string): string => {
  const path = join(dir, 'settings.json');
  writeFileSync(path, text);
  return path;
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-routing-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('claudeRouting', () => {
  it('keeps the endpoint, credential and network variables, and no model or provider choices', () => {
    const path = settingsWith(JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318', ANTHROPIC_AUTH_TOKEN: 'key', HTTPS_PROXY: 'http://proxy:3128', NODE_EXTRA_CA_CERTS: 'C:/ca.pem',
        ANTHROPIC_MODEL: 'claude-opus-5-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'x', CLAUDE_CODE_USE_BEDROCK: '1', ENABLE_LSP_TOOL: '1', ANTHROPIC_API_KEY: 5,
      },
      permissions: {},
    }));

    expect(claudeRouting(path)).toEqual({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318', ANTHROPIC_AUTH_TOKEN: 'key', HTTPS_PROXY: 'http://proxy:3128', NODE_EXTRA_CA_CERTS: 'C:/ca.pem' } });
  });

  it('has no variables when the file is missing or has no env', () => {
    expect(claudeRouting(join(dir, 'missing.json'))).toEqual({ env: {} });
    expect(claudeRouting(settingsWith('{}'))).toEqual({ env: {} });
    expect(claudeRouting(settingsWith('{"env":["ANTHROPIC_BASE_URL"]}'))).toEqual({ env: {} });
  });

  it('fails when the file cannot be read or is not JSON, without quoting its contents', () => {
    expect(claudeRouting(dir)).toEqual({ error: expect.stringMatching(/^Claude's settings at .+ could not be read/) });
    const result = claudeRouting(settingsWith('{ "env": { "ANTHROPIC_AUTH_TOKEN": sk-secret-value } }'));
    expect(result).toEqual({ error: expect.stringMatching(/^Claude's settings at .+ are not valid JSON\.$/) });
    expect(JSON.stringify(result)).not.toContain('sk-secret');
  });
});
