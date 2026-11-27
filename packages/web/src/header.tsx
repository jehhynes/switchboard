// The conversation's header (architecture.md § Web page): the dropdown of the selected work item's conversations, the row's actions, and the
// tabs under it or the switch atop the side column.
import { cloneElement } from 'preact';
import type { ComponentChildren, VNode } from 'preact';
import { providerMark } from '@switchboard/conversation/providerIcons';
import { artifactType } from './artifactIcon.js';
import { FileIcon } from './fileIcons.js';
import { selectedEntry, selectedRow, stateIcon } from './model.js';
import type { PageState } from './model.js';
import { ago, LINK_LABEL_MAX, rowKey, TABS } from './render.js';
import type { SideTab, Tab, View } from './render.js';
import { changesTab, changesUnviewed } from './changes.js';
import type { ChangesView } from './changes.js';
import { LocalTabButton, localTabName } from './localFiles.js';
import type { LocalFilesView } from './localFiles.js';
import { fitTabs, stripTabs, UNMEASURED } from './tabs.js';
import type { DocTab, StripLayout, TabFit } from './tabs.js';
import { ConnectionDot } from './connectionView.js';
import { trusted } from './trusted.js';
import { hasSourceLogo, SourceLogo } from './listHeader.js';
import type { FrameLink } from './iframeBrowser.js';
import type { ArtifactView, PageAction, PageRow } from '@switchboard/protocol';

/** The most links the menu lists by themselves; more go in its Open link submenu. */
const MENU_LINKS = 2;

/** A link's menu label, cut to `LINK_LABEL_MAX` with an ellipsis. */
function clipLabel(label: string): string {
  return label.length > LINK_LABEL_MAX ? `${label.slice(0, LINK_LABEL_MAX - 1).trimEnd()}…` : label;
}

/** A codicon with its words as tooltip and name; a session state's, with its tone, is drawn small and muted unless it needs attention. */
export function Codicon({ icon, text, tone }: { icon: string; text: string; tone?: string }) {
  const [name, modifier] = icon.split('~');

  return <span class={`codicon codicon-${name}${modifier === undefined ? '' : ` codicon-modifier-${modifier}`}${tone === undefined ? '' : ` state-icon tone-${tone}`}`} title={text} role="img" aria-label={text}></span>;
}

const Separator = () => <li class="menu-separator" role="separator"></li>;

/**
 * A row's menu, as rows of a `menu` list (architecture.md § Web page), grouped: the main control, the work controls, the
 * state controls, Add comment…, the order controls, what the row opens (Copy, several drafts in a Copy submenu, Open in VS Code and Open report, History for a work item's row, Open ticket and its
 * links, more than two of them in an Open link submenu), then the controls that ask first; empty when the row offers none. Each item names its
 * row, so a pool ticket's menu in the list runs as the header's does.
 */
/** Whether a row's actions wait: one is running, or the page is offline and could not send it (the operator's decision: no queue). */
const waiting = (view: Pick<View, 'acting' | 'connection'>): boolean => view.acting || (view.connection != null && view.connection.tone !== 'live');

/** Why a row's action waits while offline, as its tooltip. */
const offlineTitle = (view: Pick<View, 'connection'>): string | undefined => (view.connection != null && view.connection.tone !== 'live' ? 'This cannot be done while offline.' : undefined);

export function menuRows(row: PageRow, view: Pick<View, 'acting' | 'linkMenu' | 'copyMenu' | 'connection'>): VNode[] {
  const actions = row.actions;
  const pastes = row.pastes;
  const commands = row.opens;
  const key = rowKey(row);
  const item = (attrs: Record<string, string>, icon: string | null, label: string, after: ComponentChildren = null, classes = ''): VNode => (
    <li role="none">
      <button type="button" class={`menu-row${classes === '' ? '' : ` ${classes}`}`} role="menuitem" data-row={key} {...attrs} disabled={waiting(view)} title={offlineTitle(view) ?? attrs['title']}>
        <span class="menu-gutter" aria-hidden="true">{icon === null ? null : <span class={`codicon codicon-${icon}`}></span>}</span>
        <span class="title">{label}</span>
        {after}
      </button>
    </li>
  );
  const act = (action: PageAction): VNode => item({ 'data-action': 'row-action', 'data-label': action.label }, action.icon, action.label);
  const grouped = (group: PageAction['group']): VNode[] => actions.filter((one) => one.group === group).map(act);
  // A link's label can be free text a session reported, so a long one is cut, whole in its tooltip.
  const link = (which: string, label: string, icon: string | null, classes = ''): VNode =>
    item({ 'data-action': 'open-link', 'data-link': which, ...(label.length > LINK_LABEL_MAX ? { title: label } : {}) }, icon, clipLabel(label), null, classes);
  const submenu = [
    item({ 'data-action': 'link-menu', 'aria-haspopup': 'true', 'aria-expanded': String(view.linkMenu) }, 'link-external', 'Open link', <span class={`codicon codicon-chevron-${view.linkMenu ? 'down' : 'right'}`} aria-hidden="true"></span>),
    ...(view.linkMenu ? row.links.map((one, index) => link(String(index), one.label, null, 'submenu-row')) : []),
  ];
  // One draft copies at once; several open a Copy submenu of their labels.
  const copy =
    pastes.length === 1
      ? [item({ 'data-action': 'row-paste', 'data-label': pastes[0]! }, 'copy', `Copy ${pastes[0]!}`)]
      : pastes.length === 0
        ? []
        : [
            item({ 'data-action': 'copy-menu', 'aria-haspopup': 'true', 'aria-expanded': String(view.copyMenu) }, 'copy', 'Copy', <span class={`codicon codicon-chevron-${view.copyMenu ? 'down' : 'right'}`} aria-hidden="true"></span>),
            ...(view.copyMenu ? pastes.map((label) => item({ 'data-action': 'row-paste', 'data-label': label }, null, label, null, 'submenu-row')) : []),
          ];
  const opens = [
    ...copy,
    // Open report opens its draft in a file tab of the page; Open in VS Code asks the hub to start VS Code.
    ...commands.map((one) => item(one.file === undefined ? { 'data-action': 'row-command', 'data-label': one.label } : { 'data-action': 'row-report', 'data-file': one.file, title: one.file }, one.icon, one.label)),
    // History, which opens the work item's History tab and shows it, in the header's menu and a row's (operator decision 2026-11-27: History is
    // a tab only on request), for every work item, since the tab shows its state without a ticket's History too; a pool ticket has no work item
    // open, so no tab to show it in.
    ...(row.workItemId === null ? [] : [item({ 'data-action': 'row-history' }, 'history', 'History')]),
    ...(row.url === '' ? [] : [link('ticket', 'Open ticket', 'link-external')]),
    ...(row.links.length > MENU_LINKS ? submenu : row.links.map((one, index) => link(String(index), `Open ${one.label}`, 'link-external'))),
  ];
  const groups = [grouped('main'), grouped('work'), grouped('state'), grouped('notes'), grouped('order'), opens, grouped('asking')].filter((group) => group.length > 0);

  return groups.flatMap((group, index) => (index === 0 ? group : [<Separator />, ...group]));
}

/**
 * The header's row actions (architecture.md § Web page): the row's main control as a button, then the row's menu (`menuRows`) under an
 * ellipsis; nothing when the row offers none. A work item open without a row in the list still has History, so its menu holds that alone.
 */
function Actions({ row, view, workItem }: { row: PageRow | null; view: View; workItem: boolean }) {
  const rows =
    row !== null
      ? menuRows(row, view)
      : workItem
        ? [
            <li role="none">
              <button type="button" class="menu-row" role="menuitem" data-action="open-history">
                <span class="menu-gutter" aria-hidden="true"><span class="codicon codicon-history"></span></span>
                <span class="title">History</span>
              </button>
            </li>,
          ]
        : [];

  if (rows.length === 0) {
    return null;
  }

  const main = row?.actions.find((one) => one.group === 'main');

  return (
    <>
      {main === undefined ? null : (
        <button type="button" class="row-main" data-action="row-action" data-row={rowKey(row!)} data-label={main.label} disabled={waiting(view)} title={offlineTitle(view) ?? main.label}>
          <span class={`codicon codicon-${main.icon}`} aria-hidden="true"></span>
          <span class="row-main-label">{main.label}</span>
        </button>
      )}
      <div class="menu-anchor actions-anchor">
        <button type="button" class="actions" data-action="actions" aria-haspopup="menu" aria-expanded={view.actions} title="Work item actions" aria-label="Work item actions">
          <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
        </button>
        {view.actions ? (
          <ul class="glass menu actions-menu" role="menu" aria-label="Work item actions">
            {rows}
          </ul>
        ) : null}
      </div>
    </>
  );
}

type Entry = NonNullable<PageState['scope']>['conversations'][number];
type SessionRow = NonNullable<Entry['sessions']>[number];

/**
 * A session's provider as its mark, the one the New session form shows, in the column after the state codicon on the dropdown's button and every
 * row, so the titles start at one edge; an empty mark of the same width when the provider is unknown.
 */
function ProviderMark({ provider }: { provider: string | undefined }) {
  return provider === undefined || provider === '' ? <span class="provider" aria-hidden="true"></span> : trusted(providerMark(provider));
}

/**
 * An earlier session's row under its conversation's in the dropdown: its state codicon, provider's mark, CLI name and age, checked while the page
 * shows it; choosing it opens it read-only. `SessionLabel` draws it, as it draws the dropdown's button while the page shows it.
 */
function SessionRowButton({ entry, one, state, now }: { entry: Entry; one: SessionRow; state: PageState; now: number }) {
  const shown = state.scope?.earlier === true && state.scope.sessionId === one.sessionId;
  const icon = shown ? stateIcon(state.session?.state, state.session?.waitingFor, state.session?.limit) : stateIcon(one.state);

  return (
    <li role="none" key={one.sessionId}>
      <button type="button" class="menu-row conversation-row session-row" role="menuitemradio" aria-checked={shown} data-action="select-session" data-work-item={String(entry.workItemId)} data-session={one.sessionId} title={`${one.title}, started ${ago(one.startedAt, now)}`}>
        <SessionLabel icon={icon} provider={one.provider} title={one.title} />
        <span class="menu-note">{ago(one.startedAt, now)}</span>
      </button>
    </li>
  );
}

/** A session's state codicon, provider's mark and name, alike on every row of the dropdown and on its button. */
function SessionLabel({ icon, provider, title }: { icon: { icon: string; text: string; tone?: string }; provider: string | undefined; title: string }) {
  return (
    <>
      <Codicon {...icon} />
      <ProviderMark provider={provider} />
      <span class="title">{title}</span>
    </>
  );
}

/** Whether the page's session is this entry's: only while it shows the current one, not an earlier one. */
const showsCurrent = (entry: Entry, state: PageState): boolean => entry.workItemId === state.scope?.workItemId && state.scope.earlier !== true;

/** A conversation's state codicon: the page's session's while it shows it, else the entry's. */
const conversationIcon = (entry: Entry, state: PageState) => (showsCurrent(entry, state) ? stateIcon(state.session?.state, state.session?.waitingFor, state.session?.limit) : stateIcon(entry.state));

/** A conversation's provider: the page's session's while it shows it, else the entry's. */
const conversationProvider = (entry: Entry, state: PageState): string | undefined => (showsCurrent(entry, state) ? (state.session?.provider ?? entry.provider) : entry.provider);

/**
 * The dropdown's button: the state codicon, the work item's title over the session's name, muted and left out when it is the title, the
 * provider's mark, and the unread dot while another conversation has unread items.
 */
function PickerLabel({ icon, provider, title, session, unread = false }: { icon: VNode; provider?: string | undefined; title: string; session?: string | undefined; unread?: boolean }) {
  return (
    <>
      {icon}
      <ProviderMark provider={provider} />
      <span class="picker-text">
        <span class="title">{title}</span>
        {session === undefined || session === title ? null : <span class="picker-session">{session}</span>}
      </span>
      {unread ? <UnreadDot label="Unread replies or state" /> : null}
    </>
  );
}

/**
 * A conversation as each of the dropdown's rows draws it: its current session's state
 * codicon, provider's mark and name as its CLI gives it (`sessionTitle`, the work item's title from a hub that sends none), and the unread dot when
 * `unread` (architecture.md § Unread).
 */
function ConversationLabel({ entry, state, unread = false }: { entry: Entry; state: PageState; unread?: boolean }) {
  return (
    <>
      <SessionLabel icon={conversationIcon(entry, state)} provider={conversationProvider(entry, state)} title={entry.sessionTitle ?? entry.title} />
      {unread ? <UnreadDot label="Unread replies or state" /> : null}
    </>
  );
}


/** The header: the dropdown of the selected work item's conversations, its button drawn as its rows are, and the row's actions. */
export function renderHeader(state: PageState, view: View, now = Date.now()): VNode {
  const scope = state.scope!;
  const earlier = scope.earlier === true ? (selectedEntry(state)?.sessions?.find((one) => one.sessionId === scope.sessionId) ?? null) : null;
  const selected = selectedEntry(state);
  // The button shows the work item's title over the session its row names; its tooltip names both.
  const shownName = earlier?.title ?? selected?.sessionTitle;
  const title = selected?.title ?? scope.title;
  const tooltip = shownName === undefined || shownName === title ? title : `${shownName} · ${title}`;
  // The button carries the dot while a conversation the operator is not looking at has unseen items.
  const othersUnread = scope.conversations.some((entry) => entry.workItemId !== scope.workItemId && entry.unread > 0);
  // New conversation…'s draft shows in the shown work item in place of its current session until its first message starts one.
  const drafting = view.newDraft !== null && view.newDraft.workItemId === scope.workItemId;
  const pickerMenu =
    view.picker ? (
      <ul class="glass menu conversation-menu" role="menu" aria-label="Work items and sessions">
        {scope.conversations.flatMap((entry) => [
          <li role="none" key={entry.workItemId}>
            <button type="button" class="menu-row conversation-row" role="menuitemradio" aria-checked={entry.workItemId === scope.workItemId && scope.earlier !== true && !drafting} data-action="select" data-work-item={String(entry.workItemId)}>
              <ConversationLabel entry={entry} state={state} unread={entry.workItemId !== scope.workItemId && entry.unread > 0} />
            </button>
          </li>,
          // The shown conversation's earlier sessions, newest first, as an approval, a retry or a setup session left them.
          ...(entry.workItemId === scope.workItemId ? (entry.sessions ?? []) : []).map((one) => <SessionRowButton entry={entry} one={one} state={state} now={now} />),
        ])}
        <Separator />
        <li role="none">
          <button type="button" class="menu-row new-row" role="menuitem" data-action="new-conversation">
            <span class="menu-gutter" aria-hidden="true">
              <span class="codicon codicon-add"></span>
            </span>
            <span class="title">New session in this work item…</span>
          </button>
        </li>
      </ul>
    ) : null;
  return (
    <header class="header">
      <button type="button" class="icon back-toggle" data-action="back" title="Back to work items" aria-label="Back to work items">
        <span class="codicon codicon-arrow-left" aria-hidden="true"></span>
      </button>
      <button type="button" class="icon list-toggle" data-action="drawer" title="Work items" aria-label="Work items" aria-controls="list" aria-expanded={view.drawer !== null}>
        <span class="codicon codicon-layout-sidebar-left" aria-hidden="true"></span>
      </button>
      <div class="menu-anchor picker-anchor">
        <button type="button" class="picker" data-action="picker" aria-haspopup="menu" aria-expanded={view.picker} title={drafting ? `New session · ${title}` : tooltip}>
          {drafting ? (
            <PickerLabel icon={<span class="codicon codicon-add state-icon tone-muted" aria-hidden="true"></span>} title={title} session="New session" />
          ) : earlier !== null ? (
            <PickerLabel icon={<Codicon {...stateIcon(state.session?.state, state.session?.waitingFor, state.session?.limit)} />} provider={state.session?.provider ?? earlier.provider} title={title} session={earlier.title} />
          ) : selected === null ? (
            <PickerLabel icon={<Codicon {...stateIcon(state.session?.state, state.session?.waitingFor, state.session?.limit)} />} title={title} />
          ) : (
            <PickerLabel icon={<Codicon {...conversationIcon(selected, state)} />} provider={conversationProvider(selected, state)} title={title} session={selected.sessionTitle} unread={othersUnread} />
          )}
          <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
        </button>
        {pickerMenu}
      </div>
      <Actions row={selectedRow(state)} view={view} workItem={state.scope?.workItemId != null} />
      <ConnectionDot dot={view.connection} />
    </header>
  );
}

/**
 * A tab, drawn alike in the strip and in the side column's switch: its codicon and its label, cut but never hidden (page.css), its name also its
 * tooltip and accessible name; with the unread dot ([Unread](architecture.md § Unread)) on its icon's corner while `unread`.
 */
function TabButton({ selected, label, icon, unread = false, attrs }: { selected: boolean; label: string; icon: string; unread?: boolean; attrs: Record<string, string> }) {
  return (
    <button class={`tab${selected ? ' selected' : ''}`} type="button" role="tab" {...attrs} aria-selected={selected} tabindex={selected ? 0 : -1} title={label} aria-label={unread ? `${label}, unread` : label}>
      <span class={`codicon codicon-${icon}`} aria-hidden="true"></span>
      {unread ? <UnreadDot /> : null}
      <span class="tab-label">{label}</span>
    </button>
  );
}

/** The unread mark's dot (architecture.md § Unread), named for a screen reader and on hover. */
export function UnreadDot({ label = 'Unread' }: { label?: string }) {
  return <span class="unread-dot" role="img" title={label} aria-label={label}></span>;
}

/**
 * What a strip shows beside the fixed tabs: the link tabs and the link shown, the open artifact while one shows, the room its tabs have, whether
 * the More menu is open and the time for its ages, the file tabs, the Changes tab while it applies, and whether History is open.
 */
export interface ArtifactStrip {
  links?: FrameLink[];
  link?: string;
  open: string | null;
  /** The strip's room (`fitTabs`), unmeasured by default, which shows every tab. */
  fit?: TabFit;
  menu: boolean;
  now: number;
  /** The artifacts whose tabs the operator closed (`closedArtifacts`). */
  closed?: ReadonlySet<string>;
  /** The artifacts this device has not shown at their version (`unreadArtifacts`), which their tabs and More's rows mark with the unread dot. */
  unread?: ReadonlySet<string>;
  /** The file tabs (localFiles.tsx). */
  files?: LocalFilesView;
  /** The Changes tab's view, or none for a strip without it. */
  changes?: ChangesView;
  /** Whether the History tab is open (`stripTabs`). */
  history?: boolean;
}

/**
 * The History tab, open only once History was asked for (main.ts `openHistory`), with a close mark that closes it as an artifact's does; the unread
 * dot on its icon's corner while the state it shows is unread.
 */
function HistoryTab({ selected, unread, attr }: { selected: boolean; unread: boolean; attr: string }) {
  return (
    <span class={`tab artifact-tab history-tab${selected ? ' selected' : ''}`} role="presentation">
      <button class="tab-open" type="button" role="tab" {...{ [attr]: 'history' }} aria-selected={selected} tabindex={selected ? 0 : -1} title="History" aria-label={unread ? 'History, unread' : 'History'}>
        <span class="codicon codicon-history" aria-hidden="true"></span>
        {unread ? <UnreadDot /> : null}
        <span class="tab-label">History</span>
      </button>
      <button class="tab-close" type="button" data-action="close-history" aria-label="Close History" title="Close" tabindex={selected ? 0 : -1}>
        <span class="codicon codicon-close" aria-hidden="true"></span>
      </button>
    </span>
  );
}

/**
 * An artifact's tab: its file type icon, its title, and a close mark beside it in one cell, so each takes the keyboard on its own; with the unread
 * dot on its icon's corner while this device has not shown its version (`unreadArtifacts`). Its tooltip names its title, its type and when it changed.
 */
function ArtifactTab({ artifact, selected, unread, now }: { artifact: ArtifactView; selected: boolean; unread: boolean; now: number }) {
  return (
    <span class={`tab artifact-tab${selected ? ' selected' : ''}`} role="presentation" data-action="artifact" data-path={artifact.path}>
      <button class="tab-open" type="button" role="tab" aria-selected={selected} tabindex={selected ? 0 : -1} title={`${artifact.title} · ${artifactType(artifact).name} · ${ago(artifact.updatedAt, now)}`} aria-label={unread ? `${artifact.title}, unread` : artifact.title}>
        <FileIcon path={artifact.path} />
        {unread ? <UnreadDot /> : null}
        <span class="tab-label">{artifact.title}</span>
      </button>
      <button class="tab-close" type="button" data-action="close-artifact" data-path={artifact.path} aria-label={`Close ${artifact.title}`} title="Close" tabindex={selected ? 0 : -1}>
        <span class="codicon codicon-close" aria-hidden="true"></span>
      </button>
    </span>
  );
}

/** A row of the More menu: its icon, its label, with the unread dot while `unread`, and its age in a column; `type`, what it opens, names it for screen readers only. */
function MenuRow({ attrs, icon, label, type = '', note = '', unread = false, title }: { attrs: Record<string, string>; icon: ComponentChildren; label: string; type?: string; note?: string; unread?: boolean; title?: string | undefined }) {
  const named = [label, ...(unread ? ['unread'] : []), ...(type === '' ? [] : [type]), ...(note === '' ? [] : [note])].join(', ');

  return (
    <button class="menu-row" type="button" role="menuitem" {...attrs} title={title} aria-label={named}>
      <span class="menu-gutter">{icon}</span>
      <span class="title">
        <span class="title-text">{label}</span>
        {unread ? <UnreadDot /> : null}
      </span>
      <span class="menu-note">{note}</span>
    </button>
  );
}

/**
 * More, at the strip's end while some tabs do not fit or some artifacts are closed: its icon, with the unread dot on its corner while a row is
 * unread, as a tab's, and how many rows it holds in its name and tooltip. Its menu lists each tab the strip does not show, in strip order, then the closed artifacts newest first; a row does what its
 * tab does, and choosing a closed artifact opens its tab again.
 */
function MoreMenu({ hidden, closed, strip, attr }: { hidden: DocTab[]; closed: ArtifactView[]; strip: ArtifactStrip; attr: 'data-side' | 'data-tab' }) {
  const unread = strip.unread ?? new Set<string>();
  const artifactRow = (artifact: ArtifactView): VNode => (
    <MenuRow attrs={{ 'data-action': 'artifact', 'data-path': artifact.path }} icon={<FileIcon path={artifact.path} />} label={artifact.title} type={artifactType(artifact).name} note={ago(artifact.updatedAt, strip.now)} unread={unread.has(artifact.path)} title={artifact.file ?? artifact.path} />
  );
  const row = (tab: DocTab): VNode => {
    switch (tab.kind) {
      case 'fixed': {
        const { label, icon } = TABS.find((one) => one.tab === tab.tab)!;

        return <MenuRow attrs={{ [attr]: tab.tab }} icon={<span class={`codicon codicon-${icon}`} />} label={label} unread={tab.unread} />;
      }
      case 'link':
        return <MenuRow attrs={{ 'data-action': 'iframe-open', 'data-url': tab.link.url }} icon={<LinkIcon link={tab.link} />} label={tab.link.label} type="link" title={`${tab.link.name} · ${tab.link.url}`} />;
      case 'artifact':
        return artifactRow(tab.artifact);
      case 'file': {
        const name = localTabName(tab.file);
        const dir = tab.file.entry.state === 'ok' && tab.file.entry.data.kind === 'dir';

        return <MenuRow attrs={{ 'data-action': 'local-tab', 'data-local': String(tab.file.id) }} icon={dir ? <span class="codicon codicon-folder" /> : <FileIcon path={name} />} label={name} type={dir ? 'folder' : 'file'} title={tab.id.slice('file:'.length)} />;
      }
      case 'changes':
        return <MenuRow attrs={{ 'data-action': 'diff-tab' }} icon={<span class="codicon codicon-diff-multiple" />} label="Changes" unread={strip.changes !== undefined && changesUnviewed(strip.changes)} />;
    }
  };
  const count = hidden.length + closed.length;
  const title = `${count} more ${count === 1 ? 'tab' : 'tabs'}`;
  const unreadCount = hidden.filter((tab) => (tab.kind === 'fixed' && tab.unread) || (tab.kind === 'changes' && strip.changes !== undefined && changesUnviewed(strip.changes)) || (tab.kind === 'artifact' && unread.has(tab.artifact.path))).length + closed.filter((artifact) => unread.has(artifact.path)).length;

  return (
    <span class="tab-more">
      <button class={`tab tab-more-button${strip.menu ? ' open' : ''}`} type="button" data-action="tab-menu" aria-haspopup="menu" aria-expanded={strip.menu} aria-label={`${title}${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`} title={title}>
        <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
        {unreadCount > 0 ? <span class="unread-dot" aria-hidden="true"></span> : null}
      </button>
      {strip.menu ? (
        <div class="menu glass tab-menu" role="menu" aria-label="More tabs">
          {hidden.map(row)}
          {hidden.length > 0 && closed.length > 0 ? <div class="menu-separator" role="separator"></div> : null}
          {closed.map(artifactRow)}
        </div>
      ) : null}
    </span>
  );
}

/**
 * A link tab's icon: GitHub's mark for an issue and the pull request icon for a pull request, in the colours of the list's pills (page.css), the
 * ticket's source's mark where the list has one, else the globe.
 */
function LinkIcon({ link }: { link: FrameLink }) {
  if (link.icon === 'issue' || link.icon === 'pr') {
    return <span class={`codicon codicon-${link.icon === 'pr' ? 'git-pull-request' : 'github'} link-icon ${link.icon}`} aria-hidden="true" />;
  }

  return link.icon === 'source' && link.source !== undefined && hasSourceLogo(link.source) ? <SourceLogo kind={link.source} enabled extra="link-icon" /> : <span class="codicon codicon-globe" aria-hidden="true" />;
}

/** An embedded link's tab, a tab of the strip itself, so the strip counts and sizes it as any other (page.css); its tooltip is its full name and URL. */
function LinkTab({ link, selected }: { link: FrameLink; selected: boolean }) {
  return (
    <span class={`tab artifact-tab link-tab${selected ? ' selected' : ''}`} role="presentation">
      <button class="tab-open" type="button" role="tab" data-action="iframe-open" data-url={link.url} title={`${link.name} · ${link.url}`} aria-selected={selected} tabindex={selected ? 0 : -1}><LinkIcon link={link} /><span class="tab-label">{link.label}</span></button>
      <button class="tab-close" type="button" data-action="iframe-close" data-url={link.url} aria-label={`Close ${link.name}`} title="Close" tabindex={selected ? 0 : -1}><span class="codicon codicon-close" aria-hidden="true" /></button>
    </span>
  );
}

/**
 * A strip's tabs, in `stripTabs`' order for its layout, `attr` naming each fixed tab (`data-tab` in the conversation's strip, `data-side` in
 * the column's): those that fit (`fitTabs`), and More at the end with the rest and the closed artifacts.
 */
function stripContent(layout: StripLayout, shown: Tab, state: PageState, browser: boolean, strip: ArtifactStrip, console: boolean): ComponentChildren {
  const attr = layout === 'wide' ? 'data-side' : 'data-tab';
  const closed = strip.closed ?? new Set<string>();
  const files = strip.files ?? { tabs: [], open: null };
  const tabs = stripTabs({ shown, stateUnread: state.state?.unread === true, history: strip.history === true, browser, links: strip.links, link: strip.link, artifacts: state.artifacts, open: strip.open, closed, files, changes: strip.changes !== undefined, console }, layout);
  // The closed artifacts, newest first, but the one shown, which keeps its tab.
  const shut = [...state.artifacts].sort((a, b) => b.updatedAt - a.updatedAt).filter((artifact) => closed.has(artifact.path) && !tabs.some((tab) => tab.id === `artifact:${artifact.path}`));
  const { shown: fitted, hidden } = fitTabs(tabs, strip.fit ?? UNMEASURED, shut.length > 0);
  // Each drawn tab names its id (`data-id`), by which main.ts measures it (`fitStripTabs`).
  const draw = (tab: DocTab): VNode => {
    switch (tab.kind) {
      case 'fixed': {
        // History, open, has the unread dot while its state is unread; the page shows no unread counts.
        if (tab.tab === 'history') {
          return HistoryTab({ selected: tab.selected, unread: tab.unread, attr });
        }

        const { label, icon } = TABS.find((one) => one.tab === tab.tab)!;

        return TabButton({ selected: tab.selected, label, icon, unread: tab.unread, attrs: { [attr]: tab.tab } });
      }
      case 'link':
        return LinkTab({ link: tab.link, selected: tab.selected });
      case 'artifact':
        return ArtifactTab({ artifact: tab.artifact, selected: tab.selected, unread: strip.unread?.has(tab.artifact.path) === true, now: strip.now });
      case 'file':
        return LocalTabButton({ tab: tab.file, selected: tab.selected });
      case 'changes':
        return changesTab(strip.changes!, tab.selected);
    }
  };

  return [...fitted.map((tab) => cloneElement(draw(tab), { key: tab.id, 'data-id': tab.id })), hidden.length + shut.length > 0 ? <MoreMenu hidden={hidden} closed={shut} strip={strip} attr={attr} /> : null];
}

/**
 * The tab strip atop the column right of the conversation on a wide screen, in `stripTabs`' order (`stripContent`); the conversation keeps its own
 * pane beside it. `end`, as the maximize button, closes the strip.
 */
export function renderSideSwitch(side: SideTab, state: PageState, browser = false, strip: ArtifactStrip = { open: null, menu: false, now: 0 }, console = true, end: ComponentChildren = null): VNode {
  return (
    <nav class="tabs side-switch" role="tablist" aria-label="Side panel">
      {stripContent('wide', side, state, browser, strip, console)}
      {end}
    </nav>
  );
}

/** The column's maximize button, at its strip's end: it covers the whole page with the column, or restores it. */
export function renderMaximize(maximized: boolean): VNode {
  const label = maximized ? 'Restore panel' : 'Maximize panel';

  return (
    <button type="button" class="tab panel-max" data-action="panel-max" title={label} aria-label={label} aria-controls="detail">
      <span class={`codicon codicon-${maximized ? 'screen-normal' : 'screen-full'}`} aria-hidden="true"></span>
    </button>
  );
}

/** The conversation's tab strip on a narrower screen: Chat, then the column's tabs in the same order (`stripContent`). */
export function renderTabs(view: View, state: PageState, browser = false, strip: ArtifactStrip = { open: null, menu: false, now: 0 }, console = true): VNode {
  return (
    <nav class="tabs" role="tablist">
      {stripContent('narrow', view.tab, state, browser, strip, console)}
    </nav>
  );
}
