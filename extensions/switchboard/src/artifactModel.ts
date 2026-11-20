import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ArtifactView } from '@switchboard/hub';

/** An artifact's name, `<owner>/<file>`, with no segment that starts with a dot; as the hub's watch reads it. */
const NAME = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;

/** The real path of `rel` under `dir`, or null when there is none or a link on the way takes it out of `dir`. */
export function realInside(dir: string, rel: string): string | null {
  try {
    const real = realpathSync.native(isAbsolute(rel) ? rel : join(dir, ...rel.split('/')));
    const inside = relative(realpathSync.native(dir), real);

    return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? real : null;
  } catch {
    return null;
  }
}

/**
 * The file of an artifact the window was sent (architecture.md § Artifacts): an artifact of its state's list, resolved by real path inside its
 * artifact folder, so a link or junction cannot reach outside it; null otherwise.
 */
export function artifactFile(dir: string | null, artifacts: readonly ArtifactView[], path: string): { artifact: ArtifactView; file: string } | null {
  const artifact = artifacts.find((one) => one.path === path);

  if (dir === null || artifact === undefined || !NAME.test(path)) {
    return null;
  }

  const file = realInside(dir, path);

  return file === null ? null : { artifact, file };
}

/** When each artifact was last opened, by its path, for one work item. */
export type Opened = Record<string, number>;

/** The artifacts written or rewritten since they were last opened in this window's workspace, which the Artifacts view's badge counts. */
export function unopened(artifacts: readonly ArtifactView[], opened: Opened): ArtifactView[] {
  return artifacts.filter((artifact) => artifact.updatedAt > (opened[artifact.path] ?? -1));
}

/** The folder of the files an HTML artifact uses, `<owner>/<stem>/`, beside it. */
export function assetsFolder(dir: string, path: string): string {
  const [owner = '', file = ''] = path.split('/');

  return join(dir, owner, file.replace(/\.[^.]+$/, ''));
}

/** The real path of the folder beside an artifact, or null when it is missing or a link takes it out of the artifact folder. */
export function assetsRoot(dir: string, path: string): string | null {
  return realInside(dir, relative(dir, assetsFolder(dir, path)).split(sep).join('/'));
}

/**
 * Resolves a relative `src` or `href` of an HTML artifact to a file in the folder of files it uses, by real path (architecture.md § Artifacts);
 * null for anything outside that folder or missing.
 */
export function assetResolver(dir: string, path: string): (url: string) => string | null {
  const assets = assetsFolder(dir, path);
  const owner = join(dir, path.split('/')[0] ?? '');

  return (url) => {
    let rel = url.replace(/&amp;/g, '&').replace(/[?#].*$/, '');

    try {
      rel = decodeURIComponent(rel);
    } catch {
      return null;
    }

    if (rel === '' || isAbsolute(rel) || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('//')) {
      return null;
    }

    const assetsReal = assetsRoot(dir, path);

    if (assetsReal === null) {
      return null;
    }

    const real = realInside(dir, join(owner, rel));

    if (real === null) {
      return null;
    }

    const inside = relative(assetsReal, real);

    return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside) ? real : null;
  };
}

/** A URL an HTML artifact may keep as written: a fragment, `data:` and `blob:`; everything else is resolved or removed. */
function kept(url: string): boolean {
  return url.startsWith('#') || /^(data|blob):/i.test(url);
}

/**
 * An HTML artifact's `src`, `href` and `poster` attributes: a relative one to a file it uses as `toUri` gives it, a fragment, `data:` or
 * `blob:` as written, and any other emptied, since the panel has no network and navigates nowhere (architecture.md § Artifacts).
 */
export function rewriteResources(html: string, resolve: (url: string) => string | null, toUri: (file: string) => string): string {
  const attributes = (tag: string): string =>
    tag.replace(/(\s)(src|href|poster)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi, (whole, space: string, name: string, equals: string, _quoted, double?: string, single?: string, bare?: string) => {
      const url = (double ?? single ?? bare ?? '').trim();

      if (kept(url)) {
        return whole;
      }

      const file = resolve(url);

      return `${space}${name}${equals}"${file === null ? '' : toUri(file).replace(/"/g, '%22')}"`;
    });

  // A tag, its quoted values allowed to hold `>`; the text of a script or style, and comments, are left as written, so HTML quoted in a script
  // stays valid script.
  return html.replace(/<!--[\s\S]*?-->|<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(<\/\1\s*>)|<[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi, (whole, raw?: string, rawAttributes?: string, text?: string, end?: string) => {
    if (whole.startsWith('<!--')) {
      return whole;
    }

    return raw === undefined ? attributes(whole) : `<${raw}${attributes(rawAttributes ?? '')}>${text ?? ''}${end ?? ''}`;
  });
}

/**
 * The panel's Content Security Policy for an HTML artifact (voice-design § 4.4): its own scripts and styles, and files it uses from the webview,
 * with no `connect-src`, so no network; no form posts or `<base>`.
 */
export function artifactCsp(cspSource: string): string {
  return `default-src 'none'; script-src 'unsafe-inline' ${cspSource}; style-src 'unsafe-inline' ${cspSource}; img-src ${cspSource} data:; media-src ${cspSource}; font-src ${cspSource}; form-action 'none'; base-uri 'none'`;
}

/**
 * Keeps a link click, a middle click and `window.open` from leaving the page; an in-page `#` link still scrolls. It runs first, in the capture phase
 * of the document, and stops the event there, because VS Code's own webview script opens a clicked link whether or not it was prevented.
 */
const STAY = `<script>(() => { const stay = (event) => { const link = event.target instanceof Element ? event.target.closest('a[href], area[href]') : null; if (link !== null && !(link.getAttribute('href') || '').startsWith('#')) { event.preventDefault(); event.stopImmediatePropagation(); } }; document.addEventListener('click', stay, true); document.addEventListener('auxclick', stay, true); window.open = () => null; })();</script>`;

/**
 * An HTML artifact as the panel shows it: its policy and the navigation guard before anything of the page but its doctype, so they apply to all
 * of it (the parser puts them in the page's head), then the page with its resources resolved.
 */
export function artifactPage(html: string, cspSource: string, resolve: (url: string) => string | null, toUri: (file: string) => string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${artifactCsp(cspSource)}">${STAY}`;
  const page = rewriteResources(html.replace(/^\uFEFF/, ''), resolve, toUri);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(page)?.[0] ?? '<!doctype html>';

  return `${doctype}${head}${page.slice(page.startsWith(doctype) ? doctype.length : 0)}`;
}
