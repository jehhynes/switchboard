import { describe, expect, it } from 'vitest';
import { hostPlacement } from '../src/iframeHostView.js';
const placement = { type: 'switchboard-iframe', url: 'https://github.com/o/r', left: 100, top: 50, width: 600, height: 400 };
describe('extension host frame placement', () => {
  it('accepts only bounded GitHub rectangles and explicit reload', () => {
    expect(hostPlacement(placement, 900, 700)).toEqual({ url: 'https://github.com/o/r', left: 100, top: 50, width: 600, height: 400, reload: false });
    expect(hostPlacement({ ...placement, reload: true }, 900, 700)?.reload).toBe(true);
    expect(hostPlacement({ ...placement, left: -0.5, top: -0.5 }, 900, 700)).toMatchObject({ left: -0.5, top: -0.5 });
    for (const data of [
      null,
      undefined,
      false,
      {},
      { ...placement, type: 'other' },
      { ...placement, url: 'bad' },
      { ...placement, url: 'https://github.com.evil.test/' },
      { ...placement, url: 'https://u:p@github.com/' },
      { ...placement, url: `https://github.com/${'x'.repeat(2048)}` },
      { ...placement, left: -2 },
      { ...placement, top: NaN },
      { ...placement, width: Infinity },
      { ...placement, height: 0 },
      { ...placement, left: 500 },
      { ...placement, top: 400 },
    ])
      expect(hostPlacement(data, 900, 700)).toBeNull();
  });
});
import { IframeHostController } from '../src/iframeHostView.js';
import { vi } from 'vitest';

describe('extension host messages', () => {
  it('rejects stale or malformed desired state without reconciling it', () => {
    const app = {};
    const show = vi.fn(), reconcile = vi.fn();
    const controller = new IframeHostController({ origin: 'http://localhost:4000', appWindow: () => app, now: () => 0, show, reconcile, title: vi.fn(), leave: vi.fn(), viewport: () => ({ width: 900, height: 700 }) });
    controller.allow();
    const data = { ...placement, epoch: 'first', seq: 1, item: 1, tabs: [placement.url] };
    const send = (value: unknown) => controller.message({ source: app, origin: 'http://localhost:4000', data: value });
    expect(send(data)).toBe(true);
    expect(send(data)).toBe(false);
    for (const invalid of [{ ...data, seq: 0 }, { ...data, seq: NaN }, { ...data, seq: 2, item: 1.5 }, { ...data, seq: 2, tabs: ['https://evil.test'] }, { ...data, seq: 2, tabs: [placement.url, placement.url] }, { ...data, seq: 2, url: 'https://github.com/other' }, { ...data, seq: 2, tabs: Array.from({ length: 11 }, (_, i) => `https://github.com/o/r/${i}`) }]) expect(send(invalid)).toBe(false);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(send({ ...data, epoch: 'second', seq: 0 })).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(send({ ...data, seq: 99 })).toBe(false);
  });
  it('refuses messages before authentication, from GitHub or another origin, and hides on missed heartbeats', () => {
    const app = {};
    let now = 0;
    const show = vi.fn();
    const title = vi.fn();
    const leave = vi.fn();
    const controller = new IframeHostController({
      origin: 'https://pc.tail.ts.net',
      appWindow: () => app,
      now: () => now,
      show,
      title,
      leave,
      reconcile: vi.fn(),
      viewport: () => ({ width: 900, height: 700 }),
    });
    const event = { source: app, origin: 'https://pc.tail.ts.net', data: { ...placement, epoch: 'first', seq: 1, item: 1, tabs: [placement.url], title: '(2) Switchboard' } };
    expect(controller.message(event)).toBe(false);
    expect(show).not.toHaveBeenCalled();
    controller.allow();
    for (const other of [
      { ...event, source: {} },
      { ...event, source: null },
      { ...event, origin: 'https://github.com' },
      { ...event, data: null },
      { ...event, data: { type: 'other' } },
    ])
      expect(controller.message(other)).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(title).not.toHaveBeenCalled();
    expect(controller.message(event)).toBe(true);
    expect(show).toHaveBeenLastCalledWith({ url: 'https://github.com/o/r', left: 100, top: 50, width: 600, height: 400, reload: false });
    expect(title).toHaveBeenLastCalledWith('(2) Switchboard');
    now = 15_000;
    controller.tick();
    expect(show).toHaveBeenCalledTimes(1);
    now = 15_001;
    controller.tick();
    expect(show).toHaveBeenLastCalledWith(null);
    expect(controller.message({ ...event, data: { type: 'switchboard-iframe', epoch: 'first', seq: 2, item: 1, tabs: [] } })).toBe(true);
    expect(show).toHaveBeenLastCalledWith(null);
    expect(controller.message({ ...event, data: { type: 'switchboard-iframe-disabled' } })).toBe(true);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(controller.message({ ...event, origin: 'https://evil.test', data: { type: 'switchboard-iframe-disabled' } })).toBe(false);
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
