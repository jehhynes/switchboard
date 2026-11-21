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
    // The column's strip fills the header row's height from the top: its tabs stretch, nothing pushes them to the bottom.
    expect(css).toMatch(/\.detail-head \{[^}]*min-height: 45px;[^}]*align-items: stretch;/);
    expect(css).not.toMatch(/\.detail-head \{[^}]*align-items: flex-end/);
    expect(css).toMatch(/\.detail-head \.tab \{[^}]*height: auto;/);
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
