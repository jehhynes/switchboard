import { describe, expect, it } from 'vitest';
import { rowFor } from '../src/needs.js';
import type { PoolView, WorkItemView } from '../src/snapshot.js';
import { item, NOW, snapshot, triage } from './views.js';

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
