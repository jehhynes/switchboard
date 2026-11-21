import { describe, expect, it } from 'vitest';
import { hasUnspokenText, spokenBody, spokenParts } from '../src/spokenBubble.js';
import type { SpokenRender } from '../src/spokenBubble.js';

const render: SpokenRender = { markdown: (text, last) => `<md${last ? ' last' : ''}>${text.trim()}</md>`, escape: (text) => text.replace(/</g, '&lt;') };

describe('the spoken passage bubble', () => {
  it('cuts a reply round its passage, wherever it is, and keeps a reply that is only its passage whole', () => {
    expect(spokenParts('Done. The tests pass.\n\n- one\n- two', 'Done. The tests pass.')).toEqual([
      { spoken: true, text: 'Done. The tests pass.', at: 0 },
      { spoken: false, text: '\n\n- one\n- two', at: 0 },
    ]);
    expect(spokenParts('Intro.\n\nDone.\n\nMore.', 'Done.')?.map((part) => part.spoken)).toEqual([false, true, false]);
    expect(spokenParts('Done.', 'Done.')).toEqual([{ spoken: true, text: 'Done.', at: 0 }]);
  });

  it('finds several passages, which the reader joins with spaces, each in its place and in order', () => {
    expect(spokenParts('First part.\n\nMiddle text.\n\nSecond part.', 'First part. Second part.')).toEqual([
      { spoken: true, text: 'First part.', at: 0 },
      { spoken: false, text: '\n\nMiddle text.\n\n', at: 0 },
      { spoken: true, text: 'Second part.', at: 12 },
    ]);
  });

  it('takes a passage at its first place, so text that repeats it word for word before it would take its bubble', () => {
    expect(spokenParts('Done.\n\nMore.\n\nDone.', 'Done.')).toEqual([{ spoken: true, text: 'Done.', at: 0 }, { spoken: false, text: '\n\nMore.\n\nDone.', at: 0 }]);
  });

  it('tells a reply that is all passage, even several on their own lines, from one with text besides', () => {
    expect(hasUnspokenText('one\ntwo', 'one two')).toBe(false);
    expect(hasUnspokenText('Done.', 'Done.')).toBe(false);
    expect(hasUnspokenText('Done.\n\nMore.', 'Done.')).toBe(true);
    expect(hasUnspokenText('Something else.', 'Done.')).toBe(true);
  });

  it('finds no parts when a passage is not in the text', () => {
    expect(spokenParts('Something else.', 'Done.')).toBeNull();
  });

  it('draws each passage once: only the bubble while folded, else the bubble in its place among the rest', () => {
    expect(spokenBody('Done.\n\nMore.', 'Done.', null, true, render)).toBe('<div class="speech-bubble"><md>Done.</md></div>');
    expect(spokenBody('Done.\n\nMore.', 'Done.', null, false, render)).toBe('<div class="speech-bubble"><md>Done.</md></div><md last>More.</md>');
    expect(spokenBody('Done.', 'Done.', null, false, render)).toBe('<div class="speech-bubble"><md>Done.</md></div>');
    // A passage not found in the text: the text as written, with no bubble, rather than the passage twice.
    expect(spokenBody('Something else.', 'Done.', null, false, render)).toBe('<md last>Something else.</md>');
  });

  it('dims the part of an interrupted passage not heard, in the bubble, counting through several passages', () => {
    expect(spokenBody('Fixed it. More.', 'Fixed it.', 3, true, render)).toBe('<div class="speech-bubble"><p class="passage">Fix<span class="unheard">ed it.</span></p></div>');
    const two = spokenBody('One <b>.\n\nMid.\n\nTwo.', 'One <b>. Two.', 10, false, render);

    // All of the first passage heard, as Markdown; the second cut after its first character.
    expect(two).toBe('<div class="speech-bubble"><md>One <b>.</md></div><md>Mid.</md><div class="speech-bubble"><p class="passage">T<span class="unheard">wo.</span></p></div>');
    expect(spokenBody('One.\n\nTwo.', 'One. Two.', 2, false, render)).toContain('<p class="passage"><span class="unheard">Two.</span></p>');
    expect(spokenBody('Fixed <b>.', 'Fixed <b>.', 2, true, render)).toContain('<span class="unheard">xed &lt;b>.</span>');
    // The voice counts the characters it read, without the Markdown's marks: seven heard of "Hello world, again." end after "w".
    expect(spokenBody('Hello **world**, again.', 'Hello **world**, again.', 7, true, render)).toContain('<p class="passage">Hello **w<span class="unheard">orld**, again.</span></p>');
    expect(spokenBody('**One.**\n\nMid.\n\nTwo.', '**One.** Two.', 6, false, render)).toContain('<p class="passage">T<span class="unheard">wo.</span></p>');
    // A link's text is read and its target is not; a list marker is not read.
    expect(spokenBody('[go](https://example.com) now', '[go](https://example.com) now', 1, true, render)).toContain('<p class="passage">[g<span class="unheard">o](https://example.com) now</span></p>');
    expect(spokenBody('[go](https://example.com) now', '[go](https://example.com) now', 4, true, render)).toContain('<p class="passage">[go](https://example.com) n<span class="unheard">ow</span></p>');
    expect(spokenBody('- Go now', '- Go now', 1, true, render)).toContain('<p class="passage">- G<span class="unheard">o now</span></p>');
    expect(spokenBody('Fixed it.', 'Fixed it.', 0, true, render)).toContain('<p class="passage"><span class="unheard">Fixed it.</span></p>');
  });
});
