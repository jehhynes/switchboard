import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { classifierArgs, classifierPrompt, classify, parseClassifierOutput } from '../src/classifier.js';
import type { ClassifyInput } from '../src/classifier.js';
import type { Exec, ExecResult } from '../src/exec.js';

const OUTPUT = readFileSync(join(import.meta.dirname, 'fixtures', 'classifier-output.json'), 'utf8');
const CHOICES = [
  { name: 'dev:develop', description: 'Build a change' },
  { name: 'dev:question', description: 'Answer a question' },
];
const INPUT: ClassifyInput = { claudePath: 'claude', systemPrompt: 'Classify the issue.\n\nChoose one playbook:\n- dev:develop: Build a change\n- dev:question: Answer a question\n', choices: CHOICES, context: 'Issue #1 text', model: 'claude-sonnet-5', timeoutSeconds: 180, cwd: 'C:/home/.switchboard' };
const SCHEMA =
  '{"type":"object","properties":{"playbook":{"type":"string","enum":["dev:develop","dev:question"]},"summary":{"type":"string"},' +
  '"immediacy":{"type":"string","enum":["URGENT","BLOCKING","NON-BLOCKING"]},"severity":{"type":"string","enum":["HIGH","MED","LOW"]}},' +
  '"required":["playbook","summary"],"additionalProperties":false}';

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
      'Classify the issue.\n\nChoose one playbook:\n- dev:develop: Build a change\n- dev:question: Answer a question\n\nThe ticket follows as the user message. Summarize it in a few sentences. Set immediacy and severity only when the instructions above ask you to rate the ticket.',
      '--model',
      'claude-sonnet-5',
    ]);
    expect(classifierArgs({ ...INPUT, model: null }).at(-1)).toBe(classifierPrompt(INPUT.systemPrompt));
  });
});

describe('parseClassifierOutput', () => {
  it('reads structured_output from recorded CLI output', () => {
    expect(parseClassifierOutput(OUTPUT, CHOICES)).toEqual({
      playbook: 'dev:develop',
      summary: 'GitHub issue #1 reports a defect: on Safari, clicking the login button does nothing, whereas it is expected to open a dialog. This is a bug fix/change to the build, so the dev:develop playbook applies.',
      immediacy: null,
      severity: null,
    });
  });

  it('reads a rating, and drops a value outside the enum', () => {
    const output = (rating: Record<string, unknown>) => JSON.stringify({ subtype: 'success', structured_output: { playbook: 'dev:question', summary: 's', ...rating } });

    expect(parseClassifierOutput(output({ immediacy: 'BLOCKING', severity: 'HIGH' }), CHOICES)).toEqual({ playbook: 'dev:question', summary: 's', immediacy: 'BLOCKING', severity: 'HIGH' });
    expect(parseClassifierOutput(output({ immediacy: 'SOON', severity: 'LOW' }), CHOICES)).toEqual({ playbook: 'dev:question', summary: 's', immediacy: null, severity: 'LOW' });
  });

  it.each([
    ['not JSON', 'oops', 'Claude returned output that is not JSON.'],
    ['an error body', JSON.stringify({ is_error: true, subtype: 'error_max_turns', result: 'limit' }), 'Claude did not finish triage (error_max_turns): limit'],
    ['no structured output', JSON.stringify({ subtype: 'success', result: 'text' }), 'Claude returned no playbook and summary.'],
    ['an unknown playbook', JSON.stringify({ subtype: 'success', structured_output: { playbook: 'support:defect', summary: 's' } }), 'Triage chose an unknown playbook: support:defect.'],
  ])('fails on %s', (_case, stdout, error) => {
    expect(parseClassifierOutput(stdout, CHOICES)).toEqual({ error });
  });
});

describe('classify', () => {
  it('sends the context on stdin in the given directory', async () => {
    const exec = vi.fn<Exec>(async () => ran({ stdout: OUTPUT }));

    expect(await classify(INPUT, exec)).toMatchObject({ playbook: 'dev:develop' });
    expect(exec).toHaveBeenCalledWith('claude', classifierArgs(INPUT), { cwd: 'C:/home/.switchboard', stdin: 'Issue #1 text', timeoutMs: 180_000 });
  });

  it('fails with the CLI error, a timeout, or a missing CLI', async () => {
    expect(await classify(INPUT, async () => ran({ code: 1, stderr: 'API Error: 529 Overloaded\n' }))).toEqual({ error: 'API Error: 529 Overloaded' });
    expect(await classify(INPUT, async () => ran({ code: null, timedOut: true }))).toEqual({ error: 'claude did not finish within 180 seconds.' });
    expect(await classify(INPUT, async () => ran({ code: null, missing: true }))).toEqual({ error: 'claude was not found. Install Claude Code or set its path.' });
    expect(await classify(INPUT, async () => ran({ code: 2 }))).toEqual({ error: 'claude exited with code 2.' });
  });
});
