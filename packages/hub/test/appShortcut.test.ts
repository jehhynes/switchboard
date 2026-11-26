import { describe, expect, it } from 'vitest';
import { appShortcut, linuxAppShortcut } from '../src/appShortcut.js';

function strings(bytes: Buffer): { description: string; args: string; environment: Buffer } {
  let offset = 76;
  const read = () => { const length = bytes.readUInt16LE(offset); offset += 2; const value = bytes.toString('utf16le', offset, offset + length * 2); offset += length * 2; return value; };
  const description = read(), args = read();
  if ((bytes.readUInt32LE(20) & 0x40) !== 0) read();
  return { description, args, environment: bytes.subarray(offset, offset + 788) };
}

describe('portable Windows app shortcut', () => {
  it('writes the specified header and portable target, with only the hub origin and app arguments', () => {
    const bytes = appShortcut('https://pc.tail.ts.net', new URLSearchParams({ browser: 'edge', profile: 'Profile 1' }));
    expect(bytes.readUInt32LE(0)).toBe(76);
    expect(bytes.subarray(4, 20).toString('hex')).toBe('0114020000000000c000000000000046');
    expect(bytes.readUInt32LE(20)).toBe(0x020002a4); expect(bytes.readUInt32LE(60)).toBe(1);
    const value = strings(bytes);
    expect(value.description).toBe('Switchboard');
    expect(value.args).toBe('"--profile-directory=Profile 1" "--app=chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije/iframeHost.html?origin=https%3A%2F%2Fpc.tail.ts.net"');
    expect(value.environment.readUInt32LE(0)).toBe(788); expect(value.environment.readUInt32LE(4)).toBe(0xa0000001);
    expect(value.environment.toString('utf16le', 268).split('\0')[0]).toBe('%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe');
    expect(bytes.subarray(-4)).toEqual(Buffer.alloc(4));
  });
  it('selects Default unless another profile is named and supports standard or per-user locations', () => {
    const standard = strings(appShortcut('http://127.0.0.1:47616', new URLSearchParams()));
    expect(standard.args).toContain('--profile-directory=Default');
    expect(standard.environment.toString('ascii', 8, 268).split('\0')[0]).toBe('%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe');
    for (const [installation, root] of [['user', '%LOCALAPPDATA%'], ['program-files', '%ProgramFiles%'], ['program-files-x86', '%ProgramFiles(x86)%']]) {
      const value = strings(appShortcut('https://pc.tail.ts.net', new URLSearchParams({ installation: installation! })));
      expect(value.environment.toString('utf16le', 268).split('\0')[0]).toBe(`${root}\\Google\\Chrome\\Application\\chrome.exe`);
    }
  });
  it('refuses credentials, arbitrary executables, arguments, profile paths and unknown options', () => {
    for (const value of ['browser=cmd', 'profile=..%2FDefault', 'profile=Default%22+--app%3Dhttps%3A%2F%2Fevil.test', 'profile=%25USERNAME%25', 'installation=other', 'origin=https%3A%2F%2Fevil.test', 'browser=edge&browser=chrome', 'icon=%5C%5Cevil.test%5Cshare%5Cswitchboard.ico', 'icon=C%3A%5Cevil.exe', 'icon=C%3A%5C%25USERNAME%25%5Cswitchboard.ico']) {
      expect(() => appShortcut('https://pc.tail.ts.net', new URLSearchParams(value))).toThrow('Invalid shortcut option.');
    }
    for (const origin of ['file:///secret', 'https://user:password@pc.tail.ts.net', 'http://evil.test', 'https://pc.tail.ts.net/page/?t=secret']) expect(() => appShortcut(origin, new URLSearchParams())).toThrow();
  });
});

describe('portable Linux app launcher', () => {
  const icon = '/home/alex/My Downloads/Switchboard/switchboard.png';
  const entry = (text: string): Record<string, string> => Object.fromEntries(text.split('\n').slice(1).filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  it('launches the extension host in Chrome with the icon and the Wayland app ID of the chosen profile', () => {
    const text = linuxAppShortcut('https://pc.tail.ts.net', new URLSearchParams({ system: 'linux', browser: 'chrome', profile: 'Profile 1', icon }));
    expect(text.startsWith('[Desktop Entry]\n')).toBe(true);
    expect(entry(text)).toEqual({
      Type: 'Application', Name: 'Switchboard', Comment: 'Your Switchboard work items', Terminal: 'false', Categories: 'Development;', Icon: icon,
      Exec: 'google-chrome "--profile-directory=Profile 1" "--app=chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije/iframeHost.html?origin=https%%3A%%2F%%2Fpc.tail.ts.net"',
      StartupWMClass: 'chrome-hlbibnhgkgnjkbfledhgjblacloneije__iframeHost.html-Profile_1',
    });
  });
  it('keeps the dots of a profile directory, as the Chrome app ID does', () => {
    const text = entry(linuxAppShortcut('http://127.0.0.1:47616', new URLSearchParams({ system: 'linux', profile: 'my-prof.x', icon })));
    expect(text['StartupWMClass']).toBe('chrome-hlbibnhgkgnjkbfledhgjblacloneije__iframeHost.html-my-prof.x');
  });
  it('selects Default unless another profile is named', () => {
    const text = entry(linuxAppShortcut('http://127.0.0.1:47616', new URLSearchParams({ system: 'linux', icon })));
    expect(text['Exec']).toContain('"--profile-directory=Default"');
    expect(text['StartupWMClass']).toBe('chrome-hlbibnhgkgnjkbfledhgjblacloneije__iframeHost.html-Default');
  });
  it('refuses other browsers, unsafe profiles or icons, Windows options and a missing icon', () => {
    for (const value of ['icon=', 'browser=edge', 'browser=chromium', 'installation=user', 'profile=..%2FDefault', 'profile=..', 'profile=.', 'profile=Default%22+--app%3Dhttps%3A%2F%2Fevil.test', 'icon=relative%2Fswitchboard.png',
      'icon=%2Ftmp%2F..%2Fswitchboard.png', 'icon=%2Fhome%2Fa%2Fswitchboard.ico', 'icon=%2Fhome%2F%24HOME%2Fswitchboard.png', 'icon=%2Fhome%2Fa%0AExec%3Dsh.png', 'icon=%2Fhome%2F%25f.png', 'origin=https%3A%2F%2Fevil.test']) {
      const query = new URLSearchParams(value); query.set('system', 'linux'); if (!query.has('icon')) query.set('icon', icon);
      expect(() => linuxAppShortcut('https://pc.tail.ts.net', query)).toThrow('Invalid shortcut option.');
    }
    expect(() => linuxAppShortcut('https://pc.tail.ts.net', new URLSearchParams({ system: 'windows', icon }))).toThrow('Invalid shortcut option.');
    for (const origin of ['file:///secret', 'https://user:password@pc.tail.ts.net', 'http://evil.test']) expect(() => linuxAppShortcut(origin, new URLSearchParams({ system: 'linux', icon }))).toThrow();
  });
});
