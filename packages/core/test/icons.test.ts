import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARK_GLYPHS, MARK_ICONS, SESSION_ICONS } from '../src/group.js';
import { EXTRA_UNICODE_RANGE, extraIconCss, extraIconFont, extraIcons, glyphPath, ICON_FONT, ICON_LICENSE, ICONS_DIR } from '../src/icons.js';

/** A font's tables by tag, as offsets into it. */
function tables(font: Buffer): Map<string, number> {
  return new Map(Array.from({ length: font.readUInt16BE(4) }, (_, index) => [font.toString('latin1', 12 + index * 16, 16 + index * 16), font.readUInt32BE(20 + index * 16)]));
}

/** The glyph index a format 4 cmap subtable of `font` gives `code`, 0 for none. */
function glyphIndex(font: Buffer, code: number): number {
  const cmap = tables(font).get('cmap')!;
  const subtables = Array.from({ length: font.readUInt16BE(cmap + 2) }, (_, index) => cmap + font.readUInt32BE(cmap + 8 + index * 8));
  const at = subtables.find((offset) => font.readUInt16BE(offset) === 4)!;
  const segments = font.readUInt16BE(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;

  for (let segment = 0; segment < segments; segment++) {
    if (code <= font.readUInt16BE(ends + segment * 2)) {
      const start = font.readUInt16BE(starts + segment * 2);
      const range = font.readUInt16BE(ranges + segment * 2);
      const delta = font.readInt16BE(deltas + segment * 2);

      if (code < start) {
        return 0;
      }

      if (range === 0) {
        return (code + delta) & 0xffff;
      }

      // The glyph index from the subtable's glyph array, which the range offset finds from its own place.
      const glyph = font.readUInt16BE(ranges + segment * 2 + range + (code - start) * 2);

      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
  }

  return 0;
}

/** A folder holding the hourglass and the licence, for an SVG of the test's own beside them. */
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'icons-'));

  copyFileSync(join(ICONS_DIR, 'f700-hourglass.svg'), join(dir, 'f700-hourglass.svg'));
  copyFileSync(join(ICONS_DIR, ICON_LICENSE), join(dir, ICON_LICENSE));
  return dir;
}

describe('the extra icons', () => {
  it('draw the usage limit mark and session state as the hourglass, by its sb- name and its code point', () => {
    expect(extraIcons()).toEqual([{ name: 'sb-hourglass', code: 0xf700, file: 'f700-hourglass.svg' }]);
    expect(MARK_ICONS.limited).toBe('sb-hourglass');
    expect(SESSION_ICONS.limited).toBe('sb-hourglass');
    expect(MARK_GLYPHS.limited).toBe('\u{f700}');
  });

  it('match the committed font, so an SVG changed without running gen-icons.mjs fails here', () => {
    const built = extraIconFont();

    expect(built.equals(readFileSync(join(ICONS_DIR, ICON_FONT)))).toBe(true);
    expect(extraIconFont().equals(built)).toBe(true);
  });

  it('build a font whose hourglass is an outline at U+F700, on a 1600 unit em with codicon.ttf\'s ascent and descent, carrying its copyright', () => {
    const font = extraIconFont();
    const table = tables(font);
    const head = table.get('head')!;
    const hhea = table.get('hhea')!;
    const glyf = table.get('glyf')!;
    const loca = table.get('loca')!;
    const index = glyphIndex(font, 0xf700);
    // loca's offsets are 16-bit halves or 32-bit bytes, by head's indexToLocFormat.
    const long = font.readInt16BE(head + 50) === 1;
    const offset = (glyph: number) => (long ? font.readUInt32BE(loca + glyph * 4) : font.readUInt16BE(loca + glyph * 2) * 2);

    expect(font.readUInt16BE(head + 18)).toBe(1600);
    expect([font.readInt16BE(hhea + 4), font.readInt16BE(hhea + 6)]).toEqual([1600, 0]);
    expect(index).toBeGreaterThan(0);
    expect(glyphIndex(font, 0xf701)).toBe(0);
    // Two contours: the glass and its hollow, inside the em.
    expect(font.readInt16BE(glyf + offset(index))).toBe(2);
    // svg2ttf's box always takes in the origin; its top right is the glass's, 1 px in from the em's top and about 3 px from its right.
    expect([font.readInt16BE(glyf + offset(index) + 2), font.readInt16BE(glyf + offset(index) + 4), font.readInt16BE(glyf + offset(index) + 6), font.readInt16BE(glyf + offset(index) + 8)]).toEqual([0, 0, 1303, 1500]);
    expect(font.toString('latin1').replaceAll('\0', '')).toContain('Copyright (c) 2020 Microsoft Corporation, MIT License');
  });

  it('give the codicon family a face for their range only, the licence and a class per icon', () => {
    const css = extraIconCss('./switchboard-icons-abc.ttf');

    expect(css).toContain('@font-face {\n\tfont-family: "codicon";\n\tfont-display: block;\n\tsrc: url("./switchboard-icons-abc.ttf") format("truetype");\n\tunicode-range: U+F700-F7FF;\n}');
    expect(EXTRA_UNICODE_RANGE).toBe('U+F700-F7FF');
    expect(css).toContain('.codicon-sb-hourglass:before { content: "\\f700" }');
    expect(css).toContain('Permission is hereby granted, free of charge');
    expect(css).toContain('Copyright (c) 2020 Microsoft Corporation');
    // The licence sits in one comment that nothing in it ends early.
    expect(css.indexOf('*/')).toBe(css.lastIndexOf('*/'));
    expect(css.indexOf('*/')).toBeLessThan(css.indexOf('@font-face'));
  });

  it('refuse an SVG named outside the scheme, a code point outside the range, and one code point twice', () => {
    const named = folder();
    const outside = folder();
    const twice = folder();

    writeFileSync(join(named, 'hourglass-two.svg'), '');
    writeFileSync(join(outside, 'f800-gauge.svg'), '');
    writeFileSync(join(twice, 'f700-other.svg'), '');

    expect(() => extraIcons(named)).toThrow('hourglass-two.svg is not named <code point>-<name>.svg');
    expect(() => extraIcons(outside)).toThrow("f800-gauge.svg's code point is outside U+F700-F7FF.");
    expect(() => extraIcons(twice)).toThrow('f700-hourglass.svg and f700-other.svg use the same code point.');
  });

  it('refuse an SVG off the 16 px grid or holding anything but plain paths', () => {
    const path = '<path d="M0 0h16v16H0z"/>';

    expect(glyphPath(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${path}</svg>`)).toBe('M0 1600h1600v-1600H0z');
    expect(() => glyphPath(`<svg viewBox="0 0 24 24">${path}</svg>`, 'big.svg')).toThrow('big.svg is not an SVG with viewBox="0 0 16 16".');
    expect(() => glyphPath(`<svg viewBox="0 0 16 16"><g transform="scale(2)">${path}</g></svg>`, 'g.svg')).toThrow('g.svg holds something other than <path d="..."/> elements.');
    expect(() => glyphPath('<svg viewBox="0 0 16 16"><path fill-rule="evenodd" d="M0 0h1v1z"/></svg>', 'rule.svg')).toThrow('rule.svg holds something other than');
    expect(() => glyphPath('<svg viewBox="0 0 16 16"></svg>', 'empty.svg')).toThrow('empty.svg holds something other than');
  });
});
