/** `session <id>` in a log line, for a hub session ID (eight hex digits) not labelled yet. */
const SESSION = /\bsession ([0-9a-f]{8})\b(?! \(work item)/g;

/**
 * Adds the work item to each session a log line names (architecture.md § Hub log): `session bfd12580 (work item 123)`. Titles stay out of
 * the log, since they can carry ticket or customer text and the log is readable from a paired device.
 */
export function labelSessions(line: string, workItemOf: (sessionId: string) => number | null): string {
  return line.replace(SESSION, (whole, id: string) => {
    let workItem: number | null = null;
    try {
      workItem = workItemOf(id);
    } catch {
      // A closed store must not stop a log line.
    }
    return workItem === null ? whole : `${whole} (work item ${workItem})`;
  });
}
