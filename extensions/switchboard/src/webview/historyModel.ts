import type { HistoryChange, HistoryEvent, Session, TicketHistory, WorkItemStatus } from '@switchboard/core';
import { adhocLabel, DONE_WORDS } from '@switchboard/core/group';
import { ticketKey } from '@switchboard/hub/rows';

/** The filter chips of History (PRD R59). */
export type Category = 'you' | 'session' | 'report' | 'triage' | 'ticket';

export const CATEGORIES: readonly { key: Category; label: string; icon: string }[] = [
  { key: 'you', label: 'You', icon: 'account' },
  { key: 'session', label: 'Sessions', icon: 'terminal' },
  { key: 'report', label: 'Reports', icon: 'comment' },
  { key: 'triage', label: 'Triage', icon: 'filter' },
  { key: 'ticket', label: 'Ticket', icon: 'issues' },
];

export type Tone = 'error' | 'warning' | 'success' | 'accent' | null;

/** Something an entry names that the operator can open; `open` is a message the extension's History link handler takes. */
export interface EntryLink {
  label: string;
  icon: string;
  title: string;
  open: Record<string, unknown>;
}

export interface Entry {
  key: string;
  at: number;
  category: Category;
  icon: string;
  text: string;
  /** The other rows the event changed, one line each. */
  lines: string[];
  /** Longer text, such as a question or an error, shown under the entry. */
  detail: string | null;
  shortId: string | null;
  links: EntryLink[];
  tone: Tone;
  /** Rebuilt by the log's migration from the times stored before it began. */
  reconstructed: boolean;
  refused: string | null;
  /** Only a session's live state changed; long runs of these collapse. */
  stateChange: boolean;
}

export interface Section {
  key: string;
  workItemId: number | null;
  title: string;
  status: string;
  tone: Tone;
  facts: string[];
  /** The prompt of an ad-hoc or task work item, which no other place shows (PRD R59); null otherwise. */
  prompt: string | null;
  entries: Entry[];
}

export interface HistoryView {
  key: string;
  title: string;
  url: string;
  facts: { label: string; value: string }[];
  links: EntryLink[];
  /** Whether any entry was reconstructed, so the page says what was not recorded. */
  reconstructed: boolean;
  recordedSince: number | null;
  sections: Section[];
}

export const STATUS_WORDS: Record<WorkItemStatus, string> = {
  triaging: 'Triaging',
  unstarted: 'Unstarted',
  queued: 'Queued',
  setup: 'Setting up',
  running: 'Running',
  'awaiting-approval': 'Awaiting approval',
  finished: 'Finished its turn',
  blocked: 'Blocked',
  failed: 'Failed',
  done: 'Done',
};

/** An ad-hoc work item's section title, by how it was made. */
const ADHOC_SECTIONS: Record<ReturnType<typeof adhocLabel>, string> = { 'ad-hoc': 'Ad-hoc prompt', task: 'Follow-up task', registered: 'Registered session' };

/** Statuses that wait for the operator. */
const NEEDS_YOU: ReadonlySet<string> = new Set(['unstarted', 'awaiting-approval', 'finished', 'blocked', 'failed']);

const OPERATOR: Record<string, { text: string; icon: string }> = {
  adhoc: { text: 'You created the ad-hoc prompt', icon: 'add' },
  register: { text: 'You registered the session', icon: 'plug' },
  'run-schedule': { text: 'You ran it now', icon: 'play' },
  start: { text: 'You started it', icon: 'play' },
  approve: { text: 'You approved it', icon: 'check' },
  retry: { text: 'You retried it', icon: 'refresh' },
  'mark-done': { text: 'You marked it done', icon: 'pass' },
  reopen: { text: 'You reopened it', icon: 'issue-reopened' },
  retriage: { text: 'You asked to triage it again', icon: 'filter' },
  stop: { text: 'You asked to stop the session', icon: 'debug-stop' },
  delete: { text: 'You deleted a work item', icon: 'trash' },
  answer: { text: 'You answered the question', icon: 'comment' },
  'open-question': { text: 'You opened the question in its session', icon: 'comment-discussion' },
  background: { text: 'You asked to continue the session in the background', icon: 'debug-step-out' },
  pick: { text: 'You picked it from the pool', icon: 'pin' },
  'retriage-pool': { text: 'You asked to triage the pool ticket again', icon: 'filter' },
  restore: { text: 'You restored it', icon: 'bell' },
  snooze: { text: 'You snoozed it', icon: 'bell-slash' },
  comment: { text: 'You commented', icon: 'comment' },
  move: { text: 'You moved it in Ready for review', icon: 'list-ordered' },
  'reset-position': { text: 'You reset its place in Ready for review', icon: 'list-ordered' },
};

/** A local time such as `2026-10-07 14:02`. */
export function timeText(time: number): string {
  const date = new Date(time);
  const two = (value: number) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** A duration such as `45s`, `12m`, `2h 5m` or `3d 4h`. */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) {
    return `${seconds}s`;
  }

  if (hours < 1) {
    return `${minutes}m`;
  }

  return days < 1 ? `${hours}h ${minutes % 60}m` : `${days}d ${hours % 24}h`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/**
 * What a click on a session opens: the session in Claude, unless it runs in its background process, lives in the operator's window it was
 * registered from (PRD R81), or has no native ID yet; then null.
 */
export function sessionOpen(session: Session): Record<string, unknown> | null {
  if (session.state !== 'starting' && session.state !== 'ended' && session.shortId !== null && (!session.released || session.releasing || session.external === true)) {
    return null;
  }

  return session.nativeSessionId === null ? null : { type: 'open', sessionId: session.nativeSessionId, cwd: session.cwd, provider: session.provider };
}

/** A link to open a reported URL or file. */
function targetLink(label: string, target: string): EntryLink {
  return { label, icon: /^https?:\/\//i.test(target) ? 'link-external' : 'file', title: target, open: { type: 'openUrl', url: target } };
}

/** Builds the entries of a ticket's History from the hub's /history reply. */
class Builder {
  readonly sessions = new Map<string, Session>();
  /** Each session's state as of the event being worded, so a change of the question alone keeps its state. */
  readonly states = new Map<string, string>();
  /** Each session's short ID changes from a fork (PRD R78), oldest first, so an entry names the copy the session had then. */
  readonly forks = new Map<string, { eventId: number; before: string }[]>();
  /** The event being worded. */
  eventId = 0;

  constructor(readonly history: TicketHistory) {
    for (const item of history.workItems) {
      for (const session of item.sessions) {
        this.sessions.set(session.id, session);
      }
    }

    for (const event of history.events) {
      for (const change of event.changes) {
        const before = change.fields['shortId']?.[0];

        if (change.entity === 'session' && change.sessionId !== null && typeof before === 'string') {
          this.forks.set(change.sessionId, [...(this.forks.get(change.sessionId) ?? []), { eventId: event.id, before }]);
        }
      }
    }
  }

  /** A Codex session's short ID is its whole thread ID, so the page shows its last 8 characters. */
  shortId(sessionId: string | null): string | null {
    const session = sessionId === null ? undefined : this.sessions.get(sessionId);
    const later = sessionId === null ? undefined : this.forks.get(sessionId)?.find((fork) => fork.eventId > this.eventId);
    const id = later?.before ?? session?.shortId ?? null;

    return id !== null && session?.provider === 'codex' ? id.slice(-8) : id;
  }

  /** `session abc12345`, or `the session` before it has a short ID. */
  sessionName(sessionId: string | null): string {
    const id = this.shortId(sessionId);
    return id === null ? 'the session' : `session ${id}`;
  }

  sessionLink(sessionId: string | null): EntryLink[] {
    const session = sessionId === null ? undefined : this.sessions.get(sessionId);
    const open = session === undefined ? null : sessionOpen(session);

    const name = session?.provider === 'codex' ? 'Codex' : 'Claude';

    return open === null ? [] : [{ label: `Open in ${name}`, icon: 'comment-discussion', title: `Open ${this.sessionName(sessionId)} in ${name}`, open }];
  }

  /** One line per logged field of a change, in plain words; fields in `skip` are already in the entry's text. */
  changeLines(change: HistoryChange, skip: ReadonlySet<string>): string[] {
    const lines: string[] = [];
    const { fields } = change;
    const value = (field: string) => fields[field]?.[1];
    const has = (field: string) => field in fields && !skip.has(field);

    if (change.op === 'delete') {
      return change.entity === 'triage' ? ['Pool triage discarded'] : [`${change.entity} removed`];
    }

    if (change.op === 'insert') {
      switch (change.entity) {
        case 'ticket':
          return skip.has('*') ? [] : [`Switchboard first saw the ticket${value('assigned') === true ? ', assigned to you' : value('pool') === true ? ', in the pool' : ''}`];
        case 'workItem':
          return skip.has('*') ? [] : [`Work item created: ${STATUS_WORDS[value('status') as WorkItemStatus] ?? str(value('status'))}${value('playbook') ? `, ${str(value('playbook'))}` : ''}`];
        case 'session':
          return [`${value('kind') === 'setup' ? 'Setup' : 'Task'} session starting in ${str(value('cwd'))}`];
        case 'triage':
          return skip.has('*') ? [] : [change.workItemId === null ? 'Pool triage started' : 'Triage started'];
        case 'worktree':
          return skip.has('*') ? [] : [`Worktree linked: ${str(value('path'))}${value('branch') ? ` (${str(value('branch'))})` : ''}`];
        case 'link':
          return skip.has('*') ? [] : [`Link added: ${str(value('label'))}`];
        case 'paste':
          return skip.has('*') ? [] : [`Draft added: ${str(value('label'))}`];
      }
    }

    for (const field of Object.keys(fields).filter((key) => !skip.has(key) && !skip.has('*'))) {
      const [before, after] = fields[field]!;

      switch (`${change.entity}.${field}`) {
        case 'ticket.handledAssignmentKey':
          lines.push(after === null ? 'Assignment no longer handled by another session' : 'Assignment already handled by another session');
          break;
        case 'workItem.status':
          lines.push(
            after === 'done'
              ? `Done: ${DONE_WORDS[value('doneReason') as keyof typeof DONE_WORDS]?.toLowerCase() ?? 'done'}`
              : `Status: ${STATUS_WORDS[before as WorkItemStatus] ?? str(before)} → ${STATUS_WORDS[after as WorkItemStatus] ?? str(after)}`,
          );
          break;
        case 'workItem.error':
          if (after !== null) {
            lines.push(`Error: ${oneLine(str(after))}`);
          }
          break;
        case 'workItem.warning':
          if (after !== null) {
            lines.push(`Warning: ${oneLine(str(after))}`);
          }
          break;
        case 'workItem.playbook':
          lines.push(before === null ? `Playbook: ${str(after)}` : `Playbook: ${str(before)} → ${str(after)}`);
          break;
        case 'workItem.stage':
          if (after !== null) {
            lines.push(`Stage: ${str(after)}`);
          }
          break;
        case 'workItem.approvalSummary':
          if (after !== null) {
            lines.push(`Approval: ${oneLine(str(after))}`);
          }
          break;
        case 'workItem.unassignedAt':
          lines.push(after === null ? 'Assigned to you again' : 'Left the assigned state while a session was active');
          break;
        case 'workItem.taskPrompt':
          if (after !== null) {
            lines.push('Task prompt written');
          }
          break;
        case 'session.state':
          lines.push(`${this.sessionName(change.sessionId)}: ${str(before)} → ${str(after)}${has('stateDetail') && value('stateDetail') ? `, ${oneLine(str(value('stateDetail')))}` : ''}`);
          break;
        case 'session.outcome':
          if (after !== null) {
            lines.push(`Outcome: ${str(after)}${has('outcomeDetail') && value('outcomeDetail') ? `, ${oneLine(str(value('outcomeDetail')))}` : ''}`);
          }
          break;
        case 'session.released':
          if (after === true) {
            lines.push('Background process released');
          }
          break;
        case 'triage.workItemId':
          lines.push('Pool triage attached to the work item');
          break;
        case 'triage.playbook':
          lines.push(`Triage chose ${str(after)}`);
          break;
        case 'triage.error':
          if (after !== null) {
            lines.push(`Triage error: ${oneLine(str(after))}`);
          }
          break;
        case 'ticket.assigned':
          lines.push(after === true ? 'Assigned to you' : 'No longer assigned to you');
          break;
        case 'ticket.pool':
          lines.push(after === true ? 'Entered the pool' : 'Left the pool');
          break;
        case 'ticket.inQueue':
          if (before === true || after === true) lines.push(after === true ? 'Observed in the active Support queue' : 'Observed outside the active Support queue');
          break;
        case 'ticket.assigneeId':
          if (before !== null || after !== null) lines.push(`Source assignee: ${str(before) || 'none'} → ${str(after) || 'none'}`);
          break;
        case 'ticket.sourceId':
          if (this.history.ticket.source === 'schedule') {
            lines.push(after === null ? 'The schedule was removed from settings.json' : `Runs ${str(after)}`);
          }
          break;
        case 'ticket.title':
          lines.push(`Title: ${str(before)} → ${str(after)}`);
          break;
        case 'ticket.snoozed':
          lines.push(after === true ? `Snoozed ${value('snoozedUntil') == null ? 'indefinitely' : `until ${timeText(value('snoozedUntil') as number)}`}` : 'Snooze ended');
          break;
        case 'worktree.path':
          lines.push(`Worktree: ${str(after)}`);
          break;
        case 'link.label':
          lines.push(`Link renamed: ${str(before)} → ${str(after)}`);
          break;
        case 'paste.file':
          lines.push(`Draft replaced: ${str(after)}`);
          break;
        case 'session.pendingFork':
          if (after !== null) {
            lines.push(`Fork ${str(after)} waits for the background session to be released; Stop releases one waiting on a question`);
          }
          break;
        // Shown with the status, state, outcome or snooze they belong to, or internal.
        case 'workItem.failedStep':
        case 'workItem.approvalHeld':
        case 'workItem.doneAt':
        case 'workItem.doneReason':
        case 'workItem.approvalPrompt':
        case 'workItem.approvalReport':
        case 'workItem.parentId':
        case 'session.stateDetail':
        case 'session.outcomeDetail':
        case 'session.endedAt':
        case 'session.nativeSessionId':
        case 'session.shortId':
        case 'ticket.snoozedUntil':
        case 'triage.endedAt':
        case 'triage.context':
        case 'triage.model':
        case 'triage.immediacy':
        case 'triage.severity':
          break;
        default:
          lines.push(`${field}: ${str(before) || '—'} → ${str(after) || '—'}`);
      }
    }

    return lines;
  }

  /** The entry for an event's changes to one work item, or to the ticket when `workItemId` is null. */
  entry(event: HistoryEvent, changes: HistoryChange[], workItemId: number | null): Entry {
    this.eventId = event.id;
    const detail = event.detail ?? {};
    const base: Entry = {
      key: `${event.id}:${workItemId ?? 't'}`,
      at: event.at,
      category: 'ticket',
      icon: 'circle-small',
      text: '',
      lines: [],
      detail: null,
      shortId: this.shortId(event.sessionId ?? changes.find((change) => change.sessionId !== null)?.sessionId ?? null),
      links: [],
      tone: null,
      reconstructed: false,
      refused: event.refused,
      stateChange: false,
    };
    const skip = new Set<string>();
    const sessionChange = changes.find((change) => change.entity === 'session' && change.op === 'update' && ('state' in change.fields || 'stateDetail' in change.fields || 'shortId' in change.fields));
    // A question changed alone keeps the session's state: the last one seen, or the marker's.
    const state = sessionChange === undefined ? undefined : str(sessionChange.fields['state']?.[1] ?? this.states.get(sessionChange.sessionId!) ?? detail['state']);
    const status = changes.find((change) => change.entity === 'workItem' && 'status' in change.fields)?.fields['status']?.[1];
    // Work another work item's or ticket's event caused, such as a session the queue started when one ended, is worded from its own changes.
    const other = event.workItemId !== null ? event.workItemId !== workItemId : event.ticketId !== null && event.ticketId !== this.history.ticket.id;
    // The event that ended the reporting work item is about another ticket, so this ticket's entry names only the release (PRD R85).
    const ended = workItemId === null && this.handledEnded(detail);
    const foreign = other && detail['childTicketId'] !== this.history.ticket.id && !ended;
    const entry = ended
      ? { ...base, ...this.handledEndedHeadline(skip) }
      : { ...base, ...(foreign ? { refused: null } : this.headline(event, detail, skip, sessionChange, state)) };
    const lines = changes.flatMap((change) => this.changeLines(change, skip));

    for (const change of changes) {
      if (change.entity === 'session' && change.sessionId !== null && 'state' in change.fields) {
        this.states.set(change.sessionId, str(change.fields['state']![1]));
      }
    }

    // A session from before the log began starts from the state the migration saw.
    if (event.sessionId !== null && detail['fact'] === 'sessionStarted' && typeof detail['state'] === 'string') {
      this.states.set(event.sessionId, detail['state']);
    }

    if (entry.text === '') {
      entry.text = lines.shift() ?? event.type;
      entry.category = this.categoryOf(event, changes);
      entry.icon = entry.category === 'session' ? 'terminal' : entry.category === 'triage' ? 'filter' : 'issues';
    }

    entry.lines = lines;
    entry.stateChange = (event.type === 'marker' || event.type === 'roster') && changes.length === 1 && sessionChange !== undefined && state !== 'ended' && !('shortId' in sessionChange.fields);
    entry.tone =
      entry.refused !== null || status === 'failed' || state === 'failed'
        ? 'error'
        : (entry.tone ?? (status === 'blocked' || state === 'waiting' ? 'warning' : status === 'done' ? 'success' : status === 'awaiting-approval' || status === 'finished' ? 'accent' : null));

    // Only a session's start and its questions link to it, so the timeline does not repeat the same button.
    if (entry.links.length === 0 && entry.shortId !== null && (event.type === 'session-started' || state === 'waiting' || event.detail?.['fact'] === 'sessionStarted')) {
      entry.links = this.sessionLink(event.sessionId ?? sessionChange?.sessionId ?? null);
    }

    return entry;
  }

  /** A source's changes belong to the ticket; the hub's go with the row they changed, such as a session it started from the queue. */
  categoryOf(event: HistoryEvent, changes: HistoryChange[]): Category {
    const entity = changes[0]?.entity;

    if (event.actor === 'source') {
      return 'ticket';
    }

    return entity === 'triage' ? 'triage' : entity === 'session' || entity === 'workItem' ? 'session' : 'ticket';
  }

  handledEnded(detail: Record<string, unknown>): boolean {
    return Array.isArray(detail['handledEnded']) && detail['handledEnded'].includes(this.history.ticket.id);
  }

  handledEndedHeadline(skip: Set<string>): Partial<Entry> {
    skip.add('handledAssignmentKey');
    return { category: 'ticket', icon: 'issues', text: 'Handled assignment ended: the work that handled it ended' };
  }

  /** The entry's text, category, icon and links from its event; fields its text covers go in `skip`. An empty text takes the first change's line. */
  headline(event: HistoryEvent, detail: Record<string, unknown>, skip: Set<string>, sessionChange: HistoryChange | undefined, state: string | undefined): Partial<Entry> {
    const operator = OPERATOR[event.type];

    if (operator !== undefined) {
      let text = operator.text;

      if (event.type === 'snooze') {
        text = detail['until'] == null ? 'You snoozed it indefinitely' : `You snoozed it until ${timeText(detail['until'] as number)}`;
        skip.add('snoozed');
      } else if (event.type === 'restore') {
        skip.add('snoozed');
      } else if (event.type === 'stop' && event.sessionId === null) {
        text = 'You asked to stop the session';
      } else if (event.type === 'answer') {
        text = `You answered: ${oneLine(str(detail['answer']))}`;
      }

      // Start with guidance… names the playbook it chose (PRD R35) and shows the guidance under the entry (PRD R77).
      if ((event.type === 'start' || event.type === 'pick') && typeof detail['playbook'] === 'string') {
        text = `${text} as ${detail['playbook']}`;
      }

      if ((event.type === 'start' || event.type === 'pick') && typeof detail['guidance'] === 'string') {
        return { category: 'you', icon: operator.icon, text: `${text} with guidance`, detail: detail['guidance'], tone: 'accent' };
      }

      // Start with prompt… shows the edited prompt under the entry (PRD R77).
      if (event.type === 'start' && typeof detail['prompt'] === 'string') {
        return { category: 'you', icon: operator.icon, text: `${text} with an edited prompt`, detail: detail['prompt'], tone: 'accent' };
      }

      // A snooze's comment (PRD R49) and a comment (PRD R87) show their text under the entry.
      const comment = event.type === 'snooze' ? detail['comment'] : event.type === 'comment' ? detail['text'] : undefined;

      if (typeof comment === 'string') {
        return { category: 'you', icon: operator.icon, text, detail: comment, tone: 'accent' };
      }

      return { category: 'you', icon: operator.icon, text, tone: 'accent' };
    }

    const session = this.sessionName(event.sessionId);

    switch (event.type) {
      case 'poll': {
        const updates = detail['assignmentChanges'];
        const update = Array.isArray(updates) ? updates.find((value: { ticketId?: number }) => value.ticketId === this.history.ticket.id) as { reason?: string } | undefined : undefined;
        if (update === undefined) return {};
        skip.add('handledAssignmentKey');
        return { category: 'ticket', icon: 'issues', text: update.reason === 'unassigned' ? 'Handled assignment ended: unassigned' : 'Handled assignment ended: assigned again' };
      }
      case 'handled':
        return { category: 'report', icon: 'issues', text: detail['release'] === true ? 'Released the handled assignment' : 'Registered the assignment as already handled' };
      case 'volume-worked':
        return { category: 'ticket', icon: 'play', text: 'Worked in Switchboard' };
      case 'reconstructed':
        return this.reconstructed(event, detail);
      case 'report':
        return this.report(detail, skip);
      // The ticket's own field changes are the move itself (PRD R83). Only the move notes the ad-hoc key; a refusal or a retry is a request.
      case 'ticket': {
        const target = `${ticketKey({ source: str(detail['source']), sourceKey: str(detail['sourceKey']) })}${detail['playbook'] ? ` as ${str(detail['playbook'])}` : ''}`;

        skip.add('*');
        return { category: 'report', icon: 'issues', text: typeof detail['adhocKey'] === 'string' ? `Moved this work from adhoc ${detail['adhocKey']} to ${target}` : `Asked to move this work to ${target}` };
      }
      case 'marker':
      case 'roster': {
        if (sessionChange === undefined) {
          return {};
        }

        const [from, to] = sessionChange.fields['shortId'] ?? [];

        // A fork replaced the session (PRD R78); the state it took shows as a line.
        if (typeof from === 'string' && typeof to === 'string') {
          skip.add('nativeSessionId').add('shortId');
          return { category: 'session', icon: 'repo-forked', text: `The session continues in fork ${to}`, detail: `Session ${from} is retired.` };
        }

        skip.add('state').add('stateDetail');

        const name = capital(this.sessionName(sessionChange.sessionId));
        const after = state;
        const said = sessionChange.fields['stateDetail']?.[1];
        const texts: Record<string, { text: string; icon: string }> = {
          running: { text: `${name} is working`, icon: 'play-circle' },
          waiting: { text: `${name} is waiting for you`, icon: 'question' },
          idle: { text: `${name} finished its turn`, icon: 'debug-pause' },
          failed: { text: `${name}'s turn failed`, icon: 'error' },
          ended: { text: `${name} ended`, icon: 'circle-slash' },
        };
        const known = texts[str(after)] ?? { text: `${name}: ${str(after)}`, icon: 'terminal' };

        return { category: 'session', ...known, detail: said ? str(said) : null };
      }
      case 'session-started':
        skip.add('state').add('nativeSessionId').add('shortId');
        return { category: 'session', icon: 'terminal', text: `${capital(session)} started` };
      case 'session-start-failed':
        skip.add('state').add('outcome').add('outcomeDetail').add('released');
        return { category: 'session', icon: 'error', text: 'The session failed to start', detail: str(detail['message']), tone: 'error' };
      case 'stop-succeeded':
        skip.add('state').add('released');

        // The text says the session stopped to open its question.
        if (detail['reason'] === 'open') {
          skip.add('outcome');
        }

        return detail['reason'] === 'release'
          ? { category: 'session', icon: 'debug-disconnect', text: `Switchboard released ${session} so it can resume in VS Code` }
          : detail['reason'] === 'open'
            ? { category: 'session', icon: 'debug-stop', text: `${capital(session)} stopped to open its question` }
            : { category: 'session', icon: 'debug-stop', text: `${capital(session)} stopped` };
      case 'stop-failed':
        skip.add('error');
        return { category: 'session', icon: 'error', text: detail['reason'] === 'release' ? 'Releasing the session failed' : 'Stopping the session failed', detail: str(detail['message']), tone: 'error' };
      case 'session-resumed':
        skip.add('state').add('shortId').add('released').add('releasing').add('endedAt');
        return { category: 'session', icon: 'terminal', text: `${capital(session)} continues in the background` };
      case 'resume-failed':
        skip.add('state').add('outcome').add('outcomeDetail').add('released').add('error');
        return { category: 'session', icon: 'error', text: 'Continuing in the background failed', detail: str(detail['message']), tone: 'error' };
      case 'move-cancelled':
        return { category: 'session', icon: 'circle-slash', text: `${capital(session)} stayed in its tab, whose process did not exit` };
      case 'reply-failed':
        skip.add('error');
        return { category: 'session', icon: 'error', text: 'Sending your answer failed', detail: str(detail['message']), tone: 'error' };
      case 'triage-succeeded': {
        skip.add('playbook');
        const rating = [detail['immediacy'], detail['severity']].filter((part) => part != null).join(' · ');
        const stale = detail['stale'] === true ? '; it waits for Start, because nothing is newer than the earlier work item' : '';

        if (stale !== '') {
          // The headline says why; the row's note is the same text.
          skip.add('error');
        }

        return { category: 'triage', icon: 'filter', text: `Triage chose ${str(detail['playbook'])}${rating === '' ? '' : ` (${rating})`}${stale}`, detail: detail['model'] ? `Model: ${str(detail['model'])}` : null };
      }
      case 'triage-failed':
        skip.add('error');
        return { category: 'triage', icon: 'error', text: 'Triage failed', detail: str(detail['error']), tone: 'error' };
      case 'triage-cancelled':
        skip.add('error');
        return { category: 'triage', icon: 'circle-slash', text: 'Triage cancelled because the hub stopped' };
      case 'worktree-found':
        skip.add('*');
        return {
          category: 'ticket',
          icon: 'repo',
          text: `Found the worktree ${str(detail['path'])}${detail['branch'] ? ` (${str(detail['branch'])})` : ''}`,
          links: [{ label: 'Open', icon: 'folder-opened', title: str(detail['path']), open: { type: 'openFolder', path: str(detail['path']) } }],
        };
      case 'wake':
        skip.add('snoozed');
        return { category: 'ticket', icon: 'bell', text: 'Snooze ended' };
      // A schedule's change of title or directory has no headline; its change lines say it (PRD R82).
      case 'schedule':
        if (typeof detail['dueAt'] !== 'number') {
          return {};
        }

        return detail['skipped'] === true
          ? { category: 'ticket', icon: 'calendar', text: `The schedule came due at ${timeText(detail['dueAt'])}; it made no work item, because one is still open`, tone: 'warning' }
          : { category: 'ticket', icon: 'calendar', text: `The schedule came due at ${timeText(detail['dueAt'])}` };
      default:
        return {};
    }
  }

  report(detail: Record<string, unknown>, skip: Set<string>): Partial<Entry> {
    const base = { category: 'report' as const };

    switch (detail['kind']) {
      case 'stage':
        skip.add('stage');
        return { ...base, icon: 'milestone', text: `Stage: ${str(detail['stage'])}` };
      case 'worktree':
        skip.add('*');
        return {
          ...base,
          icon: 'repo',
          text: `Reported the worktree ${str(detail['path'])}`,
          links: [{ label: 'Open', icon: 'folder-opened', title: str(detail['path']), open: { type: 'openFolder', path: str(detail['path']) } }],
        };
      case 'done':
        skip.add('outcome');
        return detail['assigned'] === true
          ? { ...base, icon: 'warning', text: 'Reported done, but the ticket is still assigned to you', tone: 'warning' }
          : { ...base, icon: 'pass-filled', text: 'Reported done', tone: 'success' };
      case 'approval':
        skip.add('approvalSummary').add('approvalPrompt').add('approvalReport');
        return {
          ...base,
          icon: 'verified',
          text: `Asked for approval${detail['summary'] ? `: ${oneLine(str(detail['summary']))}` : ''}`,
          links: detail['report'] ? [targetLink('Draft', str(detail['report']))] : [],
          tone: 'accent',
        };
      case 'link':
        skip.add('*');
        return { ...base, icon: 'link', text: `Linked ${str(detail['label'])}`, links: [targetLink(str(detail['label']), str(detail['target']))] };
      case 'playbook':
        skip.add('playbook');
        return { ...base, icon: 'arrow-right', text: `Handed the work to ${str(detail['playbook'])}` };
      case 'paste':
        skip.add('*');
        return { ...base, icon: 'clippy', text: `Drafted ${str(detail['label'])}`, links: [targetLink('Open', str(detail['file']))] };
      case 'question': {
        const options = Array.isArray(detail['options']) ? detail['options'].map(str) : [];

        return { ...base, icon: 'question', text: `Asked: ${str(detail['text'])}`, detail: options.length === 0 ? null : options.join(' · ') };
      }
      case 'task':
        return {
          ...base,
          icon: 'tasklist',
          text: detail['childTicketId'] === this.history.ticket.id ? 'A session queued this follow-up' : `Queued a follow-up${detail['childTitle'] ? `: ${str(detail['childTitle'])}` : ''}`,
          detail: detail['childRef'] && detail['childTicketId'] !== this.history.ticket.id ? `Ad-hoc ${str(detail['childRef'])}` : null,
        };
      // A ticket report the hub refused before the move (PRD R83).
      case 'ticket':
        return { ...base, icon: 'issues', text: `Asked to move this work to ${str(detail['url'])}${detail['playbook'] ? ` as ${str(detail['playbook'])}` : ''}` };
      default:
        return { ...base, icon: 'comment', text: `Reported ${str(detail['kind'])}` };
    }
  }

  reconstructed(event: HistoryEvent, detail: Record<string, unknown>): Partial<Entry> {
    const base = { reconstructed: true };
    const session = this.sessionName(event.sessionId);

    switch (detail['fact']) {
      case 'created':
        return { ...base, category: 'ticket', icon: 'add', text: `Work item created${detail['playbook'] ? `: ${str(detail['playbook'])}` : ''}` };
      case 'triageStarted':
        return { ...base, category: 'triage', icon: 'filter', text: 'Triage started' };
      case 'triageEnded':
        return detail['error']
          ? { ...base, category: 'triage', icon: 'error', text: 'Triage failed', detail: str(detail['error']), tone: 'error' }
          : { ...base, category: 'triage', icon: 'filter', text: `Triage chose ${str(detail['playbook'])}` };
      case 'sessionStarted':
        return { ...base, category: 'session', icon: 'terminal', text: `${detail['kind'] === 'setup' ? 'Setup' : 'Task'} ${session} started` };
      case 'sessionEnded':
        return {
          ...base,
          category: 'session',
          icon: detail['outcome'] === 'failed' ? 'error' : 'circle-slash',
          text: `${capital(session)} ended${detail['outcome'] ? `: ${str(detail['outcome'])}` : ''}`,
          detail: detail['outcomeDetail'] ? str(detail['outcomeDetail']) : null,
          tone: detail['outcome'] === 'failed' ? 'error' : null,
        };
      case 'stage':
        return { ...base, category: 'report', icon: 'milestone', text: `Stage: ${str(detail['stage'])}` };
      case 'status':
        return detail['status'] === 'awaiting-approval'
          ? {
              ...base,
              category: 'report',
              icon: 'verified',
              text: `Asked for approval${detail['approvalSummary'] ? `: ${oneLine(str(detail['approvalSummary']))}` : ''}`,
              links: detail['approvalReport'] ? [targetLink('Draft', str(detail['approvalReport']))] : [],
              tone: 'accent',
            }
          : { ...base, category: 'session', icon: 'warning', text: STATUS_WORDS[detail['status'] as WorkItemStatus] ?? str(detail['status']), detail: detail['error'] ? str(detail['error']) : null, tone: detail['status'] === 'failed' ? 'error' : 'warning' };
      case 'done':
        return { ...base, category: 'session', icon: 'pass', text: `Done: ${DONE_WORDS[detail['reason'] as keyof typeof DONE_WORDS]?.toLowerCase() ?? 'done'}`, tone: 'success' };
      case 'link':
        return { ...base, category: 'report', icon: 'link', text: `Linked ${str(detail['label'])}`, links: [targetLink(str(detail['label']), str(detail['target']))] };
      case 'paste':
        return { ...base, category: 'report', icon: 'clippy', text: `Drafted ${str(detail['label'])}`, links: [targetLink('Open', str(detail['file']))] };
      default:
        return { ...base, category: 'ticket', icon: 'history', text: str(detail['fact']) };
    }
  }
}

/**
 * Time each work item spent waiting for the operator, from its logged changes: a status that needs them, or a session waiting for an answer.
 * Overlapping waits count once; an open wait runs to `now`. Waits before the log began are unknown.
 */
function waitingTimes(history: TicketHistory, now: number): Map<number, number> {
  const spans = new Map<number, [number, number][]>();
  const open = new Map<string, { workItemId: number; start: number }>();

  for (const event of history.events) {
    for (const change of event.changes) {
      const status = change.entity === 'workItem' ? change.fields['status'] : undefined;
      const state = change.entity === 'session' ? change.fields['state'] : undefined;

      if (change.workItemId === null || (status === undefined && state === undefined)) {
        continue;
      }

      const key = status === undefined ? `s${change.sessionId}` : `w${change.workItemId}`;
      const waiting = status === undefined ? state![1] === 'waiting' : NEEDS_YOU.has(str(status[1]));
      const started = open.get(key);

      if (started !== undefined && !waiting) {
        spans.set(started.workItemId, [...(spans.get(started.workItemId) ?? []), [started.start, event.at]]);
        open.delete(key);
      } else if (started === undefined && waiting) {
        open.set(key, { workItemId: change.workItemId, start: event.at });
      }
    }
  }

  for (const { workItemId, start } of open.values()) {
    spans.set(workItemId, [...(spans.get(workItemId) ?? []), [start, now]]);
  }

  const waiting = new Map<number, number>();

  for (const [workItemId, list] of spans) {
    let total = 0;
    let reached = -Infinity;

    for (const [start, end] of list.sort((a, b) => a[0] - b[0])) {
      total += Math.max(0, end - Math.max(start, reached));
      reached = Math.max(reached, end);
    }

    waiting.set(workItemId, total);
  }

  return waiting;
}

function sessionTime(sessions: readonly Session[], now: number): number {
  return sessions.reduce((total, session) => total + (session.endedAt ?? now) - session.startedAt, 0);
}

/** The page model of a ticket's History (PRD R59): a header, then a section per work item, newest first, and one for the ticket. */
export function historyView(history: TicketHistory, now: number): HistoryView {
  const builder = new Builder(history);
  const { ticket } = history;
  const items = new Set(history.workItems.map((item) => item.id));
  const byItem = new Map<number | null, Entry[]>();

  for (const event of history.events) {
    const groups = new Map<number | null, HistoryChange[]>();
    const owner = (id: number | null) => (id !== null && items.has(id) ? id : null);

    for (const change of event.changes) {
      const key = owner(change.workItemId ?? event.workItemId);
      groups.set(key, [...(groups.get(key) ?? []), change]);
    }

    if (groups.size === 0) {
      groups.set(owner(event.workItemId), []);
    }

    for (const [workItemId, changes] of groups) {
      byItem.set(workItemId, [...(byItem.get(workItemId) ?? []), builder.entry(event, changes, workItemId)]);
    }
  }

  const waiting = waitingTimes(history, now);
  const sections: Section[] = history.workItems.map((item) => {
    // A moved ticket's ad-hoc work item is its first, because an ad-hoc ticket has one (PRD R83).
    const playbook = item.playbook ?? (ticket.source === 'adhoc' || (ticket.adhocKey !== null && item.id === Math.min(...history.workItems.map((other) => other.id))) ? ADHOC_SECTIONS[adhocLabel(item, ticket)] : 'No playbook yet');
    const facts = [`Created ${timeText(item.createdAt)}`];

    if (item.doneAt !== null) {
      facts.push(`Done ${timeText(item.doneAt)}`);
    }

    if (item.sessions.length > 0) {
      facts.push(`${item.sessions.length} ${item.sessions.length === 1 ? 'session' : 'sessions'}, ${durationText(sessionTime(item.sessions, now))}`);
    }

    if ((waiting.get(item.id) ?? 0) > 0) {
      facts.push(`Waited on you ${durationText(waiting.get(item.id)!)} (logged)`);
    }

    return {
      key: `w${item.id}`,
      workItemId: item.id,
      title: playbook,
      status: item.status === 'done' && item.doneReason !== null ? DONE_WORDS[item.doneReason] : STATUS_WORDS[item.status],
      tone: item.status === 'failed' ? 'error' : item.status === 'blocked' ? 'warning' : item.status === 'done' ? 'success' : NEEDS_YOU.has(item.status) ? 'accent' : null,
      facts,
      prompt: item.prompt,
      entries: byItem.get(item.id) ?? [],
    };
  });
  const ticketEntries = byItem.get(null) ?? [];

  if (ticketEntries.length > 0 || sections.length === 0) {
    sections.push({ key: 'ticket', workItemId: null, title: 'Ticket', status: '', tone: null, facts: ['Assignment, pool, snoozes and worktree'], prompt: null, entries: ticketEntries });
  }

  const latest = history.workItems[0];
  const allSessions = history.workItems.flatMap((item) => item.sessions);
  const facts = [
    { label: 'Status', value: latest === undefined ? (ticket.pool ? 'In the pool' : 'No work item') : STATUS_WORDS[latest.status] },
    { label: 'Work items', value: String(history.workItems.length) },
    { label: 'Sessions', value: allSessions.length === 0 ? '0' : `${allSessions.length}, ${durationText(sessionTime(allSessions, now))}` },
  ];
  const waited = [...waiting.values()].reduce((total, time) => total + time, 0);

  if (waited > 0) {
    facts.push({ label: 'Waited on you (logged)', value: durationText(waited) });
  }

  if (ticket.scopeAt !== null) {
    facts.push({ label: 'In scope since', value: timeText(ticket.scopeAt) });
  }

  if (ticket.snoozed) {
    facts.push({ label: 'Snoozed', value: ticket.snoozedUntil === null ? 'Indefinitely' : `Until ${timeText(ticket.snoozedUntil)}` });
  }

  const links: EntryLink[] = [];

  if (ticket.url !== '') {
    links.push({ label: 'Open ticket', icon: 'link-external', title: ticket.url, open: { type: 'openUrl', url: ticket.url } });
  }

  if (history.worktree !== null) {
    links.push({ label: history.worktree.branch ?? 'Worktree', icon: 'repo', title: history.worktree.path, open: { type: 'openFolder', path: history.worktree.path } });
  }

  links.push(...history.links.map((link) => targetLink(link.label, link.target)));

  return {
    key: ticketKey(ticket),
    title: oneLine(ticket.title),
    url: ticket.url,
    facts,
    links,
    reconstructed: sections.some((section) => section.entries.some((entry) => entry.reconstructed)),
    recordedSince: history.recordedSince,
    sections,
  };
}
