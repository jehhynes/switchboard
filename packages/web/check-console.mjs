// Checks the console's layout in a real headless Chrome or Edge (testing.md § Web page console check): xterm.js's own scrollbar is its only
// scroller, and its screen stays inside the pane, for sessions larger than the pane, drawn there at once or after the pane narrows.
// Run `npm run build` first; the browser is SWITCHBOARD_CHROME, else Chrome or Edge where they install.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PAGE_ASSETS } from './dist/index.js';

/** The operator's installed page: a narrow right column of a tall window, at 125 % display scale. */
const SCALE = 1.25;
const SCENARIOS = [
  { name: 'fits at 13 px', pane: [680, 1190], size: [80, 24] },
  { name: 'wider than the pane', pane: [680, 1190], size: [160, 60] },
  { name: 'full-screen terminal', pane: [680, 1190], size: [250, 70] },
  { name: 'taller than the pane', pane: [680, 1190], size: [120, 200] },
  { name: 'narrowed from a wide pane', pane: [680, 1190], from: [1900, 1190], size: [200, 120] },
  { name: 'shortened from a tall pane', pane: [680, 600], from: [680, 1190], size: [100, 90] },
];

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

const harness = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="theme.css"><link rel="stylesheet" href="page.css"><link rel="stylesheet" href="xterm.css">
<style>html, body { margin: 0; } .scroll.console-pane { box-sizing: border-box; }</style></head><body><script src="console.js"></script><script>
const scenarios = ${JSON.stringify(SCENARIOS)};
const frames = (n) => new Promise((done) => { const step = () => (n-- <= 0 ? setTimeout(done, 50) : requestAnimationFrame(step)); step(); });
const box = (node) => node.getBoundingClientRect();
async function check({ name, pane: [width, height], from, size: [cols, rows] }) {
  const pane = document.createElement('div');
  const host = document.createElement('div');
  const sized = ([w, h]) => { pane.style.width = w + 'px'; pane.style.height = h + 'px'; };
  pane.className = 'scroll console-pane';
  host.className = 'console';
  sized(from ?? [width, height]);
  pane.append(host);
  document.body.prepend(pane);
  let source;
  class Source { constructor() { source = this; this.listeners = {}; } addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); } close() {} }
  const emit = (type, data) => (source.listeners[type] ?? []).forEach((listener) => listener({ data: JSON.stringify(data) }));
  const mounted = switchboardConsole.mount(host, { url: 'stream', EventSource: Source, type: async () => null });
  emit('size', { cols, rows });
  let text = '';
  for (let line = 0; line < rows * 3; line++) text += ('line ' + line + ' ' + 'abcdefghij'.repeat(cols)).slice(0, cols - 3) + 'END\\r\\n';
  emit('data', { data: text });
  emit('replayed', {});
  await frames(4);
  if (from) { sized([width, height]); await frames(6); }
  const screen = host.querySelector('.console-screen');
  const style = getComputedStyle(screen);
  const px = (value) => parseFloat(value) || 0;
  const outer = box(screen);
  const inner = { right: outer.right - px(style.paddingRight), bottom: outer.bottom - px(style.paddingBottom) };
  const drawn = box(host.querySelector('.xterm-screen'));
  const viewport = box(host.querySelector('.xterm-viewport'));
  const font = parseFloat(getComputedStyle(host.querySelector('.xterm-rows')).fontSize);
  const scrollers = [...host.querySelectorAll('*')].filter((node) => {
    const css = getComputedStyle(node);
    return /auto|scroll/.test(css.overflowX + css.overflowY) && !node.closest('.xterm');
  }).map((node) => node.className);
  const failures = [];
  if (screen.scrollWidth > screen.clientWidth || screen.scrollHeight > screen.clientHeight) failures.push('the pane holds more than it shows: ' + screen.scrollWidth + 'x' + screen.scrollHeight + ' in ' + screen.clientWidth + 'x' + screen.clientHeight);
  if (scrollers.length > 0) failures.push('scrollers besides xterm.js: ' + scrollers.join(', '));
  if (drawn.right > inner.right - 14 + 0.5) failures.push('the screen reaches ' + drawn.right + ', past ' + (inner.right - 14) + ', under xterm.js scrollbar or the pane edge');
  if (drawn.bottom > inner.bottom + 0.5) failures.push('the screen reaches ' + drawn.bottom + ', below the pane at ' + inner.bottom);
  if (Math.abs(viewport.height - drawn.height) > 1) failures.push('xterm.js scrolls ' + viewport.height + ' px for a screen of ' + drawn.height);
  const track = host.querySelector('.xterm .scrollbar.vertical');
  if (track !== null && box(track).bottom > drawn.bottom + 1) failures.push('xterm.js scrollbar reaches ' + box(track).bottom + ', below its screen at ' + drawn.bottom);
  mounted.dispose();
  pane.remove();
  return { name, font, failures };
}
window.checked = (async () => {
  const results = [];
  for (const scenario of scenarios) results.push(await check(scenario));
  return results;
})().catch((error) => [{ name: 'harness', failures: [String(error)] }]);
</script></body></html>`;

/** Opens `url` in the headless browser and answers the harness's `checked` through the DevTools protocol. */
async function inBrowser(url) {
  const profile = join(dir, 'profile');
  const browser = spawn(browsers[0], ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--force-device-scale-factor=${SCALE}`, '--window-size=2000,1400', url], { stdio: 'ignore' });
  let gone = false;
  const exited = new Promise((done) => browser.once('exit', (code) => ((gone = true), done(code))));

  try {
    const deadline = Date.now() + 60_000;
    /** `promise`, or a failure once the browser exits or the 60 s deadline passes. */
    const bounded = (promise, what) => {
      let timer;
      const limit = new Promise((_, fail) => {
        timer = setTimeout(() => fail(new Error(`The browser took over 60 s ${what}`)), Math.max(0, deadline - Date.now()));
        exited.then((code) => fail(new Error(`The browser exited with ${code} while ${what}`)));
      });

      return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
    };
    let port = null;

    while (port === null) {
      if (gone) throw new Error(`${browsers[0]} exited before it opened a DevTools port`);
      if (Date.now() > deadline) throw new Error(`${browsers[0]} opened no DevTools port`);
      try {
        port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }

    let target;

    while (target === undefined) {
      if (Date.now() > deadline) throw new Error('The browser opened no page');
      // DevTools can refuse a connection for a moment after it writes its port.
      target = (await bounded(fetch(`http://127.0.0.1:${port}/json`).then((answer) => answer.json()), 'listing pages').catch(() => [])).find((one) => one.type === 'page' && one.url.endsWith('check.html'));
      if (target === undefined) await new Promise((done) => setTimeout(done, 100));
    }

    const socket = new WebSocket(target.webSocketDebuggerUrl);

    await bounded(new Promise((done, fail) => { socket.onopen = done; socket.onerror = () => fail(new Error('DevTools refused the connection')); }), 'connecting to DevTools');

    const replies = new Map();

    socket.onmessage = (message) => {
      const data = JSON.parse(message.data);

      replies.get(data.id)?.(data);
    };

    /** Sends one DevTools command and answers its reply. */
    const send = (id, method, params) => {
      const reply = new Promise((done) => replies.set(id, done));

      socket.send(JSON.stringify({ id, method, params }));
      return bounded(reply, 'running the check');
    };
    let reply;

    // The page may still be loading, which destroys the context an evaluation started in; the harness sets `checked` once its scripts have run.
    for (let id = 1; reply === undefined || reply.error?.message?.includes('context was destroyed'); id++) {
      if (Date.now() > deadline) throw new Error('The page never ran the check');
      reply = await send(id, 'Runtime.evaluate', { expression: 'new Promise((done) => { const wait = () => (window.checked ? window.checked.then(done) : setTimeout(wait, 50)); wait(); })', awaitPromise: true, returnByValue: true });
    }

    socket.close();
    if (reply.result?.result?.value === undefined) throw new Error(`The check failed: ${JSON.stringify(reply.result ?? reply.error)}`);
    return reply.result.result.value;
  } finally {
    browser.kill();
    await exited;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'sb-console-check-'));

try {
  for (const name of ['theme.css', 'page.css', 'xterm.css', 'console.js']) {
    writeFileSync(join(dir, name), PAGE_ASSETS[name].body);
  }

  writeFileSync(join(dir, 'check.html'), harness);

  const results = await inBrowser(pathToFileURL(join(dir, 'check.html')).href);
  let failed = 0;

  for (const { name, font, failures } of results) {
    console.log(`${failures.length === 0 ? 'ok  ' : 'FAIL'} ${name}${font === undefined ? '' : ` (${font} px)`}`);
    failures.forEach((failure) => console.log(`     ${failure}`));
    failed += failures.length === 0 ? 0 : 1;
  }

  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
