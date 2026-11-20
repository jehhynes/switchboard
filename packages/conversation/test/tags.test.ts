import { describe, expect, it } from 'vitest';
import { endsInOpenTag, keyOf, messageTags, parseReply, splitRewrite, splitSpeak, splitStatus, splitTone, spokenText, stripAside, stripMessageTags } from '../src/tags.js';

describe('reply tags', () => {
  it('reads an aside and a rewrite only at the very start, the aside after a rewrite tag', () => {
    expect(stripAside('[aside] Still working.')).toEqual({ aside: true, text: 'Still working.' });
    expect(stripAside('[rewrite] [aside] x')).toEqual({ aside: true, text: '[rewrite] x' });
    expect(stripAside('`[aside]` marks filler.')).toEqual({ aside: false, text: '`[aside]` marks filler.' });
    expect(splitRewrite('[rewrite]\nBoth answers.')).toEqual({ rewrite: true, text: 'Both answers.' });
    expect(splitRewrite('`[rewrite]` is the syntax.').rewrite).toBe(false);
    expect(splitRewrite('Use [rewrite] then.').rewrite).toBe(false);
  });

  it('parses a reply into its kind, rewrite, text and status, keeps any other bracketed word as text', () => {
    expect(parseReply('[rewrite] Both done.\n\n- a\n- b')).toEqual({ kind: 'reply', rewrite: true, opening: 'Both done.\n\n- a\n- b', status: null, speak: null, tone: null });
    expect(parseReply('Done.\n[details]\nx')).toEqual({ kind: 'reply', rewrite: false, opening: 'Done.\n[details]\nx', status: null, speak: null, tone: null });
    expect(parseReply('[aside] Reading files.')).toEqual({ kind: 'aside', rewrite: false, opening: 'Reading files.', status: null, speak: null, tone: null });
    expect(parseReply('[rewrite] Fixed.\n\n[status]\n## Done\n- the badge')).toEqual({ kind: 'reply', rewrite: true, opening: 'Fixed.', status: '## Done\n- the badge', speak: null, tone: null });
    expect(parseReply('[status]\nAll green.')).toEqual({ kind: 'reply', rewrite: false, opening: '', status: 'All green.', speak: null, tone: null });
  });

  it('reads the [speak] passage and the tone line, and leaves their markers out of the text the view shows', () => {
    expect(parseReply('[speak]Fixed the badge.[/speak]\n\n- one\n- two')).toEqual({ kind: 'reply', rewrite: false, opening: 'Fixed the badge.\n\n- one\n- two', status: null, speak: 'Fixed the badge.', tone: null });
    expect(parseReply('[tone: calm, slightly amused]\n[rewrite]\n[speak]\nBoth done.\n[/speak]\nDetails.')).toEqual({ kind: 'reply', rewrite: true, opening: 'Both done.\nDetails.', status: null, speak: 'Both done.', tone: 'calm, slightly amused' });
    expect(parseReply('[rewrite]\n[tone: dry]\nNo.')).toMatchObject({ rewrite: true, opening: 'No.', tone: 'dry' });
    expect(parseReply('[speak]Done.[/speak]\n[status]\nGreen.')).toMatchObject({ opening: 'Done.', status: 'Green.', speak: 'Done.' });
    // Quoted in inline code, a marker is text; one never closed marks nothing.
    expect(splitSpeak('The `[speak]` rule.')).toEqual({ speak: null, text: 'The `[speak]` rule.' });
    expect(splitSpeak('[speak]Half a passage')).toEqual({ speak: null, text: 'Half a passage' });
    expect(splitSpeak('[SPEAK]One.[/speak] Middle. [speak]Two.[/speak]')).toEqual({ speak: 'One. Two.', text: 'One. Middle. Two.' });
    // In a longer code span or a fenced block a marker is text too.
    expect(splitSpeak('Use `x [speak]example[/speak] y` here.')).toEqual({ speak: null, text: 'Use `x [speak]example[/speak] y` here.' });
    expect(splitSpeak('[speak]Real.[/speak]\n\n```md\n[speak]Quoted.[/speak]\n```')).toEqual({ speak: 'Real.', text: 'Real.\n\n```md\n[speak]Quoted.[/speak]\n```' });
    // A text with no marker keeps every space and blank line, and one with markers keeps those around them.
    const spaced = 'Line one  \nline two\n\n\n\n```\ncode   \n```';

    expect(splitSpeak(spaced)).toEqual({ speak: null, text: spaced });
    expect(splitSpeak('[speak]\nSaid.\n[/speak]\nKept  \nhard break')).toEqual({ speak: 'Said.', text: 'Said.\nKept  \nhard break' });
    // A tone line counts only on the first line, without quotes and backslashes, and cut to 120 characters.
    expect(splitTone('Hi.\n[tone: calm]')).toEqual({ tone: null, text: 'Hi.\n[tone: calm]' });
    expect(splitTone('[tone: "warm" \\ kind]\nHi.')).toEqual({ tone: 'warm kind', text: 'Hi.' });
    expect(splitTone(`[tone: ${'a'.repeat(200)}]\nHi.`).tone).toHaveLength(120);
    expect(splitTone('[tone: ]\nHi.')).toEqual({ tone: null, text: 'Hi.' });
  });

  it('reads a passage as words, without Markdown marks, and tags and untags a spoken message', () => {
    expect(spokenText('**Done**: see [the plan](a.md) and `hub.ts`.\n- next')).toBe('Done: see the plan and hub.ts. next');
    expect(messageTags(true, false)).toBe('[spoken] ');
    expect(messageTags(true, true)).toBe('[spoken] [expressive] ');
    expect(messageTags(false, true)).toBe('');
    expect(stripMessageTags('[spoken] [expressive] Hello there')).toBe('Hello there');
    expect(stripMessageTags('Say [spoken] here')).toBe('Say [spoken] here');
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
    expect(endsInOpenTag('Done. [spe')).toBe(true);
    expect(endsInOpenTag('Done.[/spe')).toBe(true);
    expect(endsInOpenTag('Done.[/x')).toBe(false);
  });
});
