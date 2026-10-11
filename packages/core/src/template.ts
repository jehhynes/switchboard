import { REPORT_KINDS } from './model.js';
import type { ReportKind } from './model.js';
import type { Provider } from './settings.js';

export type TemplateResult = { text: string } | { error: string };

/** The variables a playbook template or `setupPrompt` can use. */
export const TEMPLATE_VARIABLES = [
  'ticket.source',
  'ticket.sourceKey',
  'ticket.ref',
  'ticket.title',
  'ticket.url',
  'ticket.context',
  'session.id',
  'report',
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/** The variables a triage playbook's classifier instructions can use. */
export const TRIAGE_VARIABLES = ['playbooks'] as const;

const VARIABLE = /\{\{\s*([A-Za-z][\w.]*)\s*\}\}/g;

/** Why a template would fail to render, or null. */
export function templateError(template: string, variables: readonly string[] = TEMPLATE_VARIABLES): string | null {
  const unknown = new Set([...template.matchAll(VARIABLE)].map((match) => match[1]!).filter((name) => !variables.includes(name)));

  return unknown.size > 0 ? `Unknown template variable: ${[...unknown].join(', ')}.` : null;
}
const SESSION_ID = /\{\{\s*session\.id\s*\}\}/g;

/** Replaces `{{name}}` with `values[name]`. An unknown variable fails the whole render. Values are not re-scanned. */
export function render(template: string, values: Readonly<Record<string, string>>): TemplateResult {
  const unknown = new Set<string>();
  const text = template.replace(VARIABLE, (match, name: string) => {
    const value = values[name];

    if (value === undefined) {
      unknown.add(name);
      return match;
    }

    return value;
  });

  return unknown.size > 0 ? { error: `Unknown template variable: ${[...unknown].join(', ')}.` } : { text };
}

/** Renders a playbook template, leaving `{{session.id}}` for {@link sessionPrompt}, which knows the new session's ID. */
export function renderTaskPrompt(template: string, values: Readonly<Record<string, string>>): TemplateResult {
  return render(template, { ...values, 'session.id': '{{session.id}}' });
}

export interface PlaybookChoice {
  name: string;
  description: string;
}

const PLAYBOOKS = /\{\{\s*playbooks\s*\}\}/;

/**
 * The classifier's instructions: the triage playbook with `{{playbooks}}` replaced by the choices as `- name: description` lines,
 * or, when it has no `{{playbooks}}`, with the choices appended under "Choose one playbook:".
 */
export function triagePrompt(template: string, choices: readonly PlaybookChoice[]): TemplateResult {
  const error = templateError(template, TRIAGE_VARIABLES);

  if (error !== null) {
    return { error };
  }

  const list = choices.map((choice) => `- ${choice.name}: ${choice.description}`).join('\n');

  return PLAYBOOKS.test(template) ? render(template, { playbooks: list }) : { text: `${template.trimEnd()}\n\nChoose one playbook:\n${list}` };
}

/** Each report's lines in the contract, in contract order. The task report is accepted but not listed, so only the operator starts one (PRD R68). */
const REPORT_LINES: Record<Exclude<ReportKind, 'task'>, string> = {
  stage: `- {{report}} stage {{session.id}} <stage>, when you start a new phase of the work.
  - The stage states the work now running and what it acts on as an -ing phrase of at most four words with no ending punctuation, optionally after a step count, such as 2/5 fixing tests.`,
  worktree: '- {{report}} worktree {{session.id}} <path>, when you create a worktree.',
  done: '- {{report}} done {{session.id}}, when the work is finished.',
  approval: `- {{report}} approval {{session.id}} --prompt <prompt> --summary <text> --report <absolute path>, when the work is ready but posting or publishing it needs the operator's approval, then end your turn.
  - The prompt runs in a new session with no memory of this one, so it names what it acts on, such as /review-pr pr:123 publish.
  - The summary is one phrase of at most 8 words saying what Approve publishes, without counts.
  - The report is the file holding the text Approve publishes, such as a drafted comment; leave out --report when nothing is drafted.`,
  link: '- {{report}} link {{session.id}} --label <text> --target <url>, for each GitHub issue or pull request that tracks or delivers this work, such as one you create, but not a related, base or parent one.',
  playbook: '- {{report}} playbook {{session.id}} <name>, when you hand the work to the skill of another playbook, such as dev:review-pr.',
  paste: `- {{report}} paste {{session.id}} --label <text> --file <absolute path>, for each drafted text the operator pastes into the ticket by hand, such as --label "Customer reply".
  - The file holds only the text to paste. A later paste with the same label replaces the earlier one.`,
};

/**
 * The report contract, which the session gets as appended system prompt and again after each compaction, because skills written for
 * Ground Control do not know Switchboard. It lists only the reports the session may send (PRD R23).
 */
export function sessionContract(sessionId: string, report: string, reports: readonly ReportKind[], provider: Provider): string {
  const lines = REPORT_KINDS.filter((kind): kind is Exclude<ReportKind, 'task'> => kind !== 'task' && reports.includes(kind)).map((kind) => REPORT_LINES[kind]);
  const finish = reports.includes('done') || reports.includes('approval') ? '' : '\n\nWhen the work is finished, end your turn; the operator reviews it.';
  // A background Codex run cannot wait on the operator mid-turn (mechanics M31).
  const ask =
    provider === 'codex'
      ? "When you need the operator's answer or choice, or cannot continue without them, write the question, with any choices, as your final message and end your turn. Do not report or write a file for a question."
      : "When you need the operator's answer or choice, or cannot continue without them, ask with AskUserQuestion and wait for the answer. Do not report or write a file for a question.";

  return `Report to Switchboard with these commands:
${lines.join('\n')}${finish}

${ask}`
    .replaceAll('{{report}}', report)
    .replace(SESSION_ID, sessionId);
}

/** The first message of one session: the task prompt with its session ID filled in. */
export function sessionPrompt(taskPrompt: string, sessionId: string): string {
  return taskPrompt.trimEnd().replace(SESSION_ID, sessionId);
}
