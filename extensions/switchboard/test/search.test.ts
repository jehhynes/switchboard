import type { PoolView, WorkItemView } from '@switchboard/hub';
import { describe, expect, it } from 'vitest';
import { openUrlOf, rowFor, targetForUrl } from '../src/search.js';
import { item, NOW, snapshot, triage } from '../../../packages/hub/test/views.js';

describe('rowFor (PRD R49, R65)', () => {
  const worktree = { id: 1, ticketId: 1, path: 'D:/git/widgets-wt/101-fix', branch: '101-fix', linkedBy: 'report' as const };
  const zoho = (id: number, patch: Partial<WorkItemView['ticket']> = {}): WorkItemView['ticket'] => ({ ...item(id).ticket, source: 'zoho', sourceKey: `Z${id}`, title: `Case ${id}`, url: '', ...patch });
  const pooled = (id: number, patch: Partial<PoolView> = {}): PoolView => ({ ticket: zoho(id, { pool: true, assigned: false }), triage: triage({ ticketId: id, workItemId: null, playbook: 'support:defect' }), focus: null, links: [], returned: 0, playbookChoices: [], ...patch });
  // A snoozed ticket 8 with a done and an open work item, a snoozed pool ticket 9 with a done work item, and one row per other group.
  const data = snapshot(
    [
      item(1, { status: 'awaiting-approval', worktree }),
      item(2),
      item(3, { status: 'triaging', playbook: null }),
      item(4, { status: 'done', doneAt: NOW, ticket: { ...item(4).ticket, source: 'adhoc', sourceKey: '7', url: '' }, playbook: null }),
      item(5, { ticketId: 8, status: 'done', doneAt: NOW, ticket: zoho(8, { snoozed: true }) }),
      item(6, { ticketId: 8, status: 'unstarted', ticket: zoho(8, { snoozed: true }) }),
      item(7, { ticketId: 9, status: 'done', doneAt: NOW, ticket: zoho(9, { snoozed: true }) }),
    ],
    { pool: [pooled(10), pooled(9, { ticket: zoho(9, { pool: true, assigned: false, snoozed: true }), triage: null })] },
  );

  it('finds the row that shows a work item or pool ticket, the snoozed row standing for a hidden work item, and null for none', () => {
    expect(rowFor(data, { workItemId: 4 })).toBe('item:4');
    expect(rowFor(data, { ticketId: 10 })).toBe('ticket:10');
    expect(rowFor(data, { workItemId: 5 })).toBe('item:6');
    expect(rowFor(data, { workItemId: 7 })).toBe('ticket:9');
    expect(rowFor(data, { workItemId: 99 })).toBeNull();
    // A ticket that is not in the pool has no pool row, though its work item has one.
    expect(rowFor(data, { ticketId: 1 })).toBeNull();
  });
});

describe('Open in Switchboard (PRD R69)', () => {
  const desk = (id: number) => `https://desk.example.test/tickets/${id}`;
  const zoho = (id: number, patch: Partial<WorkItemView['ticket']> = {}): WorkItemView['ticket'] => ({ ...item(id).ticket, source: 'zoho', sourceKey: `Z${id}`, url: desk(id), ...patch });
  const link = (target: string) => ({ id: 1, ticketId: 1, label: 'link', target, reportedAt: NOW, mentioned: false });
  const data = snapshot(
    [
      // Work item 1 links issue 102, which is also work item 2's ticket.
      item(1, { links: [link('https://github.com/o/r/pull/55'), link('https://github.com/o/r/issues/102')] }),
      item(2),
      // Ticket 3 returned: a done work item and an open one.
      item(3, { status: 'done', doneAt: NOW }),
      item(4, { ticketId: 3, ticket: item(3).ticket, status: 'unstarted' }),
      // Snoozed ticket 8: the dock shows its open work item 6 only.
      item(5, { ticketId: 8, status: 'done', doneAt: NOW, ticket: zoho(8, { snoozed: true }) }),
      item(6, { ticketId: 8, status: 'unstarted', ticket: zoho(8, { snoozed: true }) }),
    ],
    { sources: ['github', 'zoho'], sourceStates: [{ name: 'github', enabled: true }, { name: 'zoho', enabled: true }], pool: [{ ticket: zoho(10, { pool: true, assigned: false }), triage: null, focus: null, returned: 0, playbookChoices: [], links: [link('https://github.com/o/r/pull/77')] }] },
  );

  it("finds the row of the ticket with the URL, by GitHub's case and any page tab, before a work item that links to it", () => {
    expect(targetForUrl(data, 'https://github.com/O/R/issues/102/')).toEqual({ workItemId: 2 });
    expect(targetForUrl(data, 'https://github.com/o/r/pull/55/files')).toEqual({ workItemId: 1 });
    expect(targetForUrl(data, desk(10))).toEqual({ ticketId: 10 });
    expect(targetForUrl(data, 'https://github.com/o/r/pull/77')).toEqual({ ticketId: 10 });
  });

  it('finds an open work item before a done one of the same ticket, and the row the dock shows for a snoozed ticket', () => {
    expect(targetForUrl(data, 'https://github.com/o/r/issues/103')).toEqual({ workItemId: 4 });
    expect(targetForUrl(data, desk(8))).toEqual({ workItemId: 6 });
  });

  it('finds nothing for a URL no row has, another kind of GitHub page, or an empty URL', () => {
    expect(targetForUrl(data, 'https://github.com/o/r/issues/999')).toBeNull();
    expect(targetForUrl(data, 'https://github.com/o/r/pull/102')).toBeNull();
    expect(targetForUrl(snapshot([item(1, { ticket: { ...item(1).ticket, url: '' } })]), '')).toBeNull();
  });

  it('reads the ticket URL from an open URI and refuses any other', () => {
    expect(openUrlOf('/open', 'url=https://github.com/o/r/issues/1')).toBe('https://github.com/o/r/issues/1');
    expect(openUrlOf('/open', 'url=https://desk.example.test/t?a=1&b=2')).toBe('https://desk.example.test/t?a=1&b=2');
    expect(openUrlOf('/other', 'url=https://github.com/o/r/issues/1')).toBeNull();
    expect(openUrlOf('/open', 'link=https://github.com/o/r/issues/1')).toBeNull();
    expect(openUrlOf('/open', 'url=')).toBeNull();
  });
});
