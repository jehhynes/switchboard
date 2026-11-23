import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadedIcon, shortcutRequest } from '../src/shortcut.js';

function downloads(state: 'complete' | 'in_progress' | 'interrupted' | 'missing' = 'complete') {
  let listener: ((change: { id: number }) => void) | null = null;
  const api = {
    download: vi.fn(async () => 7),
    search: vi.fn(async () => state === 'missing' ? [] : [{ filename: 'D:\\My downloads\\Switchboard\\switchboard.ico', state } as chrome.downloads.DownloadItem]),
    onChanged: { addListener: vi.fn((next) => { listener = next; }), removeListener: vi.fn(() => { listener = null; }) },
  } satisfies Pick<typeof chrome.downloads, 'download' | 'search' | 'onChanged'>;
  return { api, change: (id: number) => listener?.({ id }) };
}

afterEach(() => vi.useRealTimers());
describe('shortcut icon download', () => {
  it('uses the browser-reported path, not an assumed Downloads folder, and removes its listener', async () => {
    const { api } = downloads();
    expect(await downloadedIcon(api, 'chrome-extension://test/switchboard.ico')).toBe('D:\\My downloads\\Switchboard\\switchboard.ico');
    expect(api.download).toHaveBeenCalledWith({ url: 'chrome-extension://test/switchboard.ico', filename: 'Switchboard/switchboard.ico', conflictAction: 'overwrite', saveAs: false });
    expect(api.onChanged.removeListener).toHaveBeenCalledOnce();
  });
  it('waits for its own download and handles completion after the first search', async () => {
    const { api, change } = downloads('in_progress');
    const pending = downloadedIcon(api, 'icon');
    await vi.waitFor(() => expect(api.search).toHaveBeenCalledOnce());
    change(8); expect(api.search).toHaveBeenCalledOnce();
    api.search.mockResolvedValue([{ state: 'complete', filename: 'C:\\Downloads\\Switchboard\\switchboard.ico' }]);
    change(7);
    await expect(pending).resolves.toContain('C:\\Downloads');
    expect(api.onChanged.removeListener).toHaveBeenCalledOnce();
  });
  it.each(['interrupted', 'missing'] as const)('refuses a %s download', async (state) => {
    const { api } = downloads(state);
    await expect(downloadedIcon(api, 'icon')).rejects.toThrow('did not finish');
    expect(api.onChanged.removeListener).toHaveBeenCalledOnce();
  });
  it('reports download/search failures and times out without leaving a listener', async () => {
    const failed = downloads(); failed.api.download.mockRejectedValue(new Error('blocked'));
    await expect(downloadedIcon(failed.api, 'icon')).rejects.toThrow('blocked');
    const search = downloads(); search.api.search.mockRejectedValue(new Error('lost'));
    await expect(downloadedIcon(search.api, 'icon')).rejects.toThrow('Could not find');
    vi.useFakeTimers(); const waiting = downloads('in_progress');
    const pending = expect(downloadedIcon(waiting.api, 'icon')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000); await pending;
    expect(waiting.api.onChanged.removeListener).toHaveBeenCalledOnce();
  });
});


describe('shortcut request authorization', () => {
  it.each([
    [{ origin: 'https://evil.test', url: 'https://evil.test/page/' }, 'https://pc.tail.ts.net'],
    [{ origin: 'https://evil.test', url: 'https://pc.tail.ts.net/page/' }, 'https://pc.tail.ts.net'],
    [{ origin: 'https://pc.tail.ts.net', url: 'https://pc.tail.ts.net/other/' }, 'https://pc.tail.ts.net'],
    [{ origin: 'http://127.0.0.1:64926', url: 'http://127.0.0.1:64926/page/' }, 'https://pc.tail.ts.net'],
  ] as const)('refuses an unconfigured or mismatched requesting page without downloading', async (sender, remote) => {
    const enabled = vi.fn(async () => true), save = vi.fn(async () => 'icon');
    expect(await shortcutRequest(sender, remote, enabled, save)).toHaveProperty('error');
    expect(enabled).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it('requires live embedding authorization and downloads only after it passes', async () => {
    const sender = { origin: 'http://127.0.0.1:64926', url: 'http://127.0.0.1:64926/page/' };
    const enabled = vi.fn(async () => false), save = vi.fn(async () => 'icon');
    expect(await shortcutRequest(sender, null, enabled, save)).toHaveProperty('error');
    expect(save).not.toHaveBeenCalled();
    enabled.mockResolvedValue(true);
    expect(await shortcutRequest(sender, null, enabled, save)).toEqual({ icon: 'icon' });
    expect(save).toHaveBeenCalledOnce();
    expect(enabled).toHaveBeenLastCalledWith(sender.origin);
  });
});
