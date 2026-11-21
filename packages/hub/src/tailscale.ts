import { REMOTE_HOST } from '@switchboard/core';
import type { Exec } from '@switchboard/core';

/** The Tailscale CLI's usual place on Windows, tried when `tailscale` is not on PATH. */
const WINDOWS_CLI = 'C:\\Program Files\\Tailscale\\tailscale.exe';

/**
 * This machine's Tailscale name and its owner's login from `tailscale status --json` (architecture.md § Remote access): `Self.DNSName` without its
 * final dot, and the `LoginName` of `Self.UserID` in `User`, both lowercased; or why not.
 */
export async function tailscaleIdentity(exec: Exec, platform: NodeJS.Platform = process.platform): Promise<{ host: string; login: string } | { error: string }> {
  let result = await exec('tailscale', ['status', '--json'], { timeoutMs: 10_000 });

  if (result.missing && platform === 'win32') {
    result = await exec(WINDOWS_CLI, ['status', '--json'], { timeoutMs: 10_000 });
  }

  if (result.missing) {
    return { error: 'the tailscale command was not found' };
  }

  if (result.code !== 0) {
    return { error: `tailscale status failed: ${(result.stderr || result.stdout).trim() || `exit ${String(result.code)}`}` };
  }

  try {
    const status = JSON.parse(result.stdout) as { BackendState?: unknown; Self?: { DNSName?: unknown; UserID?: unknown }; User?: Record<string, { LoginName?: unknown }> };
    const host = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '').toLowerCase() : '';
    const userId = status.Self?.UserID;
    // A user ID can be larger than a JavaScript number holds exactly, so the owner is the one user whose key reads as the same number, and none
    // when two do.
    const owners = typeof userId === 'number' ? Object.entries(status.User ?? {}).filter(([key]) => /^\d+$/.test(key) && Number(key) === userId) : [];
    const login = owners.length === 1 ? owners[0]![1].LoginName : undefined;

    if (status.BackendState !== 'Running') {
      return { error: `Tailscale is not running (${String(status.BackendState)})` };
    }

    if (!REMOTE_HOST.test(host)) {
      return { error: `Tailscale gave no machine name (${host || 'none'}); turn on MagicDNS` };
    }

    if (typeof login !== 'string' || !/^[^\s,;]+$/.test(login)) {
      return { error: "Tailscale named no login for this machine's owner" };
    }

    return { host, login: login.toLowerCase() };
  } catch {
    return { error: 'tailscale status did not answer JSON' };
  }
}
