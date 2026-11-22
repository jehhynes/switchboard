import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPLETE_SHARE, EDGE_PX, FLING_SPEED, LIST_SHADE, LIST_SHIFT, PAN_RATIO, SLOP_PX, SPEED_WINDOW_MS, swipeBack, swipeStart, SwipeTracker } from '../src/swipeBack.js';

/** A touch event as a phone sends it, with one finger at each point given. */
const touch = (type: string, points: [number, number][]): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });

  Object.defineProperty(event, 'touches', { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
  return event;
};

/** Gives an element a sideways scroller's sizes, which jsdom does not lay out. */
const scroller = (element: HTMLElement, overflow = 'auto'): HTMLElement => {
  Object.defineProperty(element, 'scrollWidth', { value: 600 });
  Object.defineProperty(element, 'clientWidth', { value: 300 });
  element.style.overflowX = overflow;
  return element;
};

describe('where a swipe can start', () => {
  const host = document.createElement('main');
  const path = (target: Element): EventTarget[] => {
    const out: EventTarget[] = [];

    for (let at: Element | null = target; at !== null; at = at.parentElement) {
      out.push(at);
    }

    return [...out, document, window];
  };
  const inside = (markup: string): Element => {
    host.innerHTML = markup;
    return host.querySelector('[data-t]')!;
  };

  it('starts from the edge or as a pan anywhere on plain content', () => {
    const text = inside('<div class="scroll"><p data-t>Reply</p></div>');

    expect(swipeStart(EDGE_PX, path(text), host)).toBe('edge');
    expect(swipeStart(EDGE_PX + 1, path(text), host)).toBe('pan');
  });

  it('never starts in a text field, a menu, a sheet, a sash or a frame, even from the edge', () => {
    for (const markup of ['<div class="composer-menu" role="listbox"><div role="option" data-t>@src</div></div>', '<textarea data-t></textarea>', '<input data-t>', '<div contenteditable="true"><b data-t>x</b></div>', '<div class="menu"><button data-t>Row</button></div>', '<div class="sheet-backdrop"><div class="sheet" data-t></div></div>', '<div class="sash" data-t></div>', '<iframe data-t></iframe>']) {
      const target = inside(markup);

      expect(swipeStart(2, path(target), host), markup).toBeNull();
      expect(swipeStart(200, path(target), host), markup).toBeNull();
    }
  });

  it('starts in a pane that scrolls sideways (code, a table, a diff, the console) only from the edge', () => {
    const code = inside('<div class="body"><pre><code data-t>const x = 1;</code></pre></div>');

    scroller(code.parentElement!);
    expect(swipeStart(200, path(code), host)).toBeNull();
    expect(swipeStart(10, path(code), host)).toBe('edge');

    for (const markup of ['<div class="diff-host"><span data-t>+ line</span></div>', '<div class="console"><canvas data-t></canvas></div>']) {
      const target = inside(markup);

      expect(swipeStart(200, path(target), host), markup).toBeNull();
      expect(swipeStart(10, path(target), host), markup).toBe('edge');
    }
  });

  it('starts as a pan over a wide element that does not scroll sideways, or one that fits', () => {
    const clipped = inside('<div><p data-t>x</p></div>');

    scroller(clipped.parentElement!, 'hidden');
    expect(swipeStart(200, path(clipped), host)).toBe('pan');

    const fits = inside('<pre data-t>short</pre>');

    (fits as HTMLElement).style.overflowX = 'auto';
    expect(swipeStart(200, path(fits), host)).toBe('pan');
  });

  it('looks only inside the conversation, and leaves a pan to a text selection but not an edge swipe', () => {
    const text = inside('<p data-t>x</p>');
    const outer = scroller(document.createElement('div'));

    expect(swipeStart(200, [...path(text).slice(0, 2), outer], host)).toBe('pan');
    expect(swipeStart(200, path(text), host, true)).toBeNull();
    expect(swipeStart(10, path(text), host, true)).toBe('edge');
  });
});

describe('a touch followed as a swipe', () => {
  it('waits out the slop, then drags for a pan clearly to the right', () => {
    const tracker = new SwipeTracker('pan', 100, 300, 0);

    expect(tracker.move(100 + SLOP_PX - 1, 300, 10)).toBe('pending');
    expect(tracker.offset).toBe(0);
    expect(tracker.move(130, 310, 20)).toBe('drag');
    expect(tracker.offset).toBe(30);
    // Never left of where it started.
    expect(tracker.move(80, 310, 30)).toBe('drag');
    expect(tracker.offset).toBe(0);
  });

  it('gives up for good on a pan up, down, left or not horizontal enough, so scrolling wins', () => {
    for (const [x, y] of [[100, 340], [100, 260], [70, 300], [100 + 15, 300 + 15 / PAN_RATIO + 1]] as const) {
      const tracker = new SwipeTracker('pan', 100, 300, 0);

      expect(tracker.move(x, y, 16), `${x},${y}`).toBe('cancel');
      expect(tracker.move(300, 300, 32)).toBe('cancel');
      expect(tracker.offset).toBe(0);
    }

    expect(new SwipeTracker('pan', 100, 300, 0).move(100 + 15, 300 + 15 / PAN_RATIO - 1, 16)).toBe('drag');
  });

  it('takes a steeper pan from the edge, more right than up or down', () => {
    expect(new SwipeTracker('edge', 5, 300, 0).move(20, 312, 16)).toBe('drag');
    expect(new SwipeTracker('edge', 5, 300, 0).move(20, 316, 16)).toBe('cancel');
  });

  it('goes back past a third of the width, or on a flick right, and snaps back otherwise or on a flick left', () => {
    const width = 390;
    const slow = (to: number): SwipeTracker => {
      const tracker = new SwipeTracker('pan', 0, 0, 0);

      // 1 px a frame of 16 ms, then rests for longer than the speed window.
      for (let x = SLOP_PX; x <= to; x += 1) {
        tracker.move(x, 0, x * 16);
      }

      return tracker;
    };
    const past = slow(Math.ceil(width * COMPLETE_SHARE) + 1);
    const short = slow(Math.floor(width * COMPLETE_SHARE) - 1);

    // Released long after the last move, so with no speed.
    expect(past.speed(1e9)).toBe(0);
    expect(past.completes(1e9, width)).toBe(true);
    expect(short.completes(1e9, width)).toBe(false);

    // A flick right goes back from early on.
    const flick = new SwipeTracker('pan', 0, 0, 0);

    flick.move(20, 0, 10);
    flick.move(60, 0, 60);
    expect(flick.speed(60)).toBeGreaterThanOrEqual(FLING_SPEED);
    expect(flick.completes(60, width)).toBe(true);
    // The same flick held still for longer than the speed window has no speed left.
    expect(flick.speed(60 + SPEED_WINDOW_MS + 1)).toBe(0);
    expect(flick.completes(60 + SPEED_WINDOW_MS + 1, width)).toBe(false);

    // Past a third but flicking back left snaps back.
    const back = new SwipeTracker('pan', 0, 0, 0);

    back.move(20, 0, 0);
    back.move(250, 0, 200);
    back.move(200, 0, 260);
    expect(back.speed(260)).toBeLessThanOrEqual(-FLING_SPEED);
    expect(back.completes(260, width)).toBe(false);

    // A touch that never became a swipe never goes back.
    expect(new SwipeTracker('pan', 0, 0, 0).completes(0, width)).toBe(false);
  });
});

describe('the swipe on the page', () => {
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  const setup = (patch: { enabled?: () => boolean; reduced?: boolean } = {}) => {
    const root = document.createElement('div');

    root.innerHTML = '<aside class="side"><div id="list"><button class="row selected">Item</button></div></aside><main class="main"><div class="scroll"><p>Reply</p><pre class="code">wide code</pre></div><textarea></textarea></main>';
    document.body.append(root);

    const host = root.querySelector<HTMLElement>('.main')!;
    const under = root.querySelector<HTMLElement>('.side')!;
    const back = vi.fn();
    let t = 0;
    const frames: (() => void)[] = [];

    Object.defineProperty(host, 'getBoundingClientRect', { value: () => ({ width: 390, height: 800, top: 0, left: 0, right: 390, bottom: 800 }) });
    stop = swipeBack({ root, host, under, enabled: patch.enabled ?? (() => true), back, reducedMotion: () => patch.reduced === true, now: () => t, frame: (callback) => frames.push(callback) });

    const drag = (target: Element, points: [number, number][], step = 16): Event[] =>
      points.map(([x, y], index) => {
        t += index === 0 ? 0 : step;

        const event = touch(index === 0 ? 'touchstart' : 'touchmove', [[x, y]]);

        target.dispatchEvent(event);
        frames.splice(0).forEach((callback) => callback());
        return event;
      });
    const lift = (target: Element, wait = 0): void => {
      t += wait;
      target.dispatchEvent(touch('touchend', []));
    };

    return { root, host, under, back, drag, lift, text: root.querySelector('p')!, code: root.querySelector('pre')!, box: root.querySelector('textarea')!, wait: (ms: number) => (t += ms) };
  };

  it('drags the conversation right over the shaded, shifted list and goes back once it lands past a third', () => {
    vi.useFakeTimers();

    const { root, host, under, back, drag, lift, text } = setup();
    const moves = drag(text, [[150, 400], [165, 402], [200, 405], [290, 410]]);

    // The first move only reads the direction; the ones after it stop the page scrolling.
    expect(moves[1]!.defaultPrevented).toBe(true);
    expect(moves[3]!.defaultPrevented).toBe(true);
    expect(root.classList.contains('swiping')).toBe(true);
    expect(host.style.transform).toBe('translate3d(140px, 0, 0)');

    const share = 140 / 390;

    expect(under.style.transform).toBe(`translate3d(${-LIST_SHIFT * 390 * (1 - share)}px, 0, 0)`);
    expect(Number(root.querySelector<HTMLElement>('.swipe-shade')!.style.opacity)).toBeCloseTo(LIST_SHADE * (1 - share));
    lift(text, 200);
    // It slides the rest of the way, then goes back and puts everything as it was.
    expect(host.style.transform).toBe('translate3d(390px, 0, 0)');
    expect(host.style.transition).toContain('transform');
    expect(back).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(back).toHaveBeenCalledOnce();
    expect(root.classList.contains('swiping')).toBe(false);
    expect(host.style.transform).toBe('');
    expect(under.style.transform).toBe('');
    expect(root.querySelector('.swipe-shade')).toBeNull();
  });

  it('snaps back on a short slow drag, and on a second finger or a cancel', () => {
    vi.useFakeTimers();

    const { root, host, back, drag, lift, text } = setup();

    drag(text, [[150, 400], [165, 400], [190, 400]]);
    lift(text, 200);
    expect(host.style.transform).toBe('translate3d(0px, 0, 0)');
    vi.advanceTimersByTime(400);
    expect(root.classList.contains('swiping')).toBe(false);

    drag(text, [[150, 400], [165, 400], [300, 400]]);
    text.dispatchEvent(touch('touchstart', [[300, 400], [100, 100]]));
    vi.advanceTimersByTime(400);
    drag(text, [[150, 400], [165, 400], [300, 400]]);
    text.dispatchEvent(touch('touchcancel', []));
    vi.advanceTimersByTime(400);
    expect(back).not.toHaveBeenCalled();
    expect(root.classList.contains('swiping')).toBe(false);
  });

  it('leaves vertical scrolling, the composer, code and a page that does not allow it alone', () => {
    let allowed = true;
    const { root, back, drag, lift, text, code, box } = setup({ enabled: () => allowed });

    Object.defineProperty(code, 'scrollWidth', { value: 900 });
    Object.defineProperty(code, 'clientWidth', { value: 300 });
    code.style.overflowX = 'auto';

    const checks: [Element, [number, number][]][] = [
      [text, [[150, 400], [152, 430], [300, 440]]],
      [box, [[150, 700], [200, 700], [300, 700]]],
      [box, [[5, 700], [60, 700], [300, 700]]],
      [code, [[150, 300], [200, 300], [300, 300]]],
    ];

    for (const [target, points] of checks) {
      const moves = drag(target, points);

      expect(moves.some((event) => event.defaultPrevented)).toBe(false);
      lift(target, 200);
    }

    allowed = false;
    expect(drag(text, [[150, 400], [200, 400], [300, 400]]).some((event) => event.defaultPrevented)).toBe(false);
    lift(text, 200);
    expect(root.classList.contains('swiping')).toBe(false);
    expect(back).not.toHaveBeenCalled();
    // Code that scrolls sideways still goes back from the edge.
    allowed = true;
    expect(drag(code, [[8, 300], [30, 300], [200, 300]])[2]!.defaultPrevented).toBe(true);
    expect(root.classList.contains('swiping')).toBe(true);
  });

  it('keeps following a touch whose element a redraw took away, and leaves one shade', () => {
    vi.useFakeTimers();

    const { root, host, back, drag, lift, text } = setup();

    drag(text, [[150, 400], [165, 400], [200, 400]]);
    // A new reply redraws the timeline: the touched paragraph leaves, and the touch's later events go to it alone.
    text.remove();
    const late = touch('touchmove', [[300, 400]]);

    text.dispatchEvent(late);
    expect(late.defaultPrevented).toBe(true);
    lift(text, 200);
    expect(host.style.transform).toBe('translate3d(390px, 0, 0)');
    vi.advanceTimersByTime(400);
    expect(back).toHaveBeenCalledOnce();
    expect(root.classList.contains('swiping')).toBe(false);
    expect(root.querySelectorAll('.swipe-shade')).toHaveLength(0);
  });

  it('leaves a touch the browser is already scrolling, whose deciding move cannot be cancelled', () => {
    const { root, host, back, text } = setup();
    const event = (type: string, x: number, cancelable: boolean): Event => {
      const one = new Event(type, { bubbles: true, cancelable });

      Object.defineProperty(one, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: 400 }] });
      return one;
    };

    text.dispatchEvent(event('touchstart', 150, true));
    text.dispatchEvent(event('touchmove', 200, false));
    text.dispatchEvent(event('touchmove', 330, true));
    text.dispatchEvent(event('touchend', 0, false));
    expect(root.classList.contains('swiping')).toBe(false);
    expect(host.style.transform).toBe('');
    expect(back).not.toHaveBeenCalled();
  });

  it('lands at once with reduced motion, with no slide of the list', () => {
    const { root, host, under, back, drag, lift, text } = setup({ reduced: true });

    drag(text, [[150, 400], [165, 400], [300, 400]]);
    expect(host.style.transform).toBe('translate3d(150px, 0, 0)');
    expect(under.style.transform).toBe('');
    lift(text, 200);
    expect(back).toHaveBeenCalledOnce();
    expect(root.classList.contains('swiping')).toBe(false);
    expect(host.style.transform).toBe('');
  });

  it('stops listening and puts the page back when closed mid-swipe', () => {
    const { root, host, back, drag, text } = setup();

    drag(text, [[150, 400], [165, 400], [300, 400]]);
    stop!();
    stop = null;
    expect(root.classList.contains('swiping')).toBe(false);
    expect(host.style.transform).toBe('');
    drag(text, [[150, 400], [165, 400], [300, 400]]);
    expect(root.classList.contains('swiping')).toBe(false);
    expect(back).not.toHaveBeenCalled();
  });
});
