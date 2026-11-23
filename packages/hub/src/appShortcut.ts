import { BROWSER_EXTENSION_ID } from '@switchboard/core';

/** A portable MS-SHLLINK file. It names a browser on the receiving computer, never a path on the hub. */
export function appShortcut(origin: string, query: URLSearchParams): Buffer {
  const page = new URL(origin);
  if (page.origin !== origin || page.username !== '' || page.password !== '' ||
      !(page.protocol === 'https:' || (page.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(page.hostname)))) throw new Error('Invalid hub origin.');
  for (const key of query.keys()) {
    if (!['browser', 'profile', 'installation', 'icon'].includes(key) || query.getAll(key).length !== 1) throw new Error('Invalid shortcut option.');
  }
  const browser = query.get('browser') ?? 'chrome';
  const profile = query.get('profile') || 'Default';
  const icon = query.get('icon') ?? '';
  if (icon !== '' && (!/^[A-Za-z]:\\[^<>:"|?*%\x00-\x1f]+\.ico$/i.test(icon) || icon.length > 240)) throw new Error('Invalid shortcut option.');
  const installation = query.get('installation') ?? 'standard';
  if (!['chrome', 'edge'].includes(browser) || !['standard', 'user', 'program-files', 'program-files-x86'].includes(installation) ||
      (profile !== '' && !/^[A-Za-z0-9_ -]{1,80}$/.test(profile))) throw new Error('Invalid shortcut option.');
  const root = installation === 'user' ? '%LOCALAPPDATA%' : installation === 'program-files' ? '%ProgramFiles%' :
    installation === 'program-files-x86' ? '%ProgramFiles(x86)%' : browser === 'chrome' ? '%ProgramFiles%' : '%ProgramFiles(x86)%';
  const target = `${root}\\${browser === 'chrome' ? 'Google\\Chrome\\Application\\chrome.exe' : 'Microsoft\\Edge\\Application\\msedge.exe'}`;
  const url = `chrome-extension://${BROWSER_EXTENSION_ID}/iframeHost.html?origin=${encodeURIComponent(origin)}`;
  const args = [`--profile-directory=${profile}`, `--app=${url}`].map((value) => `"${value}"`).join(' ');

  // ShellLinkHeader: Unicode name/arguments, an environment target, and no machine-specific ID list or LinkInfo.
  const header = Buffer.alloc(76);
  header.writeUInt32LE(76, 0);
  Buffer.from('0114020000000000c000000000000046', 'hex').copy(header, 4);
  header.writeUInt32LE(0x020002a4 | (icon === '' ? 0 : 0x40), 20);
  header.writeUInt32LE(1, 60);
  const string = (value: string): Buffer => {
    const length = Buffer.alloc(2);
    length.writeUInt16LE(value.length);
    return Buffer.concat([length, Buffer.from(value, 'utf16le')]);
  };
  // EnvironmentVariableDataBlock: fixed-size, zero-terminated ANSI and Unicode versions of the same target.
  const environment = Buffer.alloc(788);
  environment.writeUInt32LE(788, 0);
  environment.writeUInt32LE(0xa0000001, 4);
  environment.write(target, 8, 'ascii');
  environment.write(target, 268, 'utf16le');
  // Match Chromium's 64-character AppUserModelID, including its profile component and middle truncation.
  const components = [browser === 'edge' ? 'MSEdge' : 'Chrome', `${BROWSER_EXTENSION_ID}_/iframeHost.html`, ...(profile === 'Default' ? [] : [`UserData.${profile.replace(/[^A-Za-z0-9.]/g, '')}`])];
  const limit = Math.floor((64 - components.length + 1) / components.length);
  const appId = components.map((value) => value.length <= limit ? value : value.slice(0, Math.floor(limit / 2)) + value.slice(-Math.ceil(limit / 2))).join('.').replaceAll(' ', '_');
  // PropertyStoreDataBlock, with one serialized VT_LPWSTR PKEY_AppUserModel_ID (MS-PROPSTORE).
  const text = Buffer.alloc(Math.ceil((appId.length + 1) * 2 / 4) * 4);
  text.write(appId, 0, 'utf16le');
  const entry = Buffer.alloc(17);
  entry.writeUInt32LE(entry.length + text.length); entry.writeUInt32LE(5, 4); entry.writeUInt32LE(31, 9); entry.writeUInt32LE(appId.length + 1, 13);
  const storage = Buffer.alloc(24);
  storage.writeUInt32LE(storage.length + entry.length + text.length + 4); storage.writeUInt32LE(0x53505331, 4);
  Buffer.from('55284c9f799f394ba8d0e1d42de1d5f3', 'hex').copy(storage, 8);
  const properties = Buffer.alloc(8);
  properties.writeUInt32LE(8 + storage.length + entry.length + text.length + 8); properties.writeUInt32LE(0xa0000009, 4);
  return Buffer.concat([header, string('Switchboard'), string(args), ...(icon === '' ? [] : [string(icon)]), environment, properties, storage, entry, text, Buffer.alloc(12)]);
}
