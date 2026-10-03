import { describe, expect, it } from 'vitest';
import { importanceRank } from '../src/model.js';
import { Harness, issue } from './flowHarness.js';

describe('link reports (PRD R52)', () => {
  it('stores links on the ticket, replaces the label of a repeated target, and keeps them for a returned ticket', () => {
    const h = new Harness();
    const [triage] = h.poll(issue('1'));
    h.triaged(triage, 'dev:question');
    const session = h.started(h.act({ type: 'approve', workItemId: 1 })[0]);

    h.report(session, { kind: 'link', label: 'Issue', target: 'https://github.com/o/r/issues/1' });
    h.report(session, { kind: 'link', label: 'Case file', target: 'D:\\cases\\1\\case.md' });
    h.report(session, { kind: 'link', label: 'Issue #1', target: 'https://github.com/o/r/issues/1' });
    h.report(session, { kind: 'done', summary: null });

    expect(h.store.linksFor(1)).toMatchObject([
      { ticketId: 1, label: 'Issue #1', target: 'https://github.com/o/r/issues/1' },
      { ticketId: 1, label: 'Case file', target: 'D:\\cases\\1\\case.md' },
    ]);

    h.poll();
    const [again] = h.poll(issue('1'));

    expect(again).toMatchObject({ type: 'triage', workItemId: 2 });
    expect(h.store.linksFor(1)).toHaveLength(2);
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
