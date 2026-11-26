// Checks the page's shell at iPhone sizes and an iPad's, and its tabs on a desktop, in a real headless Chrome or Edge (testing.md § Web page shell check): in the installed
// app's standalone mode, portrait and landscape, light and dark, the list, a conversation, an empty one, History (its title first at 20 px, its
// groups' headings at 14 px, and its pinned state on the first screen), History's filter and the Changes tree's search box (each at least 160 px
// wide and covered by nothing else of its bar, with History's chips shown and the search's options menu open), Settings, the drawer, a sheet,
// a work item with more tabs than fit, the composer under each other tab and a maximized column with the mic on, a conversation with questions waiting, the long Actions, More actions, row and More tabs menus, and the list at 200, 260, 300, 330 and 420 px. Every tab shown keeps its label, no tab passes its strip,
// a tab's unread dot, More's included, is a badge on its icon's top-right corner ringed in the tab's fill, clear of its label and close mark and taking no width, two unselected tabs side by side show a line or fills
// at 1.25:1 between them, and the More menu lies above everything under it. Line 2 is one line, never wrapping and its items never
// below one another, at several list widths down to 200 px; its playbook or host is cut, with an ellipsis and a tooltip naming it whole, only
// where it does not fit beside the comment icon and the key; a key shows its source's logo, GitHub's, Zoho's or a plugin's, in place of its source's label; every pill, the key included, shows its text where line 2 is 300 px wide or more and its icon alone under that,
// its text kept for screen readers; the key never drops out; a link pill is whole, its icon alone or left out whole, never cut, the last
// first; a pill left out is no keyboard stop, and a pill shown is one only in the list's Tab stop row; the pills change with the list's width alone, without a redraw; and line 2 paints the same while
// the same list is sent again. A row's waiting questions show on line 1 after the title as their icon alone, whole, visible in the warning text colour, the title cut before them. Every control shown is a touch target of at least 44 px each way,
// and no two overlap, also in the Changes tab's diffs, the context meter's popover, Snooze, a question card and its questions-waiting chip, and a reply's
// task list, whose read-only boxes are not controls; on the desktop a question card's step dots are at least 24 px tall.
// The questions waiting chip floats centred over the composer, clear of its box, at the conversation's end and halfway up. The card's topic is
// 4.5:1 on the card, and its first question's disabled Back has no border.
// Nothing outside the scrollers can move: the document is exactly the viewport, nothing reaches past it outside a scroller, every scroller keeps
// a drag to itself or hands it to the pane around it, and the page outside the scrollers takes no pan. Chrome has no display-mode emulation, so the page's standalone rules are
// applied to every width here, and safe-area insets come from the DevTools protocol.
// Run `npm run build` first; the browser is SWITCHBOARD_CHROME, else Chrome or Edge where they install. --report prints the measurements.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_ASSETS } from './dist/index.js';

const DIFF_DIR = fileURLToPath(new URL('./dist/diff/', import.meta.url));

/**
 * Settings' views: each page, by the navigation entries pressed to reach it. On a phone a list's entry drills into its list and on a desktop
 * opens under it, so the same presses reach the page on both.
 */
const SETTINGS_PAGES = {
  settings: ['sessions'],
  'settings-triage': ['triage'],
  'settings-source': ['sources', 'source:github'],
  'settings-playbook': ['playbooks', 'namespace:dev', 'playbook:dev:build'],
  'settings-schedule': ['schedules', 'schedule:weekly'],
  'settings-display': ['display'],
  'settings-devices': ['devices'],
  'settings-advanced': ['advanced'],
  'settings-spoken-replies': ['spoken-replies'],
  'settings-dictation': ['dictation'],
  'settings-personas': ['personas', 'personas/page'],
  'settings-persona': ['personas', 'persona:0'],
};
/**
 * iPhone 16 Pro in the installed app under the opaque status bar: 393 by 852 pt, less the 59 pt status bar in portrait; none in landscape. Both
 * draw the phone's layout. iPad Air 11" on its side, 1180 by 820 pt less its 24 pt status bar, draws the drawer.
 */
const SIZES = [
  { device: 'iphone', orientation: 'portrait', width: 393, height: 793, screen: [393, 852], insets: { top: 0, bottom: 34, left: 0, right: 0 }, phone: true },
  { device: 'iphone', orientation: 'landscape', width: 852, height: 393, screen: [852, 393], insets: { top: 0, bottom: 21, left: 59, right: 59 }, phone: true },
  { device: 'ipad', orientation: 'landscape', width: 1180, height: 796, screen: [1180, 820], insets: { top: 0, bottom: 20, left: 0, right: 0 }, phone: false },
  // A desktop with a mouse, for the tabs view, whose close marks are the small ones, not touch targets, a question card's step dots, and Settings' pages.
  { device: 'desktop', orientation: 'landscape', width: 1800, height: 1000, screen: [1800, 1000], insets: { top: 0, bottom: 0, left: 0, right: 0 }, phone: false, mouse: true, views: ['history', 'history-filters', 'changes', 'changes-options', 'tabs', 'questions', 'questions-ended', 'settings-nav', ...Object.keys(SETTINGS_PAGES), 'settings-pair', 'settings-table', 'pair', 'context-details', 'mic-max-history', 'mic-max-changes', 'mic-max-artifact'] },
];
/** Settings' views that show switches or checkboxes, so their touch targets are measured. */
const SWITCHED = ['settings-source', 'settings-playbook', 'settings-table', 'settings-display', 'settings-devices', 'settings-advanced', 'settings-spoken-replies', 'settings-dictation'];
/**
 * The mic-on views (architecture.md § Web page): the mic listening while another tab shows, where the tabs fold (`mic-`) and in a desktop's
 * maximized column (`mic-max-`), so the composer shows under the tab.
 */
const MIC_VIEWS = ['mic-history', 'mic-changes', 'mic-artifact', 'mic-console'];
const VIEWS = ['list', 'narrow', 'narrow-260', 'narrow-300', 'narrow-330', 'narrow-420', 'conversation', 'empty', 'history', 'settings-nav', ...Object.keys(SETTINGS_PAGES), 'settings-pair', 'settings-table', 'drawer', 'sheet', 'pair', 'tabs', 'diffs', 'context', 'snooze', 'changes', 'changes-options', 'history-filters', 'questions', 'questions-ended', 'actions-menu', 'more-menu', 'row-menu', 'tab-menu', 'context-details', ...MIC_VIEWS, 'mic-max-history', 'mic-max-changes', 'mic-max-artifact'];
const report = process.argv.includes('--report');
/** --views <a,b> checks only those views; --shots <dir> saves a screenshot of each view there. */
const only = process.argv.includes('--views') ? process.argv[process.argv.indexOf('--views') + 1].split(',') : null;
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
/** --history-case <ended|turn|waiting|filter> draws History's pinned state ended or as of the last turn, its row waiting on you, or a filter. */
const historyCase = process.argv.includes('--history-case') ? process.argv[process.argv.indexOf('--history-case') + 1] : null;

const browsers = [
  process.env.SWITCHBOARD_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((path) => path !== undefined && existsSync(path));

if (browsers.length === 0) {
  console.error('No Chrome or Edge found; set SWITCHBOARD_CHROME to one.');
  process.exit(2);
}

// The page with a fake stream and fetch in place of the hub's: a work item with a long conversation, one with none, and the list.
const fake = `<script>
const view = new URLSearchParams(location.search).get('view');
const hcase = new URLSearchParams(location.search).get('hcase');
// The filter case types into History's filter once it shows.
if (hcase === 'filter') setTimeout(() => { const field = document.querySelector('.hist-filter'); if (field) { field.value = 'refresh'; field.dispatchEvent(new Event('input', { bubbles: true })); } }, 700);
// The drawer view unpins the list, which is otherwise pinned as a column outside the phone's layout.
if (view === 'drawer') localStorage.setItem('switchboard.listCollapsed', '1'); else localStorage.removeItem('switchboard.listCollapsed');
// Every view starts as a first start: all views share one browser profile, and a start with no work item in its hash (the list's, Settings')
// would otherwise come back to the work item an earlier view kept, and a conversation to the place an earlier drag left it (route.ts).
localStorage.removeItem('switchboard.route');
// Each view's artifacts are new to the page and it keeps no tabs, so the tabs view's changed artifacts are unread and History has no tab,
// whatever an earlier view showed.
localStorage.removeItem('switchboard.artifactsSeen');
localStorage.removeItem('switchboard.tabs');
sessionStorage.removeItem('switchboard.scroll');
const now = Date.now();
const row = (id, title, patch = {}) => ({ workItemId: id, ticketId: id, title, priority: null, time: null, ticket: 'gh ' + id, ticketNumber: String(id), sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], band: null, voice: null, history: null, ...patch });
// Line 3 with a state's headline (architecture.md § States): one dimmed as of the last turn, one current, so the lists are as tall as a running list.
const state = (text, tone) => ({ text, title: null, tone });
const remove = { label: 'Delete', action: 'delete', icon: 'trash', group: 'state', confirm: { question: 'Delete Fix it?', detail: 'It goes for good.', action: 'delete' }, input: null };
// The open work item's main control, which the header draws beside Actions: its icon alone on a phone.
const approve = { label: 'Approve', action: 'approve', icon: 'check', group: 'main', confirm: null, input: null };
// The menu views' work item offers as much as a real one awaiting approval, so its Actions and row menus are as long: on a phone on its side
// taller than the room, so they scroll, and on a phone held upright and an iPad not.
const control = (label, action, icon, group) => ({ label, action, icon, group, confirm: null, input: null });
const asking = (label, action, icon) => ({ ...control(label, action, icon, 'asking'), confirm: { question: label + ' Fix it?', detail: 'It cannot be undone.', action } });
const crowdedMenu = view?.endsWith('-menu') ? { actions: [approve, control('Snooze…', 'snooze', 'clock', 'state'), control('Mark done', 'done', 'pass', 'state'), control('Add comment…', 'comment', 'comment', 'notes'), asking('Stop session', 'stop', 'debug-stop'), { ...remove, group: 'asking' }], pastes: ['report', 'comment'], opens: [{ label: 'Open in VS Code', icon: 'vscode' }, { label: 'Open report', icon: 'file', file: 'D:/w/report.md' }], url: 'https://github.com/o/r/issues/1' } : {};
const snooze = { label: 'Snooze…', action: 'snooze', icon: 'clockface', group: 'state', confirm: null, input: null };
// The second row's line 2 holds more pills than fit beside its long playbook, so some drop out.
const pr = (n) => ({ label: 'PR #' + n, url: 'https://github.com/o/r/pull/' + n, kind: 'pr', badge: String(n), glyph: '\u{ea64}', mentioned: false });
const crowded = { ticket: 'gh 21509', ticketNumber: '21509', url: 'https://github.com/o/r/issues/21509', playbook: 'dev:address-pr-review', comment: { glyph: '\u{ea6b}', title: 'A comment' }, links: [pr(21512), pr(21513), pr(21514), pr(21515), { label: 'Design notes', url: 'https://example.com/notes', kind: 'url', badge: 'Design notes', glyph: '\u{eb15}', mentioned: false }], returned: 2 };
// The fourth row's short playbook leaves room for its pills as icons and some of their texts at 300 px.
// Its key is a DPAF topic's, whose plugin gives its own logo (the header's sources, below).
const short = { ticket: 'dpaf 7', ticketNumber: '7', sourceKind: 'dpaf', url: 'https://example.com/forum/7', playbook: 'dev:plan', links: [pr(21516), { label: 'gh 21517', url: 'https://github.com/o/r/issues/21517', kind: 'issue', badge: '21517', glyph: '\u{ea84}', mentioned: true }, { label: 'Spec', url: 'https://example.com/spec', kind: 'url', badge: 'Spec', glyph: '\u{eb15}', mentioned: false }], returned: 3 };
// The fifth row's seven pills, outside the narrow views: six short texts, then a long one that does not fit beside them at the phone's width,
// so it drops out whole.
const link = (badge) => ({ label: badge, url: 'https://example.com/' + badge, kind: 'url', badge, glyph: '\u{eb15}', mentioned: false });
const many = { ticket: 'gh 9', ticketNumber: '9', playbook: 'dev:x', links: ['1', '2', '3', '4', '5', '6', 'A long seventh label'].map(link) };
// The sixth row's long ad hoc key, of a source with no logo, and a link with a long label; the seventh's key, longer than the line, beside a
// comment icon and a long playbook. The narrow views leave out the first, fifth and seventh rows, so the list fits a phone's height on its side.
const adhoc = { ticket: 'switchboard-worktrees 1234', ticketNumber: undefined, sourceKind: 'adhoc', links: [link('A very long design document title')] };
// The header's sources: GitHub's and Zoho's logos are the page's own; the DPAF plugin gives its own, a made-up mark here.
const source = (kind, label, icon) => ({ kind, label, ...(icon ? { icon } : {}), enabled: true, title: label, sources: [{ name: kind, enabled: true }] });
// The list's notes, which a phone folds into one line.
const header = { notes: view === 'list' || view?.startsWith('narrow') ? ['settings.json: sources.zoho.orgId is missing, so Zoho Desk is not polled.', 'Voice: the voice process stopped.'] : [], sources: [source('github', 'GitHub'), source('zoho', 'Zoho Desk'), source('dpaf', 'DPAF', { viewBox: '0 0 16 16', path: 'M1 3h14v10H1z', color: '#2f6fb0' })], repoRoots: [], schedules: [] };
const groups = [{ key: 'progress', title: 'In progress', glyph: '\u{ea70}', empty: null, rows: [row(1, 'Fix it', { history: { ticketId: 1, key: 'gh 1' }, ...(hcase === 'waiting' ? { mark: { kind: 'permission', glyph: '\u{eb53}', title: 'Approve a permission' } } : {}), actions: [approve, snooze, remove], details: [state('2/5 fixing tests · 4m', 'dim')], ...crowdedMenu }), row(2, 'Another thing with questions waiting on the operator and a long title', { ...crowded, questions: 12 }), row(3, 'Hosted', { host: 'a-very-long-host-name.example.com', ticket: 'zoho 21510', ticketNumber: '21510', sourceKind: 'zoho', url: 'https://desk.zoho.com/t/21510', comment: { glyph: '\u{ea6b}', title: 'A comment' }, details: [state('reviewing the comments · 1m', null)] }), row(4, 'Short playbook', { ...short, questions: 1 }), ...(view?.startsWith('narrow') ? [] : [row(5, 'Many links', many)]), row(6, 'Ad hoc', adhoc), ...(view?.startsWith('narrow') ? [] : [row(7, 'Long key', { ticket: 'a-very-long-ad-hoc-repository-folder-name-for-testing 12345', ticketNumber: undefined, sourceKind: 'adhoc', comment: { glyph: '\u{ea6b}', title: 'A comment' }, playbook: 'dev:address-pr-review' })])].filter((one) => !(view?.startsWith('narrow') && one.workItemId === 1)) }];
// The list at its narrowest, 200 px, at 260 and 300 px, where line 2's pills show their icons alone, and at 330 and 420 px, where they show
// their texts. Only its width is set: it keeps page.css's flex: 1 in the side column, which bounds its height so it scrolls.
const narrow = view === 'narrow' ? 200 : view?.startsWith('narrow-') ? Number(view.slice(7)) : null;
const listing = view === 'list' || view === 'more-menu' || view === 'row-menu' || narrow !== null;
const open = !listing && !view?.startsWith('settings');
if (narrow !== null) document.head.insertAdjacentHTML('beforeend', '<style>#list { width: ' + narrow + 'px !important; min-width: 0 !important; max-width: none !important; }</style>');
// A title longer than any header here fits, so the header shows how much of it is left beside the main control.
const longTitle = 'Call Center dialer stops receiving incoming calls when its registration lapses';
const scope = open ? { kind: 'page', key: 'k', folder: 'D:/w', title: longTitle, scopeGen: 3, conversations: [{ workItemId: 1, title: longTitle, primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0, sessionTitle: 'switchboard · dev:build · github 1' }], workItemId: 1, cwd: 'D:/w', sessionId: 's' } : null;
const session = { id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, ...(view === 'context' ? { provider: 'claude', context: { used: 120000, window: 200000, compactAt: 167000, model: 'claude-opus-4-5' } } : { context: { used: 618_000, window: 1_000_000, compactAt: 967_000, model: 'claude-opus-5-5' } }) };
// The context meter's details (architecture.md § Context meter), as the hub answers them for a Claude session.
const contextDetails = { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium', parts: { cacheRead: 598_000, cacheWrite: 14_000, input: 2_000, output: 4_000, reasoning: null }, compacted: { at: Date.now() - 7_200_000, trigger: 'auto' }, windows: [{ minutes: 300, limit: null, usedPercent: 79, resetsAt: Date.now() + 9_000_000 }, { minutes: 10_080, limit: null, usedPercent: 63, resetsAt: Date.now() + 120_000_000 }, { minutes: 10_080, limit: 'Fable', usedPercent: 4, resetsAt: Date.now() + 120_000_000 }], limit: null };
const items = [];
for (let i = 0; view !== 'empty' && open && i < 30; i++) {
  items.push({ type: 'message', id: 'm' + i, sessionId: 's', workItemId: 1, at: now - 100000 + i * 2000, ord: i * 2, provisional: false, withdrawn: false, origin: 'typed', text: 'Message ' + i, delivery: 'sent', error: null });
  items.push({ type: 'reply', id: 'r' + i, sessionId: 's', at: now - 99000 + i * 2000, ord: i * 2 + 1, provisional: false, kind: 'reply', answers: null, opening: 'Reply ' + i + ', long enough to wrap across a phone screen.' + (i === 29 ? '\\n\\n| Column | Another column |\\n|---|---|\\n| a | b |' : i === 28 ? '\\n\\n~~~\\nnpm run build --workspace @switchboard/web && npm run check:shell --workspace @switchboard/web\\n~~~' : i === 27 ? '\\n\\n- [x] Find the cause\\n- [ ] Fix the renewal' : ''), rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null } });
}
// The questions views: the first reply asks two questions, so their card is far above the end, where the session waits on a permission in its
// terminal (questions) or has ended and takes a message, which resumes it (questions-ended, a Codex app-server session).
// Asides follow it and no message, which would answer it.
if (open && view?.startsWith('questions')) items.splice(0, items.length, ...items.filter((item, index) => index < 2 || item.type === 'reply').map((item, index) => (index < 2 ? item : { ...item, kind: 'aside' })));
if (open && view?.startsWith('questions')) items[1].opening = 'I need two decisions.\\n\\n1. **Renewal lead.** How early should the registration renew? {#renew}\\n   - A) 30 s before expiry\\n   - B) At half the lifetime\\n2. Keep the old route? {#keep-route}\\n   - A) Keep\\n   - B) Remove';
if (view === 'questions') Object.assign(session, { state: 'waiting', waitingFor: 'permission' });
if (view === 'questions-ended') Object.assign(session, { state: 'ended', provider: 'codex' });
// The conversation ends with a message the transcript did not show, so its Send again is measured as a touch target.
if (open && view === 'conversation') items.push({ type: 'message', id: 'm-lost', sessionId: 's', workItemId: 1, at: now - 30000, ord: 100, provisional: false, withdrawn: false, origin: 'typed', text: 'Can we make these notices bigger?', delivery: 'unconfirmed', error: 'The transcript does not show this message.' });
// The Changes views open it by the route, which leaves its tab in the strip.
history.replaceState(null, '', location.search + (open ? (view?.endsWith('-changes') ? '#w=1&t=changes' : '#w=1') : '#'));
// The tabs view's work item has more artifacts, with long titles but the newest's, than any strip here fits.
// The mic views' work item has one long Markdown artifact.
const mic = view?.startsWith('mic-') === true;
const artifacts = mic ? [{ path: 'chat/plan.md', owner: 'chat', kind: 'note', title: 'Plan', ext: 'md', type: 'markdown', updatedAt: now - 1000 }] : view === 'tabs' || view === 'tab-menu' ? Array.from({ length: view === 'tab-menu' ? 20 : 10 }, (_, i) => ({ path: 'chat/a' + i + '.md', owner: 'chat', kind: 'note', title: i === 9 ? 'Plan' : 'A long artifact title number ' + i, ext: 'md', type: 'markdown', updatedAt: now - (10 - i) * 1000 })) : [];
class FakeSource {
  constructor() {
    this.listeners = {};
    setTimeout(() => this.emit('hello', { key: 'pk', groups, header, scope, sessions: open ? [session] : [], items, more: false, state: view === 'history' ? { id: 'st', sessionId: 's', shortId: 'a3f9', endedAt: hcase === 'ended' ? now - 60000 : null, at: now - 240000, headline: 'Fix built; two tests still failing', body: 'Rebuilt the dialer registration refresh so a lapsed SIP registration renews itself.\\n\\n- **Done:** \`RegistrationMonitor\` renews 30 s before expiry; 14 of 16 tests pass.\\n- **Next:** fix \`Reconnect_AfterLapse_RestoresInbound\` and \`Renew_DuringCall_KeepsCall\`.\\n- **Needs you:** nothing yet.', stale: hcase === 'ended' ? 'session' : hcase === 'turn' ? 'turn' : null, unread: hcase !== 'ended' && hcase !== 'turn' } : view === 'tabs' ? { id: 'st', sessionId: 's', at: now, headline: 'Built', body: 'Built.', stale: null, unread: true } : null, artifacts, unread: 0, ...(mic ? { voice: { enabled: true, here: true, mic: 'listening', speaking: null, speakReplies: false, error: null, recognizer: null } } : {}) }), 20);
    // The tabs view's artifacts change after the page first shows them, so each is unread until its tab shows it.
    if (view === 'tabs') setTimeout(() => artifacts.forEach((artifact) => this.emit('artifact', { artifact: { ...artifact, updatedAt: artifact.updatedAt + 60000 } })), 120);
    // check-resize pauses the stream (window.__paused), so a resize is shown without a redraw.
    if (listing) setInterval(() => window.__paused || this.emit('list', { groups }), 120);
  }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener() {}
  close() {}
  emit(type, data) { for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify({ type, ...data }) }); }
}
window.EventSource = FakeSource;
// On the list, the same list again every 120 ms, as a busy hub sends it, and line 2 as each frame starts, that is as the last frame painted it.
// Frames while a web font loads are skipped: a frame can lay out the loaded font before the set's loadingdone, which refits the pills' tab
// stops (main.ts, fitListLinks), and a font load is not a list sent again.
if (listing) {
  window.__line2 = [];
  const sample = () => {
    const lines = [...document.querySelectorAll('#list .row-line:not(.row-details)')];
    if (lines.length > 0 && document.fonts.status === 'loaded') window.__line2.push(lines.map((line) => line.innerHTML + [...line.querySelectorAll('.pill')].map((pill) => pill.getBoundingClientRect().width).join()).join('|'));
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}
// History's tab reads a ticket with two work items: the open one with stage and reply states, a run of state changes, a wait and its answer;
// a done one; and the ticket's. hcase (--history-case) shows the pinned state ended or as of the last turn, the row waiting on you, or a filter.
const he = (key, minutes, patch) => ({ key, at: now - minutes * 60000, category: 'session', icon: 'terminal', text: key, lines: [], detail: null, shortId: null, links: [], tone: null, reconstructed: false, refused: null, stateChange: false, stateId: null, body: null, stage: false, ...patch });
const hstate = (key, minutes, text, patch = {}) => he(key, minutes, { category: 'state', icon: 'pulse', text, stateId: key, shortId: 'a3f9', ...patch });
const historyView = { key: 'gh 1', title: longTitle, url: 'https://github.com/o/r/issues/1', repo: 'switchboard', status: 'Running', tone: null, playbook: 'dev:build', facts: ['Yours since 2026-11-24 09:12', 'Waited on you 1h 12m', '2 work items, 3 sessions, 5h 8m'], links: [{ label: 'Open ticket', icon: 'link-external', title: 'https://github.com/o/r/issues/1', open: { type: 'openUrl', url: 'https://github.com/o/r/issues/1' } }, { label: 'fix/dialer-registration', icon: 'repo', title: 'D:/w', open: { type: 'openFolder', path: 'D:/w' } }], reconstructed: false, recordedSince: null, sections: [
  { key: 'w1', workItemId: 1, title: 'dev:build', status: 'Running', tone: null, facts: ['Created 2026-11-25 08:02', '1 session, 2h 40m'], prompt: null, entries: [
    he('a1', 170, { category: 'triage', icon: 'filter', text: 'Triage chose dev:build' }),
    he('a2', 165, { icon: 'terminal', text: 'Session a3f9 started', shortId: 'a3f9', links: [{ label: 'Open in terminal', icon: 'terminal', title: 'Attach to session a3f9', open: { type: 'open', session: 's', workItemId: 1 } }] }),
    hstate('stage-s-1', 120, 'Planning the registration refresh', { stage: true, category: 'state' }),
    he('a4', 95, { category: 'you', icon: 'account', text: 'You sent a message', tone: 'accent' }),
    // A link with a short label, so its touch target's width is measured.
    he('a5', 90, { category: 'report', icon: 'link', text: 'Linked PR', links: [{ label: 'PR', icon: 'link-external', title: 'https://github.com/o/r/pull/2', open: { type: 'openUrl', url: 'https://github.com/o/r/pull/2' } }] }),
    hstate('st-2', 60, 'Implementing the refresh in RegistrationMonitor', { body: 'Renewal timer added; wiring the lapse event to the inbound route next. **Needs you:** nothing.' }),
    he('a6', 30, { icon: 'shield', text: 'Session a3f9 is waiting on a permission prompt', shortId: 'a3f9', tone: 'warning' }),
    he('a7', 25, { category: 'you', icon: 'check', text: 'You approved it', tone: 'accent' }),
    ...Array.from({ length: 25 }, (_, i) => he('b' + i, 24 - i * 0.8, { icon: 'play-circle', text: 'Session a3f9 is working', shortId: 'a3f9', stateChange: true })),
    hstate('st', 4, 'Fix built; two tests still failing'),
  ] },
  { key: 'w9', workItemId: 9, title: 'dev:plan', status: 'Done', tone: 'success', facts: ['Created 2026-11-24 09:12', 'Done 2026-11-24 11:40', '2 sessions, 2h 28m'], prompt: null, entries: [
    he('c1', 1500, { text: 'Session 7c21 started', shortId: '7c21' }),
    hstate('st-p', 1400, 'Plan written: refresh 30 s before expiry', { shortId: '7c21', body: 'The plan is in the ticket.' }),
  ] },
  { key: 'ticket', workItemId: null, title: 'Ticket', status: '', tone: null, facts: ['Assignment, pool, snoozes and worktree'], prompt: null, entries: [he('d1', 1600, { category: 'ticket', icon: 'issues', text: 'Switchboard first saw the ticket, assigned to you' })] },
] };
// Settings reads a file with checkboxes on General and in the playbooks' table.
const settingsRead = { settings: { path: 'C:/Users/someone/.switchboard/settings.json', version: 'v1', value: { sessions: { codeMode: true }, web: { tailscale: true }, sources: { github: { repo: 'o/r', logins: ['me'], repoRoot: 'D:/git/r' } }, schedules: { weekly: { playbook: 'dev:build', repoRoot: 'D:/git/r', every: 'week', day: 'mon', at: '09:00' } }, voice: { enabled: true, personas: [{ id: 'nova', name: 'Nova', voice: 'cedar' }], playbookPersonas: { 'dev:build': 'nova' } }, playbooks: { 'dev:build': { description: 'Build it', template: 'Build.', reports: ['done', 'approval'] }, 'dev:plan': { description: 'Plan it', template: 'Plan.', autoStart: true } } }, error: null }, permissionModes: ['default', 'auto'], codexPermissionModes: ['default'], providers: ['claude', 'codex'], templateVariables: [], sourceKinds: ['github'], sourceLabels: { github: 'GitHub' }, inUse: {}, enabled: { github: true }, configDir: 'C:/Users/someone/.switchboard' };
// Pair a device and Devices list more devices than the sheet shows at once, so its list scrolls, and a pairing address longer than a phone's line.
const pairDevices = [{ id: 'a1', label: 'Windows · Edge', host: null, login: null, createdAt: now, usedAt: now, current: true }, { id: 'b2', label: 'iPhone · Safari', host: 'pc.tailnet.ts.net', login: 'someone@example.com', createdAt: now, usedAt: now, current: false, voice: true }, ...['Android · Chrome', 'iPad · Safari', 'Mac · Safari', 'Windows · Chrome', 'Linux · Firefox', 'Android · Firefox'].map((label, i) => ({ id: 'c' + i, label, host: 'some-long-computer-name.tail1234ab.ts.net', login: 'someone@example.com', createdAt: now, usedAt: now - i * 86400000, current: false }))];
const pairing = { url: 'https://some-long-computer-name.tail1234ab.ts.net/page?t=' + 'a'.repeat(64), code: 'ABCD-EFGH', host: 'some-long-computer-name.tail1234ab.ts.net', expiresAt: now + 5 * 60000 };
// The Changes views' routes: three changed files of a branch of one commit, the worktree's files, and each file's patch and sides.
const changesList = { scopeGen: 3, base: 'b0', head: 'c1', from: 'base', to: 'worktree', commits: [{ sha: 'c1', parent: 'b0', subject: 'Renew the registration before it lapses', time: Math.floor(now / 1000) - 600 }], commitsMore: false, rows: [{ path: 'src/dialer/registration.ts', status: 'M', stages: ['committed'], additions: 30, deletions: 4, binary: false, hash: 'h1', viewed: false }, { path: 'src/dialer/monitor.ts', status: 'M', stages: ['working'], additions: 3, deletions: 1, binary: false, hash: 'h2', viewed: false }, { path: 'src/dialer/timer.ts', status: 'M', stages: ['working'], additions: 1, deletions: 0, binary: false, hash: 'h3', viewed: false }], stages: { committed: 1, staged: 0, working: 2, untracked: 0 }, shown: 3, total: 3 };
const oldSide = 'export function renew() {\\n  register();\\n}\\n';
const newSide = 'export function renew() {\\n  register();\\n  schedule();\\n}\\n';
const diffOf = (path) => ({ path, status: 'M', patch: 'diff --git a/' + path + ' b/' + path + '\\n--- a/' + path + '\\n+++ b/' + path + '\\n@@ -1,3 +1,4 @@\\n export function renew() {\\n   register();\\n+  schedule();\\n }\\n', old: oldSide, new: newSide, binary: false, tooLarge: null });
const planText = '# Plan\\n\\n' + Array.from({ length: 40 }, (_, i) => 'Step ' + (i + 1) + ': renew the registration 30 s before it lapses, and check the inbound route again.').join('\\n\\n');
const stackData = { scopeGen: 3, repo: 'switchboard', root: 'D:/w', branch: 'fix/dialer-registration', head: 'c1', commitIds: ['c1'], more: false, incomplete: false, github: { state: 'none', observedAt: null }, links: [], main: { ref: 'origin/main', behind: 0, fetchedAt: now } };
const changeRoute = (url) => (url.includes('/v1/conversation/changes') ? changesList : url.includes('/v1/conversation/stack') ? stackData : url.includes('/v1/conversation/tree') ? { scopeGen: 3, paths: changesList.rows.map((row) => row.path), more: false } : url.includes('/v1/conversation/diff?') ? diffOf(new URL(url, location.href).searchParams.get('path')) : null);
window.fetch = async (url) => ({ status: 200, ok: true, headers: new Headers(), json: async () => (changeRoute(String(url)) ?? (String(url).endsWith('/page-devices') ? { devices: pairDevices } : String(url).endsWith('/page-pair') ? pairing : String(url).endsWith('/page-voice-enroll') ? { enrollment: { state: 'idle', endsAt: null, error: null, enrolledAt: '2026-10-02T10:00:00.000Z' } } : String(url).endsWith('/page-history') ? { view: historyView, categories: [{ key: 'state', label: 'States', icon: 'pulse' }, { key: 'you', label: 'You', icon: 'account' }, { key: 'session', label: 'Sessions', icon: 'terminal' }, { key: 'report', label: 'Reports', icon: 'comment' }, { key: 'triage', label: 'Triage', icon: 'filter' }, { key: 'ticket', label: 'Ticket', icon: 'issues' }] } : String(url).endsWith('/page-settings-read') ? settingsRead : String(url).endsWith('/page-settings-check') ? { errors: [] } : String(url).endsWith('/context-details') ? { details: contextDetails } : {})), text: async () => (String(url).includes('/v1/conversation/artifact/') ? planText : '') });
const matchMedia = window.matchMedia.bind(window);
window.matchMedia = (query) => (query.includes('display-mode: standalone') ? { matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : matchMedia(query));
</script>`;

/** Measures the open view: the document, whatever reaches past the viewport outside a scroller, and the scrollers. */
const measure = `(() => {
  const root = document.documentElement;
  const shown = (node) => { for (let one = node; one; one = one.parentElement) { const style = getComputedStyle(one); if (style.display === 'none' || style.visibility === 'hidden') return false; } return true; };
  const scrolls = (node) => /auto|scroll/.test(getComputedStyle(node).overflowY + getComputedStyle(node).overflowX);
  // A computed colour's red, green, blue and alpha, from rgb(), rgba() or color(srgb), its alpha laid over a colour under it, and contrast ratios.
  const rgba = (colour) => { const n = (colour.match(/[0-9.]+/g) ?? []).map(Number); const scale = colour.startsWith('color(srgb') ? 255 : 1; return [n[0] * scale, n[1] * scale, n[2] * scale, n[3] ?? 1]; };
  const over = (top, under) => { const [r, g, b, a] = rgba(top); const [ur, ug, ub] = typeof under === 'string' ? rgba(under) : under; return [r * a + ur * (1 - a), g * a + ug * (1 - a), b * a + ub * (1 - a)]; };
  const luminance = (rgb) => { const [r, g, b] = rgb.map((one) => { const c = one / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (one, two) => { const [high, low] = [luminance(one), luminance(two)].sort((a, b) => b - a); return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100; };
  const clipped = (node) => { for (let one = node.parentElement; one && one !== document.body; one = one.parentElement) { if (/auto|scroll|hidden|clip/.test(getComputedStyle(one).overflowY)) return true; } return false; };
  const name = (node) => node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/ +/).join('.') : '');
  const nodes = [...document.querySelectorAll('body *')].filter(shown);
  const past = nodes.filter((node) => { const box = node.getBoundingClientRect(); return box.height > 0 && box.width > 0 && (box.bottom > innerHeight + 0.5 || box.right > innerWidth + 0.5 || box.top < -0.5) && getComputedStyle(node).position !== 'fixed' && !clipped(node); }).map(name);
  /** Whether a drag that reaches the end of the node stops there or at a scroller around it, never reaching the page. A scroller inside a pane, such as a table, leaves a drag to its pane. */
  const kept = (node) => { for (let one = node; one && one !== document.body; one = one.parentElement) { const style = getComputedStyle(one); if (scrolls(one) && /^(contain|none)$/.test(style.overscrollBehaviorY) && /^(contain|none)$/.test(style.overscrollBehaviorX)) return true; } return false; };
  const scrollers = nodes.filter((node) => scrolls(node) && node.clientHeight > 0).map((node) => ({ name: name(node), over: node.scrollHeight - node.clientHeight, overscroll: getComputedStyle(node).overscrollBehaviorY + ' ' + getComputedStyle(node).overscrollBehaviorX, kept: kept(node) }));
  const top = (selector) => { const node = [...document.querySelectorAll(selector)].find(shown); return node ? Math.round(node.getBoundingClientRect().top * 100) / 100 : null; };
  return {
    root: document.getElementById('root').className,
    phone: root.classList.contains('phone'),
    document: { height: root.scrollHeight, client: root.clientHeight, width: root.scrollWidth, clientWidth: root.clientWidth, body: document.body.scrollHeight, bodyClient: document.body.clientHeight },
    touchAction: getComputedStyle(document.body).touchAction,
    past, scrollers,
    edge: (() => {
      // WebKit's top-edge test (LocalFrameView::fixedContainerEdges): the point 4 px down at the top's middle, pointer-events ignored, then up to the
      // first fixed or sticky box at least 90% of the viewport wide (narrower ones are skipped, unless full height) and under 105% tall.
      const all = document.createElement('style');

      all.textContent = '* { pointer-events: auto !important; }';
      document.head.append(all);
      const hit = document.elementFromPoint(innerWidth / 2, 4);

      all.remove();
      for (let one = hit; one && one !== root; one = one.parentElement) {
        const style = getComputedStyle(one);

        if (style.position !== 'fixed' && style.position !== 'sticky') continue;
        const box = one.getBoundingClientRect();
        const wide = box.width / innerWidth;
        const tall = box.height / innerHeight;

        if (style.visibility === 'hidden' || Number(style.opacity) < 0.1 || (style.backgroundColor === 'rgba(0, 0, 0, 0)' && one.children.length === 0)) continue;
        if (wide < 0.9 ? tall < 0.9 : tall >= 1.05) continue;
        return { name: name(one), kind: wide < 0.9 ? 'sidebar' : tall >= 0.9 ? 'viewport' : 'bar', top: box.top, height: box.height, wide: Math.round(wide * 1000) / 1000, background: style.backgroundColor };
      }
      return { name: null, hit: hit && name(hit) };
    })(),
    bar: (() => { const probe = document.createElement('div'); probe.style.background = 'var(--sb-bar-background)'; document.body.append(probe); const colour = getComputedStyle(probe).backgroundColor; probe.remove(); return colour; })(),
    // History's head (architecture.md § Web page): the headings in order with their sizes, and where the title and the pinned state's headline
    // sit in the body's content, so the check can say the title comes first and a first screen holds the state.
    histHead: (() => {
      const body = document.querySelector('.hist-body');
      if (body === null) return null;
      const top = (selector) => { const one = body.querySelector(selector); return one === null ? null : one.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop; };
      return { headings: [...body.querySelectorAll('h1, h2, h3')].map((one) => one.tagName + ' ' + parseFloat(getComputedStyle(one).fontSize)), title: top('h1'), state: top('.hist-now-headline'), screen: body.clientHeight };
    })(),
    histEnd: (() => { const body = document.querySelector('.hist-body'); return body === null ? null : parseFloat(getComputedStyle(body).paddingBottom); })(),
    band: document.getElementById('safe-top').getBoundingClientRect().height,
    // Line 2 of each shown row: a pill is whole inside its line and its box, its text shown whole; its icon alone, its text hidden from view
    // but kept for screen readers; or wholly outside them, left out.
    line2: window.__line2 ? { samples: window.__line2.length, ways: new Set(window.__line2).size } : null,
    // Line 1's waiting questions: whole inside line 1 and the row, after the title, which is cut before them where it does not fit; their icon
    // alone, whole inside them, visible in the warning text colour with a loaded codicon face and a glyph to draw, and no visible text.
    questions: [...document.querySelectorAll('#list .row-head .questions')].filter(shown).map((badge) => {
      const box = badge.getBoundingClientRect();
      const head = badge.closest('.row-head').getBoundingClientRect();
      const row = badge.closest('.row').getBoundingClientRect();
      const title = badge.closest('.row-head').querySelector('.row-title');
      const icon = badge.querySelector('.codicon-question');
      const glyph = icon === null ? null : icon.getBoundingClientRect();
      const style = icon === null ? null : getComputedStyle(icon);
      const probe = document.createElement('span');
      probe.style.color = 'var(--vscode-editorWarning-foreground)';
      document.body.append(probe);
      const warning = getComputedStyle(probe).color;
      probe.remove();
      const face = [...document.fonts].some((one) => one.family.replaceAll('"', '') === 'codicon' && one.status === 'loaded');
      const visible = [badge, icon].every((one) => one !== null && getComputedStyle(one).visibility === 'visible' && getComputedStyle(one).opacity === '1');
      const drawn = icon !== null && visible && face && style.color === warning && /codicon/.test(style.fontFamily) && glyph.width > 8 && glyph.height > 8 && glyph.left >= box.left - 0.5 && glyph.right <= box.right + 0.5 && glyph.top >= box.top - 0.5 && glyph.bottom <= box.bottom + 0.5 && !['none', 'normal', '""'].includes(getComputedStyle(icon, '::before').content);
      return { text: badge.getAttribute('aria-label'), whole: box.left >= head.left - 0.5 && box.right <= head.right + 0.5 && box.right <= row.right + 0.5 && box.top >= head.top - 0.5 && box.bottom <= head.bottom + 0.5, after: title.getBoundingClientRect().right <= box.left + 0.5, icon: drawn && badge.children.length === 1 && badge.textContent === '', titleCut: title.scrollWidth > title.clientWidth + 0.5 };
    }),
    // Each line 2's items in order, each starting after the one before, so none sits below another.
    // Line 2 never wraps: the line is 18 px tall and every item lies inside it, none taller than one line.
    lines: [...document.querySelectorAll('#list .row-line:not(.row-details)')].filter(shown).map((line) => { const edge = line.getBoundingClientRect(); const items = [...line.children].map((one) => one.getBoundingClientRect()); return { row: line.closest('.row').querySelector('.row-title').textContent, oneLine: items.every((box, i) => i === 0 || box.left >= items[i - 1].right - 0.5), wrapped: edge.height > 18.5 || items.some((box) => box.height > 18.5 || box.top < edge.top - 0.5 || box.bottom > edge.top + 18.5) }; }),
    // A playbook or host is cut only where its one-line width does not fit beside the comment icon and the key, each with its 6 px gap, and
    // then with an ellipsis, its tooltip naming it whole.
    names: [...document.querySelectorAll('#list .row-line .playbook')].filter(shown).map((name) => {
      const box = name.getBoundingClientRect();
      const line = name.closest('.row-line');
      const edge = line.getBoundingClientRect();
      const icon = name.previousElementSibling?.classList.contains('comment') ? name.previousElementSibling.getBoundingClientRect() : null;
      const copy = name.cloneNode(true);
      copy.style.cssText = 'position: absolute; visibility: hidden; white-space: nowrap;';
      line.append(copy);
      const natural = copy.getBoundingClientRect().width;
      copy.remove();
      const beside = [...line.querySelectorAll(':scope > .comment, :scope > .pill')].reduce((sum, one) => sum + one.getBoundingClientRect().width + 6, 0);
      const style = getComputedStyle(name);
      const host = name.classList.contains('host');
      // The lines its text takes, from its text's own boxes, so a wrap clipped inside its box counts too.
      const range = document.createRange();
      range.selectNodeContents(name);
      const textLines = new Set([...range.getClientRects()].filter((one) => one.width > 0).map((one) => Math.round(one.top))).size;
      return { text: name.textContent, alone: icon !== null && icon.bottom <= box.top + 0.5, cut: name.scrollWidth > name.clientWidth + 0.5, past: box.right > edge.right + 0.5 || box.bottom > edge.bottom + 0.5, ellipsis: style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap' && style.overflow === 'hidden', width: box.width, tooltip: name.title === (host ? 'Hosted by ' + name.textContent : name.textContent), textLines, fits: natural + beside <= edge.width - 0.5 };
    }),
    // Each key's and issue link's logo, and whether its source label shows, which its logo stands for.
    keys: [...document.querySelectorAll('#list .row-line .pill.ticket, #list .row-line .pill.link.issue')].filter(shown).map((pill) => { const label = pill.querySelector('.key-label'); return { text: pill.querySelector('.pill-text').textContent, issue: pill.classList.contains('issue'), logo: pill.firstElementChild?.getAttribute('class') ?? null, label: label === null ? null : label.getBoundingClientRect().width > 1.5 }; }),
    pills: [...document.querySelectorAll('#list .row-line:not(.row-details)')].filter(shown).flatMap((line, at) => {
      // The list has one Tab stop (main.ts, setListTabStop): focused, this row is it, and only its pills that show are keyboard stops.
      line.closest('.row').focus({ preventScroll: true });
      // A dialog over the list, as Settings, keeps the focus, so its rows' stops are not measured.
      const focused = document.activeElement === line.closest('.row');
      const others = focused ? [...document.querySelectorAll('#list .pill[data-action]')].filter((pill) => pill.tabIndex === 0 && pill.closest('.row') !== line.closest('.row')).length : 0;
      const edge = line.getBoundingClientRect();

      return [...line.querySelectorAll(':scope > .pill, .row-links > .pill')].map((pill) => {
        const box = pill.getBoundingClientRect();
        const holder = (pill.closest('.row-links') ?? line).getBoundingClientRect();
        const right = Math.min(edge.right, holder.right);
        const bottom = Math.min(edge.bottom, holder.bottom);
        const inside = box.left >= edge.left - 0.5 && box.right <= right + 0.5 && box.top >= edge.top - 0.5 && box.bottom <= bottom + 0.5;
        const outside = box.left >= right - 0.5 || box.top >= bottom - 0.5;

        const text = pill.querySelector('.pill-text');
        const icon = pill.querySelector('.codicon, .source-logo');
        const style = getComputedStyle(text);
        const textBox = text.getBoundingClientRect();
        // A text paints only where its box is wider and taller than the 1 px a text hidden from view keeps.
        const shown = textBox.width > 1.5 && textBox.height > 1.5;
        // A text shown must lie whole inside the pill's border; an icon alone must be there to show.
        const whole = shown ? textBox.left >= box.left - 0.5 && textBox.right <= box.right - 0.5 : icon !== null && icon.getBoundingClientRect().width > 0;
        const state = inside ? (whole ? (shown ? 'whole' : 'icon') : 'cut') : outside ? 'out' : 'cut';

        return { text: text.textContent, line: at, width: edge.width, ticket: pill.classList.contains('ticket'), state, clipped: shown || (style.overflow === 'hidden' && style.clipPath !== 'none'), named: style.display !== 'none' && style.visibility !== 'hidden' && text.textContent.trim() !== '', stop: focused && pill.hasAttribute('data-action') ? pill.tabIndex : null, others };
      });
    }),
    // Each shown tab strip: a label shown cut narrower than about five characters, or not at all, and any tab past the strip's edges.
    strips: [...document.querySelectorAll('.tabs:not(.opening-tabs)')].filter(shown).map((strip) => {
      const edge = strip.getBoundingClientRect();
      const tabs = [...strip.children].filter(shown);

      return {
        tabs: tabs.length,
        more: strip.querySelector('.tab-more') !== null,
        moreUnread: (strip.querySelector('.tab-more-button')?.getAttribute('aria-label') ?? '').includes('unread'),
        // Whether History shows, and how many artifact tabs show besides the one chosen: the tabs whose unread dots the tabs view expects.
        history: tabs.some((tab) => tab.dataset.id === 'history'),
        artifacts: tabs.filter((tab) => (tab.dataset.id ?? '').startsWith('artifact:') && !tab.classList.contains('selected') && tab.querySelector('[aria-selected="true"]') === null).length,
        // A fixed tab's label, outside an open button, drawn narrower than its text.
        fixedCut: [...strip.querySelectorAll(':scope > .tab > .tab-label')].filter((label) => shown(label) && label.scrollWidth > label.clientWidth + 0.5).map((label) => label.textContent),
        cut: [...strip.querySelectorAll('.tab-label')].filter((label) => !shown(label) || label.getBoundingClientRect().width < Math.min(43.5, label.scrollWidth - 0.5)).map((label) => label.textContent),
        past: tabs.filter((tab) => { const box = tab.getBoundingClientRect(); return box.left < edge.left - 0.5 || box.right > edge.right + 0.5; }).map(name),
        // Each pair of unselected tabs side by side: the contrast of the line between them against each tab's fill, and of their fills
        // against each other; and, for the report, the chosen tab's fill and top edge against the strip, and each tab's label against its fill.
        ...(() => {
          const strip0 = over(getComputedStyle(strip).backgroundColor, [255, 255, 255]);
          const fill = (tab) => over(getComputedStyle(tab).backgroundColor, strip0);
          const chosen = (tab) => tab.classList.contains('selected') || tab.querySelector('[aria-selected="true"]') !== null;
          const row = tabs.flatMap((one) => (one.classList.contains('tab-more') ? [...one.children].filter((child) => child.matches('.tab')) : one.matches('.tab') ? [one] : []));
          const seams = row.slice(1).map((right, at) => [row[at], right]).filter(([left, right]) => !chosen(left) && !chosen(right) && !right.matches('.tab-more-button, .panel-max') && left.parentElement === right.parentElement).map(([left, right]) => {
            const style = getComputedStyle(left);
            const width = parseFloat(style.borderRightWidth);
            const line = width >= 1 && style.borderRightStyle !== 'none' ? over(style.borderRightColor, fill(left)) : null;
            return { left: left.dataset.id, right: right.dataset.id, line: line === null ? null : Math.min(ratio(line, fill(left)), ratio(line, fill(right))), fills: ratio(fill(left), fill(right)) };
          });
          const selected = row.find(chosen);
          const label = (tab) => ratio(over(getComputedStyle(tab).color, fill(tab)), fill(tab));
          return { seams, contrast: { selectedFill: selected ? ratio(fill(selected), strip0) : null, selectedTop: selected ? ratio(over(getComputedStyle(selected).borderTopColor, fill(selected)), strip0) : null, selectedLabel: selected ? label(selected) : null, labels: Math.min(...row.filter((tab) => !chosen(tab)).map(label)), more: row.filter((tab) => tab.matches('.tab-more-button')).map(label)[0] ?? null } };
        })(),
        // Each unread dot of a tab, More's included: where it lies against its icon, its label, its tab and its close mark, whether its ring is the
        // tab's fill, and whether hiding it changes the tab's width.
        dots: [...strip.querySelectorAll('.tab .unread-dot')].filter(shown).map((dot) => {
          const tab = dot.closest('.tab');
          const icon = dot.previousElementSibling?.matches('.codicon, .file-icon') ? dot.previousElementSibling.getBoundingClientRect() : null;
          const label = dot.nextElementSibling?.matches('.tab-label') ? dot.nextElementSibling.getBoundingClientRect() : null;
          const fill = getComputedStyle(tab).backgroundColor;
          const box = dot.getBoundingClientRect();
          const close = tab.querySelector('.tab-close .codicon')?.getBoundingClientRect() ?? null;
          const tabBox = tab.getBoundingClientRect();
          const cut = tab.querySelector('.tab-label');
          // The tab's width and its label's as drawn, as fitStripTabs measures them, and the tab's own widest, unconstrained by the strip.
          const widths = () => {
            const drawn = [tab.getBoundingClientRect().width, cut?.getBoundingClientRect().width ?? 0];

            tab.style.flex = 'none';
            tab.style.width = 'max-content';
            const widest = tab.getBoundingClientRect().width;

            tab.style.flex = '';
            tab.style.width = '';
            return [...drawn, widest];
          };
          const width = widths();

          dot.style.display = 'none';
          const without = widths();

          dot.style.display = '';
          return { tab: tab.querySelector('.tab-label')?.textContent ?? tab.title, more: tab.matches('.tab-more-button'), cut: (tab.querySelector('.tab-label')?.scrollWidth ?? 0) > (tab.querySelector('.tab-label')?.clientWidth ?? 0), closable: close !== null, icon: icon && { left: icon.left, right: icon.right, top: icon.top, bottom: icon.bottom }, label: label && { left: label.left }, ring: getComputedStyle(dot).boxShadow.startsWith(fill) ? null : getComputedStyle(dot).boxShadow + ' on ' + fill, dot: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, tabBox: { top: tabBox.top, right: tabBox.right }, close: close && { left: close.left, right: close.right, top: close.top, bottom: close.bottom }, widthChange: Math.max(...width.map((one, i) => Math.abs(one - without[i]))) };
        }),
      };
    }),
    // The conversation's header: whether its controls share one line, its main control's box and drawn label, and the room its title has.
    header: (() => {
      const header = [...document.querySelectorAll('.header')].find(shown);
      if (!header) return null;
      const boxes = [...header.children].filter(shown).map((one) => one.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
      const main = header.querySelector('button.row-main');
      const box = main && shown(main) ? main.getBoundingClientRect() : null;
      const title = header.querySelector('button.picker .title');
      return {
        overlap: Math.min(...boxes.map((one) => one.bottom)) - Math.max(...boxes.map((one) => one.top)),
        main: box === null ? null : { width: box.width, height: box.height, label: main.querySelector('.row-main-label').getBoundingClientRect().width, title: main.title },
        title: title ? title.getBoundingClientRect().width : null,
      };
    })(),
    // The conversation's heights: its header, the header and tab strip together, the timeline's pane and the composer.
    heights: (() => { const tall = (selector) => { const node = [...document.querySelectorAll(selector)].find(shown); return node ? Math.round(node.getBoundingClientRect().height) : null; }; return { copyOverCode: [...document.querySelectorAll('.code-block')].filter(shown).filter((block) => { const copy = block.querySelector(':scope > .copy'); const pre = block.querySelector(':scope > pre'); if (!copy || !pre || !shown(copy)) return false; const a = copy.getBoundingClientRect(); const b = pre.getBoundingClientRect(); return a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5; }).length, header: tall('.header'), head: tall('#head'), panel: tall('#panel'), composer: tall('#composer'), notesLine: tall('.list-notes-toggle'), notes: tall('#list-notes') }; })(),
    tops: { header: top('.header'), listHeader: top('.list-header'), settingsHead: top('.settings-head'), tabs: top('.tabs'), panel: top('#panel'), list: top('#list') },
  };
})()`;

/**
 * Settings' page as drawn (architecture.md § Settings): the font of its title, of its first section heading and of its first setting's label;
 * whether it scrolls sideways or anything in it passes its right edge, a wide table's own scroller aside; and the bar's height, or null when it
 * does not show.
 */
const SETTINGS = `(() => {
  const page = document.querySelector('.settings-page');
  if (!page || getComputedStyle(page).display === 'none') return null;
  const name = (node) => node.tagName.toLowerCase() + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/ +/).join('.') : '');
  const font = (node) => (node === null ? null : { size: parseFloat(getComputedStyle(node).fontSize), weight: Number(getComputedStyle(node).fontWeight) });
  const box = page.getBoundingClientRect();
  const inside = box.right - parseFloat(getComputedStyle(page).paddingRight) + 0.5;
  const past = [...page.querySelectorAll('*')].filter((node) => { const one = node.getBoundingClientRect(); return one.width > 0 && one.height > 0 && one.right > inside && !node.closest('.settings-table-scroll'); }).map(name);
  const bar = document.querySelector('.settings-bar');
  return { title: font(page.querySelector('.settings-page-title h2')), heading: font(page.querySelector('.settings-section-heading')), label: font(page.querySelector('.settings-caption label')), wide: page.scrollWidth > page.clientWidth + 1, past: past.slice(0, 5), bar: bar === null ? null : Math.round(bar.getBoundingClientRect().height) };
})()`;

/** Types into the page's first text field, so the draft differs from the file, and answers the bar's height and whether it offers Save. */
const DIRTY = `(async () => {
  const box = document.querySelector('.settings-page input.settings-text');
  if (!box) return null;
  box.value = box.value + '1';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((done) => setTimeout(done, 100));
  const bar = document.querySelector('.settings-bar');
  return bar === null ? { bar: null } : { bar: Math.round(bar.getBoundingClientRect().height), save: [...bar.querySelectorAll('button')].some((one) => one.textContent.trim() === 'Save') };
})()`;

/** Checks Settings' page: three distinct levels of text, nothing past its right edge, and the bar only when it has something to say. */
function settingsFailures(view, size, s) {
  const out = [];

  if (s === null) return ['Settings showed no page'];
  if (s.title === null || s.title.size < 19.5 || s.title.weight < 600) out.push("the page's title is " + JSON.stringify(s.title) + ', not 20 px semibold');
  if (s.heading !== null && s.label !== null && !(s.heading.weight >= 600 && s.label.weight < 600 && s.heading.size > s.label.size && s.title.size > s.heading.size + 3)) out.push('a section heading ' + JSON.stringify(s.heading) + ' is not set apart from a label ' + JSON.stringify(s.label) + ' and the title ' + JSON.stringify(s.title));
  if (view !== 'settings-table' && s.heading === null) out.push('the page shows no section heading');
  if (s.wide) out.push('the page scrolls sideways');
  if (s.past.length > 0) out.push('passes the page\'s right edge: ' + s.past.join(', '));
  if (s.bar !== null) out.push('the bar shows ' + s.bar + ' px tall with nothing to say');
  return out;
}

/** What each view opens with, clicked in order. */
/**
 * The touch targets under 44 px in the open view (architecture.md § Web page, Phones first), each as its name and size; `checks` counts the checkboxes
 * measured, so a view meant to show some proves it did; `tasks` holds whether each task list box shown is read-only; `overlaps` names the
 * targets of one layer whose boxes cross.
 */
const TOUCH = `(() => {
  const shown = (node) => { for (let one = node; one; one = one.parentElement) { const style = getComputedStyle(one); if (style.display === 'none' || style.visibility === 'hidden') return false; } return true; };
  const name = (node) => node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/ +/).join('.') : '');
  let checks = 0;
  // A task list's boxes in rendered Markdown, each as whether it is read-only.
  const tasks = [];
  // The layer a target is drawn in: its nearest box around it that is fixed, sticky or positioned with a z-index, as a menu, a dialog,
  // a toast, a top bar, the Changes tree over the diffs or the list as a drawer are. Only targets of one layer are
  // checked for overlaps, since a layer is drawn over what scrolls under it.
  const layer = (node) => {
    // The questions-waiting chip floats over the conversation in a layer of its own (page.css).
    if (node.matches('.question-waiting')) return node;
    for (let one = node.parentElement; one && one !== document.body; one = one.parentElement) {
      const style = getComputedStyle(one);
      if (style.position === 'fixed' || style.position === 'sticky' || (style.position !== 'static' && style.zIndex !== 'auto')) return one;
    }
    return null;
  };
  const boxes = [];
  const small = (() => {
    // Every control shown is a touch target of at least 44 px each way (architecture.md § Web page, Phones first), measured as its box cut by
    // every ancestor that clips without scrolling. Not held to it: line 2's pills, whose press is an open question; links inside prose; and a
    // tab's own buttons, which fill their tab between its 1 px top and bottom borders, its whole height less those.
  return [...document.querySelectorAll('button, a[href], [role="tab"], [role="menuitem"], [role="link"], [role="button"], input[type="checkbox"], input[type="radio"], input[type="search"], select, summary')].filter(shown).flatMap((node) => {
      // A row's waiting questions are held to it no more than its pills: a press that misses them opens the work item, whose conversation offers the card.
      if (node.matches('.row .pill, .row-head .questions, :is(.body, .artifact-doc, .sheet-detail, .hist-body p, .group-empty) a')) return [];
      // A task list's boxes are read-only (markdown.ts), so they take no press; one that takes a press is held to it.
      if (node.matches('.task-list-item-checkbox')) {
        tasks.push(node.disabled);
        if (node.disabled) return [];
      }
      // A checkbox or radio takes presses on its label too, which holds it (settings.tsx).
      // A checkbox, radio or search field takes presses on a label that holds it too (settings.tsx, history.tsx).
      const target = node.matches('input[type="checkbox"], input[type="radio"], input[type="search"]') ? (node.closest('label') ?? node) : node;
      const whole = target.getBoundingClientRect();
      if (whole.width === 0 || whole.height === 0 || whole.bottom <= 0 || whole.top >= innerHeight || whole.right <= 0 || whole.left >= innerWidth) return [];
      if (node.matches('input[type="checkbox"]')) checks++;
      let { left, top, right, bottom } = whole;
      for (let one = target.parentElement; one && one !== document.body; one = one.parentElement) {
        const style = getComputedStyle(one);
        const clip = one.getBoundingClientRect();
        // One partly scrolled out of a scroller's view is whole once scrolled to, so it is not measured here.
        if (/auto|scroll/.test(style.overflowX + style.overflowY) && (whole.top < clip.top + one.clientTop - 0.5 || whole.bottom > clip.top + one.clientTop + one.clientHeight + 0.5 || whole.left < clip.left + one.clientLeft - 0.5 || whole.right > clip.left + one.clientLeft + one.clientWidth + 0.5)) return [];
        if (!/hidden|clip/.test(style.overflowX + style.overflowY)) continue;
        left = Math.max(left, clip.left + one.clientLeft); top = Math.max(top, clip.top + one.clientTop);
        right = Math.min(right, clip.left + one.clientLeft + one.clientWidth); bottom = Math.min(bottom, clip.top + one.clientTop + one.clientHeight);
      }
      const width = right - left;
      const height = bottom - top;
      const tab = node.parentElement?.matches('.tab') ? node.parentElement : null;
      boxes.push({ node: target, layer: layer(target), left, top, right, bottom });
      const tall = tab === null ? height >= 43.5 : tab.getBoundingClientRect().height >= 43.5 && height >= tab.clientHeight - 0.5;
      return width >= 43.5 && tall ? [] : [name(node) + ' ' + Math.round(width) + 'x' + Math.round(height)];
    });
  })();
  // No two targets of one layer overlap, but for one inside the other.
  const overlaps = [];
  for (const [index, one] of boxes.entries()) {
    for (const other of boxes.slice(index + 1)) {
      if (one.layer !== other.layer || one.node.contains(other.node) || other.node.contains(one.node)) continue;
      const width = Math.min(one.right, other.right) - Math.max(one.left, other.left);
      const height = Math.min(one.bottom, other.bottom) - Math.max(one.top, other.top);
      if (width > 1 && height > 1) overlaps.push(name(one.node) + ' and ' + name(other.node) + ' by ' + Math.round(width) + 'x' + Math.round(height));
    }
  }
  return { small, checks, tasks, overlaps };
})()`;

/** A toast with its work item's link and Dismiss (toast.tsx), and the console's foot with Reconnect (console.ts). */
const PROBES = `(() => {
  document.getElementById('toast').insertAdjacentHTML('beforeend', '<div class="toast warning"><button type="button" class="toast-text toast-open">This work item can no longer do that.</button><button type="button" class="icon dismiss" aria-label="Dismiss"><span class="codicon codicon-close"></span></button></div>');
  document.body.insertAdjacentHTML('beforeend', '<div class="console" style="position: fixed; left: 0; bottom: 0; width: 300px"><div class="console-foot"><p class="console-note">Ended.</p><button type="button" class="console-reconnect">Reconnect</button></div></div>');
})()`;

/** A step that opens the tab `selector` names, by its tab in a strip or else by its row in that strip's More menu. */
function openTab(selector) {
  return { name: selector, eval: '(async () => { const tab = document.querySelector(' + JSON.stringify('.tabs ' + selector) + '); if (tab) { tab.click(); return true; } document.querySelector(".tab-more-button")?.click(); await new Promise((done) => setTimeout(done, 150)); const row = document.querySelector(' + JSON.stringify('.tab-menu ' + selector) + '); row?.click(); return row !== null; })()' };
}

const OPEN = {
  history: ['[data-side=history], [data-tab=history]'],
  // Settings as it opens: on a phone its navigation's categories alone.
  'settings-nav': ['[data-action=list-more]', '[data-action=list-settings]'],
  ...Object.fromEntries(Object.entries(SETTINGS_PAGES).map(([view, keys]) => [view, ['[data-action=list-more]', '[data-action=list-settings]', ...keys.map((key) => (key.endsWith('/page') ? '.settings-nav-entry[data-key="' + key + '"], .settings-page-title h2' : '.settings-nav-entry[data-key="' + key + '"]'))]])),
  // A namespace's playbooks table.
  // On a phone Playbooks and the namespace drill into their lists, the namespace's starting with its table; on a desktop they open in place.
  'settings-table': ['[data-action=list-more]', '[data-action=list-settings]', '.settings-nav-entry[data-key="playbooks"]', '.settings-nav-entry[data-key="namespace:dev"]', '.settings-nav-entry.item[data-page="namespace:dev"], .settings-page-title h2'],
  drawer: ['[data-action=drawer]'],
  sheet: ['[data-action=actions]', '[data-action=row-action][data-label=Delete]'],
  // Pair a device with more devices than fit, whose list scrolls in its own area.
  pair: ['[data-action=list-more]', '[data-action=list-devices]'],
  // Devices with a pairing address shown.
  'settings-pair': ['[data-action=list-more]', '[data-action=list-settings]', '.settings-nav-entry[data-key="devices"]', '.settings-devices > .sheet-button'],
  // An artifact chosen from More, so the strip keeps it beside the tabs it always keeps: the oldest, so the newest stays unread where it has room.
  tabs: ['.tab-more-button', '.tab-menu [data-action=artifact][data-path="chat/a0.md"]'],
  // The Changes tab with its tree shown, as a phone shows it: over the diffs. A pinned tree has no flyout button, so that press finds none.
  changes: ['[data-action=diff-tab]', '[data-action=tree-flyout], .tree-pinned .tree-search'],
  // Its search's options menu open, Regular expression chosen, which keeps the menu open.
  'changes-options': ['[data-action=diff-tab]', '[data-action=tree-flyout], .tree-pinned .tree-search', '[data-action=tree-options]', '.tree-options-menu [data-option=regex]'],
  // History's chips shown, one turned off, as a phone shows them behind Filters; a wider pane shows them without it.
  'history-filters': ['[data-side=history], [data-tab=history]', '[data-action=history-chips]', '.hist-chip[data-category="you"]'],
  // The mic views' tab, from the strip or from More where the strip has no room for it; the desktop's in its column, then maximized.
  'mic-history': [openTab('[data-tab="history"]')],
  'mic-changes': [openTab('[data-action="diff-tab"]')],
  'mic-artifact': [openTab('[data-action="artifact"][data-path="chat/plan.md"]')],
  'mic-console': [openTab('[data-tab="console"]')],
  'mic-max-history': [openTab('[data-side="history"]'), '.panel-max'],
  'mic-max-changes': [openTab('[data-action="diff-tab"]'), '.panel-max'],
  'mic-max-artifact': [openTab('[data-action="artifact"][data-path="chat/plan.md"]'), '.panel-max'],
  // The long menus (menuFailures): the open work item's Actions, the list's More actions, and a row's menu by a right click or long press on it.
  'actions-menu': ['[data-action=actions]'],
  'more-menu': ['[data-action=list-more]'],
  'row-menu': [{ contextmenu: '#list .row[data-work-item="1"]' }],
  // The tab strip's More menu, a grid rather than a list, with 20 artifacts.
  'tab-menu': ['.tab-more-button'],
  // The Changes tab's diffs, each file's header with its collapse chevron and Viewed tick.
  diffs: ['[data-action=diff-tab]'],
  // The context meter's popover with Compact….
  context: ['[data-context=toggle]'],
  snooze: ['[data-action=actions]', '[data-action=row-action][data-label="Snooze…"]'],
  // The context meter's menu with its details shown.
  'context-details': ['.context-ring', '[data-context=details]'],
};

/** The context menu's failures: no details, a menu past the viewport or scrolled, or a row whose value wraps under its name. */
const CONTEXT_DETAILS = `(() => {
  const menu = document.querySelector('.context-menu');
  if (!menu || !menu.querySelector('.context-details')) return ['the context menu shows no details'];
  const out = [];
  const box = menu.getBoundingClientRect();
  if (box.left < -0.5 || box.top < -0.5 || box.right > innerWidth + 0.5 || box.bottom > innerHeight + 0.5) out.push('the context menu passes the viewport: ' + [box.left, box.top, box.right, box.bottom].map(Math.round).join(', ') + ' of ' + innerWidth + ' by ' + innerHeight);
  for (const row of menu.querySelectorAll('.context-row')) {
    const spans = row.querySelectorAll('span');
    if (spans.length === 2 && spans[1].getBoundingClientRect().top >= spans[0].getBoundingClientRect().bottom - 1) out.push('the row ' + row.textContent + ' puts its value under its name');
    if (row.getBoundingClientRect().height > 2 * parseFloat(getComputedStyle(row).lineHeight || '20') - 1) out.push('the row ' + row.textContent + ' wraps');
  }
  return out;
})()`;

/** The search views: the field, and the bar whose controls must not cover it. */
const SEARCHES = {
  changes: { field: '.tree-search input', bar: '.changes-tree-inner' },
  'changes-options': { field: '.tree-search input', bar: '.changes-tree-inner' },
  history: { field: '.hist-filter', bar: '.hist-toolbar' },
  'history-filters': { field: '.hist-filter', bar: '.hist-toolbar' },
};
/** The least width a search field's text keeps, in CSS px. */
const SEARCH_MIN = 160;
/** The least contrast, against each other, of the line between two unselected tabs or of their fills. */
const SEAM_MIN = 1.25;

/** The shown search field's visible width, and the controls of its bar, outside the field's own box, whose boxes cross it. */
const searchFit = ({ field, bar }) => `(() => {
  const shown = (node) => { for (let one = node; one; one = one.parentElement) { const style = getComputedStyle(one); if (style.display === 'none' || style.visibility === 'hidden') return false; } return true; };
  const input = [...document.querySelectorAll(${JSON.stringify(field)})].find(shown);
  if (!input) return null;
  const box = input.getBoundingClientRect();
  const host = input.closest(${JSON.stringify(bar)});
  const name = (node) => node.tagName.toLowerCase() + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/ +/).join('.') : '') + (node.textContent.trim() ? ' "' + node.textContent.trim().slice(0, 20) + '"' : '');
  const over = [...(host ?? document).querySelectorAll('button, input, label')].filter((node) => shown(node) && !node.contains(input)).filter((node) => {
    const other = node.getBoundingClientRect();
    return other.width > 0 && Math.min(box.right, other.right) - Math.max(box.left, other.left) > 1 && Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 1;
  }).map(name);
  return { width: Math.round(box.width), over };
})()`;

/**
 * Scrolls the conversation to its end or halfway, and answers whether the questions chip shows and where it floats against the composer's box:
 * how far its centre is from the box's, the gap from its bottom to the box's top, and whether a press at its centre reaches it.
 */
const chipFloat = (at) => `(async () => {
  const panel = document.getElementById('panel');
  panel.scrollTop = ${at === 'end' ? 'panel.scrollHeight' : '(panel.scrollHeight - panel.clientHeight) / 2'};
  await new Promise((done) => setTimeout(done, 200));
  const chip = document.querySelector('#composer .question-waiting');
  if (!chip || chip.hidden || chip.getBoundingClientRect().height === 0) return { shown: false };
  const box = chip.getBoundingClientRect();
  const composer = document.querySelector('#composer .composer').getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return { shown: true, off: Math.round(Math.abs(box.left + box.right - composer.left - composer.right) / 2), gap: Math.round(composer.top - box.bottom), top: Math.round(box.top), pressed: hit !== null && chip.contains(hit) };
})()`;

/**
 * The open card's look, at the conversation's top: the contrast of its topic on the card, the card's background laid over the pane's, and
 * whether the first question's disabled Back keeps a border of its own.
 */
const CARD_LOOK = `(async () => {
  const panel = document.getElementById('panel');
  panel.scrollTop = 0;
  await new Promise((done) => setTimeout(done, 150));
  const card = document.querySelector('#panel .question-card.qc');
  const topic = card?.querySelector('.qc-topic');
  const back = card?.querySelector('.qc-secondary[data-action="card-back"]');
  if (!topic || !back) return null;
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  // A computed colour as RGBA, through a canvas, which reads every syntax the page's colour-mix gives.
  const rgba = (css) => { probe.clearRect(0, 0, 1, 1); probe.fillStyle = css; probe.fillRect(0, 0, 1, 1); const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255]; };
  const over = (top, under) => top.slice(0, 3).map((one, index) => one * top[3] + under[index] * (1 - top[3])).concat(1);
  const luminance = (rgb) => { const [r, g, b] = rgb.slice(0, 3).map((one) => { const c = one / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (one, two) => { const [high, low] = [luminance(one), luminance(two)].sort((a, b) => b - a); return (high + 0.05) / (low + 0.05); };
  const page = over(rgba(getComputedStyle(document.body).backgroundColor), [255, 255, 255]);
  const pane = over(rgba(getComputedStyle(panel).backgroundColor), page);
  const ground = over(rgba(getComputedStyle(card).backgroundColor), pane);
  const style = getComputedStyle(back);
  return { contrast: Math.round(ratio(over(rgba(getComputedStyle(topic).color), ground), ground) * 100) / 100, disabled: back.disabled, border: style.borderTopColor, borderAlpha: rgba(style.borderTopColor)[3] };
})()`;

/**
 * The open menu as it shows, then scrolled to its end: whether it scrolls, where its box lies, the scroll marks (`more-above`, `more-below`) and
 * whether its fade shows, and at its end whether its last row is the element under the row's centre. Scrolled back to its top after.
 */
const MENU = `(async () => {
  const menu = document.querySelector('.menu');
  if (!menu) return null;
  const marks = () => ['more-above', 'more-below'].filter((name) => menu.classList.contains(name));
  const rows = [...menu.querySelectorAll('.menu-row')];
  const box = menu.getBoundingClientRect();
  const first = { marks: marks(), fade: getComputedStyle(menu, '::after').content, sideways: menu.scrollWidth > menu.clientWidth + 1 };
  menu.scrollTop = menu.scrollHeight;
  await new Promise((done) => setTimeout(done, 150));
  const last = rows.at(-1).getBoundingClientRect();
  const hit = document.elementFromPoint(last.left + last.width / 2, last.top + last.height / 2);
  const end = { marks: marks(), sideways: menu.scrollWidth > menu.clientWidth + 1, last: rows.at(-1).textContent, whole: last.top >= box.top - 0.5 && last.bottom <= box.bottom + 0.5, hit: hit !== null && rows.at(-1).contains(hit) };
  menu.scrollTop = 0;
  await new Promise((done) => setTimeout(done, 150));
  return { scrolls: menu.scrollHeight > menu.clientHeight + 1, flipped: menu.classList.contains('flip-y'), rows: rows.length, top: box.top, bottom: box.bottom, inside: box.left >= -0.5 && box.top >= -0.5 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5, height: innerHeight, first, end, back: marks() };
})()`;

/**
 * A long menu's failures: it stays inside the viewport; one that scrolls takes all the room on its side, shows that it scrolls with the fade
 * below it, and at its end shows its last row whole and pressable with the fade above it only; one that fits shows no fade. The fixture's
 * Actions and More menus fit a phone held upright and an iPad, and scroll on a phone on its side.
 */
function menuFailures(view, size, r) {
  const out = [];

  if (r === null) return ['opened no menu'];
  if (!r.inside) out.push('the menu passes the viewport: ' + r.top + ' to ' + r.bottom + ' of ' + r.height);
  if (r.first.sideways || r.end.sideways) out.push('the menu scrolls sideways' + (r.first.sideways ? '' : ' once scrolled to its end'));
  if (r.scrolls) {
    if (r.flipped ? r.top > 8.5 : r.bottom < r.height - 8.5) out.push('the menu scrolls but stops ' + (r.flipped ? r.top + ' px under the top' : r.height - r.bottom + ' px above the bottom') + ', leaving room unused');
    if (r.first.marks.join() !== 'more-below' || r.first.fade === 'none') out.push('the menu scrolls but shows it with ' + JSON.stringify(r.first));
    if (r.end.marks.join() !== 'more-above' || !r.end.whole || !r.end.hit) out.push('at its end the menu shows ' + JSON.stringify(r.end));
  } else if (r.first.marks.length > 0) out.push('the menu fits but is marked ' + r.first.marks.join(', '));
  if (r.back.join() !== r.first.marks.join()) out.push('scrolled back to its top the menu is marked ' + r.back.join(', '));
  if (view === 'tab-menu' && size.phone && size.orientation === 'landscape' && !r.scrolls) out.push('the More tabs menu fits, so its scrolling is not checked');
  if (!['row-menu', 'tab-menu'].includes(view) && r.scrolls !== (size.phone && size.orientation === 'landscape')) out.push(r.scrolls ? 'the menu scrolls where the screen has room for all ' + r.rows + ' rows' : 'the menu fits, so its scrolling is not checked');
  return out;
}

/** Opens the More menu again and answers whether it lies above everything at the centres of its rows in view, and inside the viewport. */
const moreOnTop = `(async () => {
  document.querySelector('.tab-more-button').click();
  await new Promise((done) => setTimeout(done, 150));
  const menu = document.querySelector('.tab-menu');
  if (!menu) return { open: false };
  const box = menu.getBoundingClientRect();
  // The rows in view: a menu taller than the room scrolls inside itself.
  const rows = [...menu.querySelectorAll('.menu-row')].filter((row) => { const r = row.getBoundingClientRect(); return r.top + r.height / 2 > box.top && r.top + r.height / 2 < box.bottom; });
  const covered = rows.filter((row) => { const r = row.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !hit || !menu.contains(hit); }).map((row) => row.textContent);
  return { open: true, rows: rows.length, covered, inside: box.left >= -0.5 && box.top >= -0.5 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5 };
})()`;

/** The centre and id of a tab, not the chosen one, in the strip whose More menu is open. */
const otherTab = `(() => {
  const strip = document.querySelector('.tab-menu')?.closest('.tabs');
  const tab = strip ? [...strip.children].find((one) => one.dataset.id !== undefined && !one.classList.contains('selected') && one.querySelector('[aria-selected="true"]') === null && !one.matches('[aria-selected="true"]')) : undefined;
  if (!tab) return null;
  const target = tab.querySelector('.tab-open') ?? tab;
  const box = target.getBoundingClientRect();
  return { id: tab.dataset.id, x: box.left + box.width / 2, y: box.top + box.height / 2 };
})()`;

/** Presses at `at` as the size's pointer does: a mouse click, or a finger's tap. */
async function press(send, size, at) {
  if (size.mouse) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
  } else {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
}

/**
 * The mic views' composer: whether it shows with its mic button, the tab shown, where the tab's pane ends (the folded tabs' panel, or the
 * maximized column), and whether its mic button and box take a press at their centres.
 */
const MIC = `(() => {
  const composer = document.getElementById('composer');
  if (composer.hidden || getComputedStyle(composer).display === 'none') return { shown: false };
  const box = composer.getBoundingClientRect();
  const hit = (node) => { if (!node) return false; const one = node.getBoundingClientRect(); const at = document.elementFromPoint(one.left + one.width / 2, one.top + one.height / 2); return at !== null && node.contains(at); };
  const maximized = document.querySelector('#root.maximized') !== null;
  const pane = (maximized ? document.querySelector('.detail') : document.getElementById('panel')).getBoundingClientRect();
  const strip = maximized ? document.querySelector('.detail .tabs') : document.querySelector('.main .tabs');
  return { shown: true, maximized, top: box.top, bottom: box.bottom, pane: pane.bottom, tab: strip?.querySelector('.tab.selected')?.dataset.id ?? null, mic: hit(composer.querySelector('button[data-voice="mic"]')), input: hit(composer.querySelector('textarea')) };
})()`;

/** Checks a mic view: the composer shows under the tab chosen, below its pane and nothing over it, its mic button and box taking a press. */
function micFailures(view, size, c) {
  const out = [];
  const want = { history: 'history', changes: 'changes', artifact: 'artifact:chat/plan.md', console: 'console' }[view.replace(/^mic-(max-)?/, '')];

  if (!c.shown) return ['the composer is hidden on the ' + want + ' tab with the mic on'];
  if (c.tab !== want) out.push('the ' + (c.tab ?? 'no') + ' tab shows, not ' + want);
  if (view.startsWith('mic-max-') && !c.maximized) out.push('the column is not maximized');
  if (c.pane > c.top + 0.5) out.push('the tab\'s pane ends at ' + c.pane + ', under the composer\'s top at ' + c.top);
  if (c.bottom > size.height + 0.5) out.push('the composer passes the viewport\'s bottom');
  if (!c.mic) out.push('the mic button does not take a press at its centre');
  if (!c.input) out.push('the composer\'s box does not take a press at its centre');
  return out;
}

/** Checks one view's measurements; answers its failures. */
function failures(view, size, m) {
  const out = [];
  const { document: d } = m;

  if (d.height !== d.client || d.width !== d.clientWidth || d.body !== d.bodyClient) out.push('the document is ' + d.width + 'x' + d.height + ' (body ' + d.body + ') in ' + d.clientWidth + 'x' + d.client);
  if (m.past.length > 0) out.push('reaches past the viewport outside a scroller: ' + m.past.slice(0, 5).join(', '));
  for (const one of m.scrollers) {
    if (!one.kept) out.push(one.name + ' hands a drag on to the page (overscroll-behavior ' + one.overscroll + ', and no scroller around it keeps it)');
  }
  if (m.touchAction !== 'pinch-zoom') out.push('the page outside the scrollers takes a pan or no pinch (body touch-action ' + m.touchAction + ')');
  // No band above the bars: under the opaque status bar the top inset is 0, and each view's top bar starts at the page's top edge.
  if (m.band !== 0) out.push('a ' + m.band + ' px band above the bars');
  // A redraw with the same rows paints line 2 the same.
  if (m.line2 !== null) {
    if (m.line2.samples < 3) out.push('line 2 was sampled in ' + m.line2.samples + ' frames, too few to check');
    if (m.line2.ways > 1) out.push('line 2 painted ' + m.line2.ways + ' different ways while the same list was sent again');
    const keys = view.startsWith('narrow') ? 4 : 7;

    if (m.pills.filter((pill) => pill.ticket).length !== keys) out.push('line 2 shows ' + m.pills.filter((pill) => pill.ticket).length + ' ticket keys, not ' + keys);
  }
  // Line 1's waiting questions show on both rows that have them, whole, after the title, as their icon alone; the long title gives way.
  if (m.line2 !== null) {
    if (m.questions.length !== 2) out.push('line 1 shows waiting questions on ' + m.questions.length + ' rows, not 2');
    for (const one of m.questions) {
      if (!one.whole) out.push('line 1\'s ' + one.text + ' is cut or passes its line');
      if (!one.after) out.push('line 1\'s ' + one.text + ' overlaps the title');
      if (!one.icon) out.push('line 1\'s ' + one.text + ' does not show its question icon alone and whole');
    }
    const width = view === 'narrow' ? 200 : view.startsWith('narrow-') ? Number(view.slice(7)) : null;

    if (width !== null && width <= 330 && !m.questions.some((one) => one.titleCut)) out.push('no title is cut before its waiting questions at ' + width + ' px');
  }
  // History's last entry scrolls clear of the home indicator.
  if (view === 'history' && m.histEnd === null) out.push('History drew no entries');
  // The title is History's first heading at Settings' 20 px, its groups' headings 14 px, above the pinned state, which a first screen shows.
  if (view === 'history' && m.histHead !== null) {
    const [first, ...rest] = m.histHead.headings;
    if (first !== 'H1 20') out.push('History opens on ' + first + ', not its title as an h1 of 20 px');
    for (const heading of rest.filter((one) => one.startsWith('H2') && one !== 'H2 14')) out.push('a History group heading is ' + heading + ' px, not 14');
    if (m.histHead.state === null || m.histHead.title === null || m.histHead.state < m.histHead.title) out.push('History has no pinned state under its title');
    // A phone held upright; on its side the screen is 300 px tall, less than the head and the bar need.
    else if (size.phone && size.orientation === 'portrait' && m.histHead.state + 24 > m.histHead.screen) out.push('History\'s first screen, ' + m.histHead.screen + ' px, ends before the pinned state at ' + Math.round(m.histHead.state) + ' px');
  }
  if (view === 'history' && m.histEnd !== null && m.histEnd < 48 + size.insets.bottom - 0.5) out.push('History ends ' + m.histEnd + ' px under its last entry, inside the home indicator\'s ' + size.insets.bottom + ' px');
  for (const line of m.lines) {
    if (!line.oneLine) out.push('line 2 of ' + line.row + ' has an item below another');
    if (line.wrapped) out.push('line 2 of ' + line.row + ' wraps onto a second line');
  }
  for (const name of m.names) {
    if (name.past) out.push('line 2\'s playbook or host ' + name.text + ' passes its line');
    if (name.textLines > 1) out.push('line 2\'s playbook or host ' + name.text + ' wraps onto ' + name.textLines + ' lines');
    if (name.cut && name.fits) out.push('line 2\'s playbook or host ' + name.text + ' is cut though it fits beside the comment icon and the key');
    if (name.cut && !name.ellipsis) out.push('line 2\'s playbook or host ' + name.text + ' is cut without an ellipsis');
    if (name.cut && name.width < 24) out.push('line 2\'s playbook or host ' + name.text + ' is cut to ' + name.width.toFixed(1) + ' px');
    if (!name.tooltip) out.push('line 2\'s playbook or host ' + name.text + ' has no tooltip naming it whole');
    if (name.alone) out.push('line 2\'s comment icon is alone on a line above ' + name.text);
  }
  for (const pill of m.pills) {
    if (pill.state === 'cut' || (pill.ticket && pill.state === 'out')) out.push('line 2\'s pill ' + pill.text + ' is ' + (pill.state === 'cut' ? 'cut' : 'left out'));
    // Every pill shown shows its text where line 2 is 300 px wide or more, and its icon alone under that.
    if (pill.state === 'icon' && pill.width >= 300) out.push('line 2\'s pill ' + pill.text + ' shows its icon alone on a ' + pill.width.toFixed(1) + ' px line');
    if (pill.state === 'whole' && pill.width < 300) out.push('line 2\'s pill ' + pill.text + ' shows its text on a ' + pill.width.toFixed(1) + ' px line');
    if (!pill.named) out.push('line 2\'s pill ' + pill.text + ' has no text for screen readers');
    if (!pill.clipped) out.push('line 2\'s pill ' + pill.text + ' hides its text without clipping it');
    if (pill.others > 0) out.push('line 2\'s pill ' + pill.text + ' is in the focused row while ' + pill.others + ' pills of other rows are keyboard stops');
    if (pill.stop !== null && (pill.state === 'out') !== (pill.stop === -1)) out.push('line 2\'s pill ' + pill.text + (pill.state === 'out' ? ', left out, is a keyboard stop' : ', shown, is no keyboard stop'));
  }
  // The link pills drop out from the last: none shows after one left out.
  for (const [index, pill] of m.pills.entries()) {
    const before = m.pills.slice(0, index).filter((one) => one.line === pill.line && !one.ticket);

    if (!pill.ticket && pill.state !== 'out' && before.some((one) => one.state === 'out')) out.push('line 2\'s pill ' + pill.text + ' shows after a pill left out before it');
  }
  if (m.line2 !== null && m.pills.length === 0) out.push('line 2 shows no pills');
  // A key with its source's logo, and an issue link with GitHub's mark, shows its number after it, its source's label hidden from view; GitHub's, Zoho's and a plugin's logo all show.
  for (const key of m.keys) {
    if (key.label === true) out.push('line 2\'s ' + (key.issue ? 'issue link ' : 'key ') + key.text + ' shows its source\'s label beside its logo');
  }
  if (m.line2 !== null) {
    if (!m.keys.some((key) => key.issue && key.text === 'gh 21517' && key.label === false)) out.push('no issue link on line 2 shows its number after GitHub\'s mark, its label read with it');
    for (const logo of ['source-logo github', 'source-logo zoho', 'source-logo dpaf custom']) {
      if (!m.keys.some((key) => key.logo === logo && key.label === false)) out.push('no key on line 2 shows its number after the logo ' + logo);
    }
  }
  // At 200 px a long playbook or host is cut with an ellipsis rather than wrapping.
  if (view === 'narrow' && !m.names.some((name) => name.cut)) out.push('no playbook or host on line 2 is cut at 200 px');
  // At 300 px the pills show their icons alone; at 330 px their texts, and some link pill fits whole.
  if (view === 'narrow-300' && !m.pills.some((pill) => !pill.ticket && pill.state === 'icon')) out.push('no link pill on line 2 shows its icon alone at 300 px');
  if (view === 'narrow-330' && !m.pills.some((pill) => !pill.ticket && pill.state === 'whole')) out.push('no link pill on line 2 shows whole at 330 px');
  for (const strip of m.strips) {
    if (strip.cut.length > 0) out.push('a tab strip hides or cuts below five characters the labels ' + strip.cut.slice(0, 4).join(', '));
    if (strip.fixedCut.length > 0) out.push('a tab strip cuts the fixed tabs\' labels ' + strip.fixedCut.join(', '));
    if (strip.past.length > 0) out.push('a tab passes its strip: ' + strip.past.slice(0, 4).join(', '));
  }
  // Two unselected tabs side by side show where one ends: the line between them, or their fills, at SEAM_MIN against each other at least.
  for (const seam of m.strips.flatMap((strip) => strip.seams)) {
    if (Math.max(seam.line ?? 1, seam.fills) < SEAM_MIN) out.push('the tabs ' + seam.left + ' and ' + seam.right + ' run together: their line is ' + seam.line + ':1 and their fills ' + seam.fills + ':1, under ' + SEAM_MIN + ':1');
  }
  // A tab's unread dot is a badge on its icon's top-right corner, inside its tab, ringed in its fill, clear of its label and close mark, and takes no width.
  const dots = m.strips.flatMap((strip) => strip.dots);

  for (const one of dots) {
    const where = 'the unread dot of the tab ' + (one.tab ?? '?');

    if (one.icon === null || (one.label === null && !one.more)) {
      out.push(where + ' does not sit between its icon and its label');
      continue;
    }
    // A badge on the icon's top-right corner: across the icon's right edge and its top, clear of the label.
    if (one.dot.left > one.icon.right - 1 || one.dot.right < one.icon.right + 1) out.push(where + ' is not across its icon\'s right edge: ' + one.dot.left + ' to ' + one.dot.right + ' for an icon ending at ' + one.icon.right);
    if (one.dot.top > one.icon.top + 1 || one.dot.bottom < one.icon.top + 1 || one.dot.top < one.tabBox.top) out.push(where + ' is not on its icon\'s top: ' + one.dot.top + ' to ' + one.dot.bottom + ' for an icon from ' + one.icon.top);
    if (one.label !== null && one.dot.right > one.label.left + 0.5) out.push(where + ' covers its label');
    if (one.ring !== null) out.push(where + ' is not ringed in its tab\'s fill: ' + one.ring);
    if (one.dot.right > one.tabBox.right + 0.5) out.push(where + ' passes its tab');
    if (one.close !== null && one.dot.right > one.close.left - 0.5 && one.dot.left < one.close.right + 0.5 && one.dot.bottom > one.close.top - 0.5 && one.dot.top < one.close.bottom + 0.5) out.push(where + ' covers its close mark');
    if (Math.abs(one.widthChange) > 0.5) out.push(where + ' changes its tab\'s or label\'s width by ' + one.widthChange + ' px');
  }
  // The tabs view's state and artifacts are unread: History's dot, a tab without a close mark, shows wherever History has room after Changes,
  // and an artifact's, with a close mark, cut or not, wherever the strip has room for an artifact tab besides the one shown.
  if (view === 'tabs') {
    if (m.strips.some((strip) => strip.history) && !dots.some((one) => !one.closable && !one.more)) out.push('no unread dot on a tab without a close mark');
    if (m.strips.some((strip) => strip.artifacts > 0) && !dots.some((one) => one.closable)) out.push('no unread dot on an artifact tab');
    if (size.device === 'ipad' && !(dots.some((one) => one.closable && one.cut) && dots.some((one) => one.closable && !one.cut))) out.push('no unread dot on both a cut and a whole artifact title');
  }
  // The tabs view's strip has more tabs than fit, so More holds the rest; More shows its dot exactly while its name says a row is unread.
  if (view === 'tabs' && !m.strips.some((strip) => strip.more)) out.push('no strip shows More for a work item with more tabs than fit');
  for (const strip of m.strips.filter((one) => one.more)) {
    if (strip.moreUnread !== strip.dots.some((one) => one.more)) out.push(strip.moreUnread ? 'More holds an unread row but shows no dot' : 'More shows a dot with no unread row');
  }
  // The header keeps one line with its main control: on a phone its icon alone, a 44 px target named by its label; elsewhere with its label.
  if (m.header !== null) {
    const h = m.header;

    if (h.overlap <= 0) out.push('the header takes more than one line');
    if (h.main === null) out.push('the header shows no main control');
    else if (size.phone && (h.main.width < 43.5 || h.main.height < 43.5)) out.push('the main control is ' + h.main.width + 'x' + h.main.height + ' px, under 44 px');
    else if (size.phone && h.main.label > 1) out.push('the main control draws its label on a phone (' + h.main.label + ' px)');
    else if (!size.phone && h.main.label <= 1) out.push('the main control hides its label outside the phone\'s layout');
    if (h.main !== null && ((h.main.name !== undefined && h.main.name !== 'Approve') || h.main.title !== 'Approve')) out.push('the main control is named ' + JSON.stringify(h.main.name) + ' with the tooltip ' + JSON.stringify(h.main.title));
    if (h.title === null) out.push('the header shows no title');
    else if (h.title < 80) out.push('the header leaves its title ' + h.title + ' px');
  }
  // On a phone the header is one 44 px row; on its side the header and the tabs share that row and the composer is one row, so the timeline
  // keeps at least 270 px of the iPhone's 393.
  if (view === 'conversation' && size.phone && m.heights.header !== null) {
    const hs = m.heights;

    if (hs.header > 46) out.push('the header is ' + hs.header + ' px tall on a phone, not one 44 px row');
    if (size.orientation === 'landscape') {
      if (hs.head > 46) out.push('the header and the tabs take ' + hs.head + ' px on a phone on its side, not one row');
      if (hs.composer > 44 + 5 + Math.max(5, Math.min(14, size.insets.bottom)) + 2) out.push('the composer is ' + hs.composer + ' px tall on a phone on its side, not one row');
      if (hs.panel < 270) out.push('the timeline gets ' + hs.panel + ' px of a phone on its side');
    }
  }
  // On a touch screen a code block's Copy, always shown, lies beside its code, not over it.
  if (!size.mouse && m.heights.copyOverCode > 0) out.push(m.heights.copyOverCode + ' code blocks\' Copy lies over their code');
  // A phone folds the list's notes into one line, closed until tapped; elsewhere they show whole, with no line.
  if (view === 'list') {
    if (size.phone && (m.heights.notesLine === null || m.heights.notesLine > 46 || (m.heights.notes ?? 0) > 1)) out.push('the list\'s notes are not one closed line on a phone (line ' + m.heights.notesLine + ' px, notes ' + m.heights.notes + ' px)');
    if (!size.phone && (m.heights.notesLine !== null || !(m.heights.notes > 0))) out.push('the list\'s notes are folded outside the phone\'s layout');
  }
  for (const [bar, top] of Object.entries(m.tops)) {
    // Settings, outside the phone's layout, sits inside the dimmed page's margin.
    if ((['header', 'listHeader'].includes(bar) || (bar === 'settingsHead' && size.phone)) && top !== null && top !== 0) out.push('the ' + bar + ' starts ' + top + ' px down');
  }
  // In portrait, under the status bar, WebKit finds the view's own solid top bar at the top edge, in the bars' colour, and paints the status bar in
  // it instead of blurring the page's top. An open sheet's dimmed backdrop is viewport-sized, which keeps the colour WebKit had. Landscape has no
  // status bar, so no colour is painted there, and its bars, inside the notch's insets, are under 90% of the width. The iPad is not checked for it.
  if (size.device === 'iphone' && size.orientation === 'portrait') {
    const edge = m.edge;
    const own = ['sheet', 'pair', 'snooze'].includes(view) ? edge.kind === 'viewport' : edge.kind === 'bar' && /^[a-z]+\.(header|list-header|hist-bar|settings-head)(\.|$)/.test(edge.name ?? '');

    if (!own) out.push('WebKit finds ' + (edge.name ?? 'no fixed or sticky box (hit ' + edge.hit + ')') + (edge.kind ? ' (' + edge.kind + ')' : '') + ' at the top edge, not the view\'s top bar');
    else if (edge.kind === 'bar' && (edge.top !== 0 || edge.height <= 10 || edge.background !== m.bar)) out.push('the top bar ' + edge.name + ' is at ' + edge.top + ', ' + edge.height + ' px tall, ' + edge.background + ' for the bars\' ' + m.bar);
  }
  return out;
}

const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://x').pathname;
  // The diff viewer's modules, which the build writes beside the page's (build.mjs) and the hub serves under the page's build.
  const diffFile = /^\/page\/diff\/[^/]+\/([\w./-]+\.(js|json))$/.exec(path);

  if (diffFile !== null && !diffFile[1].includes('..') && existsSync(join(DIFF_DIR, diffFile[1]))) {
    response.writeHead(200, { 'content-type': diffFile[2] === 'js' ? 'text/javascript' : 'application/json' }).end(readFileSync(join(DIFF_DIR, diffFile[1])));
    return;
  }
  const asked = path === '/page/' ? 'index.html' : path.replace(/^\/page\//, '');
  // A shell file by its hashed name (build.mjs) is the plain one's.
  const name = Object.keys(PAGE_ASSETS).find((one) => PAGE_ASSETS[one].hashed === asked) ?? asked;
  const asset = PAGE_ASSETS[name];

  if (asset === undefined) {
    response.writeHead(404).end();
    return;
  }

  // The installed app's rules, everywhere: Chrome cannot emulate display-mode.
  const body = name === 'index.html' ? asset.body.replace(/<script src="page-[0-9a-f]+\.js">/, (tag) => fake + tag) : name === 'page.css' ? asset.body.replaceAll('(display-mode: standalone)', 'all') : asset.base64 ? Buffer.from(asset.body, 'base64') : asset.body;

  response.writeHead(200, { 'content-type': name === 'index.html' ? 'text/html; charset=utf-8' : asset.mime }).end(body);
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));

const base = 'http://127.0.0.1:' + server.address().port + '/page/';
const dir = mkdtempSync(join(tmpdir(), 'sb-shell-check-'));
const browser = spawn(browsers[0], ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + join(dir, 'profile'), 'about:blank'], { stdio: 'ignore' });
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const exited = new Promise((done) => browser.once('exit', done));
let failed = 0;

try {
  const deadline = Date.now() + 60_000;
  let port;

  while (port === undefined) {
    if (Date.now() > deadline) throw new Error(browsers[0] + ' opened no DevTools port');
    try {
      port = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0];
    } catch {
      await wait(100);
    }
  }

  let target;
  // Headless Chrome on a slow runner can start without its about:blank page; after 5 seconds the check opens one.
  const askAt = Date.now() + 5_000;
  let asked = false;

  while (target === undefined) {
    if (Date.now() > deadline) throw new Error('The browser opened no page');
    target = (await fetch('http://127.0.0.1:' + port + '/json').then((answer) => answer.json()).catch(() => [])).find((one) => one.type === 'page');
    if (target === undefined && !asked && Date.now() > askAt) {
      asked = true;
      await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' }).catch(() => undefined);
    }
    if (target === undefined) await wait(100);
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const replies = new Map();
  let id = 0;

  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = () => fail(new Error('DevTools refused the connection')); });
  socket.onmessage = (message) => { const data = JSON.parse(message.data); replies.get(data.id)?.(data); };

  /** Sends one DevTools command and answers its result, throwing its error. */
  const send = async (method, params = {}) => {
    const reply = await new Promise((done) => { replies.set(++id, done); socket.send(JSON.stringify({ id, method, params })); });

    if (reply.error) throw new Error(method + ': ' + reply.error.message);
    return reply.result;
  };
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const results = [];

  for (const scheme of ['dark', 'light']) {
    for (const size of SIZES) {
      for (const view of VIEWS) {
        // A phone shows the list or the conversation, never a drawer, in either orientation.
        if (view === 'drawer' && size.phone) continue;
        // The column maximizes only where it is a column.
        if (view.startsWith('mic-max-') && size.device !== 'desktop') continue;
        if (size.views !== undefined && !size.views.includes(view)) continue;
        if (only !== null && !only.includes(view)) continue;
        // A list wider than the screen is not a width this screen has.
        if (view.startsWith('narrow-') && Number(view.slice(7)) > size.width) continue;
        await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, screenWidth: size.screen[0], screenHeight: size.screen[1], deviceScaleFactor: size.phone ? 3 : 2, mobile: size.mouse !== true });
        await send('Emulation.setTouchEmulationEnabled', { enabled: size.mouse !== true, maxTouchPoints: 5 });
        // A headless page has no focus of its own, so focus() would fire no focus events, which move the list's Tab stop (main.ts).
        await send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'hover', value: size.mouse ? 'hover' : 'none' }, { name: 'pointer', value: size.mouse ? 'fine' : 'coarse' }] });
        await send('Emulation.setSafeAreaInsetsOverride', { insets: size.insets });
        await send('Page.navigate', { url: base + '?view=' + view + (historyCase === null ? '' : '&hcase=' + historyCase) });
        await evaluate('new Promise((done) => { const wait = () => (document.querySelector("#root .header, #root .list-header") ? setTimeout(done, 200) : setTimeout(wait, 50)); wait(); })');
        const name = scheme + ' ' + size.device + ' ' + size.orientation + ' ' + view;
        const steps = OPEN[view] ?? [];
        const missing = [];

        for (const step of steps) {
          // A step is a selector to click, one to open the menu of, as a right click or a long press does, at its centre, or a script to run (openTab).
          if (typeof step === 'object' && step.eval !== undefined) {
            if (!(await evaluate(step.eval))) missing.push(step.name);
          } else {
            const selector = typeof step === 'string' ? step : step.contextmenu;
            const act = typeof step === 'string' ? 'node.click()' : 'node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: node.getBoundingClientRect().left + node.getBoundingClientRect().width / 2, clientY: node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2 }))';

            if (!(await evaluate('(() => { const node = document.querySelector(' + JSON.stringify(selector) + '); if (node) ' + act + '; return node !== null; })()'))) missing.push(selector);
          }
          await wait(150);
        }

        await wait(200);
        // The diff viewer loads its modules and draws each file's header after the tab opens.
        if (view === 'diffs') await evaluate('new Promise((done) => { const end = Date.now() + 10000; const wait = () => (document.querySelector(".diff-chevron") || Date.now() > end ? setTimeout(done, 300) : setTimeout(wait, 100)); wait(); })');
        const m = await evaluate(measure);

        // The main control's accessible name as the browser computes it, which a hidden label or an aria-label would change; not while a modal
        // dialog, such as Settings, leaves the page behind it out of the accessibility tree.
        if (m.header?.main && !(await evaluate('document.querySelector("[aria-modal=true]") !== null'))) {
          const { root } = await send('DOM.getDocument', { depth: 0 });
          const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '.header button.row-main' });
          const { nodes } = await send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });

          m.header.main.name = nodes.find((node) => !node.ignored)?.name?.value ?? null;
        }
        const found = missing.length > 0 ? ['could not open the view: no ' + missing.join(', ')] : failures(view, size, m);

        // A search box's text keeps its width: nothing else in its bar covers it, and it is at least SEARCH_MIN px wide.
        if (SEARCHES[view] !== undefined && missing.length === 0) {
          const fit = await evaluate(searchFit(SEARCHES[view]));

          if (fit === null) found.push('no search field shows');
          else {
            if (fit.width < SEARCH_MIN) found.push('the search field is ' + fit.width + ' px wide, under ' + SEARCH_MIN + ' px');
            fit.over.forEach((one) => found.push(one + ' covers the search field'));
          }
        }

        if (view.startsWith('settings') && view !== 'settings-nav' && missing.length === 0) found.push(...settingsFailures(view, size, await evaluate(SETTINGS)));

        if (view.startsWith('mic-') && missing.length === 0) found.push(...micFailures(view, size, await evaluate(MIC)));

        // The context meter's menu shows its details whole inside the viewport, each row on one line with its value beside its name.
        if (view === 'context-details' && missing.length === 0) found.push(...(await evaluate(CONTEXT_DETAILS)));

        // The questions chip floats centred over the composer's box, clear of it and on top of what it floats over, at the conversation's end
        // and halfway up.
        if (view.startsWith('questions')) {
          for (const at of ['middle', 'end']) {
            const chip = await evaluate(chipFloat(at));

            if (report) console.log(name + ' chip at the ' + at + ': ' + JSON.stringify(chip));
            if (!chip.shown) found.push('no questions chip with the card out of view at the ' + at);
            else {
              if (chip.off > 1) found.push('at the ' + at + ' the questions chip is ' + chip.off + " px off the composer's centre");
              if (chip.gap < 0) found.push('at the ' + at + " the questions chip covers the composer's box by " + -chip.gap + ' px');
              if (chip.top < 0) found.push('at the ' + at + ' the questions chip is above the viewport');
              if (!chip.pressed) found.push('at the ' + at + ' a press at the questions chip\'s centre reaches something else');
            }
          }
          // The card's topic is a label at 4.5:1 or more, and its first question's Back, disabled, has no border of its own.
          const look = await evaluate(CARD_LOOK);

          if (report) console.log(name + ' card: ' + JSON.stringify(look));
          if (look === null) found.push('no card with a topic and Back at the top of the conversation');
          else {
            if (look.contrast < 4.5) found.push("the card's topic is " + look.contrast + ':1 on the card');
            if (!look.disabled || look.borderAlpha > 0) found.push("the first question's Back is " + (look.disabled ? 'disabled with the border ' + look.border : 'enabled'));
          }
          await evaluate('(() => { const panel = document.getElementById("panel"); panel.scrollTop = panel.scrollHeight; })()');
        }

        if (view.endsWith('-menu') && missing.length === 0) {
          found.push(...menuFailures(view, size, await evaluate(MENU)));
          // The menu as it opens, before the touch targets' sweep scrolls it to its end.
          if (shots !== null) {
            mkdirSync(shots, { recursive: true });
            writeFileSync(join(shots, name.replaceAll(' ', '-') + '-open.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
          }
        }

        if (view === 'tabs' && missing.length === 0) {
          const more = await evaluate(moreOnTop);

          if (!more.open) found.push('More opened no menu');
          else if (more.covered.length > 0 || !more.inside || more.rows === 0) found.push('the More menu is covered at ' + more.covered.join(', ') + (more.inside ? '' : ', or passes the viewport') + (more.rows === 0 ? ', or has no rows' : ''));

          // A press on another tab of the strip, by the mouse or a finger, chooses it and closes the menu.
          if (more.open) {
            const tab = await evaluate(otherTab);

            if (tab === null) found.push('the strip with More shows no other tab to press');
            else {
              await press(send, size, tab);
              await wait(200);
              const after = await evaluate('JSON.stringify({ menu: document.querySelector(".tab-menu") !== null, chosen: document.querySelector(' + JSON.stringify('[data-id="' + tab.id + '"]') + ')?.matches(".selected, :has([aria-selected=true])") ?? false })');
              const { menu, chosen } = JSON.parse(after);

              if (menu) found.push('the More menu stays open after a press on the ' + tab.id + ' tab');
              if (!chosen) found.push('a press on the ' + tab.id + ' tab with More open did not choose it');
            }
          }
        }

        // The phone's layout by the device, never the drawer on a phone; the tablet's on the iPad.
        if (m.phone !== size.phone) found.push((size.phone ? 'no' : 'the') + " phone's layout on the " + size.device + ' at ' + size.width + ' px');
        if (size.phone && /\bdrawers\b/.test(m.root)) found.push('the list is a drawer on a phone');

        // A drag on the long conversation still scrolls it, one on the header moves nothing, and nor does one on an empty conversation.
        if (view === 'conversation' || view === 'empty') {
          const box = (selector) => evaluate('(() => { const box = document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect(); return { x: box.left + box.width / 2, top: box.top, bottom: box.bottom }; })()');
          /**
           * Drags a finger down from `start`, or just inside the top of `selector`, to just inside its bottom, or 200 px, whichever is shorter.
           */
          const drag = async (selector, start = null) => {
            const { x, top, bottom } = await box(selector);
            const from = start ?? top + 4;
            const to = Math.min(bottom - 4, from + 200);

            await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
            for (let step = 1; step <= 10; step++) {
              await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + ((to - from) * step) / 10 }] });
              await wait(16);
            }
            await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await wait(300);
          };
          const state = () => evaluate('JSON.stringify({ panel: document.getElementById("panel").scrollTop, page: document.scrollingElement.scrollTop, header: document.querySelector(".header").getBoundingClientRect().top })');
          const before = JSON.parse(await state());

          // On the conversation the finger lands on a reply's text. Chrome's emulated touch can take no pan on a single pixel row of a reply's own
          // box between its text and its meta line, as if the touch fell to the body's touch-action; the rows around it scroll.
          const text = view === 'conversation' ? await evaluate('(() => { const panel = document.getElementById("panel").getBoundingClientRect(); const line = [...document.querySelectorAll("#panel .reply .body p")].map((p) => p.getBoundingClientRect()).find((box) => box.top >= panel.top + 4 && box.bottom <= panel.bottom - 4); return line ? Math.round((line.top + line.bottom) / 2) : null; })()') : null;

          await drag('#panel', text);
          const scrolled = JSON.parse(await state());

          if (view === 'empty' && JSON.stringify(scrolled) !== JSON.stringify(before)) found.push('a drag on the empty conversation moved it: ' + JSON.stringify(scrolled));
          if (view === 'conversation' && !(scrolled.panel < before.panel)) found.push('a drag on the conversation did not scroll it: ' + before.panel + ' to ' + scrolled.panel);
          // A drag that starts on a table in a reply scrolls the conversation too: no box inside it keeps the drag (mechanics.md M125).
          if (view === 'conversation') {
            // The table's bottom at the conversation's, so its top is on screen whatever follows it.
            await evaluate('(() => { const panel = document.getElementById("panel"); const table = panel.querySelector(".body table"); panel.scrollTop += table.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom + 8; })()');
            await wait(100);
            const { x, top } = await box('#panel .body table');
            const end = JSON.parse(await state()).panel;

            await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: top + 4 }] });
            for (let step = 1; step <= 10; step++) {
              await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: top + 4 + step * 20 }] });
              await wait(16);
            }
            await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await wait(300);
            const fromTable = JSON.parse(await state()).panel;

            if (!(fromTable < end)) found.push('a drag that starts on a table did not scroll the conversation: ' + end + ' to ' + fromTable);
            await evaluate('(() => { const panel = document.getElementById("panel"); panel.scrollTop = ' + scrolled.panel + '; })()');
            await wait(100);
          }
          await drag('.header');
          const dragged = JSON.parse(await state());

          if (dragged.page !== 0 || dragged.header !== before.header || dragged.panel !== scrolled.panel) found.push('a drag on the header moved the page: ' + JSON.stringify(dragged));
        }

        // The toast and the console's foot, which the fake hub never raises, drawn with their own classes so their touch targets are measured.
        if (view === 'conversation') await evaluate(PROBES);

        // Every control's touch target, where the view opened and then down each scroller, a view's height at a time, so a control out of
        // view at first is measured too.
        if (missing.length === 0 && size.mouse !== true) {
          const small = new Set();
          const overlaps = new Set();
          const tasks = [];
          let checks = 0;
          const take = async () => { const touch = await evaluate(TOUCH); touch.small.forEach((one) => small.add(one)); touch.overlaps.forEach((one) => overlaps.add(one)); tasks.push(...touch.tasks); checks += touch.checks; };
          const scrollers = await evaluate('[...document.querySelectorAll("body *")].filter((node) => /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1).length');

          await take();
          for (let index = 0; index < scrollers; index++) {
            for (let step = 1; step <= 40; step++) {
              const moved = await evaluate('(() => { const node = [...document.querySelectorAll("body *")].filter((node) => /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1)[' + index + ']; if (!node || node.scrollTop + node.clientHeight >= node.scrollHeight - 1) return false; node.scrollTop += node.clientHeight * 0.8; return true; })()');

              if (!moved) break;
              await wait(60);
              await take();
            }
          }
          // The diffs view opens the Changes tree over the diffs, where it is not pinned beside them, and measures its rows and search too.
          if (view === 'diffs' && (await evaluate('(() => { const button = document.querySelector("[data-action=tree-flyout]"); button?.click(); return button !== null; })()'))) {
            await wait(400);
            await take();
          }
          // The questions views' card is at the conversation's top, out of view at the end, where the questions-waiting chip shows; measure the card too.
          if (view.startsWith('questions')) {
            await evaluate('document.getElementById("panel").scrollTop = 0');
            await wait(300);
            await take();
          }
          for (const one of small) found.push('a touch target under 44 px: ' + one);
          for (const one of overlaps) found.push('touch targets overlap: ' + one);
          if (SWITCHED.includes(view) && checks === 0) found.push('Settings showed no switch or checkbox to measure');
          if (view === 'conversation' && tasks.length === 0) found.push("a reply's task list showed no box to check");
          const seen = { diffs: ['.diff-chevron', '.diff-viewed'], context: ['.context-action'], questions: ['.qc-dot', '.question-waiting'], snooze: ['.sheet-choice'] }[view] ?? [];
          for (const selector of seen) {
            if (!(await evaluate('document.querySelector(' + JSON.stringify(selector) + ') !== null'))) found.push('the view showed no ' + selector + ' to measure');
          }
        }

        // With a mouse a question card's step dots are at least 24 px tall, as WCAG's least target size asks.
        if (view === 'questions' && size.mouse === true && missing.length === 0) {
          const dots = await evaluate('[...document.querySelectorAll(".qc-dot")].map((dot) => Math.round(dot.getBoundingClientRect().height))');

          if (dots.length === 0) found.push('the question card showed no step dots');
          else if (dots.some((height) => height < 24)) found.push("a question card's step dots are " + dots.join(', ') + ' px tall, under 24 px');
        }

        // Each link pill's and key's accessible name is its text, whether it shows its text or its icon alone.
        if (view.startsWith('narrow')) {
          const { root: top } = await send('DOM.getDocument', { depth: 0 });
          const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: top.nodeId, selector: '#list .row-line .pill[role=link]' });
          const texts = await evaluate('[...document.querySelectorAll("#list .row-line .pill[role=link]")].map((pill) => pill.querySelector(".pill-text").textContent)');

          if (nodeIds.length === 0) found.push('line 2 has no pill that opens a link');
          if (!(await evaluate('document.querySelector("#list .row-line .pill.ticket[role=link]") !== null'))) found.push('line 2 has no key that opens a link');
          for (const [index, nodeId] of nodeIds.entries()) {
            const { nodes } = await send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
            const named = nodes.find((node) => !node.ignored)?.name?.value;

            if (named !== texts[index]) found.push('line 2\'s pill ' + texts[index] + ' is named ' + JSON.stringify(named) + ' for screen readers');
          }
        }

        // The list narrowed past the breakpoint and widened again changes the pills by CSS alone, with the stream paused so nothing is redrawn;
        // a focused pill that drops out hands the focus to its row.
        if (view === 'narrow-330') {
          const resize = (width) => evaluate('(async () => { window.__paused = true; const style = [...document.querySelectorAll("style")].find((one) => one.textContent.startsWith("#list { width")); style.textContent = style.textContent.replace(/width: \\d+px/, "width: ' + width + 'px"); await new Promise((done) => setTimeout(done, 250)); window.__line2 = []; await new Promise((done) => setTimeout(done, 500)); })()');
          const rows = await evaluate('window.__rows = [...document.querySelectorAll("#list .row-line")]; window.__rows.length');

          for (const [width, as] of [[300, 'narrow-300'], [330, 'narrow-330']]) {
            await resize(width);
            found.push(...failures(as, size, await evaluate(measure)).map((one) => 'resized to ' + width + ' px: ' + one));
          }
          await resize(300);
          const focused = await evaluate('(() => { const pill = document.querySelector("#list [data-work-item=\\"4\\"] .pill.link[title^=Spec]"); pill?.focus(); return pill !== null && document.activeElement === pill; })()');

          if (!focused) found.push('the Spec pill could not take the focus at 300 px');
          await resize(200);
          const after = await evaluate('(() => { const pill = document.querySelector("#list [data-work-item=\\"4\\"] .pill.link[title^=Spec]"); return { stop: pill.tabIndex, row: document.activeElement === pill.closest(".row"), same: window.__rows.every((line) => line.isConnected) && document.querySelectorAll("#list .row-line").length === ' + rows + ' }; })()');

          if (after.stop !== -1 || !after.row) found.push('resized to 200 px: the focused Spec pill, left out, kept ' + (after.row ? 'its keyboard stop' : 'the focus'));
          if (!after.same) found.push('resizing the list redrew its rows');
          // Back to the view's own width, for its screenshot.
          await resize(330);
          await evaluate('window.__paused = false');
        }

        // An edit shows the bar with Save, one 52 px row on a phone above the home indicator's inset.
        if (view === 'settings' && missing.length === 0) {
          const dirty = await evaluate(DIRTY);

          if (dirty === null) found.push('Settings showed no text field to edit');
          else if (dirty.bar === null || !dirty.save) found.push('an edit did not show the bar with Save');
          else if (size.phone && dirty.bar > 52 + size.insets.bottom + 0.5) found.push('the bar is ' + dirty.bar + ' px tall on a phone, more than one 52 px row');
        }

        results.push({ name, ...m });
        // History's screenshots show its top too: the head, the pinned state and the filter.
        if (shots !== null && view.startsWith('history')) {
          await evaluate('document.querySelectorAll(".hist-body").forEach((body) => { body.scrollTop = 0; })');
          await wait(150);
          mkdirSync(shots, { recursive: true });
          writeFileSync(join(shots, name.replaceAll(' ', '-') + '-top.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        }
        if (shots !== null) {
          mkdirSync(shots, { recursive: true });
          writeFileSync(join(shots, name.replaceAll(' ', '-') + '.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        }
        console.log((found.length === 0 ? 'ok   ' : 'FAIL ') + name);
        found.forEach((one) => console.log('     ' + one));
        failed += found.length === 0 ? 0 : 1;
      }
    }
  }

  socket.close();
  if (report) console.log(JSON.stringify(results, null, 1));
} finally {
  browser.kill();
  await exited;
  server.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

process.exitCode = failed === 0 ? 0 : 1;
