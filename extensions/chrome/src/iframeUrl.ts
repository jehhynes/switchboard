import { BROWSER_PORT } from './hub.js';
/** Only bounded web URLs without embedded credentials may enter a website frame. */
export function frameUrl(value: unknown, origin?: string): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const loopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost';
    if (loopback(url.hostname) && url.port === String(BROWSER_PORT)) return false;
    if (origin !== undefined) {
      const hub = new URL(origin);
      if (url.origin === hub.origin || (loopback(url.hostname) && loopback(hub.hostname) && url.protocol === hub.protocol && url.port === hub.port)) return false;
    }
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}
