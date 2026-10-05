import type { PolledTicket } from './flow.js';
import type { Ticket } from './model.js';

/** A complete read of the source's tickets, or why the read failed or was incomplete. A failed read changes nothing. */
export type PollResult = { tickets: PolledTicket[] } | { error: string };

/** A link the source found for the ticket, such as the pull request that closes a GitHub issue (PRD R52). */
export interface SourceLink {
  label: string;
  target: string;
}

export type ContextResult = { context: string; links?: SourceLink[] } | { error: string };

/** A source plugin (PRD R1). It reads and never writes. */
export interface Source {
  /** The settings key, such as `github`. */
  readonly name: string;
  poll(): Promise<PollResult>;
  /** The triage context: the ticket's text, clipped and formatted for the classifier. */
  context(ticket: Ticket): Promise<ContextResult>;
  /** The ticket key a worktree's branch names by convention, or null (PRD R25). */
  keyOfBranch(branch: string): string | null;
}
