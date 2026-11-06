import { homedir } from 'node:os';
import type { Source, SourceSettings } from '@switchboard/core';
import { parseGithubConfig } from './config.js';
import { spawnGh } from './gh.js';
import { readRolesFile } from './roles.js';
import { GithubSource } from './source.js';

export * from './config.js';
export * from './gh.js';
export * from './keys.js';
export * from './roles.js';
export * from './source.js';

/** The GitHub source `name`, or why its settings are incomplete. */
export function githubSource(name: string, settings: SourceSettings): { source: Source } | { error: string } {
  const parsed = parseGithubConfig(settings.options, name);

  return 'error' in parsed ? parsed : { source: new GithubSource(parsed.config, spawnGh(parsed.config.ghPath), (path) => readRolesFile(path, homedir()), name) };
}
