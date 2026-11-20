import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAGE_ASSETS } from '@switchboard/web';

/** Mermaid's self-contained build, which the extension installs in `<home>/web/` beside the hub bundle, since it is too large to carry in it. */
export const PAGE_MERMAID = 'mermaid.min.js';

/**
 * A file of the web page (architecture.md § Web page): the page's own files, carried in the hub bundle so they always match the hub, and Mermaid
 * from the Switchboard home; null for any other name.
 */
export function pageAsset(name: string, home: string): { mime: string; body: Buffer | string } | null {
  if (name === PAGE_MERMAID) {
    try {
      return { mime: 'text/javascript; charset=utf-8', body: readFileSync(join(home, 'web', PAGE_MERMAID)) };
    } catch {
      return null;
    }
  }

  const asset = Object.hasOwn(PAGE_ASSETS, name) ? PAGE_ASSETS[name] : undefined;

  return asset === undefined ? null : { mime: asset.mime, body: asset.base64 ? Buffer.from(asset.body, 'base64') : asset.body };
}
