/**
 * The snapshot every window and the dock are built from (architecture.md § Hub lifecycle): a pure projection of the store and the runtime's
 * inputs, so the hub can build it in a worker thread with its own read-only connection and keep its main thread free.
 */
import type { Comment, Link, OpenTerminal, OpenVSCode, Paste, Playbook, Provider, QueueWait, Session, Settings, Store, Ticket, Triage, WorkItem, Worktree } from '@switchboard/core';
import { effectiveFocus, heldSlots, homeRepo, playbookChoices, PROVIDERS, queueWaits, reopenRefusal, repoRoots, SCHEDULE_SOURCE, ADHOC_SOURCE } from '@switchboard/core';
import type { HeldSession } from './held.js';
import { doneSince } from './rows.js';
import type { RepoKeys } from './rows.js';

/** What the runtime holds in memory that a snapshot shows; structured-cloneable, so a worker can take it as one message. */
export interface SnapshotInputs {
  settings: Settings;
  playbooks: Array<[string, Playbook]>;
  settingsError: string | null;
  playbookErrors: Array<{ name: string; error: string }>;
  /** Sources the operator turned on. */
  enabled: string[];
  /** Sources being polled. */
  sources: string[];
  held: HeldSession[];
  /** The pids the resume guard last found per session (PRD R95). */
  guarded: Array<[string, number[]]>;
  nodeError: string | null;
  hookErrors: Record<Provider, string | null>;
  sourceErrors: Record<string, string>;
  sourceNotes: Record<string, string[]>;
  now: number;
  configDir: string;
}

export interface WorkItemView extends WorkItem {
  ticket: Ticket;
  /** The latest triage, which may still be running. */
  triage: Triage | null;
  /** The URL an item window opens: the latest successful triage's focus, else the ticket's URL (PRD R79). */
  focus: string | null;
  sessions: Session[];
  worktree: Worktree | null;
  links: Link[];
  /** Drafted texts the operator copies into the source (PRD R60). */
  pastes: Paste[];
  /** The operator's comments, oldest first (PRD R87). */
  comments: Comment[];
  /** Earlier started work items for the same ticket with the same playbook or one it is a return of; above 0 the dock marks the work item Returned (PRD R51). */
  returned: number;
  /** The ticket of the work item whose session reported this one as a task (PRD R68). */
  parent: Ticket | null;
  /** The ad-hoc work item a ticket report moved onto this ticket: its first work item, because an ad-hoc ticket has one (PRD R83). */
  moved: boolean;
  /** The playbook's `approvalSends`: Approve sends the work (PRD R27). */
  approvalSends: boolean;
  /** What keeps a queued work item from starting; empty for every other status (PRD R34). */
  waits: QueueWait[];
  /** The operator can reopen it (PRD R86). */
  reopenable: boolean;
  /** The playbooks Start with guidance… offers an `unstarted` work item, its own among them; empty otherwise (PRD R35). */
  playbookChoices: string[];
  /** Unread replies and statuses of its latest session in the Conversation view (architecture.md § Unread). */
  unread: number;
  /** The pids that last kept the latest session, an ended Code Mode session, from resuming, which Stop ends (PRD R95); absent otherwise. */
  leftovers?: number[];
}

/** A pool ticket the operator may pick, with its pool triage (PRD R47). */
export interface PoolView {
  ticket: Ticket;
  triage: Triage | null;
  /** The URL a click on its row opens (PRD R79). */
  focus: string | null;
  /** The ticket's links, such as a GitHub issue its thread names (PRD R52, R61). */
  links: Link[];
  /** Started done work items for the ticket with the latest triage's playbook or one it is a return of; above 0 the dock marks it Returned (PRD R51). */
  returned: number;
  /** The playbooks Start with guidance… offers, the triage's among them (PRD R35). */
  playbookChoices: string[];
}

/** Everything a window and the dock show, sent whole on each change. */
export interface Snapshot {
  workItems: WorkItemView[];
  /** Oldest first by the source's sort time; the dock orders it with the unstarted work items (PRD R27). */
  pool: PoolView[];
  playbooks: { name: string; description: string }[];
  /** Repos an ad-hoc prompt can run in: each source's repo root, the first being the default. */
  repoRoots: string[];
  /** The schedules Run now offers, in settings order (PRD R82). */
  schedules: { name: string; playbook: string }[];
  /** Sources being polled. */
  sources: string[];
  /** Every configured source but ad-hoc with its plugin, for the operator's source filter. */
  sourceStates: { name: string; kind: string; enabled: boolean }[];
  /** Each configured source's playbook namespace, which names a triage in progress, such as `dev:triage`. */
  namespaces: Record<string, string>;
  /** The folder holding settings.json. */
  configDir: string;
  /** `dock.openVSCode`: whether rows open their item window always, or only for review (PRD R71). */
  openVSCode: OpenVSCode;
  /** `dock.openTerminal`: where the dock's Open in terminal runs with `always` (PRD R28). */
  openTerminal: OpenTerminal;
  errors: { settings: string | null; playbooks: string[]; hooks: string | null; sources: Record<string, string> };
  /** What the enabled sources' last polls left out, such as `personal: <url> belongs to github.` (PRD R44); absent from an older hub's. */
  notes?: string[];
  /** How rows shorten other repositories' keys (PRD R27); absent from an older hub's. */
  repoKeys?: RepoKeys;
  /** The terminal holder's sessions joined with the store, orphans first (PRD R94); absent when it holds none. */
  held?: HeldSession[];
  /** In a window's scoped snapshot only: how many work items need the operator, without naming them (architecture.md § Window scope). */
  needsCount?: number;
}


/** Each source's home repository and label, and each other repository's short name: its label, else its name when no other owner shares it. */
export function repoKeysOf(settings: Settings, stored: Readonly<Record<string, readonly string[]>>): RepoKeys {
  const labels: Record<string, string> = {};

  for (const source of Object.values(settings.sources)) {
    const entries = source.kind === 'github' ? source.options['labels'] : undefined;

    for (const [repo, label] of typeof entries === 'object' && entries !== null ? Object.entries(entries) : []) {
      if (typeof label === 'string') {
        labels[repo.toLowerCase()] = label;
      }
    }
  }

  const repos = [...new Set([...Object.keys(labels), ...Object.values(stored).flat()])];
  const nameOf = (repo: string) => repo.slice(repo.indexOf('/') + 1);
  const count = (name: string) => repos.filter((repo) => nameOf(repo) === name).length;
  const prefixes = Object.fromEntries(repos.flatMap((repo) => (labels[repo] !== undefined ? [[repo, labels[repo]]] : count(nameOf(repo)) === 1 ? [[repo, nameOf(repo)]] : [])));

  return { homes: Object.fromEntries(Object.entries(settings.sources).map(([name, source]) => [name, homeRepo(source)])), prefixes };
}


export function buildSnapshot(store: Store, inputs: SnapshotInputs): Snapshot {
const { settings, settingsError, playbookErrors } = inputs;
const playbooks = new Map(inputs.playbooks);
const enabled = new Set(inputs.enabled);
const sources = new Set(inputs.sources);
const guarded = new Map(inputs.guarded);
const leftoversOf = (latest: Session | undefined): { leftovers?: number[] } => {
  const pids = latest === undefined ? undefined : guarded.get(latest.id);

  return pids === undefined || latest?.codeMode !== true || latest.state !== 'ended' || (latest.lastTree?.length ?? 0) === 0 ? {} : { leftovers: pids };
};
  // Returned counts earlier work items with the same playbook, or one it is a return of, that started a session; a failed launch has no shortId.
  const started = (item: WorkItem) => store.sessionsFor(item.id).some((session) => session.shortId !== null);
  const returned = (items: WorkItem[], playbook: string | null, ticket: Ticket) => {
    // A schedule's runs repeat by design, so they are not returns (PRD R82).
    if (playbook === null || ticket.source === SCHEDULE_SOURCE) {
      return 0;
    }

    const counted = new Set([playbook, ...(playbooks.get(playbook)?.returnOf ?? [])]);

    return items.filter((item) => item.playbook !== null && counted.has(item.playbook) && started(item)).length;
  };
  const unreadOf = (latest: Session | undefined): number => (latest?.codeMode === true ? store.unreadCount(latest.id) : 0);
  const used = heldSlots(store);
  const held = inputs.held;

  return {
    workItems: store.workItems(doneSince(inputs.now)).map((item) => {
      const ticket = store.ticket(item.ticketId)!;
      const triages = store.triagesFor(item.id);

      return {
        ...item,
        ticket,
        triage: triages.at(-1) ?? null,
        focus: effectiveFocus(triages, ticket.url),
        sessions: store.sessionsFor(item.id).map(({ lastTree: _lastTree, ...session }) => session),
        ...leftoversOf(store.sessionsFor(item.id).at(-1)),
        unread: unreadOf(store.sessionsFor(item.id).at(-1)),
        worktree: store.worktreeFor(item.ticketId),
        links: store.linksFor(item.ticketId),
        pastes: store.pastesFor(item.id),
        comments: store.commentsFor(item.id),
        returned: returned(store.workItemsForTicket(item.ticketId).filter((other) => other.id < item.id), item.playbook, ticket),
        parent: item.parentId === null ? null : store.ticket(store.workItem(item.parentId)!.ticketId),
        moved: ticket.adhocKey !== null && store.workItemsForTicket(item.ticketId)[0]?.id === item.id,
        approvalSends: item.playbook !== null && playbooks.get(item.playbook)?.approvalSends === true,
        waits: item.status === 'queued' ? queueWaits(store, item, settings.sessions.concurrency, used) : [],
        reopenable: reopenRefusal(item, store.workItemsForTicket(item.ticketId), ticket) === null,
        playbookChoices: item.status === 'unstarted' ? playbookChoices(item.playbook, ticket.source, playbooks) : [],
      };
    }),
    pool: store
      .poolTickets()
      .map((ticket) => ({ ticket, items: store.workItemsForTicket(ticket.id) }))
      // A disabled source's pool is not read, so its tickets are not shown.
      .filter(({ ticket, items }) => sources.has(ticket.source) && items.every((item) => item.status === 'done'))
      .map(({ ticket, items }) => {
        const triages = store.poolTriages(ticket.id);
        const triage = triages.at(-1) ?? null;

        return { ticket, triage, focus: effectiveFocus(triages, ticket.url), links: store.linksFor(ticket.id), returned: returned(items, triage?.playbook ?? null, ticket), playbookChoices: playbookChoices(triage?.playbook ?? null, ticket.source, playbooks) };
      }),
    playbooks: [...playbooks.values()].filter((playbook) => playbook.kind === 'task').map(({ name, description }) => ({ name, description })),
    repoRoots: repoRoots(settings, store.reposBySource()),
    schedules: Object.entries(settings.schedules).map(([name, schedule]) => ({ name, playbook: schedule.playbook })),
    sources: [...sources],
    sourceStates: Object.entries(settings.sources)
      .filter(([name]) => name !== ADHOC_SOURCE)
      .map(([name, source]) => ({ name, kind: source.kind, enabled: enabled.has(name) })),
    namespaces: Object.fromEntries(Object.entries(settings.sources).map(([name, source]) => [name, source.namespace])),
    openVSCode: settings.dock.openVSCode,
    openTerminal: settings.dock.openTerminal,
    configDir: inputs.configDir,
    errors: {
      settings: settingsError,
      playbooks: playbookErrors.map((entry) => `${entry.name}: ${entry.error}`),
      hooks: [inputs.nodeError, ...PROVIDERS.map((provider) => inputs.hookErrors[provider])].filter((error) => error !== null).join(' ') || null,
      sources: { ...inputs.sourceErrors },
    },
    notes: [...sources].flatMap((name) => (inputs.sourceNotes[name] ?? []).map((note) => `${name}: ${note}`)),
    repoKeys: repoKeysOf(settings, store.reposBySource()),
    ...(held.length > 0 ? { held } : {}),
  };
}

