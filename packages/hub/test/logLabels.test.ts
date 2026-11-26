import { describe, expect, it } from 'vitest';
import { labelSessions } from '../src/logLabels.js';

describe('session labels in log lines (architecture.md § Hub log)', () => {
  const workItems: Record<string, number> = { bfd12580: 123, '6a093470': 7 };
  const workItemOf = (id: string): number | null => workItems[id] ?? null;

  it('adds the work item to each known session, once, and leaves unknown IDs and other words alone', () => {
    expect(labelSessions('session bfd12580: message sent', workItemOf)).toBe('session bfd12580 (work item 123): message sent');
    expect(labelSessions('voice: from session bfd12580 to session 6a093470', workItemOf)).toBe('voice: from session bfd12580 (work item 123) to session 6a093470 (work item 7)');
    expect(labelSessions('session bfd12580 (work item 123): again', workItemOf)).toBe('session bfd12580 (work item 123): again');
    expect(labelSessions('session ffffffff: gone', workItemOf)).toBe('session ffffffff: gone');
    expect(labelSessions('Session bfd12580 is not the session', workItemOf)).toBe('Session bfd12580 is not the session');
    expect(labelSessions('session bfd12580ab: longer ID', workItemOf)).toBe('session bfd12580ab: longer ID');
  });

  it('keeps the line when the lookup throws, as a closed store does', () => {
    expect(labelSessions('session bfd12580: x', () => { throw new Error('database is not open'); })).toBe('session bfd12580: x');
  });
});
