import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Switchboard's extra icons (architecture.md § Web page, Extra icons): glyphs Codicons lacks, in a small font of their own beside codicon.ttf.
 * Each is an SVG in packages/core/icons named `<code point>-<name>.svg` on a 16 px grid; gen-icons.mjs builds switchboard-icons.ttf from them.
 * The page and the extensions load the font as a second face of the codicon family, limited to `EXTRA_RANGE`, so a class name
 * (`codicon codicon-sb-<name>`) and a raw character both draw it wherever codicons draw.
 */

/** The folder of the SVGs, the font and its licence. */
// From the module's path, not `new URL`, which a test's jsdom replaces with a URL that fileURLToPath refuses.
export const ICONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

/** The font's file name in ICONS_DIR and in each build that ships it. */
export const ICON_FONT = 'switchboard-icons.ttf';

/** The licence of the icons, shipped beside the font. */
export const ICON_LICENSE = 'LICENSE.txt';

/** The code points the extra icons may use: private use, above every codicon (U+EA60 to U+ECE7 in 0.0.46). */
export const EXTRA_RANGE = { first: 0xf700, last: 0xf7ff } as const;

/** The CSS `unicode-range` of EXTRA_RANGE. */
export const EXTRA_UNICODE_RANGE = `U+${EXTRA_RANGE.first.toString(16).toUpperCase()}-${EXTRA_RANGE.last.toString(16).toUpperCase()}`;

/** The prefix of an extra icon's name, after `codicon-` in its class; no codicon starts with it. */
export const EXTRA_PREFIX = 'sb-';

/** The font's grid: 100 units to the SVGs' pixel. Its ascent is the whole em and its descent 0, as codicon.ttf's are, so both faces share a baseline. */
const UNITS_PER_EM = 1600;
const SVG_SIZE = 16;

export type ExtraIcon = { name: string; code: number; file: string };

/** The extra icons in ICONS_DIR (or `dir`), by code point; refuses a file name or code point outside the scheme, or a code point used twice. */
export function extraIcons(dir: string = ICONS_DIR): ExtraIcon[] {
  const icons = readdirSync(dir)
    .filter((file) => file.endsWith('.svg'))
    .map((file) => {
      const match = /^([0-9a-f]{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.svg$/.exec(file);

      if (match === null) {
        throw new Error(`${file} is not named <code point>-<name>.svg, as f700-hourglass.svg is.`);
      }

      const code = parseInt(match[1]!, 16);

      if (code < EXTRA_RANGE.first || code > EXTRA_RANGE.last) {
        throw new Error(`${file}'s code point is outside ${EXTRA_UNICODE_RANGE}.`);
      }

      return { name: `${EXTRA_PREFIX}${match[2]!}`, code, file };
    })
    .sort((a, b) => a.code - b.code);

  icons.forEach((icon, index) => {
    if (index > 0 && icons[index - 1]!.code === icon.code) {
      throw new Error(`${icons[index - 1]!.file} and ${icon.file} use the same code point.`);
    }
  });

  return icons;
}

/** One SVG's outline as a font glyph's path: its paths joined, y turned upward and scaled to the font's grid. */
export function glyphPath(svg: string, file = 'The SVG'): string {
  const parse = createRequire(import.meta.url)('svgpath') as (d: string) => { scale(x: number, y: number): ReturnType<typeof parse>; translate(x: number, y: number): ReturnType<typeof parse>; round(digits: number): ReturnType<typeof parse>; toString(): string };
  const root = /^\s*<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/.exec(svg);

  if (root === null || !/\bviewBox="0 0 16 16"/.test(root[1]!)) {
    throw new Error(`${file} is not an SVG with viewBox="0 0 16 16".`);
  }

  // Only plain paths, which a font draws as they are: a transform, a fill rule or another shape would draw differently or not at all.
  const paths = [...root[2]!.matchAll(/<path d="([^"]+)"\s*\/>/g)];

  if (paths.length === 0 || root[2]!.replace(/<path d="[^"]+"\s*\/>/g, '').trim() !== '') {
    throw new Error(`${file} holds something other than <path d="..."/> elements.`);
  }

  const scale = UNITS_PER_EM / SVG_SIZE;

  return parse(paths.map((path) => path[1]).join(' ')).scale(scale, -scale).translate(0, UNITS_PER_EM).round(2).toString();
}

/** The font of the extra icons in `dir`, the same bytes for the same SVGs. */
export function extraIconFont(dir: string = ICONS_DIR): Buffer {
  const svg2ttf = createRequire(import.meta.url)('svg2ttf') as (font: string, options: Record<string, unknown>) => { buffer: Uint8Array };
  const glyphs = extraIcons(dir).map((icon) => `<glyph glyph-name="${icon.name}" unicode="&#x${icon.code.toString(16)};" horiz-adv-x="${UNITS_PER_EM}" d="${glyphPath(readFileSync(join(dir, icon.file), 'utf8'), icon.file)}"/>`);
  const font = `<svg xmlns="http://www.w3.org/2000/svg"><defs><font id="switchboard-icons" horiz-adv-x="${UNITS_PER_EM}"><font-face font-family="switchboard-icons" units-per-em="${UNITS_PER_EM}" ascent="${UNITS_PER_EM}" descent="0"/><missing-glyph horiz-adv-x="0"/>${glyphs.join('')}</font></defs></svg>`;

  return Buffer.from(
    svg2ttf(font, {
      // A fixed creation time, so the font changes only with its glyphs.
      ts: 0,
      version: '1.0',
      copyright: 'Glyphs from Fluent UI System Icons, Copyright (c) 2020 Microsoft Corporation, MIT License; see LICENSE.txt beside this font.',
      description: "Switchboard's icons that Codicons lacks.",
      url: 'https://github.com/microsoft/fluentui-system-icons',
    }).buffer,
  );
}

/**
 * The CSS that adds the extra icons to the codicon family: the font as a face for EXTRA_RANGE only, with the licence in a comment, and a
 * `.codicon-sb-<name>:before` rule for each, written as codicon.css writes its own. `url` is the font's URL from the stylesheet.
 */
export function extraIconCss(url: string, dir: string = ICONS_DIR): string {
  const license = readFileSync(join(dir, ICON_LICENSE), 'utf8').replaceAll('*/', '* /').trimEnd();
  const rules = extraIcons(dir).map((icon) => `.codicon-${icon.name}:before { content: "\\${icon.code.toString(16)}" }`);

  return `\n/*\n${license}\n*/\n\n@font-face {\n\tfont-family: "codicon";\n\tfont-display: block;\n\tsrc: url("${url}") format("truetype");\n\tunicode-range: ${EXTRA_UNICODE_RANGE};\n}\n\n${rules.join('\n')}\n`;
}
