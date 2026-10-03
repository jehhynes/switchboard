import type { PoolView, Snapshot, WorkItemView } from '@switchboard/hub';

export type Group = 'needs' | 'working' | 'unstarted' | 'done';

/** PRD R27 checks Done first, then Unstarted, then Needs you, then Working. */
export function groupOf(item: WorkItemView): Group {
  if (item.status === 'done') {
    return 'done';
  }

  if (item.status === 'unstarted') {
    return 'unstarted';
  }

  if (item.status === 'awaiting-approval' || item.status === 'blocked' || item.status === 'failed' || activeSession(item)?.state === 'waiting') {
    return 'needs';
  }

  return 'working';
}

export function activeSession(item: WorkItemView): WorkItemView['sessions'][number] | null {
  return item.sessions.find((session) => session.state !== 'ended') ?? null;
}

const DONE_WORDS: Record<'session' | 'operator' | 'unassigned', string> = { session: 'Finished by the session', operator: 'Marked done', unassigned: 'Left without a done report' };

/** The one control a Needs you or Unstarted row shows outside its menu, when one applies. */
export function mainControl(item: WorkItemView): Control | null {
  const group = groupOf(item);

  if (group !== 'needs' && group !== 'unstarted') {
    return null;
  }

  const wanted = item.status === 'unstarted' ? 'Start' : item.status === 'awaiting-approval' ? 'Approve' : item.status === 'failed' || item.status === 'blocked' ? 'Retry' : null;

  return controlsOf(item).find((control) => control.label === wanted) ?? null;
}

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A short age such as `40s`, `5m`, `2h` or `3d`. */
export function age(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);

  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export interface Control {
  label: string;
  icon: string;
  /** The message the button posts. */
  message: Record<string, unknown>;
}

/** The controls that apply to a work item (PRD R27). */
export function controlsOf(item: WorkItemView): Control[] {
  const controls: Control[] = [];
  const session = activeSession(item);
  const adhoc = item.ticket.source === 'adhoc';
  const action = (type: string) => ({ type: 'action', action: { type, workItemId: item.id } });

  if (item.status === 'unstarted') {
    controls.push({ label: 'Start', icon: 'play', message: action('start') });
  }

  if (item.status === 'awaiting-approval') {
    controls.push({ label: 'Approve', icon: 'check', message: action('approve') });
  }

  if (item.status === 'failed' || item.status === 'blocked') {
    controls.push({ label: 'Retry', icon: 'refresh', message: action('retry') });
  }

  if (isBackground(session)) {
    controls.push({ label: 'Stop', icon: 'debug-stop', message: action('stop') });
  }

  if (item.status !== 'done' && session === null && !adhoc && item.status !== 'triaging') {
    controls.push({ label: 'Triage again', icon: 'search', message: action('retriage') });
  }

  if (item.status !== 'done') {
    controls.push({ label: 'Mark done', icon: 'pass', message: action('mark-done') });
  }

  if (item.status !== 'done' || item.ticket.iceboxed) {
    controls.push(iceboxControl(item.ticket.id, item.ticket.iceboxed));
  }

  return controls;
}

type SessionView = WorkItemView['sessions'][number];

/** A session running in its background process; a released session that is active again was resumed elsewhere, such as in a VS Code tab. */
function isBackground(session: SessionView | null): session is SessionView & { shortId: string } {
  return session !== null && session.state !== 'starting' && session.shortId !== null && !session.released;
}

const SESSION_STATES: Record<string, string> = { starting: 'running', running: 'running', waiting: 'waiting', idle: 'idle', failed: 'failed' };

/**
 * The one session control: an icon with a dot for the active session's state, which opens the latest session, attaching to
 * its background process or opening it in VS Code (PRD R27). Null when the work item has had no session.
 */
export function sessionControl(item: WorkItemView): { state: string | null; title: string; message: Record<string, unknown> | null } | null {
  const latest = item.sessions.at(-1) ?? null;

  if (latest === null) {
    return null;
  }

  const session = activeSession(item);
  const state = session === null ? null : (SESSION_STATES[session.state] ?? 'running');
  const words = state === null ? 'No active session' : `Session ${state}`;

  if (isBackground(session)) {
    return { state, title: `${words}. Attach`, message: { type: 'attach', shortId: session.shortId, name: `${item.ticket.source} ${item.ticket.sourceKey}` } };
  }

  if (latest.nativeSessionId !== null && (session === null || session.released)) {
    return { state, title: `${words}. Open in VS Code`, message: { type: 'open', sessionId: latest.nativeSessionId, cwd: latest.cwd } };
  }

  return { state, title: words, message: null };
}

function sessionButton(item: WorkItemView): string {
  const control = sessionControl(item);

  if (control === null) {
    return '';
  }

  const dot = control.state === null ? '' : `<span class="state-dot ${control.state}"></span>`;
  const attrs = control.message === null ? ' disabled' : ` data-message="${escape(JSON.stringify(control.message))}"`;

  return `<button class="control session-button" title="${escape(control.title)}"${attrs}><span class="codicon codicon-sparkle"></span>${dot}</button>`;
}

/** Icebox or Restore for a ticket (PRD R49). */
function iceboxControl(ticketId: number, iceboxed: boolean): Control {
  return iceboxed
    ? { label: 'Restore', icon: 'debug-restart', message: { type: 'action', action: { type: 'restore', ticketId } } }
    : { label: 'Icebox', icon: 'archive', message: { type: 'action', action: { type: 'icebox', ticketId } } };
}

/** A main control: the icon, with the verb in the tooltip (PRD R27). */
function iconButton(control: Control): string {
  return `<button class="control icon-button" title="${escape(control.label)}" data-message="${escape(JSON.stringify(control.message))}"><span class="codicon codicon-${control.icon}"></span></button>`;
}

/** A menu control, with its text. */
function button(control: Control): string {
  return `<button class="control" title="${escape(control.label)}" data-message="${escape(JSON.stringify(control.message))}"><span class="codicon codicon-${control.icon}"></span><span>${escape(control.label)}</span></button>`;
}

/** Time in queue as a whole number of minutes, hours, days or weeks, such as `40m`, `5h`, `3d` or `2w`. */
export function queueTime(since: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);

  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

function queued(since: number | null, until: number): string {
  return since === null ? '' : `<span class="queue" title="In queue since ${escape(new Date(since).toISOString().slice(0, 16).replace('T', ' '))} UTC">${queueTime(since, until)}</span>`;
}

type Rating = { immediacy: string | null; severity: string | null } | null;

const RANKS: Record<string, number> = { URGENT: 0, BLOCKING: 1, 'NON-BLOCKING': 2, HIGH: 0, MED: 1, LOW: 2 };

/** Immediacy rank plus severity rank, or null unless both are rated (PRD R50). */
export function rankOf(triage: Rating): number | null {
  const immediacy = triage?.immediacy == null ? undefined : RANKS[triage.immediacy];
  const severity = triage?.severity == null ? undefined : RANKS[triage.severity];

  return immediacy === undefined || severity === undefined ? null : immediacy + severity;
}

/** The priority dot: red for rank 0–1, orange for 2, grey for 3–4; nothing when unrated (PRD R27, R50). */
export function priorityDot(triage: Rating): string {
  const rank = rankOf(triage);
  if (rank === null) {
    return '';
  }

  const level = rank <= 1 ? 'high' : rank === 2 ? 'medium' : 'low';
  const title = `Priority ${level}: ${triage!.immediacy}/${triage!.severity}`;

  return `<span class="priority ${level}" title="${escape(title)}"></span>`;
}

export interface Mark {
  icon: string;
  /** What the mark means, in words, for its tooltip. */
  title: string;
  /** `error` or `warning` colours the mark. */
  tone?: 'error' | 'warning';
}

/** A blocked report that asks the operator something. */
function asksQuestion(item: WorkItemView): boolean {
  return item.status === 'blocked' && (item.error ?? '').trim().endsWith('?');
}

/** The row mark shows what differs between rows of the same group; an iceboxed item shows its group's mark (PRD R27). Unstarted rows show the priority dot. */
export function markOf(item: WorkItemView): Mark | 'priority' {
  const session = activeSession(item);

  switch (groupOf(item)) {
    case 'needs':
      if (session?.state === 'waiting' || asksQuestion(item)) {
        return { icon: 'comment-discussion', title: 'Answer a question' };
      }

      if (item.status === 'awaiting-approval') {
        return { icon: 'cloud-upload', title: 'Approve the publish' };
      }

      return item.status === 'failed' ? { icon: 'error', title: 'Failed', tone: 'error' } : { icon: 'debug-pause', title: 'Blocked' };
    case 'working':
      if (item.status === 'triaging') {
        return { icon: 'search', title: 'Triaging' };
      }

      if (item.status === 'queued') {
        return { icon: 'clock', title: 'Queued' };
      }

      if (item.status === 'setup') {
        return { icon: 'tools', title: item.needsPick ? 'Claiming' : 'Setting up' };
      }

      return { icon: 'sync codicon-modifier-spin', title: 'Running' };
    case 'unstarted':
      return 'priority';
    case 'done':
      return item.doneReason === 'operator'
        ? { icon: 'account', title: DONE_WORDS.operator }
        : item.doneReason === 'unassigned'
          ? { icon: 'warning', title: DONE_WORDS.unassigned, tone: 'warning' }
          : { icon: 'check', title: DONE_WORDS.session };
  }
}

function markHtml(item: WorkItemView): string {
  const mark = markOf(item);

  return mark === 'priority' ? `<span class="mark">${priorityDot(item.triage)}</span>` : markIcon(mark);
}

function markIcon(mark: Mark): string {
  return `<span class="mark codicon codicon-${mark.icon}${mark.tone === undefined ? '' : ` ${mark.tone}`}" title="${escape(mark.title)}"></span>`;
}

/** The playbook name: the namespace and colon muted, the name in bold (PRD R27). */
function playbookLabel(name: string): string {
  const colon = name.indexOf(':');
  const namespace = colon === -1 ? '' : name.slice(0, colon + 1);

  return `<span class="playbook-name" title="${escape(name)}"><span class="namespace">${escape(namespace)}</span><span class="name">${escape(name.slice(colon + 1))}</span></span>`;
}

/** Marks a ticket that came back after earlier work items (PRD R51). */
function returned(count: number): string {
  return count === 0 ? '' : `<span class="returned" title="${count} earlier work item${count === 1 ? '' : 's'}">Returned ×${count}</span>`;
}

/** The ... button and, when open, the menu with the row's other controls. */
function moreMenu(key: string, controls: Control[], open: boolean): string {
  if (controls.length === 0) {
    return '';
  }

  return `<span class="more"><button class="more-button" title="More actions" data-menu="${escape(key)}"><span class="codicon codicon-ellipsis"></span></button>${
    open ? `<div class="menu">${controls.map(button).join('')}</div>` : ''
  }</span>`;
}

function row(item: WorkItemView, now: number, ui: PanelUi): string {
  const main = mainControl(item);
  const key = `${item.ticket.source} ${item.ticket.sourceKey}`;
  const menuKey = `item:${item.id}`;
  const ticket = item.ticket.url === '' ? `<span class="key">${escape(key)}</span>` : `<a class="key" href="${escape(item.ticket.url)}">${escape(key)}</a>`;
  const stage = item.stage === null ? '' : `<span class="stage">${escape(item.stage)}${item.stageAt === null ? '' : ` · ${age(item.stageAt, now)}`}</span>`;
  const approval = item.approvalSummary === null || item.status !== 'awaiting-approval' ? '' : `<span class="approval" title="${escape(item.approvalSummary)}">${escape(item.approvalSummary)}</span>`;
  const notes = [item.warning, item.error].filter((note): note is string => note !== null).map((note) => `<span class="note" title="${escape(note)}">${escape(note)}</span>`).join('');
  const worktree =
    item.worktree === null ? '' : `<span class="worktree codicon codicon-git-branch" title="${escape([item.worktree.branch, item.worktree.path].filter((part) => part !== null).join('\n'))}"></span>`;
  const links = item.links
    .map((link) => `<a class="badge" href="${escape(link.target)}" title="${escape(link.target)}"><span class="codicon codicon-link"></span> ${escape(link.label)}</a>`)
    .join('');
  // A pool ticket has waited since the customer's last message; any other since its work item was created.
  const since = item.ticket.sortAt ?? item.createdAt;
  const others = controlsOf(item).filter((control) => control.label !== main?.label);
  const dot = item.status === 'unstarted' || (rankOf(item.triage) ?? 3) > 2 ? '' : priorityDot(item.triage);

  return `<div class="item" data-item="${item.id}">
<div class="line">${markHtml(item)} ${ticket} <span class="title" title="${escape(item.ticket.title)}">${dot}${escape(item.ticket.title)}</span> ${playbookLabel(item.playbook ?? (item.ticket.source === 'adhoc' ? 'ad-hoc' : ''))}${queued(since, item.doneAt ?? now)}<span class="actions">${main === null ? '' : iconButton(main)}${sessionButton(item)}${moreMenu(menuKey, others, ui.menu === menuKey)}</span></div>
<div class="line second"><span class="meta">${stage}${worktree}${approval}${links}${returned(item.returned)}${notes}</span></div>
</div>`;
}

function errors(snapshot: Snapshot): string {
  const lines = [
    snapshot.errors.settings === null ? null : `Settings: ${snapshot.errors.settings}`,
    ...snapshot.errors.playbooks.map((error) => `Playbook ${error}`),
    snapshot.errors.hooks === null ? null : `Hooks: ${snapshot.errors.hooks}`,
    ...Object.entries(snapshot.errors.sources).map(([name, error]) => `${name}: ${error}`),
  ].filter((line): line is string => line !== null);

  return lines.length === 0 ? '' : `<div class="errors">${lines.map((line) => `<div class="note"><span class="codicon codicon-warning"></span> ${escape(line)}</div>`).join('')}</div>`;
}

/** Says plainly what an unconfigured home is missing. */
function setup(snapshot: Snapshot): string {
  const lines = [
    snapshot.sources.length === 0 ? `No source is polled. Enable a source in ${snapshot.home}\\settings.json.` : null,
    snapshot.playbooks.length === 0 ? `No task playbooks are loaded. Add them under ${snapshot.home}\\playbooks.` : null,
  ].filter((line): line is string => line !== null);

  return lines.map((line) => `<p class="empty"><span class="codicon codicon-info"></span> ${escape(line)}</p>`).join('');
}


/** A pool row in Unstarted: the ticket, priority, playbook, time in queue, Unclaimed, Start (a pick), and Icebox in the menu (PRD R27, R47, R48). */
function poolRow(entry: PoolView, now: number, ui: PanelUi): string {
  const { ticket, triage } = entry;
  const key = `${ticket.source} ${ticket.sourceKey}`;
  const menuKey = `ticket:${ticket.id}`;
  const link = ticket.url === '' ? `<span class="key">${escape(key)}</span>` : `<a class="key" href="${escape(ticket.url)}">${escape(key)}</a>`;
  const pick: Control = { label: 'Start', icon: 'play', message: { type: 'action', action: { type: 'pick', ticketId: ticket.id } } };
  const again: Control = { label: 'Triage again', icon: 'search', message: { type: 'action', action: { type: 'retriage-pool', ticketId: ticket.id } } };
  const failed = triage?.error != null;
  // An iceboxed ticket is never triaged, so a missing triage is not shown as running.
  const triaging = triage !== null && triage.endedAt === null;
  const [main, ...others] = failed ? [again, pick, iceboxControl(ticket.id, ticket.iceboxed)] : [pick, iceboxControl(ticket.id, ticket.iceboxed)];

  return `<div class="item pool-item" data-ticket="${ticket.id}">
<div class="line">${triaging ? markIcon({ icon: 'search', title: 'Triaging' }) : `<span class="mark">${priorityDot(triage)}</span>`} ${link} <span class="title" title="${escape(ticket.title)}">${escape(ticket.title)}</span> ${playbookLabel(triage?.playbook ?? '')}${queued(ticket.sortAt, now)}<span class="actions">${iconButton(main!)}${moreMenu(menuKey, others, ui.menu === menuKey)}</span></div>
<div class="line second"><span class="meta"><span class="tag" title="Start claims it">Unclaimed</span>${returned(entry.returned)}${failed ? `<span class="note" title="${escape(triage!.error!)}">${escape(triage!.error!)}</span>` : ''}</span></div>
</div>`;
}

/**
 * Unstarted work items and pool tickets together: by importance rank, an unrated one counting as rank 2, then oldest first
 * by the source's sort time or the work item's creation (PRD R27, R50).
 */
export function unstartedOrder(items: WorkItemView[], pool: PoolView[]): (WorkItemView | PoolView)[] {
  const key = (entry: WorkItemView | PoolView) => {
    const since = entry.ticket.sortAt ?? ('createdAt' in entry ? entry.createdAt : Infinity);

    return [rankOf(entry.triage) ?? 2, since] as const;
  };

  return [...items, ...pool].sort((a, b) => {
    const [rankA, sinceA] = key(a);
    const [rankB, sinceB] = key(b);

    return rankA - rankB || (sinceA === sinceB ? 0 : sinceA < sinceB ? -1 : 1);
  });
}

/** What the operator changed in the panel: opened or closed groups, and the open ... menu. */
export interface PanelUi {
  /** Groups the operator opened or closed; others take their default. */
  groups: ReadonlyMap<string, boolean>;
  menu: string | null;
}

/** Needs you, Working and Unstarted start open; Done and Icebox start closed. */
const OPEN_BY_DEFAULT = new Set(['needs', 'working', 'unstarted']);

function group(key: string, title: string, count: number, body: string, ui: PanelUi): string {
  const open = ui.groups.get(key) ?? OPEN_BY_DEFAULT.has(key);

  return `<details class="group" data-group="${key}"${open ? ' open' : ''}><summary><h3>${escape(title)} (${count})</h3></summary>${body}</details>`;
}

/** The whole panel. */
export function renderPanel(snapshot: Snapshot, now: number, ui: PanelUi): string {
  const groups: Record<Group, WorkItemView[]> = { needs: [], working: [], unstarted: [], done: [] };
  const iceboxedItems = snapshot.workItems.filter((item) => item.ticket.iceboxed);
  const iceboxedPool = snapshot.pool.filter((entry) => entry.ticket.iceboxed);
  const pool = snapshot.pool.filter((entry) => !entry.ticket.iceboxed);

  for (const item of snapshot.workItems) {
    if (!iceboxedItems.includes(item)) {
      groups[groupOf(item)].push(item);
    }
  }

  const list = (items: WorkItemView[]) => items.map((item) => row(item, now, ui)).join('\n');
  const pooled = (entries: PoolView[]) => entries.map((entry) => poolRow(entry, now, ui)).join('\n');
  const waiting = unstartedOrder(groups.unstarted, pool)
    .map((entry) => ('status' in entry ? row(entry, now, ui) : poolRow(entry, now, ui)))
    .join('\n');
  const iceboxCount = iceboxedItems.length + iceboxedPool.length;

  return `${errors(snapshot)}${setup(snapshot)}
${group('needs', 'Needs you', groups.needs.length, list(groups.needs) || '<p class="empty">Nothing needs you.</p>', ui)}
${group('working', 'Working', groups.working.length, list(groups.working) || '<p class="empty">Nothing is running.</p>', ui)}
${group('unstarted', 'Unstarted', groups.unstarted.length + pool.length, waiting || '<p class="empty">Nothing waits to be started.</p>', ui)}
${group('done', 'Done', groups.done.length, list(groups.done), ui)}
${iceboxCount === 0 ? '' : group('icebox', 'Icebox', iceboxCount, `${list(iceboxedItems)}${pooled(iceboxedPool)}`, ui)}`;
}
