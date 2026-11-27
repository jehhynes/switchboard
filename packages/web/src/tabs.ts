// The tabs of a strip as one ordered list (architecture.md § Web page), which the conversation's strip and the side column's switch both draw, so
// both show the same tabs in the same order at every width.
import type { ArtifactView } from '@switchboard/protocol';
import type { FrameLink } from './iframeBrowser.js';
import type { LocalFilesView, LocalTab } from './localFiles.js';
import type { Tab } from './render.js';

/** Which strip: the side column's on a wide page, or the conversation's on a narrower one, which adds Chat. */
export type StripLayout = 'wide' | 'narrow';

/** What a strip can show: which tab shows, and each tab's source. */
export interface StripState {
  /** The tab the pane under the strip shows. */
  shown: Tab;
  /** Whether the state History shows is unread. */
  stateUnread: boolean;
  /** Whether the History tab is open: opened on request, until its close mark closes it (main.ts `historyFor`). */
  history?: boolean | undefined;
  /** Whether the Browser tab shows, which it does only while the strip has no link tabs (`links`). */
  browser: boolean;
  /** The embedded link tabs, while the page has them (architecture.md § Embedded link tabs). */
  links?: ReadonlyArray<FrameLink> | undefined;
  /** The link the Browser pane shows. */
  link?: string | null | undefined;
  artifacts: readonly ArtifactView[];
  /** The artifact the Artifacts pane shows. */
  open: string | null;
  /** The artifacts whose tabs are closed (`closedArtifacts`). */
  closed: ReadonlySet<string>;
  files: LocalFilesView;
  changes: boolean;
  console: boolean;
}

interface TabBase {
  /** `history`, `changes`, `files`, `console`, `conversation` and `browser` for the fixed tabs, `link:<url>`, `artifact:<path>` or `file:<path>`. */
  id: string;
  selected: boolean;
}

/** A strip's tab: a fixed tab, a link, an artifact, a file or Changes. */
export type DocTab =
  | (TabBase & { kind: 'fixed'; tab: 'conversation' | 'history' | 'browser' | 'console' | 'files'; unread: boolean })
  | (TabBase & { kind: 'link'; link: FrameLink })
  | (TabBase & { kind: 'artifact'; artifact: ArtifactView })
  | (TabBase & { kind: 'file'; file: LocalTab })
  | (TabBase & { kind: 'changes' });

/** A file tab's path, as its id names it: the file's own once read, else the target its link named. */
export const filePath = (tab: LocalTab): string => (tab.entry.state === 'ok' ? tab.entry.data.path : tab.target);

/**
 * The strip's tabs in order, each only while it applies: Chat (narrow strip only), Changes and Files, History while open, the links (or Browser),
 * the artifacts newest first but those closed, unless shown, the file tabs in the order they were opened, then Console.
 */
export function stripTabs(state: StripState, layout: StripLayout): DocTab[] {
  const { shown } = state;
  const fixed = (tab: 'conversation' | 'history' | 'browser' | 'console' | 'files'): DocTab => ({ id: tab, kind: 'fixed', tab, selected: shown === tab, unread: tab === 'history' && state.stateUnread && shown !== tab });
  const artifacts = [...state.artifacts]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((artifact) => !state.closed.has(artifact.path) || (shown === 'artifacts' && artifact.path === state.open));

  return [
    ...(layout === 'narrow' ? [fixed('conversation')] : []),
    ...(state.changes ? [{ id: 'changes', kind: 'changes' as const, selected: shown === 'diff' }, fixed('files')] : []),
    ...(state.history === true ? [fixed('history')] : []),
    ...(state.links === undefined ? (state.browser ? [fixed('browser')] : []) : state.links.map((link): DocTab => ({ id: `link:${link.url}`, kind: 'link', link, selected: shown === 'browser' && state.link === link.url }))),
    ...artifacts.map((artifact): DocTab => ({ id: `artifact:${artifact.path}`, kind: 'artifact', artifact, selected: shown === 'artifacts' && artifact.path === state.open })),
    ...state.files.tabs.map((file): DocTab => ({ id: `file:${filePath(file)}`, kind: 'file', file, selected: shown === 'file' && file.id === state.files.open })),
    ...(state.console ? [fixed('console')] : []),
  ];
}

/**
 * What a strip has room for, measured after a draw (main.ts): the strip's width for its tabs and More, without the maximize button, 0 while
 * unmeasured; More's width; and each tab's least width, its label cut to `--sb-tab-label-least` (page.css), as drawn by id, else by whether it has
 * a close mark (`plain`, `closable`).
 */
export interface TabFit {
  width: number;
  more: number;
  plain: number;
  closable: number;
  measured: Readonly<Record<string, number>>;
}

/** A strip not measured yet, which shows every tab. */
export const UNMEASURED: TabFit = { width: 0, more: 0, plain: 0, closable: 0, measured: {} };

/** Whether a tab has a close mark: History, a link, an artifact or a file. */
export const closable = (tab: DocTab): boolean => tab.id === 'history' || tab.kind === 'link' || tab.kind === 'artifact' || tab.kind === 'file';

/** The tabs a strip short of room keeps first after the selected one, in this order. */
const FIRST_KEPT = ['conversation', 'changes', 'history'];

/**
 * Which of a strip's tabs show and which go in More, each list in strip order. Every tab shows while all fit at their least widths, with More
 * beside them when `menu` (closed artifacts for it to list). Else More takes its room and the tabs are kept in this order while they fit: the
 * selected tab, Chat, Changes, History, then the rest in strip order, stopping at the first that does not fit; so a very narrow strip drops
 * History first, then Changes, then Chat, and keeps the selected tab whatever its width, every tab reachable through More. An unmeasured strip shows them all.
 */
export function fitTabs(tabs: readonly DocTab[], fit: TabFit, menu = false): { shown: DocTab[]; hidden: DocTab[] } {
  const least = (tab: DocTab): number => fit.measured[tab.id] ?? (closable(tab) ? fit.closable : fit.plain);
  const total = tabs.reduce((sum, tab) => sum + least(tab), 0);

  if (fit.width <= 0 || total + (menu ? fit.more : 0) <= fit.width) {
    return { shown: [...tabs], hidden: [] };
  }

  const order = [...tabs.filter((tab) => tab.selected), ...FIRST_KEPT.flatMap((id) => tabs.filter((tab) => tab.id === id && !tab.selected)), ...tabs.filter((tab) => !tab.selected && !FIRST_KEPT.includes(tab.id))];
  const kept = new Set<DocTab>();
  let room = fit.width - fit.more;

  for (const tab of order) {
    if (kept.size > 0 && least(tab) > room) {
      break;
    }

    kept.add(tab);
    room -= least(tab);
  }

  return { shown: tabs.filter((tab) => kept.has(tab)), hidden: tabs.filter((tab) => !kept.has(tab)) };
}
