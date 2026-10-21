import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { classifierArgs, classifierPrompt, classify, parseClassifierOutput } from '../src/classifier.js';
import type { ClassifyInput } from '../src/classifier.js';
import type { Exec, ExecResult } from '../src/exec.js';

const OUTPUT = readFileSync(join(import.meta.dirname, 'fixtures', 'classifier-output.json'), 'utf8');
const CHOICES = [
  { name: 'dev:develop', description: 'Build a change', focus: null },
  { name: 'dev:question', description: 'Answer a question', focus: null },
];
const INPUT: ClassifyInput = { claudePath: 'claude', settingsPath: join(tmpdir(), 'switchboard-no-such-dir', 'settings.json'), systemPrompt: 'Classify the issue.\n\nChoose one playbook:\n- dev:develop: Build a change\n- dev:question: Answer a question\n', choices: CHOICES, rates: false, focusIds: [], context: 'Issue #1 text', model: 'claude-sonnet-5', timeoutSeconds: 180, cwd: 'C:/home/.switchboard' };
const SCHEMA =
  '{"type":"object","properties":{"playbook":{"type":"string","enum":["dev:develop","dev:question"]}},' +
  '"required":["playbook"],"additionalProperties":false}';
const RATED_SCHEMA =
  '{"type":"object","properties":{"playbook":{"type":"string","enum":["dev:develop","dev:question"]},' +
  '"immediacy":{"type":"string","enum":["URGENT","BLOCKING","NON-BLOCKING"]},"severity":{"type":"string","enum":["HIGH","MED","LOW"]}},' +
  '"required":["playbook"],"additionalProperties":false}';

const ran = (patch: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...patch });

describe('classifierArgs', () => {
  it('runs one-shot with no tools, settings, MCP servers or transcript', () => {
    expect(classifierArgs(INPUT)).toEqual([
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      SCHEMA,
      '--no-session-persistence',
      '--setting-sources',
      '',
      '--tools',
      '',
      '--strict-mcp-config',
      '--system-prompt',
      'Classify the issue.\n\nChoose one playbook:\n- dev:develop: Build a change\n- dev:question: Answer a question\n\nThe ticket follows as the user message.',
      '--model',
      'claude-sonnet-5',
    ]);
    expect(classifierArgs({ ...INPUT, model: null }).at(-1)).toBe(classifierPrompt(INPUT.systemPrompt, false));
  });

  it('offers immediacy and severity only to a rating playbook', () => {
    expect(classifierArgs({ ...INPUT, rates: true })[4]).toBe(RATED_SCHEMA);
  });

  it("offers the context's anchor ids as the focus, and no focus without them (PRD R79)", () => {
    expect(JSON.parse(classifierArgs({ ...INPUT, focusIds: ['ticket', 'pr', 'c1'] })[4]!).properties.focus).toEqual({ type: 'string', enum: ['ticket', 'pr', 'c1'] });
    expect(JSON.parse(classifierArgs(INPUT)[4]!).properties).not.toHaveProperty('focus');
  });

  it('tells the classifier how to choose the focus only when the context tags anchors (PRD R79)', () => {
    expect(classifierArgs({ ...INPUT, focusIds: ['ticket', 'c1'] }).at(-3)).toBe(
      'Classify the issue.\n\nChoose one playbook:\n- dev:develop: Build a change\n- dev:question: Answer a question\n\n' +
        "Set focus to the bracketed id, such as c3, of the page or comment the operator should read first to do the chosen playbook's work; when several comments ask for that work, choose the earliest. " +
        'A playbook marked (page: ...) is done on that page, so choose a comment on it, or the page itself.\n\nThe ticket follows as the user message.',
    );
    expect(classifierArgs(INPUT).at(-3)).not.toContain('focus');
  });
});

describe('parseClassifierOutput', () => {
  it('reads structured_output from recorded CLI output', () => {
    expect(parseClassifierOutput(OUTPUT, CHOICES, true, [])).toEqual({
      playbook: 'dev:develop',
      immediacy: null,
      severity: null,
      focus: null,
    });
  });

  it('reads a focus among the ids, and drops one outside them without failing (PRD R79)', () => {
    const focused = (focus: unknown) => JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:question', focus } });

    expect(parseClassifierOutput(focused('c2'), CHOICES, false, ['ticket', 'c1', 'c2'])).toEqual({ playbook: 'dev:question', immediacy: null, severity: null, focus: 'c2' });
    expect(parseClassifierOutput(focused('c9'), CHOICES, false, ['ticket', 'c1', 'c2'])).toEqual({ playbook: 'dev:question', immediacy: null, severity: null, focus: null });
    expect(parseClassifierOutput(focused(3), CHOICES, false, ['ticket'])).toMatchObject({ focus: null });
  });

  const rated = (rating: Record<string, unknown>) => JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:question', ...rating } });

  it('reads a rating, and drops a value outside the enum', () => {
    expect(parseClassifierOutput(rated({ immediacy: 'BLOCKING', severity: 'HIGH' }), CHOICES, true, [])).toEqual({ playbook: 'dev:question', immediacy: 'BLOCKING', severity: 'HIGH', focus: null });
    expect(parseClassifierOutput(rated({ immediacy: 'SOON', severity: 'LOW' }), CHOICES, true, [])).toEqual({ playbook: 'dev:question', immediacy: null, severity: 'LOW', focus: null });
  });

  it('drops a rating from a playbook that does not rate', () => {
    expect(parseClassifierOutput(rated({ immediacy: 'BLOCKING', severity: 'MED' }), CHOICES, false, [])).toEqual({ playbook: 'dev:question', immediacy: null, severity: null, focus: null });
  });

  it.each([
    ['not JSON', 'oops', 'Claude returned output that is not JSON.'],
    ['an error body', JSON.stringify({ is_error: true, subtype: 'error_max_turns', result: 'limit' }), 'Claude did not finish triage (error_max_turns): limit'],
    ['no structured output', JSON.stringify({ subtype: 'success', result: 'text' }), 'Claude returned no playbook.'],
    ['an unknown playbook', JSON.stringify({ subtype: 'success', structured_output: { playbook: 'support:defect' } }), 'Triage chose an unknown playbook: support:defect.'],
  ])('fails on %s', (_case, stdout, error) => {
    expect(parseClassifierOutput(stdout, CHOICES, false, [])).toEqual({ error });
  });
});

describe('classify', () => {
  it('sends the context on stdin in the given directory', async () => {
    const exec = vi.fn<Exec>(async () => ran({ stdout: OUTPUT }));

    expect(await classify(INPUT, exec)).toMatchObject({ playbook: 'dev:develop' });
    expect(exec).toHaveBeenCalledWith('claude', classifierArgs(INPUT), { cwd: 'C:/home/.switchboard', stdin: 'Issue #1 text', timeoutMs: 180_000, env: {} });
  });

  it("runs an absolute claude path with its directory first on PATH", async () => {
    const exec = vi.fn<Exec>(async () => ran({ stdout: OUTPUT }));
    const claudePath = join(tmpdir(), 'nvm', 'bin', 'claude');

    await classify({ ...INPUT, claudePath }, exec);

    const env = exec.mock.calls[0]![2].env!;
    expect(env[Object.keys(env).find((name) => name.toUpperCase() === 'PATH')!]!.split(delimiter)[0]).toBe(join(tmpdir(), 'nvm', 'bin'));
  });

  it("passes the routing variables from Claude's user settings, which --setting-sources skips", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-settings-'));
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318', ENABLE_LSP_TOOL: '1' } }));
    const exec = vi.fn<Exec>(async () => ran({ stdout: OUTPUT }));

    try {
      expect(await classify({ ...INPUT, settingsPath }, exec)).toMatchObject({ playbook: 'dev:develop' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(exec.mock.calls[0]![2].env).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318' });
  });

  it('fails without running Claude when its settings are not valid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-settings-'));
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, '{ "env": ');
    const exec = vi.fn<Exec>(async () => ran({ stdout: OUTPUT }));

    try {
      expect(await classify({ ...INPUT, settingsPath }, exec)).toEqual({ error: expect.stringMatching(/^Claude's settings at .+ are not valid JSON\.$/) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(exec).not.toHaveBeenCalled();
  });

  it('fails with the CLI error, a timeout, or a missing CLI', async () => {
    expect(await classify(INPUT, async () => ran({ code: 1, stderr: 'API Error: 529 Overloaded\n' }))).toEqual({ error: 'API Error: 529 Overloaded' });
    expect(await classify(INPUT, async () => ran({ code: null, timedOut: true }))).toEqual({ error: 'claude did not finish within 180 seconds.' });
    expect(await classify({ ...INPUT, cwd: tmpdir() }, async () => ran({ code: null, missing: true }))).toEqual({ error: 'Claude Code was not found at claude. Install it or set sessions.claudePath.' });
    expect(await classify(INPUT, async () => ran({ code: 2 }))).toEqual({ error: 'claude exited with code 2.' });
  });
});
