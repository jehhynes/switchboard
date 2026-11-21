import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hubBundlePath, switchboardHome } from '@switchboard/core';
import { installBundle } from './bundle.js';
import { installHolder, installPaneHelper, installVoice, MANIFEST_FILE } from './holderInstall.js';

/** What an install did: whether the hub bundle changed, and once the per-build programs are installed, each one's error. */
export interface CarriedInstall {
  hub: boolean;
  programs: Promise<string[]>;
}

/**
 * Installs what the extension carries in its `dist` folder into the home, as activation does and `hub.js install` does without VS Code
 * (architecture.md § Hub lifecycle): the hub bundle, which a running hub then restarts onto, and the web page's Mermaid at once, then the
 * terminal holder's, the voice process's and, on Windows, the Chrome pane helper's builds. A hub bundle that cannot be copied throws; a program
 * that cannot be installed fails only what it runs, so its error is returned.
 */
export function installCarried(dist: string, home: string, platform: NodeJS.Platform = process.platform): CarriedInstall {
  const hub = installBundle(join(dist, 'hub.js'), hubBundlePath(home));

  // The web page draws Mermaid with the build the extension carries, which the hub serves from the home (architecture.md § Web page).
  try {
    installBundle(join(dist, 'mermaid', 'mermaid.min.js'), join(switchboardHome(home), 'web', 'mermaid.min.js'));
  } catch {
    // The page then shows diagrams as their code.
  }

  const target = switchboardHome(home);
  const paneHelper = join(dist, 'pane-helper');
  const installs = [installHolder(join(dist, 'holder'), target), installVoice(join(dist, 'voice'), target)];

  if (platform === 'win32' && existsSync(paneHelper)) {
    installs.push(installPaneHelper(paneHelper, target));
  }

  return { hub, programs: Promise.all(installs).then((results) => results.flatMap((result) => ('error' in result ? [result.error] : []))) };
}

/** Whether a folder is an extension's `dist`, which carries the holder's build beside the hub bundle. */
export function carriesBuilds(dist: string): boolean {
  return existsSync(join(dist, 'hub.js')) && existsSync(join(dist, 'holder', MANIFEST_FILE));
}
