import { describe, expect, it } from 'vitest';
import { endsInOpenTag, interruptNote, keyOf, messageTags, parseReply, splitHeard, splitRewrite, splitSpeak, splitStatus, splitTone, spokenText, stripAside, stripMessageTags } from '../src/tags.js';
import { typedText } from '../src/transcript.js';

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
    expect(parseReply('[rewrite] Both done.\n\n- a\n- b')).toEqual({ kind: 'reply', rewrite: true, opening: 'Both done.\n\n- a\n- b', status: null, speak: null, tone: null, heard: [] });
    expect(parseReply('Done.\n[details]\nx')).toEqual({ kind: 'reply', rewrite: false, opening: 'Done.\n[details]\nx', status: null, speak: null, tone: null, heard: [] });
    expect(parseReply('[aside] Reading files.')).toEqual({ kind: 'aside', rewrite: false, opening: 'Reading files.', status: null, speak: null, tone: null, heard: [] });
    expect(parseReply('[rewrite] Fixed.\n\n[status]\n## Done\n- the badge')).toEqual({ kind: 'reply', rewrite: true, opening: 'Fixed.', status: '## Done\n- the badge', speak: null, tone: null, heard: [] });
    expect(parseReply('[status]\nAll green.')).toEqual({ kind: 'reply', rewrite: false, opening: '', status: 'All green.', speak: null, tone: null, heard: [] });
  });

  it('reads the [speak] passage and the tone line, and leaves their markers out of the text the view shows', () => {
    expect(parseReply('[speak]Fixed the badge.[/speak]\n\n- one\n- two')).toEqual({ kind: 'reply', rewrite: false, opening: 'Fixed the badge.\n\n- one\n- two', status: null, speak: 'Fixed the badge.', tone: null, heard: [] });
    expect(parseReply('[tone: calm, slightly amused]\n[rewrite]\n[speak]\nBoth done.\n[/speak]\nDetails.')).toEqual({ kind: 'reply', rewrite: true, opening: 'Both done.\nDetails.', status: null, speak: 'Both done.', tone: 'calm, slightly amused', heard: [] });
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

  it('tags a dictated message and a [partial] part after any reply tags, and untags them with the reply tags', () => {
    expect(messageTags(false, false, 'voice')).toBe('[voice] ');
    expect(messageTags(true, true, 'voice')).toBe('[spoken] [expressive] [voice] ');
    expect(messageTags(false, false, 'partial')).toBe('[voice] [partial] ');
    expect(stripMessageTags('[spoken] [voice] fix the login flow')).toBe('fix the login flow');
    expect(stripMessageTags('[voice] [partial] fix the')).toBe('fix the');
    expect(stripMessageTags('fix the [voice] tag')).toBe('fix the [voice] tag');
    expect(typedText('[voice] [partial] fix the')).toBe('fix the');
  });

  it('writes the interruption note from what was heard of the reply, types it after the tags, and untags it only there', () => {
    const long = 'is refreshed in two places, and the second one runs after the redirect, so the old token wins.';

    expect(interruptNote({ said: '', rest: 'Fixed the login flow.' })).toBe('[interrupted your reply before its first words]');
    expect(interruptNote({ said: 'Fixed the login flow.', rest: '' })).toBeNull();
    expect(interruptNote({ said: 'Fixed the login', rest: 'flow, and the build passes.' })).toBe('[heard all of your reply but: "flow, and the build passes."]');
    expect(interruptNote({ said: 'So I looked at the whole login flow today. The session token', rest: long })).toBe('[interrupted your reply after: "…looked at the whole login flow today. The session token"; unspoken: "is refreshed in two places, and…"]');
    expect(interruptNote({ said: 'The session token', rest: long })).toBe('[interrupted your reply after: "The session token"; unspoken: "is refreshed in two places, and…"]');

    const note = '[heard all of your reply but: "flow]."]';

    expect(messageTags(true, false, 'voice', note)).toBe(`[spoken] [voice] ${note} `);
    expect(messageTags(false, false, null, note)).toBe('');
    expect(stripMessageTags(`[voice] ${note} hold on`)).toBe('hold on');
    expect(stripMessageTags('[spoken] [voice] [interrupted your reply after: "a b"; unspoken: "c d"] wait')).toBe('wait');
    expect(stripMessageTags('[voice] [interrupted your reply before its first words] stop')).toBe('stop');
    expect(stripMessageTags('[interrupted your reply before its first words] stop')).toBe('[interrupted your reply before its first words] stop');
    expect(typedText('[voice] [heard all of your reply but: "the rest."] go on')).toBe('go on');

    // Quotes in the reply's words cannot end the note early.
    const quoted = interruptNote({ said: 'Set', rest: 'config["voice"] to false.' })!;

    expect(quoted).toBe('[heard all of your reply but: "config[\'voice\'] to false."]');
    expect(stripMessageTags(`[voice] ${quoted} wait`)).toBe('wait');
  });

  it('reads heard tags, leaves them out of the text the view shows, and ignores one in code', () => {
    expect(parseReply('Ollama is running. <!--heard:a llama=Ollama-->')).toMatchObject({ opening: 'Ollama is running.', heard: [{ heard: 'a llama', meant: 'Ollama' }] });
    expect(parseReply('[speak]Done.[/speak]\n<!--heard:work train=worktree-->\n<!-- heard: nematron = Nemotron -->\nMore.')).toMatchObject({
      opening: 'Done.\nMore.',
      speak: 'Done.',
      heard: [
        { heard: 'work train', meant: 'worktree' },
        { heard: 'nematron', meant: 'Nemotron' },
      ],
    });
    expect(splitHeard('Write `<!--heard:a llama=Ollama-->` to teach it.')).toEqual({ heard: [], text: 'Write `<!--heard:a llama=Ollama-->` to teach it.' });
    expect(splitHeard('```\n<!--heard:x=Y-->\n```').heard).toEqual([]);
    expect(splitHeard('<!--heard:=Y--> <!--note-->').heard).toEqual([]);
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
