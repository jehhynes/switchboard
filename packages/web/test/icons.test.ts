import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MARK_GLYPHS, MARK_ICONS } from '@switchboard/core/group';
import { PAGE_ASSETS } from '../dist/index.js';
import type { Mark } from '@switchboard/core/group';

const css = readFileSync(createRequire(import.meta.url).resolve('@vscode/codicons/dist/codicon.css'), 'utf8');

/** A codicon's glyph by its class name, from the codicon.css the page serves. */
function glyphOf(name: string): string | null {
  const match = new RegExp(`\\.codicon-${name}:before \\{ content: "\\\\([0-9a-f]+)" \\}`).exec(css);

  return match === null ? null : String.fromCodePoint(parseInt(match[1]!, 16));
}

describe('the shared mark icons', () => {
  it('name the codicon whose glyph the dock and the pane draw for each mark, so the page, the views and the dock cannot drift', () => {
    for (const mark of Object.keys(MARK_ICONS) as Mark[]) {
      expect([mark, glyphOf(MARK_ICONS[mark])]).toEqual([mark, MARK_GLYPHS[mark]]);
    }
  });

  it('finds no glyph for a name codicon.css lacks', () => {
    expect(glyphOf('no-such-icon')).toBeNull();
  });
});

describe('the spinning codicons', () => {
  const page = PAGE_ASSETS['page.css']!.body;

  it('all stop under reduced motion, though codicon.css spins the loading glyph with a selector that outranks one class', () => {
    // The running mark, Thinking… and the attachment chips spin through this rule, which a bare `.codicon-modifier-spin { animation: none }` loses to.
    expect(css).toMatch(/\.codicon-loading\.codicon-modifier-spin,[^{}]*\{[^}]*animation: codicon-spin/);
    expect(page).toContain('@media (prefers-reduced-motion: reduce) { .codicon-modifier-spin { animation: none !important; } }');
    // No narrower reduced-motion rule for one surface, which is how the header's state icon came to stop alone.
    expect(page.match(/prefers-reduced-motion: reduce\) \{[^{}]*modifier-spin/g)).toHaveLength(1);
  });
});
