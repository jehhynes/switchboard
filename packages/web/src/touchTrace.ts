// Temporary (mechanics.md M176, M177): taps near the top bars, and every shift of the page's viewport, go to the hub's log as "page trace:"
// lines, so a fault seen on an iPhone can be read back. Remove before merging.

const round = (value: number): number => Math.round(value * 10) / 10;

function describe(node: EventTarget | Element | null): string | null {
  if (!(node instanceof Element)) {
    return null;
  }

  const button = node.closest('button, a, [data-action]') ?? node;

  return `${button.tagName.toLowerCase()}.${[...button.classList].join('.')}${button instanceof HTMLElement && button.dataset['action'] ? `[${button.dataset['action']}]` : ''}`;
}

function bar(selector: string): Record<string, number> | null {
  const node = [...document.querySelectorAll(selector)].find((one) => one.getBoundingClientRect().height > 0);

  if (node === undefined) {
    return null;
  }

  const box = node.getBoundingClientRect();
  const frame = node.parentElement!.getBoundingClientRect();

  return { top: round(box.top), bottom: round(box.bottom), frameTop: round(frame.top), frameHeight: round(frame.height) };
}

/** The page's scroll and viewport state, short keys: window scrollY, scrollingElement and body scrollTop, visualViewport offsetTop, pageTop, height and scale, innerHeight, html's client height and scroll height, #root's top and height, the shown top bar's top, the focused element, display mode and visibility. */
function state(): Record<string, unknown> {
  const view = window.visualViewport;
  const root = document.getElementById('root')?.getBoundingClientRect();
  const head = [...document.querySelectorAll('.header, .list-header')].find((one) => one.getBoundingClientRect().height > 0)?.getBoundingClientRect();

  return {
    sy: round(scrollY),
    st: round(document.scrollingElement?.scrollTop ?? -1),
    bt: round(document.body.scrollTop),
    vt: view === null ? null : round(view.offsetTop),
    vp: view === null ? null : round(view.pageTop),
    vh: view === null ? null : round(view.height),
    vs: view === null ? null : round(view.scale),
    ih: innerHeight,
    ch: document.documentElement.clientHeight,
    sh: document.documentElement.scrollHeight,
    rt: root === undefined ? null : round(root.top),
    rh: root === undefined ? null : round(root.height),
    ht: head === undefined ? null : round(head.top),
    act: describe(document.activeElement),
    sa: matchMedia('(display-mode: standalone)').matches,
    vis: document.visibilityState,
  };
}

/** What is out of line with no text field focused: any scroll offset, or the root or the top bar off the top. While a field has the focus iOS moves the page on purpose. */
function fault(now: Record<string, unknown>): string {
  const off = (key: string): boolean => typeof now[key] === 'number' && Math.abs(now[key] as number) >= 1;

  return typing() ? '' : ['sy', 'st', 'bt', 'vt', 'rt', 'ht'].filter(off).join(',');
}

function typing(): boolean {
  return document.activeElement instanceof HTMLElement && document.activeElement.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

/** A visual viewport shorter than innerHeight with no text field focused, as iOS leaves it after some blurs: noted, not a fault. */
function short(now: Record<string, unknown>): boolean {
  return typeof now['vh'] === 'number' && (now['vh'] as number) < innerHeight - 1 && !typing();
}

export function traceTouches(post: (body: Record<string, unknown>) => void): void {
  if (!(navigator.maxTouchPoints > 0) || typeof document.elementFromPoint !== 'function') {
    return;
  }

  const start = performance.now();
  const recent: unknown[] = [];
  let last = '';
  let wasShort = false;

  const note = (kind: string, extra: Record<string, unknown> = {}): void => {
    const now = state();
    const out = fault(now);

    recent.push({ t: Math.round(performance.now() - start), kind, ...extra, ...now });
    recent.splice(0, recent.length - 30);

    if (out !== last) {
      post({ shift: out === '' ? 'cleared' : out, was: last, kind, recent: [...recent] });
      last = out;
    }

    if (short(now) !== wasShort) {
      wasShort = !wasShort;
      post({ note: wasShort ? 'short' : 'short ended', kind, vh: now['vh'], ih: now['ih'] });
    }
  };
  const view = window.visualViewport;

  for (const kind of ['focusin', 'focusout'] as const) {
    document.addEventListener(kind, (event) => note(kind, { on: describe(event.target) }), true);
  }

  view?.addEventListener('resize', () => note('vv-resize'));
  view?.addEventListener('scroll', () => note('vv-scroll'));
  addEventListener('scroll', () => note('scroll'), { passive: true });
  addEventListener('resize', () => note('resize'));
  addEventListener('orientationchange', () => note('orientation'));
  addEventListener('pageshow', (event) => note('pageshow', { persisted: event.persisted }));
  addEventListener('pagehide', () => note('pagehide'));
  addEventListener('popstate', () => note('popstate'));
  document.addEventListener('visibilitychange', () => note('visibility'));
  document.addEventListener('touchend', (event) => note('touchend', { y: round(event.changedTouches[0]?.clientY ?? -1) }), { capture: true, passive: true });
  // A shift no event announces still shows within a second.
  setInterval(() => {
    const now = state();

    if (fault(now) !== last || short(now) !== wasShort) {
      note('poll');
    }
  }, 1000);
  note('start');

  let touch: Record<string, unknown> | null = null;

  document.addEventListener(
    'touchstart',
    (event) => {
      const one = event.touches[0];

      if (one === undefined || one.clientY > 200) {
        touch = null;
        return;
      }

      touch = {
        x: round(one.clientX),
        y: round(one.clientY),
        there: describe(document.elementFromPoint(one.clientX, one.clientY)),
        ...state(),
        listHeader: bar('.list-header'),
        header: bar('.header'),
      };
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    'click',
    (event) => {
      if (touch !== null) {
        post({ touch, click: { x: round(event.clientX), y: round(event.clientY), target: describe(event.target) } });
        touch = null;
      }
    },
    true,
  );
}
