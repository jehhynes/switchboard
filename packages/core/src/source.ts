import type { PolledTicket } from './flow.js';
import type { Ticket } from './model.js';
import type { FocusPage } from './playbook.js';

/** A complete read of the source's tickets, or why the read failed or was incomplete. A failed read changes nothing. */
export type PollResult = { tickets: PolledTicket[] } | { error: string };

/** A link the source found for the ticket, such as the pull request that closes a GitHub issue (PRD R52). */
export interface SourceLink {
  label: string;
  target: string;
}

/** A page or comment the triage context tags with `id`, such as `[c3]`, which triage can return as the focus (PRD R79). */
export interface Anchor {
  /** `ticket`, `pr`, or `c1`, `c2`… in time order. */
  id: string;
  url: string;
  page: FocusPage;
}

/** A warning does not fail triage; the hub logs it. Without `anchors`, the ticket is the only focus. */
export type ContextResult = { context: string; links?: SourceLink[]; anchors?: Anchor[]; warning?: string } | { error: string };

/** A reported link checked against its ticket: refused with the reason, or not (PRD R52); an error leaves it unchecked. */
export type LinkCheck = { refused: string | null } | { error: string };

/** A source plugin (PRD R1). It reads and never writes. */
export interface Source {
  /** The settings key, such as `github`. */
  readonly name: string;
  poll(): Promise<PollResult>;
  /** The triage context: the ticket's text, clipped and formatted for the classifier. */
  context(ticket: Ticket): Promise<ContextResult>;
  /** The ticket key a worktree's branch names by convention, or null (PRD R25). */
  keyOfBranch(branch: string): string | null;
  /** Checks a link a session reports for the ticket; a source without it accepts every link (PRD R52). */
  checkLink?(ticket: Ticket, target: string): Promise<LinkCheck>;
}
