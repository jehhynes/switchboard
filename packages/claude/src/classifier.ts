import { IMMEDIACIES, SEVERITIES } from '@switchboard/core';
import type { Immediacy, Severity, TriageChoice } from '@switchboard/core';
import type { Exec } from './exec.js';
import { claudeEnvironment, failureOf } from './exec.js';

export interface ClassifyInput {
  claudePath: string;
  /** The triage playbook's body with the choices rendered in (core `triagePrompt`). */
  systemPrompt: string;
  choices: TriageChoice[];
  /** Whether the triage playbook rates immediacy and severity; without it, the schema has neither field. */
  rates: boolean;
  /** The anchor ids the context tags, such as `ticket`, `pr` and `c1`, one of which triage returns as the focus (PRD R79). */
  focusIds: string[];
  context: string;
  model: string | null;
  timeoutSeconds: number;
  /** A directory with no project instructions, such as the Switchboard home. */
  cwd: string;
}

export type ClassifyResult = { playbook: string; immediacy: Immediacy | null; severity: Severity | null; focus: string | null } | { error: string };

/** The classifier's system prompt: the rendered triage playbook, how to choose the focus when the context tags anchors (PRD R79), then where the ticket is. */
export function classifierPrompt(systemPrompt: string, focus: boolean): string {
  return [
    systemPrompt.trimEnd(),
    ...(focus
      ? [
          '',
          'Set focus to the bracketed id, such as c3, of the page or comment the operator should read first to do the chosen playbook\'s work; when several comments ask for that work, choose the earliest. A playbook marked (page: ...) is done on that page, so choose a comment on it, or the page itself.',
        ]
      : []),
    '',
    'The ticket follows as the user message.',
  ].join('\n');
}

/** One-shot triage with no tools, settings, MCP servers or saved transcript (mechanics M3). */
export function classifierArgs(input: ClassifyInput): string[] {
  const schema = {
    type: 'object',
    properties: {
      playbook: { type: 'string', enum: input.choices.map((choice) => choice.name) },
      ...(input.focusIds.length === 0 ? {} : { focus: { type: 'string', enum: input.focusIds } }),
      ...(input.rates ? { immediacy: { type: 'string', enum: IMMEDIACIES }, severity: { type: 'string', enum: SEVERITIES } } : {}),
    },
    required: ['playbook'],
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

  if (output.is_error === true || (output.subtype !== undefined && output.subtype !== 'success')) {
    return { error: `Claude did not finish triage (${output.subtype ?? 'error'}): ${output.result ?? ''}`.trim() };
  }

  const { playbook, immediacy, severity, focus } = output.structured_output ?? {};

  if (typeof playbook !== 'string') {
    return { error: 'Claude returned no playbook.' };
  }

  if (!choices.some((choice) => choice.name === playbook)) {
    return { error: `Triage chose an unknown playbook: ${playbook}.` };
  }

  return {
    playbook,
    immediacy: rates && (IMMEDIACIES as readonly unknown[]).includes(immediacy) ? (immediacy as Immediacy) : null,
    severity: rates && (SEVERITIES as readonly unknown[]).includes(severity) ? (severity as Severity) : null,
    focus: typeof focus === 'string' && focusIds.includes(focus) ? focus : null,
  };
}

export async function classify(input: ClassifyInput, exec: Exec): Promise<ClassifyResult> {
  const timeoutMs = input.timeoutSeconds * 1000;
  const result = await exec(input.claudePath, classifierArgs(input), { cwd: input.cwd, stdin: input.context, timeoutMs, env: claudeEnvironment(input.claudePath) });

  if (result.code !== 0) {
    return { error: failureOf(input.claudePath, result, timeoutMs, { cwd: input.cwd }) };
  }

  return parseClassifierOutput(result.stdout, input.choices, input.rates, input.focusIds);
}
