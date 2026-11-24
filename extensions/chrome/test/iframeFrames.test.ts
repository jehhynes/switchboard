import { describe, expect, it, vi } from 'vitest';
import { IframeFrames, holesClip } from '../src/iframeFrames.js';
describe('iframe document lifecycle', () => {
  it('assigns the website URL before attaching a sandboxed frame', () => {
    const host = document.createElement('div');
    const append = vi.spyOn(host, 'append').mockImplementation((frame) => {
      expect((frame as HTMLIFrameElement).getAttribute('src')).toBe('https://github.com/o/r/issues/1');
      expect((frame as HTMLIFrameElement).getAttribute('sandbox')).not.toContain('allow-top-navigation');
    });
    const pool = new IframeFrames(host);
    pool.reconcile(1, ['https://github.com/o/r/issues/1']);
    pool.show({ url: 'https://github.com/o/r/issues/1', left: 0, top: 0, width: 500, height: 400, reload: false, holes: [], dim: 0, modal: false });
    expect(append).toHaveBeenCalledTimes(1);
  });
  it('creates lazily, hides attached inactive documents, preserves navigation, and disposes closed or old work item frames', () => {
    const host = document.createElement('div'); document.body.append(host);
    const pool = new IframeFrames(host);
    const a = 'https://github.com/o/r/issues/1', b = 'https://github.com/o/r/pull/2';
    const view = (url: string, reload = false) => ({ url, left: 10, top: 20, width: 500, height: 400, reload, holes: [], dim: 0, modal: false });
    pool.reconcile(1, [a, b]); expect(pool.frames.size).toBe(0);
    pool.show(view(a)); const first = pool.frames.get(a)!;
    first.src = 'https://github.com/o/r/issues/8'; pool.show(view(b)); const second = pool.frames.get(b)!;
    expect(first.isConnected).toBe(true); expect(first.hidden).toBe(false); expect(first.style.visibility).toBe('hidden'); expect(second.style.visibility).toBe('visible');
    expect(first.hasAttribute('inert')).toBe(true); expect(first.getAttribute('aria-hidden')).toBe('true'); expect(second.hasAttribute('inert')).toBe(false);
    pool.show(view(a)); expect(first.src).toBe('https://github.com/o/r/issues/8'); expect(second.style.visibility).toBe('hidden'); expect(first.style.visibility).toBe('visible'); expect(first.hasAttribute('inert')).toBe(false); expect(first.hasAttribute('aria-hidden')).toBe(false);
    pool.show(null); expect(first.hidden).toBe(false); expect(first.style.visibility).toBe('hidden'); expect(first.hasAttribute('inert')).toBe(true); expect(pool.frames.size).toBe(2);
    pool.show(view(a, true)); expect(first.src).toBe(a);
    expect(first.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    pool.reconcile(1, [b]); expect(first.isConnected).toBe(false); expect(second.isConnected).toBe(true);
    pool.show(view(a)); expect(pool.frames.size).toBe(1);
    pool.reconcile(2, [b]); expect(second.isConnected).toBe(false);
    pool.show(view(b)); expect(pool.frames.get(b)).not.toBe(second);
    pool.reconcile(null, []); host.remove();
  });
  it("cuts the page's layers out of the shown frame, and under a modal darkens it and passes the pointer to the page", () => {
    const host = document.createElement('div'); document.body.append(host);
    const pool = new IframeFrames(host);
    const a = 'https://github.com/o/r/issues/1', b = 'https://github.com/o/r/pull/2';
    pool.reconcile(1, [a, b]);
    const base = { left: 100, top: 50, width: 600, height: 400, reload: false };
    pool.show({ url: a, ...base, holes: [{ left: 400, top: 40, width: 200, height: 100, radius: 0 }], dim: 0, modal: false });
    const frame = pool.frames.get(a)!;
    expect(frame.style.clipPath).toBe('path(evenodd, "M0 0H600V400H0Z M300 0H500V90H300Z")');
    expect(frame.style.filter).toBe(''); expect(frame.style.pointerEvents).toBe(''); expect(frame.hasAttribute('inert')).toBe(false);
    pool.show({ url: a, ...base, holes: [{ left: 250, top: 150, width: 300, height: 200, radius: 6 }], dim: 0.4, modal: true });
    expect(frame.style.clipPath).toBe('path(evenodd, "M0 0H600V400H0Z M156 100H444A6 6 0 0 1 450 106V294A6 6 0 0 1 444 300H156A6 6 0 0 1 150 294V106A6 6 0 0 1 156 100Z")');
    expect(frame.style.filter).toBe('brightness(0.6)'); expect(frame.style.pointerEvents).toBe('none'); expect(frame.hasAttribute('inert')).toBe(true);
    // The modal closes: the frame takes the pointer and focus again, whole.
    pool.show({ url: a, ...base, holes: [], dim: 0, modal: false });
    expect(frame.style.clipPath).toBe(''); expect(frame.style.filter).toBe(''); expect(frame.style.pointerEvents).toBe(''); expect(frame.hasAttribute('inert')).toBe(false);
    // Another tab shown: the hidden frame keeps no cut and stays inert.
    pool.show({ url: a, ...base, holes: [{ left: 400, top: 40, width: 200, height: 100, radius: 0 }], dim: 0.4, modal: true });
    pool.show({ url: b, ...base, holes: [], dim: 0, modal: false });
    expect(frame.style.clipPath).toBe(''); expect(frame.style.filter).toBe(''); expect(frame.style.pointerEvents).toBe(''); expect(frame.hasAttribute('inert')).toBe(true);
    pool.reconcile(null, []); host.remove();
  });
});
describe('frame holes', () => {
  const hole = (left: number, top: number, width: number, height: number, radius = 0) => ({ left, top, width, height, radius });
  it('cuts nothing without a hole over the frame', () => {
    expect(holesClip(100, 50, 600, 400, [])).toBe('');
    expect(holesClip(100, 50, 600, 400, [hole(0, 0, 90, 40), hole(800, 50, 50, 50)])).toBe('');
  });
  it('cuts disjoint holes with their rounded corners, clipped to the frame', () => {
    expect(holesClip(0, 0, 600, 400, [hole(10, 10, 100, 50, 6), hole(300, 300, 400, 200)])).toBe(
      'path(evenodd, "M0 0H600V400H0Z M16 10H104A6 6 0 0 1 110 16V54A6 6 0 0 1 104 60H16A6 6 0 0 1 10 54V16A6 6 0 0 1 16 10Z M300 300H600V400H300Z")',
    );
    // A menu that runs past the frame's top keeps only its bottom corners round.
    expect(holesClip(200, 100, 800, 500, [hole(600, 80, 300, 200, 6)])).toBe('path(evenodd, "M0 0H800V500H0Z M400 0H700V174A6 6 0 0 1 694 180H406A6 6 0 0 1 400 174V0Z")');
    // A radius larger than half the box is held to it.
    expect(holesClip(0, 0, 600, 400, [hole(0, 0, 20, 10, 50)])).toContain('M5 0H15A5 5 0 0 1 20 5');
  });
  it('drops a hole inside another and splits overlapping ones, so even-odd filling never shows the frame inside a hole', () => {
    // A menu inside a dialog: one cut, the dialog's.
    expect(holesClip(0, 0, 600, 400, [hole(100, 100, 300, 200), hole(150, 150, 50, 50), hole(100, 100, 300, 200)])).toBe('path(evenodd, "M0 0H600V400H0Z M100 100H400V300H100Z")');
    // A small layer in a rounded dialog's corner is not inside its shape, so both are cut, square, as crossing boxes.
    expect(holesClip(0, 0, 600, 400, [hole(100, 100, 300, 200, 20), hole(100, 100, 4, 4)])).toBe('path(evenodd, "M0 0H600V400H0Z M100 100H400V104H100Z M100 104H400V300H100Z")');
    // A box that crosses none keeps its rounded corners beside two that cross.
    expect(holesClip(0, 0, 600, 400, [hole(0, 0, 100, 100), hole(50, 50, 100, 100), hole(400, 300, 100, 50, 4)])).toBe('path(evenodd, "M0 0H600V400H0Z M404 300H496A4 4 0 0 1 500 304V346A4 4 0 0 1 496 350H404A4 4 0 0 1 400 346V304A4 4 0 0 1 404 300Z M0 0H100V50H0Z M0 50H150V100H0Z M50 100H150V150H50Z")');
    // Two crossing boxes: disjoint rows covering their union.
    const clip = holesClip(0, 0, 600, 400, [hole(0, 0, 100, 100), hole(50, 50, 100, 100)]);
    expect(clip).toBe('path(evenodd, "M0 0H600V400H0Z M0 0H100V50H0Z M0 50H150V100H0Z M50 100H150V150H50Z")');
  });
});
