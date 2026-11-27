import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARK_GLYPHS } from '@switchboard/core/group';
import { EXTRA_RANGE, EXTRA_UNICODE_RANGE, ICON_FONT } from '@switchboard/core/icons';

const css = readFileSync(join(import.meta.dirname, '../src/content.css'), 'utf8');
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../src/manifest.json'), 'utf8')) as { web_accessible_resources: { resources: string[] }[] };

describe("the extension's icon fonts", () => {
  it("load the extra icons as a second face of the pills' family, for the extra range only, after the codicon face", () => {
    const faces = [...css.matchAll(/@font-face \{([^}]*)\}/g)].map((face) => face[1]!.replace(/\s+/g, ' ').trim());

    expect(faces).toEqual([
      "font-family: switchboard-codicon; src: url('chrome-extension://__MSG_@@extension_id__/codicon.ttf') format('truetype');",
      `font-family: switchboard-codicon; src: url('chrome-extension://__MSG_@@extension_id__/${ICON_FONT}') format('truetype'); unicode-range: ${EXTRA_UNICODE_RANGE};`,
    ]);
  });

  it('let GitHub pages load both fonts', () => {
    expect(manifest.web_accessible_resources.flatMap((entry) => entry.resources)).toEqual(['codicon.ttf', ICON_FONT]);
  });

  it("draw the usage limit pill's character from the extra range", () => {
    const code = MARK_GLYPHS.limited.codePointAt(0)!;

    expect(code).toBeGreaterThanOrEqual(EXTRA_RANGE.first);
    expect(code).toBeLessThanOrEqual(EXTRA_RANGE.last);
  });
});
