import { describe, expect, it, vi } from 'vitest';
import { IframeBrowser, canInstallExtension, colorAlpha, frameCover, frameLink, frameUrl, frameLinks, githubItem, FRAME_HOLES_MAX } from '../src/iframeBrowser.js';
import type { PageRow } from '@switchboard/protocol';
const row = (id = 1): PageRow => ({ workItemId: id, ticket: `gh ${id}`, sourceKind: 'github', url: `https://github.com/o/r/issues/${id}`, links: [{ label: 'PR', url: 'https://github.com/o/r/pull/3', kind: 'pr' }, { label: 'Duplicate', url: `https://github.com/o/r/issues/${id}` }, { label: 'Other', url: 'https://example.com/' }] }) as PageRow;
async function rig(answer: unknown = { ok: true }) {
  const send = vi.fn(async (_message: Record<string, unknown>) => answer);
  const external = vi.fn();
  const extension = vi.fn();
  const browser = new IframeBrowser({ send, changed: vi.fn(), external, extension });
  const host = document.createElement('div');
  document.body.append(host);
  browser.configure(true);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  return { browser, host, send, external, extension };
}
describe('embedded browser tabs', () => {
  it('rejects unsafe sites and deduplicates row links', () => {
    for (const url of ['https://github.com/o/r', 'https://desk.zoho.com/agent/ticket/1', 'https://forum.example.com/t/2', 'http://localhost:5000/']) expect(frameUrl(url)).toBe(true);
    for (const url of ['bad', 'javascript:alert(1)', 'https://u:p@github.com/', 'file:///secret', 'data:text/html,no', 'http://localhost:47615/', 'http://127.0.0.1:47615/', `${location.origin}/page/`, `https://github.com/${'x'.repeat(2048)}`]) expect(frameUrl(url)).toBe(false);
    expect(frameLinks(null)).toEqual([]);
    expect(frameLinks(row()).map((link) => [link.label, link.name, link.icon])).toEqual([['#1', 'gh 1', 'issue'], ['#3', 'PR', 'pr'], ['Other', 'Other', 'web']]);
  });
  it('names a link tab by its item: #n for GitHub, the ticket number for another source, else its own name or host', () => {
    expect(githubItem('https://github.com/o/r/pull/22234/files')).toEqual({ kind: 'pr', number: '22234' });
    expect(githubItem('https://github.com/o/r/issues/21602#issuecomment-1')).toEqual({ kind: 'issue', number: '21602' });
    for (const url of ['https://github.com/o/r', 'https://github.com/o/r/issues', 'https://gitlab.com/o/r/issues/1', 'https://github.com/o/r/issues/1x', 'bad']) expect(githubItem(url)).toBeNull();
    // A GitHub link is #n whatever named it, a ticket of its source too.
    expect(frameLink('https://github.com/o/r/issues/5', 'gh 5', { kind: 'github', ticket: 'gh 5' })).toEqual({ url: 'https://github.com/o/r/issues/5', label: '#5', name: 'gh 5', icon: 'issue' });
    expect(frameLink('https://desk.zoho.com/agent/ticket/4521', 'zoho 4521', { kind: 'zoho', ticket: 'zoho 4521' })).toEqual({ url: 'https://desk.zoho.com/agent/ticket/4521', label: '4521', name: 'zoho 4521', icon: 'source', source: 'zoho' });
    expect(frameLink('https://example.com/a', 'Docs')).toMatchObject({ label: 'Docs', icon: 'web' });
    // A link without a name of its own, or named by its URL, as a bare link in the conversation is, takes its host.
    expect(frameLink('https://example.com/a', ' ')).toMatchObject({ label: 'example.com', name: 'example.com' });
    expect(frameLink('https://example.com/a', 'https://example.com/a')).toMatchObject({ label: 'example.com' });
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
  it("keeps each work item's link tabs, the added, the closed and the one selected, through another work item, the host's reconnect and a restore", async () => {
    const r = await rig(); r.browser.follow(row());
    const issue = 'https://github.com/o/r/issues/1';
    const pr = 'https://github.com/o/r/pull/3';
    const docs = 'https://docs.example.com/a';
    const urls = () => r.browser.tabs.map((link) => link.url);
    expect(r.browser.open(docs, 1, 'Docs')).toBe(true);
    r.browser.close(issue);
    expect(r.browser.kept(1)).toEqual({ open: [{ url: pr, name: 'PR' }, { url: 'https://example.com/', name: 'Other' }, { url: docs, name: 'Docs' }], closed: [issue], selected: docs });
    expect(r.browser.kept(2)).toBeNull();
    // Another work item and back.
    r.browser.follow(row(2)); expect(urls()).toEqual(['https://github.com/o/r/issues/2', pr, 'https://example.com/']);
    r.browser.follow(row()); expect(urls()).toEqual([pr, 'https://example.com/', docs]);
    expect(r.browser.selected).toBe(docs);
    // The row's links come again: the closed ticket link stays closed.
    r.browser.follow(row()); expect(urls()).not.toContain(issue);
    // The host's reconnect discards the frame; the tabs come back with the work item.
    r.browser.configure(false); r.browser.configure(true); await Promise.resolve(); await Promise.resolve();
    r.browser.follow(row()); expect(urls()).toEqual([pr, 'https://example.com/', docs]);
    expect(r.browser.selected).toBe(docs);
    // A restore for a work item not followed waits for it; a selection no longer among its tabs gives way to its first.
    r.browser.restore(2, { open: [{ url: 'https://docs.example.com/b', name: 'B' }], closed: [], selected: 'https://gone.example.com/' });
    expect(r.browser.kept(1)?.selected).toBe(docs);
    r.browser.follow(row(2)); expect(urls()).toEqual(['https://github.com/o/r/issues/2', pr, 'https://example.com/', 'https://docs.example.com/b']);
    expect(r.browser.tabs.at(-1)?.label).toBe('B');
    expect(r.browser.selected).toBe('https://github.com/o/r/issues/2');
    // A restore of the work item followed applies at once, and an unsafe link stays out.
    r.browser.restore(2, { open: [{ url: 'javascript:alert(1)', name: 'x' }], closed: [pr], selected: 'https://example.com/' });
    expect(urls()).toEqual(['https://github.com/o/r/issues/2', 'https://example.com/', 'https://docs.example.com/b']);
    expect(r.browser.selected).toBe('https://example.com/');
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
    const browser = new IframeBrowser({ send: (message) => message['type'] === 'iframe-check' ? new Promise((done) => { resolve = done; }) : Promise.resolve(null), changed: vi.fn(), external: vi.fn(), extension: vi.fn() });
    browser.configure(true); browser.configure(false); resolve({ ok: true });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); expect(browser.ready).toBe(false);
    const r = await rig(null); r.browser.follow(row());
    // Without the extension a link tab still selects, and its pane offers its link in a browser tab and the extension's download.
    expect(r.browser.select('https://example.com/')).toBe(true);
    expect(r.browser.select('https://not-a-tab.example.com/')).toBe(false);
    expect(r.browser.selected).toBe('https://example.com/');
    r.browser.draw(r.host, row(), false);
    expect(r.host.textContent).toContain('Load the experimental');
    const buttons = (): HTMLButtonElement[] => [...r.host.querySelectorAll('button')];
    expect(buttons().map((button) => button.textContent)).toEqual(['Open in a browser tab', 'Get the browser extension', 'Retry']);
    buttons()[0]!.click(); buttons()[1]!.click();
    expect(r.external.mock.calls).toEqual([['https://example.com/']]);
    expect(r.extension).toHaveBeenCalledTimes(1);
    // A closed tab selected again comes back.
    r.browser.close('https://github.com/o/r/pull/3'); r.browser.select('https://github.com/o/r/pull/3');
    expect(r.browser.tabs.map((link) => link.url)).toContain('https://github.com/o/r/pull/3');
    r.browser.requireReload(); r.browser.draw(r.host, row(), false);
    expect(buttons().map((button) => button.textContent)).toEqual(['Reload Switchboard']);
    r.browser.dispose(); r.host.remove();
  });
});

describe('frame cover', () => {
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
  const layer = (rect: DOMRect, style = '') => {
    const element = document.createElement('div');
    element.setAttribute('style', style);
    document.body.append(element);
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
    return element;
  };
  const slot = box(1000, 120, 900, 880);
  it('reads backdrop alphas, and an unreadable colour as opaque', () => {
    expect(colorAlpha('rgba(0, 0, 0, 0.45)')).toBe(0.45);
    expect(colorAlpha('rgb(0 0 0 / 40%)')).toBe(0.4);
    expect(colorAlpha('rgb(30, 30, 30)')).toBe(1);
    expect(colorAlpha('transparent')).toBe(0);
    expect(colorAlpha('color(srgb 0 0 0)')).toBe(1);
  });
  it('cuts only the layers over the frame, with their corner radius', () => {
    const menu = layer(box(1400, 100, 480, 400), 'border-top-left-radius: 6px');
    const beside = layer(box(300, 60, 400, 540));
    const hidden = layer(box(0, 0, 0, 0));
    expect(frameCover(slot, [menu, beside, hidden, menu], [])).toEqual({ holes: [{ left: 1400, top: 100, width: 480, height: 400, radius: 6 }], dim: 0, modal: false, hide: false });
    document.body.replaceChildren();
  });
  it('darkens a modal frame by its backdrops, hides it under an opaque one, and hides it with more layers than the host takes', () => {
    const sheet = layer(box(0, 0, 1920, 1080), 'background-color: rgba(0, 0, 0, 0.4)');
    const drawer = layer(box(0, 0, 1920, 1080), 'background-color: rgba(0, 0, 0, 0.25)');
    const away = layer(box(0, 0, 500, 500), 'background-color: rgba(0, 0, 0, 0.5)');
    expect(frameCover(slot, [], [sheet, away])).toMatchObject({ dim: 0.4, modal: true, hide: false });
    expect(frameCover(slot, [], [sheet, drawer])).toMatchObject({ dim: 0.55, modal: true, hide: false });
    expect(frameCover(slot, [], [], true)).toMatchObject({ dim: 0, modal: true, hide: false });
    expect(frameCover(slot, [], [layer(box(0, 0, 1920, 1080), 'background-color: rgb(30, 30, 30)')])).toMatchObject({ modal: true, hide: true });
    const many = Array.from({ length: FRAME_HOLES_MAX + 1 }, (_, i) => layer(box(1000 + i * 10, 200, 5, 5)));
    expect(frameCover(slot, many.slice(1), [])).toMatchObject({ hide: false });
    expect(frameCover(slot, many, [])).toMatchObject({ hide: true });
    document.body.replaceChildren();
  });
  it("sends the cover with the frame's place, and no place when the cover hides it", async () => {
    const postMessage = vi.fn();
    const parent = vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window);
    try {
      const r = await rig(); r.browser.follow(row()); await r.browser.renew(); await Promise.resolve(); await Promise.resolve(); r.browser.draw(r.host, row(), false);
      vi.spyOn(r.host.querySelector<HTMLElement>('.iframe-slot')!, 'getBoundingClientRect').mockReturnValue(slot);
      expect(r.browser.holes).toBe(false);
      expect(r.browser.holesAnswered()).toBe(true);
      expect(r.browser.holesAnswered()).toBe(false);
      expect(r.browser.holes).toBe(true);
      const holes = [{ left: 1400, top: 100, width: 480, height: 400, radius: 6 }];
      r.browser.place(true, { holes, dim: 0.4, modal: true, hide: false });
      expect(postMessage.mock.lastCall?.[0]).toMatchObject({ url: row().url, left: 1000, holes, dim: 0.4, modal: true });
      r.browser.place(true, { holes, dim: 1, modal: true, hide: true });
      expect(postMessage.mock.lastCall?.[0]).not.toHaveProperty('url');
      expect(postMessage.mock.lastCall?.[0]).not.toHaveProperty('holes');
      r.browser.place(true);
      expect(postMessage.mock.lastCall?.[0]).not.toHaveProperty('holes');
      r.browser.dispose(); r.host.remove();
    } finally { parent.mockRestore(); }
  });
});

describe('canInstallExtension', () => {
  const agents = {
    chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
    chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1',
    safariIpad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    firefoxWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
    chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
    chromeAndroidTablet: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  };
  const brands = (...names: string[]) => names.map((brand) => ({ brand }));

  it('CanInstallExtension_DesktopChromeOrEdgeUserAgent_IsTrue', () => {
    expect([agents.chromeWindows, agents.edgeWindows, agents.chromeMac].map((userAgent) => canInstallExtension({ userAgent }))).toEqual([true, true, true]);
  });

  it('CanInstallExtension_SafariFirefoxIosOrAndroidUserAgent_IsFalse', () => {
    const cannot = [agents.safariIphone, agents.chromeIphone, agents.safariIpad, agents.safariMac, agents.firefoxWindows, agents.chromeAndroid, agents.chromeAndroidTablet];

    expect(cannot.map((userAgent) => canInstallExtension({ userAgent }))).toEqual(cannot.map(() => false));
  });

  it('CanInstallExtension_ClientHints_DecideOverTheUserAgentString', () => {
    // Chrome and Edge on a desktop name Chromium among their brands and are not mobile.
    expect(canInstallExtension({ userAgent: '', userAgentData: { brands: brands('Chromium', 'Google Chrome', 'Not_A Brand'), mobile: false, platform: 'Windows' } })).toBe(true);
    expect(canInstallExtension({ userAgent: '', userAgentData: { brands: brands('Chromium', 'Microsoft Edge'), mobile: false, platform: 'macOS' } })).toBe(true);
    // A phone, or an Android tablet, which reports itself as not mobile, cannot, whatever its string says.
    expect(canInstallExtension({ userAgent: agents.chromeWindows, userAgentData: { brands: brands('Chromium', 'Google Chrome'), mobile: true, platform: 'Android' } })).toBe(false);
    expect(canInstallExtension({ userAgent: agents.chromeWindows, userAgentData: { brands: brands('Chromium', 'Google Chrome'), mobile: false, platform: 'Android' } })).toBe(false);
    // Android Chrome in desktop mode names itself desktop Linux; with no fine pointer it counts as the tablet it is.
    const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
    const desktopMode = { brands: brands('Chromium', 'Google Chrome'), mobile: false, platform: 'Linux' };

    expect(canInstallExtension({ userAgent: linux, userAgentData: desktopMode, finePointer: false })).toBe(false);
    expect(canInstallExtension({ userAgent: linux, finePointer: false })).toBe(false);
    expect(canInstallExtension({ userAgent: linux, userAgentData: desktopMode, finePointer: true })).toBe(true);
    expect(canInstallExtension({ userAgent: linux, finePointer: true })).toBe(true);
    // ChromeOS keeps its extensions, mouse or not.
    expect(canInstallExtension({ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', finePointer: false })).toBe(true);
    // No brands, as before the hints are read: the string decides.
    expect(canInstallExtension({ userAgent: agents.chromeWindows, userAgentData: { brands: [], mobile: false, platform: '' } })).toBe(true);
  });
});
