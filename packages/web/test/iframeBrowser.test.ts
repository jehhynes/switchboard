import { describe, expect, it, vi } from 'vitest';
import { IframeBrowser, githubFrameUrl, githubLinks } from '../src/iframeBrowser.js';
import type { PageRow } from '@switchboard/protocol';
const row = (id = 1): PageRow =>
  ({
    workItemId: id,
    url: `https://github.com/o/r/issues/${id}`,
    links: [
      { label: 'PR', url: 'https://github.com/o/r/pull/3', kind: 'pr' },
      { label: 'Duplicate', url: `https://github.com/o/r/issues/${id}` },
      { label: 'Other', url: 'https://example.com/' },
    ],
  }) as PageRow;
async function rig(answer: unknown = { ok: true }) {
  const send = vi.fn(async (_message: Record<string, unknown>) => answer);
  const changed = vi.fn();
  const external = vi.fn();
  const browser = new IframeBrowser({ send, changed, external });
  const host = document.createElement('div');
  browser.configure(true);
  await browser.renew();
  await Promise.resolve();
  return { browser, host, send, changed, external };
}
describe('the GitHub iframe experiment', () => {
  it('accepts only exact GitHub HTTPS links and deduplicates work item links', () => {
    expect(githubFrameUrl('https://github.com/o/r')).toBe(true);
    for (const url of [
      'bad',
      'javascript:alert(1)',
      'https://github.com.evil.test/',
      'https://u:p@github.com/',
      'http://github.com/',
      'https://github.com:444/',
      `https://github.com/${'x'.repeat(2048)}`,
    ])
      expect(githubFrameUrl(url)).toBe(false);
    expect(githubLinks(null)).toEqual([]);
    expect(githubLinks(row())).toEqual([
      { url: 'https://github.com/o/r/issues/1', label: 'Ticket' },
      { url: 'https://github.com/o/r/pull/3', label: 'PR' },
    ]);
  });
  it('creates no iframe before the extension confirms the rule, and exposes retry for absence or refusal', async () => {
    const r = await rig(null);
    r.browser.draw(r.host, row(), false);
    expect(r.host.querySelector('iframe')).toBeNull();
    expect(r.host.textContent).toContain('Load the experimental');
    r.send.mockResolvedValue({ error: 'Signed out' });
    r.host.querySelector('button')!.click();
    await Promise.resolve();
    await Promise.resolve();
    r.browser.draw(r.host, row(), false);
    expect(r.host.textContent).toContain('Signed out');
    expect(r.browser.ready).toBe(false);
    r.send.mockResolvedValue({ ok: true });
    await r.browser.renew();
    r.browser.draw(r.host, row(), false);
    expect(r.host.querySelector('iframe')?.src).toBe('https://github.com/o/r/issues/1');
    expect(r.host.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
    r.browser.dispose();
  });
  it('keeps the same frame across redraws, chooses a PR in review, switches links and opens externally', async () => {
    const r = await rig();
    expect(r.changed).toHaveBeenLastCalledWith(true);
    await r.browser.renew();
    expect(r.changed).toHaveBeenLastCalledWith(false);
    r.browser.draw(r.host, row(), true);
    const frame = r.host.querySelector('iframe')!;
    const keptSelect = r.host.querySelector('select')!;
    r.browser.draw(r.host, row(), true);
    expect(r.host.querySelector('select')).toBe(keptSelect);
    expect(frame.src).toBe('https://github.com/o/r/pull/3');
    frame.setAttribute('data-kept', '1');
    r.browser.draw(r.host, row(), true);
    expect(r.host.querySelector('iframe')).toBe(frame);
    const select = r.host.querySelector('select')!;
    select.value = 'https://github.com/o/r/issues/1';
    select.dispatchEvent(new Event('change'));
    r.browser.draw(r.host, row(), true);
    expect(frame.src).toBe('https://github.com/o/r/issues/1');
    r.host.querySelectorAll('button')[0]!.click();
    r.host.querySelectorAll('button')[1]!.click();
    expect(r.external).toHaveBeenCalledWith('https://github.com/o/r/issues/1');
    expect(r.browser.open('https://evil.test')).toBe(false);
    expect(r.browser.open('https://github.com/o/r/discussions/4')).toBe(true);
    r.browser.draw(r.host, row(), true);
    expect(frame.src).toBe('https://github.com/o/r/discussions/4');
    r.browser.draw(r.host, row(2), false);
    expect(r.host.querySelector('iframe')).not.toBe(frame);
    expect(r.host.querySelector('iframe')!.src).toBe('https://github.com/o/r/issues/2');
    r.browser.dispose();
  });
  it('opens a reply link on the first Browser draw and clears the frame when rules or the setting stop', async () => {
    const r = await rig();
    expect(r.browser.open('https://github.com/o/r/pull/8', 1)).toBe(true);
    r.browser.draw(r.host, row(), false);
    expect(r.host.querySelector('iframe')!.src).toBe('https://github.com/o/r/pull/8');
    r.send.mockResolvedValue(null);
    await r.browser.renew();
    expect(r.host.querySelector('iframe')).toBeNull();
    r.browser.configure(false);
    expect(r.send).toHaveBeenLastCalledWith({ type: 'iframe-disable' });
    expect(r.browser.ready).toBe(false);
    expect(r.browser.open('https://github.com')).toBe(false);
  });
  it('ignores an enable answer that arrives after disable and handles a failed extension request', async () => {
    let resolve!: (value: unknown) => void;
    const send = vi.fn((message: Record<string, unknown>) =>
      message['type'] === 'iframe-enable'
        ? new Promise<unknown>((done) => {
            resolve = done;
          })
        : Promise.resolve({ ok: true }),
    );
    const browser = new IframeBrowser({ send, changed: vi.fn(), external: vi.fn() });
    browser.configure(true);
    browser.configure(false);
    resolve({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(browser.ready).toBe(false);
    const failed = new IframeBrowser({
      send: async () => {
        throw new Error('disconnected');
      },
      changed: vi.fn(),
      external: vi.fn(),
    });
    failed.configure(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(failed.ready).toBe(false);
    failed.dispose();
  });

  it('uses a sibling frame in the extension host and reports only its visible area, with explicit reload', async () => {
    const postMessage = vi.fn();
    const parent = vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window);
    try {
      const r = await rig();
      document.body.append(r.host);
      r.browser.draw(r.host, row(), false);
      expect(r.host.querySelector('iframe')).toBeNull();
      const slot = r.host.querySelector<HTMLElement>('.iframe-slot')!;
      vi.spyOn(slot, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 80, width: 600, height: 400 } as DOMRect);
      r.browser.place(true);
      expect(postMessage).toHaveBeenLastCalledWith(
        { type: 'switchboard-iframe', title: document.title, url: 'https://github.com/o/r/issues/1', left: 100, top: 80, width: 600, height: 400, reload: false },
        'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije',
      );
      r.host.querySelector('button')!.click();
      r.browser.place(true);
      expect(postMessage.mock.lastCall?.[0]).toMatchObject({ reload: true });
      r.browser.place(false);
      expect(postMessage.mock.lastCall?.[0]).toEqual({ type: 'switchboard-iframe', title: document.title });
      r.browser.requireReload();
      r.browser.draw(r.host, row(), false);
      expect(r.host.textContent).toContain('Reload Switchboard');
      expect(r.host.querySelector('.iframe-slot')).toBeNull();
      r.browser.dispose();
      r.host.remove();
    } finally {
      parent.mockRestore();
    }
  });
});
