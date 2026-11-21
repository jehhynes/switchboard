import type { PaneLink, PaneModel, PaneText } from '../paneModel.js';

/** What a click in the pane asks the extension to do. */
export type PaneMessage = { type: 'ready' } | { type: 'open'; target: string } | { type: 'main'; key: string } | { type: 'dock' } | { type: 'talk-here' } | { type: 'size'; inner: number; outer: number; dpr: number };

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A pull request's review decision and checks as small codicons after its number, each named in the pill's tooltip. */
function pullRequestMarks(pr: PaneLink['pr']): string {
  if (pr === null) {
    return '';
  }

  const state = pr.state === 'merged' ? 'git-merge' : pr.state === 'closed' ? 'git-pull-request-closed' : pr.state === 'draft' ? 'git-pull-request-draft' : null;
  const review = pr.review === 'approved' ? 'pass' : pr.review === 'changes-requested' ? 'request-changes' : pr.review === 'pending' ? 'eye' : null;
  const checks = pr.checks === 'passing' ? 'check' : pr.checks === 'failing' ? 'error' : pr.checks === 'running' ? 'loading codicon-modifier-spin' : null;
  const mark = (name: string | null, kind: string): string => (name === null ? '' : `<span class="codicon codicon-${name} pr-${kind}" aria-hidden="true"></span>`);

  return `${mark(state, `state ${pr.state}`)}${mark(review, `review ${pr.review ?? ''}`)}${mark(checks, `checks ${pr.checks ?? ''}`)}`;
}

/** A line of text under an item's pills, with its tooltip. */
function line(className: string, text: PaneText, icon = ''): string {
  return `<div class="${className}"${text.title === null ? '' : ` title="${escape(text.title)}"`}>${icon}<span>${escape(text.text)}</span></div>`;
}

/**
 * The pane's HTML (PRD R92): a block per work item of this window, with its ticket pill in its source's colour, its links, a pull request with
 * its review and checks, the playbook and mark, its stage and its latest status's first line, its alerts, Report and its main control; then the
 * voice in this window. A window with no work item says so; nothing about other windows shows here.
 */
export function renderPane(model: PaneModel): string {
  const voice =
    model.voice === null
      ? ''
      : `<div class="voice" data-key="voice" title="${escape(model.voice.tooltip)}"><span class="codicon codicon-${escape(model.voice.icon)}" aria-hidden="true"></span><span class="voice-text">${escape(model.voice.text)}</span>${model.voice.talkHere ? '<button data-key="talk-here" data-talk-here="" title="Move the voice to this window">Talk here</button>' : ''}</div>`;

  if (model.items.length === 0) {
    return `<div class="idle" data-key="idle"><span>No work item in this window. Open one from the dock to see it here.</span></div>${voice}`;
  }

  return (
    model.items
      .map((item) => {
        const pills = item.links
          .map((link) => {
            const glyph = link.glyph === null ? '' : `<span class="codicon">${escape(link.glyph)}</span>`;
            const kind = `pill ${link.kind}${link.kind === 'ticket' ? ` source-${escape(item.sourceKind)}` : ''}${link.mentioned ? ' mentioned' : ''}`;
            const body = `${glyph}${escape(link.text)}${link.kind === 'pr' ? pullRequestMarks(link.pr) : ''}`;

            return link.url === null
              ? `<span class="${kind}" data-key="link:${escape(link.url ?? link.text)}" title="${escape(link.title)}">${body}</span>`
              : `<button class="${kind}" data-key="link:${escape(link.url ?? link.text)}" data-open="${escape(link.url)}" title="${escape(link.title)}" aria-label="${escape(link.title)}">${body}</button>`;
          })
          .join('');
        const playbook = `<span class="playbook"${item.mark === null ? '' : ` title="${escape(item.mark.title)}"`}>${item.mark === null ? '' : `<span class="codicon mark" aria-label="${escape(item.mark.title)}" role="img">${escape(item.mark.glyph)}</span>`}${escape(item.playbook)}</span>`;
        const unread = item.unread > 0 ? `<span class="unread-count" title="${item.unread === 1 ? '1 unread reply or status' : `${item.unread} unread replies and statuses`}">${item.unread}</span>` : '';
        const progress = item.progress.map((text) => line('progress', text)).join('');
        const status = item.status === null ? '' : line('status', { text: item.status, title: 'The latest status, on the Conversation view\'s Status tab' }, '<span class="codicon codicon-pulse" aria-hidden="true"></span>');
        const alerts = item.alerts.map((text) => line('alert', text, '<span class="codicon codicon-warning" aria-hidden="true"></span>')).join('');
        const report = item.report === null ? '' : `<button data-key="report" data-open="${escape(item.report)}" title="${escape(item.report)}"><span class="codicon codicon-file"></span>Report</button>`;
        const main =
          item.main === null
            ? ''
            : `<button class="main" data-key="main" data-main="${escape(item.key)}" title="${escape(item.main.title)}">${item.main.glyph === null ? '' : `<span class="codicon">${escape(item.main.glyph)}</span>`}${escape(item.main.label)}</button>`;
        const actions = report === '' && main === '' ? '' : `<div class="actions">${report}${main}</div>`;

        return `<section class="item${item.stripe === null ? '' : ` stripe-${item.stripe}`}" data-key="${escape(item.key)}"><div class="pills">${pills}${playbook}${unread}</div>${progress}${status}${alerts}${actions}</section>`;
      })
      .join('') + voice
  );
}

/** The message a click on `target` sends, or null for a click outside a button. */
export function clickMessage(target: Element | null): PaneMessage | null {
  const button = target?.closest('button');

  if (button === null || button === undefined) {
    return null;
  }

  if (button.dataset['open'] !== undefined) {
    return { type: 'open', target: button.dataset['open'] };
  }

  if (button.dataset['main'] !== undefined) {
    return { type: 'main', key: button.dataset['main'] };
  }

  if (button.dataset['talkHere'] !== undefined) {
    return { type: 'talk-here' };
  }

  return button.dataset['dock'] !== undefined ? { type: 'dock' } : null;
}
