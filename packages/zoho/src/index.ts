import type { Source, SourceSettings } from '@switchboard/core';
import { parseZohoConfig } from './config.js';
import { commandToken, deskClient } from './desk.js';
import { ZohoSource } from './source.js';

export * from './config.js';
export * from './desk.js';
export * from './source.js';
export * from './text.js';

/** The Zoho Desk source for `sources.zoho`, or why its settings are incomplete. `bash` runs the token command. */
export function zohoSource(settings: SourceSettings, bash = 'bash'): { source: Source } | { error: string } {
  const parsed = parseZohoConfig(settings.options);

  return 'error' in parsed ? parsed : { source: new ZohoSource(parsed.config, deskClient(parsed.config, commandToken(parsed.config.tokenCommand, bash))) };
}
