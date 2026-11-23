import { describe, expect, it, vi } from 'vitest';
import { IframeBrowser, githubFrameUrl, githubLinks } from '../src/iframeBrowser.js';
import type { PageRow } from '@switchboard/protocol';
const row = (id = 1): PageRow => ({ workItemId: id, url: `https://github.com/o/r/issues/${id}`, links: [{ label: 'PR', url: 'https://github.com/o/r/pull/3', kind: 'pr' }, { label: 'Duplicate', url: `https://github.com/o/r/issues/${id}` }, { label: 'Other', url: 'https://example.com/' }] }) as PageRow;
async function rig(answer: unknown = { ok: true }) {
  const send = vi.fn(async (_message: Record<string, unknown>) => answer);
  const browser = new IframeBrowser({ send, changed: vi.fn(), external: vi.fn() });
  const host = document.createElement('div');
  document.body.append(host);
  browser.configure(true);
  await Promise.resolve(); await Promise.resolve();
  return { browser, host, send };
}
describe('embedded GitHub tabs', () => {
  it('rejects unsafe sites and deduplicates row links', () => {
    expect(githubFrameUrl('https://github.com/o/r')).toBe(true);
    for (const url of ['bad', 'javascript:alert(1)', 'https://github.com.evil.test/', 'https://u:p@github.com/', 'http://github.com/', 'https://github.com:444/', `https://github.com/${'x'.repeat(2048)}`]) expect(githubFrameUrl(url)).toBe(false);
    expect(githubLinks(null)).toEqual([]);
    expect(githubLinks(row()).map((link) => link.label)).toEqual(['Ticket', 'PR']);
  });
  it('launches the selected work item from an ordinary page without creating signed-out frames', async () => {
    const r = await rig();
    r.browser.follow(row(), true); r.browser.draw(r.host, row(), true);
    expect(r.browser.selected).toBe('https://github.com/o/r/pull/3');
    expect(r.host.querySelector('iframe')).toBeNull();
    Array.from(r.host.querySelectorAll('button')).find((button) => button.textContent === 'Open with sign-in support')!.click();
    expect(r.send).toHaveBeenLastCalledWith({ type: 'iframe-launch', workItemId: 1, url: 'https://github.com/o/r/pull/3' });
    r.browser.dispose(); r.host.remove();
  });
  it('keeps tab identities through row refreshes, closes and reopens links, and bounds the tab count', async () => {
    const r = await rig(); r.browser.follow(row());
    const url = r.browser.tabs[1]!.url;
    expect(r.browser.open(url)).toBe(true); r.browser.follow(row());
    expect(r.browser.selected).toBe(url);
    r.browser.close(url); r.browser.follow(row());
    expect(r.browser.tabs.map((link) => link.url)).not.toContain(url);
    expect(r.browser.open(url)).toBe(true);
    for (let i = 0; i < 8; i++) expect(r.browser.open(`https://github.com/o/r/pull/${i + 10}`)).toBe(true);
    expect(r.browser.open('https://github.com/o/r/pull/99')).toBe(false);
    expect(r.browser.open('https://evil.test')).toBe(false);
    r.browser.close(url);
    expect(r.browser.open('https://github.com/o/r/pull/99')).toBe(true);
    expect(r.browser.open(url)).toBe(false);
    r.browser.follow(row(2)); expect(r.browser.tabs).toHaveLength(2);
    expect(r.browser.selected).toBe('https://github.com/o/r/issues/2');
    r.browser.dispose(); r.host.remove();
  });
  it('hides without clearing desired tabs on a failed renewal and clears them on disable', async () => {
    const postMessage = vi.fn();
    const parent = vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window);
    try {
      const r = await rig(); r.browser.draw(r.host, row(), false);
      const slot = r.host.querySelector<HTMLElement>('.iframe-slot')!;
      vi.spyOn(slot, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 80, width: 600, height: 400 } as DOMRect);
      r.browser.place(true);
      expect(postMessage.mock.lastCall?.[0]).toMatchObject({ item: 1, url: row().url, tabs: [row().url, row().links[0]!.url], width: 600 });
      r.send.mockResolvedValue(null); await r.browser.renew(); r.browser.place(true);
      expect(postMessage.mock.lastCall?.[0]).toMatchObject({ item: 1, tabs: [row().url, row().links[0]!.url] });
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
    await Promise.resolve(); await Promise.resolve(); expect(browser.ready).toBe(false);
    const r = await rig(null); r.browser.draw(r.host, row(), false);
    expect(r.host.textContent).toContain('Load the experimental');
    r.browser.requireReload(); r.browser.draw(r.host, row(), false);
    expect(r.host.textContent).toContain('Reload Switchboard');
    r.browser.dispose(); r.host.remove();
  });
});
