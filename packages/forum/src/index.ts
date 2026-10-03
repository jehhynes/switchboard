import type { Source, SourceSettings } from '@switchboard/core';
import { ForumSource, commandQuery, parseForumConfig } from './source.js';

export * from './source.js';

/** The Forum source for `sources.forum`, or why its settings are incomplete. `bash` runs the query command. */
export function forumSource(settings: SourceSettings, bash = 'bash'): { source: Source } | { error: string } {
  const parsed = parseForumConfig(settings.options);

  return 'error' in parsed ? parsed : { source: new ForumSource(parsed.config, commandQuery(parsed.config.queryCommand, bash)) };
}
