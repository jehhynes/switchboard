import { escape } from './markdown.js';
import { morph } from './morph.js';
import type { PageGroup, PageHeader, PageRow, SourceGroup } from './types.js';

type Answer = { status: number; body: Record<string, unknown> };

export interface ListHeaderDeps {
  /** Posts a page command with the page key, as the page's other commands do. */
  post(name: string, body: Record<string, unknown>): Promise<Answer>;
  /** Draws the page again after the header changed what it shows. */
  redraw(): void;
  /** Opens a work item's conversation, as a click on its row does. */
  select(workItemId: number): void;
  now(): number;
}

/** The search box searches once it holds this many characters (PRD R63), as the dock's. */
export const SEARCH_MINIMUM = 3;
/** And this long after the last key. */
export const SEARCH_DELAY_MS = 250;
/** The searched ranges, as the dock's range menu names them; the first is the Done list's two weeks, which the page has, the others ask the hub. */
export const RANGES = ['Last 2 weeks', 'Last month', 'Last 3 months', 'All time'] as const;

/** A key without `gh`, `PR` or `#`, in lower case, so `#107` and `PR #107` name the row whose key is `gh 107`. */
export function bareKey(key: string): string {
  let bare = key.trim().toLowerCase();

  for (const prefix of ['gh ', 'pr ']) {
    if (bare.startsWith(prefix)) {
      bare = bare.slice(prefix.length).trimStart();
    }
  }

  return bare.replace(/^#+/, '');
}

/** Whether the text is a number, or a shown row's ticket key or link key, older Done rows the hub found included, which the search takes at once rather than after the delay. */
export function isKey(text: string, groups: readonly PageGroup[]): boolean {
  const bare = bareKey(text);

  return (bare !== '' && /^[0-9]+$/.test(bare)) || groups.some((group) => group.rows.some((row) => bareKey(row.ticket) === bare || row.links.some((link) => bareKey(link.label) === bare)));
}

/** Whether a row's search text holds every word of the filter, ignoring case. */
export function matches(search: string, filter: string): boolean {
  const text = search.toLocaleLowerCase();

  return filter.toLocaleLowerCase().split(/\s+/).filter((word) => word !== '').every((word) => text.includes(word));
}

/** The epoch milliseconds a range searches from: a month or three months back, or 0 for all time. */
export function rangeSince(range: number, now: number): number {
  if (range >= RANGES.length - 1) {
    return 0;
  }

  // As .NET's AddMonths: a day the target month lacks becomes its last day, so March 31 less a month is February 28, not March 3.
  const since = new Date(now);
  const day = since.getDate();

  since.setDate(1);
  since.setMonth(since.getMonth() - (range === 1 ? 1 : 3));
  since.setDate(Math.min(day, new Date(since.getFullYear(), since.getMonth() + 1, 0).getDate()));
  return since.getTime();
}

/**
 * The list a search shows (PRD R63): Done's rows, then those the hub found before them, and in every group only the rows that match, groups with
 * none left out. Without a search, the list as it is.
 */
export function filterGroups(groups: readonly PageGroup[], filter: string, older: readonly PageRow[]): PageGroup[] {
  if (filter.trim() === '') {
    return [...groups];
  }

  return groups.flatMap((group) => {
    const listed = new Set(group.rows.map((row) => row.workItemId));
    const all = group.key === 'done' ? [...group.rows, ...older.filter((row) => !listed.has(row.workItemId))] : group.rows;
    const rows = all.filter((row) => matches(row.search ?? '', filter));

    return rows.length === 0 ? [] : [{ ...group, rows }];
  });
}

/** The search's state: the box, what it applied, its range, and the rows the hub found before the Done list. */
export interface SearchView {
  open: boolean;
  /** The box's text. */
  query: string;
  /** The text the list is filtered by; empty for none. */
  filter: string;
  /** An index of `RANGES`. */
  range: number;
  older: PageRow[];
  more: boolean;
  pending: boolean;
  error: string | null;
}

/**
 * Each source kind's logo, as the dock's header draws it (`SourceGithub`, `SourceZoho` and `SourceForum` in the dock's `App.axaml`): GitHub's
 * mark, Zoho Desk's outline and Forum's letters, each in the colour of its ticket pill, grey while the kind is off.
 */
const LOGOS: Record<string, { viewBox: string; path: string; stroke: boolean; evenOdd: boolean }> = {
  github: {
    viewBox: '0 0 24 24',
    stroke: false,
    evenOdd: false,
    path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  },
  zoho: {
    viewBox: '11 2 28 35',
    stroke: true,
    evenOdd: false,
    path: 'M12 36 L15 18 Q15.3 16 17.5 16 L29.5 16 Q31 16 31.2 14.5 L31.6 11.6 Q31.7 10.4 30.5 10.1 Q29 9.7 29 8.4 L29 5 Q29 3 31 3 L35.5 3 Q37.5 3 37.5 5 L37.5 17.5 L25 24.5 L20 20.5 M35.6 24 L34.6 30.5 Q34.3 32 32.6 32 L17.5 32L12 36',
  },
  forum: {
    viewBox: '0 0 335 185',
    stroke: false,
    evenOdd: true,
    path: 'M75 20H260V145H160L100 180V145H75Z M95 40V125H120V145L150 125H240V40Z',
  },
};

/** A source kind's logo, grey while off; a kind without one shows a tag, so its button is never blank. */
export function sourceLogo(kind: string, enabled: boolean): string {
  const logo = LOGOS[kind];
  const state = enabled ? '' : ' off';

  if (logo === undefined) {
    return `<span class="codicon codicon-tag source-logo${state}" aria-hidden="true"></span>`;
  }

  const paint = logo.stroke ? 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"' : `fill="currentColor"${logo.evenOdd ? ' fill-rule="evenodd"' : ''}`;

  return `<svg class="source-logo ${escape(kind)}${state}" viewBox="${logo.viewBox}" aria-hidden="true" focusable="false"><path ${paint} d="${logo.path}"/></svg>`;
}

/** A menu row's left gutter: a check mark for a checked row, or nothing, as the page's other menus draw it. */
function gutter(checked: boolean): string {
  return `<span class="menu-gutter" aria-hidden="true">${checked ? '<span class="codicon codicon-check"></span>' : ''}</span>`;
}

/** The providers a new session can start in, as the dock's provider box lists them. */
const PROVIDERS = [
  { provider: 'claude', name: 'Claude' },
  { provider: 'codex', name: 'Codex' },
];

/**
 * A sheet the header opens over the page: More Actions' New ad-hoc session, New conversation in a folder, or a dock window the page does not
 * have yet. `opId` stays the same for the sheet's retries, so the hub creates once.
 */
export type HeaderSheet =
  | { kind: 'adhoc'; opId: string; schedule: string; repo: string; provider: string; providerChosen: boolean; prompt: string; start: boolean; providerNote: string | null; busy: boolean; error: string | null }
  | { kind: 'folder'; opId: string; folder: string; provider: string; providerChosen: boolean; installed: string[] | null; busy: boolean; error: string | null }
  | { kind: 'later'; title: string };

/**
 * What the header has open: a source kind's menu (`source:<kind>`), the range menu (`range`), More Actions (`more`), or nothing; and a sheet over
 * the page.
 */
export interface HeaderView {
  menu: string | null;
  search: SearchView;
  sheet: HeaderSheet | null;
  /** A refusal the header's last action got, shown under it until dismissed or the next action. */
  notice: string | null;
}

/**
 * A source kind's header icon (PRD R3, R71), as the dock's: its logo, grey while every source of the kind is off, and the hub's tooltip. With one
 * source a click turns it on or off; with several it opens a menu with a check row per source, which stays open so several can change.
 */
function sourceButton(group: SourceGroup, view: HeaderView): string {
  const several = group.sources.length > 1;
  const name = several ? group.kind : (group.sources[0]?.name ?? group.kind);
  const open = view.menu === `source:${group.kind}`;
  const state = several ? `aria-haspopup="menu" aria-expanded="${open}"` : `aria-pressed="${group.enabled}"`;
  const menu =
    several && open
      ? `<ul class="glass menu source-menu" role="menu" aria-label="${escape(`${group.kind} sources`)}">${group.sources
          .map((one) => `<li role="none"><button type="button" class="menu-row" role="menuitemcheckbox" aria-checked="${one.enabled}" data-action="list-source-entry" data-source="${escape(one.name)}">${gutter(one.enabled)}<span class="title">${escape(one.name)}</span></button></li>`)
          .join('')}</ul>`
      : '';

  return `<div class="menu-anchor" data-key="source-${escape(group.kind)}"><button type="button" class="icon source-toggle" data-action="list-source" data-kind="${escape(group.kind)}" ${state} title="${escape(group.title)}" aria-label="${escape(name)}">${sourceLogo(group.kind, group.enabled)}</button>${menu}</div>`;
}

/**
 * The list's header (architecture.md § Web page), as the dock's title row: the title, which takes what is left and ends in an ellipsis, then
 * the source icons; a refusal shows under it.
 */
export function renderListHeader(header: PageHeader | null, view: HeaderView): string {
  const sources = header?.sources ?? [];
  const icons = sources.length === 0 ? '' : `<div class="header-sources">${sources.map((group) => sourceButton(group, view)).join('')}</div><span class="header-separator" aria-hidden="true"></span>`;
  const search = view.search;
  const searchButton = `<button type="button" class="icon search-toggle" data-action="list-search" aria-pressed="${search.open}" title="Search" aria-label="Search"><span class="codicon codicon-search" aria-hidden="true"></span></button>`;
  const rangeMenu =
    view.menu === 'range'
      ? `<ul class="glass menu range-menu" role="menu" aria-label="Search range">${RANGES.map((label, index) => `<li role="none"><button type="button" class="menu-row" role="menuitemradio" aria-checked="${index === search.range}" data-action="list-range-pick" data-range="${index}">${gutter(index === search.range)}<span class="title">${label}</span></button></li>`).join('')}</ul>`
      : '';
  // The box and the searched range under the title row while the search is open, as the dock's.
  const box = search.open
    ? `<div class="search-row"><div class="search-field"><input type="search" class="search-box" placeholder="Search title, key, PR, playbook, branch" aria-label="Search" value="${escape(search.query)}" autocomplete="off" spellcheck="false"><button type="button" class="icon" data-action="list-search-clear" title="Clear search" aria-label="Clear search"><span class="codicon codicon-close" aria-hidden="true"></span></button></div>` +
      `<div class="menu-anchor"><button type="button" class="search-range" data-action="list-range" aria-haspopup="menu" aria-expanded="${view.menu === 'range'}" title="Choose how far back to search" aria-label="Search range: ${RANGES[search.range]}"><span>${RANGES[search.range]}</span><span class="codicon codicon-chevron-down" aria-hidden="true"></span></button>${rangeMenu}</div></div>`
    : '';
  const notice =
    view.notice === null
      ? ''
      : `<p class="list-notice" role="alert"><span class="list-notice-text">${escape(view.notice)}</span><button type="button" class="icon dismiss" data-action="list-dismiss" title="Dismiss" aria-label="Dismiss"><span class="codicon codicon-close" aria-hidden="true"></span></button></p>`;

  const more = `<div class="menu-anchor" data-key="more"><button type="button" class="icon more-actions" data-action="list-more" aria-haspopup="menu" aria-expanded="${view.menu === 'more'}" title="More Actions…" aria-label="More Actions"><span class="codicon codicon-ellipsis" aria-hidden="true"></span></button>${view.menu === 'more' ? renderMoreMenu(header) : ''}</div>`;

  return `<div class="list-header"><span class="list-title">Switchboard</span>${icons}${searchButton}${more}</div>${box}${notice}`;
}

/** A More Actions row: its codicon in the gutter, as the dock's menu draws its glyph, then its label. */
function moreRow(action: string, icon: string, label: string): string {
  return `<li role="none"><button type="button" class="menu-row" role="menuitem" data-action="${action}"><span class="menu-gutter" aria-hidden="true"><span class="codicon codicon-${icon}"></span></span><span class="title">${label}</span></button></li>`;
}

const SEPARATOR = '<li class="menu-separator" role="separator"></li>';

/**
 * More Actions (PRD R71), in the dock's groups: New ad-hoc session… and New conversation in a folder…; Held sessions, and Ticket volume
 * report with a Zoho or Forum source; Refresh sources and Show hub log; then Open Settings. On a phone, where the header has no room for them,
 * the source icons come first as a check row per source.
 */
export function renderMoreMenu(header: PageHeader | null): string {
  const sources = (header?.sources ?? []).flatMap((group) =>
    group.sources.map((one) => `<li role="none" class="more-source"><button type="button" class="menu-row" role="menuitemcheckbox" aria-checked="${one.enabled}" data-action="list-source-entry" data-source="${escape(one.name)}">${gutter(one.enabled)}${sourceLogo(group.kind, one.enabled)}<span class="title">${escape(one.name)}</span></button></li>`),
  );
  const volume = (header?.sources ?? []).some((group) => group.kind === 'zoho' || group.kind === 'forum');
  const rows = [
    ...(sources.length === 0 ? [] : [...sources, SEPARATOR.replace('class="menu-separator"', 'class="menu-separator more-source"')]),
    moreRow('list-adhoc', 'add', 'New ad-hoc session…'),
    moreRow('list-folder', 'folder', 'New conversation in a folder…'),
    SEPARATOR,
    moreRow('list-later-held', 'terminal', 'Held sessions'),
    volume ? moreRow('list-later-volume', 'graph', 'Ticket volume report') : '',
    SEPARATOR,
    moreRow('list-poll', 'refresh', 'Refresh sources'),
    moreRow('list-later-log', 'output', 'Show hub log'),
    SEPARATOR,
    moreRow('list-later-settings', 'settings-gear', 'Open Settings'),
  ];

  return `<ul class="glass menu more-menu align-right" role="menu" aria-label="More Actions">${rows.join('')}</ul>`;
}

/** The dock windows More Actions opens that the page does not have yet, by their row's action. */
export const LATER: Record<string, string> = { 'list-later-held': 'Held sessions', 'list-later-volume': 'Ticket volume report', 'list-later-log': 'Show hub log', 'list-later-settings': 'Open Settings' };

/** A select's options, the chosen one selected. */
function options(items: ReadonlyArray<{ value: string; label: string }>, chosen: string): string {
  return items.map((item) => `<option value="${escape(item.value)}"${item.value === chosen ? ' selected' : ''}>${escape(item.label)}</option>`).join('');
}

/**
 * A sheet of the header (architecture.md § Web page), drawn as the page's other sheets: New ad-hoc session as the dock's window (Run, with the
 * schedules; Repository; Provider; Prompt; Start automatically), New conversation in a folder with the folder and, when both are installed, the
 * provider, or a dock window the page does not have yet.
 */
export function renderHeaderSheet(sheet: HeaderSheet | null, header: PageHeader | null): string {
  if (sheet === null) {
    return '';
  }

  const frame = (title: string, body: string, buttons: string): string =>
    `<div class="sheet-backdrop" data-action="list-sheet-cancel"><div class="sheet glass" role="dialog" aria-modal="true" aria-labelledby="list-sheet-title"><h2 id="list-sheet-title" class="sheet-title">${escape(title)}</h2>${body}<div class="sheet-buttons">${buttons}</div></div></div>`;

  if (sheet.kind === 'later') {
    return frame(sheet.title, `<p class="sheet-detail">${escape(sheet.title)} is not on the web page yet. Use it from the dock.</p>`, '<button type="button" class="sheet-button primary" data-action="list-sheet-cancel">Close</button>');
  }

  const busy = sheet.busy ? ' disabled' : '';
  const cancel = `<button type="button" class="sheet-button secondary" data-action="list-sheet-cancel"${busy}>Cancel</button>`;
  const error = sheet.error === null ? '' : `<p class="sheet-error" role="alert">${escape(sheet.error)}</p>`;
  const folders = header?.folders ?? [];

  if (sheet.kind === 'folder') {
    const choices = sheet.installed === null ? [] : PROVIDERS.filter((one) => sheet.installed!.length > 1 || sheet.installed!.includes(one.provider));
    const provider =
      sheet.installed === null
        ? '<p class="sheet-detail">Loading the providers…</p>'
        : sheet.installed.length > 1
          ? `<label class="sheet-field"><span class="sheet-label">Provider</span><select class="sheet-select" data-field="provider">${options(choices.map((one) => ({ value: one.provider, label: one.name })), sheet.provider)}</select></label>`
          : '';
    const ready = !sheet.busy && sheet.folder !== '' && sheet.installed !== null && sheet.installed.length > 0;
    const body =
      folders.length === 0
        ? '<p class="sheet-detail">The hub knows no folders yet. Add a repo root in Settings from the dock.</p>'
        : `<label class="sheet-field"><span class="sheet-label">Folder</span><select class="sheet-select" data-field="folder">${options([{ value: '', label: 'Choose a folder' }, ...folders.map((one) => ({ value: one, label: one }))], sheet.folder)}</select></label>${provider}`;

    return frame('New conversation in a folder', body + error, `${cancel}<button type="button" class="sheet-button primary" data-action="list-sheet-go"${ready ? '' : ' disabled'}>Create</button>`);
  }

  const schedules = header?.schedules ?? [];
  const typed = sheet.schedule === '';
  const run =
    schedules.length === 0
      ? ''
      : `<label class="sheet-field"><span class="sheet-label">Run</span><select class="sheet-select" data-field="schedule">${options([{ value: '', label: 'A prompt' }, ...schedules.map((one) => ({ value: one.name, label: `Run ${one.name} now · ${one.playbook}` }))], sheet.schedule)}</select></label>`;
  const fields = typed
    ? `<label class="sheet-field"><span class="sheet-label">Repository</span><select class="sheet-select" data-field="repo">${options([...(sheet.repo === '' ? [{ value: '', label: 'Choose a repository' }] : []), ...folders.map((one) => ({ value: one, label: one }))], sheet.repo)}</select></label>` +
      `<label class="sheet-field"><span class="sheet-label">Provider</span><select class="sheet-select" data-field="provider">${options(PROVIDERS.map((one) => ({ value: one.provider, label: one.name })), sheet.provider)}</select>${sheet.providerNote === null ? '' : `<span class="sheet-error">${escape(sheet.providerNote)}</span>`}</label>` +
      `<label class="sheet-field"><span class="sheet-label">Prompt</span><textarea class="sheet-prompt" data-field="prompt" rows="6" placeholder="What the session should do">${escape(sheet.prompt)}</textarea></label>` +
      `<label class="sheet-choice"><input type="checkbox" data-field="start"${sheet.start ? ' checked' : ''}><span>Start automatically</span></label>`
    : '';
  const ready = !sheet.busy && (!typed || (sheet.repo !== '' && sheet.prompt.trim() !== ''));

  return frame('New ad-hoc session', run + fields + error, `${cancel}<button type="button" class="sheet-button primary" data-action="list-sheet-go"${ready ? '' : ' disabled'}>${typed ? 'Create' : 'Run'}</button>`);
}

/**
 * The end of a search's results (PRD R63), after the list while the search filters it: what found nothing, Searching… or the hub's refusal, and
 * how to search further back.
 */
export function renderSearchEnd(search: SearchView, empty: boolean): string {
  const filter = search.filter.trim();

  if (!search.open || filter === '') {
    return '';
  }

  const last = RANGES.length - 1;
  const none = empty && !search.pending;
  const noneText = search.range === last ? `No matches for “${filter}”.` : `No matches for “${filter}” in the ${RANGES[search.range]!.toLowerCase()}.`;
  const note = search.error ?? (search.pending ? 'Searching…' : search.more ? `Showing the newest ${search.older.length} matches from before the last 2 weeks. Add words to narrow the search.` : null);
  const links = [
    search.range < last ? '<button type="button" class="link" data-action="list-search-further">Search further back</button>' : '',
    none && search.range < last - 1 ? '<button type="button" class="link" data-action="list-search-all">All time</button>' : '',
    none ? '<button type="button" class="link" data-action="list-search-clear">Clear search</button>' : '',
  ].join('');

  return `<div class="search-end" data-key="search-end">${none ? `<p class="search-none">${escape(noneText)}</p>` : ''}${note === null ? '' : `<p class="search-note" role="status">${escape(note)}</p>`}${links === '' ? '' : `<div class="search-links">${links}</div>`}</div>`;
}

/** The list header's controls, as the page uses them. */
export interface ListHeader {
  /** Draws the header for the hub's latest header and list. */
  draw(header: PageHeader | null, groups: readonly PageGroup[]): void;
  /** The list to draw: filtered while a search applies, with the rows the hub found before the Done list. */
  list(groups: readonly PageGroup[]): { groups: PageGroup[]; filtering: boolean };
  /** The end of the search's results, drawn after the list; empty without a search. */
  end(shown: readonly PageGroup[]): string;
  close(): void;
}

/**
 * The list's header (architecture.md § Web page): the dock header's source icons and search, drawn into `host` and run from its own clicks and
 * keys, and the search's end, which the page draws in `list`. The page calls `draw` with each state it draws.
 */
export function listHeader(host: HTMLElement, list: HTMLElement, sheetHost: HTMLElement, deps: ListHeaderDeps): ListHeader {
  const search: SearchView = { open: false, query: '', filter: '', range: 0, older: [], more: false, pending: false, error: null };
  const view: HeaderView = { menu: null, search, sheet: null, notice: null };
  // The repository New ad-hoc session used last, offered first next time while the page is open.
  let lastRepo: string | null = null;
  let ops = 0;
  const newOp = (): string => `header-${deps.now().toString(36)}-${(++ops).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let shown: PageHeader | null = null;
  let groups: readonly PageGroup[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Each search asked of the hub, so a newer search or range drops an older answer (F7).
  let searchRun = 0;

  const redraw = (): void => deps.redraw();
  const closeMenu = (focusOpener: boolean): void => {
    const menu = view.menu;

    view.menu = null;
    redraw();

    if (focusOpener && menu !== null) {
      const opener = menu === 'range' ? host.querySelector<HTMLElement>('.search-range') : menu === 'more' ? host.querySelector<HTMLElement>('.more-actions') : [...host.querySelectorAll<HTMLElement>('[data-action="list-source"]')].find((one) => `source:${one.dataset['kind']}` === menu);

      opener?.focus();
    }
  };
  /** Turns one source on or off; the hub's next list shows the change, and a refusal shows under the header. */
  const setSource = async (name: string, enabled: boolean): Promise<void> => {
    view.notice = null;
    redraw();

    const answer = await deps.post('page-source', { name, enabled });

    if (answer.status !== 200) {
      view.notice = String(answer.body['error'] ?? 'The source was not changed.');
      redraw();
    }
  };

  // ---- Search (PRD R63), as the dock's ----
  const dropOlder = (): void => {
    searchRun++;
    search.pending = false;
    search.error = null;
    search.more = false;
    search.older = [];
  };
  /** Asks the hub for the Done rows before the Done list, when the range reaches past it. */
  const searchOlder = async (): Promise<void> => {
    if (search.filter.trim() === '' || search.range === 0) {
      return;
    }

    const run = ++searchRun;

    search.pending = true;
    redraw();

    const answer = await deps.post('page-search', { text: search.filter.trim(), since: rangeSince(search.range, deps.now()) });

    if (run !== searchRun) {
      return;
    }

    search.pending = false;
    search.error = answer.status === 200 ? null : `The hub could not search further back: ${String(answer.body['error'] ?? 'no answer')}`;
    search.older = answer.status === 200 ? ((answer.body['rows'] as PageRow[] | undefined) ?? []) : [];
    search.more = answer.status === 200 && answer.body['more'] === true;
    redraw();
  };
  const apply = (text: string): void => {
    if (search.filter === text) {
      return;
    }

    search.filter = text;
    dropOlder();
    void searchOlder();
    redraw();
  };
  const cancelTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  /** The box's text: searched 250 ms after the last key from 3 characters, at once for a key; shorter text shows every row. */
  const typed = (query: string): void => {
    search.query = query;
    cancelTimer();

    const text = query.trim();

    if (text === '') {
      apply('');
    } else if (isKey(text, [...groups, { key: 'older', title: '', glyph: '', empty: null, rows: search.older }])) {
      apply(bareKey(text));
    } else if (text.length < SEARCH_MINIMUM) {
      apply('');
    } else {
      timer = setTimeout(() => {
        timer = null;
        apply(query);
      }, SEARCH_DELAY_MS);
    }
  };
  const setFilter = (text: string): void => {
    cancelTimer();
    search.query = text;

    const box = host.querySelector<HTMLInputElement>('.search-box');

    if (box !== null) {
      box.value = text;
    }

    apply(text);
  };
  const setRange = (range: number): void => {
    const next = Math.max(0, Math.min(RANGES.length - 1, range));

    if (next === search.range) {
      return;
    }

    search.range = next;
    dropOlder();
    void searchOlder();
    redraw();
  };
  /** Shows or hides the box; hiding it clears the search and its range. */
  const setOpen = (open: boolean): void => {
    search.open = open;
    view.menu = null;

    if (!open) {
      search.range = 0;
      setFilter('');
    }

    redraw();

    if (open) {
      host.querySelector<HTMLInputElement>('.search-box')?.focus();
    } else {
      host.querySelector<HTMLElement>('.search-toggle')?.focus();
    }
  };

  // ---- More Actions ----
  const refresh = async (): Promise<void> => {
    view.notice = null;
    redraw();

    const answer = await deps.post('page-poll', {});

    if (answer.status !== 200) {
      view.notice = String(answer.body['error'] ?? 'The sources were not polled.');
      redraw();
    }
  };
  const focusSheet = (): void => sheetHost.querySelector<HTMLElement>('textarea, select')?.focus();
  /** New ad-hoc session…: the repository used last or the first repo root, the default provider, or a schedule when there is no repository. */
  const openAdhoc = async (): Promise<void> => {
    const folders = shown?.folders ?? [];
    const repo = lastRepo !== null && folders.includes(lastRepo) ? lastRepo : (shown?.repoRoots[0] ?? '');
    const sheet: Extract<HeaderSheet, { kind: 'adhoc' }> = { kind: 'adhoc', opId: newOp(), schedule: repo === '' && (shown?.schedules.length ?? 0) > 0 ? shown!.schedules[0]!.name : '', repo, provider: 'claude', providerChosen: false, prompt: '', start: false, providerNote: null, busy: false, error: null };

    view.sheet = sheet;
    redraw();
    focusSheet();

    const answer = await deps.post('providers', {});
    const named = answer.status === 200 ? String(answer.body['defaultProvider'] ?? '') : '';

    if (view.sheet !== sheet) {
      return;
    }

    // A failed lookup leaves Claude selected and usable, and says why beside the box, as the dock's window does. A provider the operator picked
    // while the hub answered stays.
    if (named === 'claude' || named === 'codex') {
      sheet.provider = sheet.providerChosen ? sheet.provider : named;
    } else {
      sheet.providerNote = `${String(answer.body['error'] ?? 'The hub did not list the providers.')} Using Claude.`;
    }

    redraw();
  };
  /** New conversation in a folder…: a folder the hub knows, and the provider when both are installed. */
  const openFolder = async (): Promise<void> => {
    const sheet: Extract<HeaderSheet, { kind: 'folder' }> = { kind: 'folder', opId: newOp(), folder: '', provider: 'claude', providerChosen: false, installed: null, busy: false, error: null };

    view.sheet = sheet;
    redraw();
    focusSheet();

    const answer = await deps.post('providers', {});

    if (view.sheet !== sheet) {
      return;
    }

    const installed = answer.status === 200 && Array.isArray(answer.body['installed']) ? (answer.body['installed'] as unknown[]).filter((one): one is string => one === 'claude' || one === 'codex') : null;
    const named = String(answer.body['defaultProvider'] ?? '');

    if (installed === null || installed.length === 0) {
      sheet.error = installed === null ? String(answer.body['error'] ?? 'The hub did not list the providers.') : 'Neither Claude nor Codex is installed.';
      sheet.installed = [];
    } else {
      sheet.installed = installed;
      sheet.provider = installed.length === 1 ? installed[0]! : named === 'codex' ? 'codex' : 'claude';
    }

    redraw();
  };
  const closeSheet = (): void => {
    if (view.sheet !== null && view.sheet.kind !== 'later' && view.sheet.busy) {
      return;
    }

    view.sheet = null;
    redraw();
    host.querySelector<HTMLElement>('.more-actions')?.focus();
  };
  /** Create, or Run: sends the sheet; a refusal keeps it open with the hub's reason, as the dock's windows do. */
  const sheetGo = async (): Promise<void> => {
    const sheet = view.sheet;

    if (sheet === null || sheet.kind === 'later' || sheet.busy) {
      return;
    }

    sheet.busy = true;
    sheet.error = null;
    redraw();

    const answer =
      sheet.kind === 'adhoc'
        ? await deps.post('page-adhoc', sheet.schedule !== '' ? { opId: sheet.opId, schedule: sheet.schedule } : { opId: sheet.opId, prompt: sheet.prompt, repoRoot: sheet.repo, start: sheet.start, provider: sheet.provider })
        : await deps.post('page-folder-conversation', { opId: sheet.opId, folder: sheet.folder, provider: sheet.provider });

    sheet.busy = false;

    if (answer.status !== 200) {
      sheet.error = String(answer.body['error'] ?? 'Switchboard did not answer.');
      redraw();
      return;
    }

    if (sheet.kind === 'adhoc' && sheet.schedule === '') {
      lastRepo = sheet.repo;
    }

    if (view.sheet === sheet) {
      view.sheet = null;
    }

    redraw();

    if (sheet.kind === 'folder' && typeof answer.body['workItemId'] === 'number') {
      deps.select(answer.body['workItemId']);
    }
  };
  /** A sheet's field changed: kept, so a redraw shows it as typed. */
  const fieldChanged = (event: Event): void => {
    const field = event.target as HTMLInputElement;
    const name = field.dataset?.['field'];
    const sheet = view.sheet;

    if (name === undefined || sheet === null || sheet.kind === 'later') {
      return;
    }

    const value = name === 'start' ? field.checked : field.value;

    (sheet as unknown as Record<string, unknown>)[name] = value;

    if (name === 'provider') {
      sheet.providerChosen = true;
    }
    redraw();
  };

  sheetHost.addEventListener('input', fieldChanged);
  sheetHost.addEventListener('change', fieldChanged);
  sheetHost.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-action]');

    if (button?.dataset['action'] === 'list-sheet-go') {
      void sheetGo();
    } else if (button?.dataset['action'] === 'list-sheet-cancel' && (!button.classList.contains('sheet-backdrop') || target === button)) {
      // A press on the sheet itself is not one on its backdrop.
      closeSheet();
    }
  });
  sheetHost.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeSheet();
    }
  });

  const clicked = (event: Event): void => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');

    switch (button?.dataset['action']) {
      case 'list-source': {
        const group = shown?.sources.find((one) => one.kind === button.dataset['kind']);

        if (group === undefined) {
          break;
        }

        if (group.sources.length === 1) {
          view.menu = null;
          void setSource(group.sources[0]!.name, !group.sources[0]!.enabled);
        } else {
          view.menu = view.menu === `source:${group.kind}` ? null : `source:${group.kind}`;
          redraw();
        }

        break;
      }
      case 'list-source-entry': {
        const name = button.dataset['source'] ?? '';
        const one = shown?.sources.flatMap((group) => group.sources).find((entry) => entry.name === name);

        if (one !== undefined) {
          void setSource(name, !one.enabled);
        }

        break;
      }
      case 'list-dismiss':
        view.notice = null;
        redraw();
        break;
      case 'list-search':
        setOpen(!search.open);
        break;
      case 'list-search-clear':
        setFilter('');
        host.querySelector<HTMLInputElement>('.search-box')?.focus();
        break;
      case 'list-range':
        view.menu = view.menu === 'range' ? null : 'range';
        redraw();
        break;
      case 'list-range-pick':
        view.menu = null;
        setRange(Number(button.dataset['range']));
        host.querySelector<HTMLElement>('.search-range')?.focus();
        break;
      case 'list-search-further':
        setRange(search.range + 1);
        break;
      case 'list-search-all':
        setRange(RANGES.length - 1);
        break;
      case 'list-more':
        view.menu = view.menu === 'more' ? null : 'more';
        redraw();
        break;
      case 'list-adhoc':
        view.menu = null;
        void openAdhoc();
        break;
      case 'list-folder':
        view.menu = null;
        void openFolder();
        break;
      case 'list-poll':
        view.menu = null;
        void refresh();
        break;
      default: {
        const later = LATER[button?.dataset['action'] ?? ''];

        if (later !== undefined) {
          view.menu = null;
          view.sheet = { kind: 'later', title: later };
          redraw();
          sheetHost.querySelector<HTMLElement>('.sheet-button')?.focus();
        }
      }
    }
  };

  host.addEventListener('click', clicked);
  list.addEventListener('click', clicked);
  host.addEventListener('input', (event) => {
    if ((event.target as HTMLElement).classList.contains('search-box')) {
      typed((event.target as HTMLInputElement).value);
    }
  });
  host.addEventListener('keydown', (event) => {
    if (view.menu === null) {
      // Escape in the box closes the search, as the dock's.
      if (event.key === 'Escape' && (event.target as HTMLElement).classList.contains('search-box')) {
        event.stopPropagation();
        setOpen(false);
      }

      return;
    }

    if (event.key === 'Escape') {
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Up and Down move between the open menu's rows, as in the page's other menus.
      const rows = [...host.querySelectorAll<HTMLElement>('.menu .menu-row')];
      const at = rows.indexOf(document.activeElement as HTMLElement);

      if (rows.length > 0) {
        rows[at === -1 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]!.focus();
        event.preventDefault();
      }
    }
  });

  // An open menu closes on a press outside the header.
  const outside = (event: Event): void => {
    if (view.menu !== null && !(event.target instanceof Node && host.contains(event.target))) {
      closeMenu(false);
    }
  };

  document.addEventListener('pointerdown', outside);

  return {
    draw: (header, listed) => {
      shown = header;
      groups = listed;

      // A kind whose menu is open and that is gone, or now has one source, has no menu.
      if (view.menu?.startsWith('source:') === true && (header?.sources.find((one) => `source:${one.kind}` === view.menu)?.sources.length ?? 0) < 2) {
        view.menu = null;
      }

      morph(host, renderListHeader(header, view));
      morph(sheetHost, renderHeaderSheet(view.sheet, header));
    },
    list: (listed) => ({ groups: filterGroups(listed, search.filter, search.older), filtering: search.filter.trim() !== '' }),
    end: (filtered) => renderSearchEnd(search, filtered.every((group) => group.rows.length === 0)),
    close: () => {
      cancelTimer();
      document.removeEventListener('pointerdown', outside);
    },
  };
}
