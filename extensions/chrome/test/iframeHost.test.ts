import { describe, expect, it } from 'vitest';
import { hostPlacement } from '../src/iframeHostView.js';
const placement = { type: 'switchboard-iframe', url: 'https://github.com/o/r', left: 100, top: 50, width: 600, height: 400 };
describe('extension host frame placement', () => {
  it('accepts only bounded web rectangles and explicit reload', () => {
    expect(hostPlacement(placement, 900, 700)).toEqual({ url: 'https://github.com/o/r', left: 100, top: 50, width: 600, height: 400, reload: false, holes: [], dim: 0, modal: false });
    expect(hostPlacement({ ...placement, reload: true }, 900, 700)?.reload).toBe(true);
    expect(hostPlacement({ ...placement, left: -0.5, top: -0.5 }, 900, 700)).toMatchObject({ left: -0.5, top: -0.5 });
    for (const data of [
      null,
      undefined,
      false,
      {},
      { ...placement, type: 'other' },
      { ...placement, url: 'bad' },
      { ...placement, url: 'file:///secret' },
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
  it("accepts the page's bounded holes, darkening and modal flag, and refuses a malformed one", () => {
    const holes = [{ left: 400, top: 40, width: 200, height: 100, radius: 6 }];
    expect(hostPlacement({ ...placement, holes, dim: 0.45, modal: true }, 900, 700)).toMatchObject({ holes, dim: 0.45, modal: true });
    const many = Array.from({ length: 17 }, () => holes[0]);
    for (const extra of [
      { holes: many },
      { holes: 'all' },
      { holes: [null] },
      { holes: [{ ...holes[0], width: 0 }] },
      { holes: [{ ...holes[0], left: NaN }] },
      { holes: [{ ...holes[0], radius: -1 }] },
      { holes: [{ ...holes[0], height: 5000 }] },
      { holes: [{ ...holes[0], radius: undefined }] },
      { dim: -0.1 },
      { dim: 1.5 },
      { dim: '0.4' },
      { modal: 'yes' },
    ])
      expect(hostPlacement({ ...placement, ...extra }, 900, 700)).toBeNull();
  });
});
import { IframeHostController } from '../src/iframeHostView.js';
import { vi } from 'vitest';

describe('extension host messages', () => {
  it('does not renew the page heartbeat when live authority is checked again', () => {
    let now = 0;
    const show = vi.fn();
    const controller = new IframeHostController({ origin: 'https://pc.tail.ts.net', appWindow: () => ({}),
      now: () => now, show, reconcile: vi.fn(), title: vi.fn(), leave: vi.fn(), viewport: () => ({ width: 900, height: 700 }), ack: vi.fn() });
    controller.allow(); now = 10_000; controller.allow(); now = 15_001; controller.tick();
    expect(show).toHaveBeenLastCalledWith(null);
  });
  it('rejects stale or malformed desired state without reconciling it', () => {
    const app = {};
    const show = vi.fn(), reconcile = vi.fn();
    const ack = vi.fn();
    const controller = new IframeHostController({ origin: 'http://localhost:4000', appWindow: () => app, now: () => 0, show, reconcile, title: vi.fn(), leave: vi.fn(), viewport: () => ({ width: 900, height: 700 }), ack });
    controller.allow();
    const data = { ...placement, epoch: 'first', seq: 1, item: 1, tabs: [placement.url] };
    const send = (value: unknown) => controller.message({ source: app, origin: 'http://localhost:4000', data: value });
    expect(send(data)).toBe(true);
    expect(send(data)).toBe(false);
    for (const invalid of [{ ...data, seq: 0 }, { ...data, seq: NaN }, { ...data, seq: 2, item: 1.5 }, { ...data, seq: 2, tabs: ['javascript:alert(1)'] }, { ...data, seq: 2, tabs: [placement.url, placement.url] }, { ...data, seq: 2, url: 'https://github.com/other' }, { ...data, seq: 2, tabs: [12] }, { ...data, seq: 2, url: undefined, tabs: ['http://localhost:4000/page/'] }, { ...data, seq: 2, url: undefined, tabs: ['http://127.0.0.1:4000/page/'] }, { ...data, seq: 2, url: undefined, tabs: ['http://localhost:47615/'] }]) expect(send(invalid)).toBe(false);
    expect(reconcile).toHaveBeenCalledTimes(1);
    // Only an accepted placement tells the page this host cuts holes.
    expect(ack).toHaveBeenCalledTimes(1);
    expect(send({ ...data, epoch: 'second', seq: 0 })).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(send({ ...data, seq: 99 })).toBe(false);
    const tabs = Array.from({ length: 15 }, (_, i) => `http://site${i}.test:8080/path?q=1#part`);
    expect(send({ ...data, epoch: 'second', seq: 1, url: undefined, tabs })).toBe(true);
    expect(reconcile).toHaveBeenLastCalledWith(1, tabs);
    for (const url of ['https://desk.zoho.com/agent/ticket/1', 'https://forum.example.com/t/1', 'http://localhost:5000/']) expect(hostPlacement({ ...placement, url }, 900, 700)?.url).toBe(url);
  });
  it('refuses messages before authentication, from GitHub or another origin, and hides on missed heartbeats', () => {
    const app = {};
    let now = 0;
    const show = vi.fn();
    const title = vi.fn();
    const leave = vi.fn();
    const ack = vi.fn();
    const controller = new IframeHostController({
      origin: 'https://pc.tail.ts.net',
      appWindow: () => app,
      now: () => now,
      show,
      title,
      leave,
      reconcile: vi.fn(),
      viewport: () => ({ width: 900, height: 700 }),
      ack,
    });
    const event = { source: app, origin: 'https://pc.tail.ts.net', data: { ...placement, epoch: 'first', seq: 1, item: 1, tabs: [placement.url], title: '(2) Switchboard' } };
    expect(controller.message(event)).toBe(false);
    expect(ack).not.toHaveBeenCalled();
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
    expect(show).toHaveBeenLastCalledWith({ url: 'https://github.com/o/r', left: 100, top: 50, width: 600, height: 400, reload: false, holes: [], dim: 0, modal: false });
    expect(title).toHaveBeenLastCalledWith('(2) Switchboard');
    controller.block();
    expect(show).toHaveBeenLastCalledWith(null);
    expect(controller.message({ ...event, data: { ...event.data, seq: 2 } })).toBe(false);
    controller.allow();
    show.mockClear();
    expect(controller.message({ ...event, data: { ...event.data, seq: 2 } })).toBe(true);
    now = 15_000;
    controller.tick();
    expect(show).toHaveBeenCalledTimes(1);
    now = 15_001;
    controller.tick();
    expect(show).toHaveBeenLastCalledWith(null);
    expect(controller.message({ ...event, data: { type: 'switchboard-iframe', epoch: 'first', seq: 3, item: 1, tabs: [] } })).toBe(true);
    expect(show).toHaveBeenLastCalledWith(null);
    expect(controller.message({ ...event, data: { type: 'switchboard-iframe-disabled' } })).toBe(true);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(controller.message({ ...event, origin: 'https://evil.test', data: { type: 'switchboard-iframe-disabled' } })).toBe(false);
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
