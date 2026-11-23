import type { ComponentChildren, VNode } from 'preact';
import qrcode from 'qrcode-generator';
import { providerMark } from '@switchboard/conversation/providerIcons';
import { mount } from './island.js';
import { HubLog } from './hubLog.js';
import { trusted } from './trusted.js';
import type { PageGroup, PageHeader, PageRow, SourceGroup } from '@switchboard/protocol';
import type { PhoneVoiceState } from './phoneVoice.js';
import { ConnectionDot } from './connectionView.js';
import type { DotView } from './connectionView.js';

type Answer = { status: number; body: Record<string, unknown> };

/** A session in the hub's dock view (PRD R94). */
export interface HeldRow {
  session: string; item: string; nativeSessionId: string; cwd: string; state: string;
  idle: string; memory: string; clients: number; orphan: boolean; exited: boolean;
  terminal: object | null;
}

export interface ListHeaderDeps {
  fetch?: typeof fetch;
  /** Posts a page command with the page key, as the page's other commands do. */
  post(name: string, body: Record<string, unknown>): Promise<Answer>;
  /** Draws the page again after the header changed what it shows. */
  redraw(): void;
  /** Opens a work item's conversation, as a click on its row does. */
  select(workItemId: number): void;
  /** Opens Settings (architecture.md § Web page), as the dock's Open Settings opens its window. */
  openSettings?(): void;
  /** Reloads the page, for an installed app with no browser reload. */
  reload?(): void;
  now(): number;
  /** Whether the page is the one on this computer, which may pair devices, open Settings and restart the holder (architecture.md § Remote access); false on a paired device. */
  local?: boolean;
  /** Voice on this phone (architecture.md § Remote access), on a paired device's page only: where it is, its last error, and the tap that moves it. */
  phoneVoice?: { state(): PhoneVoiceState; error(): string | null; toggle(): void };
  /**
   * Whether the list is pinned as a column rather than a drawer (architecture.md § Web page), for its pin button, whose click the page takes;
   * undefined where the pin would change nothing, which leaves the pin out.
   */
  pinned?(): boolean | undefined;
  /** Shows why the header's action failed in the page's toast (toast.tsx), or hides a refusal shown there with null. */
  refused(text: string | null): void;
  /** The connection's dot beside the title (connectionView.tsx). */
  connection?(): DotView | null;
}

/** A pairing link the hub gave out (architecture.md § Remote access): its URL, its code and when both stop working. */
export interface Pairing {
  url: string;
  code: string;
  host: string;
  expiresAt: number;
}

/** A signed-in device as the hub lists it, with whether voice is allowed on it (architecture.md § Remote access). */
export interface Device {
  id: string;
  label: string;
  host: string | null;
  login: string | null;
  usedAt: number;
  current: boolean;
  voice?: boolean;
}

/** How long after the last key the New session form asks the hub about a typed folder. */
export const FOLDER_CHECK_MS = 300;
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
    const rows = all.filter((row) => matches(row.search, filter));

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

/** How the New session form runs a first message (PRD R122): a conversation now, a task when a slot is free, or a task that waits for Start. */
export type RunAs = 'now' | 'queue' | 'wait';

/** The Run as choices, in the form's order. */
export const RUN_AS: ReadonlyArray<{ value: RunAs; label: string }> = [
  { value: 'now', label: 'Conversation, start now' },
  { value: 'queue', label: 'Task, start when a slot is free' },
  { value: 'wait', label: 'Task, wait for Start' },
];

/** Where this device keeps the Run as chosen last, which the form offers next time. */
export const RUN_AS_KEY = 'switchboard.newSession.run';

/** The Model list's value for Other…, which shows a text box. */
export const OTHER_MODEL = ':other';

/** The hub's `page-folders` starting places: recent folders, repo roots, worktrees, and on this computer's page its home folder and drives. */
export interface FolderPlaces {
  recent: string[];
  repoRoots: string[];
  worktrees: string[];
  computer: string[];
}

/** The folder browser over the form: a folder's subfolders, or the starting places while `path` is null. */
export interface FolderBrowser {
  path: string | null;
  parent: string | null;
  folders: { name: string; path: string }[];
  more: boolean;
  busy: boolean;
  error: string | null;
}

/** The New session form (PRD R122). `opId` stays the same for the form's retries, so the hub creates once. */
export interface NewSessionSheet {
  kind: 'new';
  opId: string;
  folder: string;
  /** Why the hub refuses the typed folder, or null. */
  folderError: string | null;
  /** Whether the folder list under the field is open. */
  folderOpen: boolean;
  places: FolderPlaces | null;
  browser: FolderBrowser | null;
  provider: string;
  installed: string[] | null;
  /** Each provider's configured model, which Default names. */
  models: Record<string, string>;
  choices: Record<string, Array<{ id: string; label: string }>>;
  /** The chosen model: '' for Default, `OTHER_MODEL` for Other…, else a choice's id. */
  model: string;
  otherModel: string;
  prompt: string;
  run: RunAs;
  more: boolean;
  /** The schedule Run a schedule now runs, or '' for none. */
  schedule: string;
  busy: boolean;
  error: string | null;
}

/**
 * A sheet the header opens over the page: the New session form, or a dock window the page does not have yet.
 */
export type HeaderSheet =
  | NewSessionSheet
  | { kind: 'later'; title: string }
  | { kind: 'log' }
  | { kind: 'held'; rows: HeldRow[] | null; busy: boolean; refreshing: boolean; listError: string | null; error: string | null; result: string | null; stopping: HeldRow | null }
  | { kind: 'extension'; remote: boolean }
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
  /** The `at` of the holder restart result dismissed last, which stays hidden. */
  holderDismissed?: number | null;
  /** Whether the page is this computer's, which offers Pair a device, Open Settings and Restart and resume; false on a paired device. */
  local?: boolean;
  /** Voice on this phone in More Actions, on a paired device's page; null or left out where it is not offered. */
  phoneVoice?: PhoneVoiceState | null;
  /** The connection's dot beside the title; none before the page first connected. */
  connection?: DotView | null;
  /** Whether the list is pinned, for the pin button at the header's end; left out, the header has no pin. */
  pinned?: boolean;
}

/**
 * The dock's notes above its groups, in the warning colour: settings, playbook, hook, source and voice errors and setup notes, then the held
 * sessions without a work item, whose click opens what Held sessions in More Actions opens; then, untoned, why no device has the voice when
 * the phone was lost.
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
      {header?.voiceNote === undefined ? null : (
        <p class="list-note voice-note" role="status">
          {header.voiceNote}
        </p>
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
        {/* Shown only in the phone's layout (page.css), where the list is its own view and no window title names the app. */}
        <span class="list-title">
          <img class="list-title-icon" src="icon-192.png" alt="" width="16" height="16" />
          <span class="list-title-text">Switchboard</span>
          <ConnectionDot dot={view.connection} />
        </span>
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
        <button type="button" class="icon" data-action="list-new-session" title="New session" aria-label="New session">
          <span class="codicon codicon-add" aria-hidden="true"></span>
        </button>
        <div class="menu-anchor" data-key="more">
          <button type="button" class="icon more-actions" data-action="list-more" aria-haspopup="menu" aria-expanded={view.menu === 'more'} title="More Actions…" aria-label="More Actions">
            <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
          </button>
          {view.menu === 'more' ? renderMoreMenu(header, view.local === true, view.phoneVoice ?? null) : null}
        </div>
        {/* Outside the phone's layout (page.css), as VS Code's and the dock's pin: pinned, the list is a column; unpinned, a drawer. Left out where it changes nothing (main.ts). */}
        {view.pinned === undefined ? null : (
          <button type="button" class="icon list-pin" data-action="list-pin" title={view.pinned ? 'Unpin sidebar' : 'Pin sidebar'} aria-label={view.pinned ? 'Unpin sidebar' : 'Pin sidebar'} aria-controls="list">
            <span class={`codicon codicon-${view.pinned ? 'pinned' : 'pin'}`} aria-hidden="true"></span>
          </button>
        )}
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
 * More Actions (PRD R71), in the dock's groups: Held sessions; Refresh sources,
 * Reload, Show hub log and Get the browser extension…; then Pair a device, Open Settings and, while the voice is not on this computer, Voice on the computer, on this computer's
 * page only, or Voice on this phone, on a paired device's.
 * On a phone, where the header has no room for them, the source icons come first as a check row per source.
 */
export function renderMoreMenu(header: PageHeader | null, local = false, phoneVoice: PhoneVoiceState | null = null): VNode {
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

  return (
    <ul class="glass menu more-menu" role="menu" aria-label="More Actions">
      {sources.length === 0 ? null : [...sources, <Separator classes="menu-separator more-source" />]}
      <MoreRow action="list-later-held" icon="terminal" label="Held sessions" />
      <Separator />
      <MoreRow action="list-poll" icon="refresh" label="Refresh sources" />
      <MoreRow action="list-reload" icon="debug-restart" label="Reload" />
      <MoreRow action="list-log" icon="output" label="Show hub log" />
      <MoreRow action="list-extension" icon="extensions" label="Get the browser extension…" />
      {local ? (
        <>
          <Separator />
          <MoreRow action="list-devices" icon="device-mobile" label="Pair a device…" />
          <MoreRow action="list-settings" icon="settings-gear" label="Open Settings" />
          {header?.voiceDevice === undefined ? null : (
            <li role="none">
              <button type="button" class="menu-row" role="menuitemcheckbox" aria-checked="false" data-action="list-voice-computer" title={header.voiceDevice === 'phone' ? "Voice is on a paired device. Select Voice on the computer to use this computer's microphone and speaker." : "Voice is off. Select Voice on the computer to use this computer's microphone and speaker."}>
                <Gutter checked={false} />
                <span class="title">Voice on the computer</span>
              </button>
            </li>
          )}
        </>
      ) : null}
      {!local && phoneVoice !== null ? (
        <>
          <Separator />
          <li role="none">
            <button type="button" class="menu-row" role="menuitemcheckbox" aria-checked={phoneVoice !== 'off'} data-action="list-phone-voice" title="Use this device's microphone and speaker for voice.">
              <Gutter checked={phoneVoice !== 'off'} />
              <span class="title">{phoneVoice === 'connecting' ? 'Voice on this device…' : 'Voice on this device'}</span>
            </button>
          </li>
        </>
      ) : null}
    </ul>
  );
}

/** The dock windows More Actions opens that the page does not have yet, by their row's action. */
export const LATER: Record<string, string> = {};

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
export function usedText(at: number): string {
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
                  {one.voice === true ? ' · voice allowed' : ''}
                </span>
              </span>
              {one.host === null ? null : (
                <button type="button" class="sheet-button secondary" data-action="list-device-voice" data-id={one.id} data-allow={one.voice === true ? '0' : '1'} disabled={sheet.busy} title={one.voice === true ? "Stop this device from using voice; its current voice connection will close." : "Allow this device to use its microphone and speaker for voice."}>
                  {one.voice === true ? 'Forbid voice' : 'Allow voice'}
                </button>
              )}
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

/** The frame every sheet of the header has: its title, its body and its buttons, over a backdrop that cancels it; `wide` names a wide sheet's class. */
function Frame({ title, children, buttons, wide }: { title: string; children: ComponentChildren; buttons: ComponentChildren; wide?: 'hub-log-sheet' | 'held-sheet' }) {
  return (
    <div class="sheet-backdrop" data-action="list-sheet-cancel">
      <div class={`sheet glass${wide === undefined ? '' : ` ${wide}`}`} role="dialog" aria-modal="true" aria-labelledby="list-sheet-title">
        <h2 id="list-sheet-title" class="sheet-title">
          {title}
        </h2>
        {children}
        <div class="sheet-buttons">{buttons}</div>
      </div>
    </div>
  );
}

function HeldSheet({ sheet }: { sheet: Extract<HeaderSheet, { kind: 'held' }> }) {
  const stopping = sheet.stopping;
  return <Frame title="Held sessions" wide="held-sheet" buttons={<>
    <button type="button" class="sheet-button secondary" data-action="list-held-refresh" disabled={sheet.busy}>Refresh</button>
    <button type="button" class="sheet-button primary" data-action="list-sheet-cancel">Close</button>
  </>}>
    <p class="sheet-detail">Code Mode sessions the terminal holder keeps alive, with or without a work item. Stop ends a session's process.</p>
    {sheet.error === null ? null : <p class="sheet-error" role="alert">{sheet.error}</p>}
    {sheet.listError === null ? null : <p class="sheet-error" role="alert">{sheet.listError}</p>}
    {sheet.result === null ? null : <p role="status">{sheet.result}</p>}
    {stopping === null ? null : <div class="held-confirm" role="group" aria-label="Confirm Stop">
      <h3 class="sheet-title">{stopping.orphan ? `Stop held session ${stopping.session}?` : `Stop the held session of ${stopping.item}?`}</h3>
      <p class="sheet-detail">{`Session ${stopping.session} in ${stopping.cwd}. Its process ends and anything it is doing stops.`}</p>
      <div class="sheet-buttons"><button type="button" class="sheet-button secondary" data-action="list-held-cancel" disabled={sheet.busy}>Cancel</button><button type="button" class="sheet-button primary" data-action="list-held-confirm" disabled={sheet.busy}>Stop</button></div>
    </div>}
    {sheet.rows === null ? (sheet.listError === null ? <p class="sheet-detail" role="status">Loading…</p> : null) : sheet.rows.length === 0 ? <p class="sheet-detail">No held sessions. Code Mode sessions appear here while the terminal holder keeps them.</p> : <div class="held-rows">
      {sheet.rows.map((row) => <section class="held-row" key={row.session} aria-label={`${row.item}: ${row.session}`}>
        <dl>{[['Work item', row.item], ['Switchboard ID', row.session], ['Claude ID', row.nativeSessionId], ['Folder', row.cwd], ['State', row.state], ['Idle', row.idle], ['Memory', row.memory], ['Terminals', String(row.clients)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}</dl>
        <div class="sheet-buttons"><button type="button" class="sheet-button secondary" data-action="list-held-open" data-id={row.session} disabled={sheet.busy || row.terminal === null}>Open in terminal</button><button type="button" class="sheet-button secondary" data-action="list-held-stop" data-id={row.session} disabled={sheet.busy || row.exited}>Stop</button></div>
      </section>)}
    </div>}
  </Frame>;
}

/** Where the page downloads the browser extension (PRD R121); the hub's `EXTENSION_DOWNLOAD`. */
export const EXTENSION_DOWNLOAD = '/page/switchboard-extension.zip';

/**
 * Get the browser extension (PRD R121): the download and how to load it unpacked in Chrome or Edge. A paired device's copy reaches the hub through
 * this page's address with this browser's sign-in, so it is loaded in the browser the page is open in.
 */
function ExtensionSheet({ remote }: { remote: boolean }) {
  return (
    <Frame
      title="Get the browser extension"
      buttons={
        <>
          <button type="button" class="sheet-button secondary" data-action="list-sheet-cancel">
            Close
          </button>
          <a class="sheet-button primary" href={EXTENSION_DOWNLOAD} download="switchboard-extension.zip">
            Download
          </a>
        </>
      }
    >
      <p class="sheet-detail">
        {remote
          ? 'The extension shows Switchboard on GitHub project boards. This copy reaches Switchboard through this page, signed in as this browser is, so load it in this browser.'
          : 'The extension shows Switchboard on GitHub project boards. This copy reaches Switchboard on this computer.'}
      </p>
      <ol class="sheet-detail extension-steps">
        <li>Download the extension and extract the zip.</li>
        <li>
          Open <code>chrome://extensions</code> in Chrome or <code>edge://extensions</code> in Edge, and turn on Developer mode.
        </li>
        <li>
          Select Load unpacked and choose the extracted <code>switchboard-extension</code> folder.
        </li>
      </ol>
    </Frame>
  );
}

/**
 * A sheet of the header (architecture.md § Web page), drawn as the page's other sheets: the New session form and its folder browser, Pair a
 * device, Get the browser extension, Restart the terminal holder, or a dock window the page does not have yet. `local`: whether the page is
 * this computer's.
 */
export function renderHeaderSheet(sheet: HeaderSheet | null, header: PageHeader | null, now = Date.now(), read = globalThis.fetch, local = true): VNode | null {
  if (sheet === null) {
    return null;
  }

  if (sheet.kind === 'devices') {
    return <DevicesSheet sheet={sheet} now={now} />;
  }

  if (sheet.kind === 'log') {
    return <Frame title="Hub log" wide="hub-log-sheet" buttons={<button type="button" class="sheet-button primary" data-action="list-sheet-cancel">Close</button>}><HubLog fetch={read} /></Frame>;
  }
  if (sheet.kind === 'held') return <HeldSheet sheet={sheet} />;

  if (sheet.kind === 'extension') {
    return <ExtensionSheet remote={sheet.remote} />;
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
  return <NewSession sheet={sheet} header={header} cancel={cancel} error={error} local={local} />;
}

/** The provider's name as the form shows it. */
function providerName(provider: string): string {
  return PROVIDERS.find((one) => one.provider === provider)?.name ?? provider;
}

/** The folder list's groups, each folder once, filtered by the typed text unless it is a folder of the list. */
export function folderGroups(places: FolderPlaces | null, typed: string): Array<{ label: string; folders: string[] }> {
  const all = places === null ? [] : [...places.recent, ...places.repoRoots, ...places.worktrees];
  const text = typed.trim().toLocaleLowerCase();
  const filter = text !== '' && !all.some((one) => one.toLocaleLowerCase() === text);
  const keep = (folders: string[]) => (filter ? folders.filter((one) => one.toLocaleLowerCase().includes(text)) : folders);

  return [
    { label: 'Recent', folders: keep(places?.recent ?? []) },
    { label: 'Repo roots', folders: keep(places?.repoRoots ?? []) },
    { label: 'Worktrees', folders: keep(places?.worktrees ?? []) },
  ].filter((group) => group.folders.length > 0);
}

/** A folder path's parts, as the folder browser's breadcrumb shows them. */
export function pathParts(path: string): string[] {
  return path.split(/[\\/]+/).filter((part) => part !== '');
}

/** The folder browser (PRD R122): the starting places, or a folder's subfolders, from `page-folders`. */
function Browser({ browser, places, local }: { browser: FolderBrowser; places: FolderPlaces | null; local: boolean }) {
  const row = (path: string, label: string, icon = 'folder') => (
    <li role="none">
      <button type="button" class="folder-row" role="option" data-action="list-browse-open" data-path={path} title={path}>
        <span class={`codicon codicon-${icon}`} aria-hidden="true"></span>
        <span class="folder-name">{label}</span>
      </button>
    </li>
  );
  const groups =
    browser.path === null
      ? [
          { label: 'Recent', folders: places?.recent ?? [] },
          { label: 'Repo roots', folders: places?.repoRoots ?? [] },
          { label: 'Worktrees', folders: places?.worktrees ?? [] },
          { label: 'This computer', folders: places?.computer ?? [] },
        ].filter((group) => group.folders.length > 0)
      : [];

  return (
    <Frame
      title="Choose a folder"
      buttons={
        <>
          <button type="button" class="sheet-button secondary" data-action="list-browse-back">
            Back
          </button>
          <button type="button" class="sheet-button primary" data-action="list-browse-use" disabled={browser.path === null || browser.busy}>
            Use this folder
          </button>
        </>
      }
    >
      {browser.path === null ? null : (
        <p class="folder-crumbs" title={browser.path}>
          <button type="button" class="icon folder-places" data-action="list-browse-places" title="Starting places" aria-label="Starting places">
            <span class="codicon codicon-home" aria-hidden="true"></span>
          </button>
          {pathParts(browser.path).map((part, index) => (
            <>
              {index === 0 ? null : <span class="folder-crumb-gap" aria-hidden="true">›</span>}
              <span class="folder-crumb">{part}</span>
            </>
          ))}
        </p>
      )}
      <ul class="folder-browser" role="listbox" aria-label="Folders" data-key="folder-browser">
        {browser.path === null
          ? groups.map((group) => (
              <>
                <li class="folder-group" role="presentation">
                  {group.label}
                </li>
                {group.folders.map((one) => row(one, one))}
              </>
            ))
          : [
              browser.parent === null ? null : row(browser.parent, '..', 'arrow-up'),
              ...browser.folders.map((one) => row(one.path, one.name)),
              browser.folders.length === 0 && !browser.busy ? (
                <li class="folder-empty" role="presentation">
                  No folders here.
                </li>
              ) : null,
            ]}
      </ul>
      {browser.more ? <p class="sheet-detail">Only the first folders are listed. Type the path to reach the others.</p> : null}
      {browser.error === null ? null : (
        <p class="sheet-error" role="alert">
          {browser.error}
        </p>
      )}
      {local ? null : <p class="sheet-detail">On a paired device: only folders under recent folders, repo roots and worktrees.</p>}
    </Frame>
  );
}

/**
 * The New session form (PRD R122): Folder, Provider (hidden with one installed), Model, an optional First message, Run as once there is one, and
 * More options' Run a schedule now (PRD R82), which hides the other fields.
 */
function NewSession({ sheet, header, cancel, error, local }: { sheet: NewSessionSheet; header: PageHeader | null; cancel: ComponentChildren; error: ComponentChildren; local: boolean }) {
  if (sheet.browser !== null) {
    return <Browser browser={sheet.browser} places={sheet.places} local={local} />;
  }

  const schedules = header?.schedules ?? [];
  const scheduled = sheet.schedule !== '' && schedules.some((one) => one.name === sheet.schedule);
  const installed = sheet.installed;
  const message = sheet.prompt.trim() !== '';
  const configured = sheet.models[sheet.provider] ?? '';
  const choices = sheet.choices[sheet.provider] ?? [];
  const ready = !sheet.busy && (scheduled || (sheet.folder.trim() !== '' && sheet.folderError === null && installed !== null && installed.length > 0 && (sheet.model !== OTHER_MODEL || sheet.otherModel.trim() !== '')));
  const label = scheduled ? 'Run' : message && sheet.run === 'wait' ? 'Create' : 'Start';
  const groups = folderGroups(sheet.places, sheet.folder);

  return (
    <Frame
      title="New session"
      buttons={
        <>
          {cancel}
          <button type="button" class="sheet-button primary" data-action="list-sheet-go" disabled={!ready}>
            {label}
          </button>
        </>
      }
    >
      {scheduled ? null : (
        <>
          <div class="sheet-field folder-field">
            <label class="sheet-label" for="new-session-folder">
              Folder
            </label>
            <div class="folder-combo">
              <input id="new-session-folder" class="sheet-select folder-input" data-field="folder" value={sheet.folder} placeholder="Choose or type a folder" autocomplete="off" spellcheck={false} role="combobox" aria-expanded={sheet.folderOpen} aria-controls="new-session-folders" />
              <button type="button" class="icon folder-toggle" data-action="list-folder-toggle" title="Show folders" aria-label="Show folders">
                <span class={`codicon codicon-chevron-${sheet.folderOpen ? 'up' : 'down'}`} aria-hidden="true"></span>
              </button>
            </div>
            {sheet.folderOpen ? (
              <ul id="new-session-folders" class="folder-menu" role="listbox" aria-label="Folders">
                {groups.map((group) => (
                  <>
                    <li class="folder-group" role="presentation">
                      {group.label}
                    </li>
                    {group.folders.map((one) => (
                      <li role="none">
                        <button type="button" class="folder-row" role="option" aria-selected={one === sheet.folder} data-action="list-folder-pick" data-path={one} title={one}>
                          <span class="folder-name">{one}</span>
                        </button>
                      </li>
                    ))}
                  </>
                ))}
                <li role="none">
                  <button type="button" class="folder-row browse" role="option" data-action="list-folder-browse">
                    <span class="folder-name">Browse…</span>
                  </button>
                </li>
              </ul>
            ) : null}
            {sheet.folderError === null ? null : <span class="sheet-error">{sheet.folderError}</span>}
          </div>
          {installed === null ? (
            <p class="sheet-detail">Loading the providers…</p>
          ) : installed.length > 1 ? (
            <div class="sheet-field">
              <span class="sheet-label">Provider</span>
              <div class="provider-switch" role="group" aria-label="Provider">
                {PROVIDERS.filter((one) => installed.includes(one.provider)).map((one) => (
                  <button type="button" class="provider-option" data-action="list-provider" data-provider={one.provider} aria-pressed={one.provider === sheet.provider}>
                    {trusted(providerMark(one.provider, 'provider-option-mark'))}
                    <span>{one.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <label class="sheet-field">
            <span class="sheet-label">Model</span>
            <select class="sheet-select" data-field="model">
              <Options
                items={[{ value: '', label: `Default (${configured === '' ? `${providerName(sheet.provider)}'s default` : configured})` }, ...choices.map((one) => ({ value: one.id, label: one.label })), { value: OTHER_MODEL, label: 'Other…' }]}
                chosen={sheet.model}
              />
            </select>
            {sheet.model === OTHER_MODEL ? <input class="sheet-select" data-field="otherModel" value={sheet.otherModel} placeholder="Model name" maxLength={200} autocomplete="off" spellcheck={false} aria-label="Model name" /> : null}
          </label>
          <label class="sheet-field">
            <span class="sheet-label">First message</span>
            <textarea class="sheet-prompt" data-field="prompt" rows={4} placeholder="Optional. Leave empty to open an empty session." value={sheet.prompt}></textarea>
          </label>
          {message ? (
            <fieldset class="sheet-field run-as">
              <legend>Run as</legend>
              {RUN_AS.map((one) => (
                <label class="sheet-choice">
                  <input type="radio" name="new-session-run" data-field="run" value={one.value} checked={sheet.run === one.value} />
                  <span>{one.label}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
        </>
      )}
      {schedules.length === 0 ? null : (
        <div class="sheet-field more-options">
          <button type="button" class="more-options-toggle" data-action="list-more-options" aria-expanded={sheet.more}>
            <span class={`codicon codicon-chevron-${sheet.more ? 'down' : 'right'}`} aria-hidden="true"></span>
            <span>More options</span>
          </button>
          {sheet.more ? (
            <Select label="Run a schedule now" field="schedule" items={[{ value: '', label: 'None' }, ...schedules.map((one) => ({ value: one.name, label: `Run ${one.name} now · ${one.playbook}` }))]} chosen={sheet.schedule} after={scheduled ? <span class="sheet-note">The schedule's playbook and folder are used; the other fields are hidden.</span> : null} />
          ) : null}
        </div>
      )}
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
  clearSearch(): void;
  /** Draws the header for the hub's latest header and list. */
  draw(header: PageHeader | null, groups: readonly PageGroup[]): void;
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
  const view: HeaderView = { menu: null, search, sheet: null, local: deps.local === true };
  let ops = 0;
  const newOp = (): string => `header-${deps.now().toString(36)}-${(++ops).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let shown: PageHeader | null = null;
  let shownVoiceError: string | null = null;
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
  /** Turns one source on or off; the hub's next list shows the change, and a refusal shows in the toast. */
  const setSource = async (name: string, enabled: boolean): Promise<void> => {
    deps.refused(null);
    redraw();

    const answer = await deps.post('page-source', { name, enabled });

    if (answer.status !== 200) {
      deps.refused(String(answer.body['error'] ?? 'The source was not changed.'));
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
    deps.refused(null);
    redraw();

    const answer = await deps.post('page-poll', {});

    if (answer.status !== 200) {
      deps.refused(String(answer.body['error'] ?? 'The sources were not polled.'));
    }
  };
  /** The Run as this device chose last, Conversation, start now by default. */
  const lastRun = (): RunAs => {
    try {
      const kept = globalThis.localStorage?.getItem(RUN_AS_KEY);

      return kept === 'queue' || kept === 'wait' ? kept : 'now';
    } catch {
      return 'now';
    }
  };
  const keepRun = (run: RunAs): void => {
    try {
      globalThis.localStorage?.setItem(RUN_AS_KEY, run);
    } catch {
      // A browser that keeps nothing offers the default next time.
    }
  };
  // Each folder check asked of the hub while the operator types, so a newer one drops an older answer.
  let folderCheck = 0;
  let folderTimer: ReturnType<typeof setTimeout> | null = null;
  /** Asks the hub whether the typed folder can be used, shortly after the last key; its refusal shows under the field. */
  const checkFolder = (sheet: NewSessionSheet): void => {
    if (folderTimer !== null) {
      clearTimeout(folderTimer);
    }

    const run = ++folderCheck;
    const path = sheet.folder.trim();

    folderTimer = setTimeout(() => {
      folderTimer = null;

      if (path === '') {
        sheet.folderError = null;
        redraw();
        return;
      }

      void deps.post('page-folders', { path }).then((answer) => {
        if (run !== folderCheck || view.sheet !== sheet) {
          return;
        }

        sheet.folderError = answer.status === 200 ? null : String(answer.body['error'] ?? 'Switchboard did not check the folder.');
        redraw();
      });
    }, FOLDER_CHECK_MS);
  };
  /** Opens the folder browser at `path`, or at the starting places with null. */
  const browse = async (sheet: NewSessionSheet, path: string | null): Promise<void> => {
    const browser: FolderBrowser = { path: sheet.browser?.path ?? null, parent: sheet.browser?.parent ?? null, folders: sheet.browser?.folders ?? [], more: false, busy: true, error: null };

    sheet.browser = browser;
    sheet.folderOpen = false;

    if (path === null) {
      sheet.browser = { path: null, parent: null, folders: [], more: false, busy: false, error: null };
      redraw();
      return;
    }

    redraw();

    const answer = await deps.post('page-folders', { path });

    if (sheet.browser !== browser) {
      return;
    }

    browser.busy = false;

    if (answer.status === 200) {
      browser.path = String(answer.body['path'] ?? path);
      browser.parent = typeof answer.body['parent'] === 'string' ? answer.body['parent'] : null;
      browser.folders = Array.isArray(answer.body['folders']) ? (answer.body['folders'] as FolderBrowser['folders']) : [];
      browser.more = answer.body['more'] === true;
    } else {
      browser.error = String(answer.body['error'] ?? 'Switchboard did not list the folder.');
    }

    redraw();
  };
  /**
   * The + button's New session form (PRD R122): the folder used last, else the first repo root; the default provider and Default model; Run as
   * as this device chose last.
   */
  const openNew = async (): Promise<void> => {
    const sheet: NewSessionSheet = {
      kind: 'new',
      opId: newOp(),
      folder: '',
      folderError: null,
      folderOpen: false,
      places: null,
      browser: null,
      provider: 'claude',
      installed: null,
      models: {},
      choices: {},
      model: '',
      otherModel: '',
      prompt: '',
      run: lastRun(),
      more: false,
      schedule: '',
      busy: false,
      error: null,
    };

    view.sheet = sheet;
    redraw();
    sheetHost.querySelector<HTMLElement>('.sheet-prompt')?.focus();

    const [providers, places] = await Promise.all([deps.post('providers', {}), deps.post('page-folders', {})]);

    if (view.sheet !== sheet) {
      return;
    }

    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []);

    if (places.status === 200) {
      sheet.places = { recent: strings(places.body['recent']), repoRoots: strings(places.body['repoRoots']), worktrees: strings(places.body['worktrees']), computer: strings(places.body['computer']) };
    }

    // A folder typed while the hub answered stays.
    if (sheet.folder === '') {
      sheet.folder = sheet.places?.recent[0] ?? sheet.places?.repoRoots[0] ?? shown?.repoRoots[0] ?? '';
    }

    const installed: string[] = providers.status === 200 ? strings(providers.body['installed']).filter((one) => one === 'claude' || one === 'codex') : [];
    const named = String(providers.body['defaultProvider'] ?? '');
    const models = providers.body['models'];
    const choices = providers.body['modelChoices'];

    sheet.installed = installed;
    sheet.error = installed.length === 0 ? String(providers.body['error'] ?? 'Neither Claude nor Codex is installed.') : null;
    sheet.provider = installed.includes(named) ? named : (installed[0] ?? 'claude');
    sheet.models = models !== null && typeof models === 'object' ? Object.fromEntries(Object.entries(models).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
    sheet.choices =
      choices !== null && typeof choices === 'object'
        ? Object.fromEntries(
            Object.entries(choices as Record<string, unknown>).map(([provider, list]) => [
              provider,
              Array.isArray(list) ? list.filter((one): one is { id: string; label: string } => typeof one?.id === 'string' && one.id !== '' && typeof one?.label === 'string') : [],
            ]),
          )
        : {};
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
  /** Signs one device out, or allows or forbids voice on it, then lists the devices again. */
  const changeDevice = async (command: 'page-device-revoke' | 'page-device-voice', body: Record<string, unknown>, failed: string): Promise<void> => {
    const sheet = view.sheet;

    if (sheet?.kind !== 'devices' || sheet.busy) {
      return;
    }

    sheet.busy = true;
    sheet.error = null;
    redraw();

    const answer = await deps.post(command, body);
    const devices = await deps.post('page-devices', {});

    sheet.busy = false;
    sheet.error = answer.status === 200 ? null : String(answer.body['error'] ?? failed);
    sheet.devices = devices.status === 200 ? ((devices.body['devices'] as Device[] | undefined) ?? []) : sheet.devices;
    redraw();
  };
  const revokeDevice = (id: string): Promise<void> => changeDevice('page-device-revoke', { id }, 'The device was not signed out.');
  let heldTimer: ReturnType<typeof setTimeout> | null = null;
  let heldRead = 0;
  const refreshHeld = async (sheet: Extract<HeaderSheet, { kind: 'held' }>): Promise<void> => {
    if (sheet.busy || sheet.refreshing || view.sheet !== sheet) return;
    if (heldTimer !== null) clearTimeout(heldTimer);
    sheet.refreshing = true;
    const read = ++heldRead;
    const answer = await deps.post('held-list', {});
    sheet.refreshing = false;
    if (view.sheet !== sheet) return;
    if (read !== heldRead) {
      void refreshHeld(sheet);
      return;
    }
    if (answer.status === 200) {
      sheet.rows = (answer.body['held'] as HeldRow[] | undefined) ?? [];
      sheet.listError = null;
    } else sheet.listError = String(answer.body['error'] ?? 'Held sessions could not be listed.');
    redraw();
    heldTimer = setTimeout(() => { if (sheet.stopping === null) void refreshHeld(sheet); }, 5000);
  };
  const heldAction = async (command: 'held-stop' | 'held-open', id: string): Promise<void> => {
    const sheet = view.sheet;
    if (sheet?.kind !== 'held' || sheet.busy) return;
    heldRead++;
    sheet.busy = true;
    sheet.error = null;
    sheet.result = null;
    redraw();
    const answer = await deps.post(command, { id });
    if (view.sheet !== sheet) return;
    sheet.busy = false;
    if (answer.status !== 200) sheet.error = String(answer.body['error'] ?? 'Switchboard did not answer.');
    else sheet.result = command === 'held-stop' ? `Stopped held session ${id}.` : 'Opening terminal…';
    sheet.stopping = null;
    redraw();
    await refreshHeld(sheet);
  };
  const closeSheet = (): void => {
    if (view.sheet !== null && view.sheet.kind !== 'log' && view.sheet.kind !== 'later' && view.sheet.kind !== 'extension' && view.sheet.kind !== 'devices' && view.sheet.kind !== 'held' && view.sheet.busy) {
      return;
    }

    if (heldTimer !== null) clearTimeout(heldTimer);
    view.sheet = null;
    redraw();
    host.querySelector<HTMLElement>('.more-actions')?.focus();
  };
  /** Create, or Run: sends the sheet; a refusal keeps it open with the hub's reason, as the dock's windows do. */
  const sheetGo = async (): Promise<void> => {
    const sheet = view.sheet;

    if (sheet === null || sheet.kind === 'log' || sheet.kind === 'later' || sheet.kind === 'extension' || sheet.kind === 'held' || sheet.busy) {
      return;
    }

    if (sheet.kind === 'devices') {
      await pairAgain(sheet);
      return;
    }

    sheet.busy = true;
    sheet.error = null;
    redraw();

    if (sheet.kind === 'holder') {
      const answer = await deps.post('page-holder-restart', { detail: shown?.holderNotice?.confirm?.detail ?? '' });

      sheet.busy = false;
      sheet.error = answer.status === 200 ? null : String(answer.body['error'] ?? 'Switchboard did not answer.');

      if (answer.status === 200 && view.sheet === sheet) {
        view.sheet = null;
      }

      redraw();
      return;
    }

    const scheduled = sheet.schedule !== '' && (shown?.schedules ?? []).some((one) => one.name === sheet.schedule);
    const message = sheet.prompt.trim();
    const run: RunAs = message === '' ? 'now' : sheet.run;
    const model = sheet.model === '' ? null : sheet.model === OTHER_MODEL ? sheet.otherModel.trim() : sheet.model;
    const answer = scheduled
      ? await deps.post('page-adhoc', { opId: sheet.opId, schedule: sheet.schedule })
      : await deps.post('page-new-session', { opId: sheet.opId, folder: sheet.folder.trim(), provider: sheet.provider, model, ...(message === '' ? {} : { prompt: message }), run });

    sheet.busy = false;

    if (answer.status !== 200) {
      sheet.error = String(answer.body['error'] ?? 'Switchboard did not answer.');
      redraw();
      return;
    }

    if (!scheduled && message !== '') {
      keepRun(run);
    }

    if (view.sheet === sheet) {
      view.sheet = null;
    }

    redraw();

    // Every outcome's work item opens, a task that waits or queues included.
    if (typeof answer.body['workItemId'] === 'number') {
      deps.select(answer.body['workItemId']);
    }
  };
  /** A field of the New session form changed: kept, so a redraw shows it as typed; a typed folder is checked by the hub. */
  const fieldChanged = (event: Event): void => {
    const field = event.target as HTMLInputElement;
    const name = field.dataset?.['field'];
    const sheet = view.sheet;

    if (name === undefined || sheet?.kind !== 'new') {
      return;
    }

    switch (name) {
      case 'folder':
        if (sheet.folder !== field.value) {
          sheet.folder = field.value;
          sheet.folderError = null;
          sheet.folderOpen = event.type === 'input';
          checkFolder(sheet);
        }

        break;
      case 'model':
        sheet.model = field.value;
        break;
      case 'otherModel':
        sheet.otherModel = field.value;
        break;
      case 'prompt':
        sheet.prompt = field.value;
        break;
      case 'run':
        if (field.checked && RUN_AS.some((one) => one.value === field.value)) {
          sheet.run = field.value as RunAs;
        }

        break;
      case 'schedule':
        sheet.schedule = field.value;
        break;
      default:
        return;
    }

    redraw();
  };
  /** A click on the New session form's own controls: the folder list, the folder browser, the provider switch and More options. */
  const formClicked = (sheet: NewSessionSheet, action: string, button: HTMLElement): boolean => {
    switch (action) {
      case 'list-folder-toggle':
        sheet.folderOpen = !sheet.folderOpen;
        break;
      case 'list-folder-pick':
        sheet.folder = button.dataset['path'] ?? '';
        sheet.folderOpen = false;
        sheet.folderError = null;
        checkFolder(sheet);
        break;
      case 'list-folder-browse':
        void browse(sheet, sheet.folder.trim() !== '' && sheet.folderError === null ? sheet.folder.trim() : null);
        return true;
      case 'list-browse-open':
        void browse(sheet, button.dataset['path'] ?? null);
        return true;
      case 'list-browse-places':
        void browse(sheet, null);
        return true;
      case 'list-browse-back':
        sheet.browser = null;
        break;
      case 'list-browse-use':
        if (sheet.browser?.path != null) {
          sheet.folder = sheet.browser.path;
          sheet.folderError = null;
          sheet.browser = null;
        }

        break;
      case 'list-provider': {
        const provider = button.dataset['provider'] ?? '';

        if (provider !== sheet.provider && (sheet.installed ?? []).includes(provider)) {
          sheet.provider = provider;
          // Each provider has its own models, so the choice goes back to Default.
          sheet.model = '';
          sheet.otherModel = '';
        }

        break;
      }
      case 'list-more-options':
        sheet.more = !sheet.more;
        sheet.schedule = sheet.more ? sheet.schedule : '';
        break;
      default:
        return false;
    }

    redraw();
    return true;
  };

  sheetHost.addEventListener('input', fieldChanged);
  sheetHost.addEventListener('change', fieldChanged);
  sheetHost.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLElement>('[data-action]');

    const action = button?.dataset['action'];
    const held = view.sheet?.kind === 'held' ? view.sheet : null;
    if (view.sheet?.kind === 'new' && button !== null && formClicked(view.sheet, action ?? '', button)) {
      return;
    }

    if (held !== null && action?.startsWith('list-held-')) {
      if (action === 'list-held-refresh') { held.error = null; void refreshHeld(held); }
      else if (action === 'list-held-open') void heldAction('held-open', button!.dataset['id'] ?? '');
      else if (action === 'list-held-confirm' && held.stopping !== null) void heldAction('held-stop', held.stopping.session);
      else if (action === 'list-held-cancel') { held.stopping = null; void refreshHeld(held); }
      else if (action === 'list-held-stop' && !held.busy) {
        held.stopping = held.rows?.find((row) => row.session === button!.dataset['id'] && !row.exited) ?? null;
        redraw();
        sheetHost.querySelector<HTMLElement>('[data-action="list-held-cancel"]')?.focus();
      }
    } else if (button?.dataset['action'] === 'list-sheet-go') {
      void sheetGo();
    } else if (button?.dataset['action'] === 'list-device-revoke') {
      void revokeDevice(button.dataset['id'] ?? '');
    } else if (button?.dataset['action'] === 'list-device-voice') {
      void changeDevice('page-device-voice', { id: button.dataset['id'] ?? '', allow: button.dataset['allow'] === '1' }, 'Voice was not changed on the device.');
    } else if (button?.dataset['action'] === 'list-sheet-cancel' && (!button.classList.contains('sheet-backdrop') || target === button)) {
      // A press on the sheet itself is not one on its backdrop.
      closeSheet();
    }
  });
  sheetHost.addEventListener('keydown', (event) => {
    const sheet = view.sheet;

    // Escape closes the folder list, then the folder browser, then the form.
    if (event.key === 'Escape' && sheet?.kind === 'new' && (sheet.folderOpen || sheet.browser !== null)) {
      event.stopPropagation();
      sheet.folderOpen = false;
      sheet.browser = null;
      redraw();
    } else if (event.key === 'Escape') {
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
      case 'list-new-session':
        view.menu = null;
        void openNew();
        break;
      case 'list-poll':
        view.menu = null;
        void refresh();
        break;
      case 'list-reload':
        view.menu = null;
        redraw();
        (deps.reload ?? (() => location.reload()))();
        break;
      case 'list-devices':
        view.menu = null;
        void openDevices();
        break;
      case 'list-extension':
        view.menu = null;
        view.sheet = { kind: 'extension', remote: view.local !== true };
        redraw();
        sheetHost.querySelector<HTMLElement>('.sheet-button.primary')?.focus();
        break;
      case 'list-log':
        view.menu = null;
        view.sheet = { kind: 'log' };
        redraw();
        sheetHost.querySelector<HTMLElement>('input')?.focus();
        break;
      case 'list-later-held': {
        view.menu = null;
        const sheet: Extract<HeaderSheet, { kind: 'held' }> = { kind: 'held', rows: null, busy: false, refreshing: false, listError: null, error: null, result: null, stopping: null };
        view.sheet = sheet;
        redraw();
        void refreshHeld(sheet);
        sheetHost.querySelector<HTMLElement>('[data-action="list-sheet-cancel"].sheet-button')?.focus();
        break;
      }
      case 'list-settings':
        view.menu = null;
        redraw();
        deps.openSettings?.();
        break;
      case 'list-voice-computer':
        view.menu = null;
        deps.refused(null);
        redraw();
        void deps.post('page-voice-computer', {}).then((answer) => {
          if (answer.status !== 200) {
            deps.refused(String(answer.body['error'] ?? 'The voice did not move to this computer.'));
          }
        });
        break;
      case 'list-phone-voice':
        // Called in the tap itself, which iOS needs to let the page start audio.
        view.menu = null;
        deps.phoneVoice?.toggle();
        redraw();
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
    clearSearch: () => { search.range = 0; setFilter(''); },
    draw: (header, listed) => {
      shown = header;
      groups = listed;

      // A kind whose menu is open and that is gone, or now has one source, has no menu.
      if (view.menu?.startsWith('source:') === true && (header?.sources.find((one) => `source:${one.kind}` === view.menu)?.sources.length ?? 0) < 2) {
        view.menu = null;
      }

      view.phoneVoice = view.local === true ? null : (deps.phoneVoice?.state() ?? null);

      const pinned = deps.pinned?.();

      if (pinned === undefined) {
        delete view.pinned;
      } else {
        view.pinned = pinned;
      }

      const voiceError = view.local === true ? null : (deps.phoneVoice?.error() ?? null);

      // Why the voice left this phone shows in the toast once.
      if (voiceError !== null && voiceError !== shownVoiceError) {
        deps.refused(voiceError);
      }

      shownVoiceError = voiceError;
      view.connection = deps.connection?.() ?? null;
      mount(host, renderListHeader(header, view));
      mount(sheetHost, renderHeaderSheet(view.sheet, header, deps.now(), deps.fetch, view.local === true));
    },
    list: (listed) => ({ groups: filterGroups(listed, search.filter, search.older), filtering: search.filter.trim() !== '' }),
    end: (filtered) => renderSearchEnd(search, filtered.every((group) => group.rows.length === 0)),
    close: () => {
      mount(sheetHost, null);
      cancelTimer();
      if (heldTimer !== null) clearTimeout(heldTimer);
      view.sheet = null;

      if (folderTimer !== null) {
        clearTimeout(folderTimer);
      }
      document.removeEventListener('pointerdown', outside);
    },
  };
}
