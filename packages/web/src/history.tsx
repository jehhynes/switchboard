// The web page's History tab (architecture.md § Web page): a ticket's activity as the VS Code History tab shows it (PRD R59), from the view the
// hub builds, drawn by the page's own code.
import type { VNode } from 'preact';
import type { HistoryCategory, HistoryEntry, HistoryLink, HistorySection, HistoryView } from '@switchboard/protocol';

/** What the operator set in a ticket's History while the page is open: hidden chips, the filter, opened or closed sections, expanded runs. */
export interface HistoryUi {
  hidden: string[];
  query: string;
  /** Sections the operator opened or closed; the rest follow the default, which opens only the first. */
  sections: Record<string, boolean>;
  /** Runs of state changes the operator expanded, by their first entry's key. */
  runs: string[];
}

export const EMPTY_HISTORY_UI: HistoryUi = { hidden: [], query: '', sections: {}, runs: [] };

/** The History the page shows: its ticket, the hub's view and chips once read, why the last read failed, and the operator's settings. */
export interface HistoryOpen {
  ticketId: number;
  key: string;
  view: HistoryView | null;
  categories: HistoryCategory[];
  error: string | null;
  ui: HistoryUi;
}

/** More consecutive session state changes than this collapse into one row, as in the History tab. */
export const RUN_LIMIT = 5;
/** Gaps shorter than this are not shown. */
const GAP_MS = 60_000;

const two = (value: number): string => String(value).padStart(2, '0');

/** A time of day such as `09:05:30`. */
function clock(time: number): string {
  const date = new Date(time);

  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** A local time such as `2026-10-07 14:02:30`, for an entry's tooltip. */
function stamp(time: number): string {
  const date = new Date(time);

  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${clock(time)}`;
}

function dayKey(time: number): string {
  const date = new Date(time);

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** A gap such as `45s`, `12m`, `2h 5m` or `3d 4h`, as the History tab writes it. */
export function gapText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  return minutes < 1 ? `${seconds}s` : hours < 1 ? `${minutes}m` : days < 1 ? `${hours}h ${minutes % 60}m` : `${days}d ${hours % 24}h`;
}

/** Whether an entry passes the chips and the filter text, as in the History tab. */
export function entryShown(entry: HistoryEntry, ui: HistoryUi): boolean {
  if (ui.hidden.includes(entry.category)) {
    return false;
  }

  const query = ui.query.trim().toLowerCase();

  return query === '' || [entry.text, entry.detail ?? '', entry.refused ?? '', entry.shortId ?? '', ...entry.lines, ...entry.links.map((link) => link.label)].some((text) => text.toLowerCase().includes(query));
}

/** The URL a link opens on the page: an http or https `openUrl`; null for a session, a folder or a file, which open only from VS Code or the dock. */
export function historyUrl(link: HistoryLink): string | null {
  return link.open.type === 'openUrl' && typeof link.open.url === 'string' && /^https?:\/\//i.test(link.open.url) ? link.open.url : null;
}

/** A link: a button that opens its URL in a new tab, or, for what only VS Code or the dock opens, its label with why in the tooltip. */
function Link({ link }: { link: HistoryLink }) {
  const url = historyUrl(link);

  return url === null ? (
    <span class="hist-link off" title={`${link.title}\nOpen it from VS Code or the dock.`}>
      <span class={`codicon codicon-${link.icon}`} aria-hidden="true"></span>
      {link.label}
    </span>
  ) : (
    <button type="button" class="hist-link" data-action="history-open" data-url={url} title={link.title}>
      <span class={`codicon codicon-${link.icon}`} aria-hidden="true"></span>
      {link.label}
    </button>
  );
}

function Entry({ entry, gap }: { entry: HistoryEntry; gap: number | null }) {
  const classes = ['hist-entry', `cat-${entry.category}`, entry.tone === null ? '' : `tone-${entry.tone}`, entry.reconstructed ? 'reconstructed' : '', entry.refused === null ? '' : 'refused'].filter(Boolean).join(' ');
  const details = [entry.refused, entry.detail].filter((text): text is string => text !== null && text !== '');

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
          {entry.text}
          {entry.shortId === null || entry.text.includes(entry.shortId) ? null : (
            <span class="hist-sid" title={`Session ${entry.shortId}`}>
              {entry.shortId}
            </span>
          )}
          {entry.reconstructed ? (
            <span class="hist-mark" title="Rebuilt from a stored time; the log had not begun">
              ≈ reconstructed
            </span>
          ) : null}
          {entry.refused === null ? null : <span class="hist-mark refused-mark">refused</span>}
        </div>
        {details.map((text) => (
          <div class="hist-detail">{text}</div>
        ))}
        {entry.lines.length === 0 ? null : (
          <ul class="hist-lines">
            {entry.lines.map((line) => (
              <li>{line}</li>
            ))}
          </ul>
        )}
        {entry.links.length === 0 ? null : (
          <div class="hist-entry-links">
            {entry.links.map((link) => (
              <Link link={link} />
            ))}
          </div>
        )}
      </div>
      <span class="hist-gap">{gap === null || gap < GAP_MS ? '' : `+${gapText(gap)}`}</span>
    </li>
  );
}

/** A section's shown entries with day headings, gaps since the previous entry, and runs of more than `RUN_LIMIT` state changes collapsed. */
function timeline(entries: HistoryEntry[], ui: HistoryUi): VNode[] {
  const parts: VNode[] = [];
  let lastDay = '';
  let previous: number | null = null;

  for (let index = 0; index < entries.length; ) {
    const entry = entries[index]!;
    let end = index;

    while (end < entries.length && entries[end]!.stateChange) {
      end++;
    }

    if (dayKey(entry.at) !== lastDay) {
      lastDay = dayKey(entry.at);
      parts.push(
        <li class="hist-day" key={`day:${lastDay}`}>
          {new Date(entry.at).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
        </li>,
      );
    }

    if (end - index > RUN_LIMIT) {
      const run = entries.slice(index, end);
      const before = previous;

      parts.push(
        <li class="hist-run" key={`run:${entry.key}`}>
          <details data-run={entry.key} open={ui.runs.includes(entry.key)}>
            <summary>
              <span class="codicon codicon-pulse" aria-hidden="true"></span>
              {`${run.length} session state changes, ${clock(run[0]!.at)} to ${clock(run.at(-1)!.at)}`}
            </summary>
            <ol class="hist-timeline">
              {run.map((item, at) => (
                <Entry key={`entry:${item.key}`} entry={item} gap={at === 0 ? (before === null ? null : item.at - before) : item.at - run[at - 1]!.at} />
              ))}
            </ol>
          </details>
        </li>,
      );
      previous = run.at(-1)!.at;
      index = end;
      continue;
    }

    parts.push(<Entry key={`entry:${entry.key}`} entry={entry} gap={previous === null ? null : entry.at - previous} />);
    previous = entry.at;
    index++;
  }

  return parts;
}

function Section({ section, ui, open }: { section: HistorySection; ui: HistoryUi; open: boolean }) {
  const entries = section.entries.filter((entry) => entryShown(entry, ui));
  const count = entries.length < section.entries.length ? `${entries.length} of ${section.entries.length}` : String(section.entries.length);

  return (
    <details class="hist-section" data-section={section.key} open={open}>
      <summary>
        <span class="hist-section-title">{section.title}</span>
        {section.status === '' ? null : <span class={`hist-status${section.tone === null ? '' : ` tone-${section.tone}`}`}>{section.status}</span>}
        <span class="hist-count">{count}</span>
        <span class="hist-section-facts">{section.facts.join(' · ')}</span>
      </summary>
      {section.prompt === null ? null : (
        <div class="hist-prompt">
          <div class="hist-prompt-label">Prompt</div>
          <div class="hist-prompt-text">{section.prompt}</div>
        </div>
      )}
      {entries.length === 0 ? (
        <p class="hist-empty">{section.entries.length === 0 ? 'Nothing recorded yet. Entries appear here as the work runs.' : 'No entries match the filter. Clear it to see every entry.'}</p>
      ) : (
        <ol class="hist-timeline">{timeline(entries, ui)}</ol>
      )}
    </details>
  );
}

/**
 * The page's History tab (PRD R59), what the VS Code History tab shows: the ticket's key, title, facts and links; the category chips, the filter,
 * Expand all and Collapse all; the note on reconstructed entries; and a section per work item, newest first, then the ticket's, the first open.
 * Loading… until the hub answers, and why when it cannot.
 */
export function renderHistory(open: HistoryOpen): VNode {
  const { view, ui } = open;
  // The first section opens by default: the newest work item, or with none the ticket's.
  const opened = (section: HistorySection, index: number): boolean => ui.sections[section.key] ?? index === 0;

  return (
    <section class="history-view hist-body" aria-label={`${open.key} History`}>
      {open.error === null ? null : (
        <p class="hist-error" role="alert">
          <span class="codicon codicon-error" aria-hidden="true"></span>
          {open.error}
        </p>
      )}
      {view === null ? (
        open.error === null ? <p class="empty">Loading…</p> : null
      ) : (
        <>
          <div class="hist-hero">
            <div class="hist-headline">
              <span class="hist-key">{view.key}</span>
              <h1>{view.title}</h1>
            </div>
            <dl class="hist-facts">
              {view.facts.map((fact) => (
                <div>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
            {view.links.length === 0 ? null : (
              <div class="hist-hero-links">
                {view.links.map((link) => (
                  <Link link={link} />
                ))}
              </div>
            )}
          </div>
          <div class="hist-toolbar">
            <div class="hist-chips">
              {/* Chips are filters without counts: a category's entries spread over the sections, whose own counts the page shows. */}
              {open.categories.map(({ key, label, icon }) => {
                const on = !ui.hidden.includes(key);

                return (
                  <button type="button" class={`hist-chip${on ? ' on' : ''}`} data-action="history-chip" data-category={key} aria-pressed={on}>
                    <span class={`codicon codicon-${icon}`} aria-hidden="true"></span>
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
            <input type="search" class="hist-filter" placeholder="Filter entries" aria-label="Filter entries" value={ui.query} autocomplete="off" spellcheck={false} />
            <button type="button" class="icon" data-action="history-all" data-all="open" title="Expand all" aria-label="Expand all">
              <span class="codicon codicon-expand-all" aria-hidden="true"></span>
            </button>
            <button type="button" class="icon" data-action="history-all" data-all="close" title="Collapse all" aria-label="Collapse all">
              <span class="codicon codicon-collapse-all" aria-hidden="true"></span>
            </button>
          </div>
          {view.reconstructed && view.recordedSince !== null ? (
            <p class="hist-banner">
              <span class="codicon codicon-info" aria-hidden="true"></span>
              {`Switchboard began logging on ${stamp(view.recordedSince).slice(0, 16)}. Entries marked ≈ reconstructed were rebuilt from the times stored before then; anything else that happened earlier was not recorded.`}
            </p>
          ) : null}
          {view.sections.map((section, index) => (
            <Section key={section.key} section={section} ui={ui} open={opened(section, index)} />
          ))}
        </>
      )}
    </section>
  );
}
