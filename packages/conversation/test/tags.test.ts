import { describe, expect, it } from 'vitest';
import { drawnKeyOf, drawnLinks, endsInOpenTag, interruptNote, keyOf, messageTags, parseReply, speechPart, splitArtifacts, splitHeard, splitPrimary, splitRewrite, splitSpeak, splitState, splitTone, stateParts, spokenText, stripAside, stripMessageTags } from '../src/tags.js';
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
    expect(parseReply('[rewrite] Both done.\n\n- a\n- b')).toEqual({ kind: 'reply', rewrite: true, opening: 'Both done.\n\n- a\n- b', state: null, speak: 'Both done.\n\n- a\n- b', tone: null, heard: [], artifacts: [] });
    expect(parseReply('Done.\n[details]\nx')).toEqual({ kind: 'reply', rewrite: false, opening: 'Done.\n\nx', state: null, speak: 'Done.', tone: null, heard: [], artifacts: [] });
    expect(parseReply('[aside] Reading files.')).toEqual({ kind: 'aside', rewrite: false, opening: 'Reading files.', state: null, speak: null, tone: null, heard: [], artifacts: [] });
    expect(parseReply('[rewrite] Fixed.\n\n[status]\n## Done\n- the badge')).toEqual({ kind: 'reply', rewrite: true, opening: 'Fixed.', state: { headline: 'Done', body: '- the badge' }, speak: 'Fixed.', tone: null, heard: [], artifacts: [] });
    expect(parseReply('[state]\nAll green.')).toEqual({ kind: 'reply', rewrite: false, opening: '', state: { headline: 'All green.', body: null }, speak: null, tone: null, heard: [], artifacts: [] });
  });

  it('takes the primary response before a [details] line, spoken or not, and with none the whole reply', () => {
    // Everything before the [details] line is primary, everything after it details; the line itself is shown nowhere.
    expect(splitPrimary('Fixed the badge.\n\n[details]\n- one\n- two')).toEqual({ primary: 'Fixed the badge.', text: 'Fixed the badge.\n\n- one\n- two' });
    expect(parseReply('Two lines.\nStill primary.\n  [DETAILS]  \nMore.')).toMatchObject({ opening: 'Two lines.\nStill primary.\n\nMore.', speak: 'Two lines.\nStill primary.' });
    // A [details] line first leaves no primary response; one quoted inline, in code or indented as code is text.
    expect(splitPrimary('[details]\nOnly details.')).toEqual({ primary: null, text: 'Only details.' });
    expect(splitPrimary('Use the `[details]` line.')).toEqual({ primary: 'Use the `[details]` line.', text: 'Use the `[details]` line.' });
    expect(splitPrimary('```md\n[details]\n```')).toEqual({ primary: '```md\n[details]\n```', text: '```md\n[details]\n```' });
    expect(splitPrimary('Done.\n\n    [details]\n\nEnd.')).toEqual({ primary: 'Done.\n\n    [details]\n\nEnd.', text: 'Done.\n\n    [details]\n\nEnd.' });
    // No [details] line: the whole reply is primary, however long, and with lists, tables, code or questions, so none of it is details.
    const long = `Done, the badge is fixed.\n\n${'More words about it. '.repeat(40).trim()}`;

    expect(splitPrimary(long)).toEqual({ primary: long, text: long });
    for (const whole of ['Two files changed:\n- a.ts\n- b.ts', 'Done.\n\n| a | b |\n|---|---|', 'Done.\n\n```\nx\n```', '1. **Pick.** Which? {#pick}\n   - A) One\n   - B) Two', '## Heading\nText']) {
      expect(splitPrimary(whole)).toEqual({ primary: whole, text: whole });
    }

    // Only blank lines go from the start, so a first line indented as code stays code; an empty reply has no primary response.
    expect(splitPrimary('\n\n    const secret = 1\n\nDone.')).toEqual({ primary: '    const secret = 1\n\nDone.', text: '    const secret = 1\n\nDone.' });
    expect(splitPrimary(' \n ')).toEqual({ primary: null, text: '' });
    // An aside has none, and an older reply's [speak] passage stands over the rule.
    expect(parseReply('[aside] Reading files.').speak).toBeNull();
    expect(parseReply('Intro.\n\n[speak]Said.[/speak]').speak).toBe('Said.');
  });

  it('reads a primary response aloud up to its first list, table, code block, heading, quote or rule, and nothing of one that opens with one', () => {
    expect(speechPart('Done, the badge is fixed.\n\nThe tests pass.')).toBe('Done, the badge is fixed.\n\nThe tests pass.');
    expect(speechPart('Two files changed:\n- a.ts\n- b.ts')).toBe('Two files changed:');
    expect(speechPart('Done.\n\n| a | b |\n|---|---|')).toBe('Done.');
    expect(speechPart('Done.\n\n```\nx\n```\n\nAfter.')).toBe('Done.');
    expect(speechPart('Done.\n\n    const secret = 1')).toBe('Done.');
    expect(speechPart('Done.\n\n## Next\nText')).toBe('Done.');
    expect(speechPart('Done.\n\n> quoted')).toBe('Done.');
    expect(speechPart('Done.\n\n---\nMore')).toBe('Done.');
    expect(speechPart('1. Pick?\n   - A) One')).toBe('');
    // A wrapped line indented as code inside a paragraph is still the paragraph.
    expect(speechPart('Done, and\n    still the same sentence.')).toBe('Done, and\n    still the same sentence.');
  });

  it('reads the [speak] passage and the tone line, and leaves their markers out of the text the view shows', () => {
    expect(parseReply('[speak]Fixed the badge.[/speak]\n\n- one\n- two')).toEqual({ kind: 'reply', rewrite: false, opening: 'Fixed the badge.\n\n- one\n- two', state: null, speak: 'Fixed the badge.', tone: null, heard: [], artifacts: [] });
    expect(parseReply('[tone: calm, slightly amused]\n[rewrite]\n[speak]\nBoth done.\n[/speak]\nDetails.')).toEqual({ kind: 'reply', rewrite: true, opening: 'Both done.\nDetails.', state: null, speak: 'Both done.', tone: 'calm, slightly amused', heard: [], artifacts: [] });
    expect(parseReply('[rewrite]\n[tone: dry]\nNo.')).toMatchObject({ rewrite: true, opening: 'No.', tone: 'dry' });
    expect(parseReply('[speak]Done.[/speak]\n[status]\nGreen.')).toMatchObject({ opening: 'Done.', state: { headline: 'Green.', body: null }, speak: 'Done.' });
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
    expect(splitState('Done.\n[state]\n2/5 fixing tests\n\n- one')).toEqual({ reply: 'Done.', state: { headline: '2/5 fixing tests', body: '- one' } });
    // [status], which earlier sessions write, is the same tag.
    expect(splitState('Done.\n[status]\n# Where it stands\n\n- one')).toEqual({ reply: 'Done.', state: { headline: 'Where it stands', body: '- one' } });
    expect(splitState('Done.\n  [STATE]  \nx')).toEqual({ reply: 'Done.', state: { headline: 'x', body: null } });
    expect(splitState('Done.\n[state]\n')).toEqual({ reply: 'Done.', state: null });
    expect(splitState('Write `[state]` on its own line.')).toEqual({ reply: 'Write `[state]` on its own line.', state: null });
    expect(splitState('See:\n```md\n[state]\nx\n```\nend')).toEqual({ reply: 'See:\n```md\n[state]\nx\n```\nend', state: null });
    expect(splitState('Code:\n    [state]\nx').state).toBeNull();
    expect(splitState('[state] Done').state).toBeNull();
    expect(splitState('[states]\nDone').state).toBeNull();
    expect(splitState('~~~\n```\n[state]\n~~~\n[status]\nafter')).toEqual({ reply: '~~~\n```\n[state]\n~~~', state: { headline: 'after', body: null } });
  });

  it("takes a state's first non-empty line, without leading Markdown marks, as its headline and the rest as its body", () => {
    expect(stateParts('\n\n## **Reviewing** the plan\n\nBody.')).toEqual({ headline: 'Reviewing the plan', body: 'Body.' });
    expect(stateParts('- **3/4 verifying**\n  - sub')).toEqual({ headline: '3/4 verifying', body: '- sub' });
    expect(stateParts('> quoted')).toEqual({ headline: 'quoted', body: null });
    // A line of marks alone stays as written rather than empty.
    expect(stateParts('***\nrest')).toEqual({ headline: '***', body: 'rest' });
    expect(stateParts('  \n ')).toBeNull();
  });

  it('keys copies by letters and digits, without the rewrite tag, and a reply with none by its other characters', () => {
    expect(keyOf('**Done**, see [tts.js](src/tts.js).')).toBe(keyOf('Done, see tts.js.'));
    expect(keyOf('[rewrite] 👍')).not.toBe(keyOf('[rewrite] 👎'));
    expect(keyOf('[rewrite] Yes.')).toBe('Yes');
  });

  it('keys a list by its items without their numbers, which the terminal draws as letters in a nested list (M171)', () => {
    const raw = '1. Queue:\n   1. phone layout;\n   2. GitHub button;\n      1) deeper.\n2. Done.';

    expect(keyOf(raw)).toBe(keyOf('1. Queue:\n   a. phone layout;\n   b. GitHub button;\n      i. deeper.\n2. Done.'));
    expect(keyOf(raw)).toBe(keyOf('Queue: phone layout; GitHub button; deeper. Done.'));
    // A number or word inside a line still counts.
    expect(keyOf('Build 2. Then a. b.')).toBe('Build2Thenab');
    expect(keyOf('Yes. Done.')).not.toBe(keyOf('Done.'));
  });

  it('draws links as the terminal does: the text and its target, the target alone when it is the text, and code spans as written', () => {
    expect(drawnLinks('At [changes.ts:280](file:///D:/x/changes.ts#L280).')).toBe('At changes.ts:280 (file:///D:/x/changes.ts#L280).');
    expect(drawnLinks('See [https://a.dev/x](https://a.dev/x) and [](./b.md).')).toBe('See https://a.dev/x and ./b.md.');
    expect(drawnLinks('Mail [alex@a.dev](mailto:alex@a.dev) or [Alex](mailto:alex@a.dev).')).toBe('Mail alex@a.dev or Alex (alex@a.dev).');
    expect(drawnLinks('[Doc](./d.md "The doc") and `[x](y)`')).toBe('Doc (./d.md) ("The doc") and `[x](y)`');
    // Text that differs from its target only in punctuation or case is not its target.
    expect(drawnLinks('[docs/x](docs-x) and [README](readme)')).toBe('docs/x (docs-x) and README (readme)');
    // A code span closes only at a run of as many backticks as opened it.
    expect(drawnLinks('Use ``a`[x](y)`` and [guide](z).')).toBe('Use ``a`[x](y)`` and guide (z).');
  });

  it("keys a transcript copy by its links' text and also with their targets, so the screen copy drawn either way matches", () => {
    const raw = 'The code is at [changes.ts:280](file:///D:/git/switchboard/packages/hub/src/changes.ts#L280), in `main`.';

    expect(keyOf(raw)).toBe(keyOf('The code is at changes.ts:280, in main.'));
    expect(drawnKeyOf(raw)).toBe(keyOf('The code is at changes.ts:280 (file:///D:/git/switchboard/packages/hub/src/changes.ts#L280), in main.'));
    expect(drawnKeyOf('No links, **bold** and `code`.')).toBeNull();
    // The screen draws a bare www. link with the scheme of its target.
    expect(keyOf('- http://www.i21692: 200')).toBe(keyOf('- www.i21692: 200'));
  });

  it('tells a tag or comment still being drawn', () => {
    expect(endsInOpenTag('Done. [asi')).toBe(true);
    expect(endsInOpenTag('Done. [rewr')).toBe(true);
    expect(endsInOpenTag('Done.\n[sta')).toBe(true);
    expect(endsInOpenTag('Done. [deta')).toBe(true);
    expect(endsInOpenTag('Done. <!--x')).toBe(true);
    expect(endsInOpenTag('Done. <!')).toBe(true);
    expect(endsInOpenTag('Done. [ok]')).toBe(false);
    expect(endsInOpenTag('See [xyz')).toBe(false);
    expect(endsInOpenTag('Done. [spe')).toBe(true);
    expect(endsInOpenTag('Done.[/spe')).toBe(true);
    expect(endsInOpenTag('Done.[/x')).toBe(false);
    expect(endsInOpenTag('Done.\n[artif')).toBe(true);
    expect(endsInOpenTag('Done.\n[artifact: D:/research/rep')).toBe(true);
    expect(endsInOpenTag('Done.\n[artifact: D:/research/report.md]')).toBe(false);
  });
});

describe('artifact tags', () => {
  it('reads each tag alone on its line, with its title and kind, and removes its line from the reply and the status', () => {
    const text = 'Report written.\n[artifact: D:/git/research/topic/2026-11-23/report/summary.md]\n  [artifact: `plans/a plan.md` | title: The plan | kind: plan]\nNext.\n[status]\nWorking.\n[ARTIFACT: <C:/x y/z.html> | kind: page]';

    expect(splitArtifacts(text).artifacts).toEqual([
      { path: 'D:/git/research/topic/2026-11-23/report/summary.md', title: null, kind: null },
      { path: 'plans/a plan.md', title: 'The plan', kind: 'plan' },
      { path: 'C:/x y/z.html', title: null, kind: 'page' },
    ]);
    expect(parseReply(text)).toMatchObject({ opening: 'Report written.\nNext.', state: { headline: 'Working.', body: null }, artifacts: [{ path: 'D:/git/research/topic/2026-11-23/report/summary.md' }, { path: 'plans/a plan.md' }, { path: 'C:/x y/z.html' }] });
  });

  it('leaves a tag in a fenced or indented code block, in inline code or inside a sentence as text, and one with no path', () => {
    const text = 'Write the tag like this:\n```\n[artifact: D:/a.md]\n```\n    [artifact: D:/b.md]\nUse `[artifact: D:/c.md]` or see [artifact: D:/d.md] here.\n[artifact: ]\n~~~md\n[artifact: D:/e.md]\n~~~';

    expect(splitArtifacts(text)).toEqual({ artifacts: [], text });
    expect(parseReply(text).artifacts).toEqual([]);
  });

  it('reads a tag between lines ending in CRLF, and leaves a tag inside a code span that runs across lines as text', () => {
    expect(splitArtifacts('Done.\r\n[artifact: report.html]\r\nNext.')).toEqual({ artifacts: [{ path: 'report.html', title: null, kind: null }], text: 'Done.\r\nNext.' });

    const quoted = 'Write `\n[artifact: secret.md]\n` to list one.';

    expect(splitArtifacts(quoted)).toEqual({ artifacts: [], text: quoted });
    // A span closed on an earlier line leaves a later tag a tag.
    expect(splitArtifacts('Use `a\nb` here.\n[artifact: x.md]').artifacts).toEqual([{ path: 'x.md', title: null, kind: null }]);
    expect(splitArtifacts('An escaped \\` mark.\n[artifact: y.md]\nAnother \\` mark.').artifacts).toEqual([{ path: 'y.md', title: null, kind: null }]);
  });

  it("keeps the rest of the text as written, a code block's blank lines too, dropping only the blank line a removed tag doubles", () => {
    const code = '```py\ns = """a\n\n\n\nb"""\n```';

    expect(splitArtifacts(`${code}\n\n[artifact: D:/r.md]\n\nNext.`).text).toBe(`${code}\n\nNext.`);
    expect(splitArtifacts('[artifact: D:/r.md]\n\nNext.').text).toBe('Next.');
  });

  it('reads a tag after a closed code block', () => {
    expect(splitArtifacts('```\ncode\n```\n[artifact: ./out/report.md]\nDone.')).toEqual({ artifacts: [{ path: './out/report.md', title: null, kind: null }], text: '```\ncode\n```\nDone.' });
  });
});
