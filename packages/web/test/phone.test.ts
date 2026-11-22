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
  it('puts the composer across the whole width on the bottom edge, its end buttons in from the corners and just above the home indicator, and the notes on its edges', () => {
    expect(phone).toContain('#composer, #note { padding: 0; }');
    // No strip as tall as the home indicator's inset below the composer.
    expect(phone).toContain('#composer .composer { border-width: 1px 0 0; border-radius: 0; box-shadow: none; }');
    expect(css).not.toMatch(/#composer[^{]*\{[^}]*padding-bottom: env\(safe-area-inset-bottom\)/);
    expect(phone).toContain('#composer .composer-footer { padding-left: max(5px, calc(env(safe-area-inset-bottom) - env(safe-area-inset-left))); padding-right: max(5px, calc(env(safe-area-inset-bottom) - env(safe-area-inset-right))); padding-bottom: max(5px, min(14px, env(safe-area-inset-bottom))); }');
    expect(phone).toContain('.session-note, .composer-error { border-left: none; border-right: none; border-radius: 0; }');
    expect(phone).not.toContain('off-conversation');
  });

  it('runs every scroller to the bottom edge, padding the end of its content by the home indicator\'s inset unless a composer is below it', () => {
    // No column keeps a strip at its bottom.
    expect(css).not.toMatch(/\.side, \.main, \.detail, #history \{ padding-bottom/);
    expect(css).toContain(':root { --sb-end: env(safe-area-inset-bottom); }\n.main:has(#composer:not([hidden])) { --sb-end: 0px; }');
    expect(css).toMatch(/#list \{[^}]*padding-bottom: calc\(12px \+ var\(--sb-end\)\);/);
    expect(css).toMatch(/(^|\n)\.scroll \{[^}]*padding: 20px 20px calc\(16px \+ var\(--sb-end\)\);/);
    expect(phone).toContain('.scroll { padding: 12px 12px calc(12px + var(--sb-end)); }');
    expect(css).toMatch(/\.artifact-doc \{[^}]*padding: 8px 20px calc\(60px \+ var\(--sb-end\)\);/);
    expect(css).toMatch(/\.hist-body \{[^}]*padding: 16px 24px calc\(48px \+ var\(--sb-end\)\);/);
    expect(css).toMatch(/\.changes-rows \{[^}]*padding: 0 0 var\(--sb-end\);/);
    expect(css).toMatch(/\.diff-host \{[^}]*padding-bottom: var\(--sb-end\);/);
    expect(css).toMatch(/\.scroll\.console-pane \{[^}]*padding: 0 0 var\(--sb-end\);/);
    // A framed HTML or PDF artifact scrolls inside its frame, so the frame ends above the inset.
    expect(css).toContain('.scroll.framed { display: flex; flex-direction: column; padding: 0 0 var(--sb-end); }');
    // Where a short screen hides the composer off the Conversation tab, by the same condition, the other tabs keep the inset.
    expect(css).toContain('#root.off-conversation:not(:has(#composer:focus-within, #composer .composer-error:not([hidden]))) #composer { display: none; }');
    expect(css).toContain('@media (height < 800px) {\n  #root.off-conversation:not(:has(#composer:focus-within, #composer .composer-error:not([hidden]))) > .main { --sb-end: env(safe-area-inset-bottom); }\n}');
    // Full-screen Settings runs to the edge too, its bar holding the inset.
    expect(css).toContain('.settings-backdrop { padding: var(--sb-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);');
    expect(css).toContain('.settings-bar { flex-wrap: wrap; padding: 8px 12px calc(8px + env(safe-area-inset-bottom)); }');
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
    // No scroller hands a drag on to the page, the composer's box never bounces, and a pan outside every scroller does nothing; a pinch zooms.
    expect(css).toContain('body { touch-action: pinch-zoom; }\n* { overscroll-behavior: contain; }\ntextarea { overscroll-behavior: none; }');
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

  it("marks a source's check row on only by its check: a tap or click leaves no tint, keyboard focus an outline, a hovering pointer the hover grey", () => {
    const rows = ':is(.source-menu, .more-source) .menu-row';

    expect(css).toContain(`${rows} { -webkit-tap-highlight-color: transparent; }`);
    // The menus' selection colours on hover and focus are cleared, so a focused row that is off looks as it does unfocused.
    expect(css).toContain(`${rows}:is(:hover, :focus) { outline: none; background: transparent; color: inherit; }`);
    expect(css).toContain(`${rows}:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }`);
    // Only a pointer that hovers tints the row, so a tap leaves no sticky hover; the tint is grey, never the selection colour.
    expect(css).toContain(`@media (hover: hover) { ${rows}:hover { background: var(--vscode-list-hoverBackground); } }`);
    expect(css.indexOf(`${rows}:is(:hover, :focus)`)).toBeGreaterThan(css.indexOf('.menu-row:hover, .menu-row:focus {'));
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
