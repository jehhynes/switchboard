import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import type { PageRow } from '@switchboard/protocol';
import { renderList } from '../src/list.js';
import { mount, unmount } from '../src/island.js';

const row = (id: number, band: string | null = 'Today'): PageRow => ({ workItemId: id, ticketId: id, title: `Item ${id}`, priority: null, time: null, ticket: `gh ${id}`, sourceKind: 'github', url: '', playbook: 'dev:build', links: [], returned: 0, comment: null, mark: null, details: [], stripe: null, dim: false, host: null, actions: [], main: null, pastes: [], search: '', opens: [], band, voice: null, history: null });

describe('Done windowing', () => {
  let host: HTMLDivElement;
  let top: number;
  let width: number;
  let height: number;
  let frames: FrameRequestCallback[];
  let observers: Array<{ callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }>;
  const scrollIntoView = vi.fn();
  const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1));
  const draw = (shown = rows, selected: number | null = null, collapsed = new Set<string>(), bands = new Map<string, boolean>(), filtering = false, key = 'done'): void => {
    act(() => mount(host, renderList([{ key, title: key, glyph: '', empty: null, rows: shown }], selected, collapsed, filtering, null, bands)));
  };
  const scroll = (value: number): void => {
    top = value;
    act(() => {
      host.dispatchEvent(new Event('scroll'));
      const pending = frames.splice(0);
      for (const frame of pending) frame(0);
    });
  };
  beforeEach(() => {
    host = document.createElement('div');
    host.id = 'list';
    document.body.append(host);
    top = 0; width = 320; height = 72; frames = []; observers = [];
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(callback: ResizeObserverCallback) { observers.push({ callback, disconnect: this.disconnect }); }
    });
    vi.spyOn(host, 'clientHeight', 'get').mockReturnValue(600);
    Object.defineProperty(host, 'scrollTop', { get: () => top, set: (value: number) => { top = value; }, configurable: true });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      let y = this === host ? 0 : -top;
      if (this.hasAttribute('data-window-row')) {
        for (let previous = this.previousElementSibling as HTMLElement | null; previous !== null; previous = previous.previousElementSibling as HTMLElement | null) {
          y += previous.hasAttribute('data-window-row') ? height : parseFloat(previous.style.height);
        }
      }
      const tall = this === host ? 600 : this.hasAttribute('data-window-row') ? height : 0;
      return { top: y, bottom: y + tall, width, height: tall } as DOMRect;
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true });
    scrollIntoView.mockReset();
  });
  afterEach(() => {
    act(() => unmount(host));
    host.remove();
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    vi.unstubAllGlobals();
  });

  it('bounds mounted rows and preserves the full scroll height with pixel spacers', () => {
    draw();
    expect(host.querySelectorAll('.row')).toHaveLength(12);
    expect(host.querySelector<HTMLElement>('[aria-hidden=true][role=presentation]')!.style.height).toBe('71136px');
    scroll(36_000);
    const mounted = [...host.querySelectorAll<HTMLElement>('[data-window-row]')];
    expect(mounted.length).toBe(16);
    expect(mounted[0]!.getAttribute('aria-posinset')).toBe('497');
    expect(mounted.at(-1)!.getAttribute('aria-posinset')).toBe('512');
    expect(mounted[0]!.getAttribute('aria-setsize')).toBe('1000');
    const gaps = [...host.querySelectorAll<HTMLElement>('[role=presentation]')].map((li) => parseFloat(li.style.height));
    expect(gaps).toEqual([35712, 35136]);
  });

  it('keeps a focused button mounted while scrolling and receiving new row objects', () => {
    draw();
    const button = host.querySelector<HTMLButtonElement>('.row')!;
    act(() => button.focus());
    scroll(36_000);
    draw(rows.map((one) => ({ ...one })));
    expect(document.activeElement).toBe(button);
    expect(button.isConnected).toBe(true);
    expect(host.querySelectorAll('.row')).toHaveLength(17);
    act(() => button.blur());
    expect(button.isConnected).toBe(false);
  });

  it('mounts an offscreen selection and scrolls it into view only when selection changes', () => {
    draw();
    draw(rows, 990);
    expect(host.querySelector('.row.selected')?.getAttribute('data-work-item')).toBe('990');
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' });
    scroll(20_000);
    draw(rows.map((one) => ({ ...one })), 990);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('measures wrapped rows and invalidates their heights when the list width changes', () => {
    draw();
    height = 100;
    act(() => { for (const observer of [...observers]) observer.callback([], {} as ResizeObserver); });
    // The window shrinks to nine rows; the three just outside it retain their measured heights.
    const gap = host.querySelector<HTMLElement>('[role=presentation]')!;
    expect(gap.style.height).toBe('71436px');
    width = 200;
    act(() => {
      window.dispatchEvent(new Event('resize'));
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(host.querySelectorAll('.row').length).toBeLessThan(20);
    expect(host.querySelector('.row-title')?.textContent).toBe('Item 1');
  });

  it('keeps a distant selection in view after its real height replaces the estimate', () => {
    height = 100;
    scrollIntoView.mockImplementation(function (this: HTMLElement) {
      top += this.parentElement!.getBoundingClientRect().top - 300;
    });
    draw();
    draw(rows, 900);
    scroll(top);
    act(() => { for (const observer of [...observers]) observer.callback([], {} as ResizeObserver); });
    const selected = host.querySelector<HTMLElement>('.row.selected')!.parentElement!;
    expect(selected.getBoundingClientRect().top).toBe(300);
    expect(selected.getBoundingClientRect().bottom).toBe(400);
    scrollIntoView.mockReset();
  });

  it('keeps measurements and the scroll offset while its pane is hidden', () => {
    height = 100;
    draw();
    scroll(6000);
    const count = host.querySelectorAll('.row').length;
    const before = top;
    width = 0;
    act(() => { for (const observer of [...observers]) observer.callback([], {} as ResizeObserver); });
    expect(top).toBe(before);
    expect(host.querySelectorAll('.row')).toHaveLength(count);
    width = 320;
    scroll(top);
    expect(top).toBe(before);
    expect(host.querySelectorAll('.row')).toHaveLength(count);
  });

  it('allows manual scrolling after selecting an already measured visible row', () => {
    draw();
    draw(rows, 1);
    scroll(6000);
    expect(top).toBe(6000);
    expect(host.querySelector('.row.selected')?.getAttribute('data-work-item')).toBe('1');
    expect(host.querySelectorAll('.row').length).toBeLessThan(25);
  });

  it('keeps the selected row in a closed band and collapsed group', () => {
    draw(rows, 990, new Set(), new Map([['done:Today', false]]));
    expect(host.querySelectorAll('.row')).toHaveLength(1);
    expect(host.querySelector('.row.selected')?.textContent).toContain('Item 990');
    draw(rows, 990, new Set(['done']));
    expect(host.querySelectorAll('.row')).toHaveLength(1);
    expect(host.querySelector('.band-head')).toBeNull();
    draw(rows, null, new Set(['done']));
    expect(host.querySelectorAll('.row')).toHaveLength(0);
  });

  it('anchors the visible row when a width change discards measurements above it', () => {
    height = 100;
    draw();
    // Build measurements above a distant selection, as scrolling through wrapped rows does.
    for (let step = 1; step <= 10; step++) scroll(step * 600);
    draw(rows, 500);
    const selected = host.querySelector<HTMLElement>('.row.selected')!.parentElement!;
    top = selected.getBoundingClientRect().top + top - 200;
    scroll(top);
    const before = selected.getBoundingClientRect().top;
    width = 200;
    height = 140;
    act(() => {
      window.dispatchEvent(new Event('resize'));
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(selected.getBoundingClientRect().top).toBe(before);
    expect(selected.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(selected.getBoundingClientRect().bottom).toBeLessThanOrEqual(600);
  });

  it('anchors visible content when newly mounted rows above it measure taller', () => {
    draw();
    scroll(36_000);
    const visible = [...host.querySelectorAll<HTMLElement>('[data-window-row]')].find((li) => li.getBoundingClientRect().top >= 0)!;
    const before = visible.getBoundingClientRect().top;
    height = 100;
    // The layout has already wrapped when ResizeObserver runs. Keep the first partially visible row at that position while spacers change.
    const atResize = visible.getBoundingClientRect().top;
    act(() => { for (const observer of [...observers]) observer.callback([], {} as ResizeObserver); });
    expect(visible.getBoundingClientRect().top).toBe(atResize);
    expect(before).toBe(0);
    expect(host.querySelectorAll('.row').length).toBeLessThan(25);
  });

  it('opens bands for filtered results and restores their counts and closed state afterward', () => {
    const bands = new Map([['done:Today', false]]);
    draw([row(995)], null, new Set(['done']), bands, true);
    expect(host.querySelector('.row')?.textContent).toContain('Item 995');
    expect(host.querySelector('.band-head')?.getAttribute('aria-expanded')).toBe('true');
    draw(rows, null, new Set(), bands);
    expect(host.querySelectorAll('.row')).toHaveLength(0);
    expect(host.querySelector('.band-count')?.textContent).toBe('1000');
    draw(rows);
    expect(host.querySelectorAll('.row')).toHaveLength(12);
  });

  it('leaves other groups unwindowed and releases listeners and observers on unmount', () => {
    draw(rows.map((one) => ({ ...one, band: null })), null, new Set(), new Map(), false, 'progress');
    expect(host.querySelectorAll('.row')).toHaveLength(1000);
    draw();
    const scrollListener = vi.spyOn(host, 'removeEventListener');
    act(() => unmount(host));
    expect(scrollListener).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(observers.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true);
  });
});
