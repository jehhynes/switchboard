import type { PoolView, Snapshot, WorkItemView } from '@switchboard/hub';

export type Group = 'needs' | 'working' | 'done';

/** PRD R27: Done first, then Needs you, then Working. */
export function groupOf(item: WorkItemView): Group {
  if (item.status === 'done') {
    return 'done';
  }

  if (item.status === 'awaiting-approval' || item.status === 'blocked' || item.status === 'failed' || activeSession(item)?.state === 'waiting') {
    return 'needs';
  }

  return 'working';
}

export function activeSession(item: WorkItemView): WorkItemView['sessions'][number] | null {
  return item.sessions.find((session) => session.state !== 'ended') ?? null;
}

const STATUS_WORDS: Record<string, string> = {
  triaging: 'Triaging',
  'awaiting-approval': 'Awaiting approval',
  queued: 'Queued',
  setup: 'Setting up',
  running: 'Running',
  blocked: 'Blocked',
  failed: 'Failed',
  done: 'Done',
};

const DONE_WORDS: Record<'session' | 'operator' | 'unassigned', string> = { session: 'Finished by the session', operator: 'Marked done', unassigned: 'Left without a done report' };

/** The row's status in words; an active session waiting on the operator, or still running after done, says so. */
export function statusOf(item: WorkItemView): string {
  const session = activeSession(item);

  if (item.status === 'done') {
    // The Done group already says done, so the row says how it ended.
    const ended = DONE_WORDS[item.doneReason ?? 'session'];

    return session === null ? ended : `${ended}, session ${session.state}`;
  }

  if (session?.state === 'waiting') {
    return 'Waiting on you';
  }

  if (item.status === 'setup' && item.needsPick) {
    return 'Claiming';
  }

  return STATUS_WORDS[item.status] ?? item.status;
}

/** The one control a Needs you row shows without expanding, when one applies. */
export function mainControl(item: WorkItemView): Control | null {
  if (groupOf(item) !== 'needs') {
    return null;
  }

  const wanted = item.status === 'awaiting-approval' ? 'Approve' : item.status === 'failed' || item.status === 'blocked' ? 'Retry' : 'Attach';

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
  const latest = item.sessions.at(-1) ?? null;
  const adhoc = item.ticket.source === 'adhoc';
  const action = (type: string) => ({ type: 'action', action: { type, workItemId: item.id } });

  if (item.status === 'awaiting-approval') {
    controls.push({ label: 'Approve', icon: 'check', message: action('approve') });
  }

  if (item.status === 'failed' || item.status === 'blocked') {
    controls.push({ label: 'Retry', icon: 'refresh', message: action('retry') });
  }

  // A released session that is active again was resumed outside its background process, such as in a VS Code tab.
  const background = session !== null && session.state !== 'starting' && session.shortId !== null && !session.released;

  if (background) {
    controls.push({ label: 'Attach', icon: 'terminal', message: { type: 'attach', shortId: session.shortId, name: `${item.ticket.source} ${item.ticket.sourceKey}` } });
    controls.push({ label: 'Stop', icon: 'debug-stop', message: action('stop') });
  } else if (latest?.nativeSessionId != null && (session === null || session.released)) {
    controls.push({ label: 'Open in VS Code', icon: 'link-external', message: { type: 'open', sessionId: latest.nativeSessionId, cwd: latest.cwd } });
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

/** Icebox or Restore for a ticket (PRD R49). */
function iceboxControl(ticketId: number, iceboxed: boolean): Control {
  return iceboxed
    ? { label: 'Restore', icon: 'debug-restart', message: { type: 'action', action: { type: 'restore', ticketId } } }
    : { label: 'Icebox', icon: 'archive', message: { type: 'action', action: { type: 'icebox', ticketId } } };
}

/** Change playbook applies with no active session, to a work item that is not done and not ad-hoc. */
export function canChangePlaybook(item: WorkItemView): boolean {
  return item.status !== 'done' && item.ticket.source !== 'adhoc' && activeSession(item) === null;
}

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

/** The priority dot: red for rank 0–1, orange for 2, grey for 3–4, hollow when unrated (PRD R27, R50). */
export function priorityDot(triage: Rating): string {
  const rank = rankOf(triage);
  const level = rank === null ? 'unrated' : rank <= 1 ? 'high' : rank === 2 ? 'medium' : 'low';
  const title = rank === null ? 'Not rated' : `Priority ${level}: ${triage!.immediacy}/${triage!.severity}`;

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

/** The row mark shows what differs between rows of the same group; an iceboxed item shows its group's mark (PRD R27). */
export function markOf(item: WorkItemView): Mark {
  const session = activeSession(item);

  switch (groupOf(item)) {
    case 'needs':
      if (session?.state === 'waiting' || asksQuestion(item)) {
        return { icon: 'comment-discussion', title: 'Answer a question' };
      }

      if (item.status === 'awaiting-approval') {
        return item.approvalPrompt === null ? { icon: 'rocket', title: 'Approve the start' } : { icon: 'cloud-upload', title: 'Approve the publish' };
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
    case 'done':
      return item.doneReason === 'operator'
        ? { icon: 'account', title: DONE_WORDS.operator }
        : item.doneReason === 'unassigned'
          ? { icon: 'warning', title: DONE_WORDS.unassigned, tone: 'warning' }
          : { icon: 'check', title: DONE_WORDS.session };
  }
}

function markIcon(mark: Mark): string {
  return `<span class="mark codicon codicon-${mark.icon}${mark.tone === undefined ? '' : ` ${mark.tone}`}" title="${escape(mark.title)}"></span>`;
}

/** Marks a ticket that came back after earlier work items (PRD R51). */
function returned(count: number): string {
  return count === 0 ? '' : `<span class="returned" title="${count} earlier work item${count === 1 ? '' : 's'}">Returned ×${count}</span>`;
}

/** The ... button and, when open, the menu with the row's other controls. */
function moreMenu(key: string, controls: Control[], extra: string, open: boolean): string {
  if (controls.length === 0 && extra === '') {
    return '';
  }

  return `<span class="more"><button class="more-button" title="More actions" data-menu="${escape(key)}"><span class="codicon codicon-ellipsis"></span></button>${
    open ? `<div class="menu">${controls.map(button).join('')}${extra}</div>` : ''
  }</span>`;
}

function section(title: string, body: string | null | undefined): string {
  return body ? `<h4>${escape(title)}</h4><pre>${escape(body)}</pre>` : '';
}

function row(item: WorkItemView, snapshot: Snapshot, now: number, ui: PanelUi): string {
  const status = statusOf(item);
  const main = mainControl(item);
  const key = `${item.ticket.source} ${item.ticket.sourceKey}`;
  const menuKey = `item:${item.id}`;
  const ticket = item.ticket.url === '' ? `<span class="key">${escape(key)}</span>` : `<a class="key" href="${escape(item.ticket.url)}">${escape(key)}</a>`;
  const stage = item.stage === null ? '' : `<span class="stage">${escape(item.stage)}${item.stageAt === null ? '' : ` · ${age(item.stageAt, now)}`}</span>`;
  const approval = item.approvalSummary === null || item.status !== 'awaiting-approval' ? '' : `<span class="approval">${escape(item.approvalSummary)}</span>`;
  const notes = [item.warning, item.error].filter((note): note is string => note !== null).map((note) => `<span class="note">${escape(note)}</span>`).join('');
  const worktree = item.worktree === null ? '' : `<span class="worktree" title="${escape(item.worktree.path)}"><span class="codicon codicon-git-branch"></span> ${escape(item.worktree.branch ?? item.worktree.path)}</span>`;
  const playbooks = canChangePlaybook(item)
    ? `<select class="playbook" data-item="${item.id}"><option value="">Change playbook…</option>${snapshot.playbooks
        .filter((playbook) => playbook.name !== item.playbook)
        .map((playbook) => `<option value="${escape(playbook.name)}" title="${escape(playbook.description)}">${escape(playbook.name)}</option>`)
        .join('')}</select>`
    : '';
  const links = item.links
    .map((link) => `<a class="badge" href="${escape(link.target)}" title="${escape(link.target)}"><span class="codicon codicon-link"></span> ${escape(link.label)}</a>`)
    .join('');
  const history = item.sessions
    .map((entry) => `<li>${escape(entry.kind)} ${escape(entry.id)}: ${escape(entry.state)}${entry.outcome === null ? '' : `, ${escape(entry.outcome)}`}${entry.outcomeDetail === null ? '' : ` (${escape(entry.outcomeDetail)})`}, started ${age(entry.startedAt, now)} ago</li>`)
    .join('');
  // A pool ticket has waited since the customer's last message; any other since its work item was created.
  const since = item.ticket.sortAt ?? item.createdAt;
  const others = controlsOf(item).filter((control) => control.label !== main?.label);

  return `<details class="item" data-item="${item.id}"${ui.expanded.has(item.id) ? ' open' : ''}>
<summary><span class="line">${markIcon(markOf(item))} ${ticket} <span class="title" title="${escape(item.ticket.title)}">${(rankOf(item.triage) ?? 3) <= 2 ? priorityDot(item.triage) : ''}${escape(item.ticket.title)}</span> ${returned(item.returned)}${queued(since, item.doneAt ?? now)}<span class="playbook-name">${escape(item.playbook ?? (item.ticket.source === 'adhoc' ? 'ad-hoc' : ''))}</span></span>
<span class="line second"><span class="status">${escape(status)}</span> ${stage} ${worktree}${approval}<span class="actions">${main === null ? '' : button(main)}${moreMenu(menuKey, others, playbooks, ui.menu === menuKey)}</span></span>${links === '' ? '' : `<span class="line second links">${links}</span>`}${notes}</summary>
<div class="detail">${section('Summary', item.triage?.summary)}${section('Triage context', item.triage?.context)}${section('Task prompt', item.taskPrompt)}${history === '' ? '' : `<h4>Sessions</h4><ul>${history}</ul>`}</div>
</details>`;
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


/** A pool row: the ticket, priority, time in queue, triage summary and playbook, Pick, and Icebox in the menu (PRD R47, R48, R50, R51). */
function poolRow(entry: PoolView, now: number, ui: PanelUi): string {
  const { ticket, triage } = entry;
  const key = `${ticket.source} ${ticket.sourceKey}`;
  const menuKey = `ticket:${ticket.id}`;
  const link = ticket.url === '' ? `<span class="key">${escape(key)}</span>` : `<a class="key" href="${escape(ticket.url)}">${escape(key)}</a>`;
  const pick: Control = { label: 'Pick', icon: 'pass-filled', message: { type: 'action', action: { type: 'pick', ticketId: ticket.id } } };
  const again: Control = { label: 'Triage again', icon: 'search', message: { type: 'action', action: { type: 'retriage-pool', ticketId: ticket.id } } };
  const failed = triage?.error != null;
  const summary = triage === null || triage.endedAt === null ? 'Triaging…' : failed ? '' : (triage.summary ?? '');
  const [main, ...others] = failed ? [again, pick, iceboxControl(ticket.id, ticket.iceboxed)] : [pick, iceboxControl(ticket.id, ticket.iceboxed)];

  return `<div class="item pool-item" data-ticket="${ticket.id}">
<div class="line"><span class="mark">${priorityDot(triage)}</span> ${link} <span class="title" title="${escape(ticket.title)}">${escape(ticket.title)}</span> ${returned(entry.returned)}${queued(ticket.sortAt, now)}<span class="playbook-name">${escape(triage?.playbook ?? '')}</span></div>
<div class="line second">${failed ? `<span class="note">${escape(triage!.error!)}</span>` : `<span class="summary">${escape(summary)}</span>`}<span class="actions">${button(main!)}${moreMenu(menuKey, others, '', ui.menu === menuKey)}</span></div>
</div>`;
}

/** What the operator changed in the panel: expanded rows, opened or closed groups, and the open ... menu. */
export interface PanelUi {
  expanded: ReadonlySet<number>;
  /** Groups the operator opened or closed; others take their default. */
  groups: ReadonlyMap<string, boolean>;
  menu: string | null;
}

/** Needs you, Working and Pool start open; Done and Icebox start closed. */
const OPEN_BY_DEFAULT = new Set(['needs', 'working', 'pool']);

function group(key: string, title: string, count: number, body: string, ui: PanelUi): string {
  const open = ui.groups.get(key) ?? OPEN_BY_DEFAULT.has(key);

  return `<details class="group" data-group="${key}"${open ? ' open' : ''}><summary><h3>${escape(title)} (${count})</h3></summary>${body}</details>`;
}

/** The whole panel. */
export function renderPanel(snapshot: Snapshot, now: number, ui: PanelUi): string {
  const groups: Record<Group, WorkItemView[]> = { needs: [], working: [], done: [] };
  const iceboxedItems = snapshot.workItems.filter((item) => item.ticket.iceboxed);
  const iceboxedPool = snapshot.pool.filter((entry) => entry.ticket.iceboxed);
  const pool = snapshot.pool.filter((entry) => !entry.ticket.iceboxed);

  for (const item of snapshot.workItems) {
    if (!iceboxedItems.includes(item)) {
      groups[groupOf(item)].push(item);
    }
  }

  const list = (items: WorkItemView[]) => items.map((item) => row(item, snapshot, now, ui)).join('\n');
  const pooled = (entries: PoolView[]) => entries.map((entry) => poolRow(entry, now, ui)).join('\n');
  const iceboxCount = iceboxedItems.length + iceboxedPool.length;

  return `${errors(snapshot)}${setup(snapshot)}
${group('needs', 'Needs you', groups.needs.length, list(groups.needs) || '<p class="empty">Nothing needs you.</p>', ui)}
${group('working', 'Working', groups.working.length, list(groups.working) || '<p class="empty">Nothing is running.</p>', ui)}
${group('done', 'Done', groups.done.length, list(groups.done), ui)}
${pool.length === 0 ? '' : group('pool', 'Pool', pool.length, pooled(pool), ui)}
${iceboxCount === 0 ? '' : group('icebox', 'Icebox', iceboxCount, `${list(iceboxedItems)}${pooled(iceboxedPool)}`, ui)}`;
}
