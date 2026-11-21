import { describe, expect, it } from 'vitest';
import { diffItem } from '../src/diff/viewer.js';

const patch = ['diff --git a/a.ts b/a.ts', 'index 1111111..2222222 100644', '--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three', ''].join('\n');

describe("the diff viewer's item", () => {
  it("reads git's patch with both whole sides, taking out carriage returns the patch does not have", () => {
    const item = diffItem({ path: 'a.ts', status: 'M', patch, old: 'one\r\ntwo\r\nthree\r\n', new: 'one\nTWO\nthree\n', binary: false, tooLarge: null }, 'v1');

    expect(item).toMatchObject({ id: 'a.ts', type: 'diff' });
    expect(JSON.stringify(item)).not.toContain('\\r');
  });

  it('reads the patch alone when the hub left the sides out, and nothing for no patch or one that does not parse', () => {
    expect(diffItem({ path: 'a.ts', status: 'M', patch, old: null, new: null, binary: false, tooLarge: 'sides' }, 'v1')).toMatchObject({ type: 'diff' });
    expect(diffItem({ path: 'a.ts', status: 'M', patch: null, old: null, new: null, binary: true, tooLarge: null }, 'v1')).toBeNull();
    expect(diffItem({ path: 'a.ts', status: 'M', patch: 'not a patch', old: 'a', new: 'b', binary: false, tooLarge: null }, 'v1')).toBeNull();
  });
});
