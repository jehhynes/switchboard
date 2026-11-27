// Writes icons/switchboard-icons.ttf, Switchboard's extra icon font (architecture.md § Web page, Extra icons), from the SVGs in icons/.
// Run it after adding or changing an SVG there, once core is built:
//   npm run build --workspace @switchboard/core && node packages/core/gen-icons.mjs
// test/icons.test.ts fails while the committed font differs from what this writes.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extraIconFont, extraIcons, ICON_FONT, ICONS_DIR } from './dist/icons.js';

writeFileSync(join(ICONS_DIR, ICON_FONT), extraIconFont());
console.log(`Wrote ${ICON_FONT}: ${extraIcons().map((icon) => `${icon.name} U+${icon.code.toString(16).toUpperCase()}`).join(', ')}`);
