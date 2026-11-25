import { describe, expect, it } from 'vitest';
import { composerInput } from '../src/composerInput.js';

describe('the composer input state', () => {
  it('keeps a chosen command only while the text is one line that starts with it', () => {
    const box = composerInput();

    expect(box.choose('compact')).toBe('/compact ');
    expect(box.asCommand('/compact ')).toBe(true);
    box.changed('/compact now @src/a.ts');
    expect(box.asCommand('/compact now @src/a.ts')).toBe(true);
    // A longer name is another command.
    box.changed('/compactor');
    expect(box.chosen).toBeNull();
    expect(box.asCommand('/compact')).toBe(false);

    box.choose('compact');
    box.changed('/compact\nmore');
    expect(box.chosen).toBeNull();

    // Emptied and typed again by hand, it goes escaped.
    box.choose('compact');
    box.changed('');
    box.changed('/compact');
    expect(box.asCommand('/compact')).toBe(false);

    box.choose('review');
    box.reset();
    expect(box.asCommand('/review ')).toBe(false);
  });

  it('recalls earlier messages with nothing chosen, and gives back the draft with its chosen command after the newest', () => {
    const box = composerInput();
    const texts = ['first', '/compact'];

    box.choose('review');
    expect(box.recall(false, '/review ', texts)).toBeNull();
    expect(box.recall(true, '/review ', texts)).toBe('/compact');
    expect(box.walking).toBe(true);
    expect(box.asCommand('/compact')).toBe(false);
    expect(box.recall(true, '/compact', texts)).toBe('first');
    expect(box.recall(true, 'first', texts)).toBeNull();
    expect(box.recall(false, 'first', texts)).toBe('/compact');
    expect(box.recall(false, '/compact', texts)).toBe('/review ');
    expect(box.walking).toBe(false);
    expect(box.asCommand('/review ')).toBe(true);

    // Typing ends the walk, and the recalled text stays as typed.
    expect(box.recall(true, '', texts)).toBe('/compact');
    box.changed('/compact again');
    expect(box.walking).toBe(false);
    expect(box.asCommand('/compact again')).toBe(false);
    expect(composerInput().recall(true, '', [])).toBeNull();
  });

  it("drops the list's request on a cancel, a change of the text, a choice, a recall or a reset", () => {
    const box = composerInput();
    const steps: Array<() => unknown> = [() => box.cancel(), () => box.changed('x'), () => box.choose('clear'), () => box.recall(true, '', ['a']), () => box.reset()];

    for (const step of steps) {
      const token = box.ask();

      expect(box.current(token)).toBe(true);
      step();
      expect(box.current(token)).toBe(false);
    }

    const first = box.ask();

    box.ask();
    expect(box.current(first)).toBe(false);
  });
});
