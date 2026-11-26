import { iframePage } from './iframe.js';
import type { IframeSender } from './iframe.js';

/** Only a configured, signed-in page with embedding enabled may ask for a local icon download. */
export async function shortcutRequest(sender: IframeSender, remote: string | null, enabled: (origin: string) => Promise<boolean>, save: () => Promise<string>): Promise<{ icon: string } | { error: string }> {
  const origin = iframePage(sender.url, remote);
  if (origin === null || sender.origin !== origin || !await enabled(origin)) return { error: 'Open the signed-in Switchboard page with Embedded browser tabs enabled.' };
  return { icon: await save() };
}

/** The packaged icon a shortcut request asks for: the PNG a Linux launcher takes, else the multi-size ICO a Windows shortcut takes. */
export function shortcutIconFile(message: unknown): { asset: string; type: string; filename: string } {
  return (message as { format?: unknown } | null)?.format === 'png'
    ? { asset: 'icon-256.png', type: 'image/png', filename: 'switchboard.png' }
    : { asset: 'switchboard.ico', type: 'image/x-icon', filename: 'switchboard.ico' };
}

/** Wait for the browser to finish writing an icon, then use its actual path, including redirected Downloads folders. */
export async function downloadedIcon(downloads: Pick<typeof chrome.downloads, 'download' | 'search' | 'onChanged'>, url: string, filename = 'switchboard.ico'): Promise<string> {
  const id = await downloads.download({ url, filename: `Switchboard/${filename}`, conflictAction: 'overwrite', saveAs: false });
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error: string | null, path?: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      downloads.onChanged.removeListener(changed);
      if (error !== null) reject(new Error(error)); else resolve(path!);
    };
    const check = (): void => {
      void downloads.search({ id }).then(([item]) => {
        if (item?.state === 'complete') finish(null, item.filename);
        else if (item === undefined || item.state === 'interrupted') finish('The icon download did not finish.');
      }, () => finish('Could not find the downloaded icon.'));
    };
    const changed = (change: chrome.downloads.DownloadDelta): void => { if (change.id === id) check(); };
    const timeout = setTimeout(() => finish('The icon download timed out. Try again.'), 30_000);
    downloads.onChanged.addListener(changed);
    check();
  });
}
