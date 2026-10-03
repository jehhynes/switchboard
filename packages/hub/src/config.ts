import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, loadPlaybooks, parseSettings, switchboardHome } from '@switchboard/core';
import type { Playbook, PlaybookError, Settings } from '@switchboard/core';

export interface Config {
  settings: Settings;
  /** Why settings.json was rejected; the previous settings stay in force (PRD R42). */
  settingsError: string | null;
  playbooks: Map<string, Playbook>;
  playbookErrors: PlaybookError[];
}

export function settingsPath(home: string): string {
  return join(switchboardHome(home), 'settings.json');
}

export function playbooksDir(home: string): string {
  return join(switchboardHome(home), 'playbooks');
}

/** Reads settings and playbooks. A missing settings file means the defaults; an invalid one keeps `previous`. */
export function loadConfig(home: string, previous: Settings = DEFAULT_SETTINGS): Config {
  let settings = previous;
  let settingsError: string | null = null;
  let text: string | null = null;

  try {
    text = readFileSync(settingsPath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      settingsError = `settings.json could not be read: ${(error as Error).message}`;
    }
  }

  if (text !== null) {
    const parsed = parseSettings(text);

    if ('settings' in parsed) {
      settings = parsed.settings;
    } else {
      settingsError = parsed.errors.join(' ');
    }
  } else if (settingsError === null) {
    settings = DEFAULT_SETTINGS;
  }

  const { playbooks, errors } = loadPlaybooks(playbooksDir(home));

  return { settings, settingsError, playbooks, playbookErrors: errors };
}
