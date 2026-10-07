import type { HistoryTriage, TicketHistory } from '@switchboard/core';
import { DONE_WORDS, sourceLabel } from './webview/render.js';

type HistorySession = TicketHistory['workItems'][number]['sessions'][number];

/** The ticket's key as the panel shows it, such as `gh 18941`. */
export function historyKey(ticket: { source: string; sourceKey: string }): string {
  return `${sourceLabel(ticket.source)} ${ticket.sourceKey}`;
}

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

/** Reported and error texts on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function triageLine(triage: HistoryTriage): string {
  const result = triage.error !== null ? `failed, ${oneLine(triage.error)}` : (triage.playbook ?? (triage.endedAt === null ? 'running' : 'no playbook'));

  return `- ${timeText(triage.startedAt)}: ${result}`;
}

function sessionLine(session: HistorySession, now: number): string {
  const span = session.endedAt === null
    ? `${timeText(session.startedAt)}, not ended, ${durationText(now - session.startedAt)} so far`
    : `${timeText(session.startedAt)} to ${timeText(session.endedAt)}, ${durationText(session.endedAt - session.startedAt)}`;
  const detail = session.outcomeDetail === null ? '' : `, ${oneLine(session.outcomeDetail)}`;

  return `- ${session.kind}, ${span}: ${session.outcome ?? session.state}${detail}`;
}

/** The History document for a ticket (PRD R59): its work items newest first, each with its triages and sessions, then pool triages. */
export function historyMarkdown(history: TicketHistory, now: number): string {
  const { ticket } = history;
  const lines = [`# ${historyKey(ticket)} ${oneLine(ticket.title)}`, ''];

  if (ticket.url !== '') {
    lines.push(ticket.url, '');
  }

  lines.push(`As of ${timeText(now)}.`);

  if (history.workItems.length === 0) {
    lines.push('', 'No work items.');
  }

  for (const item of history.workItems) {
    const playbook = item.playbook ?? (ticket.source === 'adhoc' ? 'ad-hoc prompt' : 'no playbook');
    const status = item.status === 'done' && item.doneReason !== null ? `done, ${DONE_WORDS[item.doneReason].toLowerCase()}` : item.status;

    lines.push('', `## ${playbook} · ${status}`, '', `- Created ${timeText(item.createdAt)}`);

    if (item.doneAt !== null) {
      lines.push(`- Done ${timeText(item.doneAt)}`);
    }

    if (item.approvalSummary !== null) {
      lines.push(`- Approval: ${oneLine(item.approvalSummary)}`);
    }

    if (item.error !== null) {
      lines.push(`- Error: ${oneLine(item.error)}`);
    }

    if (item.triages.length > 0) {
      lines.push('', '### Triages', '', ...item.triages.map(triageLine));
    }

    lines.push('', '### Sessions', '', ...(item.sessions.length === 0 ? ['None.'] : item.sessions.map((session) => sessionLine(session, now))));
  }

  if (history.poolTriages.length > 0) {
    lines.push('', '## Pool triages', '', ...history.poolTriages.map(triageLine));
  }

  return `${lines.join('\n')}\n`;
}
