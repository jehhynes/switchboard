// Checks the page's shell at iPhone sizes and an iPad's, and its tabs on a desktop, in a real headless Chrome or Edge (testing.md § Web page shell check): in the installed
// app's standalone mode, portrait and landscape, light and dark, the list, a conversation, an empty one, History, Settings, the drawer, a sheet,
// the persona dialog, a work item with more tabs than fit, and the list at 200, 260, 300, 330 and 420 px. Every tab shown keeps its label, no tab passes its strip,
// a tab's unread dot sits at its label's top-right, clear of its close mark and taking no width, and the More menu lies above everything under it. Line 2 is one line, never wrapping and its items never
// below one another, at several list widths down to 200 px; its playbook or host is cut, with an ellipsis and a tooltip naming it whole, only
// where it does not fit beside the comment icon and the key; a key shows its source's logo, GitHub's, Zoho's or a plugin's, in place of its source's label; every pill, the key included, shows its text where line 2 is 300 px wide or more and its icon alone under that,
// its text kept for screen readers; the key never drops out; a link pill is whole, its icon alone or left out whole, never cut, the last
// first; a pill left out is no keyboard stop, and a pill shown is one only in the list's Tab stop row; the pills change with the list's width alone, without a redraw; and line 2 paints the same while
// the same list is sent again. A row's waiting questions show on line 1 after the title as their icon alone, whole, visible in the warning text colour, the title cut before them. Every control shown is a touch target of at least 44 px each way.
// Nothing outside the scrollers can move: the document is exactly the viewport, nothing reaches past it outside a scroller, every scroller keeps
// a drag to itself or hands it to the pane around it, and the page outside the scrollers takes no pan. Chrome has no display-mode emulation, so the page's standalone rules are
// applied to every width here, and safe-area insets come from the DevTools protocol.
// Run `npm run build` first; the browser is SWITCHBOARD_CHROME, else Chrome or Edge where they install. --report prints the measurements.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAGE_ASSETS } from './dist/index.js';

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
  // A desktop with a mouse, for the tabs view, whose close marks are the small ones, not touch targets, and Settings' pages.
  { device: 'desktop', orientation: 'landscape', width: 1800, height: 1000, screen: [1800, 1000], insets: { top: 0, bottom: 0, left: 0, right: 0 }, phone: false, mouse: true, views: ['tabs', 'settings-nav', ...Object.keys(SETTINGS_PAGES), 'settings-pair', 'settings-table', 'pair'] },
];
/** Settings' views that show switches or checkboxes, so their touch targets are measured. */
const SWITCHED = ['settings-source', 'settings-playbook', 'settings-table', 'settings-display', 'settings-devices', 'settings-advanced', 'settings-spoken-replies', 'settings-dictation'];
const VIEWS = ['list', 'narrow', 'narrow-260', 'narrow-300', 'narrow-330', 'narrow-420', 'conversation', 'empty', 'history', 'settings-nav', ...Object.keys(SETTINGS_PAGES), 'settings-pair', 'settings-table', 'drawer', 'sheet', 'pair', 'persona', 'tabs'];
const report = process.argv.includes('--report');
/** --views <a,b> checks only those views; --shots <dir> saves a screenshot of each view there. */
const only = process.argv.includes('--views') ? process.argv[process.argv.indexOf('--views') + 1].split(',') : null;
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;

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
const header = { notes: [], sources: [source('github', 'GitHub'), source('zoho', 'Zoho Desk'), source('dpaf', 'DPAF', { viewBox: '0 0 16 16', path: 'M1 3h14v10H1z', color: '#2f6fb0' })], repoRoots: [], schedules: [] };
const groups = [{ key: 'progress', title: 'In progress', glyph: '\u{ea70}', empty: null, rows: [row(1, 'Fix it', { history: { ticketId: 1, key: 'gh 1' }, actions: [approve, remove], details: [state('2/5 fixing tests · 4m', 'dim')] }), row(2, 'Another thing with questions waiting on the operator and a long title', { ...crowded, questions: 12 }), row(3, 'Hosted', { host: 'a-very-long-host-name.example.com', ticket: 'zoho 21510', ticketNumber: '21510', sourceKind: 'zoho', url: 'https://desk.zoho.com/t/21510', comment: { glyph: '\u{ea6b}', title: 'A comment' }, details: [state('reviewing the comments · 1m', null)] }), row(4, 'Short playbook', { ...short, questions: 1 }), ...(view?.startsWith('narrow') ? [] : [row(5, 'Many links', many)]), row(6, 'Ad hoc', adhoc), ...(view?.startsWith('narrow') ? [] : [row(7, 'Long key', { ticket: 'a-very-long-ad-hoc-repository-folder-name-for-testing 12345', ticketNumber: undefined, sourceKind: 'adhoc', comment: { glyph: '\u{ea6b}', title: 'A comment' }, playbook: 'dev:address-pr-review' })])].filter((one) => !(view?.startsWith('narrow') && one.workItemId === 1)) }];
// The list at its narrowest, 200 px, at 260 and 300 px, where line 2's pills show their icons alone, and at 330 and 420 px, where they show
// their texts. Only its width is set: it keeps page.css's flex: 1 in the side column, which bounds its height so it scrolls.
const narrow = view === 'narrow' ? 200 : view?.startsWith('narrow-') ? Number(view.slice(7)) : null;
const listing = view === 'list' || narrow !== null;
const open = !listing && !view?.startsWith('settings');
if (narrow !== null) document.head.insertAdjacentHTML('beforeend', '<style>#list { width: ' + narrow + 'px !important; min-width: 0 !important; max-width: none !important; }</style>');
// A title longer than any header here fits, so the header shows how much of it is left beside the main control.
const longTitle = 'Call Center dialer stops receiving incoming calls when its registration lapses';
const scope = open ? { kind: 'page', key: 'k', folder: 'D:/w', title: longTitle, scopeGen: 3, conversations: [{ workItemId: 1, title: longTitle, primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0, sessionTitle: 'switchboard · dev:build · github 1' }], workItemId: 1, cwd: 'D:/w', sessionId: 's' } : null;
const session = { id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: view === 'persona' ? { id: 'nova', name: 'Nova', pinned: true, tonePending: false } : null, canPin: true };
const personas = [{ id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: 'Warm and brief, with a dry joke now and then.' }, { id: 'iris', name: 'Iris', voice: 'marin', style: 'none', personality: '' }];
const items = [];
for (let i = 0; view !== 'empty' && open && i < 30; i++) {
  items.push({ type: 'message', id: 'm' + i, sessionId: 's', workItemId: 1, at: now - 100000 + i * 2000, ord: i * 2, provisional: false, withdrawn: false, origin: 'typed', text: 'Message ' + i, delivery: 'sent', error: null });
  items.push({ type: 'reply', id: 'r' + i, sessionId: 's', at: now - 99000 + i * 2000, ord: i * 2 + 1, provisional: false, kind: 'reply', answers: null, opening: 'Reply ' + i + ', long enough to wrap across a phone screen.' + (i === 29 ? '\\n\\n| Column | Another column |\\n|---|---|\\n| a | b |' : i === 28 ? '\\n\\n~~~\\nnpm run build\\n~~~' : ''), rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null } });
}
// The conversation ends with a message the transcript did not show, so its Send again is measured as a touch target.
if (open && view === 'conversation') items.push({ type: 'message', id: 'm-lost', sessionId: 's', workItemId: 1, at: now - 30000, ord: 100, provisional: false, withdrawn: false, origin: 'typed', text: 'Can we make these notices bigger?', delivery: 'unconfirmed', error: 'The transcript does not show this message.' });
history.replaceState(null, '', location.search + (open ? '#w=1' : '#'));
// The tabs view's work item has more artifacts, with long titles but the newest's, than any strip here fits.
const artifacts = view === 'tabs' ? Array.from({ length: 10 }, (_, i) => ({ path: 'chat/a' + i + '.md', owner: 'chat', kind: 'note', title: i === 9 ? 'Plan' : 'A long artifact title number ' + i, ext: 'md', type: 'markdown', updatedAt: now - (10 - i) * 1000 })) : [];
class FakeSource {
  constructor() {
    this.listeners = {};
    setTimeout(() => this.emit('hello', { key: 'pk', groups, header, scope, sessions: open ? [session] : [], items, more: false, state: view === 'tabs' ? { id: 'st', sessionId: 's', at: now, headline: 'Built', body: 'Built.', stale: null, unread: true } : null, artifacts, unread: 0 }), 20);
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
// History's tab reads a ticket with one entry per day over a week, so its pane scrolls.
const historyView = { key: 'gh 1', title: 'Fix it', url: '', facts: [{ label: 'Status', value: 'Running' }], links: [], reconstructed: false, recordedSince: null, sections: [{ key: 'w1', workItemId: 1, title: 'dev:build', status: 'Running', tone: 'accent', facts: [], prompt: null, entries: Array.from({ length: 40 }, (_, i) => ({ key: 'e' + i, at: now - (40 - i) * 3600000, category: 'session', icon: 'play', text: 'Entry ' + i, lines: [], detail: null, shortId: null, links: [], tone: null, reconstructed: false, refused: null, stateChange: false })) }] };
// Settings reads a file with checkboxes on General and in the playbooks' table.
const settingsRead = { settings: { path: 'C:/Users/someone/.switchboard/settings.json', version: 'v1', value: { sessions: { codeMode: true }, web: { tailscale: true }, sources: { github: { repo: 'o/r', logins: ['me'], repoRoot: 'D:/git/r' } }, schedules: { weekly: { playbook: 'dev:build', repoRoot: 'D:/git/r', every: 'week', day: 'mon', at: '09:00' } }, voice: { enabled: true, personas: [{ id: 'nova', name: 'Nova', voice: 'cedar' }], playbookPersonas: { 'dev:build': 'nova' } }, playbooks: { 'dev:build': { description: 'Build it', template: 'Build.', reports: ['done', 'approval'] }, 'dev:plan': { description: 'Plan it', template: 'Plan.', autoStart: true } } }, error: null }, permissionModes: ['default', 'auto'], codexPermissionModes: ['default'], providers: ['claude', 'codex'], templateVariables: [], sourceKinds: ['github'], sourceLabels: { github: 'GitHub' }, inUse: {}, enabled: { github: true }, configDir: 'C:/Users/someone/.switchboard' };
// Pair a device and Devices list more devices than the sheet shows at once, so its list scrolls, and a pairing address longer than a phone's line.
const pairDevices = [{ id: 'a1', label: 'Windows · Edge', host: null, login: null, createdAt: now, usedAt: now, current: true }, { id: 'b2', label: 'iPhone · Safari', host: 'pc.tailnet.ts.net', login: 'someone@example.com', createdAt: now, usedAt: now, current: false, voice: true }, ...['Android · Chrome', 'iPad · Safari', 'Mac · Safari', 'Windows · Chrome', 'Linux · Firefox', 'Android · Firefox'].map((label, i) => ({ id: 'c' + i, label, host: 'some-long-computer-name.tail1234ab.ts.net', login: 'someone@example.com', createdAt: now, usedAt: now - i * 86400000, current: false }))];
const pairing = { url: 'https://some-long-computer-name.tail1234ab.ts.net/page?t=' + 'a'.repeat(64), code: 'ABCD-EFGH', host: 'some-long-computer-name.tail1234ab.ts.net', expiresAt: now + 5 * 60000 };
window.fetch = async (url) => ({ status: 200, ok: true, headers: new Headers(), json: async () => (String(url).endsWith('/page-devices') ? { devices: pairDevices } : String(url).endsWith('/page-pair') ? pairing : String(url).endsWith('/page-voice-enroll') ? { enrollment: { state: 'idle', endsAt: null, error: null, enrolledAt: '2026-10-02T10:00:00.000Z' } } : String(url).endsWith('/personas') ? { personas } : String(url).endsWith('/page-history') ? { view: historyView, categories: [{ key: 'session', label: 'Sessions', icon: 'terminal' }] } : String(url).endsWith('/page-settings-read') ? settingsRead : String(url).endsWith('/page-settings-check') ? { errors: [] } : {}), text: async () => '' });
const matchMedia = window.matchMedia.bind(window);
window.matchMedia = (query) => (query.includes('display-mode: standalone') ? { matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : matchMedia(query));
</script>`;

/** Measures the open view: the document, whatever reaches past the viewport outside a scroller, and the scrollers. */
const measure = `(() => {
  const root = document.documentElement;
  const shown = (node) => { for (let one = node; one; one = one.parentElement) { const style = getComputedStyle(one); if (style.display === 'none' || style.visibility === 'hidden') return false; } return true; };
  const scrolls = (node) => /auto|scroll/.test(getComputedStyle(node).overflowY + getComputedStyle(node).overflowX);
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
        // Whether History shows, and how many artifact tabs show besides the one chosen: the tabs whose unread dots the tabs view expects.
        history: tabs.some((tab) => tab.dataset.id === 'history'),
        artifacts: tabs.filter((tab) => (tab.dataset.id ?? '').startsWith('artifact:') && !tab.classList.contains('selected') && tab.querySelector('[aria-selected="true"]') === null).length,
        cut: [...strip.querySelectorAll('.tab-label')].filter((label) => !shown(label) || label.getBoundingClientRect().width < Math.min(43.5, label.scrollWidth - 0.5)).map((label) => label.textContent),
        past: tabs.filter((tab) => { const box = tab.getBoundingClientRect(); return box.left < edge.left - 0.5 || box.right > edge.right + 0.5; }).map(name),
        // Each unread dot of a tab: where it lies against its label, its tab and its close mark, and whether hiding it changes the tab's width.
        dots: [...strip.querySelectorAll('.tab .unread-dot:not(.tab-badge > *)')].filter(shown).map((dot) => {
          const tab = dot.closest('.tab');
          const label = dot.previousElementSibling?.classList.contains('tab-label') ? dot.previousElementSibling.getBoundingClientRect() : null;
          const box = dot.getBoundingClientRect();
          const close = tab.querySelector('.tab-close .codicon')?.getBoundingClientRect() ?? null;
          const tabBox = tab.getBoundingClientRect();
          const cut = tab.querySelector('.tab-label');
          // The tab's width and its label's as drawn, as fitStripTabs measures them, and the tab's own widest, unconstrained by the strip.
          const widths = () => {
            const drawn = [tab.getBoundingClientRect().width, cut.getBoundingClientRect().width];

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
          return { tab: tab.querySelector('.tab-label')?.textContent, cut: (tab.querySelector('.tab-label')?.scrollWidth ?? 0) > (tab.querySelector('.tab-label')?.clientWidth ?? 0), closable: close !== null, label: label && { left: label.left, right: label.right, top: label.top, bottom: label.bottom }, dot: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, tabBox: { top: tabBox.top, right: tabBox.right }, close: close && { left: close.left, right: close.right, top: close.top, bottom: close.bottom }, widthChange: Math.max(...width.map((one, i) => Math.abs(one - without[i]))) };
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
    tops: { header: top('.header'), listHeader: top('.list-header'), settingsHead: top('.settings-head'), personaHead: top('.persona-head'), tabs: top('.tabs'), panel: top('#panel'), list: top('#list') },
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
 * measured, so a view meant to show some proves it did.
 */
const TOUCH = `(() => {
  const shown = (node) => { for (let one = node; one; one = one.parentElement) { const style = getComputedStyle(one); if (style.display === 'none' || style.visibility === 'hidden') return false; } return true; };
  const name = (node) => node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/ +/).join('.') : '');
  let checks = 0;
  const small = (() => {
    // Every control shown is a touch target of at least 44 px each way (architecture.md § Web page, Phones first), measured as its box cut by
    // every ancestor that clips without scrolling. Not held to it: line 2's pills, whose press is an open question; links inside prose; and a
    // tab's own buttons, which fill their tab between its 1 px top and bottom borders, its whole height less those.
  return [...document.querySelectorAll('button, a[href], [role="tab"], [role="menuitem"], [role="link"], [role="button"], input[type="checkbox"], input[type="radio"], select, summary')].filter(shown).flatMap((node) => {
      // A row's waiting questions are held to it no more than its pills: a press that misses them opens the work item, whose conversation offers the card.
      if (node.matches('.row .pill, .row-head .questions, :is(.body, .artifact-doc, .sheet-detail, .hist-body p, .group-empty) a')) return [];
      // A checkbox or radio takes presses on its label too, which holds it (settings.tsx).
      const target = node.matches('input[type="checkbox"], input[type="radio"]') ? (node.closest('label') ?? node) : node;
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
      const tall = tab === null ? height >= 43.5 : tab.getBoundingClientRect().height >= 43.5 && height >= tab.clientHeight - 0.5;
      return width >= 43.5 && tall ? [] : [name(node) + ' ' + Math.round(width) + 'x' + Math.round(height)];
    });
  })();
  return { small, checks };
})()`;

/** A toast with its work item's link and Dismiss (toast.tsx), and the console's foot with Reconnect (console.ts). */
const PROBES = `(() => {
  document.getElementById('toast').insertAdjacentHTML('beforeend', '<div class="toast warning"><button type="button" class="toast-text toast-open">This work item can no longer do that.</button><button type="button" class="icon dismiss" aria-label="Dismiss"><span class="codicon codicon-close"></span></button></div>');
  document.body.insertAdjacentHTML('beforeend', '<div class="console" style="position: fixed; left: 0; bottom: 0; width: 300px"><div class="console-foot"><p class="console-note">Ended.</p><button type="button" class="console-reconnect">Reconnect</button></div></div>');
})()`;

const OPEN = {
  history: ['[data-action=actions]', '[data-action=row-history]'],
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
  persona: ['[data-action=view-menu]', '[data-action=persona]'],
  // An artifact chosen from More, so the strip keeps it beside the tabs it always keeps: the oldest, so the newest stays unread where it has room.
  tabs: ['.tab-more-button', '.tab-menu [data-action=artifact][data-path="chat/a0.md"]'],
};

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
    if (strip.past.length > 0) out.push('a tab passes its strip: ' + strip.past.slice(0, 4).join(', '));
  }
  // A tab's unread dot sits at its label's top-right, inside its tab, clear of its close mark, and takes no width.
  const dots = m.strips.flatMap((strip) => strip.dots);

  for (const one of dots) {
    const where = 'the unread dot of the tab ' + (one.tab ?? '?');

    if (one.label === null) {
      out.push(where + ' does not follow its label');
      continue;
    }
    if (one.dot.left < one.label.right - 1 || one.dot.left > one.label.right + 2) out.push(where + ' starts at ' + one.dot.left + ', not at its label\'s end, ' + one.label.right);
    if (one.dot.bottom > (one.label.top + one.label.bottom) / 2 || one.dot.top < one.tabBox.top) out.push(where + ' is not at its label\'s top: ' + one.dot.top + ' to ' + one.dot.bottom + ' for a label ' + one.label.top + ' to ' + one.label.bottom);
    if (one.dot.right > one.tabBox.right + 0.5) out.push(where + ' passes its tab');
    if (one.close !== null && one.dot.right > one.close.left - 0.5 && one.dot.left < one.close.right + 0.5 && one.dot.bottom > one.close.top - 0.5 && one.dot.top < one.close.bottom + 0.5) out.push(where + ' covers its close mark');
    if (Math.abs(one.widthChange) > 0.5) out.push(where + ' changes its tab\'s or label\'s width by ' + one.widthChange + ' px');
  }
  // The tabs view's state and artifacts are unread: History's dot, a tab without a close mark, shows wherever History has room after Changes,
  // and an artifact's, with a close mark, cut or not, wherever the strip has room for an artifact tab besides the one shown.
  if (view === 'tabs') {
    if (m.strips.some((strip) => strip.history) && !dots.some((one) => !one.closable)) out.push('no unread dot on a tab without a close mark');
    if (m.strips.some((strip) => strip.artifacts > 0) && !dots.some((one) => one.closable)) out.push('no unread dot on an artifact tab');
    if (size.device === 'ipad' && !(dots.some((one) => one.closable && one.cut) && dots.some((one) => one.closable && !one.cut))) out.push('no unread dot on both a cut and a whole artifact title');
  }
  // The tabs view's strip has more tabs than fit, so More holds the rest.
  if (view === 'tabs' && !m.strips.some((strip) => strip.more)) out.push('no strip shows More for a work item with more tabs than fit');
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
  for (const [bar, top] of Object.entries(m.tops)) {
    // The dialogs, Settings and the persona dialog, outside the phone's layout sit inside the dimmed page's margin.
    if ((['header', 'listHeader'].includes(bar) || (['settingsHead', 'personaHead'].includes(bar) && size.phone)) && top !== null && top !== 0) out.push('the ' + bar + ' starts ' + top + ' px down');
  }
  // In portrait, under the status bar, WebKit finds the view's own solid top bar at the top edge, in the bars' colour, and paints the status bar in
  // it instead of blurring the page's top. An open sheet's dimmed backdrop is viewport-sized, which keeps the colour WebKit had. Landscape has no
  // status bar, so no colour is painted there, and its bars, inside the notch's insets, are under 90% of the width. The iPad is not checked for it.
  if (size.device === 'iphone' && size.orientation === 'portrait') {
    const edge = m.edge;
    const own = view === 'sheet' || view === 'pair' ? edge.kind === 'viewport' : edge.kind === 'bar' && /^[a-z]+\.(header|list-header|hist-bar|settings-head|persona-head)(\.|$)/.test(edge.name ?? '');

    if (!own) out.push('WebKit finds ' + (edge.name ?? 'no fixed or sticky box (hit ' + edge.hit + ')') + (edge.kind ? ' (' + edge.kind + ')' : '') + ' at the top edge, not the view\'s top bar');
    else if (edge.kind === 'bar' && (edge.top !== 0 || edge.height <= 10 || edge.background !== m.bar)) out.push('the top bar ' + edge.name + ' is at ' + edge.top + ', ' + edge.height + ' px tall, ' + edge.background + ' for the bars\' ' + m.bar);
  }
  return out;
}

const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://x').pathname;
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

  while (target === undefined) {
    if (Date.now() > deadline) throw new Error('The browser opened no page');
    target = (await fetch('http://127.0.0.1:' + port + '/json').then((answer) => answer.json()).catch(() => [])).find((one) => one.type === 'page');
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
        await send('Page.navigate', { url: base + '?view=' + view });
        await evaluate('new Promise((done) => { const wait = () => (document.querySelector("#root .header, #root .list-header") ? setTimeout(done, 200) : setTimeout(wait, 50)); wait(); })');
        const name = scheme + ' ' + size.device + ' ' + size.orientation + ' ' + view;
        const steps = OPEN[view] ?? [];
        const missing = [];

        for (const selector of steps) {
          if (!(await evaluate('(() => { const node = document.querySelector(' + JSON.stringify(selector) + '); node?.click(); return node !== null; })()'))) missing.push(selector);
          await wait(150);
        }

        await wait(200);
        const m = await evaluate(measure);

        // The main control's accessible name as the browser computes it, which a hidden label or an aria-label would change; not while a modal
        // dialog, such as the persona dialog, leaves the page behind it out of the accessibility tree.
        if (m.header?.main && !(await evaluate('document.querySelector("[aria-modal=true]") !== null'))) {
          const { root } = await send('DOM.getDocument', { depth: 0 });
          const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '.header button.row-main' });
          const { nodes } = await send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });

          m.header.main.name = nodes.find((node) => !node.ignored)?.name?.value ?? null;
        }
        const found = missing.length > 0 ? ['could not open the view: no ' + missing.join(', ')] : failures(view, size, m);

        if (view.startsWith('settings') && view !== 'settings-nav' && missing.length === 0) found.push(...settingsFailures(view, size, await evaluate(SETTINGS)));

        if (view === 'tabs' && missing.length === 0) {
          const more = await evaluate(moreOnTop);

          if (!more.open) found.push('More opened no menu');
          else if (more.covered.length > 0 || !more.inside || more.rows === 0) found.push('the More menu is covered at ' + more.covered.join(', ') + (more.inside ? '' : ', or passes the viewport') + (more.rows === 0 ? ', or has no rows' : ''));
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
          let checks = 0;
          const take = async () => { const touch = await evaluate(TOUCH); touch.small.forEach((one) => small.add(one)); checks += touch.checks; };
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
          for (const one of small) found.push('a touch target under 44 px: ' + one);
          if (SWITCHED.includes(view) && checks === 0) found.push('Settings showed no switch or checkbox to measure');
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
