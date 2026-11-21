// Writes the diff viewer's Shiki (TextMate) themes, src/diff/themes/sb-*.json, from VS Code's own Dark Modern and Light Modern theme files,
// following their "include" chain, so its syntax colours are VS Code's (architecture.md § Web page). Run it again after a VS Code upgrade:
// node gen-diff-themes.mjs "<VS Code>/resources/app/extensions/theme-defaults/themes"
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
// JSONC: drop comments outside strings and trailing commas.
const jsonc = (text) => {
  let out = '', i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = text.indexOf('*/', i + 2) + 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
};
const load = (file) => {
  const t = jsonc(readFileSync(join(dir, file), 'utf8'));
  const base = t.include ? load(t.include.replace(/^\.\//, '')) : { colors: {}, tokenColors: [] };
  return { colors: { ...base.colors, ...(t.colors ?? {}) }, tokenColors: [...base.tokenColors, ...(t.tokenColors ?? [])] };
};
// Colours VS Code leaves to its built-in defaults that Pierre reads for its added, deleted and modified marks.
const git = {
  dark: { 'gitDecoration.addedResourceForeground': '#81b88b', 'gitDecoration.deletedResourceForeground': '#c74e39', 'gitDecoration.modifiedResourceForeground': '#e2c08d' },
  light: { 'gitDecoration.addedResourceForeground': '#587c0c', 'gitDecoration.deletedResourceForeground': '#ad0707', 'gitDecoration.modifiedResourceForeground': '#895503' },
};
mkdirSync('src/diff/themes', { recursive: true });
for (const [name, file, type] of [['sb-dark-modern', 'dark_modern.json', 'dark'], ['sb-light-modern', 'light_modern.json', 'light']]) {
  const t = load(file);
  const theme = { name, type, colors: { ...git[type], ...t.colors }, tokenColors: t.tokenColors };
  theme.fg = theme.colors['editor.foreground'];
  theme.bg = theme.colors['editor.background'];
  writeFileSync(join('src/diff/themes', name + '.json'), JSON.stringify(theme));
  console.log(name, 'bg', theme.bg, 'fg', theme.fg, 'rules', theme.tokenColors.length);
}
