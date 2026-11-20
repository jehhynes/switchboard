import type { Source, SourcePlugin, SourceSettings } from '@switchboard/core';
import { parseZohoConfig } from './config.js';
import { commandToken, deskClient } from './desk.js';
import { ZohoSource } from './source.js';

export * from './config.js';
export * from './desk.js';
export * from './source.js';
export * from './text.js';

/** The Zoho Desk source `name`, or why its settings are incomplete. `bash` runs the token command. */
export function zohoSource(name: string, settings: SourceSettings, bash = 'bash'): { source: Source } | { error: string } {
  const parsed = parseZohoConfig(settings.options, name);

  return 'error' in parsed ? parsed : { source: new ZohoSource(parsed.config, deskClient(parsed.config, commandToken(parsed.config.tokenCommand, bash)), Date.now, name) };
}

export const zohoPlugin: SourcePlugin = {
  kind: 'zoho',
  label: 'Zoho Desk',
  optionsError: (options, name) => {
    const parsed = parseZohoConfig(options, name);

    return 'error' in parsed ? parsed.error : null;
  },
  create: (name, settings, context) => zohoSource(name, settings, context.bash),
};
