import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SourcePlugin } from '@switchboard/core';
import { githubPlugin } from '@switchboard/github';
import { zohoPlugin } from '@switchboard/zoho';

/** The plugins every hub has. */
export const BUILT_IN_PLUGINS: readonly SourcePlugin[] = [githubPlugin, zohoPlugin];

const KIND = /^[a-z0-9][a-z0-9-]*$/;

export type Loaded = { plugin: SourcePlugin } | { error: string };

/** Why a module's default export is not a source plugin, or null. */
export function pluginError(value: unknown): string | null {
  const plugin = value as Partial<SourcePlugin> | null;

  if (typeof plugin !== 'object' || plugin === null) {
    return 'its default export is not a source plugin.';
  }

  if (typeof plugin.kind !== 'string' || !KIND.test(plugin.kind)) {
    return 'its kind must be lowercase letters, digits and hyphens.';
  }

  if (typeof plugin.label !== 'string' || plugin.label === '' || typeof plugin.optionsError !== 'function' || typeof plugin.create !== 'function') {
    return 'it needs a label, optionsError and create.';
  }

  if (plugin.icon !== undefined && !isIcon(plugin.icon)) {
    return 'its icon needs a numeric viewBox with positive dimensions, a path, and optional hex color, width from 1 to 64 and fillRule of nonzero or evenodd.';
  }

  if (plugin.fields !== undefined && (!Array.isArray(plugin.fields) || !plugin.fields.every(isField))) {
    return 'its fields must each have a key, a label, a type of text, integer, boolean or list, and optional string help and placeholder and boolean advanced.';
  }

  return null;
}

function isIcon(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const icon = value as Record<string, unknown>;
  const parts = typeof icon['viewBox'] === 'string' ? icon['viewBox'].trim().split(/[ ,]+/) : [];
  const box = parts.map(Number);

  return box.length === 4 && parts.every((part) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(part)) && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0 &&
    typeof icon['path'] === 'string' && icon['path'].trim() !== '' &&
    (icon['color'] === undefined || (typeof icon['color'] === 'string' && /^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(icon['color']))) &&
    (icon['width'] === undefined || (typeof icon['width'] === 'number' && Number.isFinite(icon['width']) && icon['width'] >= 1 && icon['width'] <= 64)) &&
    (icon['fillRule'] === undefined || icon['fillRule'] === 'nonzero' || icon['fillRule'] === 'evenodd');
}

const FIELD_TYPES = new Set(['text', 'integer', 'boolean', 'list']);

function isField(value: unknown): boolean {
  const field = value as Record<string, unknown> | null;

  return (
    typeof field === 'object' &&
    field !== null &&
    typeof field['key'] === 'string' &&
    field['key'] !== '' &&
    typeof field['label'] === 'string' &&
    FIELD_TYPES.has(field['type'] as string) &&
    ['help', 'placeholder'].every((key) => field[key] === undefined || typeof field[key] === 'string') &&
    (field['advanced'] === undefined || typeof field['advanced'] === 'boolean')
  );
}

/** The plugins one settings file names: the built-in ones, then those of `plugins`, and why each that failed did. */
export interface PluginSet {
  get(kind: string): SourcePlugin | undefined;
  all(): SourcePlugin[];
  errors: string[];
}

export function pluginSet(loaded: ReadonlyArray<[string, Loaded]> = []): PluginSet {
  const plugins = new Map<string, SourcePlugin>(BUILT_IN_PLUGINS.map((plugin) => [plugin.kind, plugin]));
  const errors: string[] = [];

  for (const [path, entry] of loaded) {
    if ('error' in entry) {
      errors.push(`plugins: ${path}: ${entry.error}`);
    } else if (plugins.has(entry.plugin.kind)) {
      errors.push(`plugins: ${path}: another plugin has kind ${entry.plugin.kind}.`);
    } else {
      plugins.set(entry.plugin.kind, entry.plugin);
    }
  }

  return { get: (kind) => plugins.get(kind), all: () => [...plugins.values()], errors };
}

/**
 * Imports the modules the `plugins` setting names (PRD R1). A module is imported once per path, so a changed build loads when the hub
 * restarts. `current` is the set of the settings in force.
 */
export class PluginRegistry {
  private readonly modules = new Map<string, Loaded>();
  current: PluginSet = pluginSet();

  constructor(
    private readonly home = homedir(),
    private readonly importModule: (url: string) => Promise<unknown> = (url) => import(url),
  ) {}

  /** The set `paths` names, importing each path not imported yet. */
  async resolve(paths: readonly string[]): Promise<PluginSet> {
    const loaded: Array<[string, Loaded]> = [];
    for (const path of paths) {
      const entry = this.modules.get(path) ?? await this.importPlugin(path);
      if ('plugin' in entry) {
        this.modules.set(path, entry);
      }
      loaded.push([path, entry]);
    }

    return pluginSet(loaded);
  }

  /** Resolves `paths` and puts that set in force. */
  async use(paths: readonly string[]): Promise<PluginSet> {
    this.current = await this.resolve(paths);

    return this.current;
  }

  private async importPlugin(path: string): Promise<Loaded> {
    const file = path.startsWith('~') ? join(this.home, path.slice(2)) : path;

    try {
      const module = (await this.importModule(pathToFileURL(file).href)) as { default?: unknown };
      const error = pluginError(module.default);

      return error === null ? { plugin: module.default as SourcePlugin } : { error };
    } catch (error) {
      return { error: `it could not be loaded: ${(error as Error).message}` };
    }
  }
}
