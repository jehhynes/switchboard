import { describe, expect, it } from 'vitest';
import { hasUnspokenText, replyBody, spokenParts } from '../src/replyBody.js';
import type { ReplyRender } from '../src/replyBody.js';

const render: ReplyRender = { markdown: (text, last) => `<md${last ? ' last' : ''}>${text.trim()}</md>`, escape: (text) => text.replace(/</g, '&lt;') };

describe("a reply's body", () => {
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

  it('takes a passage at its first place, so text that repeats it word for word before it would take its place', () => {
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

  it('draws each passage once: only the primary response while folded, else the primary response in its place among the details', () => {
    expect(replyBody('Done.\n\nMore.', 'Done.', null, true, render)).toBe('<div class="reply-primary"><md>Done.</md></div>');
    expect(replyBody('Done.\n\nMore.', 'Done.', null, false, render)).toBe('<div class="reply-primary"><md>Done.</md></div><div class="reply-details"><md last>More.</md></div>');
    expect(replyBody('Done.', 'Done.', null, false, render)).toBe('<div class="reply-primary"><md>Done.</md></div>');
    // A passage not found in the text: the text as written, rather than the passage twice.
    expect(replyBody('Something else.', 'Done.', null, false, render)).toBe('<md last>Something else.</md>');
  });

  it('dims the part of an interrupted passage not heard, counting through several passages', () => {
    expect(replyBody('Fixed it. More.', 'Fixed it.', 3, true, render)).toBe('<div class="reply-primary"><p class="passage">Fix<span class="unheard">ed it.</span></p></div>');
    const two = replyBody('One <b>.\n\nMid.\n\nTwo.', 'One <b>. Two.', 10, false, render);

    // All of the first passage heard, as Markdown; the second cut after its first character.
    expect(two).toBe('<div class="reply-primary"><md>One <b>.</md></div><div class="reply-details"><md>Mid.</md></div><div class="reply-primary"><p class="passage">T<span class="unheard">wo.</span></p></div>');
    expect(replyBody('One.\n\nTwo.', 'One. Two.', 2, false, render)).toContain('<p class="passage"><span class="unheard">Two.</span></p>');
    expect(replyBody('Fixed <b>.', 'Fixed <b>.', 2, true, render)).toContain('<span class="unheard">xed &lt;b>.</span>');
    // The voice counts the characters it read, without the Markdown's marks: seven heard of "Hello world, again." end after "w".
    expect(replyBody('Hello **world**, again.', 'Hello **world**, again.', 7, true, render)).toContain('<p class="passage">Hello **w<span class="unheard">orld**, again.</span></p>');
    expect(replyBody('**One.**\n\nMid.\n\nTwo.', '**One.** Two.', 6, false, render)).toContain('<p class="passage">T<span class="unheard">wo.</span></p>');
    // A link's text is read and its target is not; a list marker is not read.
    expect(replyBody('[go](https://example.com) now', '[go](https://example.com) now', 1, true, render)).toContain('<p class="passage">[g<span class="unheard">o](https://example.com) now</span></p>');
    expect(replyBody('[go](https://example.com) now', '[go](https://example.com) now', 4, true, render)).toContain('<p class="passage">[go](https://example.com) n<span class="unheard">ow</span></p>');
    expect(replyBody('- Go now', '- Go now', 1, true, render)).toContain('<p class="passage">- G<span class="unheard">o now</span></p>');
    expect(replyBody('Fixed it.', 'Fixed it.', 0, true, render)).toContain('<p class="passage"><span class="unheard">Fixed it.</span></p>');
  });
});
