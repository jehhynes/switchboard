import { describe, expect, it } from 'vitest';
import { IframeFrames } from '../src/iframeFrames.js';
describe('iframe document lifecycle', () => {
  it('creates lazily, hides attached inactive documents, preserves navigation, and disposes closed or old work item frames', () => {
    const host = document.createElement('div'); document.body.append(host);
    const pool = new IframeFrames(host);
    const a = 'https://github.com/o/r/issues/1', b = 'https://github.com/o/r/pull/2';
    const view = (url: string, reload = false) => ({ url, left: 10, top: 20, width: 500, height: 400, reload });
    pool.reconcile(1, [a, b]); expect(pool.frames.size).toBe(0);
    pool.show(view(a)); const first = pool.frames.get(a)!;
    first.src = 'https://github.com/o/r/issues/8'; pool.show(view(b)); const second = pool.frames.get(b)!;
    expect(first.isConnected).toBe(true); expect(first.hidden).toBe(true); expect(second.hidden).toBe(false);
    pool.show(view(a)); expect(first.src).toBe('https://github.com/o/r/issues/8'); expect(second.hidden).toBe(true);
    pool.show(null); expect(first.hidden).toBe(true); expect(pool.frames.size).toBe(2);
    pool.show(view(a, true)); expect(first.src).toBe(a);
    expect(first.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    pool.reconcile(1, [b]); expect(first.isConnected).toBe(false); expect(second.isConnected).toBe(true);
    pool.show(view(a)); expect(pool.frames.size).toBe(1);
    pool.reconcile(2, [b]); expect(second.isConnected).toBe(false);
    pool.show(view(b)); expect(pool.frames.get(b)).not.toBe(second);
    pool.reconcile(null, []); host.remove();
  });
});
