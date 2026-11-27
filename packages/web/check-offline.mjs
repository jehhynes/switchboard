// Checks the page's offline and error handling against a fake hub in a real headless Chrome or Edge (testing.md § Required checks): a stopped
// hub behind `tailscale serve` (502), one that hangs, a dropped stream for 1 s and for 10 s, the latter also on a desktop, where the list dims too, a half-open stream, a failed and a slow open, a
// send whose answer is lost, a restart onto the same and another build, with Update ready clear of the conversation's last item, a failed page.js, the route, scroll and draft after a reload, and
// opening a work item on a wide page, a narrower one and a phone with no column moving.
// Each scenario prints ok or FAIL with why; --shots <dir> saves a screenshot of each; --assets <dist/index.js> runs against another build of the
// page, as the one before a change. Run `npm run build` first; the browser is SWITCHBOARD_CHROME, else Chrome or Edge where they install.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const shots = arg('--shots');
const prefix = arg('--prefix') ?? '';
const only = arg('--only');
const { PAGE_ASSETS } = await import(pathToFileURL(resolve(arg('--assets') ?? './dist/index.js')).href);
const browsers = [process.env.SWITCHBOARD_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter((path) => path !== undefined && existsSync(path));

if (browsers.length === 0) {
  console.error('No Chrome or Edge found; set SWITCHBOARD_CHROME to one.');
  process.exit(2);
}

// ---- The fake hub ----
const now = Date.now();
const row = (id, title) => ({ workItemId: id, ticketId: id, title, priority: null, time: null, ticket: 'gh ' + id, sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], band: null, voice: null, history: null });
const titles = ['Fix the login redirect', 'Add the export button', 'Tidy the settings page'];
const groups = [{ key: 'progress', title: 'In progress', glyph: '\u{ea70}', empty: null, rows: titles.map((title, index) => row(index + 1, title)) }];
const scopeOf = (id) => ({ kind: 'page', key: 'k', folder: 'D:/w', title: titles[id - 1], scopeGen: id, conversations: [{ workItemId: id, title: titles[id - 1], primary: true, sessionId: 's' + id, state: 'idle', conversation: 'full', unread: 0 }], workItemId: id, cwd: 'D:/w', sessionId: 's' + id });
const session = (id) => ({ id: 's' + id, title: 'Task session', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null });
const items = (id) => Array.from({ length: 30 }, (_, i) => [
  { type: 'message', id: 'm' + id + '-' + i, sessionId: 's' + id, workItemId: id, at: now - 100_000 + i * 2_000, ord: i * 2, provisional: false, withdrawn: false, origin: 'typed', text: 'Work item ' + id + ': message ' + i, delivery: 'sent', error: null },
  { type: 'reply', id: 'r' + id + '-' + i, sessionId: 's' + id, at: now - 99_000 + i * 2_000, ord: i * 2 + 1, provisional: false, kind: 'reply', answers: null, opening: 'Reply ' + i + ' about ' + titles[id - 1] + '.', rewrittenBy: null, withdrawn: false, unread: false, speak: null, tone: null, spoken: { state: 'none', atMs: null, saidChars: null } },
]).flat();
const fresh = () => ({ down: null, delay: 0, selectFail: false, dropSendOnce: false, failJs: false, silent: false, build: 'b1' });
let mode = fresh();
const streams = new Set();
// Requests a hanging hub never answered, closed once the scenario ends, since each holds one of the browser's few connections to the host.
const hung = [];
const sends = [];
let keys = 0;
let streamsOpened = 0;
const write = (res, type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
const hello = (res, id) => write(res, 'hello', { key: res.key, groups, scope: id === null ? null : scopeOf(id), sessions: id === null ? [] : [session(id)], items: id === null ? [] : items(id), more: false, state: null, artifacts: [], unread: 0 });
const assetOf = (name) => PAGE_ASSETS[name] ?? Object.values(PAGE_ASSETS).find((one) => one.hashed === name);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/__drop') {
    for (const stream of streams) stream.destroy();
    streams.clear();
    res.end('{}');
    return;
  }

  if (mode.down === 502) return void res.writeHead(502).end();
  if (mode.down === 'hang') return void hung.push(req.socket);
  if (mode.down === 'refuse') return void req.socket.destroy();
  if (mode.delay > 0) await new Promise((done) => setTimeout(done, mode.delay));

  if (url.pathname === '/page/ping') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ build: mode.build, signedIn: true }));

  if (url.pathname.startsWith('/page/')) {
    const name = url.pathname.slice('/page/'.length) || 'index.html';
    const asset = assetOf(name);

    if (asset === undefined) return void res.writeHead(404).end();
    if (mode.failJs && /^page-[0-9a-f]+\.js$|^page\.js$/.test(name)) return void res.writeHead(502).end();
    res.writeHead(200, { 'Content-Type': asset.mime, 'Cache-Control': 'no-cache' });
    res.end(asset.base64 ? Buffer.from(asset.body, 'base64') : name === 'index.html' ? asset.body.replaceAll('{{build}}', mode.build) : asset.body);
    return;
  }

  if (url.pathname === '/v1/conversation/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.key = 'pk' + ++keys;
    streamsOpened++;
    streams.add(res);
    req.on('close', () => streams.delete(res));
    hello(res, null);
    return;
  }

  if (req.method === 'POST') {
    let text = '';

    for await (const chunk of req) text += chunk;

    const body = JSON.parse(text || '{}');
    const name = url.pathname.split('/').pop();

    if (name === 'select') {
      if (mode.selectFail) return void res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'The work item could not be opened: its worktree is missing.' }));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');

      const stream = [...streams].find((one) => one.key === body.window);

      if (stream !== undefined) {
        write(stream, 'scope', { scope: scopeOf(body.workItemId) });
        hello(stream, body.workItemId);
      }

      return;
    }

    if (name === 'send') {
      sends.push(body.opId);

      // The hub takes the message, and the answer is lost on the way back.
      if (mode.dropSendOnce) {
        mode.dropSendOnce = false;
        req.socket.destroy();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: { id: 'x-' + body.opId } }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
});
// The hub's tick, unless a half-open stream is wanted.
setInterval(() => {
  if (!mode.silent) for (const stream of streams) stream.write('event: tick\ndata: {}\n\n');
}, 15_000).unref();

await new Promise((done) => server.listen(0, '127.0.0.1', done));

const base = 'http://127.0.0.1:' + server.address().port + '/page/';
const dir = mkdtempSync(join(tmpdir(), 'sb-offline-check-'));
const browser = spawn(browsers[0], ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + join(dir, 'profile'), 'about:blank'], { stdio: 'ignore' });
const PHONE = { width: 393, height: 793, deviceScaleFactor: 2, mobile: true };
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
    target = (await fetch('http://127.0.0.1:' + port + '/json').then((answer) => answer.json()).catch(() => [])).find((one) => one.type === 'page');
    if (target === undefined) await wait(100);
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const replies = new Map();
  let id = 0;

  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = () => fail(new Error('DevTools refused the connection')); });
  socket.onmessage = (message) => { const data = JSON.parse(message.data); replies.get(data.id)?.(data); };

  // A page that never loads, as an older build's against a hanging hub, never answers an evaluate: each command gives up after 20 s.
  const send = async (method, params = {}) => {
    const reply = await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(method + ' did not answer in 20 s')), 20_000);

      replies.set(++id, (data) => { clearTimeout(timer); done(data); });
      socket.send(JSON.stringify({ id, method, params }));
    });

    if (reply.error) throw new Error(method + ': ' + reply.error.message);
    return reply.result;
  };
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  /** Waits up to `ms` for `expression` to be true in the page; answers whether it was. */
  const until = async (expression, ms) => {
    const end = Date.now() + ms;

    while (Date.now() < end) {
      if (await evaluate('(() => { try { return !!(' + expression + '); } catch { return false; } })()').catch(() => false)) return true;
      await wait(100);
    }

    return false;
  };
  const shot = async (name) => {
    if (shots === null) return;
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, prefix + name + '.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  };
  const setMode = (patch) => {
    Object.assign(mode, patch);

    if (mode.down !== 'hang') hung.splice(0).forEach((one) => one.destroy());
  };
  const drop = () => fetch(base.replace('/page/', '/__drop'));
  const scheme = (value) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  const forget = () => send('Storage.clearDataForOrigin', { origin: base.replace('/page/', ''), storageTypes: 'service_workers,cache_storage,local_storage,session_storage' });
  /** Opens the page fresh on work item `w`, or the list, and waits for its conversation; marks the window so a reload shows. */
  const open = async (w) => {
    await send('Page.navigate', { url: base + (w === null ? '' : '#w=' + w) });
    const shown = await until(w === null ? 'document.querySelector("#list .row")' : 'document.querySelectorAll("#panel .timeline > li").length > 10', 8_000);

    await evaluate('window.__marker = 1');
    return shown;
  };
  const marked = () => evaluate('window.__marker === 1');
  const banner = () => evaluate('document.querySelector(".conn-banner") !== null');

  /** Each column's left edge and width, the heights of the conversation's head, the column's strip and the composer, and the conversation's top. */
  const layoutNow = () =>
    evaluate(`(() => {
      const shown = (selector) => { const one = document.querySelector(selector); return one !== null && getComputedStyle(one).display !== 'none' ? one.getBoundingClientRect() : null; };
      const box = (selector) => { const rect = shown(selector); return rect === null ? null : [Math.round(rect.left), Math.round(rect.width)]; };
      const tall = (selector) => { const rect = shown(selector); return rect === null ? null : Math.round(rect.height); };
      return { list: box('#root > .side'), conversation: box('#root > .main'), column: box('#detail'), head: tall('#head'), columnHead: tall('#detail .detail-head'), panelTop: Math.round(document.querySelector('#panel').getBoundingClientRect().top), composer: tall('#composer') };
    })()`);
  /** A scenario that opens work item 3 from work item 1 at `metrics`, slowly or refused (`fails`), and checks that nothing moved at each step. */
  const openLayout = (metrics, name, fails = false) => async () => {
    const found = [];

    await send('Emulation.setDeviceMetricsOverride', metrics);
    await send('Emulation.setTouchEmulationEnabled', { enabled: metrics.mobile, maxTouchPoints: metrics.mobile ? 5 : 1 });

    try {
      if (!(await open(1))) found.push('work item 1 did not open: ' + (await evaluate('location.hash + " " + document.body.innerText.slice(0, 200)')));
      const steps = { selected: await layoutNow() };

      await shot('open-layout-' + name + '-1-selected');
      if (metrics.mobile) await evaluate('document.querySelector(".header .back-toggle").click()');
      setMode(fails ? { selectFail: true, delay: 1_500 } : { delay: 3_000 });
      await evaluate('document.querySelector("[data-work-item=\\"3\\"]").click()');
      await wait(300);
      if (!(await evaluate('document.querySelector("#panel .opening-note") !== null'))) found.push('no Opening… placeholder');
      steps.opening = await layoutNow();
      await shot('open-layout-' + name + '-2-opening');

      if (fails) {
        if (!(await until('document.querySelector("#panel .opening-failed")', 6_000))) found.push('no error in the work item\'s place');
        steps.failed = await layoutNow();
        await shot('open-layout-' + name + '-3-failed');
      } else {
        if (!(await until('document.body.innerText.includes("Work item 3: message")', 8_000))) found.push('work item 3 did not open');
        await wait(300);
        steps.loaded = await layoutNow();
        await shot('open-layout-' + name + '-3-loaded');
      }

      if (!metrics.mobile && steps.selected.conversation === null) found.push('no conversation column');
      if (metrics.width >= 1_400 && steps.selected.column === null) found.push('no Status column on a wide page');

      for (const [step, layout] of Object.entries(steps)) {
        for (const [part, value] of Object.entries(layout)) {
          if (JSON.stringify(value) !== JSON.stringify(steps.selected[part])) found.push(step + ' moved ' + part + ': ' + JSON.stringify(steps.selected[part]) + ' to ' + JSON.stringify(value));
        }
      }
    } finally {
      setMode({ delay: 0, selectFail: false });
      await send('Emulation.setDeviceMetricsOverride', PHONE);
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }

    return found;
  };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', PHONE);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await scheme('dark');

  const scenarios = {
    // A stopped hub behind tailscale serve answers 502 with an empty body: the kept page shows its own screen, not the browser's error page.
    'start-502': async () => {
      const found = [];

      await open(null);
      await until('navigator.serviceWorker && navigator.serviceWorker.controller', 8_000);
      await wait(1_000);
      setMode({ down: 502 });
      await send('Page.navigate', { url: base });
      if (!(await until('document.querySelector(".conn-screen h2")?.textContent === "Switchboard is not reachable"', 10_000))) found.push("no Switchboard is not reachable screen: " + (await evaluate('document.body?.innerText?.slice(0, 120)')));
      await shot('start-502');
      setMode({ down: null });
      return found;
    },
    // A sleeping PC: the hub never answers. The kept page paints within the race's 3 s, in the theme, then says it cannot reach the hub.
    'start-hang': async () => {
      const found = [];

      await open(null);
      await until('navigator.serviceWorker && navigator.serviceWorker.controller', 8_000);
      setMode({ down: 'hang' });
      const started = Date.now();

      await send('Page.navigate', { url: base });
      if (!(await until('document.getElementById("boot") || document.querySelector("#root .side")', 6_000))) found.push('nothing painted');
      const painted = Date.now() - started;

      if (painted > 4_500) found.push('the kept page took ' + painted + ' ms');
      if (!(await until('document.querySelector(".conn-screen")', 12_000))) found.push("no Switchboard is not reachable screen");
      await shot('start-hang');
      setMode({ down: null });
      return found;
    },
    // A failed page.js, with no worker to keep it: the boot screen says so, in the system's scheme.
    'boot-failed': async () => {
      const found = [];

      await forget();
      await scheme('light');
      setMode({ failJs: true });
      await send('Page.navigate', { url: base });
      if (!(await until('document.getElementById("boot")?.className === "failed"', 10_000))) found.push('the boot screen did not say the page failed: ' + (await evaluate('document.body?.innerText?.slice(0, 120)')));
      const background = await evaluate('getComputedStyle(document.documentElement).backgroundColor');

      if (background !== 'rgb(250, 250, 253)') found.push('the boot screen is not light: ' + background);
      await shot('boot-failed-light');
      setMode({ failJs: false });
      await scheme('dark');
      return found;
    },
    // A 1 s drop: nothing the operator sees changes, and the page does not reload.
    'blip-1s': async () => {
      const found = [];

      await open(1);
      setMode({ down: 'refuse' });
      await drop();
      let seen = false;

      for (let t = 0; t < 10; t++) {
        seen ||= await banner();
        await wait(100);
      }

      setMode({ down: null });
      for (let t = 0; t < 40; t++) {
        seen ||= await banner();
        // Nothing the operator sees changes meanwhile: the conversation stays.
        if (!(await evaluate('document.querySelectorAll("#panel .timeline > li").length > 10'))) found.push('the conversation went at ' + (1 + t / 10) + ' s');
        await wait(100);
      }

      await until('document.querySelector(".conn-dot.live")', 8_000);
      if (seen) found.push('the offline banner showed for a 1 s drop');
      if (!(await marked())) found.push('the page reloaded');
      if (await evaluate('document.querySelector("#composer textarea").disabled')) found.push('the composer is off: ' + (await evaluate('location.hash + " " + document.querySelector("#composer textarea").placeholder + " " + document.querySelector("#panel").innerText.slice(0, 200)')));
      if (!(await evaluate('document.querySelectorAll("#panel .timeline > li").length > 10'))) found.push('the conversation is gone');
      await shot('blip-1s');
      return found;
    },
    // A 10 s drop, as a hub restart behind tailscale serve: the banner after 4 s, then back in place with no reload.
    'lost-10s': async () => {
      const found = [];

      await open(1);
      setMode({ down: 502 });
      await drop();
      await wait(2_500);
      if (await banner()) found.push('the banner showed before the grace period');
      if (!(await until('document.querySelector(".conn-banner")', 4_000))) found.push('no offline banner after 4 s');
      if (!(await evaluate('document.querySelector("#composer textarea").disabled'))) found.push('the composer is on while offline');
      await shot('stream-lost');
      await wait(3_000);
      setMode({ down: null });
      if (!(await until('document.querySelector(".conn-banner") === null && document.querySelectorAll("#panel .timeline > li").length > 10', 20_000))) found.push('the banner stayed after the hub came back');
      if (!(await marked())) found.push('the page reloaded');
      await shot('stream-back');
      return found;
    },
    // A 10 s drop on a desktop, where the list is a column beside the conversation: offline dims the list as well as the conversation, so
    // neither looks live.
    'lost-wide': async () => {
      const found = [];

      await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
      await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });

      try {
        await open(1);
        setMode({ down: 502 });
        await drop();
        if (!(await until('document.querySelector(".conn-banner")', 8_000))) found.push('no offline banner after 4 s');
        for (const selector of ['#list', '#panel']) {
          const opacity = await evaluate(`Number(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity)`);

          if (!(opacity < 1)) found.push(selector + ' is not dimmed while offline: opacity ' + opacity);
        }
        await shot('stream-lost-wide');
        setMode({ down: null });
        if (!(await until('document.querySelector(".conn-banner") === null', 20_000))) found.push('the banner stayed after the hub came back');
      } finally {
        setMode({ down: null });
        await send('Emulation.setDeviceMetricsOverride', PHONE);
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      }

      return found;
    },
    // A failed open on a phone: the error for that work item, never the conversation shown before.
    'open-fails': async () => {
      const found = [];

      await open(1);
      await evaluate('document.querySelector(".header .back-toggle").click()');
      setMode({ selectFail: true });
      await evaluate('document.querySelector("[data-work-item=\\"2\\"]").click()');
      if (!(await until('document.querySelector("#panel .opening-failed")', 6_000))) found.push('no error in the work item\'s place');
      const title = await evaluate('document.querySelector("#head .opening-title")?.textContent');

      if (title !== titles[1]) found.push('the head shows ' + title);
      if (await evaluate('document.body.innerText.includes("Work item 1: message")')) found.push("work item 1's conversation shows");
      await shot('open-fails');
      setMode({ selectFail: false });
      return found;
    },
    // A slow open: the target's title and a placeholder at once.
    'open-slow': async () => {
      const found = [];

      await open(1);
      await evaluate('document.querySelector(".header .back-toggle").click()');
      setMode({ delay: 4_000 });
      await evaluate('document.querySelector("[data-work-item=\\"3\\"]").click()');
      await wait(500);
      if (!(await evaluate('document.querySelector("#panel .opening-note") !== null'))) found.push('no Opening… placeholder');
      if (await evaluate('document.body.innerText.includes("Work item 1: message")')) found.push("work item 1's conversation shows");
      await shot('open-slow');
      setMode({ delay: 0 });
      await until('document.body.innerText.includes("Work item 3: message")', 8_000);
      return found;
    },
    // Opening another work item keeps every column's place and width, its strip's height and the composer's place, from the one selected through
    // the Opening… placeholder to the one loaded, or to why it could not be opened: on a wide page with the column, a narrower one with the tabs,
    // and a phone.
    'open-layout-wide': openLayout({ width: 1600, height: 900, deviceScaleFactor: 1, mobile: false }, 'wide'),
    'open-layout-wide-fails': openLayout({ width: 1600, height: 900, deviceScaleFactor: 1, mobile: false }, 'wide-fails', true),
    'open-layout-narrow': openLayout({ width: 1100, height: 800, deviceScaleFactor: 1, mobile: false }, 'narrow'),
    'open-layout-narrow-fails': openLayout({ width: 1100, height: 800, deviceScaleFactor: 1, mobile: false }, 'narrow-fails', true),
    'open-layout-phone': openLayout(PHONE, 'phone'),
    // The hub takes a message and its answer is lost: the retry has the same opId, so it is typed once.
    'send-lost': async () => {
      const found = [];

      await open(1);
      sends.length = 0;
      setMode({ dropSendOnce: true });
      await evaluate('(() => { const box = document.querySelector("#composer textarea"); box.value = "Ship it"; box.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#composer button.send").click(); })()');
      await until('document.querySelector("#composer textarea").value === ""', 10_000);
      if (sends.length < 2) found.push('the send was not tried again: ' + sends.length);
      if (new Set(sends).size !== 1) found.push('the tries had different opIds: ' + JSON.stringify(sends));
      if (await evaluate('document.querySelector("#composer textarea").value') !== '') found.push('the message stayed in the box');
      await shot('send-lost');
      return found;
    },
    // A restart onto the same build reconnects in place; another build offers Reload and never reloads by itself.
    'restart': async () => {
      const found = [];

      await open(1);
      setMode({ down: 'refuse' });
      await drop();
      await wait(2_000);
      setMode({ down: null });
      await until('document.querySelector(".conn-dot.live")', 10_000);
      await wait(1_000);
      if (!(await marked())) found.push('a restart onto the same build reloaded the page');
      if (await evaluate('document.querySelector(".conn-update") !== null')) found.push('Update ready for the same build');
      setMode({ build: 'b2' });
      await drop();
      if (!(await until('document.querySelector(".conn-update")', 10_000))) found.push('no Update ready for another build');
      await wait(2_000);
      if (!(await marked())) found.push('another build reloaded the page by itself');
      // Update ready leaves room at the conversation's end: its last item lies above the card.
      const clear = () => evaluate('(() => { const p = document.querySelector("#panel"); p.scrollTop = p.scrollHeight; return document.querySelector("#panel .timeline > li:last-child").getBoundingClientRect().bottom <= document.querySelector(".conn-update").getBoundingClientRect().top; })()');

      if (!(await clear())) found.push('Update ready covers the conversation\'s last item');
      // A narrower screen wraps the card onto more lines: the room follows.
      await send('Emulation.setDeviceMetricsOverride', { ...PHONE, width: 320 });
      await wait(300);
      if (!(await clear())) found.push('Update ready covers the conversation\'s last item after a resize');
      await send('Emulation.setDeviceMetricsOverride', PHONE);
      await shot('update-ready');
      // Update ready lies over every dialog, so Reload still takes a press while Settings is open.
      for (const [name, dialog, steps] of [['Settings', '.settings[role=dialog]', ['[data-action=list-more]', '[data-action=list-settings]']]]) {
        for (const step of steps) {
          await evaluate('document.querySelector(' + JSON.stringify(step) + ')?.click()');
          await wait(200);
        }

        if (!(await until('document.querySelector(' + JSON.stringify(dialog) + ')', 5_000))) {
          found.push(name + ' did not open');
          continue;
        }

        const top = await evaluate(`(() => {
          const reload = document.querySelector('.conn-update .conn-reload');
          if (reload === null) return 'no Reload';
          const box = reload.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return reload.contains(hit) ? null : hit === null ? 'nothing' : hit.tagName.toLowerCase() + '.' + [...hit.classList].join('.');
        })()`);

        if (top !== null) found.push('Update ready is under ' + name + ': ' + top + ' is topmost at Reload');
        await shot('update-ready-settings');
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        if (!(await until('document.querySelector("[role=dialog][aria-modal=true]") === null', 5_000))) found.push(name + ' did not close on Escape');
      }

      setMode({ build: 'b1' });
      return found;
    },
    // The route and the draft after a reload, and an installed app started again at /page/ with no hash.
    'restore': async () => {
      const found = [];

      await open(2);
      await evaluate('document.querySelector("#head [data-tab=\\"history\\"]")?.click()');
      await evaluate('(() => { const box = document.querySelector("#composer textarea"); box.value = "Half a thought"; box.dispatchEvent(new Event("input", { bubbles: true })); })()');
      await wait(300);
      const hash = await evaluate('location.hash');

      if (hash !== '#w=2&t=history') found.push('the address names ' + hash);
      // Where the column folds into the conversation's strip, every opening shows the Chat tab (PRD R109), a reload's too, and the
      // address follows it.
      await send('Page.reload');
      if (!(await until('document.querySelector("#head .tab.selected")?.dataset.tab === "conversation" && location.hash === "#w=2"', 8_000))) found.push('a reload did not come back to work item 2 on the Chat tab: ' + (await evaluate('location.hash')));
      await send('Page.navigate', { url: base });
      if (!(await until('document.querySelector("#head .tab.selected")?.dataset.tab === "conversation" && location.hash === "#w=2"', 8_000))) found.push('a start with no hash did not come back to work item 2: ' + (await evaluate('location.hash')));
      await evaluate('document.querySelector("#head [data-tab=\\"conversation\\"]")?.click()');
      if ((await evaluate('document.querySelector("#composer textarea").value')) !== 'Half a thought') found.push('the draft was lost');
      await shot('restored');
      return found;
    },
    // Slow, lossy cellular: 400 ms each way and a 3 s flap of no network; a message still arrives once and nothing reloads.
    'throttled': async () => {
      const found = [];

      await open(1);
      await send('Network.enable');
      await send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 20_000 });
      sends.length = 0;
      await evaluate('(() => { const box = document.querySelector("#composer textarea"); box.value = "Over cellular"; box.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#composer button.send").click(); })()');
      await until('document.querySelector("#composer textarea").value === ""', 15_000);
      await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await wait(3_000);
      await send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 20_000 });
      await wait(3_000);
      if (new Set(sends).size !== 1) found.push('sent ' + new Set(sends).size + ' messages');
      if (await banner()) found.push('the offline banner shows after a 3 s flap');
      if (!(await marked())) found.push('the page reloaded');
      await shot('throttled');
      await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      return found;
    },
    // A half-open stream: no error, no tick. The watchdog opens a new stream after 40 s.
    'half-open': async () => {
      const found = [];

      await open(1);
      const before = streamsOpened;

      setMode({ silent: true });
      if (!(await until('false', 1))) void 0;
      await wait(47_000);
      setMode({ silent: false });
      if (streamsOpened <= before) found.push('no new stream after 47 s of silence');
      if (!(await marked())) found.push('the page reloaded');
      return found;
    },
  };

  for (const [name, run] of Object.entries(scenarios)) {
    if (only !== null && !only.split(',').includes(name)) continue;
    mode = fresh();
    hung.splice(0).forEach((one) => one.destroy());
    await send('Page.navigate', { url: 'about:blank' });
    // A page left for about:blank can leave its stream open here; six of them take every connection the browser allows to the host.
    for (const stream of streams) stream.destroy();
    streams.clear();
    await forget();

    let found;

    try {
      found = await run();
    } catch (error) {
      found = [String(error)];
    }

    console.log((found.length === 0 ? 'ok   ' : 'FAIL ') + name);
    found.forEach((one) => console.log('     ' + one));
    failed += found.length === 0 ? 0 : 1;
  }

  socket.close();
} finally {
  browser.kill();
  await exited;
  server.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

process.exit(failed === 0 ? 0 : 1);
