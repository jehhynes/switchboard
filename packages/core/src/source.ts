import type { PolledTicket } from './flow.js';
import type { Ticket } from './model.js';
import type { FocusPage } from './playbook.js';

/** A complete read of the source's tickets, or why the read failed or was incomplete. A failed read changes nothing. */
export type PollResult = { tickets: PolledTicket[] } | { error: string };

/** A link the source found for the ticket, such as the pull request that closes a GitHub issue (PRD R52). */
export interface SourceLink {
  label: string;
  target: string;
  /** Found in the ticket's text rather than tied to the work, as a GitHub issue a Zoho note names is (PRD R61). */
  mentioned?: boolean;
}

/** A page or comment the triage context tags with `id`, such as `[c3]`, which triage can return as the focus (PRD R79). */
export interface Anchor {
  /** `ticket`, `pr`, or `c1`, `c2`… in time order. */
  id: string;
  url: string;
  page: FocusPage;
}

/**
 * A warning does not fail triage; the hub logs it. Without `anchors`, the ticket is the only focus. `activityAt` is the time of the latest
 * activity by anyone but the operator that can ask for an action, such as a comment, or null when there is none (PRD R80); a source without it omits it.
 */
export type ContextResult = { context: string; links?: SourceLink[]; anchors?: Anchor[]; warning?: string; activityAt?: number | null } | { error: string };

/** A reported link checked against its ticket: refused with the reason, or not (PRD R52); an error leaves it unchecked. */
export type LinkCheck = { refused: string | null } | { error: string };

/** The ticket at a URL a ticket report names (PRD R83), as the source reads it, or why the read failed. */
export type TicketLookup = { ticket: { sourceKey: string; ref: string; repo: string; title: string; url: string; open: boolean } } | { error: string };

export type AssignmentLookup = { ticket: Extract<TicketLookup, { ticket: unknown }>['ticket']; assignmentKey: string | null; assigned: boolean } | { error: string };

/** A source plugin (PRD R1). It reads and never writes. */
export interface Source {
  /** The settings key, such as `github`. */
  readonly name: string;
  /** `current` holds the source's tickets that are assigned, in the pool or in the queue now, as the store keeps them. */
  poll(current: readonly Ticket[]): Promise<PollResult>;
  /** The triage context: the ticket's text, clipped and formatted for the classifier. */
  context(ticket: Ticket): Promise<ContextResult>;
  /** The ticket key a worktree's branch names by convention, or null (PRD R25). */
  keyOfBranch(branch: string): string | null;
  /** Checks a link a session reports for the ticket; a source without it accepts every link (PRD R52). */
  checkLink?(ticket: Ticket, target: string): Promise<LinkCheck>;
  /** Reads the ticket at `url`, or answers null when the URL is not one of this source's tickets (PRD R83). */
  ticketAt?(url: string): Promise<TicketLookup | null>;
  /** Actual operator assignment, independent of status/project eligibility; null for another source's URL. */
  assignmentAt?(url: string): Promise<AssignmentLookup | null>;
}
