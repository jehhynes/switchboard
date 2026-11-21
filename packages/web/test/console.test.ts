import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSOLE_FONT_PX, CONSOLE_INPUT_CHARS, CONSOLE_MIN_FONT_PX, fittedFont, fittedSize, keptModes, mountConsole } from '../src/console.js';
import type { ConsoleOptions, ConsoleTerm, MountedConsole, TermOptions } from '../src/console.js';
import { startPage } from '../src/main.js';
import type { ConsoleModule } from '../src/main.js';
import { consoleNote, renderSideSwitch, renderTabs, newView } from '../src/render.js';
import { EMPTY } from '../src/model.js';
import type { SessionView } from '../src/types.js';
import { PAGE_ASSETS } from '../dist/index.js';

class FakeSource {
  static all: FakeSource[] = [];
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }

  static get last(): FakeSource {
    return FakeSource.all.at(-1)!;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }

  close(): void {
    this.closed = true;
  }
}

/** A terminal that records what the console does to it and lets a test press keys and answer queries. */
class FakeTerm implements ConsoleTerm {
  cols = 80;
  rows = 24;
  element: HTMLElement | undefined;
  textarea: HTMLTextAreaElement | undefined;
  options: { fontSize?: number };
  readonly written: string[] = [];
  readonly calls: string[] = [];
  selection = '';
  csi: ((params: Array<number | number[]>) => boolean) | null = null;
  keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  #data: Array<(data: string) => void> = [];

  constructor(readonly created: TermOptions) {
    this.options = { fontSize: created.fontSize };
  }

  open(parent: HTMLElement): void {
    this.element = document.createElement('div');
    this.textarea = document.createElement('textarea');
    this.element.append(this.textarea);
    parent.append(this.element);
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.calls.push(`resize ${cols}x${rows}`);
  }

  reset(): void {
    this.calls.push('reset');
  }

  focus(): void {
    this.textarea?.focus();
  }

  dispose(): void {
    this.calls.push('dispose');
  }

  hasSelection(): boolean {
    return this.selection !== '';
  }

  getSelection(): string {
    return this.selection;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#data.push(listener);
    return { dispose: () => (this.#data = []) };
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }

  readonly parser = {
    registerCsiHandler: (id: { prefix?: string; final: string }, callback: (params: Array<number | number[]>) => boolean) => {
      expect(id).toEqual({ prefix: '?', final: 'h' });
      this.csi = callback;
      return { dispose: () => (this.csi = null) };
    },
  };

  /** What xterm.js does on a key: its data, inside the key's event on the textarea. */
  press(data: string, type: 'keydown' | 'paste' = 'keydown'): void {
    const event = new Event(type, { bubbles: true });

    this.textarea!.addEventListener(type, () => this.emit(data), { once: true });
    this.textarea!.dispatchEvent(event);
  }

  /** Data xterm.js sends with no key: an answer to a query the program wrote, or a mouse report. */
  emit(data: string): void {
    for (const listener of this.#data) {
      listener(data);
    }
  }
}

const tick = (ms = 0): Promise<void> => new Promise((done) => setTimeout(done, ms));

function mounted(type: ConsoleOptions['type'] = async () => null) {
  const host = document.createElement('div');
  const terms: FakeTerm[] = [];
  const typed: Array<{ data: string; size: { cols: number; rows: number } }> = [];
  const copied: string[] = [];

  document.body.replaceChildren(host);
  FakeSource.all = [];

  const console = mountConsole(
    host,
    (options) => {
      const term = new FakeTerm(options);

      terms.push(term);
      return term;
    },
    {
      url: '/v1/conversation/console?window=pk&sessionId=s',
      EventSource: FakeSource as unknown as typeof EventSource,
      type: async (data, size) => {
        typed.push({ data, size });
        return type(data, size);
      },
      copy: (text) => copied.push(text),
    },
  );

  return { host, term: terms[0]!, typed, copied, console, source: () => FakeSource.last };
}

describe('the console', () => {
  it("draws the stream at the program's size, scaling the font to fit and never resizing the session while it watches", async () => {
    const { host, term, typed, source } = mounted();

    expect(source().url).toBe('/v1/conversation/console?window=pk&sessionId=s');
    expect(term.created).toMatchObject({ fontSize: CONSOLE_FONT_PX, scrollback: 10_000 });
    source().emit('size', { cols: 120, rows: 40 });
    source().emit('data', { data: 'hello' });
    source().emit('replayed', {});
    expect(term.calls).toEqual(['reset', 'resize 120x40']);
    expect(term.written).toEqual(['hello']);
    expect(host.querySelector('.console-size')!.textContent).toBe('120×40');
    expect(host.querySelector('.console-state')!.textContent).toBe('Watching. Click to type.');
    // Data that no key produced, such as the terminal's answer to a query, never reaches the session.
    term.emit('\u001b[?1;2c');
    term.press('x');
    await tick();
    expect(typed).toEqual([]);
    expect(host.classList.contains('typing')).toBe(false);
  });

  it('types the keys pressed while focused, giving the session its own size first, and stops at blur', async () => {
    const { host, term, typed } = mounted();

    term.textarea!.dispatchEvent(new Event('focus'));
    await tick();
    expect(host.classList.contains('typing')).toBe(true);
    expect(host.querySelector('.console-state')!.textContent).toContain('Typing');
    expect(typed).toEqual([{ data: '', size: expect.objectContaining({ cols: expect.any(Number), rows: expect.any(Number) }) }]);
    term.press('\u001b');
    await tick();
    term.press('\u0003');
    term.press('\r');
    await tick();
    term.press('pasted', 'paste');
    await tick();
    // In order, keys pressed while one is on its way going with the next.
    expect(typed.slice(1).map((one) => one.data).join('')).toBe('\u001b\u0003\rpasted');
    expect(typed.every((one) => one.size.cols >= 20 && one.size.rows >= 5)).toBe(true);
    // A mouse report, even inside a key's event, and an answer to a query are dropped.
    term.press('\u001b[<0;10;5M');
    term.emit('\u001b[2;1R');
    await tick();
    const sent = typed.length;

    expect(typed.map((one) => one.data).join('')).not.toContain('[<0;10;5M');
    term.textarea!.dispatchEvent(new Event('blur'));
    term.press('y');
    await tick();
    expect(typed).toHaveLength(sent);
    expect(host.classList.contains('typing')).toBe(false);
  });

  it("keeps the page's own shortcuts from a key the console types, and leaves them while it watches", () => {
    const { host, term } = mounted();
    const outside = vi.fn();

    document.body.addEventListener('keydown', outside);
    term.press('a');
    expect(outside).toHaveBeenCalledTimes(1);
    term.textarea!.dispatchEvent(new Event('focus'));
    term.press('\u001b');
    expect(outside).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('keydown', outside);
    host.remove();
  });

  it('says why a key was not typed, and clears it once one is', async () => {
    let refuse = true;
    const { host, term } = mounted(async () => (refuse ? 'The session has ended.' : null));

    term.textarea!.dispatchEvent(new Event('focus'));
    await tick();
    expect(host.querySelector('.console-note')!.textContent).toBe('Not typed: The session has ended.');
    refuse = false;
    term.press('a');
    await tick();
    expect(host.querySelector<HTMLElement>('.console-note')!.hidden).toBe(true);
  });

  it('sends a long paste in order in pieces the hub takes, and drops what follows a refused piece, saying how much', async () => {
    let calls = 0;
    const { host, term, typed } = mounted(async (data) => (data !== '' && ++calls === 2 ? 'The session has ended.' : null));
    const paste = 'a'.repeat(CONSOLE_INPUT_CHARS) + '\u{1F600}' + 'b'.repeat(CONSOLE_INPUT_CHARS);

    term.textarea!.dispatchEvent(new Event('focus'));
    term.press(paste, 'paste');
    await tick();
    await tick();

    const sent = typed.map((one) => one.data).filter((data) => data !== '');

    expect(sent[0]).toBe('a'.repeat(CONSOLE_INPUT_CHARS));
    expect(sent.every((data) => data.length <= CONSOLE_INPUT_CHARS)).toBe(true);
    expect(sent).toHaveLength(2);
    expect(host.querySelector('.console-note')!.textContent).toBe(`Not typed: The session has ended. ${paste.length - CONSOLE_INPUT_CHARS} characters were not typed.`);
  });

  it("turns the program's mouse and focus reports off and keeps its other modes", () => {
    const { term } = mounted();

    expect(term.csi!([1000, 1006])).toBe(true);
    expect(term.written).toEqual([]);
    expect(term.csi!([2004])).toBe(false);
    expect(term.csi!([1003, 2004, 1004, 25])).toBe(true);
    expect(term.written).toEqual(['\u001b[?2004;25h']);
    expect(keptModes([9, [1015], 1049])).toEqual([1049]);
  });

  it('copies a selection with Ctrl+C instead of sending it, and leaves Ctrl+V to the browser to paste', () => {
    const { term, copied } = mounted();
    const key = (key: string) => term.keyHandler!(new KeyboardEvent('keydown', { key, ctrlKey: true }));

    expect(key('c')).toBe(true);
    term.selection = 'picked';
    expect(key('c')).toBe(false);
    expect(copied).toEqual(['picked']);
    expect(key('v')).toBe(false);
    expect(term.keyHandler!(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
  });

  it('ends at an exit, an unavailable console, a close or a lost stream, never reconnecting by itself, and starts over on Reconnect', () => {
    const { host, term, source } = mounted();
    const reconnect = host.querySelector<HTMLButtonElement>('.console-reconnect')!;

    expect(reconnect.hidden).toBe(true);
    source().emit('exited', { exitCode: 0 });
    expect(source().closed).toBe(true);
    expect(term.written.at(-1)).toContain('The session exited with code 0.');
    expect(host.querySelector('.console-note')!.textContent).toBe('The session exited. Resume continues it.');
    expect(reconnect.hidden).toBe(false);
    reconnect.click();
    expect(FakeSource.all).toHaveLength(2);
    expect(term.calls.filter((call) => call === 'reset')).toHaveLength(2);
    source().emit('unavailable', { reason: 'The terminal holder is not running.' });
    expect(host.querySelector('.console-note')!.textContent).toBe('The terminal holder is not running.');
    // The error the closed stream raises afterwards keeps the reason.
    source().emit('error', {});
    expect(host.querySelector('.console-note')!.textContent).toBe('The terminal holder is not running.');
    reconnect.click();
    source().emit('error', {});
    expect(host.querySelector('.console-note')!.textContent).toBe('The console lost its connection to Switchboard.');
    expect(FakeSource.all).toHaveLength(3);
    reconnect.click();
    source().emit('closed', { error: 'The terminal holder closed the connection.' });
    expect(host.querySelector('.console-note')!.textContent).toBe('The terminal holder closed the connection.');
  });

  it('closes its stream and its terminal when disposed', () => {
    const { host, term, source, console } = mounted();

    console.dispose();
    expect(source().closed).toBe(true);
    expect(term.calls).toContain('dispose');
    expect(host.innerHTML).toBe('');
  });

  it('fits the columns by font size down to its minimum, and its own size to the pane', () => {
    expect(fittedFont(780, 100, 7.8)).toBe(CONSOLE_FONT_PX);
    expect(fittedFont(780, 120, 7.8)).toBe(10);
    expect(fittedFont(100, 300, 7.8)).toBe(CONSOLE_MIN_FONT_PX);
    expect(fittedFont(0, 80, 7.8)).toBe(CONSOLE_FONT_PX);
    expect(fittedSize(800, 400, { width: 8, height: 16 })).toEqual({ cols: 100, rows: 25 });
    expect(fittedSize(10, 10, { width: 8, height: 16 })).toEqual({ cols: 20, rows: 5 });
  });
});

const session = (patch: Partial<SessionView> = {}): SessionView => ({ id: 's', title: 'Task session s', state: 'idle', waitingFor: null, launch: 'L', current: true, conversation: 'full', reason: null, persona: null, ...patch });
const scope = { kind: 'page' as const, key: 'pk', folder: 'D:/w', title: 'Fix it', scopeGen: 3, conversations: [{ workItemId: 1, title: 'Fix it', primary: true, sessionId: 's', state: 'idle' as const, conversation: 'full' as const, unread: 0 }], workItemId: 1, cwd: 'D:/w', sessionId: 's' };

describe('the Console tab', () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, '', '#w=1');
    FakeSource.all = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a tab beside Status and Artifacts, and the third of the wide column', () => {
    const state = { ...EMPTY, connected: true, scope, session: session() };

    expect([...renderTabs(newView(), state).matchAll(/data-tab="(\w+)"/g)].map((match) => match[1])).toEqual(['conversation', 'status', 'artifacts', 'console']);
    expect([...renderSideSwitch('console', state).matchAll(/data-side="(\w+)"/g)].map((match) => match[1])).toEqual(['status', 'artifacts', 'console']);
    expect(renderSideSwitch('console', state)).toMatch(/aria-selected="true"[^>]*>Console/);
  });

  it('says why a session has no console without loading it', () => {
    expect(consoleNote(null)).toBe('No session has started yet.');
    expect(consoleNote(session({ provider: 'codex' }))).toContain("Codex's app-server");
    expect(consoleNote(session({ conversation: 'none' }))).toContain("does not run in Switchboard's terminal holder");
    expect(consoleNote(session({ provider: 'claude' }))).toBeNull();
  });

  it("loads the console only when shown, mounts it on the page's session, types through console-input, and ends it on another tab", async () => {
    const root = document.createElement('div');
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const mounts: Array<{ host: HTMLElement; options: ConsoleOptions; disposed: boolean }> = [];
    const loadConsole = vi.fn(
      async (): Promise<ConsoleModule | null> => ({
        mount: (host, options): MountedConsole => {
          const one = { host, options, disposed: false };

          mounts.push(one);
          return { dispose: () => (one.disposed = true) };
        },
      }),
    );
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      posts.push({ url, body: init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>) });
      return { status: 200, ok: true, json: async () => ({ done: true }), text: async () => '' } as unknown as Response;
    });

    document.body.replaceChildren(root);

    const page = startPage(root, { fetch: fetch as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, loadConsole });
    const source = FakeSource.all[0]!;

    source.emit('hello', { type: 'hello', key: 'pk', groups: [], scope, sessions: [session()], items: [], more: false, status: null, artifacts: [] });
    await tick();
    expect(loadConsole).not.toHaveBeenCalled();
    root.querySelector<HTMLElement>('[data-tab="console"]')!.click();
    await tick();
    expect(loadConsole).toHaveBeenCalledTimes(1);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.options.url).toBe('/v1/conversation/console?window=pk&sessionId=s');
    expect(root.querySelector('#panel')!.classList.contains('console-pane')).toBe(true);

    expect(await mounts[0]!.options.type('ls\r', { cols: 100, rows: 30 })).toBeNull();
    expect(posts.find((post) => post.url === '/v1/conversation/console-input')!.body).toMatchObject({ window: 'pk', scopeGen: 3, sessionId: 's', launch: 'L', data: 'ls\r', cols: 100, rows: 30 });

    // A redraw keeps the mounted console; another tab ends it.
    source.emit('session', { type: 'session', session: session({ state: 'running' }) });
    expect(mounts).toHaveLength(1);
    root.querySelector<HTMLElement>('[data-tab="status"]')!.click();
    expect(mounts[0]!.disposed).toBe(true);
    expect(root.querySelector('.console')).toBeNull();
    root.querySelector<HTMLElement>('[data-tab="console"]')!.click();
    await tick();
    expect(mounts).toHaveLength(2);
    expect(loadConsole).toHaveBeenCalledTimes(1);
    page.close();
    expect(mounts[1]!.disposed).toBe(true);
  });

  it("shows a Codex session's note in place of a console, and loads nothing", async () => {
    const root = document.createElement('div');
    const loadConsole = vi.fn(async () => null);

    document.body.replaceChildren(root);

    const page = startPage(root, { fetch: vi.fn() as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, loadConsole });

    FakeSource.all[0]!.emit('hello', { type: 'hello', key: 'pk', groups: [], scope, sessions: [session({ provider: 'codex' })], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-tab="console"]')!.click();
    await tick();
    expect(root.querySelector('#panel')!.textContent).toContain("Codex's app-server");
    expect(loadConsole).not.toHaveBeenCalled();
    page.close();
  });
});

describe('the console assets', () => {
  it("carries xterm.js only in the console's own script, with its styles, so the page loads without it", () => {
    expect(PAGE_ASSETS['console.js']!.body).toContain('xterm-helper-textarea');
    expect(PAGE_ASSETS['page.js']!.body).not.toContain('xterm-helper-textarea');
    expect(PAGE_ASSETS['xterm.css']!.body).toContain('.xterm');
  });
});
