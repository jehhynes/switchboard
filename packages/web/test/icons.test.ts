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

  it('keep spinning under reduced motion, as the dock and the Conversation view do, while the other reduced-motion rules stay', () => {
    // Each reduced-motion block whole, over as many lines as it takes.
    const reduced = page.split(/@media\s*\(prefers-reduced-motion:\s*reduce\)/).slice(1).map((rest) => rest.slice(0, rest.indexOf('}\n') + 1).replace(/\s+/g, ' '));

    expect(page).toMatch(/\.codicon-modifier-spin \{ animation: codicon-spin /);
    expect(reduced.filter((rule) => /spin/.test(rule))).toEqual([]);
    expect(reduced.some((rule) => rule.includes('.composer .mic .codicon { animation: none; }'))).toBe(true);
    expect(reduced.length).toBeGreaterThan(1);
  });
});
