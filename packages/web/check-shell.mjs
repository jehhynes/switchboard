// Checks the page's shell at iPhone sizes and an iPad's in a real headless Chrome or Edge (testing.md § Web page shell check): in the installed
// app's standalone mode, portrait and landscape, light and dark, the list, a conversation, an empty one, History, Settings, the drawer, a sheet,
// the persona dialog, a work item with more tabs than fit, and the list at 200 px. Every tab shown keeps its label, no tab passes its strip, and
// the More menu lies above everything under it. Line 2's playbook or host is never cut, its pills are whole or left out whole, the ticket
// key always shows, and line 2 paints the same while the same list is sent again.
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
 * iPhone 16 Pro in the installed app under the opaque status bar: 393 by 852 pt, less the 59 pt status bar in portrait; none in landscape. Both
 * draw the phone's layout. iPad Air 11" on its side, 1180 by 820 pt less its 24 pt status bar, draws the drawer.
 */
const SIZES = [
  { device: 'iphone', orientation: 'portrait', width: 393, height: 793, screen: [393, 852], insets: { top: 0, bottom: 34, left: 0, right: 0 }, phone: true },
  { device: 'iphone', orientation: 'landscape', width: 852, height: 393, screen: [852, 393], insets: { top: 0, bottom: 21, left: 59, right: 59 }, phone: true },
  { device: 'ipad', orientation: 'landscape', width: 1180, height: 796, screen: [1180, 820], insets: { top: 0, bottom: 20, left: 0, right: 0 }, phone: false },
];
const VIEWS = ['list', 'narrow', 'conversation', 'empty', 'history', 'settings', 'drawer', 'sheet', 'persona', 'tabs'];
const report = process.argv.includes('--report');
/** --shots <dir> saves a screenshot of each view there. */
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
sessionStorage.removeItem('switchboard.scroll');
const now = Date.now();
const row = (id, title, patch = {}) => ({ workItemId: id, ticketId: id, title, priority: null, time: null, ticket: 'gh ' + id, sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], band: null, voice: null, history: null, ...patch });
const remove = { label: 'Delete', action: 'delete', icon: 'trash', group: 'state', confirm: { question: 'Delete Fix it?', detail: 'It goes for good.', action: 'delete' }, input: null };
// The second row's line 2 holds more pills than fit beside its long playbook, so some drop out.
const pr = (n) => ({ label: 'PR #' + n, url: 'https://github.com/o/r/pull/' + n, kind: 'pr', badge: String(n), glyph: '\u{ea64}', mentioned: false });
const crowded = { ticket: 'gh 21509', playbook: 'dev:address-pr-review', comment: { glyph: '\u{ea6b}', title: 'A comment' }, links: [pr(21512), pr(21513), pr(21514), pr(21515), { label: 'Design notes', url: 'https://example.com/notes', kind: 'url', badge: 'Design notes', glyph: '\u{eb15}', mentioned: false }], returned: 2 };
const groups = [{ key: 'progress', title: 'In progress', glyph: '\u{ea70}', empty: null, rows: [row(1, 'Fix it', { history: { ticketId: 1, key: 'gh 1' }, actions: [remove] }), row(2, 'Another thing', crowded), row(3, 'Hosted', { host: 'a-very-long-host-name.example.com', ticket: 'gh 21510', comment: { glyph: '\u{ea6b}', title: 'A comment' } })] }];
const listing = view === 'list' || view === 'narrow';
const open = !listing && view !== 'settings';
// The list at its narrowest, 200 px, where line 2 wraps.
if (view === 'narrow') document.head.insertAdjacentHTML('beforeend', '<style>#list { width: 200px !important; min-width: 0 !important; max-width: none !important; flex: none !important; }</style>');
const scope = open ? { kind: 'page', key: 'k', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' } : null;
const session = { id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: view === 'persona' ? { id: 'nova', name: 'Nova', pinned: true, tonePending: false } : null, canPin: true };
const personas = [{ id: 'nova', name: 'Nova', voice: 'cedar', style: 'pair', personality: 'Warm and brief, with a dry joke now and then.' }, { id: 'iris', name: 'Iris', voice: 'marin', style: 'none', personality: '' }];
const items = [];
for (let i = 0; view !== 'empty' && open && i < 30; i++) {
  items.push({ type: 'message', id: 'm' + i, sessionId: 's', workItemId: 1, at: now - 100000 + i * 2000, ord: i * 2, provisional: false, withdrawn: false, origin: 'typed', text: 'Message ' + i, delivery: 'sent', error: null });
  items.push({ type: 'reply', id: 'r' + i, sessionId: 's', at: now - 99000 + i * 2000, ord: i * 2 + 1, provisional: false, kind: 'reply', answers: null, opening: 'Reply ' + i + ', long enough to wrap across a phone screen.' + (i === 29 ? '\\n\\n| Column | Another column |\\n|---|---|\\n| a | b |' : ''), rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null } });
}
history.replaceState(null, '', location.search + (open ? '#w=1' : '#'));
// The tabs view's work item has more artifacts, with long titles, than any strip here fits.
const artifacts = view === 'tabs' ? Array.from({ length: 10 }, (_, i) => ({ path: 'chat/a' + i + '.md', owner: 'chat', kind: 'note', title: 'A long artifact title number ' + i, ext: 'md', type: 'markdown', updatedAt: now - (10 - i) * 1000 })) : [];
class FakeSource {
  constructor() {
    this.listeners = {};
    setTimeout(() => this.emit('hello', { key: 'pk', groups, scope, sessions: open ? [session] : [], items, more: false, status: null, artifacts, unread: 0 }), 20);
    if (listing) setInterval(() => this.emit('list', { groups }), 120);
  }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener() {}
  close() {}
  emit(type, data) { for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify({ type, ...data }) }); }
}
window.EventSource = FakeSource;
// On the list, the same list again every 120 ms, as a busy hub sends it, and line 2 as each frame starts, that is as the last frame painted it.
if (listing) {
  window.__line2 = [];
  const sample = () => {
    const lines = [...document.querySelectorAll('#list .row-line:not(.row-details)')];
    if (lines.length > 0) window.__line2.push(lines.map((line) => line.innerHTML + [...line.querySelectorAll('.pill')].map((pill) => pill.getBoundingClientRect().width).join()).join('|'));
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}
// History's tab reads a ticket with one entry per day over a week, so its pane scrolls.
const historyView = { key: 'gh 1', title: 'Fix it', url: '', facts: [{ label: 'Status', value: 'Running' }], links: [], reconstructed: false, recordedSince: null, sections: [{ key: 'w1', workItemId: 1, title: 'dev:build', status: 'Running', tone: 'accent', facts: [], prompt: null, entries: Array.from({ length: 40 }, (_, i) => ({ key: 'e' + i, at: now - (40 - i) * 3600000, category: 'session', icon: 'play', text: 'Entry ' + i, lines: [], detail: null, shortId: null, links: [], tone: null, reconstructed: false, refused: null, stateChange: false })) }] };
window.fetch = async (url) => ({ status: 200, ok: true, headers: new Headers(), json: async () => (String(url).endsWith('/personas') ? { personas } : String(url).endsWith('/page-history') ? { view: historyView, categories: [{ key: 'session', label: 'Sessions', icon: 'terminal' }] } : {}), text: async () => '' });
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
    band: document.getElementById('safe-top').getBoundingClientRect().height,
    // Line 2 of each shown row: a pill is whole inside its line and its box, or wholly outside them, left out; the ticket key always whole.
    line2: window.__line2 ? { samples: window.__line2.length, ways: new Set(window.__line2).size } : null,
    names: [...document.querySelectorAll('#list .row-line .playbook')].filter(shown).map((name) => { const box = name.getBoundingClientRect(); const edge = name.closest('.row-line').getBoundingClientRect(); const icon = name.previousElementSibling?.classList.contains('comment') ? name.previousElementSibling.getBoundingClientRect() : null; return { text: name.textContent, alone: icon !== null && icon.bottom <= box.top + 0.5, cut: name.scrollWidth > name.clientWidth + 0.5 || box.right > edge.right + 0.5 || box.bottom > edge.bottom + 0.5 }; }),
    pills: [...document.querySelectorAll('#list .row-line:not(.row-details)')].filter(shown).flatMap((line) => {
      const edge = line.getBoundingClientRect();

      return [...line.querySelectorAll('.pill')].map((pill) => {
        const box = pill.getBoundingClientRect();
        const holder = pill.parentElement.getBoundingClientRect();
        const right = Math.min(edge.right, holder.right);
        const bottom = Math.min(edge.bottom, holder.bottom);
        const inside = box.left >= edge.left - 0.5 && box.right <= right + 0.5 && box.top >= edge.top - 0.5 && box.bottom <= bottom + 0.5;
        const outside = box.left >= right - 0.5 || box.top >= bottom - 0.5;

        return { text: pill.textContent, ticket: pill.classList.contains('ticket'), state: inside ? 'whole' : outside ? 'out' : 'cut' };
      });
    }),
    // Each shown tab strip: a label shown cut narrower than about five characters, or not at all, and any tab past the strip's edges.
    strips: [...document.querySelectorAll('.tabs:not(.opening-tabs)')].filter(shown).map((strip) => {
      const edge = strip.getBoundingClientRect();
      const tabs = [...strip.children].filter(shown);

      return {
        tabs: tabs.length,
        more: strip.querySelector('.tab-more') !== null,
        cut: [...strip.querySelectorAll('.tab-label')].filter((label) => !shown(label) || label.getBoundingClientRect().width < Math.min(43.5, label.scrollWidth - 0.5)).map((label) => label.textContent),
        past: tabs.filter((tab) => { const box = tab.getBoundingClientRect(); return box.left < edge.left - 0.5 || box.right > edge.right + 0.5; }).map(name),
      };
    }),
    tops: { header: top('.header'), listHeader: top('.list-header'), settingsHead: top('.settings-head'), personaHead: top('.persona-head'), tabs: top('.tabs'), panel: top('#panel'), list: top('#list') },
  };
})()`;

/** What each view opens with, clicked in order. */
const OPEN = {
  history: ['[data-action=actions]', '[data-action=row-history]'],
  settings: ['[data-action=list-more]', '[data-action=list-settings]'],
  drawer: ['[data-action=drawer]'],
  sheet: ['[data-action=actions]', '[data-action=row-action][data-label=Delete]'],
  persona: ['[data-action=view-menu]', '[data-action=persona]'],
  // An artifact chosen from More, so the strip keeps it beside the tabs it always keeps.
  tabs: ['.tab-more-button', '.tab-menu [data-action=artifact]'],
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
    if (m.pills.filter((pill) => pill.ticket).length !== 3) out.push('line 2 shows ' + m.pills.filter((pill) => pill.ticket).length + ' ticket keys, not 3');
  }
  for (const name of m.names) {
    if (name.cut) out.push('line 2\'s playbook or host ' + name.text + ' is cut');
    if (name.alone) out.push('line 2\'s comment icon is alone on a line above ' + name.text);
  }
  for (const pill of m.pills) {
    if (pill.state === 'cut' || (pill.ticket && pill.state !== 'whole')) out.push('line 2\'s pill ' + pill.text + ' is ' + (pill.state === 'cut' ? 'cut' : 'left out'));
  }
  for (const strip of m.strips) {
    if (strip.cut.length > 0) out.push('a tab strip hides or cuts below five characters the labels ' + strip.cut.slice(0, 4).join(', '));
    if (strip.past.length > 0) out.push('a tab passes its strip: ' + strip.past.slice(0, 4).join(', '));
  }
  // The tabs view's strip has more tabs than fit, so More holds the rest.
  if (view === 'tabs' && !m.strips.some((strip) => strip.more)) out.push('no strip shows More for a work item with more tabs than fit');
  for (const [bar, top] of Object.entries(m.tops)) {
    // The dialogs, Settings and the persona dialog, outside the phone's layout sit inside the dimmed page's margin.
    if ((['header', 'listHeader'].includes(bar) || (['settingsHead', 'personaHead'].includes(bar) && size.phone)) && top !== null && top !== 0) out.push('the ' + bar + ' starts ' + top + ' px down');
  }
  // In portrait, under the status bar, WebKit finds the view's own solid top bar at the top edge, in the bars' colour, and paints the status bar in
  // it instead of blurring the page's top. An open sheet's dimmed backdrop is viewport-sized, which keeps the colour WebKit had. Landscape has no
  // status bar, so no colour is painted there, and its bars, inside the notch's insets, are under 90% of the width. The iPad is not checked for it.
  if (size.device === 'iphone' && size.orientation === 'portrait') {
    const edge = m.edge;
    const own = view === 'sheet' ? edge.kind === 'viewport' : edge.kind === 'bar' && /^[a-z]+\.(header|list-header|hist-bar|settings-head|persona-head)(\.|$)/.test(edge.name ?? '');

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
        await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, screenWidth: size.screen[0], screenHeight: size.screen[1], deviceScaleFactor: size.phone ? 3 : 2, mobile: true });
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] });
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
        const found = missing.length > 0 ? ['could not open the view: no ' + missing.join(', ')] : failures(view, size, m);

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
            await evaluate('(() => { const panel = document.getElementById("panel"); panel.scrollTop = panel.scrollHeight; })()');
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
