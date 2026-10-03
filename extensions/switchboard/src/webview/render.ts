import type { Snapshot, WorkItemView } from '@switchboard/hub';

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

const MARKS: Record<string, string> = {
  triaging: 'search',
  'awaiting-approval': 'question',
  queued: 'clock',
  setup: 'tools',
  running: 'play-circle',
  waiting: 'bell',
  blocked: 'debug-pause',
  failed: 'error',
  done: 'check',
};

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

/** The row's status in words; an active session waiting on the operator, or still running after done, says so. */
export function statusOf(item: WorkItemView): string {
  const session = activeSession(item);

  if (session?.state === 'waiting') {
    return 'Waiting on you';
  }

  return item.status === 'done' && session !== null ? `Done, session ${session.state}` : (STATUS_WORDS[item.status] ?? item.status);
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

  return controls;
}

/** Change playbook applies with no active session, to a work item that is not done and not ad-hoc. */
export function canChangePlaybook(item: WorkItemView): boolean {
  return item.status !== 'done' && item.ticket.source !== 'adhoc' && activeSession(item) === null;
}

function button(control: Control): string {
  return `<button class="control" title="${escape(control.label)}" data-message="${escape(JSON.stringify(control.message))}"><span class="codicon codicon-${control.icon}"></span> ${escape(control.label)}</button>`;
}

function section(title: string, body: string | null | undefined): string {
  return body ? `<h4>${escape(title)}</h4><pre>${escape(body)}</pre>` : '';
}

function row(item: WorkItemView, snapshot: Snapshot, now: number, expanded: boolean): string {
  const session = activeSession(item);
  const mark = session?.state === 'waiting' ? 'waiting' : item.status;
  const status = statusOf(item);
  const main = mainControl(item);
  const key = `${item.ticket.source} ${item.ticket.sourceKey}`;
  const ticket = item.ticket.url === '' ? escape(key) : `<a href="${escape(item.ticket.url)}">${escape(key)}</a>`;
  const stage = item.stage === null ? '' : `<span class="stage">${escape(item.stage)}${item.stageAt === null ? '' : ` · ${age(item.stageAt, now)}`}</span>`;
  const notes = [item.warning, item.error].filter((note): note is string => note !== null).map((note) => `<span class="note">${escape(note)}</span>`).join('');
  const worktree = item.worktree === null ? '' : `<span class="worktree" title="${escape(item.worktree.path)}"><span class="codicon codicon-git-branch"></span> ${escape(item.worktree.branch ?? item.worktree.path)}</span>`;
  const playbooks = canChangePlaybook(item)
    ? `<select class="playbook" data-item="${item.id}"><option value="">Change playbook…</option>${snapshot.playbooks
        .filter((playbook) => playbook.name !== item.playbook)
        .map((playbook) => `<option value="${escape(playbook.name)}" title="${escape(playbook.description)}">${escape(playbook.name)}</option>`)
        .join('')}</select>`
    : '';
  const history = item.sessions
    .map((entry) => `<li>${escape(entry.kind)} ${escape(entry.id)}: ${escape(entry.state)}${entry.outcome === null ? '' : `, ${escape(entry.outcome)}`}${entry.outcomeDetail === null ? '' : ` (${escape(entry.outcomeDetail)})`}, started ${age(entry.startedAt, now)} ago</li>`)
    .join('');

  return `<details class="item" data-item="${item.id}"${expanded ? ' open' : ''}>
<summary><span class="line"><span class="codicon codicon-${MARKS[mark] ?? 'circle-outline'}" title="${escape(status)}"></span> ${ticket} <span class="title" title="${escape(item.ticket.title)}">${escape(item.ticket.title)}</span> <span class="playbook-name">${escape(item.playbook ?? (item.ticket.source === 'adhoc' ? 'ad-hoc' : ''))}</span></span>
<span class="line second"><span class="status">${escape(status)}</span> ${stage} ${worktree}${main === null ? '' : button(main)}</span>${notes}</summary>
<div class="controls">${controlsOf(item).filter((control) => control.label !== main?.label).map(button).join('')}${playbooks}</div>
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

function adhocBox(snapshot: Snapshot): string {
  const repos = snapshot.repoRoots.map((root) => `<option value="${escape(root)}">${escape(root)}</option>`).join('');

  return `<form class="adhoc"><textarea name="prompt" rows="2" placeholder="Ad-hoc prompt for a new session"></textarea><div class="adhoc-row"><select name="repo">${repos}</select><button type="submit"${repos === '' ? ' disabled title="Set a repoRoot on a source to choose a repo."' : ''}><span class="codicon codicon-play"></span> Start</button></div></form>`;
}

/** The whole panel. `expanded` keeps the rows the operator opened. */
export function renderPanel(snapshot: Snapshot, now: number, expanded: ReadonlySet<number>, showDone: boolean): string {
  const groups: Record<Group, WorkItemView[]> = { needs: [], working: [], done: [] };

  for (const item of snapshot.workItems) {
    groups[groupOf(item)].push(item);
  }

  const list = (items: WorkItemView[]) => items.map((item) => row(item, snapshot, now, expanded.has(item.id))).join('\n');

  return `${errors(snapshot)}${adhocBox(snapshot)}
<h3>Needs you (${groups.needs.length})</h3>${list(groups.needs) || '<p class="empty">Nothing needs you.</p>'}
<h3>Working (${groups.working.length})</h3>${list(groups.working) || '<p class="empty">Nothing is running.</p>'}
<details class="done"${showDone ? ' open' : ''}><summary><h3>Done (${groups.done.length})</h3></summary>${list(groups.done)}</details>`;
}
