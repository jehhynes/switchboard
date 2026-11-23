import { IframeHostController } from '../src/iframeHostView.js';
import { describe, expect, it, vi } from 'vitest';
import { HostStartup, type HostAccess } from '../src/hostStartup.js';
import { iframeAccess } from '../src/iframe.js';

describe('host offline shell', () => {
  function rig() {
    let access: HostAccess = 'enabled', remembered = false;
    const authority = vi.fn(), shell = vi.fn(), note = vi.fn();
    const startup = new HostStartup({ probe: async () => access, remembered: async () => remembered,
      remember: async (value) => { remembered = value; }, authority, shell, note, leave: vi.fn() });
    return { startup, authority, shell, note, access: (value: HostAccess) => { access = value; }, remembered: () => remembered };
  }
  it('remembers live verification and opens only the cached shell offline, then restores authority', async () => {
    const r = rig();
    await r.startup.check();
    expect(r.remembered()).toBe(true); expect(r.authority).toHaveBeenLastCalledWith(true);
    r.access('offline'); await r.startup.check();
    expect(r.shell).toHaveBeenLastCalledWith(true); expect(r.authority).toHaveBeenLastCalledWith(false); expect(r.note).toHaveBeenLastCalledWith(null);
    r.access('enabled'); await r.startup.check(); expect(r.authority).toHaveBeenLastCalledWith(true);
  });
  it('refuses unknown offline origins and forgets trust on an explicit rejection', async () => {
    const r = rig(); r.access('offline'); await r.startup.check();
    expect(r.shell).toHaveBeenLastCalledWith(false); expect(r.authority).toHaveBeenLastCalledWith(false);
    expect(r.note).toHaveBeenLastCalledWith('Cannot reach Switchboard. Connect once to verify this hub, then retry.');
    r.access('enabled'); await r.startup.check();
    r.access('refused'); await r.startup.check(); expect(r.remembered()).toBe(false); expect(r.shell).toHaveBeenLastCalledWith(false);
    r.access('offline'); await r.startup.check(); expect(r.shell).toHaveBeenLastCalledWith(false);
  });
  it('clears offline trust before leaving through a settings message, even with a save in flight', async () => {
    let saved = false, finish!: () => void;
    const navigate = vi.fn();
    const source = {};
    let exiting = Promise.resolve();
    const controller = new IframeHostController({ origin: 'https://pc.tail.ts.net', appWindow: () => source,
      now: () => 0, show: vi.fn(), title: vi.fn(), reconcile: vi.fn(), viewport: () => ({ width: 900, height: 700 }),
      leave: () => { exiting = startup.leave(); } });
    const startup = new HostStartup({ probe: async () => 'enabled', remembered: async () => saved,
      remember: async (value) => {
        if (value) await new Promise<void>((done) => { finish = done; });
        saved = value;
      }, authority: (value) => value ? controller.allow() : controller.block(), shell: vi.fn(), note: vi.fn(), leave: navigate });
    const checking = startup.check();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(controller.message({ source, origin: 'https://pc.tail.ts.net', data: { type: 'switchboard-iframe-disabled' } })).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    finish(); await checking; await exiting;
    expect(saved).toBe(false); expect(navigate).toHaveBeenCalledTimes(1);
    await startup.check(); expect(saved).toBe(false);
  });
  it('does not navigate if saved trust cannot be cleared', async () => {
    const navigate = vi.fn(), authority = vi.fn();
    const startup = new HostStartup({ probe: async () => 'enabled', remembered: async () => true,
      remember: async () => { throw new Error('storage'); }, authority, shell: vi.fn(), note: vi.fn(), leave: navigate });
    await startup.leave(); expect(authority).toHaveBeenCalledWith(false); expect(navigate).not.toHaveBeenCalled();
  });
  it('serializes probes and fails closed when saved state cannot be read', async () => {
    let finish!: (value: HostAccess) => void;
    const probe = vi.fn(() => new Promise<HostAccess>((done) => { finish = done; }));
    const authority = vi.fn(), shell = vi.fn(), note = vi.fn();
    const startup = new HostStartup({ probe, remembered: async () => { throw new Error('storage'); }, remember: vi.fn(), authority, shell, note, leave: vi.fn() });
    const pending = startup.check(); await startup.check(); expect(probe).toHaveBeenCalledTimes(1);
    finish('offline'); await pending; expect(authority).toHaveBeenLastCalledWith(false); expect(shell).toHaveBeenLastCalledWith(false);
    expect(note).toHaveBeenLastCalledWith('Cannot read the extension’s saved hub. Reload the extension and retry.');
  });
});

describe('host access probe', () => {
  const origin = 'https://pc.tail.ts.net';
  it('distinguishes transport outages from explicit refusal or malformed answers', async () => {
    for (const status of [502, 503, 504]) expect(await iframeAccess(async () => new Response('', { status }), origin, origin)).toBe('offline');
    expect(await iframeAccess(async () => { throw new Error('offline'); }, origin, origin)).toBe('offline');
    for (const status of [401, 403, 404, 500]) expect(await iframeAccess(async () => new Response('', { status }), origin, origin)).toBe('refused');
    for (const body of ['bad JSON', 'null', '{}', '{"enabled":false}']) expect(await iframeAccess(async () => new Response(body), origin, origin)).toBe('refused');
    expect(await iframeAccess(async () => new Response('{"enabled":true}'), origin, origin)).toBe('enabled');
  });
  it('rejects another remote origin without fetching and requires both local checks', async () => {
    const fetch = vi.fn(async () => new Response('{"enabled":true}'));
    expect(await iframeAccess(fetch, 'https://evil.test', origin)).toBe('refused'); expect(fetch).not.toHaveBeenCalled();
    const local = 'http://127.0.0.1:4000';
    const read = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/iframe') && url.includes(':47615') ? { enabled: true, origins: [local] } : { enabled: false })));
    expect(await iframeAccess(read, local, null)).toBe('refused'); expect(read).toHaveBeenCalledTimes(2);
    expect(await iframeAccess(async () => new Response('{"enabled":true,"origins":[]}'), local, null)).toBe('refused');
  });
});
