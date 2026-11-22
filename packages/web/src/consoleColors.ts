/**
 * The console's colours (architecture.md § Web page): xterm.js's theme read from the page's terminal variables (theme.css), which follow the
 * operating system's light or dark setting, and a rewrite of the 24-bit colours Claude Code draws for its dark theme into its light theme's, for a
 * console drawn in light colours (mechanics M106, M126).
 */

/** xterm.js's theme options and the variables VS Code gives a webview for them, which theme.css sets in both schemes. */
export const TERMINAL_VARIABLES: Readonly<Record<string, string>> = {
  background: '--vscode-terminal-background',
  foreground: '--vscode-terminal-foreground',
  cursor: '--vscode-terminalCursor-foreground',
  cursorAccent: '--vscode-terminal-background',
  selectionBackground: '--vscode-terminal-selectionBackground',
  black: '--vscode-terminal-ansiBlack',
  red: '--vscode-terminal-ansiRed',
  green: '--vscode-terminal-ansiGreen',
  yellow: '--vscode-terminal-ansiYellow',
  blue: '--vscode-terminal-ansiBlue',
  magenta: '--vscode-terminal-ansiMagenta',
  cyan: '--vscode-terminal-ansiCyan',
  white: '--vscode-terminal-ansiWhite',
  brightBlack: '--vscode-terminal-ansiBrightBlack',
  brightRed: '--vscode-terminal-ansiBrightRed',
  brightGreen: '--vscode-terminal-ansiBrightGreen',
  brightYellow: '--vscode-terminal-ansiBrightYellow',
  brightBlue: '--vscode-terminal-ansiBrightBlue',
  brightMagenta: '--vscode-terminal-ansiBrightMagenta',
  brightCyan: '--vscode-terminal-ansiBrightCyan',
  brightWhite: '--vscode-terminal-ansiBrightWhite',
  scrollbarSliderBackground: '--vscode-scrollbarSlider-background',
  scrollbarSliderHoverBackground: '--vscode-scrollbarSlider-hoverBackground',
  scrollbarSliderActiveBackground: '--vscode-scrollbarSlider-activeBackground',
};

/**
 * The contrast xterm.js keeps in the light scheme between a cell's text and its background, raising the text's lightness or darkness where it is
 * lower, as VS Code's terminal does by default (`terminal.integrated.minimumContrastRatio`); dim text gets half of it. The dark scheme keeps the
 * program's own colours, which it draws for a dark terminal: there the adjustment turned white text on Claude Code's mid-green word highlight dark.
 */
export const MINIMUM_CONTRAST = 4.5;

/** xterm.js's theme from the page's terminal variables as `style` computes them; a variable the page leaves unset keeps xterm.js's default. */
export function terminalTheme(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): Record<string, string> {
  const theme: Record<string, string> = {};

  for (const [option, variable] of Object.entries(TERMINAL_VARIABLES)) {
    const value = style.getPropertyValue(variable).trim();

    if (value !== '') {
      theme[option] = value;
    }
  }

  return theme;
}

/**
 * Claude Code 2.1.330's colours: each of its `dark` theme's, and of `dark-daltonized`'s, that its `light` (or `light-daltonized`) theme draws in
 * another colour for the same purpose, apart for text and for backgrounds (its message rows, diff lines and selection), since a colour can be
 * both, as white is text in one theme and a background in the other. #b1b9f9 is four purposes' text in the dark theme and two colours in the light
 * one; it takes the permission colour. Black is left out, as it is both the logo's background in both themes and the text on a coloured mark,
 * black in the dark theme and white in the light one: `lightColor` turns black text white and a black background, as any dark one, light.
 */
const CLAUDE_LIGHT_TEXT: ReadonlyMap<string, string> = new Map(
  Object.entries({
    '#af87ff': '#8700ff',
    '#fd5db1': '#ff0087',
    '#eb9f7f': '#f59575',
    '#93a5ff': '#5769f7',
    '#b1c3ff': '#7587ff',
    '#b1b9f9': '#5769f7',
    '#cfd7ff': '#899bff',
    '#48968c': '#006666',
    '#888888': '#8a8a8a',
    '#a6a6a6': '#b7b7b7',
    '#ffffff': '#000000',
    '#999999': '#666666',
    '#c1c1c1': '#8e8e8e',
    '#505050': '#afafaf',
    '#00cccc': '#009999',
    '#4eba65': '#2c7a39',
    '#ff6b80': '#ab2b3f',
    '#ffc107': '#966c1e',
    '#ffdf39': '#c89e50',
    '#505370': '#d5dafd',
    '#ff7814': '#ff6a00',
    '#ffa546': '#ff9632',
    '#7ab4e8': '#2563eb',
    '#3399ff': '#0066cc',
    '#99ccff': '#3366ff',
    '#b7e0ff': '#6598ff',
    '#669999': '#336666',
    '#ff6666': '#cc0000',
    '#ffcc00': '#ff9900',
    '#ffea32': '#ffb732',
    '#66b2ff': '#0066cc',
    '#66ff66': '#00cc00',
    '#ffff66': '#ffcc00',
    '#b266ff': '#800080',
    '#ffb266': '#ff8000',
    '#ff99cc': '#ff66b2',
    '#66cccc': '#00b2b2',
    '#455c73': '#ccd9ff',
  }),
);
const CLAUDE_LIGHT_BACKGROUND: ReadonlyMap<string, string> = new Map(
  Object.entries({
    '#225c2b': '#69db7c',
    '#7a2936': '#ffa8b4',
    '#47584a': '#c7e1cb',
    '#69484d': '#fdd2d8',
    '#38a660': '#2f9d44',
    '#b3596b': '#d1454b',
    '#373737': '#f0f0f0',
    '#464646': '#fcfcfc',
    '#262626': '#f5f5f5',
    '#264f78': '#b4d5ff',
    '#413c41': '#faf5fa',
    '#374146': '#e6f5fa',
    '#004466': '#99ccff',
    '#660000': '#ffcccc',
    '#3e515b': '#d1e7fd',
    '#3e2c2c': '#ffe9e9',
    '#0077b3': '#3366cc',
    '#b30000': '#993333',
  }),
);

/** The SGR colour parameters: text, background and underline. */
const KINDS: Readonly<Record<string, 'text' | 'background'>> = { '38': 'text', '48': 'background', '58': 'text' };

const hex = (rgb: readonly number[]): string => `#${rgb.map((part) => part.toString(16).padStart(2, '0')).join('')}`;

/** The red, green and blue of xterm's 256-colour palette entry `index`, 16 to 255. */
export function paletteRgb(index: number): [number, number, number] {
  if (index >= 232) {
    const grey = 8 + (index - 232) * 10;

    return [grey, grey, grey];
  }

  const cube = index - 16;
  const level = (step: number): number => (step === 0 ? 0 : 55 + step * 40);

  return [level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6)];
}

/**
 * The colour a console drawn in light colours shows for `rgb`, which the program drew for a dark terminal: Claude Code's light theme colour for a
 * dark theme one, else white for black text and a dark background with its lightness inverted. Other text colours stay; the minimum contrast
 * makes them readable.
 */
export function lightColor(rgb: readonly [number, number, number], kind: 'text' | 'background'): [number, number, number] {
  const mapped = (kind === 'text' ? CLAUDE_LIGHT_TEXT : CLAUDE_LIGHT_BACKGROUND).get(hex(rgb));

  if (mapped !== undefined) {
    return [1, 3, 5].map((at) => Number.parseInt(mapped.slice(at, at + 2), 16)) as [number, number, number];
  }

  if (kind === 'text') {
    return rgb.every((part) => part === 0) ? [255, 255, 255] : [...rgb];
  }

  const [r, g, b] = rgb.map((part) => part / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;

  if (lightness >= 0.5) {
    return [...rgb];
  }

  // The same hue and saturation at 1 - lightness: in HSL, every channel c maps to c + 1 - max - min.
  return [r, g, b].map((part) => Math.round((part + 1 - max - min) * 255)) as [number, number, number];
}

/** WCAG 2's contrast between two opaque colours. */
export function contrast(one: readonly number[], other: readonly number[]): number {
  const luminance = (rgb: readonly number[]): number =>
    rgb
      .map((part) => part / 255)
      .map((part) => (part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4))
      .reduce((sum, part, at) => sum + part * [0.2126, 0.7152, 0.0722][at]!, 0);
  const [high, low] = [luminance(one), luminance(other)].sort((a, b) => b - a);

  return (high! + 0.05) / (low! + 0.05);
}

/** The contrast dim text keeps in the light scheme: WCAG's for large text, below the 4.5:1 of other text so it still reads as dim. */
export const DIM_CONTRAST = 3;

const rgbOf = (colour: string): [number, number, number] | null =>
  /^#[0-9a-f]{6}$/i.test(colour) ? ([1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16)) as [number, number, number]) : null;
const mix = (one: readonly number[], other: readonly number[], share: number): number[] => one.map((part, at) => Math.round(part * (1 - share) + other[at]! * share));

/**
 * The colour dim text in `colour` takes on `background`: the colour darkened until it has the minimum contrast, then faded towards the background
 * by up to half, as xterm.js fades it, while it keeps `DIM_CONTRAST`. xterm.js fades a named colour or the default by half after its minimum
 * contrast, which left dim text at 1.65:1 on the light background (mechanics M126).
 */
export function dimColor(colour: readonly number[], background: readonly number[]): string {
  let base = [...colour];

  for (let step = 1; step <= 20 && contrast(base, background) < MINIMUM_CONTRAST; step++) {
    base = mix(colour, [0, 0, 0], step / 20);
  }

  let share = 0;

  for (let next = 0.05; next <= 0.5 + 1e-9 && contrast(mix(base, background, next), background) >= DIM_CONTRAST; next += 0.05) {
    share = next;
  }

  return hex(mix(base, background, share));
}

/**
 * CSS for the light scheme's dim text in the default colour and each of the 256 colours, more specific than xterm.js's own rules; empty for a
 * theme whose colours are not all #rrggbb. 24-bit dim text is drawn undimmed by xterm.js's DOM renderer, and text the minimum contrast changed is
 * drawn in that colour.
 */
export function dimCss(theme: Readonly<Record<string, string>>): string {
  const background = rgbOf(theme['background'] ?? '');
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  const named = [...names, ...names.map((name) => `bright${name[0]!.toUpperCase()}${name.slice(1)}`)].map((name) => rgbOf(theme[name] ?? ''));
  const foreground = rgbOf(theme['foreground'] ?? '');

  if (background === null || foreground === null || named.some((colour) => colour === null)) {
    return '';
  }

  return [
    `.console .xterm .xterm-rows .xterm-dim:not([class*="xterm-fg-"]) { color: ${dimColor(foreground, background)}; }`,
    ...[...named, ...Array.from({ length: 240 }, (_unused, at) => paletteRgb(at + 16))].map(
      (colour, index) => `.console .xterm .xterm-rows .xterm-fg-${index}.xterm-dim { color: ${dimColor(colour!, background)}; }`,
    ),
  ].join('\n');
}

/** One SGR sequence's parameters with each 24-bit or 256-colour colour drawn for a dark terminal given its light colour. */
export function lightParams(params: string): string {
  const parts = params.split(';');
  const out: string[] = [];
  const valid = (values: number[]): boolean => values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);

  for (let at = 0; at < parts.length; at++) {
    const part = parts[at]!;

    if (part.includes(':')) {
      // ITU T.416 form: 38:2:<colour space>:r:g:b, or 38:2:r:g:b, and 38:5:n.
      const sub = part.split(':');
      const kind = KINDS[sub[0]!];
      const first = sub.length >= 6 ? 3 : 2;
      const rgb = sub.slice(first, first + 3).map(Number);

      if (kind !== undefined && sub[1] === '2' && rgb.length === 3 && valid(rgb)) {
        out.push([...sub.slice(0, first), ...lightColor(rgb as [number, number, number], kind)].join(':'));
      } else if (kind === 'background' && sub[1] === '5' && Number(sub[2]) >= 16 && valid([Number(sub[2])])) {
        out.push([sub[0], '2', ...lightColor(paletteRgb(Number(sub[2])), kind)].join(':'));
      } else {
        out.push(part);
      }

      continue;
    }

    const kind = KINDS[part];
    const rgb = parts.slice(at + 2, at + 5).map(Number);

    if (kind !== undefined && parts[at + 1] === '2' && rgb.length === 3 && valid(rgb)) {
      out.push(part, '2', ...lightColor(rgb as [number, number, number], kind).map(String));
      at += 4;
    } else if (kind !== undefined && parts[at + 1] === '5' && at + 2 < parts.length) {
      const index = Number(parts[at + 2]);

      // The 16 named colours come from the theme, which has light ones; the others are fixed, so a dark background among them is turned light.
      if (kind === 'background' && index >= 16 && valid([index])) {
        out.push(part, '2', ...lightColor(paletteRgb(index), kind).map(String));
      } else {
        out.push(part, '5', parts[at + 2]!);
      }

      at += 2;
    } else {
      out.push(part);
    }
  }

  return out.join(';');
}

/** A complete SGR sequence, or the start of a control sequence cut off at the end of a chunk. */
const SGR = /\u001b\[([0-9;:]*)m/g;
const CUT = /\u001b(?:\[[0-9;:]*)?$/;

/**
 * Rewrites the SGR colours of a stream drawn for a dark terminal into light ones, chunk by chunk. A sequence cut at a chunk's end is held until
 * the next chunk completes it.
 */
export class LightColors {
  #held = '';

  /** The chunk's text to write, rewritten, less a sequence cut off at its end. */
  push(data: string): string {
    const text = this.#held + data;
    const cut = CUT.exec(text);

    this.#held = cut === null ? '' : cut[0];

    return (cut === null ? text : text.slice(0, cut.index)).replace(SGR, (_sequence, params: string) => `\u001b[${lightParams(params)}m`);
  }

  /** What is held back, for the end of the stream. */
  flush(): string {
    const held = this.#held;

    this.#held = '';
    return held;
  }
}
