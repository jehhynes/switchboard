// The web page's History tab (architecture.md § Web page): the ticket's head, the session's state pinned at the head of one timeline, and the
// ticket's activity with every state a session wrote (PRD R59, R98), from the views the hub builds, drawn by the page's own code.
import type { VNode } from 'preact';
import type { HistoryCategory, HistoryEntry, HistoryLink, HistorySection, HistoryView, PageRow, StateView } from '@switchboard/protocol';
import { stripQuestionMarkup } from '@switchboard/conversation/questions';
import { UnreadDot } from './header.js';
import { SourceLogo } from './listHeader.js';
import { renderMarkdown } from './markdown.js';
import { ago } from './render.js';
import { trusted } from './trusted.js';

/** What the operator set in a ticket's History while the page is open: hidden chips, the filter, opened or closed groups, expanded runs and state bodies. */
export interface HistoryUi {
  hidden: string[];
  query: string;
  /** Groups the operator opened or closed; the rest follow the default, which opens only the open work item's, else the first. */
  sections: Record<string, boolean>;
  /** Runs of state changes the operator expanded, by their newest entry's key. */
  runs: string[];
  /** State bodies the operator opened or closed, by entry key; the rest follow the default, which opens the newest `OPEN_BODIES`. */
  bodies: Record<string, boolean>;
  /** Whether a narrow pane shows the filter chips. */
  chips: boolean;
}

export const EMPTY_HISTORY_UI: HistoryUi = { hidden: [], query: '', sections: {}, runs: [], bodies: {}, chips: false };

/** The History the page shows: its ticket, the hub's view and chips once read, why the last read failed, and the operator's settings. */
export interface HistoryOpen {
  ticketId: number;
  key: string;
  view: HistoryView | null;
  categories: HistoryCategory[];
  error: string | null;
  ui: HistoryUi;
}

/**
 * What the page knows of the open work item before History loads, so the head shows at once: the key, title, source and playbook from its row
 * and scope, its mark as the status, whether it waits on the operator (`needsYou`), and the scoped work item and session.
 */
export interface HistoryHead {
  key: string;
  title: string;
  sourceKind: string | null;
  playbook: string | null;
  status: string | null;
  needsYou: string | null;
  workItemId: number | null;
  sessionId: string | null;
}

/** More consecutive session state changes than this collapse into one row. */
export const RUN_LIMIT = 5;
/** The newest states show their body; older ones keep it behind Details. */
export const OPEN_BODIES = 3;

const two = (value: number): string => String(value).padStart(2, '0');

/** A time of day such as `09:05`. */
function clock(time: number): string {
  const date = new Date(time);

  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** A local time such as `2026-10-07 14:02:30`, for an entry's tooltip. */
function stamp(time: number): string {
  const date = new Date(time);

  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${clock(time)}:${two(date.getSeconds())}`;
}

function dayKey(time: number): string {
  const date = new Date(time);

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** A day heading: Today, Yesterday, else the date. */
function dayText(time: number, now: number): string {
  if (dayKey(time) === dayKey(now)) {
    return 'Today';
  }

  const yesterday = new Date(now);

  yesterday.setDate(yesterday.getDate() - 1);
  return dayKey(time) === dayKey(yesterday.getTime())
    ? 'Yesterday'
    : new Date(time).toLocaleDateString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
}

/** Whether an entry passes the chips and the filter text. */
export function entryShown(entry: HistoryEntry, ui: HistoryUi): boolean {
  if (ui.hidden.includes(entry.category)) {
    return false;
  }

  const query = ui.query.trim().toLowerCase();

  return (
    query === '' ||
    [entry.text, entry.body ?? '', entry.detail ?? '', entry.refused ?? '', entry.shortId ?? '', ...entry.lines, ...entry.links.map((link) => link.label)].some(
      (text) => text.toLowerCase().includes(query),
    )
  );
}

/**
 * What the row says the operator must do, for the head's pill (PRD R98 head): a question or permission prompt the session waits on, an approval,
 * or waiting questions; null otherwise, so the pill shows the work item's status and never asserts that the session is working.
 */
export function needsYou(row: Pick<PageRow, 'mark' | 'questions'> | null): string | null {
  const kind = row?.mark?.kind;
  const questions = row?.questions ?? 0;

  return kind === 'question'
    ? 'a question'
    : kind === 'permission'
      ? 'permission prompt'
      : kind === 'send' || kind === 'review'
        ? 'approval'
        : questions > 0
          ? `${questions} ${questions === 1 ? 'question' : 'questions'}`
          : null;
}

/** The URL a link opens on the page: an http or https `openUrl`; null for anything else. */
export function historyUrl(link: HistoryLink): string | null {
  return link.open.type === 'openUrl' && typeof link.open.url === 'string' && /^https?:\/\//i.test(link.open.url) ? link.open.url : null;
}

/**
 * What a link's button carries, as its `data-` attributes: an http or https URL opens in a browser tab, another `openUrl` in a file tab, a folder
 * with Open in VS Code, and a session in the conversation by its work item and Switchboard session ID; null for a link the page cannot open.
 */
export function historyAction(link: HistoryLink): Record<string, string> | null {
  const url = historyUrl(link);
  const { open } = link;

  if (url !== null) {
    return {
      'data-action': 'history-open',
      'data-url': url,
      'data-label': link.label,
    };
  }

  if (open.type === 'openUrl' && typeof open.url === 'string' && open.url !== '') {
    return { 'data-action': 'history-file', 'data-path': open.url };
  }

  if (open.type === 'openFolder') {
    return { 'data-action': 'history-folder' };
  }

  if (open.type === 'open' && Number.isInteger(open['workItemId']) && typeof open['session'] === 'string') {
    return {
      'data-action': 'history-session',
      'data-work-item': String(open['workItemId']),
      'data-session': open['session'],
    };
  }

  return null;
}

/** A link: a button that opens it on the page, or, for one the page cannot open, its label with its target in the tooltip. */
function Link({ link }: { link: HistoryLink }) {
  const action = historyAction(link);
  // A session shows in the conversation here, not in the terminal or the panel the hub's label names.
  const label = action?.['data-action'] === 'history-session' ? 'Show session' : link.label;
  const title =
    action?.['data-action'] === 'history-folder'
      ? `${link.title}\nOpens the work item in VS Code.`
      : action?.['data-action'] === 'history-session'
        ? `${link.title}\nShows the session here.`
        : link.title;

  return action === null ? (
    <span class="hist-link off" title={link.title}>
      <span class={`codicon codicon-${link.icon}`} aria-hidden="true"></span>
      {link.label}
    </span>
  ) : (
    <button type="button" class="hist-link" {...action} title={title}>
      <span class={`codicon codicon-${link.icon}`} aria-hidden="true"></span>
      {label}
    </button>
  );
}

/** A shown item of a group's timeline: a day heading, an entry, or a run of state changes. */
type Item =
  | { kind: 'day'; key: string; text: string }
  | { kind: 'entry'; entry: HistoryEntry; body: 'open' | 'closed' | null }
  | { kind: 'run'; key: string; entries: HistoryEntry[] };

interface Group {
  section: HistorySection;
  /** The open work item's group, which holds the pinned state. */
  own: boolean;
  open: boolean;
  shown: number;
  total: number;
  items: Item[];
  /** The newest state's headline, for a closed group's summary. */
  lastState: string | null;
}

/**
 * The timeline's groups as the page draws them, newest first: each group's entries that pass the filter, less the pinned state's reply entry,
 * with day headings, runs of more than `RUN_LIMIT` state changes and which state bodies show.
 */
export function historyGroups(view: HistoryView, ui: HistoryUi, head: HistoryHead, pinned: string | null, now: number): Group[] {
  const hasOwn = view.sections.some((section) => section.workItemId !== null && section.workItemId === head.workItemId);
  let bodies = 0;

  // The open work item's group comes first, so the pinned state heads the timeline whichever work item is open.
  const sections = hasOwn ? [...view.sections].sort((a, b) => Number(b.workItemId === head.workItemId) - Number(a.workItemId === head.workItemId)) : view.sections;

  return sections.map((section, index) => {
    const own = hasOwn ? section.workItemId === head.workItemId : false;
    const open = ui.sections[section.key] ?? (hasOwn ? own : index === 0);
    const all = section.entries.filter((entry) => !(entry.stateId !== null && entry.stateId === pinned && !entry.stage));
    const entries = all.filter((entry) => entryShown(entry, ui)).reverse();
    const items: Item[] = [];
    let lastDay = '';

    for (let index = 0; index < entries.length;) {
      const entry = entries[index]!;
      let end = index;

      while (end < entries.length && entries[end]!.stateChange) {
        end++;
      }

      if (dayKey(entry.at) !== lastDay) {
        lastDay = dayKey(entry.at);
        items.push({
          kind: 'day',
          key: `day:${lastDay}`,
          text: dayText(entry.at, now),
        });
      }

      if (end - index > RUN_LIMIT) {
        items.push({
          kind: 'run',
          key: entry.key,
          entries: entries.slice(index, end),
        });
        index = end;
        continue;
      }

      const hasBody = entry.category === 'state' && entry.body !== null && !(entry.stage && entry.stateId === pinned);
      const byDefault = hasBody && open && bodies++ < OPEN_BODIES;

      items.push({
        kind: 'entry',
        entry,
        body: !hasBody ? null : (ui.bodies[entry.key] ?? byDefault) ? 'open' : 'closed',
      });
      index++;
    }

    const newest = [...section.entries].reverse().find((entry) => entry.category === 'state');

    return {
      section,
      own,
      open,
      shown: entries.length,
      total: all.length,
      items,
      lastState: newest?.text ?? null,
    };
  });
}

/**
 * What Expand all opens: every group, run and state body behind Details, whatever the chips and filter hide now, so clearing them later shows
 * every body and run as Expand all or Collapse all left it.
 */
export function expandable(view: HistoryView, ui: HistoryUi, head: HistoryHead, pinned: string | null, now: number): HistoryUi {
  const sections = Object.fromEntries(view.sections.map((section) => [section.key, true]));
  const items = [...historyGroups(view, { ...ui, sections }, head, pinned, now), ...historyGroups(view, { ...ui, sections, hidden: [], query: '' }, head, pinned, now)].flatMap((group) => group.items);

  return {
    ...ui,
    sections,
    runs: [...new Set(items.flatMap((item) => (item.kind === 'run' ? [item.key] : [])))],
    bodies: Object.fromEntries(items.flatMap((item) => (item.kind === 'entry' && item.body !== null ? [[item.entry.key, true]] : []))),
  };
}

function Markdown({ text, class: name }: { text: string; class: string }) {
  return <div class={`${name} md-doc body`}>{trusted(renderMarkdown(stripQuestionMarkup(text)))}</div>;
}

function Entry({ entry, body, pinned, ui }: { entry: HistoryEntry; body: 'open' | 'closed' | null; pinned: boolean; ui: HistoryUi }) {
  const classes = [
    'hist-entry',
    `cat-${entry.category}`,
    entry.tone === null ? '' : `tone-${entry.tone}`,
    entry.reconstructed ? 'reconstructed' : '',
    entry.refused === null ? '' : 'refused',
    pinned ? 'pinned-stage' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const details = [entry.refused, entry.detail].filter((text): text is string => text !== null && text !== '');
  // The pinned state's stage entry keeps its attribution and details, named as the report it was: its headline shows in the pinned state.
  const text = pinned ? 'Stage report' : entry.text;

  return (
    <li class={classes} data-entry={entry.key}>
      <time dateTime={new Date(entry.at).toISOString()} title={stamp(entry.at)}>
        {clock(entry.at)}
      </time>
      <span class="hist-dot">
        <span class={`codicon codicon-${entry.icon}`} aria-hidden="true"></span>
      </span>
      <div class="hist-entry-body">
        <div class="hist-text">
          <span class="hist-words">{text}</span>
          {entry.stage && !pinned ? <span class="hist-tag">stage report</span> : null}
          {entry.shortId === null || text.includes(entry.shortId) ? null : (
            <span class="hist-sid" title={`Session ${entry.shortId}`}>
              {entry.shortId}
            </span>
          )}
          {entry.reconstructed ? (
            <span class="hist-mark" title="Time estimated: History began after this happened">
              ≈ reconstructed
            </span>
          ) : null}
          {entry.refused === null ? null : <span class="hist-mark refused-mark">refused</span>}
        </div>
        {details.map((one) => (
          <div class="hist-detail">{one}</div>
        ))}
        {entry.lines.length === 0 ? null : (
          <ul class="hist-lines">
            {entry.lines.map((line) => (
              <li>{line}</li>
            ))}
          </ul>
        )}
        {body !== null && entry.body !== null ? (
          <details class="hist-more" data-body={entry.key} open={body === 'open'}>
            <summary>Details</summary>
            <Markdown class="hist-state-body" text={entry.body} />
          </details>
        ) : null}
        {entry.links.length === 0 ? null : (
          <div class="hist-entry-links">
            {entry.links.map((link) => (
              <Link link={link} />
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function Items({ items, ui, pinned }: { items: Item[]; ui: HistoryUi; pinned: string | null }) {
  return (
    <>
      {items.map((item) =>
        item.kind === 'day' ? (
          <li class="hist-day" key={item.key}>
            {item.text}
          </li>
        ) : item.kind === 'run' ? (
          <li class="hist-run" key={`run:${item.key}`}>
            <details data-run={item.key} open={ui.runs.includes(item.key)}>
              <summary>
                <span class="codicon codicon-chevron-right" aria-hidden="true"></span>
                {`${item.entries.length} session state changes, ${clock(item.entries.at(-1)!.at)} to ${clock(item.entries[0]!.at)}`}
              </summary>
              <ol class="hist-timeline">
                {item.entries.map((entry) => (
                  <Entry key={`entry:${entry.key}`} entry={entry} body={null} pinned={false} ui={ui} />
                ))}
              </ol>
            </details>
          </li>
        ) : (
          <Entry
            key={`entry:${item.entry.key}`}
            entry={item.entry}
            body={item.body}
            pinned={item.entry.stage && item.entry.stateId !== null && item.entry.stateId === pinned}
            ui={ui}
          />
        ),
      )}
    </>
  );
}

/**
 * The pinned state (architecture.md § States), the head of the timeline's rail: Now while current, As of the last turn once its turn ended, Last
 * state once its session ended or with none; another session's names it. Its box spans the timeline, its time and dot on the rail. Only it
 * carries `data-unread`, so only it reports seen.
 */
function Pinned({ state, head, now }: { state: StateView | null; head: HistoryHead; now: number }) {
  if (state === null) {
    return (
      <li class="hist-now empty" key="now">
        <div class="hist-now-card">
          <div class="hist-now-top">
            <span></span>
            <span class="hist-dot">
              <span class="codicon codicon-pulse" aria-hidden="true"></span>
            </span>
            <p class="hist-now-none">No state yet. It appears here when the session sets one.</p>
          </div>
        </div>
      </li>
    );
  }

  const label = state.stale === 'session' ? 'Last state' : state.stale === 'turn' ? 'As of the last turn' : 'Now';
  const short = state.shortId ?? null;
  const other = state.sessionId !== null && head.sessionId !== null && state.sessionId !== head.sessionId;
  const sub =
    state.sessionId === null
      ? `State from ${ago(state.at, now)}`
      : other
        ? `From session ${short ?? 'another session'} · ${ago(state.at, now)}`
        : state.stale === 'session' && state.endedAt != null
          ? `Session ${short ?? ''} ended ${clock(state.endedAt)} · state from ${ago(state.at, now)}`.replace('Session  ended', 'The session ended')
          : `State from session ${short ?? ''} · ${ago(state.at, now)}`.replace('session  ·', 'the session ·');

  return (
    <li
      class={`hist-now${state.stale === null ? '' : ' stale'}${state.unread ? ' unread' : ''}`}
      key="now"
      data-unread={state.unread ? state.id : undefined}
      data-state={state.id}
    >
      <div class="hist-now-card">
        <div class="hist-now-top">
          <time dateTime={new Date(state.at).toISOString()} title={stamp(state.at)}>
            {clock(state.at)}
          </time>
          <span class="hist-dot">
            <span class="codicon codicon-pulse" aria-hidden="true"></span>
          </span>
          <div class="hist-now-head">
            <span class="hist-now-label">{label}</span>
            <span class="hist-now-sub">{sub}</span>
            {state.unread ? <UnreadDot /> : null}
          </div>
        </div>
        <h3 class="hist-now-headline">{state.headline}</h3>
        {state.body === null ? null : <Markdown class="hist-now-body" text={state.body} />}
      </div>
    </li>
  );
}

function GroupHead({ group }: { group: Group }) {
  const { section } = group;
  const facts = [...section.facts];
  const filtering = group.shown < group.total;

  if (!group.open && group.lastState !== null) {
    facts.push(`Last state: ${group.lastState}`);
  }

  if (filtering) {
    facts.push(`${group.shown} of ${group.total} match`);
  } else if (!group.open) {
    facts.push(`${group.total} ${group.total === 1 ? 'entry' : 'entries'}`);
  }

  return (
    <div class="hist-group-head">
      <h2>
        <button type="button" class="hist-group-toggle" data-action="history-section" data-section={section.key} aria-expanded={group.open}>
          <span class={`codicon codicon-chevron-${group.open ? 'down' : 'right'}`} aria-hidden="true"></span>
          <span class="hist-group-title">{section.title}</span>
          {group.own || section.status === '' ? null : <span class={`hist-pill${section.tone === null ? '' : ` tone-${section.tone}`}`}>{section.status}</span>}
        </button>
      </h2>
      {facts.length === 0 ? null : <p class="hist-group-facts">{facts.join(' · ')}</p>}
    </div>
  );
}

/**
 * The page's History tab (PRD R59, R98): the head (key, repository, links, the title as the page's `h1`, and one line with the status or
 * waiting-on-you pill, the playbook and the summary), the timeline's toolbar (the filter, Expand all and Collapse all, then the chips under them), then the work items as
 * groups of one timeline, newest first, the open work item's first with the pinned state at the head of its rail. The head shows from what the
 * page holds before History loads, after a failed read and for a row with no ticket History.
 */
export function renderHistory(open: HistoryOpen | null, state: StateView | null, now: number, head: HistoryHead): VNode {
  const view = open?.view ?? null;
  const ui = open?.ui ?? EMPTY_HISTORY_UI;
  const pinnedId = state?.id ?? null;
  const groups = view === null ? [] : historyGroups(view, ui, head, pinnedId, now);
  const own = groups.find((group) => group.own);
  const status = own?.section.status ?? view?.status ?? head.status;
  const tone = own?.section.tone ?? view?.tone ?? null;
  const playbook = own?.section.title ?? head.playbook ?? view?.playbook ?? null;
  const key = view?.key ?? open?.key ?? head.key;
  const title = view?.title ?? head.title;
  // A pool ticket has no work item, so no state.
  const pinned = head.workItemId === null ? null : <Pinned state={state} head={head} now={now} />;
  const pill =
    head.needsYou !== null ? (
      <span class="hist-pill tone-warning hist-needs-you">
        <span class="codicon codicon-debug-pause" aria-hidden="true"></span>
        {`Waiting on you · ${head.needsYou}`}
      </span>
    ) : status === null || status === '' ? null : (
      <span class={`hist-pill${tone === null ? '' : ` tone-${tone}`}`}>
        <span class="codicon codicon-circle-filled" aria-hidden="true"></span>
        {status}
      </span>
    );

  return (
    <section class="history-view hist-body" aria-label={`${key} History`}>
      <header class="hist-head">
        <div class="hist-head-top">
          <span class="hist-key">
            {head.sourceKind === null ? null : <SourceLogo kind={head.sourceKind} enabled={true} />}
            {key}
          </span>
          {view?.repo == null ? null : <span class="hist-repo">{view.repo}</span>}
          {view === null || view.links.length === 0 ? null : (
            <span class="hist-head-links">
              {view.links.map((link) => (
                <Link link={link} />
              ))}
            </span>
          )}
        </div>
        <h1>{title}</h1>
        <div class="hist-meta">
          {pill}
          {playbook === null ? null : <span class="hist-playbook">{playbook}</span>}
          {(view?.facts ?? []).map((fact) => (
            <span>{fact}</span>
          ))}
        </div>
      </header>
      {open?.error == null ? null : (
        <p class="hist-error" role="alert">
          <span class="codicon codicon-error" aria-hidden="true"></span>
          {open.error}
        </p>
      )}
      {view === null ? (
        <>
          {pinned === null ? null : <ol class="hist-timeline hist-pinned">{pinned}</ol>}
          {open === null ? (
            <p class="hist-empty">No History for this work item. It shows for a work item with a ticket.</p>
          ) : open.error === null ? (
            <p class="hist-empty">Loading…</p>
          ) : null}
        </>
      ) : (
        <>
          <div class="hist-toolbar">
            <h2 class="hist-tl-title">
              Timeline <span class="hist-order">Newest first</span>
            </h2>
            <div class={`hist-tools${ui.chips ? ' chips-open' : ''}`}>
              {/* The filter has a line of its own, and the chips wrap on the lines under it, so neither covers the other at any width (the operator's
                  decision, 2026-11-26). A narrow pane folds the chips behind Filters, so a phone's first screen still holds the pinned state. */}
              <span class="hist-find">
                <label class="hist-filter-box">
                  <span class="codicon codicon-search" aria-hidden="true"></span>
                  <input
                    type="search"
                    class="hist-filter"
                    placeholder="Filter"
                    aria-label="Filter the timeline"
                    value={ui.query}
                    autocomplete="off"
                    spellcheck={false}
                  />
                </label>
                <button type="button" class="icon" data-action="history-all" data-all="open" title="Expand all" aria-label="Expand all">
                  <span class="codicon codicon-expand-all" aria-hidden="true"></span>
                </button>
                <button type="button" class="icon" data-action="history-all" data-all="close" title="Collapse all" aria-label="Collapse all">
                  <span class="codicon codicon-collapse-all" aria-hidden="true"></span>
                </button>
              </span>
              <button
                type="button"
                class={`hist-chips-toggle${ui.hidden.length > 0 ? ' filtered' : ''}`}
                data-action="history-chips"
                aria-expanded={ui.chips}
                title={ui.hidden.length > 0 ? `${ui.hidden.length} hidden` : 'Show the filter chips'}
              >
                <span class="codicon codicon-filter" aria-hidden="true"></span>
                <span>{ui.hidden.length > 0 ? `Filters · ${ui.hidden.length} hidden` : 'Filters'}</span>
              </button>
              {open!.categories.map(({ key: category, label, icon }) => {
                const on = !ui.hidden.includes(category);

                return (
                  <button type="button" class={`hist-chip${on ? ' on' : ''}`} data-action="history-chip" data-category={category} aria-pressed={on}>
                    <span class={`codicon codicon-${icon}`} aria-hidden="true"></span>
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {view.reconstructed && view.recordedSince !== null ? (
            <p class="hist-banner">
              <span class="codicon codicon-info" aria-hidden="true"></span>
              {`Switchboard began logging on ${stamp(view.recordedSince).slice(0, 16)}. Entries marked ≈ are estimated from times stored before then; anything else that happened earlier was not recorded.`}
            </p>
          ) : null}
          {own === undefined && pinned !== null ? <ol class="hist-timeline hist-pinned">{pinned}</ol> : null}
          {groups.map((group) => (
            <section class={`hist-group${group.own ? ' own' : ''}${group.open ? ' open' : ''}`} key={group.section.key} data-section={group.section.key}>
              <GroupHead group={group} />
              {group.open && group.section.prompt !== null ? (
                <div class="hist-prompt">
                  <div class="hist-prompt-label">Prompt</div>
                  <div class="hist-prompt-text">{group.section.prompt}</div>
                </div>
              ) : null}
              {group.own || group.open ? (
                <ol class="hist-timeline">
                  {group.own ? pinned : null}
                  {group.open ? <Items items={group.items} ui={ui} pinned={pinnedId} /> : null}
                </ol>
              ) : null}
              {group.open && group.shown === 0 ? (
                <p class="hist-empty">
                  {group.total === 0
                    ? 'Nothing recorded yet. Entries appear here as the work runs.'
                    : 'No entries match the filter. Clear it to see every entry.'}
                </p>
              ) : null}
            </section>
          ))}
        </>
      )}
    </section>
  );
}
