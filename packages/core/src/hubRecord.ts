export const HUB_NAME = 'switchboard';
export const PROTOCOL = 1;
/** The fixed loopback port of the hub's browser endpoint, which the Chrome extension reads (PRD R56). */
export const BROWSER_PORT = 47615;
/**
 * The Chrome extension's fixed ID, from the public key in its manifest; the browser endpoint's pane socket accepts only this extension's Origin
 * (architecture.md § Pane socket). `extensions/chrome/test/manifest.test.ts` checks it against the key.
 */
export const PANE_EXTENSION_ID = 'hlbibnhgkgnjkbfledhgjblacloneije';

/** Contents of `hub.json`: how a client reaches the running hub. */
export interface HubRecord {
  protocol: number;
  version: string;
  /** Hash of the hub bundle; differs between builds of one version. */
  build: string;
  /** The folder holding settings.json. */
  configDir: string;
  /** The hub's runtime, `process.execPath`: VS Code's Electron when a window started it, Node.js from `hub.js start`; the dock starts a hub with it (PRD R71). */
  execPath: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  /** The hub restarts by itself onto the installed bundle when that is another build (architecture.md § Hub lifecycle); absent from an older hub. */
  restarts?: boolean;
}

/** What the hub reports about itself. */
export interface HubIdentity {
  hub: string;
  protocol: number;
  version: string;
  pid: number;
}

function objectOf(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isInteger(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Null for anything that is not a complete record, such as a file caught mid-write. */
export function parseHubRecord(text: string): HubRecord | null {
  const raw = objectOf(text);

  if (
    raw === null ||
    !isInteger(raw.protocol, 1) ||
    !isInteger(raw.port, 1, 65535) ||
    !isInteger(raw.pid, 1) ||
    typeof raw.version !== 'string' ||
    typeof raw.build !== 'string' ||
    typeof raw.token !== 'string' ||
    raw.token === '' ||
    typeof raw.startedAt !== 'string' ||
    typeof raw.configDir !== 'string' ||
    typeof raw.execPath !== 'string'
  ) {
    return null;
  }

  return { protocol: raw.protocol, version: raw.version, build: raw.build, configDir: raw.configDir, execPath: raw.execPath, port: raw.port, token: raw.token, pid: raw.pid, startedAt: raw.startedAt, ...(raw.restarts === true ? { restarts: true } : {}) };
}

export function parseHubIdentity(text: string): HubIdentity | null {
  const raw = objectOf(text);

  if (raw === null || typeof raw.hub !== 'string' || !isInteger(raw.protocol, 1) || typeof raw.version !== 'string' || !isInteger(raw.pid, 1)) {
    return null;
  }

  return { hub: raw.hub, protocol: raw.protocol, version: raw.version, pid: raw.pid };
}
