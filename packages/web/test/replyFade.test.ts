import { afterEach, describe, expect, it } from 'vitest';
import { fadeCut, fitFade, textLines } from '../src/replyFade.js';

/** Lines 20 px apart, 16 px tall, from the top of their box. */
const lines = (count: number) => Array.from({ length: count }, (_, index) => ({ top: index * 20, bottom: index * 20 + 16 }));
const had = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');

/** Draws each text node of the page as the boxes `place` gives it, as a browser would lay it out. */
function layOut(place: (text: Text) => Array<{ top: number; bottom: number; width?: number }>): void {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value(this: Range) {
      return place(this.startContainer as Text).map(({ top, bottom, width = 100 }) => ({ top, bottom, height: bottom - top, width, left: 0, right: width }));
    },
  });
}

afterEach(() => {
  if (had === undefined) {
    delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
  } else {
    Object.defineProperty(Range.prototype, 'getClientRects', had);
  }
});

describe("Brief replies' fade", () => {
  it('cuts details after two whole lines with the third fading, only when it hides 1.5 lines or more', () => {
    // Two or three lines, or a fourth just under the cut: nothing worth a click is hidden.
    expect(fadeCut(lines(2), 20)).toBeNull();
    expect(fadeCut(lines(3), 20)).toBeNull();
    expect(fadeCut(lines(4), 20)).toBeNull();
    // Two lines below the third are worth it: two whole lines, and the third fading to the cut.
    expect(fadeCut(lines(5), 20)).toEqual({ height: 56, solid: 36 });
    // A fourth line after a wide margin, as after a list, hides as much as two lines.
    expect(fadeCut([...lines(3), { top: 70, bottom: 86 }], 20)).toEqual({ height: 56, solid: 36 });
  });

  it('reads the lines a box draws, a bold label and the text beside it as one line, from its top, skipping white space', () => {
    const box = document.createElement('div');

    box.innerHTML = '<p><strong>The three:</strong> fixes</p>\n<ul><li>one</li><li>two, which wraps</li></ul>';
    box.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    document.body.append(box);
    layOut((text) => {
      switch (text.textContent) {
        case 'The three:':
          return [{ top: 100, bottom: 118 }];
        case ' fixes':
          return [{ top: 102, bottom: 116 }];
        case 'one':
          return [{ top: 140, bottom: 156 }];
        case 'two, which wraps':
          return [{ top: 160, bottom: 176 }, { top: 180, bottom: 196 }, { top: 190, bottom: 190, width: 0 }];
        default:
          throw new Error(`white space was measured: ${JSON.stringify(text.textContent)}`);
      }
    });
    expect(textLines(box)).toEqual([{ top: 0, bottom: 18 }, { top: 40, bottom: 56 }, { top: 60, bottom: 76 }, { top: 80, bottom: 96 }]);
    box.remove();
  });

  it("sets a fade's height and solid part from its details, answers false for details too short to fade, and leaves an undrawn fade as it was", () => {
    const fade = document.createElement('div');
    const count = { lines: 6 };

    fade.innerHTML = '<div class="reply-more-text"><div class="reply-details"><p>text</p></div></div>';
    (fade.firstElementChild as HTMLElement).getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    document.body.append(fade);
    layOut(() => lines(count.lines));
    expect(fitFade(fade)).toBe(true);
    expect([fade.style.getPropertyValue('--sb-fade-height'), fade.style.getPropertyValue('--sb-fade-solid')]).toEqual(['56px', '36px']);

    count.lines = 3;
    expect(fitFade(fade)).toBe(false);
    // Nothing drawn, as in a hidden tab: no decision yet.
    count.lines = 0;
    expect(fitFade(fade)).toBe(true);
    expect(fitFade(document.createElement('div'))).toBe(true);
    fade.remove();
  });
});
