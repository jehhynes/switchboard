import { describe, expect, it, vi } from 'vitest';
import { IframeLauncher } from '../src/iframeLaunch.js';
import type { HostTab } from '../src/iframeLaunch.js';
const host = 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije/iframeHost.html';
describe('iframe host launch', () => {
  it('serializes creation, reuses the same origin, and avoids reloading its current work item', async () => {
    const tabs: HostTab[] = [];
    const create = vi.fn(async (url: string) => { tabs.push({ id: 4, windowId: 7, pendingUrl: url }); });
    const update = vi.fn(async (_id: number, url?: string) => { if (url !== undefined) tabs[0]!.pendingUrl = url; });
    const focus = vi.fn(async () => {});
    const launcher = new IframeLauncher({ host, remote: null, tabs: async () => tabs, create, update, focus });
    await Promise.all([launcher.open('http://localhost:4000', 12), launcher.open('http://localhost:4000', 12)]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(new URL(tabs[0]!.pendingUrl!).hash.slice(1)).get('workItemId')).toBe('12');
    expect(new URL(update.mock.lastCall![1]!).search).toBe(new URL(tabs[0]!.pendingUrl!).search);
    await launcher.open('http://localhost:4000', 13);
    expect(new URLSearchParams(new URL(update.mock.lastCall![1]!).hash.slice(1)).get('workItemId')).toBe('13');
    expect(focus).toHaveBeenLastCalledWith(7);
  });
  it('rejects forged origins and work items and recovers after failure', async () => {
    const create = vi.fn(async (_url: string) => {});
    const launcher = new IframeLauncher({ host, remote: 'https://pc.tail.ts.net', tabs: async () => [{ id: 1, url: `${host}?origin=https%3A%2F%2Fpc.tail.ts.net.evil.test` }], create, update: vi.fn(), focus: vi.fn() });
    for (const item of [0, -1, 1.5, '12', Infinity]) await expect(launcher.open('https://pc.tail.ts.net', item)).rejects.toThrow('Invalid work item');
    await expect(launcher.open('https://evil.test', 1)).rejects.toThrow('Invalid Switchboard origin');
    await launcher.open('https://pc.tail.ts.net', null);
    expect(create).toHaveBeenCalledTimes(1);
    await launcher.open('https://pc.tail.ts.net', 3, 'https://github.com/o/r/pull/8');
    const target = new URL(create.mock.lastCall![0]!);
    expect(new URLSearchParams(target.hash.slice(1)).get('url')).toBe('https://github.com/o/r/pull/8');
    for (const url of ['https://evil.test/', 'https://u:p@github.com/', 'javascript:alert(1)', 12]) await expect(launcher.open('https://pc.tail.ts.net', 3, url)).rejects.toThrow();
  });
});
