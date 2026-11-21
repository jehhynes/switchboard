import { describe, expect, it } from 'vitest';
import type { Exec, ExecResult } from '@switchboard/core';
import { tailscaleIdentity } from '../src/tailscale.js';

/** `tailscale status --json` as Tailscale 1.98 prints it, cut to the fields read, with another user's peer whose UserID comes later. */
const STATUS = `{
  "Version": "1.98.4",
  "BackendState": "Running",
  "Self": { "ID": "n1", "HostName": "PC", "DNSName": "PC.tail1234.ts.net.", "OS": "windows", "UserID": 9007199254740993 },
  "Peer": { "k": { "DNSName": "phone.tail1234.ts.net.", "UserID": 2 } },
  "User": {
    "2": { "ID": 2, "LoginName": "other@example.com" },
    "9007199254740993": { "ID": 9007199254740993, "LoginName": "alex@example.com", "DisplayName": "Alex" }
  }
}`;

const result = (over: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...over });

/** An exec that answers each file from `answers`, recording the calls. */
function fakeExec(answers: Record<string, ExecResult>, calls: string[][]): Exec {
  return async (file, args) => {
    calls.push([file, ...args]);
    return answers[file] ?? result({ code: null, missing: true });
  };
}

describe('tailscaleIdentity', () => {
  it("reads this machine's name and its owner's login, a user ID beyond a JavaScript number included", async () => {
    const calls: string[][] = [];

    expect(await tailscaleIdentity(fakeExec({ tailscale: result({ stdout: STATUS }) }, calls), 'linux')).toEqual({ host: 'pc.tail1234.ts.net', login: 'alex@example.com' });
    expect(calls).toEqual([['tailscale', 'status', '--json']]);
  });

  it('tries the Windows install folder when tailscale is not on PATH, and only on Windows', async () => {
    const calls: string[][] = [];
    const windows = 'C:\\Program Files\\Tailscale\\tailscale.exe';

    expect(await tailscaleIdentity(fakeExec({ [windows]: result({ stdout: STATUS }) }, calls), 'win32')).toEqual({ host: 'pc.tail1234.ts.net', login: 'alex@example.com' });
    expect(calls.map((call) => call[0])).toEqual(['tailscale', windows]);
    expect(await tailscaleIdentity(fakeExec({ [windows]: result({ stdout: STATUS }) }, []), 'linux')).toEqual({ error: 'the tailscale command was not found' });
  });

  it('says why when tailscale fails, is stopped, has no MagicDNS name, names no owner, or prints no JSON', async () => {
    const answer = async (over: Partial<ExecResult>) => tailscaleIdentity(fakeExec({ tailscale: result(over) }, []), 'linux');

    expect(await answer({ code: 1, stderr: 'failed to connect to local tailscaled\n' })).toEqual({ error: 'tailscale status failed: failed to connect to local tailscaled' });
    expect(await answer({ stdout: STATUS.replace('"Running"', '"Stopped"') })).toEqual({ error: 'Tailscale is not running (Stopped)' });
    expect(await answer({ stdout: STATUS.replace('PC.tail1234.ts.net.', '') })).toEqual({ error: 'Tailscale gave no machine name (none); turn on MagicDNS' });
    expect(await answer({ stdout: STATUS.replace('"alex@example.com"', 'null') })).toEqual({ error: "Tailscale named no login for this machine's owner" });
    expect(await answer({ stdout: 'not json' })).toEqual({ error: 'tailscale status did not answer JSON' });
    // With no Self.UserID, a peer's user is never taken for the owner.
    expect(await answer({ stdout: STATUS.replace(', "UserID": 9007199254740993 }', ' }') })).toEqual({ error: "Tailscale named no login for this machine's owner" });
    // Two users whose IDs read as the same number leave the owner unknown.
    expect(await answer({ stdout: STATUS.replace('"2": { "ID": 2,', '"9007199254740992": { "ID": 9007199254740992,') })).toEqual({ error: "Tailscale named no login for this machine's owner" });
  });
});
