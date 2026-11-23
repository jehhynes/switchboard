import type { AppServer } from '@switchboard/codex';
import { triageModel } from '@switchboard/core';
import type { Playbook, Settings } from '@switchboard/core';

/** A model the New session form's Model list offers: what is sent, and what it shows. */
export interface ModelChoice {
  id: string;
  label: string;
}

/** Claude Code's stable model aliases, which follow each new model version (PRD R122). */
export const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]'];

/** How long the form waits for Codex's model list before it offers the configured model alone. */
export const CODEX_MODELS_MS = 5_000;

/** Claude's choices: its aliases, then each other Claude model named in settings.json, in `sessions`, `triage` or a playbook. */
export function claudeModelChoices(settings: Settings, playbooks: Iterable<Playbook>): ModelChoice[] {
  const named = [settings.sessions.model, settings.triage.model, ...[...playbooks].filter((one) => (one.provider ?? settings.sessions.provider) === 'claude').map((one) => one.model ?? '')];
  const ids = [...CLAUDE_ALIASES];

  for (const model of named.map((one) => one.trim())) {
    if (model !== '' && triageModel('claude', model) !== null && !ids.includes(model)) {
      ids.push(model);
    }
  }

  return ids.map((id) => ({ id, label: id }));
}

/** Codex's choices from the app-server's `model/list` (mechanics.md M136), without hidden models; throws when it fails. */
export async function codexModelChoices(server: Pick<AppServer, 'request'>): Promise<ModelChoice[]> {
  const choices: ModelChoice[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 5; page++) {
    const answer = (await server.request('model/list', cursor === null ? {} : { cursor })) as { data?: unknown; nextCursor?: unknown };

    for (const model of Array.isArray(answer.data) ? (answer.data as Array<Record<string, unknown>>) : []) {
      const id = typeof model['model'] === 'string' && model['model'] !== '' ? model['model'] : typeof model['id'] === 'string' ? model['id'] : '';

      if (id !== '' && model['hidden'] !== true && !choices.some((one) => one.id === id)) {
        choices.push({ id, label: typeof model['displayName'] === 'string' && model['displayName'] !== '' ? model['displayName'] : id });
      }
    }

    cursor = typeof answer.nextCursor === 'string' && answer.nextCursor !== '' ? answer.nextCursor : null;

    if (cursor === null) {
      break;
    }
  }

  return choices;
}

/** Adds `configured` to `choices` when it is set and not among them, so the configured model stays choosable. */
export function withConfigured(choices: readonly ModelChoice[], configured: string): ModelChoice[] {
  const model = configured.trim();

  return model === '' || choices.some((one) => one.id === model) ? [...choices] : [...choices, { id: model, label: model }];
}
