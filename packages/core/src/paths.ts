import { isAbsolute, join, resolve } from 'node:path';

/** The Switchboard home holds state, the hub bundle and its log, and settings and playbooks unless a config folder is set. */
export function switchboardHome(home: string): string {
  return join(home, '.switchboard');
}

export function hubRecordPath(home: string): string {
  return join(switchboardHome(home), 'hub.json');
}

export function hubLogPath(home: string): string {
  return join(switchboardHome(home), 'hub.log');
}

export function hubBundlePath(home: string): string {
  return join(switchboardHome(home), 'hub.js');
}


/**
 * The folder holding settings.json: the `switchboard.configDir` setting, with a leading `~` meaning
 * `profile`, or the Switchboard home when the setting is empty. A relative path is an error.
 */
export function resolveConfigDir(setting: string, home: string, profile: string): { dir: string } | { error: string } {
  const value = setting.trim();

  if (value === '') {
    return { dir: resolve(switchboardHome(home)) };
  }

  const expanded = value === '~' || /^~[\\/]/.test(value) ? join(profile, value.slice(1)) : value;

  return isAbsolute(expanded) ? { dir: resolve(expanded) } : { error: `switchboard.configDir must be an absolute path or start with ~: ${value}` };
}