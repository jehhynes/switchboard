import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexRouting } from '../src/routing.js';

let dir: string;
const configWith = (text: string): string => {
  const path = join(dir, 'config.toml');
  writeFileSync(path, text);
  return path;
};
/** The overrides as Codex reads them: each `key=value` parsed as TOML. */
const asConfig = (args: string[]): Record<string, unknown> =>
  Object.fromEntries(args.filter((_arg, i) => i % 2 === 1).map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), parse(`v = ${pair.slice(at + 1)}`, { integersAsBigInt: true })['v']];
  }));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-routing-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('codexRouting', () => {
  it('carries the selected provider with nested tables and quoted names, and no other provider', () => {
    const path = configWith([
      "model_provider = 'my proxy'",
      'developer_instructions = """',
      'openai_base_url = "http://not-config/v1"',
      '[Rules]',
      '"""',
      '[model_providers."my proxy"]',
      'name = "CLIProxyAPI"',
      'base_url = "http://liberty-linux:8317/v1" # the proxy',
      'request_max_retries = 2',
      '[model_providers."my proxy".http_headers]',
      'Authorization = "Bearer k#1"',
      '[model_providers.other]',
      'base_url = "http://other/v1"',
    ].join('\r\n'));

    const result = codexRouting(path);
    expect(result).toHaveProperty('args');
    const args = (result as { args: string[] }).args;
    expect(args.filter((_arg, i) => i % 2 === 0).every((flag) => flag === '-c')).toBe(true);
    expect(asConfig(args)).toEqual({
      model_provider: 'my proxy',
      model_providers: { 'my proxy': { name: 'CLIProxyAPI', base_url: 'http://liberty-linux:8317/v1', request_max_retries: 2n, http_headers: { Authorization: 'Bearer k#1' } } },
    });
  });

  it('carries a quoted openai_base_url key for the built-in provider', () => {
    const path = configWith('model_provider = "openai"\n"openai_base_url" = "http://127.0.0.1:8319/v1"\n\n[features]\nfoo = true\n');

    expect(codexRouting(path)).toEqual({ args: ['-c', 'model_provider="openai"', '-c', 'openai_base_url="http://127.0.0.1:8319/v1"'] });
  });

  it('carries a provider defined with dotted keys', () => {
    const path = configWith('model_provider = "p"\nmodel_providers.p.base_url = "http://p/v1"\nmodel_providers.p.name = "p"\n');

    expect(asConfig((codexRouting(path) as { args: string[] }).args)).toEqual({ model_provider: 'p', model_providers: { p: { base_url: 'http://p/v1', name: 'p' } } });
  });

  it('writes back control characters, floats and large integers as the values they were', () => {
    const path = configWith([
      'model_provider = "p"',
      '[unrelated]',
      'big = 9007199254740993',
      '[model_providers.p]',
      'name = "a\\u007fb\\tc\\\\d\\"e"',
      'stream_idle_timeout_ms = 9007199254740993',
      'weight = 1e20',
      'ratio = 0.5',
    ].join('\n'));

    const result = codexRouting(path) as { args: string[] };
    expect(asConfig(result.args)).toEqual({
      model_provider: 'p',
      model_providers: { p: { name: 'a\u007fb\tc\\d"e', stream_idle_timeout_ms: 9007199254740993n, weight: 1e20, ratio: 0.5 } },
    });
    expect(result.args.join(' ')).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('carries nothing when the file is missing or names no endpoint', () => {
    expect(codexRouting(join(dir, 'missing.toml'))).toEqual({ args: [] });
    expect(codexRouting(configWith('model = "gpt-6-astra"\n'))).toEqual({ args: [] });
  });

  it('fails when the file cannot be read or is not TOML, without quoting its contents', () => {
    expect(codexRouting(dir)).toEqual({ error: expect.stringMatching(/^Codex's config at .+ could not be read/) });
    const result = codexRouting(configWith('openai_base_url = "http://x/v1\nkey = sk-secret-value\n'));
    expect(result).toEqual({ error: expect.stringMatching(/^Codex's config at .+ is not valid TOML\.$/) });
    expect(JSON.stringify(result)).not.toContain('sk-secret');
  });
});
