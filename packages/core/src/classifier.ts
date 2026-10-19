import { IMMEDIACIES, SEVERITIES } from './model.js';
import type { Immediacy, Severity } from './model.js';
import type { TriageChoice } from './flow.js';
import type { Provider } from './settings.js';

export function triageModel(provider: Provider, model: string | null): string | null {
  if (model === null) return null;
  const name = model.toLowerCase();
  const mismatch = provider === 'codex'
    ? /^(claude(?:-|$)|sonnet(?:\[|$)|opus(?:\[|$)|haiku(?:\[|$))/.test(name)
    : /^(gpt-|chatgpt-|codex(?:-|$)|o[134](?:-|$))/.test(name);
  return mismatch ? null : model;
}

export interface ClassifyInput {
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

export function classifierSchema(input: Pick<ClassifyInput, 'choices' | 'focusIds' | 'rates'>) {
  return {
    type: 'object',
    properties: {
      playbook: { type: 'string', enum: input.choices.map((choice) => choice.name) },
      ...(input.focusIds.length === 0 ? {} : { focus: { type: 'string', enum: input.focusIds } }),
      ...(input.rates ? { immediacy: { type: 'string', enum: IMMEDIACIES }, severity: { type: 'string', enum: SEVERITIES } } : {}),
    },
    required: ['playbook'],
    additionalProperties: false,
  };
}

export function validateClassification(value: unknown, choices: TriageChoice[], rates: boolean, focusIds: string[], provider: string): ClassifyResult {
  const { playbook, immediacy, severity, focus } = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};

  if (typeof playbook !== 'string') {
    return { error: `${provider} returned no playbook.` };
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
