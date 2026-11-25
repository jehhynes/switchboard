import { describe, expect, it } from 'vitest';
import { PAGE_ASSETS } from '../dist/index.js';

/** The theme copy's variables in its default (Dark Modern) block and in its light (Light Modern) block. */
function blocks(): { dark: Map<string, string>; light: Map<string, string> } {
  const css = PAGE_ASSETS['theme.css']!.body;
  const start = css.indexOf('@media (prefers-color-scheme: light)');
  const read = (text: string) => new Map([...text.matchAll(/(--vscode-[\w.-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));

  expect(start).toBeGreaterThan(0);
  return { dark: read(css.slice(0, start)), light: read(css.slice(start)) };
}

/** A #rgb, #rrggbb or #rrggbbaa colour's relative luminance over `under`, by WCAG 2. */
function luminance(colour: string, under = '#ffffff'): number {
  const channels = (hex: string) => {
    const digits = hex.slice(1).length === 3 ? [...hex.slice(1)].map((digit) => digit + digit).join('') : hex.slice(1);

    return [0, 2, 4, 6].map((at) => (digits.length > at ? parseInt(digits.slice(at, at + 2), 16) : 255));
  };
  const [r, g, b, a] = channels(colour);
  const base = channels(under);
  const linear = (value: number, index: number) => {
    const blended = ((value * a!) / 255 + base[index]! * (1 - a! / 255)) / 255;

    return blended <= 0.03928 ? blended / 12.92 : ((blended + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * linear(r!, 0) + 0.7152 * linear(g!, 1) + 0.0722 * linear(b!, 2);
}

/** A #rrggbb colour as Viénot, Brettel and Mollon (1999) simulate it for protanopia or deuteranopia, or as it is, in CIELAB (D65). */
function lab(colour: string, vision: 'normal' | 'protanopia' | 'deuteranopia' = 'normal'): [number, number, number] {
  const simulate = {
    normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    protanopia: [[0.11238, 0.88762, 0], [0.11238, 0.88762, 0], [0.00401, -0.00401, 1]],
    deuteranopia: [[0.29275, 0.70725, 0], [0.29275, 0.70725, 0], [-0.02234, 0.02234, 1]],
  }[vision];
  const linear = [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16) / 255).map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = simulate.map((row) => Math.min(1, Math.max(0, row[0]! * linear[0]! + row[1]! * linear[1]! + row[2]! * linear[2]!)));
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [x, y, z] = [(0.4124 * r! + 0.3576 * g! + 0.1805 * b!) / 0.95047, 0.2126 * r! + 0.7152 * g! + 0.0722 * b!, (0.0193 * r! + 0.1192 * g! + 0.9505 * b!) / 1.08883];

  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** A #rrggbb colour's hue in degrees. */
function hue(colour: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16));
  const high = Math.max(r!, g!, b!);
  const range = high - Math.min(r!, g!, b!);
  const sector = high === r ? ((g! - b!) / range + 6) % 6 : high === g ? (b! - r!) / range + 2 : (r! - g!) / range + 4;

  return sector * 60;
}

function contrast(text: string, background: string): number {
  const [high, low] = [luminance(text), luminance(background)].sort((x, y) => y - x);

  return (high! + 0.05) / (low! + 0.05);
}

describe('the theme copy', () => {
  it('sets every Dark Modern variable again for the light scheme, and only those', () => {
    const { dark, light } = blocks();
    const colours = [...dark.keys()].filter((name) => !/font/.test(name));

    expect(colours.length).toBeGreaterThan(60);
    expect([...light.keys()].sort()).toEqual(colours.sort());
    expect(light.get('--vscode-sideBar-background')).toBe('#F8F8F8');
    expect(light.get('--vscode-foreground')).toBe('#3B3B3B');
  });

  it('switches with the operating system, Dark Modern being the default', () => {
    const css = PAGE_ASSETS['theme.css']!.body;

    expect(css.indexOf(':root {')).toBeLessThan(css.indexOf('@media (prefers-color-scheme: light)'));
    expect(css).toMatch(/^:root \{[^}]*color-scheme: dark;/m);
    expect(css).toMatch(/@media \(prefers-color-scheme: light\) \{\s*:root \{[^}]*color-scheme: light;/);
  });

  it('keeps text and marks readable on the side bar and the editor in both schemes', () => {
    for (const [scheme, colours] of Object.entries(blocks())) {
      for (const surface of ['--vscode-sideBar-background', '--vscode-editor-background']) {
        for (const text of ['--vscode-foreground', '--vscode-descriptionForeground', '--vscode-errorForeground', '--vscode-editorWarning-foreground', '--vscode-textLink-foreground', '--vscode-testing-iconPassed', '--vscode-testing-iconFailed']) {
          expect(contrast(colours.get(text)!, colours.get(surface)!), `${text} on ${surface} in ${scheme}`).toBeGreaterThanOrEqual(4.5);
        }
      }

      expect(contrast(colours.get('--vscode-button-foreground')!, colours.get('--vscode-button-background')!), `button in ${scheme}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colours.get('--vscode-input-placeholderForeground')!, colours.get('--vscode-input-background')!), `placeholder in ${scheme}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colours.get('--vscode-list-activeSelectionForeground')!, colours.get('--vscode-list-activeSelectionBackground')!), `selected row in ${scheme}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colours.get('--vscode-menu-selectionForeground')!, colours.get('--vscode-menu-selectionBackground')!), `menu row in ${scheme}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("draws the console's terminal on the panel's background, with readable text, selection and cursor, in both schemes", () => {
    for (const [scheme, colours] of Object.entries(blocks())) {
      const background = colours.get('--vscode-terminal-background')!;

      expect(background, scheme).toBe(colours.get('--vscode-panel-background'));
      expect(contrast(colours.get('--vscode-terminal-foreground')!, background), `text in ${scheme}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colours.get('--vscode-terminal-foreground')!, colours.get('--vscode-terminal-selectionBackground')!), `selected text in ${scheme}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colours.get('--vscode-terminalCursor-foreground')!, background), `cursor in ${scheme}`).toBeGreaterThanOrEqual(3);
    }

    // VS Code's light terminal palette: its white is a mid grey, so white text stays visible on a light background.
    expect(blocks().light.get('--vscode-terminal-ansiWhite')).toBe('#555555');
  });

  it('gives row stripes status colours that show on every row background and stay apart in hue, lightness and with protanopia or deuteranopia', () => {
    const theme = PAGE_ASSETS['theme.css']!.body;
    const page = PAGE_ASSETS['page.css']!.body;
    const start = theme.indexOf('@media (prefers-color-scheme: light)');
    const status = (text: string) => new Map([...text.matchAll(/--sb-status-(\w+): (#[0-9A-Fa-f]{6});/g)].map((match) => [match[1]!, match[2]!]));
    const pageLight = /@media \(prefers-color-scheme: light\) \{\s*:root \{([^}]*)\}/.exec(page)?.[1] ?? '';
    const { dark, light } = blocks();
    const schemes = {
      dark: { status: status(theme.slice(0, start)), backgrounds: [dark.get('--vscode-sideBar-background')!, dark.get('--vscode-list-hoverBackground')!, dark.get('--vscode-list-activeSelectionBackground')!] },
      light: { status: status(theme.slice(start)), backgrounds: [light.get('--vscode-sideBar-background')!, light.get('--vscode-list-hoverBackground')!, /--sb-row-selected: (#[0-9A-Fa-f]{6});/.exec(pageLight)?.[1] ?? ''] },
    };

    // The dark selected row is the list's selection colour; the light one is the page's own.
    expect(page).toMatch(/^:root \{[^}]*--sb-row-selected: var\(--vscode-list-activeSelectionBackground\);/m);

    for (const [scheme, { status: colours, backgrounds }] of Object.entries(schemes)) {
      expect([...colours.keys()].sort(), scheme).toEqual(['error', 'turn', 'warning']);
      const [warning, error, turn] = [colours.get('warning')!, colours.get('error')!, colours.get('turn')!];

      for (const [name, colour] of colours) {
        for (const background of backgrounds) {
          expect(contrast(colour, background), `${name} on ${background} in ${scheme}`).toBeGreaterThanOrEqual(3);
        }
      }

      // Amber, red and blue.
      expect(hue(warning), `warning in ${scheme}`).toBeGreaterThanOrEqual(40);
      expect(hue(warning), `warning in ${scheme}`).toBeLessThanOrEqual(55);
      expect(Math.min(hue(error), 360 - hue(error)), `error in ${scheme}`).toBeLessThanOrEqual(10);
      expect(hue(turn), `turn in ${scheme}`).toBeGreaterThanOrEqual(200);
      expect(hue(turn), `turn in ${scheme}`).toBeLessThanOrEqual(220);
      // Warning is clearly lighter than error, so the two differ where their hues do not.
      expect(lab(warning)[0] - lab(error)[0], `lightness in ${scheme}`).toBeGreaterThanOrEqual(20);

      for (const vision of ['protanopia', 'deuteranopia'] as const) {
        for (const [a, b] of [[warning, error], [warning, turn], [error, turn]] as const) {
          const [p, q] = [lab(a, vision), lab(b, vision)];

          expect(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), `${a} and ${b} with ${vision} in ${scheme}`).toBeGreaterThanOrEqual(25);
        }
      }
    }

    for (const tone of ['warning', 'error', 'turn']) {
      expect(page).toContain(`.row.stripe-${tone}::before { background: var(--sb-status-${tone}); }`);
      expect(page).toContain(`.sliver > .stripe-${tone} { background: var(--sb-status-${tone}); }`);
    }

    // Returned's outline and fill take the warning status colour; warning text keeps the readable editorWarning colour.
    expect(page).toContain('.row-line .pill.returned { border-color: var(--sb-status-warning); background: color-mix(in srgb, var(--sb-status-warning) 18%, transparent); color: var(--vscode-editorWarning-foreground); }');
    expect(page).toContain('.row-details .row-detail.warning { color: var(--vscode-editorWarning-foreground); }');
  });

  it("draws the page's own colours, its surfaces and the composer's light fill from variables that follow the scheme", () => {
    const css = PAGE_ASSETS['page.css']!.body;
    const light = /@media \(prefers-color-scheme: light\) \{\s*:root \{([^}]*)\}/.exec(css)?.[1] ?? '';

    for (const name of ['--sb-github', '--sb-pull-request', '--sb-source-off', '--sb-composer-background', '--sb-chat-background', '--sb-bar-background', '--sb-row-selected']) {
      expect(light, name).toContain(`${name}:`);
    }

    expect(css).not.toMatch(/#f0f6fc;\s*\}|#a371f7 18%/);
    expect(css).toMatch(/\.main \{[^}]*background: var\(--sb-chat-background\)/);
    expect(css).toMatch(/\.row\.selected \{[^}]*background: var\(--sb-row-selected\)/);
    expect(css).toMatch(/\.header \{[^}]*background: var\(--sb-bar-background\)/);
    // The tab strip is a shade of the surface under it, in both schemes, and the chosen tab is that surface.
    expect(css).toMatch(/\.tabs \{[^}]*background: var\(--sb-tab-strip\)/);
    expect(css).toMatch(/--sb-tab-strip: color-mix\(in srgb, var\(--sb-tab-surface\), #000 var\(--sb-tab-shade\)\)/);
    expect(css).toMatch(/\.tab\.selected \{[^}]*background: var\(--sb-tab-surface\)/);
    expect(light).toContain('--sb-tab-shade:');
    // The column's strip starts at its top with no band above, its tabs at their own height, the chosen tab's top edge one pixel down, in the accent.
    expect(css).toMatch(/\.detail-head \{[^}]*align-items: flex-start;[^}]*padding-top: 1px;/);
    expect(css).not.toMatch(/\.detail-head \{[^}]*min-height/);
    expect(css).not.toMatch(/\.detail-head \.tab \{/);
    expect(css).toMatch(/\.tab \{[^}]*height: 35px;[^}]*border-top: 1px solid transparent;/);
    expect(css).toMatch(/\.tab\.selected \{[^}]*border-top-color: var\(--vscode-panelTitle-activeBorder\);/);
    // The tabs are one group: only Artifacts and the maximize button sit apart, at the strip's end, each with its own left border, since the tab
    // before it is not beside it; no tab is pushed there or borders its left.
    expect(css).toMatch(/\.artifact-more \{[^}]*margin-left: auto;/);
    expect(css).toMatch(/\.tab\.artifact-menu-button \{[^}]*border-left: 1px solid var\(--vscode-panel-border\);/);
    expect(css).toMatch(/\.tab\.panel-max \{[^}]*margin-left: auto;[^}]*border-left: 1px solid var\(--vscode-panel-border\);/);
    expect(css).toContain('.artifact-more + .tab.panel-max { margin-left: 0; }');
    expect(css).not.toMatch(/\.tab\.push|\.tab:is\(\[data-tab="console"\]|\.tab\.(?:changes-tab|diff-tab\.selected) \{[^}]*(?:border-left|margin-left)/);
    // The console's typing border is drawn inside its own box, dimmed, on all four sides, above xterm.js's layers.
    expect(css).toMatch(/\.console \{[^}]*position: relative;[^}]*isolation: isolate;/);
    expect(css).toMatch(/\.console\.typing::after \{[^}]*inset: 0;[^}]*z-index: 50;[^}]*border: 1px solid color-mix\(in srgb, var\(--vscode-focusBorder\) 45%, transparent\);/);
    expect(css).not.toMatch(/\.console\.typing \{[^}]*outline/);
  });

  it('gives light its Light Modern surfaces: the conversation white, its bars and the side bar grey, and a selected row that shows and stays readable', () => {
    const css = PAGE_ASSETS['page.css']!.body;
    const light = /@media \(prefers-color-scheme: light\) \{\s*:root \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const { light: colours } = blocks();
    const selected = /--sb-row-selected: (#[0-9A-Fa-f]{6});/.exec(light)?.[1] ?? '';

    expect(light).toContain('--sb-chat-background: var(--vscode-editor-background);');
    expect(light).toContain('--sb-bar-background: var(--vscode-sideBar-background);');
    expect(colours.get('--vscode-editor-background')).toBe('#FFFFFF');
    expect(contrast(selected, colours.get('--vscode-sideBar-background')!)).toBeGreaterThan(contrast(colours.get('--vscode-list-activeSelectionBackground')!, colours.get('--vscode-sideBar-background')!));

    for (const text of ['--vscode-foreground', '--vscode-descriptionForeground', '--vscode-list-activeSelectionForeground']) {
      expect(contrast(colours.get(text)!, selected), text).toBeGreaterThanOrEqual(4.5);
    }
  });
});
