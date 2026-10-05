import { handle } from '../src/flow.js';
import type { FlowAction, FlowEvent, FlowResult, PolledTicket } from '../src/flow.js';
import { parsePlaybook } from '../src/playbook.js';
import type { Playbook } from '../src/playbook.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import type { Settings } from '../src/settings.js';
import { Store } from '../src/store.js';

export const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const REPORT = 'node "C:/home/.switchboard/hub.js" report';

const PLAYBOOKS: Record<string, string> = {
  'triage:github': '---\ndescription: GitHub triage\nkind: triage\n---\nClassify the GitHub issue.',
  'triage:zoho': '---\ndescription: Zoho triage\nkind: triage\n---\nTriage the Support case.',
  'dev:develop': '---\ndescription: Plan and build the change\nautoStart: true\nrequiresWorktree: true\n---\n/gc-plan {{ticket.sourceKey}}',
  'dev:question': '---\ndescription: Answer a question\npermissionMode: plan\nmodel: opus\n---\nAnswer {{ticket.title}}.\n{{triage.summary}}',
  'support:defect': '---\ndescription: Research a defect\nautoStart: true\nworkdir: repoRoot\n---\nResearch {{ticket.sourceKey}} in {{ticket.url}}.',
};

export function playbooks(names: string[] = Object.keys(PLAYBOOKS), extra: Record<string, string> = {}): Map<string, Playbook> {
  const all = { ...PLAYBOOKS, ...extra };
  const result = new Map<string, Playbook>();

  for (const name of [...names, ...Object.keys(extra)]) {
    const parsed = parsePlaybook(name, all[name]!);

    if ('error' in parsed) {
      throw new Error(`${name}: ${parsed.error}`);
    }

    result.set(name, parsed.playbook);
  }

  return result;
}

export function settings(patch: { sessions?: Partial<Settings['sessions']>; triage?: Partial<Settings['triage']> } = {}): Settings {
  return {
    sessions: { ...DEFAULT_SETTINGS.sessions, ...patch.sessions },
    triage: { ...DEFAULT_SETTINGS.triage, ...patch.triage },
    sources: {
      github: { enabled: true, pollIntervalSeconds: 300, repoRoot: 'D:/git/widgets', triagePlaybook: 'triage:github', setupPrompt: '/init-worktree {{ticket.sourceKey}}', namespace: '', pickPrompt: '', options: {} },
      zoho: { enabled: true, pollIntervalSeconds: 300, repoRoot: 'D:/git/support', triagePlaybook: 'triage:zoho', setupPrompt: '', namespace: 'support', pickPrompt: 'Claim case #{{ticket.sourceKey}}, then stop.', options: {} },
    },
  };
}

export function issue(key: string, assigned = true): PolledTicket {
  return { sourceKey: key, ref: `#${key}`, sourceId: null, title: `Issue ${key}`, url: `https://github.com/acme/widgets/issues/${key}`, assigned, pool: false, sortAt: null, enteredAt: null };
}

/** Drives the flow against an in-memory store with a settable clock and sequential session IDs. */
export class Harness {
  readonly store = Store.open(':memory:');
  now = T0;
  settings: Settings;
  playbooks: Map<string, Playbook>;
  #sessions = 0;

  constructor(options: { settings?: Settings; playbooks?: Map<string, Playbook> } = {}) {
    this.settings = options.settings ?? settings();
    this.playbooks = options.playbooks ?? playbooks();
  }

  send(event: FlowEvent): FlowResult {
    return this.store.transaction(() =>
      handle(this.store, event, { now: this.now, settings: this.settings, playbooks: this.playbooks, report: REPORT, newSessionId: () => `s${++this.#sessions}` }),
    );
  }

  /** Sends an event that must not be refused, returning its actions. */
  act(event: FlowEvent): FlowAction[] {
    const result = this.send(event);

    if (result.refused !== null) {
      throw new Error(`Refused: ${result.refused}`);
    }

    return result.actions;
  }

  poll(...tickets: PolledTicket[]): FlowAction[] {
    return this.act({ type: 'poll', source: 'github', tickets });
  }

  /** Succeeds the triage of the given action with the playbook. */
  triaged(action: FlowAction | undefined, playbook: string, summary = 'A summary.'): FlowAction[] {
    if (action?.type !== 'triage') {
      throw new Error(`Expected a triage action, got ${JSON.stringify(action)}`);
    }

    return this.act({ type: 'triage-succeeded', triageId: action.triageId, context: `Context ${action.ticket.sourceKey}`, playbook, summary, immediacy: null, severity: null, model: 'claude-sonnet-5' });
  }

  started(action: FlowAction | undefined, shortId = 'abc12345'): string {
    if (action?.type !== 'start-session') {
      throw new Error(`Expected a start-session action, got ${JSON.stringify(action)}`);
    }

    this.act({ type: 'session-started', sessionId: action.sessionId, nativeSessionId: null, shortId });

    return action.sessionId;
  }

  report(sessionId: string, report: Extract<FlowEvent, { type: 'report' }>['report']): FlowResult {
    return this.send({ type: 'report', sessionId, report });
  }

  item(id: number) {
    return this.store.workItem(id)!;
  }

  status(id: number): string {
    return this.item(id).status;
  }
}
