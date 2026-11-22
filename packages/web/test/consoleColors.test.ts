import { describe, expect, it } from 'vitest';
import { contrast, DIM_CONTRAST, dimColor, dimCss, LightColors, lightColor, lightParams, MINIMUM_CONTRAST, paletteRgb, terminalTheme, TERMINAL_VARIABLES } from '../src/consoleColors.js';
import { PAGE_ASSETS } from '../dist/index.js';

describe("the console's light colours", () => {
  it("gives each of Claude Code's dark theme colours its light theme colour, in either SGR form", () => {
    // A sent message's row and its text, secondary text, the mode line, a diff's added line and the permission colour two purposes share.
    expect(lightParams('48;2;55;55;55')).toBe('48;2;240;240;240');
    expect(lightParams('38;2;255;255;255')).toBe('38;2;0;0;0');
    expect(lightParams('38;2;153;153;153')).toBe('38;2;102;102;102');
    expect(lightParams('1;38;2;255;193;7;4')).toBe('1;38;2;150;108;30;4');
    expect(lightParams('48;2;34;92;43')).toBe('48;2;105;219;124');
    expect(lightParams('38;2;177;185;249')).toBe('38;2;87;105;247');
    expect(lightParams('38:2::255:193:7')).toBe('38:2::150:108:30');
    expect(lightParams('48:2:55:55:55')).toBe('48:2:240:240:240');
    // A colour that is text in one theme and a background in the other maps only as what it is: white text turns black, a white background stays.
    expect(lightParams('48;2;255;255;255')).toBe('48;2;255;255;255');
    expect(lightParams('38;2;55;55;55')).toBe('38;2;55;55;55');
    // An underline colour is text.
    expect(lightParams('58;2;255;255;255')).toBe('58;2;0;0;0');
  });

  it('turns black text white and any other dark background light with its hue, and leaves other text colours for the minimum contrast', () => {
    expect(lightColor([0, 0, 0], 'text')).toEqual([255, 255, 255]);
    expect(lightColor([0, 0, 0], 'background')).toEqual([255, 255, 255]);
    expect(lightColor([20, 40, 80], 'background')).toEqual([175, 195, 235]);
    expect(lightColor([200, 210, 220], 'background')).toEqual([200, 210, 220]);
    expect(lightColor([12, 34, 56], 'text')).toEqual([12, 34, 56]);
  });

  it('turns a dark background from the fixed 256 colours light, and leaves the 16 named ones and every 256-colour text to the theme', () => {
    expect(paletteRgb(16)).toEqual([0, 0, 0]);
    expect(paletteRgb(231)).toEqual([255, 255, 255]);
    expect(paletteRgb(236)).toEqual([48, 48, 48]);
    expect(paletteRgb(67)).toEqual([95, 135, 175]);
    expect(lightParams('48;5;236')).toBe('48;2;207;207;207');
    expect(lightParams('48:5:236')).toBe('48:2:207:207:207');
    expect(lightParams('48;5;4')).toBe('48;5;4');
    expect(lightParams('38;5;245')).toBe('38;5;245');
    expect(lightParams('0;31;42;97;100')).toBe('0;31;42;97;100');
    expect(lightParams('')).toBe('');
  });

  it('leaves a colour it cannot read as it is', () => {
    expect(lightParams('48;2;55;55')).toBe('48;2;55;55');
    expect(lightParams('48;2;300;0;0')).toBe('48;2;300;0;0');
    expect(lightParams('48;5')).toBe('48;5');
  });

  it("rewrites only SGR sequences, holding one cut at a chunk's end until the next completes it", () => {
    const colours = new LightColors();

    expect(colours.push('\u001b[2J\u001b[?1049h\u001b[>4;2m\u001b]0;t\u0007x\u001b[48;2;55;55;55my')).toBe('\u001b[2J\u001b[?1049h\u001b[>4;2m\u001b]0;t\u0007x\u001b[48;2;240;240;240my');
    expect(colours.push('a\u001b[38;2;25')).toBe('a');
    expect(colours.push('5;255;255mb\u001b')).toBe('\u001b[38;2;0;0;0mb');
    expect(colours.push('[Hc')).toBe('\u001b[Hc');
    expect(colours.push('d\u001b[')).toBe('d');
    expect(colours.flush()).toBe('\u001b[');
    expect(colours.flush()).toBe('');
  });

  it("reads xterm.js's theme from the page's terminal variables, leaving out those the page does not set", () => {
    const values: Record<string, string> = { '--vscode-terminal-background': ' #F8F8F8 ', '--vscode-terminal-ansiRed': '#CD3131' };
    const theme = terminalTheme({ getPropertyValue: (name: string) => values[name] ?? '' });

    expect(theme).toEqual({ background: '#F8F8F8', cursorAccent: '#F8F8F8', red: '#CD3131' });
    expect(Object.keys(TERMINAL_VARIABLES)).toHaveLength(24);
  });

  it("keeps dim text in the light palette at 3:1 or more, below the other text's 4.5:1 so it still reads as dim", () => {
    const css = PAGE_ASSETS['theme.css']!.body;
    const light = css.slice(css.indexOf('@media (prefers-color-scheme: light)'));
    const variable = (name: string): string => new RegExp(`${name}: (#[0-9A-F]{6});`, 'i').exec(light)?.[1] ?? '';
    const theme = terminalTheme({ getPropertyValue: (name: string) => variable(name) });
    const rgb = (colour: string): number[] => [1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16));
    const background = rgb(theme['background']!);
    const rules = dimCss(theme).split('\n');

    expect(rules).toHaveLength(257);
    // The default colour's rule leaves out every numbered colour, which has its own.
    expect(rules[0]).toMatch(/^\.console \.xterm \.xterm-rows \.xterm-dim:not\(\[class\*="xterm-fg-"\]\) \{ color: #[0-9a-f]{6}; \}$/);
    expect(rules[256]).toMatch(/^\.console \.xterm \.xterm-rows \.xterm-fg-255\.xterm-dim \{ color: #[0-9a-f]{6}; \}$/);

    const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
    const sources = ['foreground', ...names, ...names.map((name) => `bright${name[0]!.toUpperCase()}${name.slice(1)}`)];

    for (const [at, rule] of rules.slice(0, 17).entries()) {
      const dim = contrast(rgb(/#[0-9a-f]{6}/.exec(rule)![0]), background);
      const full = Math.max(MINIMUM_CONTRAST, contrast(rgb(theme[sources[at]!]!), background));

      expect(dim, rule).toBeGreaterThanOrEqual(DIM_CONTRAST);
      expect(dim, rule).toBeLessThan(full);
    }

    for (const [at, rule] of rules.slice(17).entries()) {
      expect(contrast(rgb(/#[0-9a-f]{6}/.exec(rule)![0]), background), rule).toBeGreaterThanOrEqual(DIM_CONTRAST);
      expect(rule).toContain(`.xterm-fg-${at + 16}.xterm-dim`);
    }

    // Black and the default text stay well above it; yellow, raised to 4.5:1 first, fades to about 3:1.
    expect(dimColor([0x94, 0x98, 0x00], background)).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(rgb(dimColor([0x94, 0x98, 0x00], background)), background)).toBeLessThan(3.5);
    expect(dimCss({ ...theme, red: 'rgb(1, 2, 3)' })).toBe('');
  });
});
