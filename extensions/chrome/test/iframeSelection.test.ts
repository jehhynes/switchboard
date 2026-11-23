import { describe, expect, it, vi } from 'vitest';
import { consumeSelection } from '../src/iframeSelection.js';
const base = 'chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije/iframeHost.html?origin=http%3A%2F%2Flocalhost%3A4000';
describe('host selection handoff', () => {
  it('consumes each launch once and does not replay it on an app reload', () => {
    let href = `${base}#workItemId=2&url=https%3A%2F%2Fgithub.com%2Fo%2Fr&request=first`;
    const send = vi.fn();
    const replace = (value: string) => { href = value; };
    expect(consumeSelection(href, send, replace)).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ workItemId: 2, url: 'https://github.com/o/r' });
    expect(href).toBe(base);
    expect(consumeSelection(href, send, replace)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(consumeSelection(`${base}#workItemId=3&request=next`, send, replace)).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ workItemId: 3, url: null });
    for (const url of ['https://desk.zoho.com/agent/ticket/1', 'https://forum.example.com/t/2', 'http://localhost:5000/path?q=1#part']) {
      expect(consumeSelection(`${base}#workItemId=3&url=${encodeURIComponent(url)}`, send, replace)).toBe(true);
      expect(send).toHaveBeenLastCalledWith({ workItemId: 3, url });
    }
  });
  it('refuses unsafe items and links without posting or consuming them', () => {
    const send = vi.fn(), replace = vi.fn();
    for (const hash of ['workItemId=0', 'workItemId=-1', 'workItemId=1.5', 'workItemId=2&url=bad', 'workItemId=2&url=http%3A%2F%2Flocalhost%3A4000%2Fpage%2F', 'workItemId=2&url=http%3A%2F%2F127.0.0.1%3A4000%2Fpage%2F', 'workItemId=2&url=file%3A%2F%2F%2Fsecret', 'workItemId=2&url=https%3A%2F%2Fu%3Ap%40github.com']) expect(consumeSelection(`${base}#${hash}`, send, replace)).toBe(false);
    expect(send).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
  });
});
