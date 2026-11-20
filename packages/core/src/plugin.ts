import type { SourceSettings } from './settings.js';
import type { Source } from './source.js';

/** A source setting the Settings editor shows as a field. */
export interface SourceField {
  /** The option key, with `.` for a nested key, such as `project.owner`. */
  key: string;
  label: string;
  type: 'text' | 'integer' | 'boolean' | 'list';
  help?: string;
  /** The default, shown when the key is unset. */
  placeholder?: string;
  /** Shown under Advanced. */
  advanced?: boolean;
}

/** What the hub gives a plugin to build a source. */
export interface SourcePluginContext {
  /** The bash executable that runs the operator's commands, such as Git Bash on Windows. */
  bash: string;
}

/**
 * A source plugin (PRD R1): a built-in one, or the default export of a module that `plugins` names. The hub builds each source whose kind
 * is the plugin's with `create`, and checks its keys with `optionsError`.
 */
export interface SourcePlugin {
  /** Lowercase letters, digits and hyphens, such as `github`. */
  kind: string;
  /** The name the page shows, such as `GitHub`. */
  label: string;
  fields?: SourceField[];
  /** Null when the source's own keys are valid. */
  optionsError(options: Record<string, unknown>, name: string): string | null;
  create(name: string, settings: SourceSettings, context: SourcePluginContext): { source: Source } | { error: string };
}
