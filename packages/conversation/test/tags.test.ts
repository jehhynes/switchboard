import { describe, expect, it } from 'vitest';
import { endsInOpenTag, keyOf, parseReply, splitRewrite, splitStatus, stripAside } from '../src/tags.js';

describe('reply tags', () => {
  it('reads an aside and a rewrite only at the very start, the aside after a rewrite tag', () => {
    expect(stripAside('[aside] Still working.')).toEqual({ aside: true, text: 'Still working.' });
    expect(stripAside('[rewrite] [aside] x')).toEqual({ aside: true, text: '[rewrite] x' });
    expect(stripAside('`[aside]` marks filler.')).toEqual({ aside: false, text: '`[aside]` marks filler.' });
    expect(splitRewrite('[rewrite]\nBoth answers.')).toEqual({ rewrite: true, text: 'Both answers.' });
    expect(splitRewrite('`[rewrite]` is the syntax.').rewrite).toBe(false);
    expect(splitRewrite('Use [rewrite] then.').rewrite).toBe(false);
  });

  it('parses a reply into its kind, rewrite, text and status, keeps any other bracketed word as text, and reads only the tags its rules version explained', () => {
    expect(parseReply('[rewrite] Both done.\n\n- a\n- b', 3)).toEqual({ kind: 'reply', rewrite: true, opening: 'Both done.\n\n- a\n- b', status: null });
    expect(parseReply('Done.\n[details]\nx', 3)).toEqual({ kind: 'reply', rewrite: false, opening: 'Done.\n[details]\nx', status: null });
    expect(parseReply('[aside] Reading files.', 3)).toEqual({ kind: 'aside', rewrite: false, opening: 'Reading files.', status: null });
    expect(parseReply('[rewrite] Fixed.\n\n[status]\n## Done\n- the badge', 3)).toEqual({ kind: 'reply', rewrite: true, opening: 'Fixed.', status: '## Done\n- the badge' });
    expect(parseReply('[status]\nAll green.', 3)).toEqual({ kind: 'reply', rewrite: false, opening: '', status: 'All green.' });
    // Versions 1 and 2 explained the aside and rewrite tags, not the status tag; with none, a reply is whole.
    expect(parseReply('[aside] x\n[status]\ny', 2)).toEqual({ kind: 'aside', rewrite: false, opening: 'x\n[status]\ny', status: null });
    expect(parseReply('[aside] Done.', null)).toEqual({ kind: 'reply', rewrite: false, opening: '[aside] Done.', status: null });
    expect(parseReply('[aside] Done.\n[status]\nx', 1)).toEqual({ kind: 'aside', rewrite: false, opening: 'Done.\n[status]\nx', status: null });
  });

  it('splits a status at its own [status] line outside fenced code, never at a quoted or indented tag', () => {
    expect(splitStatus('Done.\n[status]\n# Where it stands\n\n- one')).toEqual({ reply: 'Done.', status: '# Where it stands\n\n- one' });
    expect(splitStatus('Done.\n  [STATUS]  \nx')).toEqual({ reply: 'Done.', status: 'x' });
    expect(splitStatus('Done.\n[status]\n')).toEqual({ reply: 'Done.', status: null });
    expect(splitStatus('Write `[status]` on its own line.')).toEqual({ reply: 'Write `[status]` on its own line.', status: null });
    expect(splitStatus('See:\n```md\n[status]\nx\n```\nend')).toEqual({ reply: 'See:\n```md\n[status]\nx\n```\nend', status: null });
    expect(splitStatus('Code:\n    [status]\nx').status).toBeNull();
    expect(splitStatus('[status] Done').status).toBeNull();
    expect(splitStatus('~~~\n```\n[status]\n~~~\n[status]\nafter')).toEqual({ reply: '~~~\n```\n[status]\n~~~', status: 'after' });
  });

  it('keys copies by letters and digits, without the rewrite tag, and a reply with none by its other characters', () => {
    expect(keyOf('**Done**, see [tts.js](src/tts.js).')).toBe(keyOf('Done, see tts.js.'));
    expect(keyOf('[rewrite] 👍')).not.toBe(keyOf('[rewrite] 👎'));
    expect(keyOf('[rewrite] Yes.')).toBe('Yes');
  });

  it('tells a tag or comment still being drawn', () => {
    expect(endsInOpenTag('Done. [asi')).toBe(true);
    expect(endsInOpenTag('Done. [rewr')).toBe(true);
    expect(endsInOpenTag('Done.\n[sta')).toBe(true);
    expect(endsInOpenTag('Done. [deta')).toBe(false);
    expect(endsInOpenTag('Done. <!--x')).toBe(true);
    expect(endsInOpenTag('Done. <!')).toBe(true);
    expect(endsInOpenTag('Done. [ok]')).toBe(false);
    expect(endsInOpenTag('See [xyz')).toBe(false);
  });
});
