// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { IframeRules, iframePage, iframeRule, iframeTab, iframeEnabled, IFRAME_LEASE_MS } from '../src/iframe.js';
import type { IframeLease, IframeRule, IframeSender } from '../src/iframe.js';

const sender: IframeSender = { origin: 'https://pc.tail.ts.net', url: 'https://pc.tail.ts.net/page/', frameId: 1, tab: { id: 7 } };
function rig(remote: string | null = 'https://pc.tail.ts.net') {
  const state = {
    now: 1000,
    url: 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije/iframeHost.html?origin=https%3A%2F%2Fpc.tail.ts.net' as string | undefined,
    enabled: true,
    fail: false,
    leases: {} as Record<string, IframeLease>,
    rules: [] as IframeRule[],
    checks: [] as string[],
  };
  const rules = new IframeRules({
    origin: remote,
    now: () => state.now,
    tab: async () => state.url,
    enabled: async (origin) => {
      state.checks.push(origin);
      if (state.fail) throw new Error('offline');
      return state.enabled;
    },
    leases: async () => structuredClone(state.leases),
    save: async (leases) => {
      state.leases = structuredClone(leases);
    },
    rules: async () => state.rules,
    update: async (remove, add) => {
      state.rules = [...state.rules.filter((rule) => !remove.includes(rule.id)), ...add];
    },
  });
  return { state, rules, enable: (from = sender) => rules.external({ type: 'iframe-enable' }, from) };
}
describe('GitHub iframe header exceptions', () => {
  it('probes an ordinary page without installing or keeping a header exception', async () => {
    const r = rig();
    r.state.url = sender.url;
    const ordinary = { ...sender, frameId: 0 };
    expect(await r.rules.external({ type: 'iframe-check' }, ordinary)).toEqual({ ok: true });
    expect(await r.enable(ordinary)).toEqual({ ok: true });
    expect(r.state.rules).toEqual([]);
    expect(r.state.leases).toEqual({});
  });
  it('restricts exceptions to one tab, the Switchboard top domain and exact HTTPS GitHub subframes', () => {
    expect(iframeRule(7, 'https://pc.tail.ts.net')).toEqual({
      id: 8,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
        ],
      },
      condition: { tabIds: [7], topDomains: ['pc.tail.ts.net'], regexFilter: '^https://github\\.com/', resourceTypes: ['sub_frame'] },
    });
  });
  it('accepts the exact remote origin and loopback page, refusing other origins and paths', () => {
    expect(iframePage('http://127.0.0.1:4000/page/#w=1', null)).toBe('http://127.0.0.1:4000');
    expect(iframePage('http://localhost:4000/page/', null)).toBe('http://localhost:4000');
    for (const url of [undefined, 'bad', 'https://evil.test/page/', 'http://127.0.0.1:4000/other', 'https://u:p@pc.tail.ts.net/page/', 'http://pc.tail.ts.net/page/'])
      expect(iframePage(url, 'https://pc.tail.ts.net')).toBeNull();
    expect(iframePage('https://evil.test/page/', null)).toBeNull();
  });
  it('requires a top-level page sender, a matching tab, the setting and the page sign-in before adding a rule', async () => {
    const r = rig();
    for (const invalid of [
      { ...sender, frameId: 0 },
      { ...sender, origin: 'https://evil.test' },
      { ...sender, url: 'https://evil.test/page/' },
      { ...sender, tab: {} },
      { ...sender, tab: { id: -1 } },
    ])
      expect(await r.enable(invalid)).toHaveProperty('error');
    expect(await r.rules.external({ type: 'unknown' }, sender)).toHaveProperty('error');
    expect(r.state.rules).toEqual([]);
    expect(r.state.checks).toEqual([]);
    r.state.enabled = false;
    expect(await r.enable()).toHaveProperty('error');
    expect(r.state.rules).toEqual([]);
    r.state.enabled = true;
    r.state.url = 'https://evil.test/';
    expect(await r.enable()).toHaveProperty('error');
    r.state.url = 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije/iframeHost.html?origin=https%3A%2F%2Fpc.tail.ts.net';
    expect(await r.enable()).toEqual({ ok: true });
    expect(r.state.rules).toHaveLength(1);
    expect(r.state.leases).toEqual({ '7': { origin: 'https://pc.tail.ts.net', until: 91000 } });
    expect(await r.rules.external({ type: 'iframe-disable' }, sender)).toEqual({ ok: true });
    expect(r.state.rules).toEqual([]);
    expect(r.state.leases).toEqual({});
  });
  it('keeps rules across worker restarts and hash navigation, and removes them on navigation away, closure, expiry, sign-out or a failed check', async () => {
    const r = rig();
    await r.enable();
    await r.rules.sweep();
    expect(r.state.rules).toHaveLength(1);
    r.state.url += '#w=2';
    await r.rules.navigated(7);
    expect(r.state.rules).toHaveLength(1);
    r.state.url = 'https://github.com/';
    await r.rules.navigated(7);
    expect(r.state.rules).toEqual([]);
    r.state.url = 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije/iframeHost.html?origin=https%3A%2F%2Fpc.tail.ts.net';
    for (const reason of ['closed', 'expired', 'off', 'offline']) {
      r.state.enabled = true;
      r.state.fail = false;
      await r.enable();
      expect(r.state.rules).toHaveLength(1);
      if (reason === 'closed') r.state.url = undefined;
      if (reason === 'expired') r.state.now += IFRAME_LEASE_MS;
      if (reason === 'off') r.state.enabled = false;
      if (reason === 'offline') r.state.fail = true;
      await r.rules.sweep();
      expect(r.state.rules).toEqual([]);
      expect(r.state.leases).toEqual({});
      r.state.url = 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije/iframeHost.html?origin=https%3A%2F%2Fpc.tail.ts.net';
    }
    await r.rules.remove(7);
    expect(r.state.rules).toEqual([]);
  });
  it('serializes enable and close, so a late enable cannot restore a removed exception', async () => {
    const r = rig();
    const enabling = r.enable();
    const closing = r.rules.remove(7);
    await Promise.all([enabling, closing]);
    expect(r.state.rules).toEqual([]);
    expect(r.state.leases).toEqual({});
    r.state.fail = true;
    expect(await r.enable()).toHaveProperty('error');
    expect(r.state.rules).toEqual([]);
  });
});

describe('iframe host authentication', () => {
  it('checks the fixed local hub before trusting any loopback page, and requires the configured remote origin', async () => {
    const asked: string[] = [];
    const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
    const fetch = async (url: string) => {
      asked.push(url);
      return reply(url.endsWith('/iframe') && !url.includes('/v1/') ? { enabled: true, origins: ['http://127.0.0.1:4000'] } : { enabled: true });
    };
    expect(await iframeEnabled(fetch, 'http://127.0.0.1:9999', null)).toBe(false);
    expect(asked).toEqual(['http://127.0.0.1:47615/iframe']);
    asked.length = 0;
    expect(await iframeEnabled(fetch, 'http://127.0.0.1:4000', null)).toBe(true);
    expect(asked).toEqual(['http://127.0.0.1:47615/iframe', 'http://127.0.0.1:4000/v1/browser/iframe']);
    expect(await iframeEnabled(fetch, 'https://evil.test', 'https://pc.tail.ts.net')).toBe(false);
    expect(await iframeEnabled(fetch, 'https://pc.tail.ts.net', 'https://pc.tail.ts.net')).toBe(true);
    expect(await iframeEnabled(async () => reply({}, false), 'http://127.0.0.1:4000', null)).toBe(false);
    expect(
      await iframeEnabled(
        async () => {
          throw new Error('offline');
        },
        'https://pc.tail.ts.net',
        'https://pc.tail.ts.net',
      ),
    ).toBe(false);
    expect(await iframeEnabled(async () => reply({ enabled: false }), 'https://pc.tail.ts.net', 'https://pc.tail.ts.net')).toBe(false);
  });
  it('accepts only the fixed extension host page and its verified Switchboard child', async () => {
    const host = 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije/iframeHost.html?origin=https%3A%2F%2Fpc.tail.ts.net';
    expect(iframeTab(host, 'https://pc.tail.ts.net')).toEqual({ origin: 'https://pc.tail.ts.net', hosted: true });
    for (const url of [
      undefined,
      'bad',
      host.replace('/iframeHost.html', '/other.html'),
      host.replace('hlbibnhgkgnjkbfledhgjblacloneije', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      host.replace('pc.tail.ts.net', 'evil.test'),
      host.split('?')[0],
    ])
      expect(iframeTab(url, 'https://pc.tail.ts.net')).toBeNull();
    const r = rig();
    r.state.url = host;
    expect(await r.enable({ ...sender, frameId: 0 })).toHaveProperty('error');
    expect(await r.enable({ ...sender, frameId: 3 })).toEqual({ ok: true });
    expect(r.state.rules[0]?.condition.topDomains).toEqual(['hlbibnhgkgnjkbfledhgjblacloneije']);
    await r.rules.sweep();
    expect(r.state.rules).toHaveLength(1);
    expect(await r.rules.external({ type: 'iframe-launch' }, { ...sender, frameId: 3 })).toEqual({ ok: true });
    await r.rules.remove(7);
    expect(r.state.rules).toEqual([]);
  });
});
