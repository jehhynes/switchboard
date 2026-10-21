import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecResult } from '@switchboard/core';
import { classifyCodex } from '../src/classifier.js';
import type { CodexClassifyInput } from '../src/classifier.js';

let home: string;
let configDir: string;
let input: CodexClassifyInput;
const ok: ExecResult = { code: 0, stdout: readFileSync(join(import.meta.dirname, 'fixtures/classifier-output.jsonl'), 'utf8'), stderr: '', missing: false, timedOut: false };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'triage-codex-'));
  configDir = mkdtempSync(join(tmpdir(), 'triage-codex-config-'));
  input = { codexPath: 'custom-codex', env: { CODEX_HOME: join(home, 'auth') }, configPath: join(configDir, 'config.toml'), cwd: home, systemPrompt: 'Classify.', choices: [{ name: 'dev:build', description: 'Build', focus: null }], rates: true, focusIds: ['ticket'], context: '[ticket] Fix a typo.', model: null, timeoutSeconds: 12 };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe('classifyCodex', () => {
  it('runs isolated ephemeral triage with stdin, a strict schema, the configured environment and timeout', async () => {
    const result = await classifyCodex(input, async (file, args, options) => {
      expect(file).toBe('custom-codex');
      expect(args).toEqual(['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"', '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'hooks', '--output-schema', join(options.cwd!, 'schema.json'), '--output-last-message', join(options.cwd!, 'answer.json'), '-']);
      expect(options.env).toEqual({ CODEX_HOME: join(home, 'auth') });
      expect(options.timeoutMs).toBe(12000);
      expect(options.stdin).toContain('Classify.');
      expect(options.stdin).toContain('[ticket] Fix a typo.');
      const schema = JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1]!, 'utf8'));
      expect(schema.required).toEqual(['playbook', 'focus', 'immediacy', 'severity']);
      expect(schema.additionalProperties).toBe(false);
      writeFileSync(args[args.indexOf('--output-last-message') + 1]!, '{"playbook":"dev:build","immediacy":"NON-BLOCKING","severity":"LOW","focus":"ticket"}');
      return ok;
    });
    expect(result).toEqual({ playbook: 'dev:build', immediacy: 'NON-BLOCKING', severity: 'LOW', focus: 'ticket' });
    expect(readdirSync(home)).toEqual([]);
  });
  it("keeps the model endpoint from config.toml ahead of the classifier's own overrides", async () => {
    writeFileSync(input.configPath, 'model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:8319/v1"\n');
    await classifyCodex(input, async (_file, args) => {
      expect(args.slice(6, 14)).toEqual(['-c', 'model_provider="openai"', '-c', 'openai_base_url="http://127.0.0.1:8319/v1"', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"']);
      writeFileSync(args[args.indexOf('--output-last-message') + 1]!, '{"playbook":"dev:build","immediacy":"NON-BLOCKING","severity":"LOW","focus":"ticket"}');
      return ok;
    });
  });
  it('fails without running Codex when config.toml cannot be read', async () => {
    let ran = false;
    expect(await classifyCodex({ ...input, configPath: configDir }, async () => {
      ran = true;
      return ok;
    })).toEqual({ error: expect.stringMatching(/^Codex's config at .+ could not be read/) });
    expect(ran).toBe(false);
  });
  it('passes an explicit model and accepts an unrated result', async () => {
    expect(await classifyCodex({ ...input, model: 'custom-model', rates: false, focusIds: [] }, async (_file, args) => {
      expect(args.slice(-3)).toEqual(['--model', 'custom-model', '-']);
      writeFileSync(args[args.indexOf('--output-last-message') + 1]!, '{"playbook":"dev:build"}');
      return ok;
    })).toEqual({ playbook: 'dev:build', immediacy: null, severity: null, focus: null });
  });
  it.each([
    [{ ...ok, missing: true }, 'custom-codex was not found. Install Codex or set its path.'],
    [{ ...ok, timedOut: true }, 'Codex did not finish triage within 12 seconds.'],
    [{ ...ok, stdout: '{"type":"turn.failed","error":{"message":"Quota exhausted"}}' }, 'Codex did not finish triage: Quota exhausted'],
    [{ ...ok, code: 1, stderr: 'API refused' }, 'API refused'],
    [{ ...ok, code: 1 }, 'Codex did not finish triage (exit code 1).'],
    [{ ...ok, stdout: '' }, 'Codex did not finish triage (exit code 0).'],
    [ok, 'Codex returned no valid JSON triage result.'],
  ] as const)('reports CLI failures and missing output, then removes temporary files (%j)', async (output, error) => {
    expect(await classifyCodex(input, async () => output)).toEqual({ error });
    expect(readdirSync(home)).toEqual([]);
  });
  it.each(['bad json', 'null', '{}', '{"playbook":"unknown"}'])('rejects an invalid result %s', async (answer) => {
    const result = await classifyCodex(input, async (_file, args) => {
      writeFileSync(args[args.indexOf('--output-last-message') + 1]!, answer);
      return ok;
    });
    expect(result).toHaveProperty('error');
    expect(readdirSync(home)).toEqual([]);
  });
  it('cleans temporary files after a spawn exception', async () => {
    await expect(classifyCodex(input, async () => { throw new Error('spawn failed'); })).rejects.toThrow('spawn failed');
    expect(readdirSync(home)).toEqual([]);
  });
});
