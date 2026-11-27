import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARK_GLYPHS, MARK_ICONS } from '@switchboard/core/group';
import { EXTRA_RANGE, ICON_FONT, ICONS_DIR } from '@switchboard/core/icons';
import { PAGE_ASSETS } from '../dist/index.js';
import type { Mark } from '@switchboard/core/group';

const codicons = createRequire(import.meta.url).resolve('@vscode/codicons/dist/codicon.css');
/** The codicon.css the page serves: Codicons' own, then Switchboard's extra icons. */
const css = PAGE_ASSETS['codicon.css']!.body;

/** A codicon's glyph by its class name, from the codicon.css the page serves. */
function glyphOf(name: string): string | null {
  const match = new RegExp(`\\.codicon-${name}:before \\{ content: "\\\\([0-9a-f]+)" \\}`).exec(css);

  return match === null ? null : String.fromCodePoint(parseInt(match[1]!, 16));
}

describe('the shared mark icons', () => {
  it('name the codicon whose glyph MARK_GLYPHS gives each mark, so the page and the browser extension pills cannot drift', () => {
    // The codicon the panel shows for each mark, which the extension's pills draw by its glyph.
    expect(MARK_ICONS).toEqual({ question: 'question', permission: 'shield', send: 'send', review: 'eye', finished: 'eye', blocked: 'debug-pause', failed: 'error', queued: 'clock', setup: 'tools', running: 'loading', limited: 'sb-hourglass', idle: 'circle-large-outline', triaging: 'loading', 'done-session': 'check', 'done-operator': 'account', 'done-unassigned': 'sign-out' });

    for (const mark of Object.keys(MARK_ICONS) as Mark[]) {
      expect([mark, glyphOf(MARK_ICONS[mark])]).toEqual([mark, MARK_GLYPHS[mark]]);
    }

    expect(Object.keys(MARK_GLYPHS).sort()).toEqual(Object.keys(MARK_ICONS).sort());
  });
});

describe("the page's extra icons", () => {
  it('add the extra font as a codicon face for their range only, after Codicons\' own face, from the committed font', () => {
    const faces = [...css.matchAll(/@font-face \{([^}]*)\}/g)].map((face) => face[1]!.replace(/\s+/g, ' ').trim());

    expect(faces).toEqual([
      `font-family: "codicon"; font-display: block; src: url("./${PAGE_ASSETS['codicon.ttf']!.hashed!}") format("truetype");`,
      `font-family: "codicon"; font-display: block; src: url("./${PAGE_ASSETS[ICON_FONT]!.hashed!}") format("truetype"); unicode-range: U+F700-F7FF;`,
    ]);
    expect(PAGE_ASSETS[ICON_FONT]!.hashed).toMatch(/^switchboard-icons-[0-9a-f]{16}\.ttf$/);
    expect(Buffer.from(PAGE_ASSETS[ICON_FONT]!.body, 'base64').equals(readFileSync(join(ICONS_DIR, ICON_FONT)))).toBe(true);
    expect(PAGE_ASSETS[ICON_FONT]!.mime).toBe('font/ttf');
    expect(css).toContain('Copyright (c) 2020 Microsoft Corporation');
  });

  it('collide with no codicon by name or code point', () => {
    const own = readFileSync(codicons, 'utf8');
    const codes = [...own.matchAll(/:before \{ content: "\\([0-9a-f]+)" \}/g)].map((match) => parseInt(match[1]!, 16));

    expect(codes.length).toBeGreaterThan(500);
    expect(codes.filter((code) => code >= EXTRA_RANGE.first && code <= EXTRA_RANGE.last)).toEqual([]);
    expect(own).not.toMatch(/\.codicon-sb-/);
    expect(glyphOf('sb-hourglass')).toBe('\u{f700}');
  });
});

describe('the spinning codicons', () => {
  const page = PAGE_ASSETS['page.css']!.body;

  it('keep spinning under reduced motion, while the other reduced-motion rules stay', () => {
    // Each reduced-motion block whole, over as many lines as it takes.
    const reduced = page.split(/@media\s*\(prefers-reduced-motion:\s*reduce\)/).slice(1).map((rest) => rest.slice(0, rest.indexOf('}\n') + 1).replace(/\s+/g, ' '));

    expect(page).toMatch(/:is\(\.codicon-modifier-spin, \.mic-ring\)::before \{[^}]*animation: codicon-spin /);
    expect(reduced.filter((rule) => /spin/.test(rule))).toEqual([]);
    expect(reduced.some((rule) => rule.includes('.composer .mic .codicon { animation: none; }'))).toBe(true);
    expect(reduced.length).toBeGreaterThan(1);
  });

  /** Every rule in the page's stylesheet, comments removed, as its selector and its declarations by property, the rules inside an @media block included. */
  const rules = [...page.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim(),
    body: Object.fromEntries(match[2]!.split(';').map((one) => one.trim()).filter((one) => one !== '').map((one) => [one.slice(0, one.indexOf(':')).trim(), one.slice(one.indexOf(':') + 1).trim()])),
  }));
  const rule = (selector: string): Record<string, string> | undefined => rules.find((one) => one.selector === selector)?.body;
  const spinner = /codicon-modifier-spin|mic-ring/;

  it('turn only each spinner\'s ::before, on its own layer, in a box that clips its paint and keeps its baseline', () => {
    expect(rules.filter((one) => one.selector === '.codicon.codicon-modifier-spin, .mic-ring')).toHaveLength(1);
    expect(rule('.codicon.codicon-modifier-spin, .mic-ring')).toMatchObject({ animation: 'none', contain: 'paint', 'overflow-clip-margin': '1px' });
    expect(rule(':is(.codicon-modifier-spin, .mic-ring)::before')).toMatchObject({ display: 'block', width: '1em', height: '1em', 'line-height': '1', 'text-align': 'center', 'transform-origin': '50% 50%', 'will-change': 'transform', animation: 'codicon-spin 1s linear infinite' });
    // Layout containment would take the box's baseline away and move it in a line of text.
    expect(rules.filter((one) => spinner.test(one.selector) && /layout|strict|content|size/.test(one.body.contain ?? ''))).toEqual([]);
  });

  it('set no other animation on a spinner or its ::before, so every spinner keeps the shared rule', () => {
    const animated = rules.filter((one) => spinner.test(one.selector) && ('animation' in one.body || 'animation-name' in one.body)).map((one) => one.selector);

    expect(animated).toEqual(['.codicon.codicon-modifier-spin, .mic-ring', ':is(.codicon-modifier-spin, .mic-ring)::before']);
    expect(rules.filter((one) => one.selector.includes('state-icon') && 'animation' in one.body)).toEqual([]);
  });

  it('come after codicon.css, whose own spinning rule the box\'s rule overrides at the same specificity', () => {
    const shell = PAGE_ASSETS['index.html']!.body;

    expect(css).toMatch(/\.codicon-loading\.codicon-modifier-spin,?[^{]*\{[^}]*animation: codicon-spin/);
    expect(shell.indexOf(PAGE_ASSETS['codicon.css']!.hashed!)).toBeGreaterThan(-1);
    expect(shell.indexOf(PAGE_ASSETS['page.css']!.hashed!)).toBeGreaterThan(shell.indexOf(PAGE_ASSETS['codicon.css']!.hashed!));
  });

  it('draw the mic\'s starting ring as a whole square round the mic\'s middle, its ::before the ring', () => {
    expect(rule('.mic-ring')).toMatchObject({ position: 'absolute', left: '50%', top: '50%', width: '24px', height: '24px', margin: '-12px 0 0 -12px' });
    expect(rule('.mic-ring::before')).toMatchObject({ content: "''", 'box-sizing': 'border-box', width: '100%', height: '100%', 'border-radius': '50%' });
  });
});
