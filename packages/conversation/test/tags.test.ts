import { describe, expect, it } from 'vitest';
import { endsInOpenTag, keyOf, parseReply, splitRewrite, stripAside } from '../src/tags.js';

describe('reply tags', () => {
  it('reads an aside and a rewrite only at the very start, the aside after a rewrite tag', () => {
    expect(stripAside('[aside] Still working.')).toEqual({ aside: true, text: 'Still working.' });
    expect(stripAside('[rewrite] [aside] x')).toEqual({ aside: true, text: '[rewrite] x' });
    expect(stripAside('`[aside]` marks filler.')).toEqual({ aside: false, text: '`[aside]` marks filler.' });
    expect(splitRewrite('[rewrite]\nBoth answers.')).toEqual({ rewrite: true, text: 'Both answers.' });
    expect(splitRewrite('`[rewrite]` is the syntax.').rewrite).toBe(false);
    expect(splitRewrite('Use [rewrite] then.').rewrite).toBe(false);
  });

  it('parses a reply into its kind, rewrite and text, keeps any other bracketed word as text, and leaves a session without the current rules whole', () => {
    expect(parseReply('[rewrite] Both done.\n\n- a\n- b', true)).toEqual({ kind: 'reply', rewrite: true, opening: 'Both done.\n\n- a\n- b' });
    expect(parseReply('Done.\n[details]\nx', true)).toEqual({ kind: 'reply', rewrite: false, opening: 'Done.\n[details]\nx' });
    expect(parseReply('[aside] Reading files.', true)).toEqual({ kind: 'aside', rewrite: false, opening: 'Reading files.' });
    expect(parseReply('[aside] Done.', false)).toEqual({ kind: 'reply', rewrite: false, opening: '[aside] Done.' });
  });

  it('keys copies by letters and digits, without the rewrite tag, and a reply with none by its other characters', () => {
    expect(keyOf('**Done**, see [tts.js](src/tts.js).')).toBe(keyOf('Done, see tts.js.'));
    expect(keyOf('[rewrite] 👍')).not.toBe(keyOf('[rewrite] 👎'));
    expect(keyOf('[rewrite] Yes.')).toBe('Yes');
  });

  it('tells a tag or comment still being drawn', () => {
    expect(endsInOpenTag('Done. [asi')).toBe(true);
    expect(endsInOpenTag('Done. [rewr')).toBe(true);
    expect(endsInOpenTag('Done. [deta')).toBe(false);
    expect(endsInOpenTag('Done. <!--x')).toBe(true);
    expect(endsInOpenTag('Done. <!')).toBe(true);
    expect(endsInOpenTag('Done. [ok]')).toBe(false);
    expect(endsInOpenTag('See [xyz')).toBe(false);
  });
});
