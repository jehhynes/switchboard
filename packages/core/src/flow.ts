import type { Playbook } from './playbook.js';
import { activeSession, failedAtTriage, groupOf, retries, ownPrompt, QUESTION_CARD, resumesHeld, reviewKey, START_PROMPT, waitsOnCard, waitsOnPermission, waitsToStart } from './group.js';
import { heldSlots, queueWaits } from './queue.js';
import { backoff, givesUp, limitFor, MAX_ATTEMPTS, providerLimitUntil, SETUP_AT_LIMIT, waitsOnLimit } from './limit.js';
import { latestDue, SCHEDULE_SOURCE, scheduleText } from './schedule.js';
import { homeRepo, isRootPattern, repoOf, repoRoots, samePath, ticketRoot } from './repo.js';
import type { PermissionMode, Provider, ScheduleSettings, Settings } from './settings.js';
import { REPORT_KINDS } from './model.js';
import type { Immediacy, LimitReading, ReportKind, Session, SessionKind, SessionState, Severity, Ticket, TicketBlocker, Triage, WorkItem, WorkItemStatus } from './model.js';
import { focusUrl } from './focus.js';
import type { Anchor, SourceLink } from './source.js';
import type { Actor, EventRecord, NewWorkItem, Store } from './store.js';
import { renderTaskPrompt, sessionContract, sessionPrompt, triagePrompt } from './template.js';
import { personaById, resolvePersona, sessionTone, toneVersion } from './persona.js';
import type { PlaybookChoice, TemplateVariable } from './template.js';

export const ADHOC_SOURCE = 'adhoc';
/** A hosted conversation's title until its first message titles it (architecture.md § Hosted conversations). */
export const NEW_CONVERSATION_TITLE = 'New session';
/** Why a Claude start is refused while hooks are off: a held session's state comes only from its hook markers (PRD R93). */
export const NEEDS_HOOKS = 'Claude sessions need sessions.installHooks.';

/** The statuses of a run; entering one from another status starts the Working clock (PRD R27). */
const RUN_STATUSES: ReadonlySet<WorkItemStatus> = new Set(['setup', 'running']);

/** The statuses that put a work item in Ready for review for good (PRD R27). */
const READY_STATUSES: ReadonlySet<WorkItemStatus> = new Set(['awaiting-approval', 'finished']);

/** A ticket that leaves the source's scope stops being snoozed, so it leaves the Snoozed group (PRD R49). */
const UNSNOOZED = { snoozed: false, snoozedUntil: null, snoozeComment: null } as const;

const EMPTY_TRIAGE = { context: null, playbook: null, immediacy: null, severity: null, focus: null, model: null } as const;

export const MESSAGES = {
  stopped: 'Stopped by you.',
  setupWithoutWorktree: 'Setup ended without a worktree.',
  setupAtLimit: SETUP_AT_LIMIT,
  turnAtLimit: 'The turn stopped at a usage limit. Open the session to continue it after the reset.',
  limitSkipped: 'You typed in the session during its usage-limit wait, so Switchboard did not continue it.',
  limitGaveUp: `The session stopped at a usage limit, and ${MAX_ATTEMPTS} attempts to continue it did not start a turn.`,
  turnEnded: 'The turn ended without a done report.',
  sessionEnded: 'The session ended without a done report.',
  turnEndedWithoutApproval: 'The turn ended without an approval report.',
  sessionEndedWithoutApproval: 'The session ended without an approval report.',
  noTaskPlaybooks: 'No task playbooks to choose from.',
  doneStillAssigned: 'The session reported done, but the ticket is still assigned to you.',
  nothingNew: 'Nothing is newer than the earlier work item',
  holderStopped: 'The terminal holder stopped.',
  legacyEnded: 'Switchboard no longer runs Claude background sessions (claude --bg), so it ended this one. Open it in a terminal to resume it in the terminal holder.',
  legacyCodexEnded: 'Switchboard no longer runs codex exec, so it ended this Codex session. Open it in a terminal to resume it with codex resume.',
} as const;

/** Starts a task session's `outcomeDetail` while its done report waits for the hub's second read of the ticket (PRD R10). */
export const UNCONFIRMED_DONE = 'Waiting to read the ticket again';

/**
 * Why a work item cannot be reopened, or null (PRD R86): it must be done, its ticket's latest work item with no open one, and its ticket not
 * registered as handled by another session, whose work the scheduler would not start.
 */
export function reopenRefusal(item: Pick<WorkItem, 'id' | 'status'>, ticketItems: readonly Pick<WorkItem, 'id' | 'status'>[], ticket: Pick<Ticket, 'handledAssignmentKey'>): string | null {
  if (item.status !== 'done') {
    return 'The work item is not done.';
  }

  if (ticketItems.some((other) => other.id > item.id || other.status !== 'done')) {
    return 'Only the latest work item of a ticket with no open work item can be reopened.';
  }

  return ticket.handledAssignmentKey == null ? null : "Another session handles the ticket's assignment.";
}

/**
 * The task playbooks Start with guidance… offers, triage's choice among them: those of the work item's playbook namespace, in settings order. None for
 * a work item without a playbook, such as an ad-hoc one, or a scheduled run, which keeps its schedule's (PRD R35).
 */
export function playbookChoices(playbook: string | null, source: string, playbooks: ReadonlyMap<string, Playbook>): string[] {
  if (playbook === null || source === SCHEDULE_SOURCE) {
    return [];
  }

  const namespace = namespaceOf(playbook);

  return [...playbooks.values()].filter((candidate) => candidate.kind === 'task' && namespaceOf(candidate.name) === namespace).map((candidate) => candidate.name);
}

function namespaceOf(playbook: string): string {
  return playbook.split(':')[0]!;
}

/** A task session's done report whose first read still listed the ticket, on a work item the second read can still settle. */
export function awaitsRecheck(item: Pick<WorkItem, 'status'>, session: Pick<Session, 'kind' | 'outcome' | 'outcomeDetail'>): boolean {
  return session.kind === 'task' && session.outcome === 'done' && !!session.outcomeDetail?.startsWith(UNCONFIRMED_DONE) && (item.status === 'running' || item.status === 'awaiting-approval');
}

/** When an earlier work item of the ticket took in its activity, and that work item's playbook (PRD R80). */
export interface HandledWork {
  at: number;
  playbook: string | null;
}

/** True when the source reports no activity after the earlier work item took it in, so nothing new asks for an action (PRD R80). */
export function nothingNew(handled: HandledWork | null, activityAt: number | null | undefined): boolean {
  return handled !== null && activityAt !== undefined && (activityAt === null || activityAt <= handled.at);
}

/** One ticket from a complete poll. A ticket of the source missing from the poll is not in the assigned state. */
export interface PolledTicket {
  sourceKey: string;
  /** The reference people use, such as `#123` or `T456`; the source sets it (`{{ticket.ref}}`). */
  ref: string;
  /** The repository, `owner/name` in lowercase, for a source with repositories; empty otherwise. */
  repo: string;
  sourceId: string | null;
  title: string;
  url: string;
  assigned: boolean;
  /** Unclaimed in a queue the operator works, so they may pick it (PRD R47). Never true with `assigned`. */
  pool: boolean;
  /** When the customer has waited since, such as Zoho's `customerResponseTime`; it orders the pool (PRD R27). */
  sortAt: number | null;
  /** When the ticket last entered the source's scope, as the source records it, such as a Zoho ticket's move to its scope value; null when unknown (PRD R27). */
  enteredAt: number | null;
  /** The open issues blocking the ticket (PRD R90); a source that does not read them omits it. */
  blockers?: TicketBlocker[];
}

export type Report =
  | { kind: 'stage'; stage: string }
  | { kind: 'worktree'; path: string; branch: string | null }
  /** `assigned`: a fresh read still lists the task's ticket as assigned, so the work item waits for `done-checked` (PRD R10). */
  | { kind: 'done'; assigned?: boolean }
  | { kind: 'approval'; prompt: string; summary: string | null; report: string | null }
  | { kind: 'link'; label: string; target: string }
  | { kind: 'playbook'; playbook: string }
  | { kind: 'paste'; label: string; file: string }
  /** A follow-up for a new ad-hoc work item (PRD R68); a null repo or title takes the default. */
  | { kind: 'task'; prompt: string; repo: string | null; title: string | null }
  /** A Codex session's question, which it waits on once its turn ends (PRD R70). */
  | { kind: 'question'; text: string };

export type StopReason = 'operator' | 'release';

export type LiveState = Exclude<SessionState, 'starting' | 'ended'>;

/** A Switchboard session on a successful roster read, with the state its hook marker gives, or the roster's when it has none. */
export interface ObservedSession {
  sessionId: string;
  state: LiveState;
  detail: string | null;
  /** Listed as an interactive session, such as a registered session in the operator's own window, rather than one Switchboard holds. */
  interactive?: boolean;
  /** A held session's process tree as the holder last read it, which the resume guard checks (PRD R95). */
  tree?: Array<{ pid: number; created: string }>;
  /** The usage or rate limit the turn the read found ended at (architecture.md § Rate limits). */
  limit?: LimitReading;
}

/** A live fork that may replace a session (PRD R78), with the fork's own state. */
export interface ObservedFork {
  sessionId: string;
  nativeSessionId: string;
  shortId: string;
  state: LiveState;
  detail: string | null;
}

export type FlowEvent =
  | { type: 'poll'; source: string; tickets: PolledTicket[]; assignments?: { ticketId: number; expectedKey: string; key: string | null }[]; queue?: boolean }
  | { type: 'handled'; sessionId: string; source: string; sourceKey: string; ref: string; repo: string; title: string; url: string; key: string; release: boolean; assigned: boolean }
  | { type: 'poll-failed'; source: string; error: string }
  | {
      type: 'triage-succeeded';
      triageId: number;
      context: string;
      playbook: string;
      immediacy: Immediacy | null;
      severity: Severity | null;
      model: string | null;
      links?: SourceLink[];
      /** The anchor id the classifier chose, resolved against `anchors` and the playbook's page (PRD R79). */
      focus?: string | null;
      anchors?: Anchor[];
      /** `nothingNew` held, so the work item waits for Start whatever the playbook's `autoStart` (PRD R80). */
      stale?: boolean;
    }
  | { type: 'triage-failed'; triageId: number; error: string; context: string | null }
  /** The hub stopped during triage. Nothing failed, so the work item is triaged again. */
  | { type: 'triage-cancelled'; triageId: number }
  /** `launchId`: the launch of a Code Mode session's process (PRD R93). */
  | { type: 'session-started'; sessionId: string; nativeSessionId: string | null; shortId: string; startPrompt?: true; launchId?: string }
  | { type: 'session-start-failed'; sessionId: string; message: string }
  | { type: 'session-start-pending'; sessionId: string; message: string }
  /** `checked` lists the sessions the read looked for, so a session whose start completed during the read is not ended; all when absent. */
  | { type: 'roster'; sessions: ObservedSession[]; checked?: string[]; forks?: ObservedFork[] }
  /** `limit`: what the runner read about the usage or rate limit a turn ended at (architecture.md § Rate limits). */
  | { type: 'marker'; sessionId: string; state: LiveState; detail: string | null; limit?: LimitReading | null }
  /** A limit read after the turn end's marker, such as Claude Code's own wait written just after its Stop (mechanics M100). */
  | { type: 'limit-found'; sessionId: string; limit: LimitReading }
  /** The hub typed the continue text into a session waiting on its limit, or could not, with why (architecture.md § Rate limits). */
  | { type: 'limit-attempt'; sessionId: string; error: string | null }
  /** The hub did not continue a session waiting on its limit, because the operator acted in its terminal since. */
  | { type: 'limit-skipped'; sessionId: string; reason: string }
  | { type: 'release-cancelled'; sessionId: string }
  /** The terminal holder that held this Code Mode session is gone (PRD R94). */
  | { type: 'holder-lost'; sessionId: string }
  /**
   * The holder lists this Code Mode session with no terminal attached and no input or output for the idle limit (PRD R95), or this Codex app-server
   * thread has had no turn for it (PRD R107).
   */
  | { type: 'held-idle'; sessionId: string }
  /** `POST /attach` is about to resume this ended Code Mode session under this launch, stored first so a hub restart during the spawn can recognize it (PRD R95). */
  /** `adopt`: an ended registered session becomes held as its resume starts, in Code Mode only when it ran in it (PRD R81). */
  | { type: 'held-resuming'; sessionId: string; launchId: string; adopt?: { codeMode: boolean } }
  /**
   * `POST /attach` resumed this ended Code Mode session in the holder under a new launch, or the hub found it live under its stored launch (PRD R95),
   * or the hub resumed this ended Codex app-server thread under a new launch (PRD R107).
   */
  | { type: 'held-resumed'; sessionId: string; launchId: string }
  | { type: 'report'; sessionId: string; report: Report }
  /** The hub's recheck of a done report whose first read still listed the ticket as assigned (PRD R10). */
  /** 	oken is the session's outcomeDetail when the hub scheduled the read, so a check of a superseded report changes nothing. */
  | { type: 'done-checked'; sessionId: string; token: string; assigned: boolean }
  /**
   * `shortId` is the copy the stop targeted; a result for a copy a fork retired changes nothing (PRD R78). `leftovers`: the stop ended the processes an
   * ended Code Mode session's last run left (PRD R95).
   */
  | { type: 'stop-succeeded'; sessionId: string; reason: StopReason; shortId?: string | null; leftovers?: true }
  | { type: 'stop-failed'; sessionId: string; reason: StopReason; message: string; shortId?: string | null; leftovers?: true }
  | { type: 'worktree-found'; source: string; sourceKey: string; path: string; branch: string }
  /** `start` queues the work item to run now; otherwise it waits `unstarted` for Start (PRD R6). */
  | { type: 'adhoc'; prompt: string; repoRoot: string; start?: boolean; provider?: Provider; model?: string | null }
  /** A standalone conversation (PRD R122), empty or with `prompt` as its first message. */
  | { type: 'new-session'; repoRoot: string; provider?: Provider; model?: string | null; prompt?: string }
  /**
   * New conversation… on the web page (architecture.md § Web page): a new session of the work item, in its folder, with `prompt`, the
   * operator's first message, as its prompt; in `provider`, else its latest session's.
   */
  | { type: 'item-session'; workItemId: number; prompt: string; provider?: Provider }
  | { type: 'conversation-title'; workItemId: number; text: string; origin?: 'provider-manual' | 'provider-auto' }
  /** The operator pins a persona to a Code Mode session, or clears its pin with null (architecture.md § Personas). */
  | { type: 'persona'; sessionId: string; personaId: string | null }
  /** The contract hook gave a Code Mode session's prompt its tone section as the settings have it now (architecture.md § Personas). */
  | { type: 'persona-delivered'; sessionId: string }
  /** A live Claude session the operator started outside Switchboard, as the roster lists it (PRD R81). */
  | { type: 'register'; nativeSessionId: string; shortId: string; cwd: string; title: string }
  /**
   * A ticket report: the session's ad-hoc work item continues as the work item of the source's ticket the hub read, with `playbook` when
   * the report names one (PRD R83).
   */
  | { type: 'ticket'; sessionId: string; source: string; sourceKey: string; ref: string; repo: string; title: string; url: string; playbook: string | null }
  /** Run now: a queued work item for the named schedule (PRD R82). */
  | { type: 'run-schedule'; name: string }
  /** `retry` retries a failed work item from the step that failed (PRD R34). */
  | { type: 'approve' | 'mark-done' | 'reopen' | 'retry' | 'delete'; workItemId: number }
  /** `sessionId` names a held session of the work item to stop, which may be an older one whose end waits for its terminal (PRD R94). */
  | { type: 'stop'; workItemId: number; sessionId?: string }
  /** `guidance` is added to the task session's prompt (PRD R77); `playbook` replaces triage's choice (PRD R35); `prompt` replaces an ad-hoc one (PRD R77). */
  | { type: 'start'; workItemId: number; guidance?: string | null; playbook?: string | null; prompt?: string | null }
  | { type: 'pick'; ticketId: number; guidance?: string | null; playbook?: string | null }
  /**
   * The hub started: Claude sessions an earlier hub ran in Claude's background service, and Codex sessions it ran as `codex exec`, end, since nothing
   * observes them now (PRD R93, R107).
   */
  | { type: 'end-legacy' }
  | { type: 'retriage-pool' | 'restore'; ticketId: number }
  /** Snoozes the ticket until `until`, or indefinitely when null, with the operator's comment (PRD R49). */
  | { type: 'snooze'; ticketId: number; until: number | null; comment?: string | null }
  /** Adds the operator's comment to a work item (PRD R87). */
  | { type: 'comment'; workItemId: number; text: string }
  /** Places a Ready for review work item after `after`, or first when null (PRD R73). */
  | { type: 'move'; workItemId: number; after: number | null }
  /** Returns a moved work item to its place by readyAt (PRD R73). */
  | { type: 'reset-position'; workItemId: number }
  | { type: 'tick' };

export type TriageChoice = PlaybookChoice;

export type FlowAction =
  | {
      type: 'triage';
      triageId: number;
      /** Null for a pool triage. */
      workItemId: number | null;
      ticket: Ticket;
      systemPrompt: string;
      choices: TriageChoice[];
      /** Whether the triage playbook rates immediacy and severity. */
      rates: boolean;
      model: string | null;
      timeoutSeconds: number;
      /** The latest earlier work item's handling; null for a pool triage or a ticket without one (PRD R80). */
      handled: HandledWork | null;
    }
  | {
      type: 'start-session';
      sessionId: string;
      workItemId: number;
      kind: SessionKind;
      /** The runner that starts it (PRD R22). */
      provider: Provider;
      cwd: string;
      /** The repository whose clone `cwd` must be, when a `{name}` pattern resolved it; the hub refuses a folder that is not a checkout. */
      clone?: string;
      /** The first message. */
      prompt: string;
      /** The report contract, appended to the system prompt. */
      contract: string;
      name: string;
      permissionMode: PermissionMode;
      model: string | null;
      /** A Code Mode session's Claude session ID and the launch of its process, chosen before the start so a restarted hub can find it (PRD R93). */
      nativeSessionId?: string;
      launchId?: string;
      /** Held in the terminal holder (PRD R93), in Code Mode unless `withoutCodeMode`. */
      codeMode?: true;
      /** A held Claude session started with `sessions.codeMode` off, as a plain interactive `claude` (PRD R93). */
      withoutCodeMode?: true;
      execution?: 'app-server';
      /** A Code Mode session's tone section, appended after its conversation rules (architecture.md § Personas). */
      tone?: string;
    }
  /**
   * The provider travels with the action, because Delete removes the session's row before its stop runs. `leftovers`: ends the processes of an ended
   * Code Mode session's last process tree that still run (PRD R95).
   */
  | { type: 'stop-session'; sessionId: string; provider: Provider; shortId: string | null; reason: StopReason; codeMode?: true; execution?: 'app-server'; leftovers?: true };

export interface FlowContext {
  now: number;
  settings: Settings;
  playbooks: ReadonlyMap<string, Playbook>;
  /** The report command prefix, `<sessions.nodePath> "<home>/hub.js" report`. */
  report: string;
  newSessionId(): string;
  /** A random UUID, for a Code Mode session's Claude session ID and launch (PRD R93). */
  newUuid(): string;
  /** Whether the session's conversation holds a question card no message has answered yet (PRD R103); none without it. */
  questionCard?(sessionId: string): boolean;
}

export interface FlowResult {
  actions: FlowAction[];
  /** Why an operator action or report was refused, or null. */
  refused: string | null;
}

class Refusal extends Error {}

/**
 * The reports a session's prompt offers (PRD R23). A playbook's task session gets stage, link and the playbook's own; a setup or approved
 * session finishes with done, and an ad-hoc prompt has no playbook to narrow them.
 */
function sessionReports(kind: SessionKind, approved: boolean, playbook: Playbook | null, provider: Provider): ReportKind[] {
  // A background Codex run cannot wait on the operator mid-turn, so it reports its question (mechanics M31).
  const asks = (entry: ReportKind) => entry === 'question' && provider === 'codex';

  if (kind !== 'task' || approved) {
    return REPORT_KINDS.filter((entry) => ['stage', 'worktree', 'done', 'link', 'task'].includes(entry) || asks(entry));
  }

  // An ad-hoc work item has no playbook to change.
  return playbook === null
    ? REPORT_KINDS.filter((entry) => entry !== 'playbook' && (entry !== 'question' || asks(entry)))
    : REPORT_KINDS.filter((entry) => entry === 'stage' || entry === 'link' || entry === 'task' || asks(entry) || (playbook.reports as readonly string[]).includes(entry));
}

/** Why a task session's turn or process ended without the done or approval report its prompt offered. */
function endedMessage(session: Session, turn: boolean): string {
  if (session.reports.includes('done')) {
    return turn ? MESSAGES.turnEnded : MESSAGES.sessionEnded;
  }

  return turn ? MESSAGES.turnEndedWithoutApproval : MESSAGES.sessionEndedWithoutApproval;
}

const TURN_ENDED: readonly SessionState[] = ['idle', 'failed'];

/** The prompt's first non-empty line, which titles an ad-hoc ticket. */
function firstLine(prompt: string): string {
  return prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
}

/** Whether a session ended at its start, refused before its first message was taken, rather than after it ran (`sessionStartFailed`). */
function startFailed(session: Session): boolean {
  return session.outcome === 'failed' && session.outcomeDetail !== MESSAGES.holderStopped;
}

/** Refuses a model name that is blank or 200 characters or longer. */
function checkModel(model: string | null | undefined): void {
  if (model != null && (model.trim() === '' || model.length > 200)) throw new Refusal('Choose a model name under 200 characters.');
}

/** A short label while the provider has not named the conversation, or for a session that has no title of its own. */
export function summarizeMessage(message: string): string {
  const plain = message.replace(/^(?:\[(?:voice|spoken|expressive)\]\s*)+/i, '').replace(/\s+/g, ' ').trim();
  const sentence = plain.split(/(?<=[.!?])\s/, 1)[0] ?? '';
  const subject = sentence.replace(/^(?:please\s+|i(?:'d| would) like (?:you )?to\s+|can you\s+|could you\s+)/i, '').replace(/[.!]+$/, '').trim();
  if (subject.length <= 72) return subject;
  const short = subject.slice(0, 73).replace(/\s+\S*$/, '').trim();
  return short === '' ? subject.slice(0, 72) : short.slice(0, 72);
}

/** Start with prompt…'s trimmed prompt when it differs from the work item's stored one, else null (PRD R77). */
function editedPrompt(store: Store, workItemId: number, prompt: string | null | undefined): string | null {
  const text = textOf(prompt);
  const item = store.workItem(workItemId);

  return text === null || item === null || text === ownPrompt(item)?.trim() ? null : text;
}

/** The operator's text, such as Start's guidance (PRD R77) or a comment (PRD R49, R87), trimmed, or null when blank. */
function textOf(text: string | null | undefined): string | null {
  return text?.trim() || null;
}

const OPERATOR_EVENTS: ReadonlySet<FlowEvent['type']> = new Set(['adhoc', 'new-session', 'item-session', 'register', 'run-schedule', 'start', 'approve', 'mark-done', 'reopen', 'retry', 'stop', 'delete', 'pick', 'retriage-pool', 'restore', 'snooze', 'comment', 'move', 'reset-position', 'persona']);

/**
 * Events logged even when they change nothing, because they record a request or a report (PRD R59). The rest, such as polls and
 * roster reads, are logged only when they change a row.
 */
const ALWAYS_LOGGED: ReadonlySet<FlowEvent['type']> = new Set([...OPERATOR_EVENTS, 'report', 'ticket', 'session-start-failed', 'stop-failed', 'limit-found', 'limit-attempt', 'limit-skipped']);

function actorOf(type: FlowEvent['type']): Actor {
  if (OPERATOR_EVENTS.has(type)) {
    return 'operator';
  }

  switch (type) {
    case 'report':
    case 'ticket':
      return 'session';
    case 'handled':
      return 'session';
    case 'poll':
    case 'poll-failed':
      return 'source';
    case 'triage-succeeded':
    case 'triage-failed':
      return 'triage';
    default:
      return 'hub';
  }
}

/** The flag a Code Mode session's actions carry, because Delete removes the session's row before its stop runs. */
function codeModeOf(session: Pick<Session, 'codeMode' | 'execution'>): { codeMode?: true; execution?: 'app-server' } {
  return session.codeMode === true ? { codeMode: true } : session.execution === 'app-server' ? { execution: 'app-server' } : {};
}

function persistent(session: Pick<Session, 'codeMode' | 'execution'>): boolean {
  return session.codeMode === true || session.execution === 'app-server';
}

/** A stop result for a copy that a fork retired after the stop was sent. */
function retiredStop(session: Session, shortId: string | null | undefined): boolean {
  return shortId !== undefined && shortId !== session.shortId;
}

/** The permission mode and model a session of this kind starts with: a task session's playbook's, else the provider's settings. */
export function launchOptions(settings: Settings, playbook: Playbook | null, kind: SessionKind, provider: Provider): { permissionMode: PermissionMode; model: string | null } {
  const own = kind === 'task' ? playbook : null;
  const sessions = settings.sessions;

  return {
    permissionMode: own?.permissionMode ?? (provider === 'codex' ? sessions.codex.permissionMode : sessions.permissionMode),
    model: own?.model ?? ((provider === 'codex' ? sessions.codex.model : sessions.model) || null),
  };
}

/** The name a session starts with, which a Code Mode session's holder label also carries. */
export function sessionName(kind: SessionKind, item: Pick<WorkItem, 'playbook'>, ticket: Pick<Ticket, 'source' | 'sourceKey'>): string {
  return `switchboard · ${kind === 'task' ? (item.playbook ?? 'ad-hoc') : kind} · ${ticket.source} ${ticket.sourceKey}`;
}

/** A limit as the log keeps it, without the message, which the session's transcript holds. */
function limitDetail(limit: LimitReading): Record<string, unknown> {
  return { kind: limit.kind, window: limit.window, resetsAt: limit.resetsAt, cli: limit.cli };
}

/** A turn that failed with `rate_limit` when the runner read nothing more about the limit. */
const UNREAD_LIMIT: LimitReading = { kind: 'usage', window: null, resetsAt: null, exact: false, cli: false, message: null };

/** The provider a work item's next session starts in: its playbook's, else its own choice while it has none, else `sessions.provider`. */
export function itemProvider(settings: Settings, playbooks: ReadonlyMap<string, Playbook>, item: Pick<WorkItem, 'playbook' | 'provider'>): Provider {
  const playbook = item.playbook === null ? null : (playbooks.get(item.playbook) ?? null);

  return playbook === null ? (item.provider ?? settings.sessions.provider) : (playbook.provider ?? settings.sessions.provider);
}

/** The event's own fields for the log: no prompt, context or polled list, except the prompt the operator edited in Start with prompt… (PRD R77). */
function detailOf(store: Store, event: FlowEvent): Record<string, unknown> | null {
  switch (event.type) {
    case 'poll':
    case 'poll-failed':
      return { source: event.source };
    case 'triage-succeeded':
      return { triageId: event.triageId, playbook: event.playbook, immediacy: event.immediacy, severity: event.severity, model: event.model, ...(event.stale ? { stale: true } : {}) };
    case 'triage-failed':
      return { triageId: event.triageId, error: event.error };
    case 'triage-cancelled':
      return { triageId: event.triageId };
    case 'session-started':
      return { shortId: event.shortId, ...(event.startPrompt ? { startPrompt: true } : {}), ...(event.launchId === undefined ? {} : { launchId: event.launchId }) };
    case 'held-resumed':
      return { launchId: event.launchId };
    case 'held-resuming':
      return event.adopt === undefined ? null : { codeMode: event.adopt.codeMode };
    case 'session-start-failed':
      return { message: event.message };
    case 'marker':
      return { state: event.state, detail: event.detail, ...(event.limit == null ? {} : { limit: limitDetail(event.limit) }) };
    case 'limit-found':
      return { limit: limitDetail(event.limit) };
    case 'limit-attempt':
      return { attempt: (store.session(event.sessionId)?.rateLimit?.attempts ?? 0) + 1, ...(event.error === null ? {} : { error: event.error }) };
    case 'limit-skipped':
      return { reason: event.reason };
    case 'report': {
      const { prompt: _prompt, ...report } = event.report as Report & { prompt?: string };
      return report;
    }
    case 'done-checked':
      return { assigned: event.assigned };
    case 'stop-succeeded':
      return { reason: event.reason, ...(event.leftovers ? { leftovers: true } : {}) };
    case 'stop-failed':
      return { reason: event.reason, message: event.message, ...(event.leftovers ? { leftovers: true } : {}) };
    case 'worktree-found':
      return { path: event.path, branch: event.branch };
    case 'adhoc':
      return { repoRoot: event.repoRoot, start: event.start === true, model: event.model ?? null };
    case 'new-session':
      return { repoRoot: event.repoRoot, provider: event.provider ?? null, model: event.model ?? null };
    case 'item-session':
      return { provider: event.provider ?? null };
    case 'persona':
      return { personaId: event.personaId };
    case 'register':
      return { cwd: event.cwd };
    case 'ticket':
      return { source: event.source, sourceKey: event.sourceKey, playbook: event.playbook };
    case 'handled':
      return { source: event.source, sourceKey: event.sourceKey, key: event.key, release: event.release, reportedBySessionId: event.sessionId };
    case 'run-schedule':
      return { name: event.name };
    case 'start':
    case 'pick': {
      const detail = { ...(textOf(event.guidance) === null ? {} : { guidance: textOf(event.guidance) }), ...(event.playbook == null ? {} : { playbook: event.playbook }) };
      const prompt = event.type === 'start' ? editedPrompt(store, event.workItemId, event.prompt) : null;
      const all = prompt === null ? detail : { ...detail, prompt };

      return Object.keys(all).length === 0 ? null : all;
    }
    case 'snooze':
      return textOf(event.comment) === null ? { until: event.until } : { until: event.until, comment: textOf(event.comment) };
    case 'comment':
      return { text: textOf(event.text) };
    case 'move':
      return { after: event.after };
    case 'delete':
      return { workItemId: event.workItemId };
    default:
      return null;
  }
}

/** The ticket, work item and session an event names, when it names one that exists. */
function subjectOf(store: Store, event: FlowEvent): Pick<EventRecord, 'ticketId' | 'workItemId' | 'sessionId'> {
  const none = { ticketId: null, workItemId: null, sessionId: null };
  if (event.type === 'handled') return { ...none, ticketId: store.findTicket(event.source, event.sourceKey)?.id ?? null };
  const ofItem = (workItemId: number | null, sessionId: string | null = null) => {
    const item = workItemId === null ? null : store.workItem(workItemId);
    return item === null ? none : { ticketId: item.ticketId, workItemId: item.id, sessionId };
  };

  if ('sessionId' in event) {
    const session = store.session(event.sessionId);
    return session === null ? none : ofItem(session.workItemId, session.id);
  }

  // The ticket's log keeps the delete, because the work item's own log is deleted with it (PRD R120).
  if (event.type === 'delete') {
    return { ...none, ticketId: store.workItem(event.workItemId)?.ticketId ?? null };
  }

  if ('workItemId' in event) {
    return ofItem(event.workItemId);
  }

  if ('triageId' in event) {
    const triage = store.triage(event.triageId);
    return triage === null ? none : { ticketId: triage.ticketId, workItemId: triage.workItemId, sessionId: null };
  }

  if ('ticketId' in event) {
    return { ...none, ticketId: store.ticket(event.ticketId)?.id ?? null };
  }

  if (event.type === 'worktree-found') {
    return { ...none, ticketId: store.findTicket(event.source, event.sourceKey)?.id ?? null };
  }

  if (event.type === 'run-schedule') {
    return { ...none, ticketId: store.findTicket(SCHEDULE_SOURCE, event.name)?.id ?? null };
  }

  return none;
}

/** The event as the activity log records it (PRD R59). */
export function eventRecord(store: Store, event: FlowEvent, at: number): EventRecord {
  return { at, type: event.type, actor: actorOf(event.type), ...subjectOf(store, event), detail: detailOf(store, event) };
}

/** Logs an event the hub refused before the flow saw it, such as a worktree report naming no git worktree. */
export function recordRefusal(store: Store, event: FlowEvent, at: number, message: string): void {
  const record = eventRecord(store, event, at);

  try {
    store.beginEvent(record, record.ticketId !== null);
    store.refuseEvent(message);
  } finally {
    store.endEvent();
  }
}

/** Decides what one event changes and which actions the hub runs. Call it inside one store transaction. */
export function handle(store: Store, event: FlowEvent, context: FlowContext): FlowResult {
  const flow = new Flow(store, context);

  try {
    store.beginEvent({ at: context.now, type: 'wake', actor: 'hub', ticketId: null, workItemId: null, sessionId: null, detail: null });
    flow.wake();

    // The hub ticks every minute, so a schedule's run starts within a minute of its time (PRD R82).
    if (event.type === 'tick') {
      flow.runSchedules();
    }

    const record = eventRecord(store, event, context.now);

    store.beginEvent(record, ALWAYS_LOGGED.has(event.type) && record.ticketId !== null);

    try {
      flow.apply(event);
    } catch (error) {
      if (error instanceof Refusal) {
        store.refuseEvent(error.message);
        return { actions: [], refused: error.message };
      }

      throw error;
    }

    flow.endUnownedHandling();
    flow.schedule();

    return { actions: flow.actions, refused: null };
  } finally {
    store.endEvent();
  }
}

class Flow {
  readonly actions: FlowAction[] = [];

  constructor(
    private readonly store: Store,
    private readonly context: FlowContext,
  ) {}

  private get now(): number {
    return this.context.now;
  }

  apply(event: FlowEvent): void {
    switch (event.type) {
      case 'poll':
        return this.poll(event.source, event.tickets, event.assignments, event.queue === true);
      case 'handled':
        return this.registerHandled(event);
      case 'poll-failed':
        return;
      case 'tick':
        return this.limitsDue();
      case 'triage-succeeded':
        return this.triageSucceeded(event);
      case 'triage-failed':
        return this.triageFailed(event.triageId, event.error, event.context);
      case 'triage-cancelled':
        return this.triageCancelled(event.triageId);
      case 'session-started':
        return this.sessionStarted(event.sessionId, event.nativeSessionId, event.shortId, event.startPrompt === true, event.launchId);
      case 'session-start-pending': {
        const session = this.session(event.sessionId);
        if (session.state === 'starting') {
          this.store.updateSession(session.id, { stateDetail: event.message });
          const item = this.latest(session);
          if (item !== null) this.store.updateWorkItem(item.id, { warning: event.message });
        }
        return;
      }
      case 'session-start-failed':
        return this.sessionStartFailed(event.sessionId, event.message);
      case 'roster':
        return this.roster(event.sessions, event.checked, event.forks ?? []);
      case 'marker':
        return this.marker(event.sessionId, event.state, event.detail, event.limit ?? null);
      case 'limit-found':
        return this.limitFound(event.sessionId, event.limit);
      case 'limit-attempt':
        return this.limitAttempt(event.sessionId, event.error);
      case 'limit-skipped':
        return this.limitSkipped(event.sessionId);
      case 'holder-lost':
        return this.holderLost(event.sessionId);
      case 'held-idle':
        return this.heldIdle(event.sessionId);
      case 'held-resuming':
        return this.heldResuming(event.sessionId, event.launchId, event.adopt);
      case 'held-resumed':
        return this.heldResumed(event.sessionId, event.launchId);
      case 'report':
        return this.report(event.sessionId, event.report);
      case 'done-checked':
        return this.doneChecked(event.sessionId, event.token, event.assigned);
      case 'stop-succeeded':
        return this.stopSucceeded(event.sessionId, event.reason, event.shortId, event.leftovers === true);
      case 'stop-failed':
        return this.stopFailed(event.sessionId, event.reason, event.message, event.shortId, event.leftovers === true);
      case 'release-cancelled':
        if (this.store.session(event.sessionId) !== null) this.store.updateSession(event.sessionId, { releasing: false });
        return;
      case 'worktree-found':
        return this.worktreeFound(event.source, event.sourceKey, event.path, event.branch);
      case 'adhoc':
        return this.adhoc(event.prompt, event.repoRoot, event.start === true, event.provider, event.model);
      case 'new-session':
        return this.newSession(event.repoRoot, event.provider, event.model, event.prompt);
      case 'item-session':
        return this.itemSession(this.openItem(event.workItemId), event.prompt, event.provider);
      case 'conversation-title':
        return this.conversationTitle(event.workItemId, event.text, event.origin);
      case 'persona':
        return this.pinPersona(event.sessionId, event.personaId);
      case 'persona-delivered':
        return this.personaDelivered(event.sessionId);
      case 'register':
        return this.register(event);
      case 'ticket':
        return this.moveToTicket(event);
      case 'run-schedule':
        return this.runSchedule(event.name);
      case 'start':
        return this.start(this.openItem(event.workItemId), textOf(event.guidance), event.playbook ?? null, editedPrompt(this.store, event.workItemId, event.prompt));
      case 'approve':
        return this.approve(this.openItem(event.workItemId));
      case 'mark-done':
        return this.done(this.openItem(event.workItemId), 'operator', null);
      case 'reopen':
        return this.reopen(this.knownItem(event.workItemId));
      case 'retry':
        return this.retry(this.openItem(event.workItemId));
      case 'stop':
        return this.stop(this.knownItem(event.workItemId), event.sessionId ?? null);
      case 'delete':
        return this.delete(this.knownItem(event.workItemId));
      case 'end-legacy':
        return this.endLegacy();
      case 'pick':
        return this.pick(this.poolTicket(event.ticketId), textOf(event.guidance), event.playbook ?? null);
      case 'retriage-pool':
        return this.retriagePool(this.poolTicket(event.ticketId));
      case 'snooze':
        return this.snooze(event.ticketId, event.until, textOf(event.comment));
      case 'comment':
        return this.comment(this.knownItem(event.workItemId), textOf(event.text));
      case 'restore':
        return this.restore(event.ticketId);
      case 'move':
        return this.move(this.reviewItem(event.workItemId), event.after);
      case 'reset-position':
        return this.store.updateWorkItem(this.reviewItem(event.workItemId).id, { orderAt: null });
    }
  }

  /** Ends every snooze whose wake time has passed, so the ticket returns to its group on the next event (PRD R49). */
  wake(): void {
    for (const ticket of this.store.dueSnoozes(this.now)) {
      this.store.updateTicket(ticket.id, UNSNOOZED);
    }
  }

  /**
   * Ends each handled assignment whose reporting work item is done or deleted, and gives a still-assigned ticket a work item, so no ticket
   * stays hidden after the work that handled it ends (PRD R85).
   */
  endUnownedHandling(): void {
    const ended: number[] = [];

    for (const ticket of this.store.handledTickets()) {
      const registration = this.store.handledRegistrations(ticket.id).filter((entry) => entry.key === ticket.handledAssignmentKey).at(-1);
      const reporter = registration?.workItemId == null ? null : this.store.workItem(registration.workItemId);

      if (reporter !== null && reporter.status !== 'done') {
        continue;
      }

      this.store.updateTicket(ticket.id, { handledAssignmentKey: null });
      ended.push(ticket.id);

      if (ticket.assigned) {
        this.createWorkItem(ticket.id);
      }
    }

    if (ended.length > 0) {
      this.store.noteEvent({ handledEnded: ended });
    }
  }

  // Sources

  private poll(source: string, polled: PolledTicket[], assignments: Extract<FlowEvent, { type: 'poll' }>['assignments'] = [], queue = false): void {
    const returned = new Set<number>();
    const assignmentChanges: { ticketId: number; reason: string }[] = [];
    for (const assignment of assignments) {
      const ticket = this.store.ticket(assignment.ticketId);
      if (ticket?.source !== source || ticket.handledAssignmentKey !== assignment.expectedKey || assignment.key === assignment.expectedKey) continue;
      this.store.updateTicket(ticket.id, { handledAssignmentKey: null });
      assignmentChanges.push({ ticketId: ticket.id, reason: assignment.key === null ? 'unassigned' : 'reassigned' });
      returned.add(ticket.id);
    }
    if (assignmentChanges.length > 0) this.store.noteEvent({ assignmentChanges });
    const seen = new Set<string>();

    for (const entry of polled) {
      seen.add(entry.sourceKey);

      const known = this.store.findTicket(source, entry.sourceKey);
      const fields = {
        ref: entry.ref,
        repo: entry.repo,
        sourceId: entry.sourceId,
        title: entry.title,
        url: entry.url,
        assigned: entry.assigned,
        pool: entry.pool,
        sortAt: entry.sortAt,
        scopeAt: this.scopeAt(known, entry),
        lastPolledAt: this.now,
        // A read that does not list blockers, such as GitHub's read of an issue missing from the search, keeps the last ones seen.
        ...(entry.blockers === undefined ? {} : { blockers: entry.blockers }),
        ...(entry.assigned || entry.pool ? {} : UNSNOOZED),
      };

      if (known === null) {
        const ticket = this.store.insertTicket({ source, sourceKey: entry.sourceKey, repoRoot: '', snoozed: false, snoozedUntil: null, ...fields });

        if (entry.assigned) {
          this.createWorkItem(ticket.id);
        }

        continue;
      }

      this.store.updateTicket(known.id, fields);

      if (known.pool && !entry.pool) {
        this.leftPool(known.id);
      } else if (!known.pool && entry.pool) {
        this.reenteredPool(known.id);
      }

      if (entry.assigned && (!known.assigned || returned.has(known.id))) {
        this.createWorkItem(known.id);
      } else if (!entry.assigned && known.assigned) {
        this.left(known.id);
      }
    }

    for (const ticket of this.store.currentTickets(source)) {
      if (!seen.has(ticket.sourceKey)) {
        this.store.updateTicket(ticket.id, { assigned: false, pool: false, lastPolledAt: this.now, ...UNSNOOZED });

        if (ticket.pool) {
          this.leftPool(ticket.id);
        }

        if (ticket.assigned) {
          this.left(ticket.id);
        }
      }
    }
  }

  /**
   * When the ticket entered the source's scope (PRD R53). The source's time wins, because its scope can be wider than the assigned state and
   * the pool, such as a GitHub issue on another status. Without one, the ticket keeps its time, or takes this poll's when it has none.
   */
  private scopeAt(known: Ticket | null, entry: PolledTicket): number | null {
    return entry.enteredAt ?? known?.scopeAt ?? (entry.assigned || entry.pool ? this.now : null);
  }

  /** A ticket that entered the assigned state gets a work item, unless it already has an open one, such as a picked pool ticket's (PRD R48). */
  private createWorkItem(ticketId: number): void {
    if (this.store.ticket(ticketId)?.handledAssignmentKey != null) return;
    const open = this.store.workItemsForTicket(ticketId).filter((item) => item.status !== 'done');

    if (open.length > 0) {
      // Assigned again: the deferred unassignment no longer applies (PRD R10).
      for (const item of open.filter((entry) => entry.unassignedAt !== null)) {
        this.store.updateWorkItem(item.id, { unassignedAt: null });
      }

      return;
    }

    this.store.insertWorkItem({
      ticketId,
      playbook: null,
      status: 'triaging',
      stage: null,
      stageAt: null,
      taskPrompt: null,
      guidance: null,
      reportedPrompt: null,
      warning: null,
      error: null,
      unassignedAt: null,
      queuedAt: null,
      approvalPrompt: null,
      approvalSummary: null,
      approvalReport: null,
      approvalHeld: false,
      createdAt: this.now,
      statusAt: this.now,
      readyAt: null,
      orderAt: null,
      runStartedAt: this.now,
      scopeAt: null,
      doneAt: null,
      doneReason: null,
      parentId: null,
    });
  }

  /**
   * A ticket that left the pool without a pick loses its pool triage, so it is triaged again if it returns (PRD R47). A running one is kept
   * until it ends, so it still counts toward `triage.concurrency` and a work item on the ticket waits for it rather than starting a second.
   */
  private leftPool(ticketId: number): void {
    for (const triage of this.store.poolTriages(ticketId)) {
      if (triage.endedAt !== null) this.store.deleteTriage(triage.id);
    }
  }

  /** A ticket back in the pool drops a pool triage still running from before it left, so the new entry is triaged afresh. */
  private reenteredPool(ticketId: number): void {
    for (const triage of this.store.poolTriages(ticketId)) {
      this.store.deleteTriage(triage.id);
    }
  }

  /** Drops a pool triage that ends after its ticket left the pool, before its result touches the ticket; true when it did. */
  private leftPoolTriage(triage: Triage): boolean {
    if (triage.workItemId !== null || this.store.ticket(triage.ticketId)!.pool) {
      return false;
    }

    this.store.deleteTriage(triage.id);
    return true;
  }

  /**
   * PRD R10: deleted when it never had a session, done now when no session is active or its session reported done, otherwise
   * when the active session reports or ends. A running triage also defers the deletion, so its row keeps holding a `triage.concurrency`
   * slot until the classifier finishes.
   */
  private left(ticketId: number): void {
    const running = new Set(this.store.runningTriages().map((triage) => triage.workItemId));

    for (const item of this.store.workItemsForTicket(ticketId)) {
      if (item.status === 'done') {
        continue;
      }

      const active = this.activeSession(item);

      if (this.store.sessionsFor(item.id).length === 0) {
        if (!running.has(item.id)) {
          this.store.deleteWorkItem(item.id);
        } else if (item.unassignedAt === null) {
          this.store.updateWorkItem(item.id, { unassignedAt: this.now });
        }
      } else if (active === null || (active.kind === 'task' && active.outcome === 'done' && item.status === 'blocked') || awaitsRecheck(item, active)) {
        this.done(item, 'unassigned', null);
      } else if (item.unassignedAt === null) {
        this.store.updateWorkItem(item.id, { unassignedAt: this.now });
      }
    }
  }

  /** Deletes a work item whose ticket left during its triage, when it never had a session (PRD R10). */
  private deletedAfterTriage(item: WorkItem): boolean {
    if (item.unassignedAt === null || this.store.sessionsFor(item.id).length > 0) {
      return false;
    }

    this.store.deleteWorkItem(item.id);
    return true;
  }

  private worktreeFound(source: string, sourceKey: string, path: string, branch: string): void {
    const ticket = this.store.findTicket(source, sourceKey);

    if (ticket !== null && this.store.worktreeFor(ticket.id) === null) {
      this.store.linkWorktree({ ticketId: ticket.id, path, branch, linkedBy: 'convention' });
    }
  }

  private adhoc(prompt: string, repoRoot: string, start: boolean, provider?: Provider, model?: string | null): void {
    this.checkProvider(provider);
    checkModel(model);
    const title = firstLine(prompt);

    if (title === '') {
      throw new Refusal('The prompt is empty.');
    }

    if (repoRoot === '') {
      throw new Refusal('Choose a repo for the prompt.');
    }

    const item = this.insertAdhoc(prompt, title, repoRoot, null, start ? 'queued' : 'unstarted', provider);
    if (model != null) this.store.updateWorkItem(item.id, { model: model.trim() });
  }

  /**
   * Starts an independent conversation in its own work item (PRD R122): empty, or with `prompt` as its first message, which titles it until the
   * provider names it.
   */
  private newSession(repoRoot: string, provider?: Provider, model?: string | null, prompt?: string): void {
    this.checkInteractiveProvider(provider);
    if (repoRoot === '') throw new Refusal('Choose a folder for the session.');
    checkModel(model);
    const message = prompt?.trim() ?? '';
    const title = message === '' ? NEW_CONVERSATION_TITLE : summarizeMessage(message) || NEW_CONVERSATION_TITLE;
    const item = this.insertAdhoc(message === '' ? null : message, title, repoRoot, null, 'running', provider, true);
    this.store.updateWorkItem(item.id, { ...(model != null ? { model: model.trim() } : {}), ...(title === NEW_CONVERSATION_TITLE ? {} : { titleOrigin: 'generated' as const }) });
    this.startSession(this.store.workItem(item.id)!);
  }

  /**
   * New conversation… on the web page (architecture.md § Web page): another session of the work item, started at once with the operator's first
   * message as its prompt, in the folder its sessions run in; its earlier sessions stay, read-only on the page. Only a work item whose work has
   * started and stopped for the operator takes one, and never while a session of its ticket is in a turn (PRD R17).
   */
  private itemSession(item: WorkItem, prompt: string, provider?: Provider): void {
    const message = prompt.trim();

    if (message === '') throw new Refusal('Write the first message of the new conversation.');
    if (item.status !== 'running' && item.status !== 'blocked' && item.status !== 'finished' && item.status !== 'failed') {
      throw new Refusal('A new conversation starts only in a work item whose work has started and is not done.');
    }

    const sessions = this.store.workItemsForTicket(item.ticketId).flatMap((one) => this.store.sessionsFor(one.id));

    if (sessions.some((one) => one.state !== 'ended' && !TURN_ENDED.includes(one.state))) {
      throw new Refusal('A session of this work item is in a turn. Wait for it to end, or stop it, before starting a new conversation.');
    }

    const chosen = provider ?? this.store.sessionsFor(item.id).at(-1)?.provider ?? itemProvider(this.context.settings, this.context.playbooks, item);

    this.checkInteractiveProvider(chosen);
    this.startSession(item, { prompt: message, provider: chosen });
  }

  private checkInteractiveProvider(provider?: Provider): void {
    this.checkProvider(provider);
    const sessions = this.context.settings.sessions;
    const chosen = provider ?? sessions.provider;
    if (chosen !== 'codex' && !sessions.installHooks) throw new Refusal(NEEDS_HOOKS);
  }

  private checkProvider(provider: Provider | undefined): void {
    if (provider !== undefined && provider !== 'claude' && provider !== 'codex') throw new Refusal('Choose Claude or Codex.');
  }

  /** Keeps an interactive work item's label current with the provider, preferring a manually chosen provider name. */
  private conversationTitle(workItemId: number, text: string, origin?: 'provider-manual' | 'provider-auto'): void {
    const item = this.store.workItem(workItemId);
    const ticket = item === null ? null : this.store.ticket(item.ticketId);
    if (item === null || ticket?.source !== 'adhoc' || !this.interactive(item)) return;
    const title = origin === undefined ? summarizeMessage(text) : text.trim();
    if (title === '' || (title === item.lastProviderName && origin === item.titleOrigin) || (origin !== undefined && title === sessionName('task', item, ticket)) || (origin === undefined && ticket.title !== NEW_CONVERSATION_TITLE)) return;
    if (origin === 'provider-auto' && item.titleOrigin === 'provider-manual') return;
    if (origin === undefined && item.titleOrigin?.startsWith('provider')) return;
    this.store.updateTicket(ticket.id, { title });
    this.store.updateWorkItem(item.id, { titleOrigin: origin ?? 'generated', ...(origin === undefined ? {} : { lastProviderName: title }) });
  }

  /**
   * PRD R81: a live Claude session the operator started outside Switchboard becomes a running ad-hoc work item in its own directory. The session
   * counts as released, because its process is the operator's, and stays external until it ends.
   */
  private register(event: Extract<FlowEvent, { type: 'register' }>): void {
    const title = event.title.trim();

    if (title === '') {
      throw new Refusal('The title is empty.');
    }

    const known = this.store.sessionByNativeId(event.nativeSessionId) ?? this.store.startedSessions().find((session) => session.retiredIds.includes(event.nativeSessionId)) ?? null;

    if (known !== null) {
      const ticket = this.store.ticket(this.store.workItem(known.workItemId)!.ticketId)!;

      throw new Refusal(`This session is already in Switchboard as ${ticket.source} ${ticket.sourceKey}.`);
    }

    const item = this.insertAdhoc(null, title, event.cwd, null, 'running');

    this.store.insertSession({
      id: this.context.newSessionId(),
      workItemId: item.id,
      kind: 'task',
      provider: 'claude',
      nativeSessionId: event.nativeSessionId,
      shortId: event.shortId,
      cwd: event.cwd,
      state: 'running',
      stateAt: this.now,
      stateDetail: null,
      outcome: null,
      outcomeDetail: null,
      startedAt: this.now,
      endedAt: null,
      released: true,
      releasing: false,
      question: null,
      reports: sessionReports('task', false, null, 'claude'),
      retiredIds: [],
      pendingFork: null,
      external: true,
      move: null,
      movedAt: null,
      codeMode: false,
      launchId: null,
      registered: true,
    });
  }

  /**
   * PRD R83: the ad-hoc ticket of the session's work item becomes the source's ticket in place, so its work item, sessions, worktree, links and
   * History stay with it. It is stored out of the assigned state, so the poll that first lists it in scope finds the open work item and creates
   * none (PRD R7). A ticket a poll stored with nothing on it gives way. A registered session takes the playbook's reports at once, because its
   * contract is only in its conversation; a session Switchboard started keeps the contract in its system prompt, and its later sessions get the
   * playbook's.
   */
  private moveToTicket(event: Extract<FlowEvent, { type: 'ticket' }>): void {
    const session = this.session(event.sessionId);
    const item = this.store.workItem(session.workItemId)!;
    const ticket = this.store.ticket(item.ticketId)!;
    // A retry after a lost reply.
    if (ticket.source === event.source && ticket.sourceKey === event.sourceKey) {
      return;
    }

    if (ticket.source !== ADHOC_SOURCE) {
      throw new Refusal('Only an ad-hoc or registered work item can move to a ticket.');
    }

    if (item.status === 'done') {
      throw new Refusal('The work item is done.');
    }

    if (this.store.sessionsFor(item.id).at(-1)?.id !== session.id) {
      throw new Refusal("Only the work item's latest session can move it to a ticket.");
    }

    const playbook = event.playbook === null ? null : this.ticketPlaybook(event.source, event.playbook);
    const existing = this.store.findTicket(event.source, event.sourceKey);

    if (existing !== null) {
      const bare = existing.handledAssignmentKey == null && this.store.workItemsForTicket(existing.id).length === 0 && this.store.worktreeFor(existing.id) === null && this.store.linksFor(existing.id).length === 0 && this.store.poolTriages(existing.id).length === 0;

      if (!bare) {
        throw new Refusal(`Switchboard already has ${event.source} ${event.sourceKey}.`);
      }

      this.store.deleteBareTicket(existing.id);
    }

    this.store.updateTicket(ticket.id, { source: event.source, sourceKey: event.sourceKey, ref: event.ref, repo: event.repo, sourceId: null, title: event.title, url: event.url, assigned: false, pool: false, adhocKey: ticket.sourceKey });
    this.store.noteEvent({ adhocKey: ticket.sourceKey });

    if (playbook !== null) {
      this.store.updateWorkItem(item.id, { playbook: playbook.name });

      if (session.external) {
        this.store.updateSession(session.id, { reports: sessionReports('task', false, playbook, session.provider) });
      }
    }
  }

  /** A ticket report's playbook: a task playbook in the source's namespace, when the source has one (PRD R83). */
  private ticketPlaybook(source: string, name: string): Playbook {
    const namespace = this.context.settings.sources[source]?.namespace ?? '';
    const playbook = this.context.playbooks.get(name);

    if (playbook === undefined || playbook.kind !== 'task' || (namespace !== '' && name.split(':')[0] !== namespace)) {
      throw new Refusal(namespace === '' ? `${name} is not a task playbook.` : `${name} is not a task playbook in the ${namespace} namespace.`);
    }

    return playbook;
  }

  /**
   * PRD R68: a session's follow-up becomes an unstarted ad-hoc work item, in the named repo or else the reporting ticket's, which must be
   * a configured repo root. A repeated report adds nothing while the earlier work item is open.
   */
  private task(session: Session, report: Extract<Report, { kind: 'task' }>): void {
    const line = firstLine(report.prompt);

    if (line === '') {
      throw new Refusal('The prompt is empty.');
    }

    const parent = this.store.workItem(session.workItemId)!;
    const ticket = this.store.ticket(parent.ticketId)!;
    const own = ticketRoot(this.context.settings, ticket, this.store.reposBySource());
    const wanted = report.repo ?? ('root' in own ? own.root : '');
    const roots = repoRoots(this.context.settings, this.store.reposBySource());
    const repoRoot = roots.find((root) => samePath(root, wanted));

    if (repoRoot === undefined) {
      throw new Refusal(`${wanted === '' ? 'Name a repo with --repo.' : `${wanted} is not a configured repo root.`} Repo roots: ${roots.join(', ') || 'none'}.`);
    }

    if (this.store.workItemsWithParent(parent.id).some((item) => item.status !== 'done' && item.reportedPrompt === report.prompt)) {
      return;
    }

    this.insertAdhoc(report.prompt, report.title?.trim() || line, repoRoot, parent.id, 'unstarted');
  }

  /**
   * An ad-hoc ticket and work item: queued when the operator chose Start automatically, otherwise unstarted, and running, with no
   * prompt, for a registered session (PRD R6, R68, R81).
   */
  private insertAdhoc(prompt: string | null, title: string, repoRoot: string, parentId: number | null, status: 'queued' | 'unstarted' | 'running', provider?: Provider, interactive = false): WorkItem {
    const keys = this.store.adhocKeys().map(Number);
    const sourceKey = String(Math.max(0, ...keys) + 1);
    // A follow-up keeps its origin when Delete clears its parentId (PRD R27, R120).
    const ticket = this.store.insertTicket({ source: ADHOC_SOURCE, sourceKey, ref: `#${sourceKey}`, sourceId: parentId === null ? null : 'task', title, url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: this.now, lastPolledAt: null, repoRoot });
    const queued = status === 'queued';

    if (parentId !== null) {
      this.store.noteEvent({ childTicketId: ticket.id, childRef: ticket.ref, childTitle: title });
    }

    return this.store.insertWorkItem({
      ticketId: ticket.id,
      interactive,
      model: null,
      playbook: null,
      ...(provider === undefined ? {} : { provider }),
      status,
      stage: null,
      stageAt: null,
      taskPrompt: prompt,
      guidance: null,
      reportedPrompt: parentId === null ? null : prompt,
      warning: null,
      error: null,
      unassignedAt: null,
      queuedAt: queued ? this.now : null,
      approvalPrompt: null,
      approvalSummary: null,
      approvalReport: null,
      approvalHeld: false,
      createdAt: this.now,
      statusAt: this.now,
      readyAt: null,
      orderAt: null,
      runStartedAt: status === 'unstarted' ? null : this.now,
      scopeAt: null,
      doneAt: null,
      doneReason: null,
      parentId,
    });
  }

  // Schedules

  /**
   * PRD R82: keeps a ticket for each schedule, and gives each schedule that came due since the last tick a work item, unless it has an open one.
   * The ticket's `lastPolledAt` is when its schedule was last checked, so a time that passed while the hub was stopped runs once at the next tick,
   * and its `sourceId` is the schedule's `scheduleText`, so a schedule added again or moved starts from now instead of catching up.
   */
  runSchedules(): void {
    const configured = this.context.settings.schedules;

    for (const ticket of this.store.tickets(SCHEDULE_SOURCE)) {
      if (configured[ticket.sourceKey] === undefined && ticket.sourceId !== null) {
        this.store.beginEvent({ at: this.now, type: 'schedule', actor: 'hub', ticketId: ticket.id, workItemId: null, sessionId: null, detail: { name: ticket.sourceKey } });
        this.store.updateTicket(ticket.id, { sourceId: null });
      }
    }

    for (const [name, schedule] of Object.entries(configured)) {
      this.store.beginEvent({ at: this.now, type: 'schedule', actor: 'hub', ticketId: this.store.findTicket(SCHEDULE_SOURCE, name)?.id ?? null, workItemId: null, sessionId: null, detail: { name } });

      const ticket = this.scheduleTicket(name, schedule);
      const due = latestDue(schedule, this.now);
      const when = scheduleText(schedule);
      const checked = ticket.sourceId === when ? ticket.lastPolledAt : null;

      if (ticket.sourceId !== when) {
        this.store.updateTicket(ticket.id, { sourceId: when });
      }

      this.store.updateTicket(ticket.id, { lastPolledAt: this.now });

      if (due === null || checked === null || due <= checked) {
        continue;
      }

      const skipped = this.hasOpenWorkItem(ticket.id);

      this.store.beginEvent({ at: this.now, type: 'schedule', actor: 'hub', ticketId: ticket.id, workItemId: null, sessionId: null, detail: { name, dueAt: due, skipped } }, true);

      if (!skipped) {
        this.insertRun(ticket, schedule, false);
      }
    }
  }

  private runSchedule(name: string): void {
    const schedule = this.context.settings.schedules[name];

    if (schedule === undefined) {
      throw new Refusal(`settings.json has no schedule named ${name}.`);
    }

    const ticket = this.scheduleTicket(name, schedule);

    if (this.hasOpenWorkItem(ticket.id)) {
      throw new Refusal(`${name} already has an open work item.`);
    }

    this.insertRun(ticket, schedule, true);
  }

  /** The schedule's ticket, titled by its playbook's description, made when first seen. */
  private scheduleTicket(name: string, schedule: ScheduleSettings): Ticket {
    const title = this.context.playbooks.get(schedule.playbook)?.description || name;
    const known = this.store.findTicket(SCHEDULE_SOURCE, name);

    if (known === null) {
      return this.store.insertTicket({ source: SCHEDULE_SOURCE, sourceKey: name, ref: name, sourceId: scheduleText(schedule), title, url: '', assigned: true, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: this.now, lastPolledAt: this.now, repoRoot: schedule.repoRoot });
    }

    if (known.title !== title || known.repoRoot !== schedule.repoRoot) {
      this.store.updateTicket(known.id, { title, repoRoot: schedule.repoRoot });
    }

    return { ...known, title, repoRoot: schedule.repoRoot };
  }

  /** A run of a schedule: queued when its playbook starts automatically or the operator asked for it, else unstarted, and failed without a task playbook. */
  private insertRun(ticket: Ticket, schedule: ScheduleSettings, start: boolean): void {
    const playbook = this.context.playbooks.get(schedule.playbook);
    const error = playbook === undefined ? `Playbook ${schedule.playbook} is not loaded.` : playbook.kind !== 'task' ? `${schedule.playbook} is not a task playbook.` : null;
    const status: WorkItemStatus = error !== null ? 'failed' : start || playbook!.autoStart ? 'queued' : 'unstarted';

    // The in-queue time counts from the run's start, not the schedule's first one (PRD R27).
    this.store.updateTicket(ticket.id, { scopeAt: this.now });
    this.store.insertWorkItem({
      ticketId: ticket.id,
      playbook: schedule.playbook,
      status,
      stage: null,
      stageAt: null,
      taskPrompt: null,
      guidance: null,
      reportedPrompt: null,
      warning: null,
      error,
      unassignedAt: null,
      queuedAt: status === 'queued' ? this.now : null,
      approvalPrompt: null,
      approvalSummary: null,
      approvalReport: null,
      approvalHeld: false,
      createdAt: this.now,
      statusAt: this.now,
      readyAt: null,
      orderAt: null,
      runStartedAt: status === 'queued' ? this.now : null,
      scopeAt: null,
      doneAt: null,
      doneReason: null,
      parentId: null,
    });
  }

  // Triage

  private triageSucceeded(event: Extract<FlowEvent, { type: 'triage-succeeded' }>): void {
    const triage = this.store.triage(event.triageId);

    if (triage === null || triage.endedAt !== null || this.leftPoolTriage(triage)) {
      return;
    }

    const playbook = this.context.playbooks.get(event.playbook);

    if (playbook === undefined || playbook.kind !== 'task') {
      this.triageFailed(event.triageId, `Triage chose an unknown playbook: ${event.playbook}.`, event.context);
      return;
    }

    this.store.updateTriage(triage.id, {
      endedAt: this.now,
      context: event.context,
      playbook: event.playbook,
      immediacy: event.immediacy,
      severity: event.severity,
      focus: focusUrl(event.anchors ?? [], event.focus ?? null, playbook.focus),
      model: event.model,
    });

    for (const link of event.links ?? []) {
      this.store.addLink({ ticketId: triage.ticketId, label: link.label, target: link.target, reportedAt: this.now, mentioned: link.mentioned === true });
    }

    const item = triage.workItemId === null ? null : this.store.workItem(triage.workItemId)!;

    if (item?.status !== 'triaging' || this.deletedAfterTriage(item)) {
      return;
    }

    this.store.updateWorkItem(item.id, { playbook: playbook.name, taskPrompt: null, error: null });

    const outside = this.outsideHome(this.store.ticket(item.ticketId)!);

    if (playbook.autoStart && !event.stale && outside === null) {
      this.queue(item);
    } else {
      // The row says why the work item waits; Start clears it (PRD R80, R44).
      this.setStatus(item.id, { status: 'unstarted', error: event.stale ? MESSAGES.nothingNew : outside });
    }
  }

  /**
   * Why a ticket outside its source's home repository waits for Start whatever its playbook's `autoStart`, or null: the source's playbooks and
   * skills are written for its home repository, and one that starts by itself must not run them elsewhere unseen (PRD R44).
   */
  private outsideHome(ticket: Ticket): string | null {
    const home = homeRepo(this.context.settings.sources[ticket.source]);

    return ticket.repo === '' || home === '' || ticket.repo === home ? null : `${ticket.repo} is outside the home repository ${home}, so it waits for Start.`;
  }

  private triageFailed(triageId: number, error: string, context: string | null): void {
    const triage = this.store.triage(triageId);

    if (triage === null || triage.endedAt !== null || this.leftPoolTriage(triage)) {
      return;
    }

    this.store.updateTriage(triage.id, { endedAt: this.now, error, context });

    const item = triage.workItemId === null ? null : this.store.workItem(triage.workItemId)!;

    if (item?.status === 'triaging' && !this.deletedAfterTriage(item)) {
      this.fail(item, error);
    }
  }

  private triageCancelled(triageId: number): void {
    const triage = this.store.triage(triageId);

    if (triage === null || triage.endedAt !== null) {
      return;
    }

    // A cancelled pool triage is removed, so the pool ticket is due again; a work item stays triaging.
    if (triage.workItemId === null) {
      this.store.deleteTriage(triage.id);
    } else {
      this.store.updateTriage(triage.id, { endedAt: this.now, error: 'Cancelled.' });
      this.deletedAfterTriage(this.store.workItem(triage.workItemId)!);
    }
  }

  /** Triages a work item, or a pool ticket when `item` is null. Choices are the task playbooks of the source's namespace. */
  private startTriage(ticket: Ticket, item: WorkItem | null): void {
    const source = this.context.settings.sources[ticket.source];
    const name = source?.triagePlaybook ?? '';
    const playbook = this.context.playbooks.get(name);
    const prefix = source?.namespace ? `${source.namespace}:` : '';
    // The failed triage row marks a work item failed at triage (PRD R34).
    const fail = (error: string) => {
      this.store.insertTriage({ ...EMPTY_TRIAGE, ticketId: ticket.id, workItemId: item?.id ?? null, startedAt: this.now, endedAt: this.now, error });

      if (item !== null) {
        this.fail(item, error);
      }
    };

    if (playbook === undefined || playbook.kind !== 'triage') {
      fail(name === '' ? `sources.${ticket.source}.triagePlaybook is not set.` : `Triage playbook ${name} is not loaded.`);
      return;
    }

    const choices = [...this.context.playbooks.values()]
      .filter((candidate) => candidate.kind === 'task' && candidate.name.startsWith(prefix))
      .map((candidate) => ({ name: candidate.name, description: candidate.description, focus: candidate.focus }));

    if (choices.length === 0) {
      fail(prefix === '' ? MESSAGES.noTaskPlaybooks : `No task playbooks in the ${source!.namespace} namespace.`);
      return;
    }

    const systemPrompt = triagePrompt(playbook.template, choices);

    if ('error' in systemPrompt) {
      fail(`Triage playbook ${name}: ${systemPrompt.error}`);
      return;
    }

    const triage = this.store.insertTriage({ ...EMPTY_TRIAGE, ticketId: ticket.id, workItemId: item?.id ?? null, startedAt: this.now, endedAt: null, error: null });

    this.actions.push({
      type: 'triage',
      triageId: triage.id,
      workItemId: item?.id ?? null,
      ticket,
      systemPrompt: systemPrompt.text,
      choices,
      rates: playbook.rates,
      model: this.context.settings.triage.model || null,
      timeoutSeconds: this.context.settings.triage.timeoutSeconds,
      handled: item === null ? null : this.handled(item),
    });
  }

  /**
   * The latest earlier work item of the ticket and when it took in the ticket's activity: the start of its first task session that the runner
   * started, or when the operator marked it done without one (PRD R80). A work item with neither, such as one unassigned during setup, did not act on it.
   * A handled-assignment registration counts as the reporting work item taking in the ticket's activity when it registered (PRD R85).
   */
  private handled(item: WorkItem): HandledWork | null {
    let latest: HandledWork | null = null;

    for (const other of this.store.workItemsForTicket(item.ticketId)) {
      const starts = this.store.sessionsFor(other.id).filter((session) => session.kind === 'task' && session.shortId !== null).map((session) => session.startedAt);
      const at = starts.length > 0 ? Math.min(...starts) : other.doneReason === 'operator' ? other.doneAt : null;

      if (other.id !== item.id && at !== null && (latest === null || at > latest.at)) {
        latest = { at, playbook: other.playbook };
      }
    }

    for (const registration of this.store.handledRegistrations(item.ticketId)) {
      if (latest === null || registration.at > latest.at) {
        // Registrations logged before the event kept the playbook take it from the reporter while it exists.
        const playbook = registration.playbook ?? (registration.workItemId === null ? null : (this.store.workItem(registration.workItemId)?.playbook ?? null));
        latest = { at: registration.at, playbook };
      }
    }

    return latest;
  }

  // Sessions

  private session(sessionId: string): Session {
    const session = this.store.session(sessionId);

    if (session === null) {
      throw new Refusal(`Unknown session ${sessionId}.`);
    }

    return session;
  }

  private registerHandled(event: Extract<FlowEvent, { type: 'handled' }>): void {
    const session = this.session(event.sessionId);
    const origin = this.store.workItem(session.workItemId)!;
    if (origin.status === 'done' || this.store.sessionsFor(origin.id).at(-1)?.id !== session.id) throw new Refusal('Only the current session of an open work item can report a handled assignment.');
    let ticket = this.store.findTicket(event.source, event.sourceKey);
    if (ticket?.id === origin.ticketId) throw new Refusal('The session already works on this ticket.');
    if (event.release) {
      if (ticket === null) throw new Refusal('No handled assignment was registered for this ticket.');
      if (ticket.handledAssignmentKey == null && this.store.assignmentEnded(ticket.id, event.key)) return;
      if (ticket.handledAssignmentKey !== event.key) throw new Refusal('The handled assignment changed; the release was not applied.');
      this.store.updateTicket(ticket.id, { handledAssignmentKey: null, assigned: event.assigned });
      this.store.noteEvent({ assignmentReason: 'released' });
      if (event.assigned) this.createWorkItem(ticket.id);
      return;
    }
    if (ticket?.handledAssignmentKey === event.key) return;
    const registered = ticket === null ? null : this.store.registeredAssignment(ticket.id, session.id);
    if (registered !== null && registered !== event.key) throw new Refusal('This session registered an earlier assignment; it cannot register the returned work.');
    if (ticket !== null && (ticket.handledAssignmentKey != null || this.store.assignmentEnded(ticket.id, event.key))) throw new Refusal('This assignment was already released or another assignment is registered.');
    const items = ticket === null ? [] : this.store.workItemsForTicket(ticket.id).filter((item) => item.status !== 'done');
    if (items.some((item) => this.store.sessionsFor(item.id).length > 0)) throw new Refusal('This ticket already has started work; resolve it before registering the assignment.');
    ticket ??= this.store.insertTicket({ source: event.source, sourceKey: event.sourceKey, ref: event.ref, repo: event.repo, title: event.title, url: event.url, sourceId: null, assigned: false, pool: false, snoozed: false, snoozedUntil: null, sortAt: null, scopeAt: null, lastPolledAt: null, repoRoot: '' });
    for (const item of items) this.store.deleteWorkItem(item.id);
    this.store.updateTicket(ticket.id, { handledAssignmentKey: event.key });
    this.store.noteEvent({ reportedByWorkItemId: origin.id, reportedByPlaybook: origin.playbook });
  }

  private sessionStarted(sessionId: string, nativeSessionId: string | null, shortId: string, startPrompt: boolean, launchId: string | undefined): void {
    const session = this.session(sessionId);

    if (session.state === 'starting') {
      // A session started with no prompt waits for the operator's first message (mechanics M87).
      const state = startPrompt ? { state: 'waiting' as const, stateDetail: START_PROMPT } : { state: session.promptless === true ? ('idle' as const) : ('running' as const), stateDetail: null };

      this.store.updateSession(sessionId, { nativeSessionId, shortId, ...state, stateAt: this.now, ...(launchId === undefined ? {} : { launchId }) });
      const item = this.store.workItem(session.workItemId)!;
      if (session.stateDetail !== null && item.warning === session.stateDetail) this.store.updateWorkItem(item.id, { warning: null });
      if ((session.execution === 'app-server' && item.error !== null) || (session.stateDetail !== null && item.error === `Stop failed: ${session.stateDetail}`)) this.store.updateWorkItem(item.id, { error: null });

      // The started task session's prompt holds the guidance (PRD R77).
      if (session.kind === 'task' && item.guidance !== null) {
        this.store.updateWorkItem(item.id, { guidance: null });
      }
    }
  }

  /** PRD R41: Claude's own message says how to trust an untrusted directory. */
  private sessionStartFailed(sessionId: string, message: string): void {
    const session = this.session(sessionId);

    // A Code Mode start that failed has no session to resume, so its preallocated IDs go (PRD R93); Retry starts a new session.
    const unused = session.codeMode === true ? { nativeSessionId: null, launchId: null } : {};

    this.store.updateSession(sessionId, { state: 'ended', stateDetail: null, stateAt: this.now, endedAt: this.now, outcome: 'failed', outcomeDetail: message, released: true, ...unused });

    const item = this.latest(session);

    if (item === null) {
      return;
    }

    if (item.unassignedAt !== null) {
      this.done(item, 'unassigned', null);
      return;
    }

    if (session.stateDetail !== null && item.warning === session.stateDetail) this.store.updateWorkItem(item.id, { warning: null });
    this.fail(item, message);
  }

  /** Liveness comes from the roster alone (GC M20): a listed session is alive, an unlisted one has ended. */
  private roster(observed: ObservedSession[], checked: string[] | undefined, forks: ObservedFork[]): void {
    const listed = new Map(observed.map((entry) => [entry.sessionId, entry]));

    for (const entry of observed) {
      const session = entry.tree === undefined || entry.tree.length === 0 ? null : this.store.session(entry.sessionId);

      if (session?.codeMode === true && JSON.stringify(session.lastTree ?? null) !== JSON.stringify(entry.tree)) {
        this.store.updateSession(session.id, { lastTree: entry.tree! });
      }
    }

    for (const fork of forks) {
      // A Code Mode session's new ID is the same held process (PRD R93), never the operator's interactive one.
      const held = this.store.session(fork.sessionId)?.codeMode === true;
      const adopted = this.adoptFork(fork);

      if (adopted) {
        listed.set(fork.sessionId, { sessionId: fork.sessionId, state: fork.state, detail: fork.detail, interactive: !held });
      }
    }

    for (const entry of listed.values()) {
      let session = this.store.session(entry.sessionId);
      if (session?.execution === 'app-server' && session.state === 'ended' && (entry.state === 'running' || entry.state === 'waiting')) {
        this.store.updateSession(session.id, { released: false, releasing: false, endedAt: null, launchId: this.context.newUuid() });
        session = this.store.session(session.id);
      }

      if (session !== null && session.state !== 'starting') {
        // An interactive session is the operator's, such as a registered one; Switchboard never stops it (PRD R39).
        if (entry.interactive === true && (!session.released || session.releasing || session.question !== null)) {
          this.store.updateSession(session.id, { released: true, releasing: false, question: null });
        }

        this.setState({ ...session, released: session.released || entry.interactive === true, releasing: session.releasing && entry.interactive !== true }, entry.state, entry.detail, entry.limit ?? null);
      }
    }

    const looked = checked === undefined ? null : new Set(checked);

    for (const session of this.store.activeSessions()) {
      if (session.state !== 'starting' && !listed.has(session.id) && (looked === null || looked.has(session.id))) {
        // Its process is gone, so a later resume is never released (PRD R39).
        this.store.updateSession(session.id, { state: 'ended', stateAt: this.now, stateDetail: null, endedAt: this.now, released: true, releasing: false, question: null, external: false });
        this.ended({ ...session, state: 'ended' });
      }
    }
  }

  /**
   * A fork replaces the work item's latest session, whose current copy is retired (PRD R78): a held session's ID change in its terminal, or a fork of
   * a registered session in the operator's own window.
   */
  private adoptFork(fork: ObservedFork): boolean {
    const session = this.store.session(fork.sessionId);

    // A held process can resume an ID it left, such as `/resume` back to the ID before a `/clear` (mechanics M73).
    if (session === null || session.state === 'starting' || session.nativeSessionId === null || session.nativeSessionId === fork.nativeSessionId || (session.codeMode !== true && session.retiredIds.includes(fork.nativeSessionId))) {
      return false;
    }

    // A Code Mode session's ID change, by /clear, /branch or /resume in its terminal, is its own held process, so it is followed at once (PRD R93).
    if (session.codeMode !== true && this.store.sessionsFor(session.workItemId).at(-1)?.id !== session.id) {
      return false;
    }

    this.store.updateSession(session.id, { nativeSessionId: fork.nativeSessionId, shortId: fork.shortId, retiredIds: [...session.retiredIds.filter((id) => id !== fork.nativeSessionId), session.nativeSessionId], pendingFork: null });

    return true;
  }

  /**
   * A hook marker sets the state of a live session only, because a killed process leaves its marker behind. A session waiting on a prompt before
   * it starts leaves that state only when the roster lists its process (PRD R41).
   */
  private marker(sessionId: string, state: LiveState, detail: string | null, limit: LimitReading | null): void {
    const session = this.session(sessionId);

    if (session.state !== 'starting' && session.state !== 'ended' && !waitsToStart(session)) {
      this.setState(session, state, detail, limit);
    }
  }

  private setState(session: Session, state: LiveState, detail: string | null, limit: LimitReading | null = null): void {
    // A turn that ends asking lettered questions no message has answered waits on the operator's answer, not finished or blocked (PRD R103).
    if (state === 'idle' && detail === null && this.asksInCard(session)) {
      detail = QUESTION_CARD;
    }

    if (session.state === state && session.stateDetail === detail) {
      return;
    }

    const reopened = session.outcome === 'opened' ? { outcome: null, outcomeDetail: null } : {};
    // A turn that ends at a limit keeps it until a turn ends without one; a new turn keeps it, so a limit hit again counts the attempts.
    const reading = TURN_ENDED.includes(state) ? (limit ?? (state === 'failed' && detail === 'rate_limit' ? UNREAD_LIMIT : null)) : undefined;
    const limited = reading === undefined ? {} : { rateLimit: reading === null ? null : limitFor(reading, session.rateLimit, session.launchId ?? null, this.now) };

    this.store.updateSession(session.id, { state, stateAt: this.now, stateDetail: detail, endedAt: null, ...reopened, ...limited });

    const current = { ...session, state, stateDetail: detail, ...reopened, ...limited };
    const atLimit = waitsOnLimit(current);
    // A new turn after the last one ended, as one the operator typed in the session's terminal.
    const resumed = (state === 'running' || state === 'waiting') && (session.state === 'ended' || TURN_ENDED.includes(session.state));

    // A registered session in the operator's window is theirs, so only a held session or an app-server thread ends here (PRD R39, R95).
    if (TURN_ENDED.includes(state)) {
      if (persistent(current) && !atLimit) {
        this.endHeld(current);
      }
    } else if (current.codeMode === true && current.releasing && !current.released) {
      // A new turn, such as one typed in an attached terminal, cancels an end that waited for the terminal to detach; its turn end decides again (PRD R95).
      this.store.updateSession(session.id, { releasing: false });
      current.releasing = false;
    }

    const item = this.latest(current);

    if (item !== null && current.kind === 'setup') {
      // A held setup session stopped at a limit continues after the reset, so its turn end decides nothing (architecture.md § Rate limits).
      if (!(atLimit && persistent(current))) {
        this.setupState(item, current, state, resumed);
      }

      return;
    }

    if (item === null || current.kind !== 'task') {
      return;
    }

    // Resumed before the recheck of its done report, so that report no longer ends the work item.
    if (resumed && awaitsRecheck(item, current)) {
      this.store.updateSession(session.id, { outcome: null, outcomeDetail: null });
    }

    if (TURN_ENDED.includes(state) && current.outcome === null && item.status === 'running' && atLimit) {
      // A held session continues after the reset; a registered one in the operator's window is theirs to continue (architecture.md § Rate limits).
      if (!persistent(current)) {
        if (item.approvalHeld) {
          this.restoreApproval(item, MESSAGES.turnAtLimit);
        } else {
          this.block(item, MESSAGES.turnAtLimit);
        }
      }
    } else if (TURN_ENDED.includes(state) && current.outcome === null && item.status === 'running') {
      const cause = state === 'failed' ? `The turn failed: ${detail ?? 'unknown error'}.` : null;

      // A hosted conversation offers no done report, so a turn that ends leaves it open (architecture.md § Hosted conversations).
      // A turn that asked in a question card leaves the work item running, waiting on the answer (PRD R103).
      if (cause === null && (this.interactive(item) || detail === QUESTION_CARD)) {
        return;
      }

      if (item.unassignedAt !== null) {
        this.done(item, 'unassigned', null);
      } else if (item.approvalHeld) {
        this.restoreApproval(item, cause);
      } else if (cause === null) {
        this.endRun(item, current, true);
      } else {
        this.block(item, cause);
      }
    } else if (resumed && (item.status === 'blocked' || item.status === 'finished')) {
      this.store.updateSession(session.id, { outcome: null, outcomeDetail: null });
      this.setStatus(item.id, { status: 'running', error: null });
    } else if (state === 'running' && detail === null && item.status === 'awaiting-approval') {
      // The operator gave the session more work after its approval report; the report waits until the run ends (PRD R34).
      // A turn that ends with background tasks stays `running` with a detail, so the next prompt or tool call still counts.
      this.store.updateSession(session.id, { outcome: null, outcomeDetail: null });
      this.setStatus(item.id, { status: 'running', approvalHeld: true, error: null });
    }
  }

  /** Settles a done report the first read could not confirm: blocked when the ticket is still assigned, else done (PRD R10). */
  private doneChecked(sessionId: string, token: string, assigned: boolean): void {
    const session = this.store.session(sessionId);
    const item = session === null ? null : this.latest(session);

    // A resume, an approval report or a later done report replaced the token, or the status changed.
    if (item === null || session!.outcomeDetail !== token || !awaitsRecheck(item, session!)) {
      return;
    }

    this.store.updateSession(sessionId, { outcomeDetail: null });

    if (assigned) {
      this.block(item, MESSAGES.doneStillAssigned);
    } else {
      this.done(item, 'session', null);
    }
  }

  /** The session's process is gone: decide setup, or settle a task that never reported. */
  private ended(session: Session): void {
    const item = this.latest(session);

    if (item === null) {
      return;
    }

    if (session.kind === 'setup') {
      if (item.status !== 'setup') {
        return;
      }

      // A usage limit is a wait, not a failure, so it blocks the work item until the operator retries after the reset (PRD R111).
      if (item.unassignedAt === null && this.store.worktreeFor(item.ticketId) === null && session.rateLimit != null) {
        this.block(item, MESSAGES.setupAtLimit);
      } else if (item.unassignedAt === null && this.store.worktreeFor(item.ticketId) === null) {
        this.fail(item, MESSAGES.setupWithoutWorktree);
      } else {
        this.finishSetup(item, session);
      }

      return;
    }

    // A done report with its ticket still assigned leaves the work item open until the recheck or the ticket leaving settles it.
    if (item.unassignedAt !== null) {
      this.done(item, 'unassigned', null);
    } else if (session.outcome === 'done' || this.interactive(item)) {
      return;
    } else if (item.status === 'running') {
      if (item.approvalHeld) {
        this.restoreApproval(item, null);
      } else {
        this.endRun(item, session, false);
      }
    }
  }

  /**
   * A held setup session's turn end decides setup. A resume after setup failed because the process was gone, as at a logout, or blocked, as at a
   * usage limit, retries it; a work item failed at a usage limit before such a stop blocked it is retried the same way.
   */
  private setupState(item: WorkItem, session: Session, state: LiveState, resumed: boolean): void {
    if (resumed && ((item.status === 'failed' && (item.error === MESSAGES.setupWithoutWorktree || item.error === MESSAGES.setupAtLimit)) || item.status === 'blocked')) {
      this.setStatus(item.id, { status: 'setup', error: null });
    } else if (TURN_ENDED.includes(state) && persistent(session) && item.status === 'setup' && (item.unassignedAt !== null || this.store.worktreeFor(item.ticketId) !== null)) {
      this.finishSetup(item, session);
    }
  }

  private finishSetup(item: WorkItem, session: Session): void {
    if (item.unassignedAt !== null) {
      this.done(item, 'unassigned', null);
      return;
    }

    this.store.updateSession(session.id, { outcome: 'done' });

    // A snoozed ticket's task waits in the queue until the ticket wakes or is restored (PRD R49), and a blocked one until its blockers close (PRD R90).
    const ticket = this.store.ticket(item.ticketId)!;

    if (ticket.snoozed || (ticket.blockers?.length ?? 0) > 0) {
      this.queue(item);
    } else {
      this.startSession(item);
    }
  }

  /**
   * Ends a held session, or releases an app-server thread's subscription, once (PRD R39, R95). The session is `released` only once its runner
   * confirms the end, so no observation takes a pending end for an ended session.
   */
  private release(session: Session): void {
    if (session.released || session.releasing) {
      return;
    }

    this.store.updateSession(session.id, { releasing: true });
    this.actions.push({ type: 'stop-session', sessionId: session.id, provider: session.provider, shortId: session.shortId, reason: 'release', ...codeModeOf(session) });
  }

  /**
   * A Codex app-server thread whose turn has ended releases its subscription when it is a setup session, its work item is done, or a newer session
   * of its work item has started (PRD R39). A held Code Mode session keeps running between turns; only Stop, Delete and the idle limit end it (PRD R95).
   */
  private endHeld(session: Session): void {
    const item = this.store.workItem(session.workItemId);

    if (item === null) {
      return;
    }

    // Nothing continues a limited session of a done work item or one a newer session replaced, so its wait ends (architecture.md § Rate limits).
    if (session.rateLimit != null && (item.status === 'done' || this.store.sessionsFor(item.id).at(-1)?.id !== session.id)) {
      this.store.updateSession(session.id, { rateLimit: null });
      session = { ...session, rateLimit: null };
    }

    if (session.codeMode === true || session.released || session.releasing || waitsOnLimit(session)) {
      return;
    }

    if (session.kind === 'setup' || item.status === 'done' || this.store.sessionsFor(item.id).at(-1)?.id !== session.id) {
      this.release(session);
    }
  }

  /** Applies the end rule to the work item's held Code Mode sessions whose turn has ended, as when it becomes done or a newer session starts. */
  private endHeldSessions(workItemId: number): void {
    for (const session of this.store.sessionsFor(workItemId)) {
      if (persistent(session) && TURN_ENDED.includes(session.state)) {
        this.endHeld(session);
      }
    }
  }

  /**
   * The holder that held a Code Mode session is gone (PRD R94). Interrupted work blocks its work item with the cause rather than taking the
   * roster's end path, whose `finished` rule would read it as a finished run; a session whose turn had ended leaves its work item as it was.
   */
  private holderLost(sessionId: string): void {
    const session = this.store.session(sessionId);

    if (session === null || session.codeMode !== true || session.state === 'ended') {
      return;
    }

    if (session.state === 'starting') {
      this.sessionStartFailed(sessionId, MESSAGES.holderStopped);
      return;
    }

    const turnEnded = TURN_ENDED.includes(session.state);
    const card = waitsOnCard(session);

    this.store.updateSession(sessionId, {
      state: 'ended',
      stateAt: this.now,
      stateDetail: null,
      endedAt: this.now,
      released: true,
      releasing: false,
      question: null,
      ...(turnEnded || session.outcome !== null ? {} : { outcome: 'failed' as const, outcomeDetail: MESSAGES.holderStopped }),
    });

    // A session that reported done ends as its process would, so a done report that waits for its second read still settles (PRD R10). So does
    // one that waited on a question card's answer, whose turn had ended with its work item still running (PRD R103).
    if (session.outcome === 'done' || card) {
      this.ended({ ...session, state: 'ended' });
      return;
    }

    const item = turnEnded ? null : this.latest(session);

    if (item === null) {
      return;
    }

    if (item.unassignedAt !== null) {
      this.done(item, 'unassigned', null);
    } else if (item.approvalHeld || item.status === 'awaiting-approval') {
      this.restoreApproval(item, MESSAGES.holderStopped);
    } else {
      this.block(item, MESSAGES.holderStopped);
    }
  }

  /**
   * The idle limit ends a held session after its turn, or in any state while hooks are off and it is unobserved (PRD R95), and releases an app-server
   * thread's subscription after its turn (PRD R107); neither while the session waits on its usage limit.
   */
  private heldIdle(sessionId: string): void {
    const session = this.store.session(sessionId);

    if (session === null || !persistent(session) || session.state === 'starting' || session.state === 'ended') {
      return;
    }

    // A session waiting on its limit keeps its process, which may be waiting for the reset itself, until the hub resumes it or gives up
    // (architecture.md § Rate limits).
    if (waitsOnLimit(session)) {
      return;
    }

    // An app-server thread's state comes from Codex, not hooks, so only a turn end counts.
    if (TURN_ENDED.includes(session.state) || (session.codeMode === true && !this.context.settings.sessions.installHooks)) {
      this.release(session);
    }
  }

  /** A limit read after the turn end's marker: kept like one the marker carried, and a run the turn end settled runs again (architecture.md § Rate limits). */
  private limitFound(sessionId: string, reading: LimitReading): void {
    const session = this.store.session(sessionId);

    if (session === null || !TURN_ENDED.includes(session.state)) {
      return;
    }

    const rateLimit = limitFor(reading, session.rateLimit, session.launchId ?? null, this.now);

    this.store.updateSession(sessionId, { rateLimit });

    const item = this.latest(session);

    if (session.rateLimit != null || item === null || !persistent(session) || item.statusAt < session.stateAt) {
      return;
    }

    if (session.kind === 'task' && (item.status === 'finished' || item.status === 'blocked')) {
      this.setStatus(item.id, { status: 'running', error: null });
    }
  }

  /** The hub typed the continue text, or could not: the next attempt waits by the backoff in case no turn starts (architecture.md § Rate limits). */
  private limitAttempt(sessionId: string, _error: string | null): void {
    const session = this.store.session(sessionId);
    const limit = session?.rateLimit;

    if (session == null || limit == null || !waitsOnLimit(session)) {
      return;
    }

    this.store.updateSession(sessionId, { rateLimit: { ...limit, attempts: limit.attempts + 1, attemptedAt: this.now, nextAt: this.now + backoff(limit.attempts) } });
  }

  /** The operator acted in the session's terminal during the wait, so the hub leaves the session to them (architecture.md § Rate limits). */
  private limitSkipped(sessionId: string): void {
    const session = this.store.session(sessionId);

    if (session !== null && waitsOnLimit(session)) {
      this.stopWaiting(session, MESSAGES.limitSkipped);
    }
  }

  /** Each tick gives up on a session whose attempts did not start a turn (architecture.md § Rate limits). */
  private limitsDue(): void {
    for (const session of this.store.activeSessions()) {
      if (waitsOnLimit(session) && givesUp(session.rateLimit!, this.now)) {
        this.stopWaiting(session, MESSAGES.limitGaveUp);
      }
    }
  }

  /** Ends a session's wait on its limit: its work item, when the session is its latest and still runs, waits on the operator with the cause. */
  private stopWaiting(session: Session, cause: string): void {
    this.store.updateSession(session.id, { rateLimit: null });

    const item = this.latest(session);

    if (item !== null && (item.status === 'running' || item.status === 'setup')) {
      this.block(item, cause);
    }
  }

  private heldResuming(sessionId: string, launchId: string, adopt?: { codeMode: boolean }): void {
    let session = this.store.session(sessionId);

    // A registered session becomes held as its resume starts; its later resumes keep the mode (PRD R81, mechanics M68).
    if (session !== null && adopt !== undefined && resumesHeld(session)) {
      this.store.updateSession(sessionId, { codeMode: true, withoutCodeMode: !adopt.codeMode });
      session = this.store.session(sessionId);
    }

    if (session?.codeMode === true && session.state === 'ended') {
      // The resume's prompt carries the tone section as the settings have it now.
      this.store.updateSession(sessionId, { launchId, personaVersion: toneVersion(sessionTone(this.context.settings.voice, session)) });
    }
  }

  /** The persona IDs of the live Code Mode sessions other than `except`, one per session, for the pool (architecture.md § Personas). */
  private livePersonas(except: string | null): Array<string | null | undefined> {
    return this.store
      .activeSessions()
      .filter((session) => persistent(session) && session.id !== except)
      .map((session) => session.personaId);
  }

  /**
   * Pins a persona to a Code Mode or Codex app-server session, or clears its pin, which gives it the persona a start would resolve now (architecture.md § Personas).
   * Its voice changes from the next spoken reply; its tone section waits for the next resume or compaction.
   */
  private pinPersona(sessionId: string, personaId: string | null): void {
    const session = this.session(sessionId);
    const voice = this.context.settings.voice;

    if (!persistent(session)) {
      throw new Refusal('Only a Code Mode or Codex app-server session has a persona.');
    }

    // Personas are part of voice, so a persona menu shown before voice was turned off pins nothing.
    if (!voice.enabled) {
      throw new Refusal('Voice is off (voice.enabled).');
    }

    if (personaId !== null) {
      if (personaById(voice, personaId) === null) {
        throw new Refusal(`No persona ${personaId} in voice.personas.`);
      }

      this.store.updateSession(sessionId, { personaId, personaPinned: true });
      return;
    }

    const item = this.store.workItem(session.workItemId);

    this.store.updateSession(sessionId, { personaId: resolvePersona(voice, item?.playbook ?? null, this.livePersonas(sessionId))?.id ?? null, personaPinned: false });
  }

  private personaDelivered(sessionId: string): void {
    const session = this.store.session(sessionId);

    if (session !== null && persistent(session)) {
      this.store.updateSession(sessionId, { personaVersion: toneVersion(sessionTone(this.context.settings.voice, session)) });
    }
  }

  /**
   * A resume through `POST /attach` (PRD R95), or of a Codex app-server thread (PRD R107), holds the ended session again under a new launch; its
   * outcome and its work item's status stand until a new turn.
   */
  private heldResumed(sessionId: string, launchId: string): void {
    const session = this.store.session(sessionId);

    if (session === null || !persistent(session) || session.state !== 'ended') {
      return;
    }

    this.store.updateSession(sessionId, { state: 'idle', stateAt: this.now, stateDetail: null, endedAt: null, released: false, releasing: false, launchId, lastTree: null });
  }

  private report(sessionId: string, report: Report): void {
    const session = this.session(sessionId);

    if (session.state === 'ended' && session.outcome === 'failed' && session.nativeSessionId === null && session.shortId === null) {
      throw new Refusal('The session failed to start; retry the work item before reporting.');
    }

    if (!session.reports.includes(report.kind)) {
      throw new Refusal(`This session's report contract does not offer the ${report.kind} report.`);
    }

    // A report after Open in Claude or Codex comes from the session the operator resumed, so its question no longer waits (PRD R70).
    if (session.outcome === 'opened') {
      this.store.updateSession(sessionId, { outcome: null, outcomeDetail: null });
    }

    const item = this.latest(session);

    switch (report.kind) {
      case 'stage':
        if (item !== null) {
          this.store.updateWorkItem(item.id, { stage: report.stage, stageAt: this.now });
        }
        return;
      case 'worktree': {
        const ticketId = this.store.workItem(session.workItemId)!.ticketId;
        this.store.linkWorktree({ ticketId, path: report.path, branch: report.branch, linkedBy: 'report' });
        return;
      }
      case 'done':
        this.store.updateSession(sessionId, { outcome: 'done', outcomeDetail: null });

        if (item !== null && session.kind === 'task') {
          // A read that still lists the ticket waits for the hub's recheck (`done-checked`), because issue search lags an unassignment.
          if (report.assigned === true) {
            this.store.updateSession(sessionId, { outcomeDetail: `${UNCONFIRMED_DONE}; it was still assigned at ${new Date(this.now).toISOString()}.` });
          } else {
            this.done(item, 'session', null);
          }
        }

        return;
      case 'approval':
        // The work is ready; Approve starts a new task session with the prompt that publishes it (PRD R23, R31).
        if (item !== null && session.kind === 'task') {
          // An approval after a done report the hub has not confirmed replaces it.
          if (awaitsRecheck(item, session)) {
            this.store.updateSession(sessionId, { outcomeDetail: null });
          }

          this.setStatus(item.id, { status: 'awaiting-approval', approvalPrompt: report.prompt, approvalSummary: report.summary, approvalReport: report.report, error: null });
        }

        return;
      case 'link':
        // Links belong to the ticket, so a returned ticket keeps them (PRD R52).
        this.store.addLink({ ticketId: this.store.workItem(session.workItemId)!.ticketId, label: report.label, target: report.target, reportedAt: this.now, mentioned: false });
        return;
      case 'playbook':
        if (item !== null && session.kind === 'task') {
          this.store.updateWorkItem(item.id, { playbook: this.handoffPlaybook(item, report.playbook) });
        }

        return;
      case 'paste':
        // Pastes belong to the work item whose draft they are; Copy shows on its approval row (PRD R60).
        if (item !== null) {
          this.store.setPaste({ workItemId: item.id, label: report.label, file: report.file, reportedAt: this.now });
        }

        return;
      case 'task':
        // Follow-up work is new work, so it is recorded whatever the state of the reporting work item.
        return this.task(session, report);
      case 'question':
        // A session the operator resumed elsewhere asks there; only its background run waits on a reported question.
        if (session.state !== 'ended' && (!session.released || session.releasing)) {
          this.store.updateSession(sessionId, { question: { id: this.context.newSessionId(), text: report.text } });
        }

        return;
    }
  }

  /** The playbook a session hands its work item to: a task playbook in the work item's namespace (PRD R23). */
  private handoffPlaybook(item: WorkItem, name: string): string {
    const namespace = item.playbook?.split(':')[0];
    const playbook = this.context.playbooks.get(name);

    if (playbook === undefined || playbook.kind !== 'task' || name.split(':')[0] !== namespace) {
      throw new Refusal(`${name} is not a task playbook in the ${namespace} namespace.`);
    }

    return name;
  }

  private stop(item: WorkItem, sessionId: string | null): void {
    const session = this.activeSession(item);

    // An older held session ends as Stop ends one; only the latest session's work item is blocked (stopSucceeded).
    if (sessionId !== null && sessionId !== session?.id) {
      const older = this.store.session(sessionId);

      if (older === null || older.workItemId !== item.id || older.codeMode !== true || older.state === 'ended') {
        throw new Refusal(`Session ${sessionId} is not a running held session of the work item.`);
      }

      this.actions.push({ type: 'stop-session', sessionId: older.id, provider: older.provider, shortId: older.shortId, reason: 'operator', codeMode: true });
      return;
    }

    if (session === null) {
      const last = this.store.sessionsFor(item.id).at(-1);

      // Processes an ended Code Mode session's last run left can block its resume, so Stop ends them (PRD R95).
      if (last?.codeMode === true && (last.lastTree?.length ?? 0) > 0) {
        this.actions.push({ type: 'stop-session', sessionId: last.id, provider: last.provider, shortId: last.shortId, reason: 'operator', codeMode: true, leftovers: true });
        return;
      }

      throw new Refusal('The work item has no active session.');
    }

    // A registered session runs in the operator's window, so Switchboard never stops it (PRD R81).
    if (session.external) {
      throw new Refusal('The session runs in your own window; stop it there.');
    }

    this.actions.push({ type: 'stop-session', sessionId: session.id, provider: session.provider, shortId: session.shortId, reason: 'operator', ...codeModeOf(session) });
  }

  /**
   * PRD R120: stops a session running in its background process, then deletes the work item. A starting session has no short ID to stop yet; a
   * session the operator resumed is theirs, so it keeps running, and its later reports are refused as from an unknown session.
   */
  private delete(item: WorkItem): void {
    const session = this.activeSession(item);

    // A starting Code Mode session is held under its Switchboard session ID, so the holder can end it (PRD R95).
    if (session?.state === 'starting' && session.codeMode !== true && !(session.execution === 'app-server' && session.nativeSessionId !== null)) {
      throw new Refusal('The session is starting. Delete the work item once it has started.');
    }

    // A session whose release stop has not finished may still run in its background process.
    if (session !== null && session.codeMode !== true && (!session.released || session.releasing)) {
      this.actions.push({ type: 'stop-session', sessionId: session.id, provider: session.provider, shortId: session.shortId, reason: 'operator', ...codeModeOf(session) });
    }

    // The holder keeps every Code Mode session of the work item running until it is ended, including older ones whose end waits on a terminal.
    for (const held of this.store.sessionsFor(item.id)) {
      if (held.codeMode === true && held.state !== 'ended') {
        this.actions.push({ type: 'stop-session', sessionId: held.id, provider: held.provider, shortId: held.shortId, reason: 'operator', codeMode: true });
      }
    }

    // Its follow-ups lose their parentId, so their tickets keep the origin, as tickets made before it was stored did not (PRD R27).
    for (const child of this.store.workItemsWithParent(item.id)) {
      this.store.updateTicket(child.ticketId, { sourceId: 'task' });
    }

    this.store.deleteWorkItem(item.id);

    // A snoozed ticket with no row left would stay hidden on GitHub boards (PRD R56) until it left scope.
    const ticket = this.store.ticket(item.ticketId)!;

    if (ticket.snoozed && !ticket.pool && this.store.workItemsForTicket(ticket.id).length === 0) {
      this.store.updateTicket(ticket.id, UNSNOOZED);
    }
  }

  private stopSucceeded(sessionId: string, reason: StopReason, shortId: string | null | undefined, leftovers = false): void {
    const session = this.session(sessionId);

    if (leftovers) {
      this.store.updateSession(sessionId, { lastTree: null });
      return;
    }

    if (session.state === 'ended' || retiredStop(session, shortId)) {
      return;
    }

    // A session that already reported done ends normally, so a finished setup still starts its task.
    const stopped = reason !== 'release' && session.outcome !== 'done';

    this.store.updateSession(sessionId, {
      state: 'ended',
      released: true,
      releasing: false,
      question: null,
      stateAt: this.now,
      endedAt: this.now,
      ...(stopped && session.outcome === null ? { outcome: 'stopped' as const, outcomeDetail: MESSAGES.stopped } : {}),
    });

    if (!stopped) {
      this.ended({ ...session, state: 'ended' });
      return;
    }

    const item = this.latest(session);

    if (item === null) {
      return;
    }

    if (item.unassignedAt !== null) {
      this.done(item, 'unassigned', null);
    } else if (item.approvalHeld || item.status === 'awaiting-approval') {
      // A stop is not a decision on the approval, so Approve stays offered (PRD R40).
      this.restoreApproval(item, MESSAGES.stopped);
    } else {
      this.block(item, MESSAGES.stopped);
    }
  }

  /** The session stays as it was, so the operator can stop it again. */
  private stopFailed(sessionId: string, reason: StopReason, message: string, shortId: string | null | undefined, leftovers: boolean): void {
    const session = this.session(sessionId);

    // A late failure of a second end of a held session that has ended says nothing about it.
    if (session.codeMode === true && session.state === 'ended' && !leftovers) {
      return;
    }
    const item = retiredStop(session, shortId) ? null : this.latest(session);

    if (item !== null) {
      this.store.updateWorkItem(item.id, { error: `${reason === 'release' ? 'Release' : 'Stop'} failed: ${message}` });
    }

    // A held session whose end failed is still held, so a later turn end or the idle limit can end it.
    if (persistent(session) && reason === 'release') {
      this.store.updateSession(sessionId, { releasing: false });
    }
  }

  /**
   * The hub started (PRD R93, R107): a Claude session that ran in Claude's background service under an earlier hub, or a Codex session it ran as
   * `codex exec`, is ended, since nothing observes or releases it now. Its work item waits on the operator with why, as when the holder stops;
   * opening a Claude one resumes it in the terminal holder. A registered session in the operator's own window is still followed through Claude's
   * roster (PRD R81).
   */
  private endLegacy(): void {
    for (const session of this.store.activeSessions()) {
      // A registered session is the operator's, followed through Claude's roster, also once resumed in their window after it ended (PRD R81).
      if (persistent(session) || session.external || session.registered === true) {
        continue;
      }

      const cause = session.provider === 'codex' ? MESSAGES.legacyCodexEnded : MESSAGES.legacyEnded;

      if (session.state === 'starting') {
        this.sessionStartFailed(session.id, cause);
        continue;
      }

      const turnEnded = TURN_ENDED.includes(session.state);
      const card = waitsOnCard(session);

      this.store.updateSession(session.id, {
        state: 'ended',
        stateAt: this.now,
        stateDetail: null,
        endedAt: this.now,
        released: true,
        releasing: false,
        question: null,
        move: null,
        pendingFork: null,
        ...(turnEnded || session.outcome !== null ? {} : { outcome: 'stopped' as const, outcomeDetail: cause }),
      });

      // Its background process may still run and change files, so it is stopped with `claude stop`; a Codex exec run ends with its turn.
      if (session.provider === 'claude' && session.shortId !== null && (!session.released || session.releasing)) {
        this.actions.push({ type: 'stop-session', sessionId: session.id, provider: 'claude', shortId: session.shortId, reason: 'operator' });
      }

      // A setup session whose turn had ended waited for its release to settle setup, so its end settles it now.
      if (session.outcome === 'done' || card || (turnEnded && session.kind === 'setup')) {
        this.ended({ ...session, state: 'ended' });
        continue;
      }

      const item = turnEnded ? null : this.latest(session);

      if (item === null || this.interactive(item)) {
        continue;
      }

      if (item.unassignedAt !== null) {
        this.done(item, 'unassigned', null);
      } else if (item.approvalHeld || item.status === 'awaiting-approval') {
        this.restoreApproval(item, cause);
      } else if (item.status === 'running' || item.status === 'setup') {
        this.block(item, cause);
      }
    }
  }

  // Operator actions

  private knownItem(workItemId: number): WorkItem {
    const item = this.store.workItem(workItemId);

    if (item === null) {
      throw new Refusal(`Unknown work item ${workItemId}.`);
    }

    return item;
  }

  private openItem(workItemId: number): WorkItem {
    const item = this.knownItem(workItemId);

    if (item.status === 'done') {
      throw new Refusal('The work item is done.');
    }

    return item;
  }

  /** A work item in Ready for review: open, ready and not snoozed (PRD R73). */
  private reviewItem(workItemId: number): WorkItem {
    const item = this.openItem(workItemId);

    if (this.store.ticket(item.ticketId)!.snoozed || groupOf({ ...item, sessions: this.store.sessionsFor(item.id), triage: this.store.triagesFor(item.id).at(-1) ?? null }) !== 'review') {
      throw new Refusal('The work item is not in Ready for review.');
    }

    return item;
  }

  /**
   * Sets `orderAt` between `after` and the next work item in Ready for review's order, or first when `after` is null. The order holds every
   * ready work item, snoozed ones too, so they return to their places, and stays before now, so a newly ready one comes last.
   */
  private move(item: WorkItem, after: number | null): void {
    if (after === item.id) {
      throw new Refusal('A work item cannot move after itself.');
    }

    if (after !== null) {
      this.reviewItem(after);
    }

    let order = this.store.readyWorkItems().filter((entry) => entry.id !== item.id);
    let index = after === null ? 0 : order.findIndex((entry) => entry.id === after) + 1;
    const gap = () => {
      const before = index === 0 ? null : reviewKey(order[index - 1]!);
      const next = index === order.length ? this.now : reviewKey(order[index]!);

      return { before, next };
    };
    let { before, next } = gap();

    if (before !== null && next - before < 2) {
      // Too close to place between: respace the whole order 1s apart, ending before now, which keeps every work item's place.
      order.forEach((entry, position) => this.store.updateWorkItem(entry.id, { orderAt: this.now - (order.length - position) * 1000 }));
      order = this.store.readyWorkItems().filter((entry) => entry.id !== item.id);
      index = after === null ? 0 : order.findIndex((entry) => entry.id === after) + 1;
      ({ before, next } = gap());
    }

    this.store.updateWorkItem(item.id, { orderAt: before === null ? next - 60_000 : Math.floor((before + next) / 2) });
  }

  /** PRD R49: local only; a snoozed ticket gets no automatic triage or start until `until` passes, or until restored when `until` is null. */
  private snooze(ticketId: number, until: number | null, comment: string | null): void {
    if (until !== null && until <= this.now) {
      throw new Refusal('The snooze time has passed.');
    }

    this.store.updateTicket(this.knownTicket(ticketId).id, { snoozed: true, snoozedUntil: until, snoozeComment: comment });
  }

  private restore(ticketId: number): void {
    this.store.updateTicket(this.knownTicket(ticketId).id, UNSNOOZED);
  }

  /** PRD R87: local only; any work item, open or done, takes a comment. */
  private comment(item: WorkItem, text: string | null): void {
    if (text === null) {
      throw new Refusal('The comment is empty.');
    }

    this.store.addComment({ workItemId: item.id, at: this.now, text });
  }

  private knownTicket(ticketId: number): Ticket {
    const ticket = this.store.ticket(ticketId);

    if (ticket === null) {
      throw new Refusal(`Unknown ticket ${ticketId}.`);
    }

    return ticket;
  }

  private poolTicket(ticketId: number): Ticket {
    const ticket = this.store.ticket(ticketId);

    if (ticket === null || !ticket.pool) {
      throw new Refusal('The ticket is not in the pool.');
    }

    if (this.hasOpenWorkItem(ticket.id)) {
      throw new Refusal('The ticket already has a work item.');
    }

    return ticket;
  }

  /** PRD R48: a queued work item with the pool triage's playbook; its task session's skill claims the ticket. */
  private pick(ticket: Ticket, guidance: string | null, playbook: string | null): void {
    const triages = this.store.poolTriages(ticket.id);
    const triaged = triages.filter((triage) => triage.playbook !== null).at(-1);

    if (triaged?.playbook == null) {
      throw new Refusal('The ticket has no triage result yet.');
    }

    const item = this.store.insertWorkItem({
      ticketId: ticket.id,
      playbook: this.chosenPlaybook(triaged.playbook, ticket, playbook),
      status: 'queued',
      stage: null,
      stageAt: null,
      taskPrompt: null,
      guidance,
      reportedPrompt: null,
      warning: null,
      error: null,
      unassignedAt: null,
      queuedAt: this.now,
      approvalPrompt: null,
      approvalSummary: null,
      approvalReport: null,
      approvalHeld: false,
      createdAt: this.now,
      statusAt: this.now,
      readyAt: null,
      orderAt: null,
      runStartedAt: this.now,
      scopeAt: null,
      doneAt: null,
      doneReason: null,
      parentId: null,
    });

    for (const triage of triages) {
      this.store.updateTriage(triage.id, { workItemId: item.id });
    }
  }

  private retriagePool(ticket: Ticket): void {
    const triages = this.store.poolTriages(ticket.id);

    if (triages.some((triage) => triage.endedAt === null)) {
      throw new Refusal('Triage is already running.');
    }

    for (const triage of triages) {
      this.store.deleteTriage(triage.id);
    }
  }

  private approve(item: WorkItem): void {
    if (item.status !== 'awaiting-approval') {
      throw new Refusal('The work item is not awaiting approval.');
    }

    this.queue(item);
  }

  private start(item: WorkItem, guidance: string | null, playbook: string | null, prompt: string | null): void {
    if (item.status !== 'unstarted') {
      throw new Refusal('The work item is not unstarted.');
    }

    // Start with prompt… edits the prompt of a work item without a playbook, which every later start runs (PRD R77).
    if (prompt !== null && ownPrompt(item) === null) {
      throw new Refusal("The work item runs its playbook's prompt.");
    }

    // The focus stays as triage set it (PRD R79).
    this.store.updateWorkItem(item.id, { guidance, playbook: this.chosenPlaybook(item.playbook, this.store.ticket(item.ticketId)!, playbook), ...(prompt === null ? {} : { taskPrompt: prompt }) });
    this.queue(item);
  }

  /** The playbook Start with guidance… chose, or triage's when it chose none (PRD R35). */
  private chosenPlaybook(triaged: string | null, ticket: Ticket, chosen: string | null): string | null {
    if (chosen === null || chosen === triaged) {
      return triaged;
    }

    if (!playbookChoices(triaged, ticket.source, this.context.playbooks).includes(chosen)) {
      throw new Refusal(triaged === null || ticket.source === SCHEDULE_SOURCE ? 'The playbook of this work item cannot change.' : `${chosen} is not a task playbook in the ${namespaceOf(triaged)} namespace.`);
    }

    return chosen;
  }

  /**
   * PRD R34: a work item that failed at triage triages again; any other failure, or a setup blocked at a usage limit (PRD R111), queues it, so
   * its next start runs setup, the approved prompt or the task session, as before it failed. Its playbook, approval, guidance and readiness stay.
   */
  private retry(item: WorkItem): void {
    if (!retries(item)) {
      throw new Refusal('The work item has not failed.');
    }

    this.requireNoSession(item);

    if (this.interactive(item)) {
      this.startSession(item);
      return;
    }

    if (failedAtTriage({ ...item, triage: this.store.triagesFor(item.id).at(-1) ?? null })) {
      this.setStatus(item.id, { status: 'triaging', error: null });
    } else {
      this.queue(item);
    }
  }

  /**
   * PRD R86: a done work item opens where its work stands: running while its task session is in a turn, `awaiting-approval` for an approval
   * that waited when it became done, else `finished`; without a task session it waits for Start, or for triage. A turn holds that approval.
   */
  private reopen(item: WorkItem): void {
    const refusal = reopenRefusal(item, this.store.workItemsForTicket(item.ticketId), this.store.ticket(item.ticketId)!);

    if (refusal !== null) {
      throw new Refusal(refusal);
    }

    const latest = this.store.sessionsFor(item.id).at(-1);

    // An outcome such as `stopped` from before the work item was done would keep its next turn end from settling it.
    if (latest !== undefined && latest.outcome !== null && latest.outcome !== 'opened') {
      this.store.updateSession(latest.id, { outcome: null, outcomeDetail: null });
    }

    const turnEnded = latest !== undefined && (TURN_ENDED.includes(latest.state) || latest.state === 'ended');
    const approval = latest?.kind === 'task' && item.approvalHeld;
    const status: WorkItemStatus = this.interactive(item) ? 'running' : latest?.kind !== 'task'
      ? item.playbook !== null || item.taskPrompt !== null ? 'unstarted' : 'triaging'
      : turnEnded ? (approval ? 'awaiting-approval' : 'finished') : 'running';

    this.setStatus(item.id, { status, approvalHeld: approval && !turnEnded, doneAt: null, doneReason: null, scopeAt: null, warning: null, error: null, unassignedAt: null, queuedAt: null });
  }

  private requireNoSession(item: WorkItem): void {
    if (this.activeSession(item) !== null) {
      throw new Refusal('The work item has an active session.');
    }
  }

  // Status changes

  /** Every status change comes here, so statusAt, runStartedAt and readyAt stay true (PRD R27). */
  private setStatus(id: number, patch: Partial<NewWorkItem> & { status: WorkItemStatus }): void {
    const { status: before, readyAt } = this.store.workItem(id)!;
    const run = RUN_STATUSES.has(patch.status) && !RUN_STATUSES.has(before) ? { runStartedAt: this.now } : {};
    const ready = readyAt === null && READY_STATUSES.has(patch.status) ? { readyAt: this.now } : {};

    this.store.updateWorkItem(id, before === patch.status ? patch : { approvalHeld: false, ...patch, statusAt: this.now, ...run, ...ready });
  }

  /** A run or stop ended without a report: the earlier approval waits again, with the cause when the run did not finish. */
  private restoreApproval(item: WorkItem, cause: string | null): void {
    this.setStatus(item.id, { status: 'awaiting-approval', error: cause });
  }

  private queue(item: WorkItem): void {
    this.setStatus(item.id, { status: 'queued', queuedAt: this.now, error: null });
  }

  private done(item: WorkItem, reason: 'session' | 'operator' | 'unassigned', warning: string | null): void {
    const scopeAt = this.store.ticket(item.ticketId)!.scopeAt ?? item.createdAt;
    const current = this.store.workItem(item.id)!;
    const latest = this.store.sessionsFor(item.id).at(-1);
    // A done report, settled now or awaiting its recheck, covers the publication; any other ending keeps a waiting or approved-but-unstarted
    // approval for Reopen (PRD R86).
    const reported = reason === 'session' || (latest !== undefined && awaitsRecheck(current, latest));
    const approvalHeld = !reported && (current.status === 'awaiting-approval' || current.approvalHeld || (current.status === 'queued' && current.approvalPrompt !== null));

    this.setStatus(item.id, { status: 'done', doneAt: this.now, doneReason: reason, warning, queuedAt: null, scopeAt, approvalHeld });
    this.endHeldSessions(item.id);
  }

  private fail(item: WorkItem, cause: string): void {
    this.setStatus(item.id, { status: 'failed', error: cause, queuedAt: null });
  }

  private block(item: WorkItem, cause: string): void {
    this.setStatus(item.id, { status: 'blocked', error: cause });
  }

  /** A run that ended without a report: `finished` for review when the prompt offered neither done nor approval, else blocked (PRD R23). */
  private endRun(item: WorkItem, session: Session, turn: boolean): void {
    if (session.reports.includes('done') || session.reports.includes('approval')) {
      this.block(item, endedMessage(session, turn));
    } else {
      this.setStatus(item.id, { status: 'finished', error: null });
    }
  }

  /** The session's work item when the session is its latest and it is not done (PRD R45). */
  private latest(session: Session): WorkItem | null {
    const item = this.store.workItem(session.workItemId)!;
    const sessions = this.store.sessionsFor(item.id);

    return item.status !== 'done' && sessions.at(-1)?.id === session.id ? item : null;
  }

  /**
   * Whether a turn of this Code Mode or Codex app-server task session that ends now would leave a question card unanswered and would otherwise
   * settle its running work item as finished or blocked (PRD R103). A hosted conversation, an unassigned ticket, a held approval and a report
   * decide as before.
   */
  private asksInCard(session: Session): boolean {
    const item = this.latest(session);

    return (
      persistent(session) &&
      session.kind === 'task' &&
      session.outcome === null &&
      item !== null &&
      item.status === 'running' &&
      item.unassignedAt === null &&
      !item.approvalHeld &&
      !this.interactive(item) &&
      this.context.questionCard?.(session.id) === true
    );
  }

  /** Whether the work item is a hosted conversation, which offers no done report and stays open when a turn or its session ends. */
  private interactive(item: WorkItem): boolean {
    return item.interactive === true || this.store.ticket(item.ticketId)?.hostWindow != null;
  }

  private activeSession(item: WorkItem): Session | null {
    return activeSession({ sessions: this.store.sessionsFor(item.id) });
  }

  // Scheduling

  schedule(): void {
    this.scheduleTriage();
    this.scheduleStarts();
  }

  /** Triages work items, then pool tickets that have no triage yet, up to `triage.concurrency` at once (PRD R47). */
  private scheduleTriage(): void {
    const running = this.store.runningTriages();
    const busy = new Set(running.map((triage) => triage.workItemId));
    // A work item waits for a pool triage still running on its ticket (`leftPool`).
    const busyTickets = new Set(running.filter((triage) => triage.workItemId === null).map((triage) => triage.ticketId));
    let free = this.context.settings.triage.concurrency - running.length;
    const start = (ticket: Ticket, item: WorkItem | null) => {
      const before = this.actions.length;
      this.startTriage(ticket, item);
      free -= this.actions.length - before;
    };

    for (const item of this.store.workItemsWithStatus('triaging')) {
      if (free <= 0) {
        return;
      }

      const ticket = this.store.ticket(item.ticketId)!;

      if (!busy.has(item.id) && !busyTickets.has(ticket.id) && !ticket.snoozed && ticket.handledAssignmentKey == null) {
        start(ticket, item);
      }
    }

    for (const ticket of this.store.poolTickets()) {
      if (free <= 0) {
        return;
      }

      if (!ticket.snoozed && ticket.handledAssignmentKey == null && this.store.poolTriages(ticket.id).length === 0 && !this.hasOpenWorkItem(ticket.id)) {
        start(ticket, null);
      }
    }
  }

  private hasOpenWorkItem(ticketId: number): boolean {
    return this.store.workItemsForTicket(ticketId).some((item) => item.status !== 'done');
  }

  /**
   * Starts queued work items in order while slots are free, skipping a ticket with another session in a turn (PRD R17, R38).
   * A session holds a slot only while its work item runs, so a question, an approval, a block, Done and Snoozed do not stall the queue.
   */
  private scheduleStarts(): void {
    const queued = this.store.workItemsWithStatus('queued').sort((a, b) => a.queuedAt! - b.queuedAt! || a.id - b.id);
    const limit = this.context.settings.sessions.concurrency;
    let used = heldSlots(this.store);

    for (const item of queued) {
      if (used >= limit) {
        return;
      }

      if (this.store.ticket(item.ticketId)?.handledAssignmentKey == null && queueWaits(this.store, item, limit, used, itemProvider(this.context.settings, this.context.playbooks, item), this.now).length === 0) {
        this.startSession(item);
        used = heldSlots(this.store);
      }
    }
  }

  /**
   * Starts the work item's setup or task session. The task after a setup session takes the setup session's slot (PRD R38). `fresh`, from New
   * conversation… (`itemSession`), starts a task session with the operator's message as its prompt in that provider instead, never a setup.
   */
  private startSession(item: WorkItem, fresh: { prompt: string; provider: Provider } | null = null): void {
    const ticket = this.store.ticket(item.ticketId)!;
    const source = this.context.settings.sources[ticket.source];
    const sessions = this.context.settings.sessions;
    const playbook = item.playbook === null ? null : (this.context.playbooks.get(item.playbook) ?? null);

    if (item.playbook !== null && playbook === null) {
      this.fail(item, `Playbook ${item.playbook} is not loaded.`);
      return;
    }

    if (playbook !== null && playbook.kind !== 'task') {
      this.fail(item, `${playbook.name} is not a task playbook.`);
      return;
    }

    const worktree = this.store.worktreeFor(ticket.id);
    const resolved = ticketRoot(this.context.settings, ticket, this.store.reposBySource());
    const repoRoot = 'root' in resolved ? resolved.root : '';
    const approved = item.approvalPrompt !== null;
    const kind: SessionKind = fresh === null && !approved && playbook?.requiresWorktree === true && worktree === null ? 'setup' : 'task';
    const cwd = playbook?.workdir === 'repoRoot' ? repoRoot : (worktree?.path ?? repoRoot);

    // A linked worktree does not lift a refusal: the root's repository may be ambiguous or not the ticket's.
    if (cwd === '' || 'error' in resolved) {
      this.fail(item, 'error' in resolved ? resolved.error : `sources.${ticket.source}.repoRoot is not set.`);
      return;
    }

    const id = this.context.newSessionId();
    const values = this.values(ticket, item);
    let prompt: string;

    if (fresh !== null) {
      prompt = fresh.prompt;
    } else if (kind === 'setup') {
      const template = source?.setupPrompt ?? '';

      if (template === '') {
        this.fail(item, `sources.${ticket.source}.setupPrompt is not set.`);
        return;
      }

      const rendered = renderTaskPrompt(template, values);

      if ('error' in rendered) {
        this.fail(item, `sources.${ticket.source}.setupPrompt: ${rendered.error}`);
        return;
      }

      prompt = rendered.text;
    } else if (approved) {
      prompt = item.approvalPrompt!;
    } else if (playbook === null) {
      // A conversation's first message starts only its first session that takes it: a retry after a failed start sends it again, one after a
      // session ran opens an empty conversation.
      prompt = this.interactive(item) && this.store.sessionsFor(item.id).some((one) => !startFailed(one)) ? '' : (item.taskPrompt ?? '');
    } else {
      const rendered = renderTaskPrompt(playbook.template, values);

      if ('error' in rendered) {
        this.fail(item, `Playbook ${playbook.name}: ${rendered.error}`);
        return;
      }

      prompt = rendered.text;
    }

    // A playbook runs its sessions in its own provider, else sessions.provider, the one its permission mode and model were checked against
    // (playbook.ts); an explicit choice applies only while the work item has no playbook, through queued starts and retries.
    const hosted = this.interactive(item);
    const provider = fresh?.provider ?? (playbook === null ? (item.provider ?? sessions.provider) : (playbook.provider ?? sessions.provider));
    // A playbook's permission mode and model were checked against its own provider, so a new conversation in another takes the sessions' own.
    const launchPlaybook = fresh !== null && provider !== (playbook?.provider ?? sessions.provider) ? null : playbook;
    const reports = sessionReports(kind, approved && fresh === null, playbook, provider).filter((report) => !hosted || (report !== 'done' && report !== 'approval'));
    // Every Claude session is held in the terminal holder, in Code Mode as sessions.codeMode says at its start; resumes keep the mode (PRD R93).
    // The Claude session ID and launch are stored before the start, so a hub restarted during it finds the process in the holder.
    const held =
      provider === 'claude' ? { codeMode: true as const, nativeSessionId: this.context.newUuid(), launchId: this.context.newUuid(), ...(sessions.codeMode ? {} : { withoutCodeMode: true as const }) } : null;
    const appServer = provider === 'codex';
    // The guidance waits through a setup session and a failed start for the task session, and an approved prompt does not take it (PRD R77).
    const guided = kind === 'task' && !approved && fresh === null;
    const full = sessionPrompt(prompt, id, guided ? item.guidance : null);
    // A Code Mode session's persona is resolved once, here, and kept for its life (architecture.md § Personas).
    const persona = held === null && !appServer ? null : resolvePersona(this.context.settings.voice, item.playbook, this.livePersonas(null));
    const tone = held === null && !appServer ? null : sessionTone(this.context.settings.voice, { personaId: persona?.id ?? null });

    if (kind === 'task' && playbook !== null && fresh === null) {
      this.store.updateWorkItem(item.id, { taskPrompt: full });
    }


    this.store.insertSession({
      id,
      workItemId: item.id,
      kind,
      provider,
      nativeSessionId: held?.nativeSessionId ?? null,
      shortId: null,
      cwd,
      state: 'starting',
      stateAt: this.now,
      stateDetail: null,
      outcome: null,
      outcomeDetail: null,
      startedAt: this.now,
      endedAt: null,
      released: false,
      releasing: false,
      question: null,
      reports,
      retiredIds: [],
      pendingFork: null,
      external: false,
      move: null,
      movedAt: null,
      codeMode: held !== null,
      ...(held?.withoutCodeMode === true ? { withoutCodeMode: true } : {}),
      ...(appServer ? { execution: 'app-server' as const } : {}),
      launchId: held?.launchId ?? (appServer ? this.context.newUuid() : null),
      promptless: hosted && prompt === '',
      personaId: persona?.id ?? null,
      personaVersion: toneVersion(tone),
      personaPinned: false,
    });
    this.setStatus(item.id, { status: kind === 'task' ? 'running' : 'setup', queuedAt: null, error: null });
    // An older app-server thread leaves its subscription (PRD R39); an older held Code Mode session keeps running (PRD R95).
    this.endHeldSessions(item.id);
    this.actions.push({
      type: 'start-session',
      sessionId: id,
      workItemId: item.id,
      kind,
      provider,
      cwd,
      ...(ticket.repoRoot === '' && cwd === repoRoot && isRootPattern(source?.repoRoot ?? '') ? { clone: repoOf(this.context.settings, ticket) } : {}),
      prompt: full,
      contract: sessionContract(id, this.context.report, reports, provider),
      name: this.interactive(item) ? '' : sessionName(kind, item, ticket),
      ...launchOptions(this.context.settings, launchPlaybook, kind, provider),
      ...(playbook === null && item.model != null ? { model: item.model } : {}),
      ...(held ?? {}),
      ...(appServer ? { execution: 'app-server' as const } : {}),
      ...(tone === null ? {} : { tone }),
    });
  }

  private values(ticket: Ticket, item: WorkItem): Record<Exclude<TemplateVariable, 'session.id'>, string> {
    const triage = this.store.triagesFor(item.id).filter((entry) => entry.playbook !== null).at(-1);
    const repo = repoOf(this.context.settings, ticket);

    return {
      'ticket.source': ticket.source,
      'ticket.sourceKey': ticket.sourceKey,
      'ticket.ref': ticket.ref,
      'ticket.repo': repo,
      'ticket.number': repo === '' ? '' : ticket.ref.slice(ticket.ref.lastIndexOf('#') + 1),
      'ticket.title': ticket.title,
      'ticket.url': ticket.url,
      'ticket.context': triage?.context ?? '',
      report: this.context.report,
    };
  }

}
