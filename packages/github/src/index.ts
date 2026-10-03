import type { Source, SourceSettings } from '@switchboard/core';
import { parseGithubConfig } from './config.js';
import { spawnGh } from './gh.js';
import { GithubSource } from './source.js';

export * from './clip.js';
export * from './config.js';
export * from './gh.js';
export * from './source.js';

/** The GitHub source for `sources.github`, or why its settings are incomplete. */
export function githubSource(settings: SourceSettings): { source: Source } | { error: string } {
  const parsed = parseGithubConfig(settings.options);

  return 'error' in parsed ? parsed : { source: new GithubSource(parsed.config, spawnGh(parsed.config.ghPath)) };
}
