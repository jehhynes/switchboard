import { describe, expect, it, vi } from 'vitest';
import { IframeBrowser, frameUrl, frameLinks } from '../src/iframeBrowser.js';
import type { PageRow } from '@switchboard/protocol';
const row = (id = 1): PageRow => ({ workItemId: id, url: `https://github.com/o/r/issues/${id}`, links: [{ label: 'PR', url: 'https://github.com/o/r/pull/3', kind: 'pr' }, { label: 'Duplicate', url: `https://github.com/o/r/issues/${id}` }, { label: 'Other', url: 'https://example.com/' }] }) as PageRow;
async function rig(answer: unknown = { ok: true }) {
  const send = vi.fn(async (_message: Record<string, unknown>) => answer);
  const browser = new IframeBrowser({ send, changed: vi.fn(), external: vi.fn() });
  const host = document.createElement('div');
  document.body.append(host);
  browser.configure(true);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  return { browser, host, send };
}
describe('embedded browser tabs', () => {
  it('rejects unsafe sites and deduplicates row links', () => {
    for (const url of ['https://github.com/o/r', 'https://desk.zoho.com/agent/ticket/1', 'https://forum.example.com/t/2', 'http://localhost:5000/']) expect(frameUrl(url)).toBe(true);
    for (const url of ['bad', 'javascript:alert(1)', 'https://u:p@github.com/', 'file:///secret', 'data:text/html,no', 'http://localhost:47615/', 'http://127.0.0.1:47615/', `${location.origin}/page/`, `https://github.com/${'x'.repeat(2048)}`]) expect(frameUrl(url)).toBe(false);
    expect(frameLinks(null)).toEqual([]);
    expect(frameLinks(row()).map((link) => link.label)).toEqual(['Ticket', 'PR', 'Other']);
  });
  it('launches the selected work item from an ordinary page without creating signed-out frames', async () => {
    const r = await rig();
    r.browser.follow(row(), true); r.browser.draw(r.host, row(), true);
    expect(r.browser.selected).toBe('https://github.com/o/r/pull/3');
    expect(r.host.querySelector('iframe')).toBeNull();
    expect(r.host.querySelector('.iframe-toolbar')?.textContent).toContain('Open outside');
    expect(r.host.querySelector('.iframe-browser')?.classList.contains('hosted')).toBe(false);
    Array.from(r.host.querySelectorAll('button')).find((button) => button.textContent === 'Open with sign-in support')!.click();
    expect(r.send).toHaveBeenLastCalledWith({ type: 'iframe-launch', workItemId: 1, url: 'https://github.com/o/r/pull/3' });
    r.browser.dispose(); r.host.remove();
  });
  it('keeps tab identities through row refreshes, closes and reopens links, and includes every attached link', async () => {
    const r = await rig(); r.browser.follow(row());
    const url = r.browser.tabs[1]!.url;
    expect(r.browser.open(url)).toBe(true); r.browser.follow(row());
    expect(r.browser.selected).toBe(url);
    r.browser.close(url); r.browser.follow(row());
    expect(r.browser.tabs.map((link) => link.url)).not.toContain(url);
    expect(r.browser.open(url)).toBe(true);
    const links = Array.from({ length: 15 }, (_, i) => ({ ...row().links[2]!, label: `Site ${i}`, url: `http://site${i}.test:8080/path?q=1#part` }));
    r.browser.follow({ ...row(), links: [...row().links, ...links] });
    expect(r.browser.tabs).toHaveLength(18);
    for (const link of links) expect(r.browser.open(link.url)).toBe(true);
    expect(r.browser.open('javascript:alert(1)')).toBe(false);
    r.browser.follow(row(2)); expect(r.browser.tabs).toHaveLength(3);
    expect(r.browser.selected).toBe('https://github.com/o/r/issues/2');
    r.browser.dispose(); r.host.remove();
  });
  it('holds a link focus through a work item change until its site rules are ready', async () => {
    const postMessage = vi.fn();
    const parent = vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window);
    try {
      const r = await rig();
      r.browser.follow(row()); await Promise.resolve(); await Promise.resolve();
      expect(r.browser.ready).toBe(true);
      let resolve!: (value: unknown) => void;
      r.send.mockImplementation(async () => new Promise((done) => { resolve = done; }));
      const next = { ...row(2), url: 'https://desk.zoho.com/agent/ticket/2', links: [{ ...row().links[2]!, url: 'https://forum.example.com/t/forum/topic' }] };
      r.browser.follow(next);
      expect(r.browser.ready).toBe(false);
      expect(r.browser.available).toBe(true);
      expect(r.browser.open(next.links[0]!.url, 2)).toBe(true);
      r.browser.place(true);
      expect(postMessage.mock.lastCall?.[0]).not.toHaveProperty('url');
      expect(r.send.mock.lastCall?.[0]).toEqual({ type: 'iframe-enable', urls: [next.url, next.links[0]!.url] });
      resolve({ ok: true }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(r.browser.ready).toBe(true);
      r.browser.draw(r.host, next, false);
      expect(r.browser.selected).toBe('https://forum.example.com/t/forum/topic');
      r.send.mockResolvedValue(null); await r.browser.renew();
      expect(r.browser.open(next.url)).toBe(false);
      r.browser.dispose(); r.host.remove();
    } finally { parent.mockRestore(); }
  });
  it('hides without clearing desired tabs on a failed renewal and clears them on disable', async () => {
    const postMessage = vi.fn();
    const parent = vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window);
    try {
      const r = await rig(); r.browser.follow(row()); await r.browser.renew(); await Promise.resolve(); await Promise.resolve(); r.browser.draw(r.host, row(), false);
      expect(r.host.querySelector('.iframe-toolbar')).toBeNull();
      expect(r.host.querySelector('.iframe-warning')).toBeNull();
      expect(r.host.querySelector('.iframe-browser.hosted')?.children).toHaveLength(1);
      const slot = r.host.querySelector<HTMLElement>('.iframe-slot')!;
      vi.spyOn(slot, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 80, width: 600, height: 400 } as DOMRect);
      r.browser.place(true);
      expect(postMessage.mock.lastCall?.[0]).toMatchObject({ item: 1, url: row().url, tabs: [row().url, row().links[0]!.url, row().links[2]!.url], width: 600 });
      r.send.mockResolvedValue(null); await r.browser.renew(); r.browser.place(true);
      expect(postMessage.mock.lastCall?.[0]).toMatchObject({ item: 1, tabs: [row().url, row().links[0]!.url, row().links[2]!.url] });
      expect(postMessage.mock.lastCall?.[0]).not.toHaveProperty('url');
      r.browser.configure(false);
      expect(postMessage.mock.lastCall?.[0]).toMatchObject({ item: null, tabs: [] });
      expect(r.send).toHaveBeenLastCalledWith({ type: 'iframe-disable' });
      r.browser.dispose(); r.host.remove();
    } finally { parent.mockRestore(); }
  });
  it('ignores enable answers after disable and offers recovery for missing extensions', async () => {
    let resolve!: (value: unknown) => void;
    const browser = new IframeBrowser({ send: (message) => message['type'] === 'iframe-check' ? new Promise((done) => { resolve = done; }) : Promise.resolve(null), changed: vi.fn(), external: vi.fn() });
    browser.configure(true); browser.configure(false); resolve({ ok: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); expect(browser.ready).toBe(false);
    const r = await rig(null); r.browser.draw(r.host, row(), false);
    expect(r.host.textContent).toContain('Load the experimental');
    r.browser.requireReload(); r.browser.draw(r.host, row(), false);
    expect(r.host.textContent).toContain('Reload Switchboard');
    r.browser.dispose(); r.host.remove();
  });
});
