import { describe, expect, it } from 'vitest';
import { importanceRank } from '../src/model.js';
import { Harness, issue, playbooks } from './flowHarness.js';

describe('link reports (PRD R52)', () => {
  it('stores links on the ticket, replaces the label of a repeated target, and keeps them for a returned ticket', () => {
    const h = new Harness({ playbooks: playbooks(undefined, { 'dev:finish': '---\ndescription: Finish it\nreports: done\n---\nFinish it.' }) });
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
