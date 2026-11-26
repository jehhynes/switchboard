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
    expect(phone).toContain('.session-note { border-left: none; border-right: none; border-radius: 0; }');
    expect(phone).not.toContain('off-conversation');
  });

  it('runs every scroller to the bottom edge, padding the end of its content by the home indicator\'s inset unless a composer is below it', () => {
    // No column keeps a strip at its bottom.
    expect(css).not.toMatch(/\.side, \.main, \.detail \{ padding-bottom/);
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
    // Where the composer hides off the Conversation tab, by the same condition, the other tabs keep the inset.
    expect(css).toContain('#root.off-conversation #note, #root.off-conversation #composer { display: none; }');
    expect(css).toContain('\n#root.off-conversation > .main { --sb-end: env(safe-area-inset-bottom); }\n');
    // Full-screen Settings runs to the edge too, its bar holding the inset, or without the bar its page and navigation.
    expect(css).toContain('.settings-backdrop { padding: var(--sb-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);');
    expect(css).toContain('.settings-bar { min-height: calc(52px + env(safe-area-inset-bottom)); padding: 3px 12px calc(3px + env(safe-area-inset-bottom)); }');
    expect(css).toContain('.settings:not(:has(> .settings-bar)) :is(.settings-page, .settings-nav) { padding-bottom: calc(24px + env(safe-area-inset-bottom)); }');
  });

  it('gives a conversation under 600 px wide, by its own width, its side padding, dot gutter, list indent and bubble room, and leaves a wider one as it was', () => {
    const narrow = /@container conversation \(max-width: 600px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';

    // The conversation's pane is the container, so a narrow column on a wide screen narrows too, and a phone's width alone does not.
    expect(css).toMatch(/(^|\n)\.main \{[^}]*container: conversation \/ inline-size;/);
    expect(narrow).toContain('.scroll:has(> .timeline) { padding-left: 8px; padding-right: 8px; }');
    // A conversation narrowed on its sash keeps its timeline as wide as the pane less that padding.
    expect(narrow).toContain('.timeline { max-width: calc(var(--chat-width, 940px) - 16px); }');
    expect(narrow).toContain('.reply, .timeline > li.artifact { padding-left: 20px; }');
    expect(narrow).toContain('.reply .dot { left: 4px; }');
    expect(narrow).toContain('.body ul, .body ol { padding-inline-start: 1.5em; }');
    expect(narrow).toContain('.message .bubble { max-width: calc(100% - 24px); }');
    expect(phone).not.toContain('.bubble');
    // Wider, our messages' bubbles keep their room and the replies their gutter; a reply has no bubble.
    expect(css).toMatch(/(^|\n)\.message \.bubble \{[^}]*max-width: 85%;/);
    expect(css).not.toContain('speech-bubble');
    expect(css).toMatch(/(^|\n)\.reply \{ padding-left: 30px; \}/);
    expect(css).toMatch(/(^|\n)\.body ul, \.body ol \{ margin: 1em 0; padding-inline-start: 2em; \}/);
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
    // The composer's box never bounces, and a pan outside every scroller does nothing; a pinch zooms.
    expect(css).toContain('body { touch-action: pinch-zoom; }\ntextarea { overscroll-behavior: none; }');
    expect(css).toMatch(/#list \{[^}]*touch-action: pan-y pinch-zoom;/);
    expect(css).toMatch(/\.scroll \{[^}]*touch-action: pan-y pinch-zoom;/);
    expect(css).toMatch(/\.body pre \{[^}]*touch-action: pan-x pan-y pinch-zoom;/);
    expect(css).toMatch(/\.body table \{[^}]*touch-action: pan-x pan-y pinch-zoom;/);
  });

  it('keeps each drag in the pane, popup or dialog that scrolls, while a vertical pan from a table, code, a nested scroller or clipped text scrolls its pane', () => {
    // Chrome and Edge give a pan to the innermost scroll container with contain, even one that cannot scroll that way or clips with overflow: hidden.
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector!.trim(), body: body! }));
    const overscroll = (selector: string): string[] => rules.filter((rule) => rule.selector === selector).flatMap((rule) => [...rule.body.matchAll(/overscroll-behavior(-[xy])?: (\w+)/g)].map((match) => match[2]!));
    /** Scrollers inside a pane, which hand a vertical pan to it. */
    const nested = ['.prompt-screen'];
    const vertical = rules.filter((rule) => /(^|[\s;])overflow(-y)?: (auto|scroll)/.test(rule.body)).map((rule) => rule.selector);
    const sideways = rules.filter((rule) => /overflow-x: (auto|scroll)/.test(rule.body) && !/(^|[\s;])overflow(-y)?: /.test(rule.body)).map((rule) => rule.selector);

    // No rule for every box, however written, such as `*` or `:where(*)`.
    expect(rules.filter((rule) => rule.selector.includes('*') && rule.body.includes('overscroll-behavior')).map((rule) => rule.selector)).toEqual([]);
    expect(vertical).toEqual(expect.arrayContaining(['#list', '.scroll', '.artifact-doc', '.local-entries', '.menu', '.sheet', '.hist-body', '.settings-page', '.changes-rows', '.diff-host', '.prompt-screen']));
    for (const selector of vertical) {
      expect([selector, overscroll(selector)]).toEqual([selector, nested.includes(selector) ? [] : expect.arrayContaining(['contain'])]);
    }
    expect(sideways).toEqual(expect.arrayContaining(['.body pre', '.body table', '.body.md-doc pre', '.body.md-doc table', '.settings-table-scroll']));
    for (const selector of sideways) {
      expect([selector, overscroll(selector)]).toEqual([selector, []]);
    }
    for (const rule of rules.filter((one) => /overflow(-[xy])?: (hidden|clip)/.test(one.body))) {
      expect([rule.selector, rule.body]).not.toEqual([rule.selector, expect.stringMatching(/overscroll-behavior(-y)?: contain/)]);
    }
  });

  it("makes every icon button in the bars 44 px with its glyph at 20 px, centred, on a touch screen, without showing a button the layout hides", () => {
    const touch = /@media \(hover: none\), \(pointer: coarse\) \{\n  :is\(\.header, [^)]*\) :is\(button\.icon, a\.icon, button\.actions\) \{([^}]*)\}\n  :is\([^)]*\) :is\([^)]*\) > \.codicon \{([^}]*)\}/.exec(css);

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

  it('keeps every text at its set size on a phone turned to landscape, where iOS would enlarge long blocks, with the viewport at the device width', () => {
    expect(css).toMatch(/(^|\n)html \{ -webkit-text-size-adjust: 100%; text-size-adjust: 100%; \}/);
    expect(css).not.toMatch(/text-size-adjust: (?!100%)/);
    expect(PAGE_ASSETS['index.html']!.body).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    expect(PAGE_ASSETS['index.html']!.body).toContain('html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%;');
  });

  it("shows the header's main control as its icon alone in the phone's layout, and the Actions menu starts with it whatever it is", () => {
    // A 44 px target, its label kept for a screen reader but not drawn (the operator's decision, 2026-11-25).
    expect(css).toContain(':where(html.phone) .header > button.row-main { position: relative; justify-content: center; min-width: 44px; min-height: 44px; padding: 0; }');
    expect(css).toContain(':where(html.phone) .header > button.row-main > .row-main-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }');
    expect(css).not.toMatch(/button\.row-main \{[^}]*display: none/);

    for (const label of ['Approve', 'Mark done', 'Resume', 'Open in Claude', 'Answer in terminal']) {
      const main = { label, icon: 'check', group: 'main' } as PageAction;
      const row = { workItemId: 1, ticketId: null, ticket: 'gh 1', url: '', links: [], actions: [{ label: 'Stop session', icon: 'debug-stop', group: 'state' } as PageAction, main], pastes: [], opens: [], history: null } as unknown as PageRow;
      const host = document.createElement('ul');

      host.innerHTML = html(menuRows(row, { acting: false, linkMenu: false, copyMenu: false }));
      expect(host.querySelector('[data-action="row-action"]')?.getAttribute('data-label')).toBe(label);
    }
  });
});
