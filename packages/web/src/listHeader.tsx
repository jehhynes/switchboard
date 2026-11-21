import type { ComponentChildren, VNode } from 'preact';
import qrcode from 'qrcode-generator';
import { mount } from './island.js';
import type { PageGroup, PageHeader, PageRow, SourceGroup } from './types.js';

type Answer = { status: number; body: Record<string, unknown> };

export interface ListHeaderDeps {
  /** Posts a page command with the page key, as the page's other commands do. */
  post(name: string, body: Record<string, unknown>): Promise<Answer>;
  /** Draws the page again after the header changed what it shows. */
  redraw(): void;
  /** Opens a work item's conversation, as a click on its row does. */
  select(workItemId: number): void;
  /** Opens Settings (architecture.md § Web page), as the dock's Open Settings opens its window. */
  openSettings?(): void;
  now(): number;
  /** Whether the page is the one on this computer, which may pair devices, open Settings and restart the holder (architecture.md § Remote access); false on a paired device. */
  local?: boolean;
}

/** A pairing link the hub gave out (architecture.md § Remote access): its URL, its code and when both stop working. */
export interface Pairing {
  url: string;
  code: string;
  host: string;
  expiresAt: number;
}

/** A signed-in device as the hub lists it. */
export interface Device {
  id: string;
  label: string;
  host: string | null;
  login: string | null;
  usedAt: number;
  current: boolean;
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

/** A source kind's logo, grey while off, with `extra` classes; a kind without one shows a tag, so its button is never blank. */
export function SourceLogo({ kind, enabled, extra = '' }: { kind: string; enabled: boolean; extra?: string }) {
  const logo = LOGOS[kind];
  const state = `${enabled ? '' : ' off'}${extra === '' ? '' : ` ${extra}`}`;

  if (logo === undefined) {
    return <span class={`codicon codicon-tag source-logo${state}`} aria-hidden="true"></span>;
  }

  const paint = logo.stroke
    ? { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }
    : { fill: 'currentColor', ...(logo.evenOdd ? { 'fill-rule': 'evenodd' } : {}) };

  return (
    <svg class={`source-logo ${kind}${state}`} viewBox={logo.viewBox} aria-hidden="true" focusable="false">
      <path {...(paint as Record<string, string>)} d={logo.path} />
    </svg>
  );
}

/** A menu row's left gutter: a check mark for a checked row, or nothing, as the page's other menus draw it. */
function Gutter({ checked }: { checked: boolean }) {
  return <span class="menu-gutter" aria-hidden="true">{checked ? <span class="codicon codicon-check"></span> : null}</span>;
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
  | { kind: 'later'; title: string }
  | { kind: 'holder'; busy: boolean; error: string | null }
  | { kind: 'devices'; pairing: Pairing | null; devices: Device[] | null; busy: boolean; error: string | null };

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
  /** The `at` of the holder restart result dismissed last, which stays hidden. */
  holderDismissed?: number | null;
  /** Whether the page is this computer's, which offers Pair a device, Open Settings and Restart and resume; false on a paired device. */
  local?: boolean;
  /** The last work item that started needing the operator, with the dock's message, shown until it times out or is dismissed (PRD R65). */
  needs?: { workItemId: number; message: string } | null;
}

/** How long the needs-you message shows on a visible page with the pointer off it, as the dock's status toast. */
export const NEEDS_SHOWN_MS = 10_000;
/** How often the page counts that time. */
const NEEDS_TICK_MS = 1_000;

/** The needs-you message under the header, as the dock's status toast shows it: a click on the message opens its work item. */
function NeedsYou({ view }: { view: HeaderView }) {
  const needs = view.needs ?? null;

  return needs === null ? null : (
    <p class="needs-toast" role="status">
      <button type="button" class="needs-message" data-action="list-needs" title="Open this work item">
        {needs.message}
      </button>
      <button type="button" class="icon dismiss" data-action="list-needs-dismiss" title="Dismiss" aria-label="Dismiss">
        <span class="codicon codicon-close" aria-hidden="true"></span>
      </button>
    </p>
  );
}

/**
 * The dock's notes above its groups, in the warning colour: settings, playbook, hook, source and voice errors and setup notes, then the held
 * sessions without a work item, whose click opens what Held sessions in More Actions opens.
 */
function HeaderNotes({ header }: { header: PageHeader | null }) {
  return (
    <>
      {(header?.notes ?? []).map((note) => (
        <p class="list-note" role="status">
          {note}
        </p>
      ))}
      {header?.heldNote === undefined ? null : (
        <button type="button" class="list-note held-note" data-action="list-later-held" title="Open held sessions">
          {header.heldNote}
        </button>
      )}
    </>
  );
}

/**
 * The terminal holder's notice under the header while it is from an older build or restarting, with Restart and resume on this computer's page
 * only, and the last restart's result until dismissed (architecture.md § Restarting the holder), as the dock shows them above its groups.
 */
function HolderNotices({ header, view }: { header: PageHeader | null; view: HeaderView }) {
  const notice = header?.holderNotice;
  const result = header?.holderResult;

  return (
    <>
      {notice === undefined ? null : (
        <div class="holder-notice" role="status">
          <span class="holder-notice-text">{notice.text}</span>
          {notice.confirm == null || view.local !== true ? null : (
            <button type="button" class="holder-restart" data-action="list-holder-restart">
              {notice.confirm.action}
            </button>
          )}
        </div>
      )}
      {result === undefined || result.at === view.holderDismissed ? null : (
        <p class={`holder-result${result.failed ? ' failed' : ''}`} role="status">
          <span class="holder-result-text">{result.text}</span>
          <button type="button" class="icon dismiss" data-action="list-holder-dismiss" title="Dismiss" aria-label="Dismiss">
            <span class="codicon codicon-close" aria-hidden="true"></span>
          </button>
        </p>
      )}
    </>
  );
}

/**
 * A source kind's header icon (PRD R3, R71), as the dock's: its logo, grey while every source of the kind is off, and the hub's tooltip. With one
 * source a click turns it on or off; with several it opens a menu with a check row per source, which stays open so several can change.
 */
function SourceButton({ group, view }: { group: SourceGroup; view: HeaderView }) {
  const several = group.sources.length > 1;
  const name = several ? group.kind : (group.sources[0]?.name ?? group.kind);
  const open = view.menu === `source:${group.kind}`;
  const state = several ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': open } : { 'aria-pressed': group.enabled };

  return (
    <div class="menu-anchor" data-key={`source-${group.kind}`}>
      <button type="button" class="icon source-toggle" data-action="list-source" data-kind={group.kind} {...state} title={group.title} aria-label={name}>
        <SourceLogo kind={group.kind} enabled={group.enabled} />
      </button>
      {several && open ? (
        <ul class="glass menu source-menu" role="menu" aria-label={`${group.kind} sources`}>
          {group.sources.map((one) => (
            <li role="none">
              <button type="button" class="menu-row" role="menuitemcheckbox" aria-checked={one.enabled} data-action="list-source-entry" data-source={one.name}>
                <Gutter checked={one.enabled} />
                <span class="title">{one.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The list's header (architecture.md § Web page), as the dock's title row: the title, which takes what is left and ends in an ellipsis, then
 * the source icons; a refusal shows under it.
 */
export function renderListHeader(header: PageHeader | null, view: HeaderView): VNode {
  const sources = header?.sources ?? [];
  const search = view.search;

  return (
    <>
      <div class="list-header">
        {sources.length === 0 ? null : (
          <>
            <div class="header-sources">
              {sources.map((group) => (
                <SourceButton key={group.kind} group={group} view={view} />
              ))}
            </div>
            <span class="header-separator" aria-hidden="true"></span>
          </>
        )}
        <button type="button" class="icon search-toggle" data-action="list-search" aria-pressed={search.open} title="Search" aria-label="Search">
          <span class="codicon codicon-search" aria-hidden="true"></span>
        </button>
        <div class="menu-anchor" data-key="more">
          <button type="button" class="icon more-actions" data-action="list-more" aria-haspopup="menu" aria-expanded={view.menu === 'more'} title="More Actions…" aria-label="More Actions">
            <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
          </button>
          {view.menu === 'more' ? renderMoreMenu(header, view.local === true) : null}
        </div>
      </div>
      {/* The box and the searched range under the title row while the search is open, as the dock's. */}
      {search.open ? (
        <div class="search-row">
          <div class="search-field">
            <input type="search" class="search-box" placeholder="Search title, key, PR, playbook, branch" aria-label="Search" value={search.query} autocomplete="off" spellcheck={false} />
            <button type="button" class="icon" data-action="list-search-clear" title="Clear search" aria-label="Clear search">
              <span class="codicon codicon-close" aria-hidden="true"></span>
            </button>
          </div>
          <div class="menu-anchor">
            <button type="button" class="search-range" data-action="list-range" aria-haspopup="menu" aria-expanded={view.menu === 'range'} title="Choose how far back to search" aria-label={`Search range: ${RANGES[search.range]}`}>
              <span>{RANGES[search.range]}</span>
              <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
            </button>
            {view.menu === 'range' ? (
              <ul class="glass menu range-menu" role="menu" aria-label="Search range">
                {RANGES.map((label, index) => (
                  <li role="none">
                    <button type="button" class="menu-row" role="menuitemradio" aria-checked={index === search.range} data-action="list-range-pick" data-range={String(index)}>
                      <Gutter checked={index === search.range} />
                      <span class="title">{label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
      <NeedsYou view={view} />
      {view.notice === null ? null : (
        <p class="list-notice" role="alert">
          <span class="list-notice-text">{view.notice}</span>
          <button type="button" class="icon dismiss" data-action="list-dismiss" title="Dismiss" aria-label="Dismiss">
            <span class="codicon codicon-close" aria-hidden="true"></span>
          </button>
        </p>
      )}
      <HeaderNotes header={header} />
      <HolderNotices header={header} view={view} />
    </>
  );
}

/** A More Actions row: its codicon in the gutter, as the dock's menu draws its glyph, then its label. */
function MoreRow({ action, icon, label }: { action: string; icon: string; label: string }) {
  return (
    <li role="none">
      <button type="button" class="menu-row" role="menuitem" data-action={action}>
        <span class="menu-gutter" aria-hidden="true">
          <span class={`codicon codicon-${icon}`}></span>
        </span>
        <span class="title">{label}</span>
      </button>
    </li>
  );
}

const Separator = ({ classes = 'menu-separator' }: { classes?: string }) => <li class={classes} role="separator"></li>;

/**
 * More Actions (PRD R71), in the dock's groups: New ad-hoc session… and New conversation in a folder…; Held sessions, and Ticket volume
 * report with a Zoho or Forum source; Refresh sources and Show hub log; then Pair a device and Open Settings, on this computer's page only. On a phone, where the header has no room for them,
 * the source icons come first as a check row per source.
 */
export function renderMoreMenu(header: PageHeader | null, local = false): VNode {
  const sources = (header?.sources ?? []).flatMap((group) =>
    group.sources.map((one) => (
      <li role="none" class="more-source">
        <button type="button" class="menu-row" role="menuitemcheckbox" aria-checked={one.enabled} data-action="list-source-entry" data-source={one.name}>
          <Gutter checked={one.enabled} />
          <SourceLogo kind={group.kind} enabled={one.enabled} />
          <span class="title">{one.name}</span>
        </button>
      </li>
    )),
  );
  const volume = (header?.sources ?? []).some((group) => group.kind === 'zoho' || group.kind === 'forum');

  return (
    <ul class="glass menu more-menu" role="menu" aria-label="More Actions">
      {sources.length === 0 ? null : [...sources, <Separator classes="menu-separator more-source" />]}
      <MoreRow action="list-adhoc" icon="add" label="New ad-hoc session…" />
      <MoreRow action="list-folder" icon="folder" label="New conversation in a folder…" />
      <Separator />
      <MoreRow action="list-later-held" icon="terminal" label="Held sessions" />
      {volume ? <MoreRow action="list-later-volume" icon="graph" label="Ticket volume report" /> : null}
      <Separator />
      <MoreRow action="list-poll" icon="refresh" label="Refresh sources" />
      <MoreRow action="list-later-log" icon="output" label="Show hub log" />
      {local ? (
        <>
          <Separator />
          <MoreRow action="list-devices" icon="device-mobile" label="Pair a device…" />
          <MoreRow action="list-settings" icon="settings-gear" label="Open Settings" />
        </>
      ) : null}
    </ul>
  );
}

/** The dock windows More Actions opens that the page does not have yet, by their row's action. */
export const LATER: Record<string, string> = { 'list-later-held': 'Held sessions', 'list-later-volume': 'Ticket volume report', 'list-later-log': 'Show hub log' };

/** A QR code of `text` as an SVG of dark modules on a light square with a quiet zone of 4 modules, which phone cameras read in either theme. */
export function QrCode({ text }: { text: string }) {
  const qr = qrcode(0, 'M');

  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const size = count + 8;
  let path = '';

  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        path += `M${col + 4} ${row + 4}h1v1h-1z`;
      }
    }
  }

  return (
    <svg class="pair-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code of the pairing link" shape-rendering="crispEdges">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

/** When a device was last used, as the device list says it. */
function usedText(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Pair a device (architecture.md § Remote access): the pairing link's QR code and code, how long they work, and the signed-in devices, each
 * with Sign out.
 */
function DevicesSheet({ sheet, now }: { sheet: Extract<HeaderSheet, { kind: 'devices' }>; now: number }) {
  const pairing = sheet.pairing;
  const minutes = pairing === null ? 0 : Math.max(0, Math.ceil((pairing.expiresAt - now) / 60_000));

  return (
    <Frame
      title="Pair a device"
      buttons={
        <>
          <button type="button" class="sheet-button secondary" data-action="list-sheet-go" disabled={sheet.busy}>
            New code
          </button>
          <button type="button" class="sheet-button primary" data-action="list-sheet-cancel">
            Close
          </button>
        </>
      }
    >
      {pairing === null ? (
        sheet.busy ? <p class="sheet-detail">Asking Switchboard for a code…</p> : null
      ) : (
        <div class="pair" data-key="pair">
          <QrCode text={pairing.url} />
          <p class="sheet-detail">
            Scan this with the device's camera, or open <strong>https://{pairing.host}/</strong> on it and type this code:
          </p>
          <p class="pair-code">{pairing.code}</p>
          <p class="sheet-detail">{minutes > 0 ? `It works once, for ${minutes === 1 ? '1 more minute' : `${minutes} more minutes`}.` : 'It has expired. Choose New code.'}</p>
        </div>
      )}
      {sheet.error === null ? null : <p class="sheet-error" role="alert">{sheet.error}</p>}
      <h3 class="sheet-label">Signed-in devices</h3>
      {sheet.devices === null ? (
        <p class="sheet-detail">Loading…</p>
      ) : sheet.devices.length === 0 ? (
        <p class="sheet-detail">No device is signed in.</p>
      ) : (
        <ul class="device-list">
          {sheet.devices.map((one) => (
            <li class="device" data-key={`device-${one.id}`}>
              <span class="device-text">
                <span class="device-name">
                  {one.label || 'Unknown device'}
                  {one.current ? ' (this browser)' : ''}
                </span>
                <span class="device-detail">
                  {one.host === null ? 'This computer' : `${one.host} as ${one.login ?? ''}`} · last used {usedText(one.usedAt)}
                </span>
              </span>
              <button type="button" class="sheet-button secondary" data-action="list-device-revoke" data-id={one.id} disabled={sheet.busy}>
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
}

/** A select's options, the chosen one selected. */
function Options({ items, chosen }: { items: ReadonlyArray<{ value: string; label: string }>; chosen: string }) {
  return (
    <>
      {items.map((item) => (
        <option value={item.value} selected={item.value === chosen}>
          {item.label}
        </option>
      ))}
    </>
  );
}

/** A labelled select of a sheet's field. */
function Select({ label, field, items, chosen, after }: { label: string; field: string; items: ReadonlyArray<{ value: string; label: string }>; chosen: string; after?: ComponentChildren }) {
  return (
    <label class="sheet-field">
      <span class="sheet-label">{label}</span>
      <select class="sheet-select" data-field={field}>
        <Options items={items} chosen={chosen} />
      </select>
      {after}
    </label>
  );
}

/** The frame every sheet of the header has: its title, its body and its buttons, over a backdrop that cancels it. */
function Frame({ title, children, buttons }: { title: string; children: ComponentChildren; buttons: ComponentChildren }) {
  return (
    <div class="sheet-backdrop" data-action="list-sheet-cancel">
      <div class="sheet glass" role="dialog" aria-modal="true" aria-labelledby="list-sheet-title">
        <h2 id="list-sheet-title" class="sheet-title">
          {title}
        </h2>
        {children}
        <div class="sheet-buttons">{buttons}</div>
      </div>
    </div>
  );
}

/**
 * A sheet of the header (architecture.md § Web page), drawn as the page's other sheets: New ad-hoc session as the dock's window (Run, with the
 * schedules; Repository; Provider; Prompt; Start automatically), New conversation in a folder with the folder and, when both are installed, the
 * provider, or a dock window the page does not have yet.
 */
export function renderHeaderSheet(sheet: HeaderSheet | null, header: PageHeader | null, now = Date.now()): VNode | null {
  if (sheet === null) {
    return null;
  }

  if (sheet.kind === 'devices') {
    return <DevicesSheet sheet={sheet} now={now} />;
  }

  if (sheet.kind === 'later') {
    return (
      <Frame
        title={sheet.title}
        buttons={
          <button type="button" class="sheet-button primary" data-action="list-sheet-cancel">
            Close
          </button>
        }
      >
        <p class="sheet-detail">{sheet.title} is not on the web page yet. Use it from the dock.</p>
      </Frame>
    );
  }

  const cancel = (
    <button type="button" class="sheet-button secondary" data-action="list-sheet-cancel" disabled={sheet.busy}>
      Cancel
    </button>
  );
  const error = sheet.error === null ? null : <p class="sheet-error" role="alert">{sheet.error}</p>;

  // Restart and resume asks the hub's question, which follows each list, so a restart begun elsewhere leaves nothing to confirm.
  if (sheet.kind === 'holder') {
    const confirm = header?.holderNotice?.confirm ?? null;

    return confirm === null ? (
      <Frame
        title="Restart the terminal holder"
        buttons={
          <button type="button" class="sheet-button primary" data-action="list-sheet-cancel">
            Close
          </button>
        }
      >
        <p class="sheet-detail">{header?.holderNotice?.text ?? 'The terminal holder runs the installed build.'}</p>
        {error}
      </Frame>
    ) : (
      <Frame
        title={confirm.question}
        buttons={
          <>
            {cancel}
            <button type="button" class="sheet-button primary" data-action="list-sheet-go" disabled={sheet.busy}>
              {confirm.action}
            </button>
          </>
        }
      >
        <p class="sheet-detail">{confirm.detail}</p>
        {error}
      </Frame>
    );
  }
  const folders = header?.folders ?? [];
  const go = (ready: boolean, label: string) => (
    <>
      {cancel}
      <button type="button" class="sheet-button primary" data-action="list-sheet-go" disabled={!ready}>
        {label}
      </button>
    </>
  );

  if (sheet.kind === 'folder') {
    const installed = sheet.installed;
    const choices = installed === null ? [] : PROVIDERS.filter((one) => installed.length > 1 || installed.includes(one.provider));
    const provider =
      installed === null ? (
        <p class="sheet-detail">Loading the providers…</p>
      ) : installed.length > 1 ? (
        <Select label="Provider" field="provider" items={choices.map((one) => ({ value: one.provider, label: one.name }))} chosen={sheet.provider} />
      ) : null;
    const ready = !sheet.busy && sheet.folder !== '' && installed !== null && installed.length > 0;

    return (
      <Frame title="New conversation in a folder" buttons={go(ready, 'Create')}>
        {folders.length === 0 ? (
          <p class="sheet-detail">The hub knows no folders yet. Add a repo root in Settings from the dock.</p>
        ) : (
          <>
            <Select label="Folder" field="folder" items={[{ value: '', label: 'Choose a folder' }, ...folders.map((one) => ({ value: one, label: one }))]} chosen={sheet.folder} />
            {provider}
          </>
        )}
        {error}
      </Frame>
    );
  }

  const schedules = header?.schedules ?? [];
  const typed = sheet.schedule === '';
  const ready = !sheet.busy && (!typed || (sheet.repo !== '' && sheet.prompt.trim() !== ''));

  return (
    <Frame title="New ad-hoc session" buttons={go(ready, typed ? 'Create' : 'Run')}>
      {schedules.length === 0 ? null : <Select label="Run" field="schedule" items={[{ value: '', label: 'A prompt' }, ...schedules.map((one) => ({ value: one.name, label: `Run ${one.name} now · ${one.playbook}` }))]} chosen={sheet.schedule} />}
      {typed ? (
        <>
          <Select label="Repository" field="repo" items={[...(sheet.repo === '' ? [{ value: '', label: 'Choose a repository' }] : []), ...folders.map((one) => ({ value: one, label: one }))]} chosen={sheet.repo} />
          <Select label="Provider" field="provider" items={PROVIDERS.map((one) => ({ value: one.provider, label: one.name }))} chosen={sheet.provider} after={sheet.providerNote === null ? null : <span class="sheet-error">{sheet.providerNote}</span>} />
          <label class="sheet-field">
            <span class="sheet-label">Prompt</span>
            <textarea class="sheet-prompt" data-field="prompt" rows={6} placeholder="What the session should do" value={sheet.prompt}></textarea>
          </label>
          <label class="sheet-choice">
            <input type="checkbox" data-field="start" checked={sheet.start} />
            <span>Start automatically</span>
          </label>
        </>
      ) : null}
      {error}
    </Frame>
  );
}

/**
 * The end of a search's results (PRD R63), after the list while the search filters it: what found nothing, Searching… or the hub's refusal, and
 * how to search further back.
 */
export function renderSearchEnd(search: SearchView, empty: boolean): VNode | null {
  const filter = search.filter.trim();

  if (!search.open || filter === '') {
    return null;
  }

  const last = RANGES.length - 1;
  const none = empty && !search.pending;
  const noneText = search.range === last ? `No matches for “${filter}”.` : `No matches for “${filter}” in the ${RANGES[search.range]!.toLowerCase()}.`;
  const note = search.error ?? (search.pending ? 'Searching…' : search.more ? `Showing the newest ${search.older.length} matches from before the last 2 weeks. Add words to narrow the search.` : null);
  const links = [
    search.range < last ? (
      <button type="button" class="link" data-action="list-search-further">
        Search further back
      </button>
    ) : null,
    none && search.range < last - 1 ? (
      <button type="button" class="link" data-action="list-search-all">
        All time
      </button>
    ) : null,
    none ? (
      <button type="button" class="link" data-action="list-search-clear">
        Clear search
      </button>
    ) : null,
  ].filter((one) => one !== null);

  return (
    <div class="search-end" data-key="search-end" key="search-end">
      {none ? <p class="search-none">{noneText}</p> : null}
      {note === null ? null : (
        <p class="search-note" role="status">
          {note}
        </p>
      )}
      {links.length === 0 ? null : <div class="search-links">{links}</div>}
    </div>
  );
}

/** The list header's controls, as the page uses them. */
export interface ListHeader {
  /** Draws the header for the hub's latest header and list. */
  draw(header: PageHeader | null, groups: readonly PageGroup[]): void;
  /** Shows the hub's `needs` event: the last of its work items, as the dock's toast does. */
  needs(items: ReadonlyArray<{ workItemId: number; message: string }>): void;
  /** The list to draw: filtered while a search applies, with the rows the hub found before the Done list. */
  list(groups: readonly PageGroup[]): { groups: PageGroup[]; filtering: boolean };
  /** The end of the search's results, drawn after the list; nothing without a search. */
  end(shown: readonly PageGroup[]): VNode | null;
  close(): void;
}

/**
 * The list's header (architecture.md § Web page): the dock header's source icons and search, drawn into `host` and run from its own clicks and
 * keys, and the search's end, which the page draws in `list`. The page calls `draw` with each state it draws.
 */
export function listHeader(host: HTMLElement, list: HTMLElement, sheetHost: HTMLElement, deps: ListHeaderDeps): ListHeader {
  const search: SearchView = { open: false, query: '', filter: '', range: 0, older: [], more: false, pending: false, error: null };
  const view: HeaderView = { menu: null, search, sheet: null, notice: null, local: deps.local === true };
  // The repository New ad-hoc session used last, offered first next time while the page is open.
  let lastRepo: string | null = null;
  let ops = 0;
  const newOp = (): string => `header-${deps.now().toString(36)}-${(++ops).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let shown: PageHeader | null = null;
  let groups: readonly PageGroup[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Each search asked of the hub, so a newer search or range drops an older answer (F7).
  let searchRun = 0;
  // How long the needs-you message has shown on a visible page with the pointer off it; a hidden page or the pointer on it starts it again.
  let needsShown = 0;
  let needsTimer: ReturnType<typeof setInterval> | null = null;
  let needsHovered = false;
  const clearNeeds = (): void => {
    view.needs = null;

    if (needsTimer !== null) {
      clearInterval(needsTimer);
      needsTimer = null;
    }
  };
  const needsTick = (): void => {
    needsShown = needsHovered || document.hidden ? 0 : needsShown + NEEDS_TICK_MS;

    if (needsShown >= NEEDS_SHOWN_MS) {
      clearNeeds();
      redraw();
    }
  };

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
  /** Asks the hub for a new pairing link, or the devices again, into the open Pair a device sheet; a refusal shows in it. */
  const pairAgain = async (sheet: Extract<HeaderSheet, { kind: 'devices' }>): Promise<void> => {
    sheet.busy = true;
    sheet.error = null;
    redraw();

    const [pairing, devices] = await Promise.all([deps.post('page-pair', {}), deps.post('page-devices', {})]);

    sheet.busy = false;
    sheet.pairing = pairing.status === 200 ? (pairing.body as unknown as Pairing) : null;
    sheet.error = pairing.status === 200 ? null : String(pairing.body['error'] ?? 'Switchboard did not give a code.');
    sheet.devices = devices.status === 200 ? ((devices.body['devices'] as Device[] | undefined) ?? []) : (sheet.devices ?? []);
    redraw();
  };
  /** Pair a device…: a new pairing link and the signed-in devices. */
  const openDevices = async (): Promise<void> => {
    const sheet: Extract<HeaderSheet, { kind: 'devices' }> = { kind: 'devices', pairing: null, devices: null, busy: true, error: null };

    view.sheet = sheet;
    redraw();
    sheetHost.querySelector<HTMLElement>('.sheet-button.primary')?.focus();
    await pairAgain(sheet);
  };
  /** Signs one device out, then lists the devices again. */
  const revokeDevice = async (id: string): Promise<void> => {
    const sheet = view.sheet;

    if (sheet?.kind !== 'devices' || sheet.busy) {
      return;
    }

    sheet.busy = true;
    sheet.error = null;
    redraw();

    const answer = await deps.post('page-device-revoke', { id });
    const devices = await deps.post('page-devices', {});

    sheet.busy = false;
    sheet.error = answer.status === 200 ? null : String(answer.body['error'] ?? 'The device was not signed out.');
    sheet.devices = devices.status === 200 ? ((devices.body['devices'] as Device[] | undefined) ?? []) : sheet.devices;
    redraw();
  };
  const closeSheet = (): void => {
    if (view.sheet !== null && view.sheet.kind !== 'later' && view.sheet.kind !== 'devices' && view.sheet.busy) {
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

    if (sheet.kind === 'devices') {
      await pairAgain(sheet);
      return;
    }

    sheet.busy = true;
    sheet.error = null;
    redraw();

    const answer =
      sheet.kind === 'holder'
        ? await deps.post('page-holder-restart', { detail: shown?.holderNotice?.confirm?.detail ?? '' })
        : sheet.kind === 'adhoc'
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

    if (name === undefined || sheet === null || sheet.kind === 'later' || sheet.kind === 'holder' || sheet.kind === 'devices') {
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
    } else if (button?.dataset['action'] === 'list-device-revoke') {
      void revokeDevice(button.dataset['id'] ?? '');
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
      case 'list-needs': {
        const workItemId = view.needs?.workItemId;

        clearNeeds();
        redraw();

        if (workItemId !== undefined) {
          deps.select(workItemId);
        }

        break;
      }
      case 'list-needs-dismiss':
        clearNeeds();
        redraw();
        break;
      case 'list-holder-restart':
        view.sheet = { kind: 'holder', busy: false, error: null };
        redraw();
        sheetHost.querySelector<HTMLElement>('.sheet-button')?.focus();
        break;
      case 'list-holder-dismiss':
        view.holderDismissed = shown?.holderResult?.at ?? null;
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
      case 'list-devices':
        view.menu = null;
        void openDevices();
        break;
      case 'list-settings':
        view.menu = null;
        redraw();
        deps.openSettings?.();
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
  host.addEventListener('pointerover', (event) => {
    needsHovered = (event.target as HTMLElement).closest?.('.needs-toast') != null;
  });
  host.addEventListener('pointerleave', () => {
    needsHovered = false;
  });

  return {
    needs: (items) => {
      const last = items.at(-1);

      if (last === undefined) {
        return;
      }

      view.needs = { workItemId: last.workItemId, message: last.message };
      needsShown = 0;
      needsTimer ??= setInterval(needsTick, NEEDS_TICK_MS);
      redraw();
    },
    draw: (header, listed) => {
      shown = header;
      groups = listed;

      // A kind whose menu is open and that is gone, or now has one source, has no menu.
      if (view.menu?.startsWith('source:') === true && (header?.sources.find((one) => `source:${one.kind}` === view.menu)?.sources.length ?? 0) < 2) {
        view.menu = null;
      }

      mount(host, renderListHeader(header, view));
      mount(sheetHost, renderHeaderSheet(view.sheet, header, deps.now()));
    },
    list: (listed) => ({ groups: filterGroups(listed, search.filter, search.older), filtering: search.filter.trim() !== '' }),
    end: (filtered) => renderSearchEnd(search, filtered.every((group) => group.rows.length === 0)),
    close: () => {
      cancelTimer();
      clearNeeds();
      document.removeEventListener('pointerdown', outside);
    },
  };
}
