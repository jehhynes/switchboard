import type { Session, WorkItem } from './model.js';

// Imports only types, so the panel webview and the Chrome extension can bundle it for a browser through `@switchboard/core/group`.

export type Group = 'needs' | 'working' | 'unstarted' | 'done';

export function activeSession<S extends Pick<Session, 'state'>>(item: { sessions: S[] }): S | null {
  return item.sessions.find((session) => session.state !== 'ended') ?? null;
}

/** PRD R27 checks Done first, then Unstarted, which includes triage in progress, then Needs you, then queued starts in Unstarted, then Working. */
export function groupOf(item: Pick<WorkItem, 'status'> & { sessions: Pick<Session, 'state'>[] }): Group {
  if (item.status === 'done') {
    return 'done';
  }

  if (item.status === 'unstarted' || item.status === 'triaging') {
    return 'unstarted';
  }

  if (item.status === 'awaiting-approval' || item.status === 'blocked' || item.status === 'failed' || activeSession(item)?.state === 'waiting') {
    return 'needs';
  }

  // A queued item waits for a slot, or for a live session of the same work item, which shows in Needs you while it asks a question.
  return item.status === 'queued' ? 'unstarted' : 'working';
}

/** The playbook slot during triage: the source's namespace and `triage`, such as `dev:triage`, or `triage` without one. */
export function triageLabel(source: string, namespaces: Record<string, string>): string {
  const namespace = namespaces[source] ?? '';

  return namespace === '' ? 'triage' : `${namespace}:triage`;
}

/**
 * A URL as Open in Switchboard compares it (PRD R69): a GitHub issue or pull request page, any tab such as `/files` included, as
 * `github.com/<owner>/<repo>/<issues|pull>/<number>` in lower case; any other URL as parsed, without a trailing slash.
 */
export function urlKey(url: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const match = parsed.hostname === 'github.com' ? /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/|$)/.exec(parsed.pathname) : null;

  return match === null ? parsed.href.replace(/\/$/, '') : `github.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`.toLowerCase();
}

/** A ticket on the browser endpoint's `GET /cards` (PRD R67). `url` is the ticket's URL as stored. */
export interface Card {
  url: string;
  /** The playbook the panel shows, `<namespace>:triage` during triage, or null before triage chooses one. */
  playbook: string | null;
  group: Group;
  snoozed: boolean;
  /** The URLs of the ticket's links (PRD R52), so a pull request page finds its ticket (PRD R69). A hub older than R69 sends none. */
  links?: string[];
}
