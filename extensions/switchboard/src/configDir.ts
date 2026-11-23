import { resolve } from 'node:path';
import { readHubConfig, resolveConfigDir, switchboardHome } from '@switchboard/core';

/**
 * The config folder a window starts and accepts a hub on (architecture.md § Config folder): config.json's, which the hub owns, else the
 * `switchboard.configDir` setting until config.json exists, else the Switchboard home. An isolated home ignores the setting, which would name
 * the operator's own settings.
 */
export function windowConfigDir(home: string, profile: string, setting: string, isolated: boolean): string {
  const file = readHubConfig(home);

  if (file !== null && 'dir' in file) {
    return file.dir;
  }

  const resolved = isolated ? null : resolveConfigDir(setting, home, profile);

  return resolved !== null && 'dir' in resolved ? resolved.dir : resolve(switchboardHome(home));
}
