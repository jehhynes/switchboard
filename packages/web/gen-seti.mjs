// Writes src/seti/ from an installed VS Code (architecture.md § Web page): its Seti file icon theme's font, and file-icons.json, a compact copy of
// the theme's mapping and of the languages VS Code's built-in extensions register, so the page picks a file's icon as VS Code does. Run it after a
// VS Code upgrade with the install's resources/app folder:
//   node gen-seti.mjs "%LOCALAPPDATA%/Programs/Microsoft VS Code/<build>/resources/app"
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const app = process.argv[2];

if (app === undefined) {
  console.error('Usage: node gen-seti.mjs <VS Code resources/app folder>');
  process.exit(1);
}

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const themeDir = join(app, 'extensions', 'theme-seti', 'icons');
const theme = read(join(themeDir, 'vs-seti-icon-theme.json'));
const product = read(join(app, 'package.json'));
const commit = read(join(app, 'product.json')).commit ?? '';

// Each icon is a pair of the dark and the light definition, as [character, dark colour, light colour]; a key the light section lacks keeps its dark
// definition, as VS Code's light rules only add to the base ones.
const icons = [];
const index = new Map();
const icon = (dark, light = dark) => {
  const id = `${dark}|${light}`;

  if (!index.has(id)) {
    const [one, two] = [theme.iconDefinitions[dark], theme.iconDefinitions[light]];

    index.set(id, icons.length);
    icons.push([String.fromCodePoint(parseInt(one.fontCharacter.slice(1), 16)), one.fontColor, two.fontColor]);
  }

  return index.get(id);
};
const section = (name) => {
  const base = { ...theme[name] };

  // VS Code gives jsonc the json icon when the theme names only json.
  if (name === 'languageIds' && base.jsonc === undefined && base.json !== undefined) {
    base.jsonc = base.json;
  }

  return Object.fromEntries(Object.entries(base).map(([key, dark]) => [key.toLowerCase(), icon(dark, theme.light?.[name]?.[key] ?? dark)]));
};

// The languages of the built-in extensions, in folder order, a later one taking a name or extension an earlier one registered, as VS Code's
// association lookup prefers the last registered of equal length.
const names = {};
const extensions = {};
const patterns = [];

for (const folder of readdirSync(join(app, 'extensions')).sort()) {
  let manifest;

  try {
    manifest = read(join(app, 'extensions', folder, 'package.json'));
  } catch {
    continue;
  }

  for (const language of manifest.contributes?.languages ?? []) {
    for (const name of language.filenames ?? []) names[name.toLowerCase()] = language.id;
    for (const extension of language.extensions ?? []) extensions[extension.toLowerCase()] = language.id;
    for (const pattern of language.filenamePatterns ?? []) {
      // src/fileIcons.tsx reads only `**`, `*` and `?`.
      if (/[{}[\]]/.test(pattern)) {
        throw new Error(`${folder} registers the glob ${pattern}, which src/fileIcons.tsx cannot read.`);
      }

      patterns.push([pattern.toLowerCase(), language.id]);
    }
  }
}

const out = 'src/seti';

mkdirSync(out, { recursive: true });
copyFileSync(join(themeDir, 'seti.woff'), join(out, 'seti.woff'));
writeFileSync(
  join(out, 'file-icons.json'),
  JSON.stringify({
    source: `VS Code ${product.version} ${commit}`.trim(),
    file: icon(theme.file, theme.light?.file ?? theme.file),
    fileNames: section('fileNames'),
    fileExtensions: section('fileExtensions'),
    languageIds: section('languageIds'),
    languages: { names, extensions, patterns },
    icons,
  }) + '\n',
);
