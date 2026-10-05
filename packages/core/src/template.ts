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

const VARIABLE = /\{\{\s*([A-Za-z][\w.]*)\s*\}\}/g;

/** Why a template would fail to render, or null. */
export function templateError(template: string): string | null {
  const unknown = new Set([...template.matchAll(VARIABLE)].map((match) => match[1]!).filter((name) => !(TEMPLATE_VARIABLES as readonly string[]).includes(name)));

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

/** Appended to every session prompt, because skills written for Ground Control do not know Switchboard. */
export const REPORT_CONTRACT = `

Switchboard session {{session.id}} tracks this work. Report progress with these commands:
- {{report}} stage {{session.id}} <stage>
- {{report}} worktree {{session.id}} <path>, when you create a worktree
- {{report}} done {{session.id}} [--summary <text>], when the work is finished
- {{report}} blocked {{session.id}} --reason <text>, when you cannot continue
- {{report}} approval {{session.id}} --prompt <prompt> [--summary <text>], when the work is ready but posting or publishing it needs the operator's approval
- {{report}} link {{session.id}} --label <text> --target <url or absolute path>, for each GitHub issue or pull request you create or find for this work, and for a case file such as case.md
When you need the operator for a question or a choice, report blocked with the question and end your turn instead of waiting. When the work is ready but posting or publishing it needs approval, report approval with the prompt that would do it, such as /review-pr pr:123 publish, and end your turn.`;

/** The prompt one session runs: the task prompt with its session ID filled in, plus the report contract. */
export function sessionPrompt(taskPrompt: string, sessionId: string, report: string): string {
  const contract = REPORT_CONTRACT.replaceAll('{{report}}', report);

  return (taskPrompt.trimEnd() + contract).replace(SESSION_ID, sessionId);
}
