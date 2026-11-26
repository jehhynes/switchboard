// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const host = readFileSync(join(__dirname, '../src/iframeHost.html'), 'utf8');
const theme = readFileSync(join(__dirname, '../../../packages/web/src/theme.css'), 'utf8');
/** The web page's editor background in its dark (default) and light themes, which follow prefers-color-scheme as the host page does. */
const [dark, light] = [...theme.matchAll(/--vscode-editor-background: (#[0-9A-Fa-f]{6});/g)].map((match) => match[1]!.toLowerCase());
const short = (colour: string): string => colour.replace(/^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/, '#$1$2$3');

describe('the embedded browser host page', () => {
  it('fills a website frame with the web page theme\'s editor background and colour scheme while it loads, not white', () => {
    // 2026 Dark's editor colour.
    expect(dark).toBe('#121314');
    expect(host).toContain(`.browser{position:absolute;border:0;background:${dark};color-scheme:dark}`);
    expect(host).toMatch(new RegExp(`@media \\(prefers-color-scheme:light\\)\\{[^@]*\\.browser\\{background:${short(light!)};color-scheme:light\\}\\}`));
    expect(host).not.toMatch(/\.browser\{[^}]*background:white/);
  });
});
