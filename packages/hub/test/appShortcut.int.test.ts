import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appShortcut } from '../src/appShortcut.js';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 5 }); });

describe('portable Windows app shortcut', () => {
  it.runIf(process.platform === 'win32').each([['Default', 'Chrome.hlbibnhgkgnjkbf/iframeHost.html'], ['Profile 1', 'Chrome.hlbibnhgkgeHost.html.UserData.Profile1']])('is read by Windows with its icon and identity for %s', (profile, appId) => {
    const dir = mkdtempSync(join(tmpdir(), 'switchboard-link-')); temporary.push(dir);
    const path = join(dir, 'Switchboard.lnk');
    const icon = join(dir, 'switchboard.ico');
    writeFileSync(path, appShortcut('https://pc.tail.ts.net', new URLSearchParams({ browser: 'chrome', profile: profile!, installation: 'user', icon })));
    const script = `$shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut('${path.replace(/'/g, "''")}'); @{target=$link.TargetPath;args=$link.Arguments;name=$link.Description;icon=$link.IconLocation;appId=(New-Object -ComObject Shell.Application).NameSpace('${dir.replace(/'/g, "''")}').ParseName('Switchboard.lnk').ExtendedProperty('System.AppUserModel.ID')}|ConvertTo-Json -Compress`;
    const value = JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }));
    expect(value.target).toBe(join(process.env['LOCALAPPDATA']!, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    expect(value.args).toBe(`"--profile-directory=${profile}" "--app=chrome-extension://hlbibnhgkgnjkbfledhgjblacloneije/iframeHost.html?origin=https%3A%2F%2Fpc.tail.ts.net"`);
    expect(value.name).toBe('Switchboard'); expect(value.icon).toBe(`${icon},0`);
    expect(value.appId).toBe(appId);
  });
});
