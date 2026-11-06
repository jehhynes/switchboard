import type { Source, SourceSettings } from '@switchboard/core';
import { ForumSource, commandQuery, parseForumConfig } from './source.js';

export * from './source.js';

/** The Forum source `name`, or why its settings are incomplete. `bash` runs the query command. */
export function forumSource(name: string, settings: SourceSettings, bash = 'bash'): { source: Source } | { error: string } {
  const parsed = parseForumConfig(settings.options, name);

  return 'error' in parsed ? parsed : { source: new ForumSource(parsed.config, commandQuery(parsed.config.queryCommand, bash), name) };
}
