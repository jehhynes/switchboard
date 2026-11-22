/**
 * The web page's console (architecture.md § Web page): a held session's terminal drawn with xterm.js from the hub's console stream. It shows the
 * session at the size the program draws, scaling its font down until the screen fits the pane, so a console that only watches never
 * re-wraps the screen or changes the session's size, and xterm.js's own scrollbar is its only scroller. Focusing it makes it type: the keys
 * the operator presses go to the session, and the session takes the console's size, so the program redraws for it; blurring it makes it watch again. Mouse reporting stays
 * off, so a pointer over it never types (mechanics M101), and the terminal's own answers to the program's queries are never sent.
 */

import { dimCss, LightColors, MINIMUM_CONTRAST, terminalTheme } from './consoleColors.js';

/** The part of xterm.js's `Terminal` the console uses, so tests can pass a fake. */
export interface ConsoleTerm {
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement | undefined;
  readonly textarea: HTMLTextAreaElement | undefined;
  options: { fontSize?: number; theme?: Record<string, string>; minimumContrastRatio?: number };
  open(parent: HTMLElement): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  reset(): void;
  focus(): void;
  dispose(): void;
  hasSelection(): boolean;
  getSelection(): string;
  onData(listener: (data: string) => void): { dispose(): void };
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  readonly parser: { registerCsiHandler(id: { prefix?: string; final: string }, callback: (params: Array<number | number[]>) => boolean): { dispose(): void } };
}

export interface TermOptions {
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  cursorBlink: boolean;
  theme: Record<string, string>;
  minimumContrastRatio: number;
}

export interface ConsoleOptions {
  /** The console stream's URL, with the page key and the session. */
  url: string;
  EventSource: new (url: string) => EventSource;
  /** Types keys into the session at the console's size; `data` is empty to resize alone. Resolves null once typed, else why not. */
  type(data: string, size: { cols: number; rows: number }): Promise<string | null>;
  /** Puts the selected text on the clipboard. */
  copy?(text: string): void;
}

export interface MountedConsole {
  dispose(): void;
}

/**
 * The font size the console types at, and the smallest it scales a larger screen down to: small enough to fit a full-screen terminal into a
 * narrow pane, since the pane never scrolls (a 3 px cell is about 1.7 px wide). A screen that does not fit even then is cut off at the pane's edge.
 */
export const CONSOLE_FONT_PX = 13;
export const CONSOLE_MIN_FONT_PX = 3;
/** The most characters one `console-input` carries, as the hub takes; a longer paste goes in order in several. */
export const CONSOLE_INPUT_CHARS = 64 * 1024;
/** How long the console waits after its pane resizes before it gives the session its new size while it types. */
export const CONSOLE_RESIZE_MS = 200;
/** The DEC private modes that make a terminal report the mouse or the focus, which the console never turns on (mechanics M101). */
export const REPORT_MODES: ReadonlySet<number> = new Set([9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016]);
/** A mouse report, legacy or SGR, which the console never sends even if a mode slipped through. */
const MOUSE_REPORT = /^\u001b\[(?:M[\s\S]{3}|<\d+;\d+;\d+[mM])$/;
/** The width of xterm.js's own scrollbar, drawn over the right edge of its screen: the page's 8 px (page.css) rather than xterm.js's 14 px. */
export const XTERM_SCROLLBAR_PX = 8;
/** The fonts the console draws with: VS Code's editor font. */
const FONT_FAMILY = 'Consolas, "Courier New", monospace';
/** The media query under which the page draws Light Modern (theme.css), and the console its light colours. */
export const LIGHT_SCHEME = '(prefers-color-scheme: light)';

/** The modes of a DECSET the console lets through: all but the report modes. */
export function keptModes(params: ReadonlyArray<number | number[]>): number[] {
  return params.map((param) => (Array.isArray(param) ? param[0]! : param)).filter((mode) => !REPORT_MODES.has(mode));
}

/**
 * The font size that fits `size` in cells of `cell` at `CONSOLE_FONT_PX` into `area`, between the minimum and that size, so the screen
 * fits the pane in both directions and xterm.js's own scrollback is the only scroller. A dimension of 0 sets no limit.
 */
export function fittedFont(area: { width: number; height: number }, size: { cols: number; rows: number }, cell: { width: number; height: number }): number {
  const fits = (pixels: number, cells: number, cellPixels: number): number =>
    pixels <= 0 || cells <= 0 || cellPixels <= 0 ? CONSOLE_FONT_PX : Math.floor((CONSOLE_FONT_PX * pixels) / (cellPixels * cells));

  return Math.max(CONSOLE_MIN_FONT_PX, Math.min(CONSOLE_FONT_PX, fits(area.width, size.cols, cell.width), fits(area.height, size.rows, cell.height)));
}

/** The columns and rows that fill `width` by `height` pixels with cells of the given size at `CONSOLE_FONT_PX`. */
export function fittedSize(width: number, height: number, cell: { width: number; height: number }): { cols: number; rows: number } {
  return {
    cols: Math.max(20, Math.min(1000, Math.floor(width / cell.width))),
    rows: Math.max(5, Math.min(1000, Math.floor(height / cell.height))),
  };
}

/** The keyboard and clipboard events that carry the operator's keys into the terminal. */
const INPUT_EVENTS = ['keydown', 'keypress', 'paste', 'input', 'compositionend'] as const;

/** Mounts the console in `host` and opens its stream. */
export function mountConsole(host: HTMLElement, createTerm: (options: TermOptions) => ConsoleTerm, options: ConsoleOptions): MountedConsole {
  // Built from nodes rather than HTML: the console's bundle stays without Preact, and nothing it shows is markup.
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, attributes: Record<string, string> = {}): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);

    node.className = className;
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
    return node;
  };
  // No bar above the screen: the focus border alone shows that it types (architecture.md § Web page).
  const screen = element('div', 'console-screen', { role: 'group', 'aria-label': 'Session console', title: 'Session console' });
  const foot = element('div', 'console-foot');
  const note = element('p', 'console-note', { role: 'alert' });
  const reconnect = element('button', 'console-reconnect', { type: 'button' });

  reconnect.hidden = true;
  reconnect.textContent = 'Reconnect';
  note.hidden = true;
  foot.hidden = true;
  foot.append(note, reconnect);
  /** The light scheme's dim colours (consoleColors.ts `dimCss`). */
  const dimStyle = element('style', '');

  host.replaceChildren(screen, foot, dimStyle);
  const scheme = typeof matchMedia === 'function' ? matchMedia(LIGHT_SCHEME) : null;
  const contrast = (): number => (scheme?.matches === true ? MINIMUM_CONTRAST : 1);
  /** The page's terminal colours for the scheme now, with the light scheme's dim colours. */
  const colourTheme = (): Record<string, string> => {
    const theme = terminalTheme(getComputedStyle(host));

    dimStyle.textContent = scheme?.matches === true ? dimCss(theme) : '';
    return theme;
  };
  const term = createTerm({ fontSize: CONSOLE_FONT_PX, fontFamily: FONT_FAMILY, scrollback: 10_000, cursorBlink: false, theme: colourTheme(), minimumContrastRatio: contrast() });
  /** Rewrites the stream's colours while the console draws in light colours; null in dark ones. */
  let colours: LightColors | null = null;

  let source: EventSource | null = null;
  let ended = false;
  let typing = false;
  let armed = 0;
  let disposed = false;
  let error: string | null = null;
  let pending = '';
  let sizeWanted = false;
  let sending = false;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** A cell's size at `CONSOLE_FONT_PX`, measured from the drawn screen while it is drawn at that size. */
  let cell: { width: number; height: number } | null = null;
  /** The drawing area the console last fitted to, and the size it last gave the session. */
  let fitted: { width: number; height: number } | null = null;
  let sentSize: { cols: number; rows: number } | null = null;

  term.open(screen);

  // The program's mouse and focus reports stay off, whatever it asks for; its other modes pass.
  const modes = term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    const kept = keptModes(params);

    if (kept.length === params.length) {
      return false;
    }

    if (kept.length > 0) {
      term.write(`\u001b[?${kept.join(';')}h`);
    }

    return true;
  });

  // Copy with a selection copies, as VS Code's terminal does; paste goes to the browser, which hands it to the terminal as one paste.
  term.attachCustomKeyEventHandler((event) => {
    const key = event.key.toLowerCase();
    const control = (event.ctrlKey || event.metaKey) && !event.altKey;

    if (event.type === 'keydown' && control && key === 'c' && term.hasSelection()) {
      options.copy?.(term.getSelection());
      return false;
    }

    return !(control && key === 'v');
  });

  // Only data that a key, a paste or an input method produced while the operator types goes to the session; the terminal's answers to the
  // program's queries come from a write, never inside one of these events, and are dropped, since the session's own terminal answers them.
  const arm = (): void => {
    armed++;
  };
  const disarm = (event: Event): void => {
    if (event.type === 'compositionend') {
      // xterm.js sends a composed text on a timer after the event.
      setTimeout(() => (armed = Math.max(0, armed - 1)), 0);
    } else {
      armed = Math.max(0, armed - 1);
    }

    // While it types, the keys are the session's, not the page's shortcuts.
    if (typing && event.type === 'keydown') {
      event.stopPropagation();
    }
  };

  for (const type of INPUT_EVENTS) {
    host.addEventListener(type, arm, true);
    host.addEventListener(type, disarm);
  }

  const keys = term.onData((data) => {
    if (armed > 0 && typing && !ended && !MOUSE_REPORT.test(data)) {
      pending += data;
      void flush();
    }
  });

  const drawState = (): void => {
    host.classList.toggle('typing', typing && !ended);
    note.hidden = error === null;
    note.textContent = error ?? '';
    reconnect.hidden = !ended;
    foot.hidden = note.hidden && reconnect.hidden;
  };

  /**
   * Has xterm.js fit its scrollbar and its input textarea to the screen again after a font change. xterm.js 6.0 sizes the scrollbar only when
   * its buffer resizes or scrolls, and places the textarea only when the cursor moves, so a smaller font left the old, taller scrollbar and the
   * textarea past the screen, where the pane scrolled to show them (mechanics M107). Both are xterm.js's private parts, so this does nothing if
   * an upgrade removes them, and `check-console.mjs` then fails.
   */
  const resync = (): void => {
    const core = (term as unknown as { _core?: { _viewport?: { queueSync?(): void }; _syncTextArea?(): void } })._core;

    core?._viewport?.queueSync?.();

    if (core?._syncTextArea !== undefined && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (!disposed) {
          core._syncTextArea?.();
        }
      });
    }
  };

  /**
   * Measures a cell at the console's own font from the drawn screen, or estimates it before the screen is drawn. It measures only while the
   * screen is drawn at `CONSOLE_FONT_PX`: a smaller font's cells do not scale exactly, and a cell measured at the font the last fit chose
   * could choose another font at the next fit, and back again.
   */
  const measure = (): { width: number; height: number } => {
    const drawn = term.element?.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect();

    if ((term.options.fontSize ?? CONSOLE_FONT_PX) === CONSOLE_FONT_PX && drawn !== undefined && drawn.width > 0 && drawn.height > 0) {
      cell = { width: drawn.width / term.cols, height: drawn.height / term.rows };
    }

    return cell ?? { width: CONSOLE_FONT_PX * 0.6, height: Math.ceil(CONSOLE_FONT_PX * 1.2) };
  };

  /**
   * The pane's drawing area: the screen less its padding and xterm.js's scrollbar, which xterm.js draws over the right edge of its screen, as
   * xterm.js's fit addon counts it. The screen itself never scrolls (page.css), so it has no scrollbars of its own.
   */
  const area = (): { width: number; height: number } => {
    const style = getComputedStyle(screen);
    const px = (value: string): number => Number.parseFloat(value) || 0;

    return {
      width: Math.max(0, screen.clientWidth - px(style.paddingLeft) - px(style.paddingRight) - XTERM_SCROLLBAR_PX),
      height: Math.max(0, screen.offsetHeight - px(style.borderTopWidth) - px(style.borderBottomWidth) - px(style.paddingTop) - px(style.paddingBottom)),
    };
  };

  /**
   * Scales the font so the session's columns and rows fit the pane, never above the console's own size. A smaller font's cells can be
   * larger than the 13 px cell scaled down, so it steps down from the scaled font while the drawn screen is still wider or taller than the pane.
   */
  const fit = (): void => {
    const room = area();
    let font = fittedFont(room, { cols: term.cols, rows: term.rows }, measure());

    if (term.options.fontSize !== font) {
      term.options.fontSize = font;
    }

    const overflows = (): boolean => {
      const drawn = term.element?.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect();

      return drawn !== undefined && ((room.width > 0 && drawn.width > room.width) || (room.height > 0 && drawn.height > room.height));
    };

    while (font > CONSOLE_MIN_FONT_PX && overflows()) {
      font--;
      term.options.fontSize = font;
    }

    resync();
    drawState();
  };

  /** The size the session takes while the console types: the cells that fill the pane at the console's own font. */
  const ownSize = (): { cols: number; rows: number } => {
    const { width, height } = area();

    return fittedSize(width, height, measure());
  };

  async function flush(): Promise<void> {
    if (sending || disposed || (pending === '' && !sizeWanted)) {
      return;
    }

    sending = true;

    let cut = Math.min(pending.length, CONSOLE_INPUT_CHARS);

    // A cut never splits a surrogate pair.
    if (cut < pending.length && /[\uD800-\uDBFF]/.test(pending[cut - 1]!)) {
      cut--;
    }

    const data = pending.slice(0, cut);

    pending = pending.slice(cut);
    sizeWanted = false;

    const size = ownSize();
    const why = await options.type(data, size);

    sending = false;

    if (why === null) {
      sentSize = size;
    }

    if (why !== null) {
      // Keys after refused ones are not typed either, so the session never gets part of what the operator typed out of order.
      const dropped = data.length + pending.length;

      pending = '';
      error = `Not typed: ${why}${dropped === 0 ? '' : ` ${dropped} character${dropped === 1 ? ' was' : 's were'} not typed.`}`;
    } else if (error?.startsWith('Not typed: ') === true) {
      error = null;
    }

    if (!disposed) {
      drawState();
      void flush();
    }
  }

  const onFocus = (): void => {
    typing = true;
    sizeWanted = true;
    // The focus border is drawn over the console's box by a pseudo-element, which takes no room, so focusing never changes the pane's size and the session is resized once.
    drawState();
    void flush();
  };
  const onBlur = (): void => {
    typing = false;
    drawState();
  };

  term.textarea?.addEventListener('focus', onFocus);
  term.textarea?.addEventListener('blur', onBlur);

  /** Gives the session the console's size `CONSOLE_RESIZE_MS` after the pane changes, while it types, if the pane now holds other cells. */
  const resizeLater = (): void => {
    if (!typing) {
      return;
    }

    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
    }

    resizeTimer = setTimeout(() => {
      resizeTimer = null;

      const size = ownSize();

      // The session is resized only when the pane, shown, now holds other cells than it was given.
      if (typing && area().width > 0 && (sentSize === null || size.cols !== sentSize.cols || size.rows !== sentSize.rows)) {
        sizeWanted = true;
        void flush();
      }
    }, CONSOLE_RESIZE_MS);
  };

  const resized =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          // The observer also reports the console's own redraws, such as a scrollbar showing; only a new drawing area refits it.
          const now = area();

          if (fitted !== null && now.width === fitted.width && now.height === fitted.height) {
            return;
          }

          fitted = now;
          fit();
          resizeLater();
        })
      : null;

  resized?.observe(screen);

  // A new display scale changes xterm.js's cells but not the pane, which the observer would not report. Once xterm.js has measured the new
  // scale, the console measures a cell at its own font again, without drawing in between, and refits.
  let scale: MediaQueryList | null = null;
  let scaleTimer: ReturnType<typeof setTimeout> | null = null;
  const watchScale = (): void => {
    scale?.removeEventListener('change', rescaled);
    scale = typeof matchMedia === 'function' ? matchMedia(`(resolution: ${devicePixelRatio}dppx)`) : null;
    scale?.addEventListener('change', rescaled);
  };
  function rescaled(): void {
    watchScale();

    if (scaleTimer !== null) {
      clearTimeout(scaleTimer);
    }

    scaleTimer = setTimeout(() => {
      scaleTimer = null;

      if (!disposed) {
        term.options.fontSize = CONSOLE_FONT_PX;
        measure();
        fit();
        resizeLater();
      }
    }, 0);
  }

  watchScale();

  const end = (why: string | null): void => {
    if (ended) {
      return;
    }

    ended = true;
    error = why;
    source?.close();
    colours = null;
    source = null;
    drawState();
  };
  /** Opens the stream on a cleared terminal; `queued` clears it in order with the writes still queued, so none of them lands after the clear. */
  const connect = (queued = false): void => {
    ended = false;
    error = null;

    if (queued) {
      // RIS, the reset `term.reset()` does, parsed after the data written before it.
      term.write('\u001bc');
    } else {
      term.reset();
    }

    colours = scheme?.matches === true ? new LightColors() : null;
    const own = new options.EventSource(options.url);

    source = own;

    // Only the open stream draws: one closed for a new one, or ended, is done.
    const on = (type: string, listener: (data: Record<string, unknown>) => void): void =>
      own.addEventListener(type, (event) => {
        if (source === own) {
          listener(JSON.parse((event as MessageEvent<string>).data) as Record<string, unknown>);
        }
      });

    on('size', (data) => {
      const cols = Number(data['cols']);
      const rows = Number(data['rows']);

      if (cols !== term.cols || rows !== term.rows) {
        term.resize(cols, rows);
      }

      fit();
    });
    on('data', (data) => {
      const text = String(data['data'] ?? '');

      term.write(colours === null ? text : colours.push(text));
    });
    on('replayed', () => drawState());
    on('exited', (data) => {
      term.write(colours?.flush() ?? '');
      term.write(`\r\n\u001b[2m[The session exited with code ${String(data['exitCode'])}.]\u001b[0m\r\n`);
      end('The session exited. Resume continues it.');
    });
    on('closed', (data) => end(typeof data['error'] === 'string' ? data['error'] : 'The console closed.'));
    on('unavailable', (data) => end(String(data['reason'] ?? 'The session has no console.')));
    // The browser would open the stream again by itself and replay the screen over it; the operator reconnects instead.
    own.addEventListener('error', () => {
      if (source === own) {
        end('The console lost its connection to Switchboard.');
      }
    });
    drawState();
  };

  /**
   * Follows the operating system's scheme, live: xterm.js takes the page's terminal colours for it, and a console still streaming draws the session
   * again from a new replay, since the colours the program drew were rewritten, or not, as they arrived. An ended console keeps what it drew.
   */
  const schemeChanged = (): void => {
    term.options.theme = colourTheme();
    term.options.minimumContrastRatio = contrast();

    if (!ended && source !== null) {
      source.close();
      source = null;
      connect(true);
    }
  };

  scheme?.addEventListener('change', schemeChanged);
  reconnect.addEventListener('click', () => connect());
  connect();

  return {
    dispose: () => {
      disposed = true;
      source?.close();
      scheme?.removeEventListener('change', schemeChanged);
      resized?.disconnect();
      scale?.removeEventListener('change', rescaled);

      if (scaleTimer !== null) {
        clearTimeout(scaleTimer);
      }

      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
      }

      for (const type of INPUT_EVENTS) {
        host.removeEventListener(type, arm, true);
        host.removeEventListener(type, disarm);
      }

      keys.dispose();
      modes.dispose();
      term.dispose();
      host.replaceChildren();
    },
  };
}
