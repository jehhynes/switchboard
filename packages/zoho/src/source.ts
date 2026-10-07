import { githubLinks } from '@switchboard/core';
import type { ContextResult, PolledTicket, PollResult, Source, Ticket } from '@switchboard/core';
import type { ZohoConfig } from './config.js';
import type { DeskGet, DeskResult } from './desk.js';
import { clip, stripHtml } from './text.js';

/** Each thread body and comment is clipped to this many characters, as GitHub's are. */
export const TEXT_LIMIT = 2_000;

/** How long the agent-to-teams map is trusted; team membership changes over months (Support board). */
export const TEAMS_TTL_MS = 6 * 60 * 60 * 1000;

const PAGE = 100;
/** History pages read for a scope change before falling back to the ticket's creation. */
const HISTORY_PAGES = 10;

/** Who holds a ticket, from Support's side (Support board `classifyAssignee`). Only `engineer` is a claim by somebody else. */
export type AssigneeClass = 'mine' | 'none' | 'support' | 'engineer';

interface SearchTicket {
  id: string;
  ticketNumber: string;
  subject: string;
  webUrl: string;
  createdTime?: string;
  /** Changes on any edit, so a ticket's scope entry is read again only when it changes. */
  modifiedTime?: string;
  status?: string;
  /** When the customer last wrote, or null after an agent replied. */
  customerResponseTime?: string | null;
  assigneeId: string | null;
  cf?: Record<string, string | null>;
}

interface Team {
  id: string;
  name: string;
  agents?: unknown[];
  derivedAgents?: unknown[];
}

interface Person {
  name?: string;
  firstName?: string;
  lastName?: string;
  type?: string;
}

interface ConversationEntry {
  id: string;
  type: string;
  createdTime?: string;
  commentedTime?: string;
  isPublic?: boolean;
  content?: string;
  commenter?: Person;
  author?: Person;
  direction?: string;
  summary?: string;
}

interface Thread {
  content?: string;
  summary?: string;
  createdTime?: string;
  direction?: string;
  author?: Person;
}

interface HistoryEvent {
  eventTime: string;
  agentName?: string;
  changes?: { field: string; oldValue?: unknown; newValue?: unknown }[];
}

/** Custom fields the triage context shows (architecture.md § Settings). */
const CONTEXT_FIELDS = ['cf_queue', 'cf_user_id', 'cf_account_id', 'cf_page_url'];

/** History fields that show a ticket's tier, owner and status moves. */
const HISTORY_FIELDS = new Set(['Escalation', 'Case Owner', 'Status', 'Team']);

function nameOf(person: Person | undefined): string {
  if (person === undefined) {
    return 'someone';
  }

  return person.name || [person.firstName, person.lastName].filter(Boolean).join(' ') || 'someone';
}

function json(result: DeskResult): unknown {
  if ('error' in result) {
    throw new DeskError(result.error);
  }

  return 'empty' in result ? null : result.json;
}

class DeskError extends Error {}

export class ZohoSource implements Source {
  readonly name = 'zoho';
  private teams: { teamOf: Map<string, string[]>; names: Map<string, string>; until: number } | null = null;
  /** Each Support ticket's scope entry, by ticket ID, with the modifiedTime it was read at. */
  private entered = new Map<string, { modifiedTime: string; at: number | null }>();

  constructor(
    private readonly config: ZohoConfig,
    private readonly get: DeskGet,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reads every Open ticket and keeps the Support ones: yours are assigned, unclaimed ones are the pool (PRD R46, R47). A failed team read fails the poll. */
  async poll(): Promise<PollResult> {
    try {
      const teamOf = await this.teamMap();
      const tickets: PolledTicket[] = [];

      for (let page = 0; page < this.config.maxPages; page++) {
        const body = json(await this.get(`/tickets/search?status=Open&limit=${PAGE}&from=${page * PAGE + 1}`)) as { data?: SearchTicket[] } | null;
        const rows = body?.data ?? [];

        if (!Array.isArray(rows)) {
          throw new DeskError('Zoho Desk returned an unexpected response.');
        }

        for (const ticket of rows) {
          const holder = this.classify(ticket.assigneeId, teamOf);

          // Another engineer's ticket is neither assigned nor in the pool, so it is left out.
          if (ticket.cf?.[this.config.escalationField] === this.config.escalationValue && holder !== 'engineer') {
            // The customer has waited since their last message; a ticket without one falls back to its creation.
            const waiting = Date.parse(ticket.customerResponseTime ?? ticket.createdTime ?? '');

            tickets.push({
              sourceKey: String(ticket.ticketNumber),
              ref: `#${ticket.ticketNumber}`,
              sourceId: String(ticket.id),
              title: ticket.subject,
              url: ticket.webUrl,
              assigned: holder === 'mine',
              pool: holder !== 'mine',
              sortAt: Number.isNaN(waiting) ? null : waiting,
              enteredAt: await this.enteredScope(ticket),
            });
          }
        }

        if (rows.length < PAGE) {
          const kept = new Set(tickets.map((ticket) => ticket.sourceId));

          for (const id of this.entered.keys()) {
            if (!kept.has(id)) {
              this.entered.delete(id);
            }
          }

          return { tickets };
        }
      }

      return { error: `More than ${this.config.maxPages} pages of Open tickets; raise sources.zoho.maxPages.` };
    } catch (error) {
      return { error: error instanceof DeskError ? error.message : 'Zoho Desk returned an unexpected response.' };
    }
  }

  /**
   * When the ticket last entered Support scope (PRD R27): the later of its last escalation to Support and its last change to its current Open
   * status, such as back from Deferred. A history that ends without either gives its creation; one longer than 1,000 events gives null, so
   * Switchboard keeps the time it has.
   */
  private async enteredScope(ticket: SearchTicket): Promise<number | null> {
    const cached = this.entered.get(ticket.id);

    if (cached !== undefined && ticket.modifiedTime !== undefined && cached.modifiedTime === ticket.modifiedTime) {
      return cached.at;
    }

    const status = ticket.status ?? 'Open';
    const entersScope = (event: HistoryEvent) =>
      (event.changes ?? []).some((change) => (change.field === 'Escalation' && change.newValue === this.config.escalationValue) || (change.field === 'Status' && change.newValue === status));
    const created = Date.parse(ticket.createdTime ?? '');
    let at: number | null = null;

    // History comes newest first, so the first page with a scope change holds the latest one.
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const events = (json(await this.get(`/tickets/${encodeURIComponent(ticket.id)}/history?from=${page * PAGE + 1}&limit=${PAGE}`)) as HistoryEvent[] | null) ?? [];
      const times = events.filter(entersScope).map((event) => Date.parse(event.eventTime)).filter((time) => !Number.isNaN(time));

      if (times.length > 0) {
        at = Math.max(...times);
        break;
      }

      if (events.length < PAGE) {
        at = Number.isNaN(created) ? null : created;
        break;
      }
    }

    if (ticket.modifiedTime !== undefined) {
      this.entered.set(ticket.id, { modifiedTime: ticket.modifiedTime, at });
    }

    return at;
  }

  async context(ticket: Ticket): Promise<ContextResult> {
    if (ticket.sourceId === null) {
      return { error: `Zoho ticket ${ticket.sourceKey} has no internal ID.` };
    }

    try {
      await this.teamMap();

      const id = encodeURIComponent(ticket.sourceId);
      const detail = json(await this.get(`/tickets/${id}`)) as { subject?: string; status?: string; cf?: Record<string, string | null>; assigneeId?: string | null } | null;
      const conversations = (json(await this.get(`/tickets/${id}/conversations?limit=100`)) as { data?: ConversationEntry[] } | null)?.data ?? [];
      const history = (json(await this.get(`/tickets/${id}/history?limit=100`)) as HistoryEvent[] | null) ?? [];
      const lines = [
        `Zoho Desk ticket #${ticket.sourceKey}: ${detail?.subject ?? ticket.title}`,
        `Status: ${detail?.status ?? 'unknown'}`,
        `Assignee: ${this.ownerLabel(detail?.assigneeId ?? null)}`,
        ...CONTEXT_FIELDS.map((field) => `${field}: ${detail?.cf?.[field] ?? 'none'}`),
      ];
      const moves = history
        .flatMap((event) => (event.changes ?? []).filter((change) => HISTORY_FIELDS.has(change.field)).map((change) => ({ event, change })))
        .map(({ event, change }) => `${event.eventTime.slice(0, 16).replace('T', ' ')} ${event.agentName ?? 'Zoho'}: ${change.field} ${this.value(change.field, change.oldValue)} → ${this.value(change.field, change.newValue)}`)
        .reverse();

      if (moves.length > 0) {
        lines.push('', '## Tier, owner and status history', ...moves);
      }

      lines.push('', '## Conversation, oldest first');

      // Links come from the unclipped HTML, so a clip cannot shorten a URL and a link's href counts.
      const bodies = [lines.join('\n')];

      for (const entry of [...conversations].reverse()) {
        const { heading, body } = await this.entry(id, entry);

        lines.push('', heading, clip(stripHtml(body), TEXT_LIMIT));
        bodies.push(body);
      }

      return { context: lines.join('\n'), links: githubLinks(bodies) };
    } catch (error) {
      return { error: error instanceof DeskError ? error.message : 'Zoho Desk returned an unexpected response.' };
    }
  }

  /** Zoho worktrees are not named by ticket, so none is linked by branch name. */
  keyOfBranch(): string | null {
    return null;
  }

  /** The Support board's `classifyAssignee`, with the team map deciding support from engineer. */
  classify(assigneeId: string | null, teamOf: Map<string, string[]>): AssigneeClass {
    if (assigneeId === null || assigneeId === '') {
      return 'none';
    }

    const id = String(assigneeId);

    if (id === this.config.agentId) {
      return 'mine';
    }

    if (this.config.automationAgentIds.includes(id)) {
      return 'support';
    }

    return (teamOf.get(id) ?? []).length > 0 ? 'support' : 'engineer';
  }

  private async teamMap(): Promise<Map<string, string[]>> {
    if (this.teams !== null && this.now() < this.teams.until) {
      return this.teams.teamOf;
    }

    const body = json(await this.get('/teams')) as { teams?: Team[] } | null;
    const teams = body?.teams ?? [];

    if (teams.length === 0) {
      throw new DeskError('Zoho Desk returned no teams, so support assignees cannot be told from engineers.');
    }

    const teamOf = new Map<string, string[]>();
    const names = new Map(teams.map((team) => [String(team.id), team.name]));

    for (const team of teams) {
      for (const member of [...(team.agents ?? []), ...(team.derivedAgents ?? [])]) {
        const id = typeof member === 'object' && member !== null ? String((member as { id?: unknown }).id ?? '') : String(member);

        if (id !== '' && !teamOf.get(id)?.includes(team.name)) {
          teamOf.set(id, [...(teamOf.get(id) ?? []), team.name]);
        }
      }
    }

    this.teams = { teamOf, names, until: this.now() + TEAMS_TTL_MS };

    return teamOf;
  }

  private ownerLabel(id: string | null): string {
    if (id === null || id === '') {
      return 'nobody';
    }

    const kind = this.classify(id, this.teams?.teamOf ?? new Map());

    return kind === 'mine' ? 'you' : `${kind} agent ${id}`;
  }

  private value(field: string, value: unknown): string {
    if (value === null || value === undefined || value === '') {
      return '(none)';
    }

    if (field === 'Team') {
      return this.teams?.names.get(String(value)) ?? `team ${String(value)}`;
    }

    return field === 'Case Owner' ? this.ownerLabel(String(value)) : String(value);
  }

  /** An entry's heading and its HTML body. */
  private async entry(id: string, entry: ConversationEntry): Promise<{ heading: string; body: string }> {
    if (entry.type === 'comment') {
      const when = (entry.commentedTime ?? '').slice(0, 16).replace('T', ' ');

      return { heading: `### ${entry.isPublic === true ? 'Public comment' : 'Internal note'} by ${nameOf(entry.commenter)}, ${when}`, body: entry.content ?? '' };
    }

    // The conversation list omits thread bodies; each thread is read on its own.
    const thread = json(await this.get(`/tickets/${id}/threads/${encodeURIComponent(entry.id)}`)) as Thread | null;
    const when = (thread?.createdTime ?? entry.createdTime ?? '').slice(0, 16).replace('T', ' ');
    const direction = (thread?.direction ?? entry.direction) === 'in' ? 'from the customer' : 'to the customer';

    return { heading: `### Message ${direction} by ${nameOf(thread?.author ?? entry.author)}, ${when}`, body: thread?.content ?? thread?.summary ?? entry.summary ?? '' };
  }
}
