import { describe, expect, it } from 'vitest';
import { importanceRank } from '../src/model.js';
import { Harness, issue, playbooks } from './flowHarness.js';

describe('link reports (PRD R52)', () => {
  it('stores links on the ticket, replaces the label of a repeated target, and keeps them for a returned ticket', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'dev:finish': { description: 'Finish it', reports: ['done'], template: 'Finish it.' } }) });
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:finish');
    const session = h.started(h.act({ type: 'start', workItemId: 1 })[0]);

    h.report(session, { kind: 'link', label: 'Issue', target: 'https://github.com/o/r/issues/1' });
    h.report(session, { kind: 'link', label: 'PR 2', target: 'https://github.com/o/r/pull/2' });
    h.report(session, { kind: 'link', label: 'Issue #1', target: 'https://github.com/o/r/issues/1' });
    h.report(session, { kind: 'done' });

    expect(h.store.linksFor(1)).toMatchObject([
      { ticketId: 1, label: 'Issue #1', target: 'https://github.com/o/r/issues/1' },
      { ticketId: 1, label: 'PR 2', target: 'https://github.com/o/r/pull/2' },
    ]);

    h.poll();
    const [again] = h.poll(issue('1'));

    expect(again).toMatchObject({ type: 'triage', workItemId: 2 });
    expect(h.store.linksFor(1)).toHaveLength(2);
  });

  it('stores the links a source found when triage succeeds, and none from a late result', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    const pr = { label: 'Pull request #2', target: 'https://github.com/o/r/pull/2' };

    if (triage?.type !== 'triage') {
      throw new Error('Expected a triage action.');
    }

    const succeeded = { type: 'triage-succeeded', triageId: triage.triageId, context: 'c', playbook: 'dev:develop', immediacy: null, severity: null, model: null } as const;

    h.act({ ...succeeded, links: [pr] });
    h.act({ ...succeeded, links: [{ label: 'Late', target: 'https://github.com/o/r/pull/3' }] });

    expect(h.store.linksFor(1)).toMatchObject([{ ticketId: 1, ...pr, mentioned: false }]);
  });

  it('keeps a mentioned link mentioned until a session reports it, and a later triage does not mention it again (PRD R61)', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'dev:finish': { description: 'Finish it', reports: ['done'], template: 'Finish it.' } }) });
    const [triage] = h.poll(issue('1'));
    const named = { label: 'Issue #5', target: 'https://github.com/o/r/issues/5', mentioned: true };
    const other = { label: 'Issue #6', target: 'https://github.com/o/r/issues/6', mentioned: true };

    if (triage?.type !== 'triage') {
      throw new Error('Expected a triage action.');
    }

    h.act({ type: 'triage-succeeded', triageId: triage.triageId, context: 'c', playbook: 'dev:finish', immediacy: null, severity: null, model: null, links: [named, other] });
    expect(h.store.linksFor(1).map((link) => link.mentioned)).toEqual([true, true]);

    const session = h.started(h.act({ type: 'start', workItemId: 1 })[0]);
    h.report(session, { kind: 'link', label: 'Issue #5', target: named.target });
    h.report(session, { kind: 'done' });
    h.poll();
    const [again] = h.poll(issue('1'));

    if (again?.type !== 'triage') {
      throw new Error('Expected a triage action.');
    }

    h.act({ type: 'triage-succeeded', triageId: again.triageId, context: 'c', playbook: 'dev:finish', immediacy: null, severity: null, model: null, links: [named, other] });
    expect(h.store.linksFor(1).map((link) => [link.target, link.mentioned])).toEqual([
      [named.target, false],
      [other.target, true],
    ]);
  });

  it('refuses a link from an unknown session', () => {
    expect(new Harness().send({ type: 'report', sessionId: 'nope', report: { kind: 'link', label: 'x', target: 'https://x' } }).refused).toBe('Unknown session nope.');
  });
});

describe('importanceRank (PRD R50)', () => {
  it('adds the immediacy and severity ranks, and is null unless both are rated', () => {
    expect(importanceRank('URGENT', 'HIGH')).toBe(0);
    expect(importanceRank('BLOCKING', 'MED')).toBe(2);
    expect(importanceRank('NON-BLOCKING', 'HIGH')).toBe(2);
    expect(importanceRank('NON-BLOCKING', 'LOW')).toBe(4);
    expect(importanceRank('URGENT', null)).toBeNull();
    expect(importanceRank(null, 'HIGH')).toBeNull();
  });
});
