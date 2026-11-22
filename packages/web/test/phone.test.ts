import { describe, expect, it } from 'vitest';
import { PAGE_ASSETS } from '../dist/index.js';
import { renderMarkdown } from '../src/markdown.js';

// The page's rules for a phone's screen (architecture.md § Web page), read from the built page.css.
const css = PAGE_ASSETS['page.css']!.body;
/** The phone block: the rules under `@media (max-width: 600px)`. */
const phone = /@media \(max-width: 600px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

describe('the page on a phone', () => {
  it('puts the composer across the whole width on the bottom edge, the home indicator inside it, and the notes on its edges', () => {
    expect(phone).toContain('#composer, #note { padding: 0; }');
    expect(phone).toContain('#composer .composer { border-width: 1px 0 0; border-radius: 0; box-shadow: none; padding-bottom: env(safe-area-inset-bottom); }');
    // The conversation's own bottom inset goes while the composer holds it, so it is not counted twice.
    expect(phone).toContain('.main:has(#composer:not([hidden])) { padding-bottom: 0; }');
    expect(phone).toContain('.session-note, .composer-error { border-left: none; border-right: none; border-radius: 0; }');
    // Where a short screen hides the composer off the Conversation tab, by the same condition, the conversation keeps the inset.
    expect(css).toContain('#root.off-conversation:not(:has(#composer:focus-within, #composer .composer-error:not([hidden]))) #composer { display: none; }');
    // Only under 800 px of height, where that rule hides it: a taller phone keeps the composer, with the inset inside it.
    expect(css).toContain('@media (max-width: 600px) and (height < 800px) {\n  #root.off-conversation:not(:has(#composer:focus-within, #composer .composer-error:not([hidden]))) > .main { padding-bottom: env(safe-area-inset-bottom); }\n}');
    expect(phone).not.toContain('off-conversation');
  });

});
