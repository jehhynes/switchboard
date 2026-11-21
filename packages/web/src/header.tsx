// The conversation's header (architecture.md § Web page): the dropdown of the selected work item's conversations, the row's actions, the
// persona and the view options, and the tabs under it or the switch atop the side column.
import type { ComponentChildren, VNode } from 'preact';
import { providerMark } from '@switchboard/conversation/providerIcons';
import { artifactIcon, selectedEntry, selectedRow, stateIcon } from './model.js';
import type { PageState } from './model.js';
import { ago, artifactBar, LINK_LABEL_MAX, paneStatus, rowKey, TABS } from './render.js';
import type { SideTab, Tab, View } from './render.js';
import { trusted } from './trusted.js';
import type { PageAction, PageRow } from './types.js';

/** The most links the menu lists by themselves; more go in its Open link submenu, as the dock's `MenuLinks`. */
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

/** A menu row's left gutter: a check mark for the chosen row, or nothing, so every row's text starts in one column. */
function Gutter({ checked }: { checked: boolean }) {
  return <span class="menu-gutter" aria-hidden="true">{checked ? <span class="codicon codicon-check"></span> : null}</span>;
}

const Separator = () => <li class="menu-separator" role="separator"></li>;

/**
 * A row's menu, as rows of a `menu` list (architecture.md § Web page), grouped as the dock's row menu is: the main control, the work controls, the
 * state controls, Add comment…, the order controls, what the row opens (Copy, Open in VS Code, Open changes and Open report, History, Open ticket and its
 * links, more than two of them in an Open link submenu), then the controls that ask first; empty when the row offers none. Each item names its
 * row, so a pool ticket's menu in the list runs as the header's does.
 */
export function menuRows(row: PageRow, view: Pick<View, 'acting' | 'linkMenu'>): VNode[] {
  const actions = row.actions ?? [];
  const pastes = row.pastes ?? [];
  const commands = row.opens ?? [];
  const key = rowKey(row);
  const item = (attrs: Record<string, string>, icon: string | null, label: string, after: ComponentChildren = null, classes = ''): VNode => (
    <li role="none">
      <button type="button" class={`menu-row${classes === '' ? '' : ` ${classes}`}`} role="menuitem" data-row={key} {...attrs} disabled={view.acting}>
        <span class="menu-gutter" aria-hidden="true">{icon === null ? null : <span class={`codicon codicon-${icon}`}></span>}</span>
        <span class="title">{label}</span>
        {after}
      </button>
    </li>
  );
  const act = (action: PageAction): VNode => item({ 'data-action': 'row-action', 'data-label': action.label }, action.icon, action.label);
  const grouped = (group: PageAction['group']): VNode[] => actions.filter((one) => one.group === group).map(act);
  // A link's label can be free text a session reported, so a long one is cut, whole in its tooltip, as in the dock's menu.
  const link = (which: string, label: string, icon: string | null, classes = ''): VNode =>
    item({ 'data-action': 'open-link', 'data-link': which, ...(label.length > LINK_LABEL_MAX ? { title: label } : {}) }, icon, clipLabel(label), null, classes);
  const submenu = [
    item({ 'data-action': 'link-menu', 'aria-haspopup': 'true', 'aria-expanded': String(view.linkMenu) }, 'link-external', 'Open link', <span class={`codicon codicon-chevron-${view.linkMenu ? 'down' : 'right'}`} aria-hidden="true"></span>),
    ...(view.linkMenu ? row.links.map((one, index) => link(String(index), one.label, null, 'submenu-row')) : []),
  ];
  const opens = [
    ...pastes.map((label) => item({ 'data-action': 'row-paste', 'data-label': label }, 'copy', `Copy ${label}`)),
    // The dock's Open in terminal: the open work item's session on the Console tab.
    ...(row.terminal === true ? [item({ 'data-action': 'open-console' }, 'terminal', 'Open in terminal')] : []),
    ...commands.map((one) => item({ 'data-action': 'row-command', 'data-label': one.label }, one.icon, one.label)),
    // The dock's History, which the page shows in the conversation's place.
    ...(row.history == null ? [] : [item({ 'data-action': 'row-history' }, 'history', 'History')]),
    ...(row.url === '' ? [] : [link('ticket', 'Open ticket', 'link-external')]),
    ...(row.links.length > MENU_LINKS ? submenu : row.links.map((one, index) => link(String(index), `Open ${one.label}`, 'link-external'))),
  ];
  const groups = [grouped('main'), grouped('work'), grouped('state'), grouped('notes'), grouped('order'), opens, grouped('asking')].filter((group) => group.length > 0);

  return groups.flatMap((group, index) => (index === 0 ? group : [<Separator />, ...group]));
}

/**
 * The header's row actions (architecture.md § Web page): the dock's main control as a button, then the row's menu (`menuRows`) under an
 * ellipsis; nothing when the row offers none.
 */
function Actions({ row, view }: { row: PageRow | null; view: View }) {
  const rows = row === null ? [] : menuRows(row, view);

  if (row === null || rows.length === 0) {
    return null;
  }

  const main = (row.actions ?? []).find((one) => one.group === 'main');

  return (
    <>
      {main === undefined ? null : (
        <button type="button" class="row-main" data-action="row-action" data-row={rowKey(row)} data-label={main.label} disabled={view.acting}>
          <span class={`codicon codicon-${main.icon}`} aria-hidden="true"></span>
          <span>{main.label}</span>
        </button>
      )}
      <div class="menu-anchor actions-anchor">
        <button type="button" class="actions" data-action="actions" aria-haspopup="menu" aria-expanded={view.actions} title="Actions" aria-label="Actions">
          <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
        </button>
        {view.actions ? (
          <ul class="glass menu actions-menu" role="menu" aria-label="Actions">
            {rows}
          </ul>
        ) : null}
      </div>
    </>
  );
}

type Entry = NonNullable<PageState['scope']>['conversations'][number];

/**
 * A conversation as the dropdown's button and each of its rows draw it, from this one renderer so they never differ: its session's state
 * codicon, title, the unread dot when `unread` (architecture.md § Unread), and provider's mark.
 */
function ConversationLabel({ entry, state, unread = false }: { entry: Entry; state: PageState; unread?: boolean }) {
  const selected = entry.workItemId === state.scope?.workItemId;
  const icon = selected ? stateIcon(state.session?.state, state.session?.waitingFor, state.session?.limit) : stateIcon(entry.state);

  return (
    <>
      <Codicon {...icon} />
      <span class="title">{entry.title}</span>
      {unread ? <span class="unread-dot" role="img" title="Unread replies or status" aria-label="Unread replies or status"></span> : null}
      {trusted(providerMark(selected ? (state.session?.provider ?? entry.provider) : entry.provider))}
    </>
  );
}

/** The view options menu's Chrome pane rows while it is on: its state, the last pairing's outcome, and Pair Chrome extension until paired. */
function PaneRows({ view }: { view: View }) {
  const status = paneStatus(view.pane);

  if (status === null) {
    return null;
  }

  return (
    <>
      <div class="menu-separator" role="separator"></div>
      <p class="pane-note">{status}</p>
      {view.paneNote === null ? null : (
        <p class="pane-note" role="status">
          {view.paneNote}
        </p>
      )}
      {view.pane!.extension === 'paired' ? null : (
        <button type="button" class="menu-row" role="menuitem" data-action="pane-pair">
          <span class="menu-gutter" aria-hidden="true">
            <span class="codicon codicon-plug"></span>
          </span>
          <span class="title">Pair Chrome extension</span>
        </button>
      )}
    </>
  );
}

/** The header's view options button and its menu: Show message details, and the Chrome pane's state and pairing while it is on. */
function ViewOptions({ view }: { view: View }) {
  return (
    <div class="menu-anchor view-options-anchor">
      <button type="button" class="icon view-options" data-action="view-menu" aria-haspopup="menu" aria-expanded={view.viewMenu} title="View options" aria-label="View options">
        <span class="codicon codicon-settings" aria-hidden="true"></span>
      </button>
      {view.viewMenu ? (
        <div class="glass menu view-options-menu" role="menu" aria-label="View options">
          <button type="button" class="menu-row" role="menuitemcheckbox" aria-checked={view.details} data-action="toggle-details">
            <Gutter checked={view.details} />
            <span class="title">Show message details</span>
          </button>
          <PaneRows view={view} />
        </div>
      ) : null}
    </div>
  );
}

/** The menu's message rows: an error, or Loading… while the items load. */
function Message({ text }: { text: string }) {
  return (
    <li class="menu-message" role="none">
      {text}
    </li>
  );
}

/** The header: the dropdown of the selected work item's conversations, its button drawn as its rows are, and the persona as an icon. */
export function renderHeader(state: PageState, view: View): VNode {
  const scope = state.scope!;
  const selected = selectedEntry(state);
  const title = selected?.title ?? scope.title;
  // The button carries the dot while a conversation the operator is not looking at has unseen items.
  const othersUnread = scope.conversations.some((entry) => entry.workItemId !== scope.workItemId && entry.unread > 0);
  const persona = state.session?.persona;
  const personaLabel = persona == null ? '' : `Persona: ${persona.name}${persona.pinned ? ', pinned' : ''}`;
  const personaButton =
    persona == null ? (
      state.session?.canPin === true ? (
        <button type="button" class="persona" data-action="persona" aria-haspopup="menu" aria-expanded={view.personas !== null} title="No persona. Click to choose one." aria-label="No persona. Click to choose one.">
          <span class="codicon codicon-person" aria-hidden="true"></span>
        </button>
      ) : null
    ) : (
      <button type="button" class={`persona${persona.tonePending ? ' pending' : ''}`} data-action="persona" aria-haspopup="menu" aria-expanded={view.personas !== null} title={`${personaLabel}. Click to choose another.`} aria-label={personaLabel}>
        <span class={`codicon codicon-${persona.pinned ? 'pinned' : 'person'}`} aria-hidden="true"></span>
      </button>
    );
  // After a separator, New conversation… as in the Conversation view; it opens the providers under the same button when there is a choice.
  const providers = view.providers;
  const providerRows =
    providers === null
      ? null
      : providers.error !== null
        ? <Message text={providers.error} />
        : providers.items === null
          ? <Message text="Loading…" />
          : providers.items.map((one) => (
              <li role="none">
                <button type="button" class="menu-row" role="menuitem" data-action="new-provider" data-provider={one.provider}>
                  <Gutter checked={false} />
                  <span class="title">{one.name}</span>
                  {one.default ? <span class="menu-note">Default</span> : null}
                </button>
              </li>
            ));
  const pickerMenu =
    providers !== null ? (
      <ul class="glass menu conversation-menu" role="menu" aria-label="Provider">
        {providerRows}
      </ul>
    ) : view.picker ? (
      <ul class="glass menu conversation-menu" role="menu" aria-label="Conversations">
        {scope.conversations.map((entry) => (
          <li role="none" key={entry.workItemId}>
            <button type="button" class="menu-row conversation-row" role="menuitemradio" aria-checked={entry.workItemId === scope.workItemId} data-action="select" data-work-item={String(entry.workItemId)}>
              <ConversationLabel entry={entry} state={state} unread={entry.workItemId !== scope.workItemId && entry.unread > 0} />
            </button>
          </li>
        ))}
        <Separator />
        <li role="none">
          <button type="button" class="menu-row new-row" role="menuitem" data-action="new-conversation">
            <span class="menu-gutter" aria-hidden="true">
              <span class="codicon codicon-add"></span>
            </span>
            <span class="title">New conversation…</span>
          </button>
        </li>
      </ul>
    ) : null;
  const menu = view.personas;
  const personaRows =
    menu === null
      ? null
      : menu.error !== null
        ? <Message text={menu.error} />
        : menu.items === null
          ? <Message text="Loading…" />
          : [
              ...menu.items.map((one) => (
                <li role="none">
                  <button type="button" class="menu-row" role="menuitemradio" aria-checked={persona?.id === one.id} data-action="persona-pick" data-persona={one.id}>
                    <Gutter checked={persona?.id === one.id} />
                    <span class="title">{one.name}</span>
                  </button>
                </li>
              )),
              ...(persona?.pinned === true
                ? [
                    <Separator />,
                    <li role="none">
                      <button type="button" class="menu-row" role="menuitem" data-action="persona-pick" data-persona="">
                        <Gutter checked={false} />
                        <span class="title">Clear pin</span>
                      </button>
                    </li>,
                  ]
                : []),
            ];

  return (
    <header class="header">
      <button type="button" class="icon back-toggle" data-action="back" title="Back to work items" aria-label="Back to work items">
        <span class="codicon codicon-arrow-left" aria-hidden="true"></span>
      </button>
      <button type="button" class="icon list-toggle" data-action="drawer" title="Work items" aria-label="Work items" aria-controls="list" aria-expanded={view.drawer !== null}>
        <span class="codicon codicon-layout-sidebar-left" aria-hidden="true"></span>
      </button>
      <div class="menu-anchor picker-anchor">
        <button type="button" class="picker" data-action="picker" aria-haspopup="menu" aria-expanded={view.picker || providers !== null} title={title}>
          {selected === null ? (
            <>
              <Codicon {...stateIcon(state.session?.state, state.session?.waitingFor, state.session?.limit)} />
              <span class="title">{title}</span>
            </>
          ) : (
            <ConversationLabel entry={selected} state={state} unread={othersUnread} />
          )}
          <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
        </button>
        {pickerMenu}
      </div>
      <Actions row={selectedRow(state)} view={view} />
      {personaButton === null ? null : (
        <div class="menu-anchor persona-anchor">
          {personaButton}
          {menu === null ? null : (
            <ul class="glass menu persona-menu" role="menu" aria-label="Persona">
              {personaRows}
            </ul>
          )}
        </div>
      )}
      <ViewOptions view={view} />
    </header>
  );
}

/** A tab, drawn alike in the strip and in the side column's switch. */
function TabButton({ selected, label, badge, attrs }: { selected: boolean; label: string; badge: string; attrs: Record<string, string> }) {
  return (
    <button class={`tab${selected ? ' selected' : ''}`} type="button" role="tab" {...attrs} aria-selected={selected} tabindex={selected ? 0 : -1}>
      {label}
      {badge === '' ? null : <span class="tab-badge">{badge}</span>}
    </button>
  );
}

/** What a strip's artifact tabs show: the open artifact while one shows, how many tabs fit, whether the Artifacts menu is open, and the time for its ages. */
export interface ArtifactStrip {
  open: string | null;
  fit: number;
  menu: boolean;
  now: number;
  /** The artifacts whose tabs the operator closed (`closedArtifacts`). */
  closed?: ReadonlySet<string>;
}

/**
 * One tab per artifact after the fixed tabs, newest first, but those the operator closed, as many as fit (`artifactBar`), each with a close button;
 * then, when some have no tab, Artifacts with their count, which opens a menu of every artifact, newest first with its kind and age, those with a
 * tab dimmed and those closed marked so.
 */
function artifactTabs(state: PageState, strip: ArtifactStrip): ComponentChildren {
  const closed = strip.closed ?? new Set<string>();
  const { ordered, tabs } = artifactBar(state.artifacts, strip.open, strip.fit, closed);
  const rest = ordered.length - tabs.length;

  return [
    ...tabs.map((artifact) => {
      const selected = artifact.path === strip.open;

      // The tab and its close button are siblings in one cell, so each takes the keyboard on its own.
      return (
        <span class={`tab artifact-tab${selected ? ' selected' : ''}`} role="presentation" data-action="artifact" data-path={artifact.path}>
          <button class="tab-open" type="button" role="tab" aria-selected={selected} tabindex={selected ? 0 : -1} title={`${artifact.title} · ${artifact.kind}`}>
            <span class={`codicon codicon-${artifactIcon(artifact.type)}`} aria-hidden="true"></span>
            <span class="tab-label">{artifact.title}</span>
          </button>
          <button class="tab-close" type="button" data-action="close-artifact" data-path={artifact.path} aria-label={`Close ${artifact.title}`} title="Close" tabindex={selected ? 0 : -1}>
            <span class="codicon codicon-close" aria-hidden="true"></span>
          </button>
        </span>
      );
    }),
    rest === 0 ? null : (
      <span class="artifact-more">
        <button class={`tab artifact-menu-button${strip.menu ? ' open' : ''}`} type="button" data-action="artifact-menu" aria-haspopup="menu" aria-expanded={strip.menu} title="Every artifact, newest first">
          <span class="codicon codicon-files" aria-hidden="true"></span>
          <span class="tab-label">Artifacts</span>
          <span class="tab-badge muted">+{rest}</span>
          <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
        </button>
        {strip.menu ? (
          <div class="menu glass artifact-menu" role="menu" aria-label="Artifacts">
            {ordered.map((artifact) => (
              <button class={`menu-row${tabs.includes(artifact) ? ' in-bar' : ''}${closed.has(artifact.path) ? ' closed' : ''}`} type="button" role="menuitem" data-action="artifact" data-path={artifact.path} title={artifact.path}>
                <span class="menu-gutter">
                  <span class={`codicon codicon-${artifactIcon(artifact.type)}`} aria-hidden="true"></span>
                </span>
                <span class="title">{artifact.title}</span>
                <span class="menu-note">{closed.has(artifact.path) ? `Closed · ${ago(artifact.updatedAt, strip.now)}` : ago(artifact.updatedAt, strip.now)}</span>
              </button>
            ))}
          </div>
        ) : null}
      </span>
    ),
  ];
}

/**
 * The tab strip atop the column right of the conversation on a wide screen: Status, Console and Browser, then a tab per artifact (`artifactTabs`);
 * the conversation keeps its own pane beside it.
 */
export function renderSideSwitch(side: SideTab, state: PageState, browser = false, strip: ArtifactStrip = { open: null, fit: 0, menu: false, now: 0 }): VNode {
  const fresh = state.status?.unread === true;
  const tabs: Array<[SideTab, string, string]> = [
    ['status', 'Status', fresh ? 'New' : ''],
    ['console', 'Console', ''],
    ...(browser ? [['browser', 'Browser', ''] as [SideTab, string, string]] : []),
  ];

  return (
    <nav class="tabs side-switch" role="tablist" aria-label={browser ? 'Status, console, browser and artifacts' : 'Status, console and artifacts'}>
      {tabs.map(([tab, label, badge]) => (
        <TabButton selected={tab === side} label={label} badge={badge} attrs={{ 'data-side': tab }} />
      ))}
      {artifactTabs(state, { ...strip, open: side === 'artifacts' ? strip.open : null, fit: strip.fit })}
    </nav>
  );
}

/** The conversation's tab strip on a narrower screen: Conversation, Status, Console and Browser, then a tab per artifact as in the column. */
export function renderTabs(view: View, state: PageState, browser = false, strip: ArtifactStrip = { open: null, fit: 0, menu: false, now: 0 }): VNode {
  const fresh = state.status?.unread === true;
  // As in the VS Code view: Status has its New badge; the page shows no unread counts.
  const badges: Record<Tab, string> = { conversation: '', status: fresh ? 'New' : '', artifacts: '', console: '', browser: '' };

  return (
    <nav class="tabs" role="tablist">
      {TABS.filter(({ tab }) => tab !== 'artifacts' && (browser || tab !== 'browser')).map(({ tab, label }) => (
        <TabButton selected={tab === view.tab} label={label} badge={badges[tab]} attrs={{ 'data-tab': tab }} />
      ))}
      {artifactTabs(state, { ...strip, open: view.tab === 'artifacts' ? strip.open : null })}
    </nav>
  );
}
