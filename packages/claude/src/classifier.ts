import { IMMEDIACIES, SEVERITIES } from '@switchboard/core';
import type { Immediacy, Severity, TriageChoice } from '@switchboard/core';
import type { Exec } from './exec.js';
import { failureOf } from './exec.js';

export interface ClassifyInput {
  claudePath: string;
  /** The triage playbook's body. */
  systemPrompt: string;
  choices: TriageChoice[];
  context: string;
  model: string | null;
  timeoutSeconds: number;
  /** A directory with no project instructions, such as the Switchboard home. */
  cwd: string;
}

export type ClassifyResult = { playbook: string; summary: string; immediacy: Immediacy | null; severity: Severity | null } | { error: string };

/** The classifier's system prompt: the triage playbook, then each choice and when to use it. */
export function classifierPrompt(systemPrompt: string, choices: TriageChoice[]): string {
  return `${systemPrompt.trimEnd()}\n\nChoose one playbook:\n${choices.map((choice) => `- ${choice.name}: ${choice.description}`).join('\n')}\n\nThe ticket follows as the user message. Summarize it in a few sentences. Set immediacy and severity only when the instructions above ask you to rate the ticket.`;
}

/** One-shot triage with no tools, settings, MCP servers or saved transcript (mechanics M3). */
export function classifierArgs(input: ClassifyInput): string[] {
  const schema = {
    type: 'object',
    properties: {
      playbook: { type: 'string', enum: input.choices.map((choice) => choice.name) },
      summary: { type: 'string' },
      immediacy: { type: 'string', enum: IMMEDIACIES },
      severity: { type: 'string', enum: SEVERITIES },
    },
    required: ['playbook', 'summary'],
    additionalProperties: false,
  };

  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--no-session-persistence',
    // Each variadic option is followed by another flag, so later values are not read as its arguments.
    '--setting-sources',
    '',
    '--tools',
    '',
    '--strict-mcp-config',
    '--system-prompt',
    classifierPrompt(input.systemPrompt, input.choices),
    ...(input.model === null ? [] : ['--model', input.model]),
  ];
}

/** Reads `structured_output` from `--output-format json`. A body-level error fails even when the process exits 0. */
export function parseClassifierOutput(stdout: string, choices: TriageChoice[]): ClassifyResult {
  let output: { is_error?: boolean; subtype?: string; result?: string; structured_output?: { playbook?: unknown; summary?: unknown; immediacy?: unknown; severity?: unknown } };

  try {
    output = JSON.parse(stdout);
  } catch {
    return { error: 'Claude returned output that is not JSON.' };
  }

  if (output.is_error === true || (output.subtype !== undefined && output.subtype !== 'success')) {
    return { error: `Claude did not finish triage (${output.subtype ?? 'error'}): ${output.result ?? ''}`.trim() };
  }

  const { playbook, summary, immediacy, severity } = output.structured_output ?? {};

  if (typeof playbook !== 'string' || typeof summary !== 'string') {
    return { error: 'Claude returned no playbook and summary.' };
  }

  if (!choices.some((choice) => choice.name === playbook)) {
    return { error: `Triage chose an unknown playbook: ${playbook}.` };
  }

  return {
    playbook,
    summary,
    immediacy: (IMMEDIACIES as readonly unknown[]).includes(immediacy) ? (immediacy as Immediacy) : null,
    severity: (SEVERITIES as readonly unknown[]).includes(severity) ? (severity as Severity) : null,
  };
}

export async function classify(input: ClassifyInput, exec: Exec): Promise<ClassifyResult> {
  const timeoutMs = input.timeoutSeconds * 1000;
  const result = await exec(input.claudePath, classifierArgs(input), { cwd: input.cwd, stdin: input.context, timeoutMs });

  if (result.code !== 0) {
    return { error: failureOf(input.claudePath, result, timeoutMs) };
  }

  return parseClassifierOutput(result.stdout, input.choices);
}
