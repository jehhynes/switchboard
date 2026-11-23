import { frameUrl } from './iframeUrl.js';
export interface HostSelection { workItemId: number; url: string | null }
/** Consumes a launch fragment once, so an app reload cannot replay an old selection. */
export function consumeSelection(href: string, send: (selection: HostSelection) => void, replace: (url: string) => void): boolean {
  const target = new URL(href);
  const params = new URLSearchParams(target.hash.slice(1));
  const workItemId = Number(params.get('workItemId'));
  const url = params.get('url');
  if (!Number.isSafeInteger(workItemId) || workItemId <= 0) return false;
  if (url !== null && !frameUrl(url, target.searchParams.get('origin') ?? undefined)) return false;
  send({ workItemId, url });
  target.hash = '';
  replace(target.href);
  return true;
}
