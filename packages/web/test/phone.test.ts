import { describe, expect, it } from 'vitest';
import { PAGE_ASSETS } from '../dist/index.js';
import { renderMarkdown } from '../src/markdown.js';
import { menuRows } from '../src/header.js';
import { html } from './html.js';
import type { PageAction, PageRow } from '@switchboard/protocol';

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

  it('wraps a very long link, path or word anywhere, and keeps code blocks, tables and media inside the conversation', () => {
    const url = `https://example.com/${'segment'.repeat(60)}?q=${'x'.repeat(200)}`;
    const markup = renderMarkdown(`See ${url} and D:/${'folder/'.repeat(40)}file.ts`);

    // The link stays one unbroken word: the page wraps it, the Markdown does not cut it.
    expect(markup).toContain(`href="${url}"`);
    expect(markup).toContain(`>${url}</a>`);
    expect(css).toMatch(/(^|\n)\.body \{ overflow-wrap: anywhere; \}/);
    expect(css).toMatch(/\.body pre \{[^}]*overflow-x: auto;/);
    expect(css).toMatch(/\.body table \{ display: block; max-width: 100%; overflow-x: auto;/);
    expect(css).toContain('.body img, .body video, .body svg, .body iframe { max-width: 100%; }');
    expect(css).toMatch(/\.message \.box \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.main \{[^}]*min-width: 0;/);
  });

  it('never scrolls or bounces as a whole, its panes panning only up and down and code and tables also sideways', () => {
    expect(css).toMatch(/html, body \{ height: 100%; margin: 0; overflow: hidden; overscroll-behavior: none; \}/);
    expect(css).toMatch(/#list \{[^}]*touch-action: pan-y pinch-zoom;/);
    expect(css).toMatch(/\.scroll \{[^}]*touch-action: pan-y pinch-zoom;/);
    expect(css).toMatch(/\.body pre \{[^}]*touch-action: pan-x pan-y pinch-zoom;/);
    expect(css).toMatch(/\.body table \{[^}]*touch-action: pan-x pan-y pinch-zoom;/);
  });

  it("makes every icon button in the bars 44 px with its glyph at 20 px, centred, on a touch screen, without showing a button the layout hides", () => {
    const touch = /@media \(hover: none\), \(pointer: coarse\) \{\n  :is\(\.header, [^)]*\) :is\(button\.icon, a\.icon, button\.actions, button\.persona\) \{([^}]*)\}\n  :is\([^)]*\) :is\([^)]*\) > \.codicon \{([^}]*)\}/.exec(css);

    expect(touch?.[1]).toContain('align-items: center; justify-content: center;');
    // By descent, not as a child, so the header's View options button inside its menu's anchor is as large as the buttons beside it.
    expect(touch?.[1]).toContain('min-width: 44px; min-height: 44px;');
    expect(css).toContain('.header button.icon { justify-content: center; min-width: 26px; height: 26px; }');
    expect(css).not.toContain('.header > button.icon,');
    // A display here would show the Work items button, which only a drawer shows.
    expect(touch?.[1]).not.toContain('display');
    expect(touch?.[2]).toContain('font-size: 20px; line-height: 1;');
  });

  it("hides the header's main control under 768 px, and the Actions menu starts with it whatever it is", () => {
    expect(css).toContain('@media (width < 768px) { .header > button.row-main { display: none; } }');

    for (const label of ['Approve', 'Mark done', 'Resume', 'Open in Claude', 'Answer in terminal']) {
      const main = { label, icon: 'check', group: 'main' } as PageAction;
      const row = { workItemId: 1, ticketId: null, ticket: 'gh 1', url: '', links: [], actions: [{ label: 'Stop', icon: 'debug-stop', group: 'state' } as PageAction, main], pastes: [], opens: [], terminal: false, history: null } as unknown as PageRow;
      const host = document.createElement('ul');

      host.innerHTML = html(menuRows(row, { acting: false, linkMenu: false }));
      expect(host.querySelector('[data-action="row-action"]')?.getAttribute('data-label')).toBe(label);
    }
  });
});
