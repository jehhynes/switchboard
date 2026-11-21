import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSOLE_FONT_PX, CONSOLE_INPUT_CHARS, CONSOLE_MIN_FONT_PX, CONSOLE_THEME, fittedFont, fittedSize, keptModes, LIGHT_SCHEME, mountConsole, XTERM_SCROLLBAR_PX } from '../src/console.js';
import type { ConsoleOptions, ConsoleTerm, MountedConsole, TermOptions } from '../src/console.js';
import { startPage } from '../src/main.js';
import type { ConsoleModule } from '../src/main.js';
import { consoleNote, newView } from '../src/render.js';
import { renderSideSwitch, renderTabs } from '../src/header.js';
import { html } from './html.js';
import { EMPTY } from '../src/model.js';
import type { SessionView } from '@switchboard/protocol';
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
  options: { fontSize?: number; theme?: Record<string, string> };
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

describe("the console's colours", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("draws in Dark Modern's terminal colours whatever the system's scheme, on a background that matches its own", () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === LIGHT_SCHEME, addEventListener: () => {}, removeEventListener: () => {} }));

    const { term } = mounted();
    const css = PAGE_ASSETS['page.css']!.body;

    expect(term.created.theme).toEqual(CONSOLE_THEME);
    expect(term.created.theme).toMatchObject({ background: '#181818', foreground: '#cccccc', white: '#e5e5e5' });
    expect(css).toMatch(new RegExp(`\\.console \\{[^}]*color-scheme: dark;[^}]*background: ${CONSOLE_THEME.background!};`, 'i'));
    // xterm.js's scrollbar takes the page's: the console's slider colours, and the page's 8 px width, which the fit leaves out.
    for (const [option, variable] of [['scrollbarSliderBackground', 'background'], ['scrollbarSliderHoverBackground', 'hoverBackground'], ['scrollbarSliderActiveBackground', 'activeBackground']] as const) {
      expect(css).toMatch(new RegExp(`\\.console \\{[^}]*--vscode-scrollbarSlider-${variable}: ${CONSOLE_THEME[option]!.replace(/[()]/g, '\\$&')};`));
    }

    expect(css).toMatch(/::-webkit-scrollbar \{ width: 8px;/);
    expect(css).toContain(`.console .xterm .xterm-scrollable-element > .scrollbar.vertical { width: ${XTERM_SCROLLBAR_PX}px !important;`);
    // The light scheme's block never gives the console another background.
    expect(/@media \(prefers-color-scheme: light\) \{\s*:root \{([^}]*)\}/.exec(css)?.[1]).not.toMatch(/console/);
  });
});

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
    // No bar and no instruction text: the screen names itself, and only the focus border shows that it types.
    expect([...host.children].map((child) => child.className)).toEqual(['console-screen', 'console-foot']);
    expect(host.querySelector<HTMLElement>('.console-foot')!.hidden).toBe(true);
    expect(host.querySelector('.console-screen')!.getAttribute('aria-label')).toBe('Session console');
    expect(host.querySelector('.console-screen')!.getAttribute('title')).toBe('Session console');
    expect(host.textContent).not.toMatch(/120|Click|Watching/);
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

  it('fits the columns and rows by font size down to its minimum, and its own size to the pane', () => {
    const cell = { width: 7.8, height: 16 };

    expect(fittedFont({ width: 780, height: 640 }, { cols: 100, rows: 40 }, cell)).toBe(CONSOLE_FONT_PX);
    expect(fittedFont({ width: 780, height: 640 }, { cols: 120, rows: 40 }, cell)).toBe(10);
    // The rows bind when the screen is taller than the pane, though its columns fit.
    expect(fittedFont({ width: 780, height: 400 }, { cols: 80, rows: 40 }, cell)).toBe(8);
    expect(fittedFont({ width: 780, height: 480 }, { cols: 80, rows: 40 }, cell)).toBe(9);
    expect(fittedFont({ width: 100, height: 640 }, { cols: 300, rows: 40 }, cell)).toBe(CONSOLE_MIN_FONT_PX);
    expect(fittedFont({ width: 0, height: 0 }, { cols: 80, rows: 24 }, cell)).toBe(CONSOLE_FONT_PX);
    expect(fittedSize(800, 400, { width: 8, height: 16 })).toEqual({ cols: 100, rows: 25 });
    expect(fittedSize(10, 10, { width: 8, height: 16 })).toEqual({ cols: 20, rows: 5 });
  });
});

it("has xterm.js fit its scrollbar and input textarea to the screen after each fit, as a font change alone does not (mechanics M107)", async () => {
  const { term, source, console } = mounted();
  const core = { _viewport: { queueSync: vi.fn() }, _syncTextArea: vi.fn() };

  Object.assign(term, { _core: core });
  source().emit('size', { cols: 200, rows: 60 });
  expect(core._viewport.queueSync).toHaveBeenCalledTimes(1);
  await new Promise((done) => requestAnimationFrame(done));
  expect(core._syncTextArea).toHaveBeenCalledTimes(1);
  // A textarea placed after the console is gone would touch a disposed terminal.
  source().emit('size', { cols: 100, rows: 30 });
  console.dispose();
  await new Promise((done) => requestAnimationFrame(done));
  expect(core._syncTextArea).toHaveBeenCalledTimes(1);
});

/**
 * A browser's layout of the console's screen, enough to show a resize loop: its padding, overflow and gutter come from page.css; were the
 * screen to scroll, the side scrollbar would show while the drawn screen is taller than the pane, the bottom one while it is wider; xterm.js's
 * own scrollbar covers the right edge of its screen; and the observer reports each change of the
 * screen's content box, as a browser's does, including the changes the console's own redraws cause.
 */
function laidOut(box: { width: number; height: number }) {
  const style = document.createElement('style');

  style.textContent = PAGE_ASSETS['page.css']!.body;
  document.head.replaceChildren(style);

  let report: (() => void) | null = null;
  const scaled: Array<() => void> = [];
  const display = { scale: 1 };

  vi.stubGlobal('matchMedia', (query: string) =>
    query.startsWith('(resolution:')
      ? { addEventListener: (_type: string, listener: () => void) => scaled.push(listener), removeEventListener: (_type: string, listener: () => void) => scaled.splice(scaled.indexOf(listener), 1) }
      : { matches: false, addEventListener: () => {}, removeEventListener: () => {} },
  );

  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        report = callback;
      }

      observe(): void {}

      disconnect(): void {
        report = null;
      }
    },
  );

  const refusals = { left: 0 };
  const type: ConsoleOptions['type'] = async (_data, size) => {
    if (refusals.left > 0) {
      refusals.left--;
      return 'The session is busy.';
    }

    queueMicrotask(() => source().emit('size', size));
    return null;
  };
  const { host, term, typed, source, console } = mounted(type);

  // As the page mounts it, so page.css styles it.
  host.classList.add('console');
  const screen = host.querySelector<HTMLElement>('.console-screen')!;
  const drawn = document.createElement('div');
  const SCROLLBAR = 15;
  // A cell does not scale exactly with the font, as hinted fonts do.
  const cellWidth = (): number => Math.floor((term.options.fontSize ?? CONSOLE_FONT_PX) * 0.55 * 2 * display.scale) / 2;
  const cellHeight = (): number => Math.ceil((term.options.fontSize ?? CONSOLE_FONT_PX) * 1.2);
  const height = (): number => box.height;
  const layout = () => {
    const css = getComputedStyle(screen);
    const padX = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight);
    const padY = parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
    const width = term.cols * cellWidth();
    const drawnHeight = term.rows * cellHeight();
    const scrolls = /auto|scroll/.test(css.overflowX + css.overflowY);
    const side = scrolls && drawnHeight > height() - padY;
    const clientWidth = box.width - (side || (scrolls && css.scrollbarGutter === 'stable') ? SCROLLBAR : 0);
    const bottom = scrolls && width > clientWidth - padX;

    return { clientWidth, clientHeight: height() - (bottom ? SCROLLBAR : 0), padX, padY, width, height: drawnHeight, side };
  };

  drawn.className = 'xterm-screen';
  term.element!.append(drawn);
  drawn.getBoundingClientRect = () => ({ width: term.cols * cellWidth(), height: term.rows * cellHeight() }) as DOMRect;
  Object.defineProperty(screen, 'clientWidth', { get: () => layout().clientWidth });
  Object.defineProperty(screen, 'clientHeight', { get: () => layout().clientHeight });
  Object.defineProperty(screen, 'offsetHeight', { get: () => height() });

  let reported = '';
  let reports = 0;
  /** Delivers the observer's reports until the content box stops changing, at most 50. */
  const settle = (): void => {
    for (let index = 0; index < 50; index++) {
      const now = layout();
      const content = `${now.clientWidth - now.padX}x${now.clientHeight - now.padY}`;

      if (content === reported) {
        return;
      }

      reported = content;
      reports++;
      report?.();
    }
  };

  /** Moves the page to a display that draws cells `by` times as wide, as xterm.js does, without changing the pane. */
  const rescale = (by: number): void => {
    display.scale = by;
    [...scaled].forEach((listener) => listener());
  };

  return { host, term, typed, source, console, settle, refusals, rescale, listeners: () => scaled.length, reports: () => reports, fits: () => layout().width <= layout().clientWidth - layout().padX - XTERM_SCROLLBAR_PX,
    /** Whether the drawn screen is no taller than the pane. */
    fitsHeight: () => layout().height <= layout().clientHeight - layout().padY,
    /** The pixels the pane can grow by before it holds another column. */
    spare: () => Math.max(0, cellWidth() - 1 - ((layout().clientWidth - layout().padX - XTERM_SCROLLBAR_PX) % cellWidth())),
  };
}

describe('the console in a laid-out pane', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.head.replaceChildren();
  });

  /** Runs the page for `ms`, delivering the observer's reports and the session's answers as they come. */
  const run = async (settle: () => void, ms: number): Promise<void> => {
    for (let elapsed = 0; elapsed < ms; elapsed += 20) {
      settle();
      await vi.advanceTimersByTimeAsync(20);
    }

    settle();
  };

  it('settles on one font while it watches, whatever the side scrollbar its redraws show or hide', async () => {
    for (let width = 600; width <= 760; width += 5) {
      for (const height of [420, 460, 500, 540]) {
        const pane = laidOut({ width, height });
        const fonts: number[] = [];
        const options = pane.term.options;

        pane.term.options = new Proxy(options, { set: (target, key, value) => (key === 'fontSize' && fonts.push(value as number), Reflect.set(target, key, value)) });
        pane.source().emit('size', { cols: 120, rows: 40 });
        await run(pane.settle, 600);

        const settled = fonts.length;

        await run(pane.settle, 600);
        expect({ width, height, fonts: fonts.length }).toEqual({ width, height, fonts: settled });
        // The screen fits whenever a font above the minimum fits it, though a smaller font's cells do not scale exactly.
        expect(pane.term.options.fontSize === CONSOLE_MIN_FONT_PX || (pane.fits() && pane.fitsHeight())).toBe(true);
        expect(pane.reports()).toBeLessThan(5);
        expect(pane.typed).toEqual([]);
        pane.console.dispose();
        vi.unstubAllGlobals();
      }
    }
  }, 30_000);

  it("gives the session its size once while it types, and again only when the pane's cells change", async () => {
    for (let width = 600; width <= 760; width += 11) {
      for (const height of [400, 450, 490, 540]) {
        const box = { width, height };
        const pane = laidOut(box);

        pane.source().emit('size', { cols: 120, rows: 40 });
        await run(pane.settle, 500);
        pane.term.textarea!.dispatchEvent(new Event('focus'));
        await run(pane.settle, 3000);
        expect({ width, height, sent: pane.typed.length }).toEqual({ width, height, sent: 1 });
        expect(pane.term.options.fontSize).toBe(CONSOLE_FONT_PX);
        expect(pane.fits()).toBe(true);

        // A pane that grows short of another column keeps the session's size; one that grows by more gives it the new one, once.
        box.width += pane.spare();
        await run(pane.settle, 1000);
        expect(pane.typed).toHaveLength(1);
        box.width += 40;
        await run(pane.settle, 1000);
        expect(pane.typed).toHaveLength(2);
        expect(pane.typed[1]!.size.cols).toBeGreaterThan(pane.typed[0]!.size.cols);

        // A refused size is not taken as given: the pane's next change sends it again, though it holds the same cells.
        pane.refusals.left = 1;
        box.width += 40;
        await run(pane.settle, 1000);
        expect(pane.typed).toHaveLength(3);
        box.width += Math.max(1, pane.spare());
        await run(pane.settle, 1000);
        expect(pane.typed).toHaveLength(4);
        expect(pane.typed[3]!.size).toEqual(pane.typed[2]!.size);
        pane.console.dispose();
        vi.unstubAllGlobals();
      }
    }
  }, 30_000);

it('scales a screen taller than the pane down until its rows fit, so only xterm.js scrolls', async () => {
    const pane = laidOut({ width: 760, height: 420 });

    // 80 columns fit at 13 px; 30 rows of 16 px do not.
    pane.source().emit('size', { cols: 80, rows: 30 });
    await run(pane.settle, 500);
    expect(pane.term.options.fontSize).toBeLessThan(CONSOLE_FONT_PX);
    expect(pane.term.options.fontSize).toBeGreaterThan(CONSOLE_MIN_FONT_PX);
    expect(pane.fitsHeight()).toBe(true);
    expect(pane.fits()).toBe(true);
    // A screen that fits again at 13 px goes back to it.
    pane.source().emit('size', { cols: 80, rows: 20 });
    await run(pane.settle, 500);
    expect(pane.term.options.fontSize).toBe(CONSOLE_FONT_PX);
    expect(pane.typed).toEqual([]);
    pane.console.dispose();
  });

  it('resizes the session once on focus, with no bar above the screen to change its height', async () => {
    // Each resize makes the program redraw, which can repeat lines in its scrollback (mechanics M104).
    const pane = laidOut({ width: 340, height: 500 });

    // The box page.css gives the console and its parts, which typing must leave as it is: only the outline, which takes no room, changes.
    const boxes = (): string[] =>
      [pane.host, ...pane.host.children].map((node) => {
        const css = getComputedStyle(node);

        return [css.display, css.borderTopWidth, css.borderBottomWidth, css.paddingTop, css.paddingBottom, css.marginTop, css.marginBottom, css.height].join(' ');
      });

    pane.source().emit('size', { cols: 120, rows: 40 });
    await run(pane.settle, 500);
    const watching = boxes();

    pane.term.textarea!.dispatchEvent(new Event('focus'));
    await run(pane.settle, 2000);
    expect(pane.host.classList.contains('typing')).toBe(true);
    expect(boxes()).toEqual(watching);
    expect(pane.typed).toHaveLength(1);
    expect(pane.fitsHeight()).toBe(true);
    pane.console.dispose();
  });

  it('refits to a display whose cells are another width, though the pane keeps its size', async () => {
    const pane = laidOut({ width: 640, height: 500 });

    pane.source().emit('size', { cols: 120, rows: 24 });
    await run(pane.settle, 500);
    expect(pane.term.options.fontSize).toBe(9);
    pane.rescale(0.8);
    await run(pane.settle, 500);
    expect(pane.term.options.fontSize).toBe(12);
    expect(pane.fits()).toBe(true);
    pane.rescale(1);
    await run(pane.settle, 500);
    expect(pane.term.options.fontSize).toBe(9);
    expect(pane.listeners()).toBe(1);
    pane.console.dispose();
    expect(pane.listeners()).toBe(0);
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

    expect([...html(renderTabs(newView(), state)).matchAll(/data-tab="(\w+)"/g)].map((match) => match[1])).toEqual(['conversation', 'status', 'console']);
    expect([...html(renderSideSwitch('console', state)).matchAll(/data-side="(\w+)"/g)].map((match) => match[1])).toEqual(['status', 'console']);
    expect(html(renderSideSwitch('console', state))).toMatch(/aria-selected="true"[^>]*>Console/);
    expect([...html(renderSideSwitch('browser', state, true)).matchAll(/data-side="(\w+)"/g)].map((match) => match[1])).toEqual(['status', 'console', 'browser']);
  });

  it('says why a session has no console without loading it', () => {
    expect(consoleNote(null)).toBe('No session has started yet.');
    expect(consoleNote(session({ provider: 'codex' }))).toBeNull();
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

  it("loads the console for a Codex session as for a Claude one", async () => {
    const root = document.createElement('div');
    const loadConsole = vi.fn(async () => null);

    document.body.replaceChildren(root);

    const page = startPage(root, { fetch: vi.fn() as unknown as typeof globalThis.fetch, EventSource: FakeSource as unknown as typeof EventSource, now: () => 10_000, loadConsole });

    FakeSource.all[0]!.emit('hello', { type: 'hello', key: 'pk', groups: [], scope, sessions: [session({ provider: 'codex' })], items: [], more: false, status: null, artifacts: [] });
    root.querySelector<HTMLElement>('[data-tab="console"]')!.click();
    await tick();
    expect(root.querySelector('#panel')!.textContent).not.toContain("Codex's app-server");
    expect(loadConsole).toHaveBeenCalledTimes(1);
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
