import { CATEGORIES, durationText, timeText } from '@switchboard/hub/history';
import type { Category, Entry, EntryLink, HistoryView, Section } from '@switchboard/hub/history';

/** Text safe inside HTML text and quoted attributes. */
function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** What the operator set on the page; the webview keeps it across reloads. */
export interface HistoryUi {
  /** Categories hidden by their chip. */
  hidden: Category[];
  query: string;
  /** Sections the operator opened or closed; the rest follow the default, which opens only the newest. */
  sections: Record<string, boolean>;
  /** Runs of state changes the operator expanded, by their first entry's key. */
  runs: string[];
}

export const EMPTY_UI: HistoryUi = { hidden: [], query: '', sections: {}, runs: [] };

/** More consecutive session state changes than this collapse into one row. */
export const RUN_LIMIT = 5;

/** Gaps shorter than this are not shown. */
const GAP_MS = 60_000;

function clock(time: number): string {
  const date = new Date(time);
  const two = (value: number) => String(value).padStart(2, '0');

  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

function day(time: number): string {
  return new Date(time).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function dayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function linkButton(link: EntryLink, extra = ''): string {
  return `<button class="link${extra}" title="${escape(link.title)}" data-open="${escape(JSON.stringify(link.open))}"><span class="codicon codicon-${link.icon}"></span>${escape(link.label)}</button>`;
}

/** Whether the entry passes the chips and the search text. */
export function shown(entry: Entry, ui: HistoryUi): boolean {
  if (ui.hidden.includes(entry.category)) {
    return false;
  }

  const query = ui.query.trim().toLowerCase();

  return query === '' || [entry.text, entry.detail ?? '', entry.refused ?? '', entry.shortId ?? '', ...entry.lines, ...entry.links.map((link) => link.label)].some((text) => text.toLowerCase().includes(query));
}

function entryHtml(entry: Entry, gap: number | null): string {
  const classes = ['entry', `cat-${entry.category}`, entry.tone === null ? '' : `tone-${entry.tone}`, entry.reconstructed ? 'reconstructed' : '', entry.refused === null ? '' : 'refused'].filter(Boolean).join(' ');
  const marks = [
    entry.shortId === null || entry.text.includes(entry.shortId) ? '' : `<span class="sid" title="Session ${escape(entry.shortId)}">${escape(entry.shortId)}</span>`,
    entry.reconstructed ? '<span class="mark" title="Rebuilt from a stored time; the log had not begun">≈ reconstructed</span>' : '',
    entry.refused === null ? '' : '<span class="mark refused-mark">refused</span>',
  ].join('');
  const detail = [entry.refused, entry.detail].filter((text): text is string => text !== null && text !== '');

  return `<li class="${classes}" data-entry="${escape(entry.key)}" data-key="entry:${escape(entry.key)}">
<time datetime="${new Date(entry.at).toISOString()}" title="${escape(timeText(entry.at))}:${String(new Date(entry.at).getSeconds()).padStart(2, '0')}">${clock(entry.at)}</time>
<span class="dot"><span class="codicon codicon-${entry.icon}"></span></span>
<div class="body"><div class="text">${escape(entry.text)}${marks}</div>${detail.map((text) => `<div class="detail">${escape(text)}</div>`).join('')}${
    entry.lines.length === 0 ? '' : `<ul class="lines">${entry.lines.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>`
  }${entry.links.length === 0 ? '' : `<div class="entry-links">${entry.links.map((link) => linkButton(link)).join('')}</div>`}</div>
<span class="gap">${gap === null || gap < GAP_MS ? '' : `+${durationText(gap)}`}</span>
</li>`;
}

/** A section's visible entries with day headings, gaps since the previous entry, and long runs of state changes collapsed. */
function timeline(entries: Entry[], ui: HistoryUi): string {
  const parts: string[] = [];
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
      parts.push(`<li class="day" data-key="day:${lastDay}">${escape(day(entry.at))}</li>`);
    }

    if (end - index > RUN_LIMIT) {
      const run = entries.slice(index, end);
      const open = ui.runs.includes(entry.key);

      parts.push(
        `<li class="run" data-key="run:${escape(entry.key)}"><details data-run="${escape(entry.key)}"${open ? ' open' : ''}><summary><span class="codicon codicon-pulse"></span>${run.length} session state changes, ${clock(run[0]!.at)} to ${clock(run.at(-1)!.at)}</summary><ol class="timeline">${run
          .map((item, at) => entryHtml(item, at === 0 ? (previous === null ? null : item.at - previous) : item.at - run[at - 1]!.at))
          .join('')}</ol></details></li>`,
      );
      previous = run.at(-1)!.at;
      index = end;
      continue;
    }

    parts.push(entryHtml(entry, previous === null ? null : entry.at - previous));
    previous = entry.at;
    index++;
  }

  return parts.join('');
}

function sectionHtml(section: Section, ui: HistoryUi, open: boolean): string {
  const entries = section.entries.filter((entry) => shown(entry, ui));
  const filtered = entries.length < section.entries.length;
  const count = filtered ? `${entries.length} of ${section.entries.length}` : String(section.entries.length);

  return `<details class="section" data-section="${escape(section.key)}" data-key="section:${escape(section.key)}"${open ? ' open' : ''}>
<summary><span class="title">${escape(section.title)}</span>${section.status === '' ? '' : `<span class="status${section.tone === null ? '' : ` tone-${section.tone}`}">${escape(section.status)}</span>`}<span class="count">${escape(count)}</span><span class="facts">${section.facts.map(escape).join(' · ')}</span></summary>
${section.prompt === null ? '' : `<div class="prompt"><div class="label">Prompt</div><div class="text">${escape(section.prompt)}</div></div>`}
${entries.length === 0 ? `<p class="empty">${section.entries.length === 0 ? 'Nothing recorded yet. Entries appear here as the work runs.' : 'No entries match the filter. Clear it to see every entry.'}</p>` : `<ol class="timeline">${timeline(entries, ui)}</ol>`}
</details>`;
}

/** The History page (PRD R59). */
export function renderHistory(view: HistoryView, ui: HistoryUi): string {
  // Chips are filters without counts: a category's entries spread over the sections, whose own counts are what the page shows.
  const chips = CATEGORIES.map(({ key, label, icon }) => {
    const on = !ui.hidden.includes(key);
    return `<button class="chip${on ? ' on' : ''}" data-category="${key}" aria-pressed="${on}"><span class="codicon codicon-${icon}"></span>${label}</button>`;
  }).join('');
  const banner =
    view.reconstructed && view.recordedSince !== null
      ? `<p class="banner"><span class="codicon codicon-info"></span>Switchboard began logging on ${escape(timeText(view.recordedSince))}. Entries marked ≈ reconstructed were rebuilt from the times stored before then; anything else that happened earlier was not recorded.</p>`
      : '';
  // The newest work item opens by default; with none, the ticket section does.
  const opened = (section: Section, index: number) => ui.sections[section.key] ?? index === 0;

  return `<header class="hero">
<div class="headline"><span class="key">${escape(view.key)}</span><h1>${escape(view.title)}</h1></div>
<dl class="facts">${view.facts.map((fact) => `<div><dt>${escape(fact.label)}</dt><dd>${escape(fact.value)}</dd></div>`).join('')}</dl>
${view.links.length === 0 ? '' : `<div class="hero-links">${view.links.map((link) => linkButton(link)).join('')}</div>`}
</header>
<div class="toolbar"><div class="chips">${chips}</div><input id="search" type="search" placeholder="Filter entries" value="${escape(ui.query)}" aria-label="Filter entries"><button class="icon" data-all="open" title="Expand all"><span class="codicon codicon-expand-all"></span></button><button class="icon" data-all="close" title="Collapse all"><span class="codicon codicon-collapse-all"></span></button></div>
${banner}
${view.sections.map((section, index) => sectionHtml(section, ui, opened(section, index))).join('\n')}`;
}
