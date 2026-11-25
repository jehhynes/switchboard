// Checks Collapse details' fade in a real headless Chrome or Edge (testing.md § Test layers): a folded reply's details show at least two whole
// lines of text before the fade, details that would hide less than 1.5 lines show in full with no fade, opening a folded reply moves none
// of the lines it showed, and the newest reply shows whole until a newer one comes, when it folds with none of the lines it keeps moving.
// Desktop and phone, light and dark.
// Run `npm run build` first; the browser is SWITCHBOARD_CHROME, else Chrome or Edge where they install. --shots <dir> saves each size's
// conversation folded and opened, the long reply alone, and the newest reply before and after a newer one comes; --linear draws the fade's
// box with a linear mask instead, to compare; --report prints the measurements.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAGE_ASSETS } from './dist/index.js';

const SIZES = [
  { name: 'desktop', width: 1280, height: 900, scale: 1, mobile: false },
  { name: 'phone', width: 393, height: 793, scale: 2, mobile: true },
];
const report = process.argv.includes('--report');
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
// --linear draws the same fade's box with a linear mask, to compare the curve against in the shots, which it names with -linear.
const linear = process.argv.includes('--linear');

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

const PRIMARY = 'The rate-limit fix is now on top of the layout and Approve fixes, so all three are ready to install together, with one hub restart. Shall I install them now?';
/** Each reply's details after the primary response, and what the check expects of it; the last is the newest reply, shown whole. */
const REPLIES = [
  { id: 'short', details: 'Nothing else changed.', folded: false },
  { id: 'two-lines', details: 'The hub restarts once the sessions are quiet, which takes a minute or two on a busy afternoon, and the page reconnects on its own after it.', folded: false },
  { id: 'label-list', details: '**The three:**\n\n- the rate-limit fix, which waits out a 429 before the next poll\n- the layout fix, which keeps every column in place while a work item opens\n- the Approve fix, which sends the approval once\n\nEach has its tests, and the three pass together.', folded: true },
  { id: 'heading', details: '## What changed\n\nThe poller now reads the Retry-After header and waits that long before it asks again, instead of retrying at once and tripping the limit a second time.\n\n## Why\n\nGitHub counts every request against the hour, so a burst of retries used the whole hour in a few minutes.', folded: true },
  { id: 'paragraphs', details: 'The poller now reads the Retry-After header and waits that long before it asks again, instead of retrying at once and tripping the limit a second time. GitHub counts every request against the hour, so a burst of retries used the whole hour in a few minutes.\n\nThe layout fix keeps every column in place while a work item opens, and the Approve fix sends the approval once, even after a double click.\n\nEach has its tests, and the three pass together.\n\nThe hub restarts once the sessions are quiet, which takes a minute or two on a busy afternoon, and the page reconnects on its own after it.', folded: true },
  { id: 'newest', details: '**The three:**\n\n- the rate-limit fix, which waits out a 429 before the next poll\n- the layout fix, which keeps every column in place while a work item opens\n- the Approve fix, which sends the approval once\n\nThe hub restarts once the sessions are quiet, which takes a minute or two on a busy afternoon, and the page reconnects on its own after it.', folded: false, newest: true },
];

// The page with a fake stream and fetch in place of the hub's: one work item whose conversation is the replies above, with Collapse details on.
const fake = '<script>' + String.raw`
localStorage.removeItem('switchboard.route');
${linear ? "document.head.append(Object.assign(document.createElement('style'), { textContent: '.reply-fade { --sb-fade-curve: linear-gradient(to bottom, #000 var(--sb-fade-from), transparent calc(var(--sb-fade-from) + 3lh)) !important; }' }));" : ''}
localStorage.removeItem('switchboard.briefReplies');
sessionStorage.removeItem('switchboard.scroll');
const now = Date.now();
const replies = ${JSON.stringify(REPLIES)};
const primary = ${JSON.stringify(PRIMARY)};
const row = { workItemId: 1, ticketId: 1, title: 'Fix it', priority: null, time: null, ticket: 'gh 1', sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], band: null, voice: null, history: null };
const groups = [{ key: 'progress', title: 'In progress', glyph: '\u{ea70}', empty: null, rows: [row] }];
const scope = { kind: 'page', key: 'k', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle', conversation: 'full', unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };
const session = { id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null, canPin: true };
const items = replies.flatMap((reply, i) => [
  { type: 'message', id: 'm-' + reply.id, sessionId: 's', workItemId: 1, at: now - 100000 + i * 2000, ord: i * 2, provisional: false, withdrawn: false, origin: 'typed', text: 'Where are we?', delivery: 'sent', error: null },
  { type: 'reply', id: reply.id, sessionId: 's', at: now - 99000 + i * 2000, ord: i * 2 + 1, provisional: false, kind: 'reply', answers: null, opening: primary + '\n\n' + reply.details, rewrittenBy: null, withdrawn: false, unread: false, speak: primary, tone: null, spoken: { state: 'none', atMs: null, saidChars: null } },
]);
history.replaceState(null, '', location.search + '#w=1');
class FakeSource {
  constructor() { this.listeners = {}; window.fakeSource = this; setTimeout(() => this.emit('hello', { key: 'pk', groups, scope, sessions: [session], items, more: false, state: null, artifacts: [], unread: 0, settings: { briefReplies: true } }), 20); }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  removeEventListener() {}
  close() {}
  emit(type, data) { for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify({ type, ...data }) }); }
}
window.EventSource = FakeSource;
window.fetch = async () => ({ status: 200, ok: true, headers: new Headers(), json: async () => ({}), text: async () => '' });
` + '</script>';

/**
 * Each reply's lines of text, placed in the conversation's content (so scrolling moves none), as its primary response and its details draw them:
 * a line is the text boxes that share a row. With the reply folded, the fade's box and how far down it its text stays solid.
 */
const measure = String.raw`(() => {
  const panel = document.getElementById('panel');
  const origin = panel.getBoundingClientRect();
  const place = (box) => ({ top: box.top - origin.top + panel.scrollTop, bottom: box.bottom - origin.top + panel.scrollTop, left: box.left - origin.left });
  const lines = (nodes) => {
    const boxes = [];
    for (const node of nodes) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (text.textContent.trim() === '') continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        for (const box of range.getClientRects()) if (box.width > 0 && box.height > 0) boxes.push(place(box));
      }
    }
    boxes.sort((a, b) => a.top - b.top || a.left - b.left);
    const rows = [];
    for (const box of boxes) {
      const last = rows.at(-1);
      if (last && (box.top + box.bottom) / 2 < last.bottom) { last.bottom = Math.max(last.bottom, box.bottom); last.top = Math.min(last.top, box.top); last.left = Math.min(last.left, box.left); }
      else rows.push({ ...box });
    }
    return rows.map((row) => ({ top: Math.round(row.top * 100) / 100, bottom: Math.round(row.bottom * 100) / 100, left: Math.round(row.left * 100) / 100 }));
  };
  return [...document.querySelectorAll('#panel li.reply')].map((li) => {
    const fade = li.querySelector('.reply-fade');
    const box = fade ? place(fade.getBoundingClientRect()) : null;
    const style = fade ? getComputedStyle(fade) : null;
    // How far down the fade its text is wholly opaque: the page's --sb-fade-solid, else 10% of its height, where the first fade's mask started.
    const solid = fade ? (parseFloat(style.getPropertyValue('--sb-fade-solid')) || 0.1 * (box.bottom - box.top)) : null;
    return {
      id: li.dataset.id,
      folded: li.classList.contains('folded'),
      // Text the reply draws besides its own, such as a Show more link: none.
      label: [...li.querySelectorAll('.reply-fade > :not(.reply-fade-text), .show-more')].map((one) => one.textContent.trim()).join(' '),
      cursor: getComputedStyle(li.querySelector('.body')).cursor,
      fade: box === null ? null : { top: box.top, bottom: box.bottom, solid },
      primary: lines(li.querySelectorAll('.reply-primary')),
      details: lines(li.querySelectorAll('.reply-details')),
      bottom: place(li.getBoundingClientRect()).bottom,
    };
  });
})()`;

const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://x').pathname;
  const asked = path === '/page/' ? 'index.html' : path.replace(/^\/page\//, '');
  const name = Object.keys(PAGE_ASSETS).find((one) => PAGE_ASSETS[one].hashed === asked) ?? asked;
  const asset = PAGE_ASSETS[name];

  if (asset === undefined) {
    response.writeHead(404).end();
    return;
  }

  const body = name === 'index.html' ? asset.body.replace(/<script src="page-[0-9a-f]+\.js">/, (tag) => fake + tag) : asset.base64 ? Buffer.from(asset.body, 'base64') : asset.body;

  response.writeHead(200, { 'content-type': name === 'index.html' ? 'text/html; charset=utf-8' : asset.mime }).end(body);
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));

const base = 'http://127.0.0.1:' + server.address().port + '/page/';
const dir = mkdtempSync(join(tmpdir(), 'sb-fade-check-'));
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

  const send = async (method, params = {}) => {
    const reply = await new Promise((done) => { replies.set(++id, done); socket.send(JSON.stringify({ id, method, params })); });

    if (reply.error) throw new Error(method + ': ' + reply.error.message);
    return reply.result;
  };
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const shot = async (name, clip) => {
    if (shots === null) return;
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, name + (linear ? '-linear' : '') + '.png'), Buffer.from((await send('Page.captureScreenshot', clip === undefined ? { format: 'png' } : { format: 'png', clip: { ...clip, scale: 1 } })).data, 'base64'));
  };
  const results = [];

  for (const scheme of ['dark', 'light']) {
    for (const size of SIZES) {
      const name = scheme + '-' + size.name;
      const found = [];

      await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: size.mobile });
      await send('Emulation.setTouchEmulationEnabled', { enabled: size.mobile, maxTouchPoints: size.mobile ? 5 : 1 });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'hover', value: size.mobile ? 'none' : 'hover' }, { name: 'pointer', value: size.mobile ? 'coarse' : 'fine' }] });
      await send('Page.navigate', { url: base + '?fade' });
      await evaluate('new Promise((done) => { const wait = () => (document.querySelectorAll("#panel li.reply").length >= ' + REPLIES.length + ' ? setTimeout(done, 300) : setTimeout(wait, 50)); wait(); })');
      // The conversation's top, so the screenshot shows the folded replies from the first.
      await evaluate('document.getElementById("panel").scrollTop = 0');
      await wait(100);
      const before = await evaluate(measure);

      await shot(name + '-folded');
      // The reply with a bold label and a list, as the operator's report showed it, at the top.
      await evaluate('document.querySelector(\'#panel li.reply[data-id="label-list"]\').scrollIntoView({ block: "start" })');
      await wait(100);
      await shot(name + '-folded-list');
      // The long reply alone, from its question to a little past its fade, for comparing fades.
      await evaluate('document.querySelector(\'#panel li.reply[data-id="paragraphs"]\').scrollIntoView({ block: "center" })');
      await wait(100);
      await shot(name + '-reply', await evaluate('(() => { const li = document.querySelector(\'#panel li.reply[data-id="paragraphs"]\'); const ask = li.previousElementSibling.getBoundingClientRect(); const box = li.getBoundingClientRect(); const panel = document.getElementById("panel").getBoundingClientRect(); return { x: panel.left, y: ask.top - 8, width: panel.width, height: box.bottom - ask.top + 24 }; })()'));
      // Opens each folded reply as a click on its fade does, from the last up, so opening one moves none of those still to open, and measures it
      // just before and just after.
      const opened = new Map();

      for (const reply of [...before].reverse().filter((one) => one.folded)) {
        const just = (await evaluate(measure)).find((one) => one.id === reply.id);

        await evaluate('document.querySelector(' + JSON.stringify('#panel li.reply[data-id="' + reply.id + '"] .reply-fade') + ').click()');
        await wait(100);
        opened.set(reply.id, { before: just, after: (await evaluate(measure)).find((one) => one.id === reply.id) });
      }
      await evaluate('document.getElementById("panel").scrollTop = 0');
      await wait(200);
      const after = await evaluate(measure);

      await shot(name + '-opened');
      await evaluate('document.querySelector(\'#panel li.reply[data-id="label-list"]\').scrollIntoView({ block: "start" })');
      await wait(100);
      await shot(name + '-opened-list');

      for (const expected of REPLIES) {
        const folded = opened.get(expected.id)?.before ?? before.find((one) => one.id === expected.id);
        const open = opened.get(expected.id)?.after ?? after.find((one) => one.id === expected.id);

        if (folded === undefined || open === undefined) {
          found.push(expected.id + ' was not drawn');
          continue;
        }
        if (open.folded) found.push(expected.id + ' stayed folded after a click on its fade');
        if (folded.folded !== expected.folded) found.push(expected.id + (expected.folded ? ' was not folded' : ' was folded, with only ' + folded.details.length + ' lines of details'));
        if (!expected.folded) {
          if (folded.fade !== null) found.push(expected.id + ' has a fade');
          if (folded.cursor === 'pointer') found.push(expected.id + ' takes a click to open');
          continue;
        }
        if (folded.fade === null) {
          found.push(expected.id + ' is folded with no fade');
          continue;
        }
        if (folded.label !== '') found.push(expected.id + "'s fade shows the text " + JSON.stringify(folded.label));
        // At least two whole lines of the details before the fade starts.
        const solid = folded.details.filter((line) => line.top >= folded.fade.top - 0.5 && line.bottom <= folded.fade.top + folded.fade.solid + 0.5);

        if (solid.length < 2) found.push(expected.id + ' shows ' + solid.length + ' solid lines of details before the fade, not 2');
        // Opening it moves no line it showed, the primary response's or the details'.
        const shown = [...folded.primary.map((line, index) => ['primary', index, line, open.primary[index]]), ...folded.details.filter((line) => line.top < folded.fade.bottom).map((line, index) => ['details', index, line, open.details[index]])];

        for (const [part, index, line, now] of shown) {
          if (now === undefined || Math.abs(now.top - line.top) > 0.5 || Math.abs(now.left - line.left) > 0.5) found.push(expected.id + "'s " + part + ' line ' + (index + 1) + ' moved from ' + line.left + ',' + line.top + ' to ' + (now === undefined ? 'nowhere' : now.left + ',' + now.top));
        }
      }

      // A newer reply folds the newest, which showed whole: none of the lines it keeps moves, and at least two whole lines of its details show
      // before the fade.
      const whole = after.find((one) => one.id === 'newest');

      await evaluate('document.querySelector(\'#panel li.reply[data-id="newest"]\').scrollIntoView({ block: "start" })');
      await wait(100);
      await shot(name + '-newest-whole');
      await evaluate('window.fakeSource.emit("reply", { reply: { type: "reply", id: "newer", sessionId: "s", at: Date.now(), ord: 100, provisional: false, kind: "reply", answers: null, opening: "Installed.", rewrittenBy: null, withdrawn: false, unread: false, speak: "Installed.", tone: null, spoken: { state: "none", atMs: null, saidChars: null } } })');
      await wait(200);
      const newer = await evaluate(measure);
      const folded = newer.find((one) => one.id === 'newest');

      await evaluate('document.querySelector(\'#panel li.reply[data-id="newest"]\').scrollIntoView({ block: "start" })');
      await wait(100);
      await shot(name + '-newest-folded');
      if (whole === undefined || folded === undefined || !newer.some((one) => one.id === 'newer')) {
        found.push('the newest reply or the newer one was not drawn');
      } else if (whole.folded || whole.fade !== null) {
        found.push('the newest reply was folded before a newer one came');
      } else if (!folded.folded || folded.fade === null) {
        found.push('the newest reply stayed whole after a newer one came');
      } else {
        const solid = folded.details.filter((line) => line.top >= folded.fade.top - 0.5 && line.bottom <= folded.fade.top + folded.fade.solid + 0.5);

        if (solid.length < 2) found.push('the folded newest reply shows ' + solid.length + ' solid lines of details before the fade, not 2');
        const kept = [...whole.primary.map((line, index) => ['primary', index, line, folded.primary[index]]), ...folded.details.filter((line) => line.top < folded.fade.bottom).map((line, index) => ['details', index, whole.details[index], line])];

        for (const [part, index, line, now] of kept) {
          if (line === undefined || now === undefined || Math.abs(now.top - line.top) > 0.5 || Math.abs(now.left - line.left) > 0.5) found.push("the newest reply's " + part + ' line ' + (index + 1) + ' moved as it folded');
        }
      }

      results.push({ name, before, after });
      console.log((found.length === 0 ? 'ok   ' : 'FAIL ') + name);
      found.forEach((one) => console.log('     ' + one));
      failed += found.length === 0 ? 0 : 1;
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
