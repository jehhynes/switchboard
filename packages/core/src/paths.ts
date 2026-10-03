import { join } from 'node:path';

/** The Switchboard home holds state, playbooks, settings, the hub bundle and its log. */
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
