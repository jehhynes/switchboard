import { classifierPrompt, classifierSchema, validateClassification } from '@switchboard/core';
import type { ClassifyInput as SharedClassifyInput, ClassifyResult } from '@switchboard/core';
import type { TriageChoice } from '@switchboard/core';
import type { Exec } from './exec.js';
import { claudeEnvironment, failureOf } from './exec.js';

export interface ClassifyInput extends SharedClassifyInput {
  claudePath: string;
}

export { classifierPrompt } from '@switchboard/core';
export type { ClassifyResult } from '@switchboard/core';

/** One-shot triage with no tools, settings, MCP servers or saved transcript (mechanics M3). */
export function classifierArgs(input: ClassifyInput): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(classifierSchema(input)),
    '--no-session-persistence',
    // Each variadic option is followed by another flag, so later values are not read as its arguments.
    '--setting-sources',
    '',
    '--tools',
    '',
    '--strict-mcp-config',
    '--system-prompt',
    classifierPrompt(input.systemPrompt, input.focusIds.length > 0),
    ...(input.model === null ? [] : ['--model', input.model]),
  ];
}

/**
 * Reads `structured_output` from `--output-format json`. A body-level error fails even when the process exits 0. Ratings count only when `rates`.
 * A focus outside `focusIds` is dropped, not an error, because the hub falls back to the playbook's page.
 */
export function parseClassifierOutput(stdout: string, choices: TriageChoice[], rates: boolean, focusIds: string[]): ClassifyResult {
  let output: { is_error?: boolean; subtype?: string; result?: string; structured_output?: { playbook?: unknown; immediacy?: unknown; severity?: unknown; focus?: unknown } };

  try {
    output = JSON.parse(stdout);
  } catch {
    return { error: 'Claude returned output that is not JSON.' };
  }

  if (output?.is_error === true || (output?.subtype !== undefined && output.subtype !== 'success')) {
    return { error: `Claude did not finish triage (${output.subtype ?? 'error'}): ${output.result ?? ''}`.trim() };
  }

  return validateClassification(output?.structured_output, choices, rates, focusIds, 'Claude');
}

export async function classify(input: ClassifyInput, exec: Exec): Promise<ClassifyResult> {
  const timeoutMs = input.timeoutSeconds * 1000;
  const result = await exec(input.claudePath, classifierArgs(input), { cwd: input.cwd, stdin: input.context, timeoutMs, env: claudeEnvironment(input.claudePath) });

  if (result.code !== 0) {
    return { error: failureOf(input.claudePath, result, timeoutMs, { cwd: input.cwd }) };
  }

  return parseClassifierOutput(result.stdout, input.choices, input.rates, input.focusIds);
}
