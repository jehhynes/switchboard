import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hubBundlePath, switchboardHome } from '@switchboard/core';
import { installBundle } from './bundle.js';
import { installHolder, installVoice, MANIFEST_FILE } from './holderInstall.js';
import { installBrowserExtension } from './browserExtension.js';
import { installDiffViewer } from './pageAssets.js';

/** What an install did: whether the hub bundle changed, and once the per-build programs are installed, each one's error. */
export interface CarriedInstall {
  hub: boolean;
  programs: Promise<string[]>;
}

/**
 * Installs what a build folder carries into the home: apps/hub's standalone build (`npm run install-local`) or the extension's `dist`, which
 * activation installs (architecture.md § Hub lifecycle): the hub bundle, which a running hub then restarts onto, and the web page's Mermaid, diff viewer and browser extension at once, then the
 * terminal holder's and the voice process's builds. A hub bundle that cannot be copied throws; a program
 * that cannot be installed fails only what it runs, so its error is returned.
 */
export function installCarried(dist: string, home: string, platform: NodeJS.Platform = process.platform): CarriedInstall {
  const hub = installBundle(join(dist, 'hub.js'), hubBundlePath(home));

  // The web page draws Mermaid with the build the folder carries, which the hub serves from the home (architecture.md § Web page).
  try {
    installBundle(join(dist, 'mermaid', 'mermaid.min.js'), join(switchboardHome(home), 'web', 'mermaid.min.js'));
  } catch {
    // The page then shows diagrams as their code.
  }

  // The web page's diff viewer, in a folder named by its build, so a page loads the build it was built with (architecture.md § Web page).
  try {
    installDiffViewer(join(dist, 'diff'), join(switchboardHome(home), 'web'));
  } catch {
    // The page then says the diff viewer could not be loaded.
  }

  // The browser extension, which the web page offers for download to another device (architecture.md § Browser extension).
  try {
    installBrowserExtension(join(dist, 'chrome'), join(switchboardHome(home), 'web'));
  } catch {
    // The page's download then answers that there is none.
  }

  const target = switchboardHome(home);
  const installs = [installHolder(join(dist, 'holder'), target), installVoice(join(dist, 'voice'), target)];

  return { hub, programs: Promise.all(installs).then((results) => results.flatMap((result) => ('error' in result ? [result.error] : []))) };
}

/** Whether a folder is a build folder, which carries the holder's build beside the hub bundle. */
export function carriesBuilds(dist: string): boolean {
  return existsSync(join(dist, 'hub.js')) && existsSync(join(dist, 'holder', MANIFEST_FILE));
}
