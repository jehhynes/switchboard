import { CodeView } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';
import { keepAtTop } from '../src/diff/viewer.js';

describe('keepAtTop', () => {
  it("still finds CodeView's sticky positioning, which it wraps", () => {
    expect(typeof (CodeView.prototype as unknown as Record<string, unknown>)['applyStickyPositioning']).toBe('function');
  });

  it("drops a positive top, which would push a short file's lines down, and keeps a negative one, which keeps a long file in view", () => {
    const box = document.createElement('div');
    let next = { top: '0px', bottom: '0px' };
    const view = {
      stickyContainer: box,
      applyStickyPositioning(): void {
        box.style.top = next.top;
        box.style.bottom = next.bottom;
      },
    };

    keepAtTop(view);
    next = { top: '487px', bottom: '531px' };
    view.applyStickyPositioning();
    expect([box.style.top, box.style.bottom]).toEqual(['0px', 'auto']);

    next = { top: '-385px', bottom: '-341px' };
    view.applyStickyPositioning();
    expect([box.style.top, box.style.bottom]).toEqual(['-385px', '-341px']);
  });

  it('leaves a view without the method alone', () => {
    const view = { stickyContainer: document.createElement('div') };

    keepAtTop(view);
    expect(view).toEqual({ stickyContainer: expect.any(HTMLElement) });
  });
});
