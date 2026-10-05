export type TemplateResult = { text: string } | { error: string };

/** The variables a playbook template, `setupPrompt` or `pickPrompt` can use. */
export const TEMPLATE_VARIABLES = [
  'ticket.source',
  'ticket.sourceKey',
  'ticket.ref',
  'ticket.title',
  'ticket.url',
  'ticket.context',
  'triage.summary',
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

/** Renders a playbook template, leaving `{{session.id}}` for {@link sessionPrompt}, because a retry reuses the prompt in a new session. */
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

/** Appended to every session prompt, because skills written for Ground Control do not know Switchboard. */
export const REPORT_CONTRACT = `

Report to Switchboard with these commands:
- {{report}} stage {{session.id}} <stage>, when you start a new phase of the work.
  - The stage is one or two words, such as Reviewing or Fixing tests.
- {{report}} worktree {{session.id}} <path>, when you create a worktree.
- {{report}} done {{session.id}}, when the work is finished.
- {{report}} approval {{session.id}} --prompt <prompt> --summary <text> --report <absolute path>, when the work is ready but posting or publishing it needs the operator's approval, then end your turn.
  - The prompt runs in a new session with no memory of this one, so it names what it acts on, such as /review-pr pr:123 publish.
  - The summary is one phrase of at most 8 words saying what Approve publishes, without counts.
  - The report is the file holding the text Approve publishes, such as a drafted comment; leave out --report when nothing is drafted.
- {{report}} link {{session.id}} --label <text> --target <url>, for each GitHub issue or pull request you create or find for this work.

When you need the operator's answer or choice, or cannot continue without them, ask with AskUserQuestion and wait for the answer. Do not report or write a file for a question.`;

/** The prompt one session runs: the task prompt with its session ID filled in, plus the report contract. */
export function sessionPrompt(taskPrompt: string, sessionId: string, report: string): string {
  const contract = REPORT_CONTRACT.replaceAll('{{report}}', report);

  return (taskPrompt.trimEnd() + contract).replace(SESSION_ID, sessionId);
}
