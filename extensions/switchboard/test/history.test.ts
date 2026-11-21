import { DEFAULT_SETTINGS, Store, handle, parsePlaybook } from '@switchboard/core';
import type { FlowEvent, Playbook, Settings, TicketHistory } from '@switchboard/core';
import { describe, expect, it, vi } from 'vitest';
import { historyView, timeText } from '@switchboard/hub/history';
import type { Entry } from '@switchboard/hub/history';
import { startHistory } from '../src/webview/historyMain.js';
import { EMPTY_UI, RUN_LIMIT, renderHistory, shown } from '../src/webview/historyRender.js';

const T0 = new Date(2026, 9, 7, 9, 0, 0).getTime();
const MINUTE = 60_000;

const SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  sources: { github: { kind: 'github', pollIntervalSeconds: 300, repoRoot: 'D:/git/widgets', triagePlaybook: 'triage:github', setupPrompt: '', namespace: '', options: {} } },
};

function playbooks(): Map<string, Playbook> {
  const entries: Record<string, unknown> = {
    'triage:github': { description: 'Triage', kind: 'triage', template: 'Classify.' },
    'dev:question': { description: 'Answer a question', reports: ['approval'], template: 'Answer {{ticket.title}}.' },
  };

  return new Map(Object.entries(entries).map(([name, entry]) => [name, (parsePlaybook(name, entry) as { playbook: Playbook }).playbook]));
}

const ISSUE = { sourceKey: '77', ref: '#77', repo: '', sourceId: null, title: 'Inbox badge', url: 'https://github.com/o/r/issues/77', assigned: true, pool: false, sortAt: null, enteredAt: null };

/** Drives a real store through the flow, so the history is what the hub would return. */
class Run {
  readonly store = Store.open(':memory:');
  now = T0;
  #sessions = 0;

  send(event: FlowEvent): void {
    this.store.transaction(() => handle(this.store, event, { now: this.now, settings: SETTINGS, playbooks: playbooks(), report: 'report', newSessionId: () => `s${++this.#sessions}`, newUuid: () => 'uuid' }));
  }

  history(): TicketHistory {
    // The hub sends the history as JSON.
    return JSON.parse(JSON.stringify(this.store.ticketHistory(1))) as TicketHistory;
  }
}

/** Ticket gh 77 through triage, a started session with a stage and a question, and an approval request that the operator approves. */
function approvedRun(): Run {
  const run = new Run();

  run.send({ type: 'poll', source: 'github', tickets: [ISSUE] });
  run.now += MINUTE;
  run.send({ type: 'triage-succeeded', triageId: 1, context: 'ctx', playbook: 'dev:question', immediacy: null, severity: null, model: 'claude-sonnet-5' });
  run.now += 2 * MINUTE;
  run.send({ type: 'start', workItemId: 1 });
  run.send({ type: 'session-started', sessionId: 's1', nativeSessionId: 'native-1', shortId: 'abc12345' });
  run.now += MINUTE;
  run.send({ type: 'report', sessionId: 's1', report: { kind: 'stage', stage: 'researching' } });
  run.send({ type: 'marker', sessionId: 's1', state: 'waiting', detail: 'Which branch?' });
  run.now += 10 * MINUTE;
  run.send({ type: 'marker', sessionId: 's1', state: 'running', detail: null });
  run.send({ type: 'report', sessionId: 's1', report: { kind: 'approval', prompt: '/publish', summary: 'Post the answer', report: 'D:/draft.md' } });
  run.now += 2 * 60 * MINUTE;
  run.send({ type: 'approve', workItemId: 1 });

  return run;
}

describe('History page', () => {
  it("shows an ad-hoc work item's prompt under its section heading, and none for a registered session (PRD R59)", () => {
    const run = new Run();

    run.send({ type: 'adhoc', prompt: 'Fix the <badge>', repoRoot: 'D:/git/widgets' });
    run.send({ type: 'start', workItemId: 1, prompt: 'Fix the <badge>\nin the inbox' });

    const root = document.createElement('div');

    root.innerHTML = renderHistory(historyView(run.history(), run.now), EMPTY_UI);
    expect(root.querySelector('.section .prompt .text')!.textContent).toBe('Fix the <badge>\nin the inbox');
    run.send({ type: 'register', nativeSessionId: 'native-9', shortId: 'feed1234', cwd: 'D:/git/widgets', title: 'My session' });
    root.innerHTML = renderHistory(historyView(JSON.parse(JSON.stringify(run.store.ticketHistory(2))) as TicketHistory, run.now), EMPTY_UI);
    expect(root.querySelector('.prompt')).toBeNull();
  });

  it('renders the header, chips without counts, day headings, gaps and the newest section open', () => {
    const run = approvedRun();
    const root = document.createElement('div');

    root.innerHTML = renderHistory(historyView(run.history(), run.now), EMPTY_UI);

    expect(root.querySelector('h1')?.textContent).toBe('Inbox badge');
    expect([...root.querySelectorAll('.chip')].map((chip) => chip.textContent)).toEqual(['You', 'Sessions', 'Reports', 'Triage', 'Ticket']);
    expect([...root.querySelectorAll<HTMLDetailsElement>('details.section')].map((section) => section.open)).toEqual([true, false]);
    expect(root.querySelectorAll('.day')).toHaveLength(2);
    expect([...root.querySelectorAll('.entry .gap')].map((gap) => gap.textContent).filter(Boolean)).toEqual(['+1m', '+2m', '+1m', '+10m', '+2h 0m']);
    expect(root.querySelector('.entry.tone-warning .detail')?.textContent).toBe('Which branch?');
    expect(root.querySelector('.banner')).toBeNull();
  });

  it('filters by chip and by text, counting what the filter hides, and collapses a long run of state changes', () => {
    const run = approvedRun();
    const view = historyView(run.history(), run.now);
    const root = document.createElement('div');

    root.innerHTML = renderHistory(view, { ...EMPTY_UI, hidden: ['session', 'ticket', 'triage'], query: '' });
    expect([...root.querySelectorAll('[data-section="w1"] .entry .text')].map((text) => text.textContent)).toEqual(['You started itabc12345', 'Stage: researchingabc12345', 'Asked for approval: Post the answerabc12345', 'You approved it']);
    expect(root.querySelector('[data-section="w1"] .count')?.textContent).toBe('4 of 9');

    root.innerHTML = renderHistory(view, { ...EMPTY_UI, query: 'BRANCH' });
    expect(root.querySelectorAll('[data-section="w1"] .entry')).toHaveLength(1);
    expect(root.querySelector('[data-section="ticket"] .empty')?.textContent).toBe('No entries match the filter. Clear it to see every entry.');

    const states = Array.from({ length: RUN_LIMIT + 1 }, (_, index): Entry => ({ ...view.sections[0]!.entries[5]!, key: `r${index}`, at: T0 + index * 1000 }));
    const long = { ...view, sections: [{ ...view.sections[0]!, entries: states }] };

    root.innerHTML = renderHistory(long, EMPTY_UI);
    expect(root.querySelector('.run summary')?.textContent).toContain(`${RUN_LIMIT + 1} session state changes`);
    expect(root.querySelector<HTMLDetailsElement>('.run details')?.open).toBe(false);

    root.innerHTML = renderHistory({ ...long, sections: [{ ...long.sections[0]!, entries: states.slice(0, RUN_LIMIT) }] }, EMPTY_UI);
    expect(root.querySelector('.run')).toBeNull();
    expect(shown(states[0]!, { ...EMPTY_UI, query: 'abc1' })).toBe(true);
  });

  it('says when logging began when it shows reconstructed entries', () => {
    const run = approvedRun();
    const view = { ...historyView(run.history(), run.now), reconstructed: true, recordedSince: T0 };
    const root = document.createElement('div');

    root.innerHTML = renderHistory(view, EMPTY_UI);

    expect(root.querySelector('.banner')?.textContent).toContain(`Switchboard began logging on ${timeText(T0)}.`);
  });

  it('asks for the history, renders it, keeps the chips, search and sections in its state, and posts what to open', () => {
    const run = approvedRun();
    const posted: unknown[] = [];
    let state: unknown = null;
    const api = { postMessage: (message: unknown) => posted.push(message), getState: () => state, setState: (next: unknown) => (state = next) };
    const root = document.createElement('div');

    document.body.append(root);
    (window as { switchboardHistory?: unknown }).switchboardHistory = { ticketId: 1, key: 'gh 77' };
    vi.useFakeTimers();

    try {
      startHistory(root, api, () => run.now);

      expect(posted).toEqual([{ type: 'ready' }]);
      expect(state).toMatchObject({ ticketId: 1, key: 'gh 77' });

      window.dispatchEvent(new MessageEvent('message', { data: { type: 'history', history: run.history() } }));
      expect(root.querySelectorAll('[data-section="w1"] .entry')).toHaveLength(9);
      // The page says which revision it rendered, after rendering it.
      expect(posted.at(-1)).toEqual({ type: 'shown', revision: run.history().revision });

      root.querySelector<HTMLElement>('[data-category="you"]')!.click();
      expect(root.querySelectorAll('[data-section="w1"] .entry')).toHaveLength(7);
      expect(state).toMatchObject({ ticketId: 1, ui: { hidden: ['you'] } });

      const search = root.querySelector<HTMLInputElement>('#search')!;
      search.value = 'stage';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      expect(root.querySelectorAll('[data-section="w1"] .entry')).toHaveLength(1);
      expect(state).toMatchObject({ ui: { query: 'stage' } });

      root.querySelector<HTMLElement>('[data-all="open"]')!.click();
      expect(state).toMatchObject({ ui: { sections: { w1: true, ticket: true } } });

      // Closing a section by hand is kept, so the next redraw leaves it closed.
      const section = root.querySelector<HTMLDetailsElement>('[data-section="w1"]')!;
      section.open = false;
      section.dispatchEvent(new Event('toggle'));
      expect(state).toMatchObject({ ui: { sections: { w1: false, ticket: true } } });
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'history', history: run.history() } }));
      expect(root.querySelector<HTMLDetailsElement>('[data-section="w1"]')!.open).toBe(false);

      root.querySelector<HTMLElement>('[data-category="you"]')!.click();
      search.value = '';
      root.querySelector<HTMLInputElement>('#search')!.value = '';
      root.querySelector<HTMLInputElement>('#search')!.dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector<HTMLElement>('[data-open]')!.click();
      expect(posted.at(-1)).toEqual({ type: 'open', action: { type: 'openUrl', url: 'https://github.com/o/r/issues/77' } });

      window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'Switchboard: the hub did not answer.' } }));
      expect(root.querySelector('.error')?.textContent).toBe('Switchboard: the hub did not answer.');
    } finally {
      vi.useRealTimers();
      root.remove();
      delete (window as { switchboardHistory?: unknown }).switchboardHistory;
    }
  });

  it('redraws in place on a chip press, a new history and the tick, so the focused control keeps its focus', () => {
    const run = approvedRun();
    const api = { postMessage: () => {}, getState: () => null, setState: () => {} };
    const root = document.createElement('div');

    document.body.append(root);
    vi.useFakeTimers();

    try {
      startHistory(root, api, () => run.now);
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'history', history: run.history() } }));

      const chip = root.querySelector<HTMLButtonElement>('[data-category="you"]')!;
      const section = root.querySelector<HTMLDetailsElement>('[data-section="w1"]')!;
      const link = root.querySelector<HTMLButtonElement>('[data-open]')!;

      chip.focus();
      chip.click();
      expect(root.querySelector('[data-category="you"]')).toBe(chip);
      expect(chip.getAttribute('aria-pressed')).toBe('false');
      expect(document.activeElement).toBe(chip);

      link.focus();
      vi.advanceTimersByTime(30_000);
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'history', history: run.history() } }));
      expect(root.querySelector('[data-section="w1"]')).toBe(section);
      expect(root.querySelector('[data-open]')).toBe(link);
      expect(document.activeElement).toBe(link);
    } finally {
      vi.useRealTimers();
      root.remove();
    }
  });

  it('starts from the filters a reloaded page saved', () => {
    const run = approvedRun();
    const api = { postMessage: () => {}, getState: () => ({ ticketId: 1, key: 'gh 77', ui: { ...EMPTY_UI, hidden: ['you', 'session'] } }), setState: () => {} };
    const root = document.createElement('div');

    vi.useFakeTimers();

    try {
      startHistory(root, api, () => run.now);
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'history', history: run.history() } }));

      expect([...root.querySelectorAll('.chip.on')].map((chip) => (chip as HTMLElement).dataset['category'])).toEqual(['report', 'triage', 'ticket']);
    } finally {
      vi.useRealTimers();
    }
  });
});

it('labels retained Support queue and work facts in History', () => {
  const run = new Run();
  run.send({ type: 'poll', source: 'zoho', tickets: [{ ...ISSUE, assigned: false, inQueue: true, assigneeId: 'other' }] });
  run.store.volumeWorked(1, 'removed-session', T0 + 1);
  run.now += MINUTE;
  run.send({ type: 'poll', source: 'zoho', tickets: [] });
  const view = historyView(run.history(), run.now);
  const entries = view.sections.flatMap(section => section.entries);
  expect(entries.some(entry => entry.text === 'Worked in Switchboard')).toBe(true);
  expect(JSON.stringify(entries)).toContain('Observed outside the active Support queue');
  expect(JSON.stringify(entries)).not.toContain('ticket.inQueue');
  expect(JSON.stringify(entries)).not.toContain('volume-worked');
  run.store.close();
});
