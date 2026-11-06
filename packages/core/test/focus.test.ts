import { describe, expect, it } from 'vitest';
import type { FlowAction } from '../src/flow.js';
import { effectiveFocus, focusUrl } from '../src/focus.js';
import type { Triage } from '../src/model.js';
import type { Anchor } from '../src/source.js';
import { Harness, issue, playbooks } from './flowHarness.js';

const ISSUE = 'https://github.com/o/r/issues/7';
const PR = 'https://github.com/o/r/pull/9';
const ANCHORS: Anchor[] = [
  { id: 'ticket', url: ISSUE, page: 'ticket' },
  { id: 'pr', url: PR, page: 'pr' },
  { id: 'c1', url: `${ISSUE}#issuecomment-1`, page: 'ticket' },
  { id: 'c2', url: `${PR}#discussion_r2`, page: 'pr' },
];

describe('focusUrl (PRD R79)', () => {
  it('takes the chosen anchor when the playbook names no page', () => {
    expect(focusUrl(ANCHORS, 'c2', null)).toBe(`${PR}#discussion_r2`);
    expect(focusUrl(ANCHORS, 'c1', null)).toBe(`${ISSUE}#issuecomment-1`);
  });

  it("takes the chosen anchor on the playbook's page", () => {
    expect(focusUrl(ANCHORS, 'c2', 'pr')).toBe(`${PR}#discussion_r2`);
    expect(focusUrl(ANCHORS, 'c1', 'ticket')).toBe(`${ISSUE}#issuecomment-1`);
  });

  it("replaces a comment on another page with the playbook's page", () => {
    expect(focusUrl(ANCHORS, 'c1', 'pr')).toBe(PR);
    expect(focusUrl(ANCHORS, 'c2', 'ticket')).toBe(ISSUE);
  });

  it("takes the playbook's page, else the ticket, for a missing or unknown id", () => {
    expect(focusUrl(ANCHORS, null, 'pr')).toBe(PR);
    expect(focusUrl(ANCHORS, 'c99', null)).toBe(ISSUE);
    expect(focusUrl(ANCHORS, null, null)).toBe(ISSUE);
  });

  it('takes the ticket for a pr playbook whose context has no pull request', () => {
    const noPr = ANCHORS.filter((anchor) => anchor.page === 'ticket');

    expect(focusUrl(noPr, 'c1', 'pr')).toBe(ISSUE);
    expect(focusUrl(noPr, null, 'pr')).toBe(ISSUE);
  });

  it('is null with no anchors', () => {
    expect(focusUrl([], 'c1', 'pr')).toBeNull();
  });
});

describe('effectiveFocus (PRD R79)', () => {
  const triage = (patch: Partial<Triage>): Triage => ({ id: 1, ticketId: 1, workItemId: 1, context: null, playbook: null, immediacy: null, severity: null, focus: null, model: null, startedAt: 0, endedAt: null, error: null, ...patch });

  it('keeps the latest successful focus through a running or failed triage', () => {
    const triages = [triage({ playbook: 'dev:a', focus: `${ISSUE}#issuecomment-1`, endedAt: 1 }), triage({ id: 2, error: 'Timed out.', endedAt: 2 }), triage({ id: 3 })];

    expect(effectiveFocus(triages, ISSUE)).toBe(`${ISSUE}#issuecomment-1`);
  });

  it('takes the latest successful one over an earlier one', () => {
    expect(effectiveFocus([triage({ playbook: 'dev:a', focus: PR }), triage({ id: 2, playbook: 'dev:b', focus: `${PR}#discussion_r2` })], ISSUE)).toBe(`${PR}#discussion_r2`);
  });

  it('takes the ticket with no successful triage, or one stored before focus existed, and null with no ticket URL', () => {
    expect(effectiveFocus([], ISSUE)).toBe(ISSUE);
    expect(effectiveFocus([triage({ playbook: 'dev:a' })], ISSUE)).toBe(ISSUE);
    expect(effectiveFocus([], '')).toBeNull();
  });
});

describe('triage focus in the flow (PRD R79)', () => {
  const PAGED = playbooks(undefined, { 'dev:review-pr': { description: 'Review a pull request', focus: 'pr', template: '/review-pr {{ticket.sourceKey}}' } });

  function triageOf(actions: FlowAction[]): Extract<FlowAction, { type: 'triage' }> {
    const action = actions.find((entry) => entry.type === 'triage');

    if (action?.type !== 'triage') {
      throw new Error('Expected a triage action.');
    }

    return action;
  }

  it("names a playbook's page in the triage prompt the classifier receives", () => {
    const h = new Harness({ playbooks: PAGED });
    const action = triageOf(h.poll(issue('7')));

    expect(action.systemPrompt).toContain('- dev:review-pr: Review a pull request (page: pull request)');
    expect(action.choices).toContainEqual({ name: 'dev:review-pr', description: 'Review a pull request', focus: 'pr' });
  });

  it("stores the chosen comment's URL, enforcing the playbook's page", () => {
    const h = new Harness({ playbooks: PAGED });
    const action = triageOf(h.poll(issue('7')));

    h.act({ type: 'triage-succeeded', triageId: action.triageId, context: 'ctx', playbook: 'dev:review-pr', immediacy: null, severity: null, model: null, focus: 'c1', anchors: ANCHORS });

    expect(h.store.triage(action.triageId)?.focus).toBe(PR);
  });

  it('stores no focus when the source gave no anchors or triage failed', () => {
    const h = new Harness({ playbooks: PAGED });
    const [a, b] = h.poll(issue('7'), issue('8')).filter((entry) => entry.type === 'triage') as Extract<FlowAction, { type: 'triage' }>[];

    h.act({ type: 'triage-succeeded', triageId: a!.triageId, context: 'ctx', playbook: 'dev:question', immediacy: null, severity: null, model: null, focus: 'c1' });
    h.act({ type: 'triage-failed', triageId: b!.triageId, error: 'Timed out.', context: null });

    expect([h.store.triage(a!.triageId)?.focus, h.store.triage(b!.triageId)?.focus]).toEqual([null, null]);
  });

  it('keeps a pool triage focus, which the pick carries to the new work item', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'support:case': { description: 'A Support case', workdir: 'repoRoot', template: '/support-process {{ticket.ref}}' } }) });
    const url = 'https://desk.example.test/500';
    const action = triageOf(h.act({ type: 'poll', source: 'zoho', tickets: [{ sourceKey: '500', ref: 'R500', repo: '', sourceId: 'id-500', title: 'Case', url, assigned: false, pool: true, sortAt: 1, enteredAt: null }] }));

    h.act({ type: 'triage-succeeded', triageId: action.triageId, context: 'ctx', playbook: 'support:case', immediacy: null, severity: null, model: null, focus: 'ticket', anchors: [{ id: 'ticket', url, page: 'ticket' }] });
    h.act({ type: 'pick', ticketId: action.ticket.id });

    const item = h.store.workItemsForTicket(action.ticket.id)[0]!;

    expect(effectiveFocus(h.store.triagesFor(item.id), '')).toBe(url);
  });
});
