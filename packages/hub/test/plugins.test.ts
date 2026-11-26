import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_PLUGINS, PluginRegistry, pluginError } from '../src/plugins.js';
import { tempHome } from './helpers.js';

let temp: ReturnType<typeof tempHome>;

beforeEach(() => {
  temp = tempHome();
});

afterEach(() => {
  temp.remove();
});

/** Writes a plugin module whose default export has `kind`, and returns its absolute path. */
function writePlugin(name: string, body: string): string {
  const dir = join(temp.home, 'plugins');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, body);

  return path;
}

const plugin = (kind: string, extra = '') =>
  `export default { kind: '${kind}', label: 'Forum', ${extra} optionsError: () => null, create: (name) => ({ source: { name, poll: async () => ({ tickets: [] }), context: async () => ({ context: '' }), keyOfBranch: () => null } }) };`;

describe('PluginRegistry', () => {
  it('has the built-in plugins with no plugins setting', async () => {
    const registry = new PluginRegistry(temp.home);

    expect((await registry.use([])).all().map((entry) => entry.kind)).toEqual(['github', 'zoho']);
    expect(registry.current.errors).toEqual([]);
    expect(BUILT_IN_PLUGINS.map((entry) => [entry.kind, entry.label])).toEqual([
      ['github', 'GitHub'],
      ['zoho', 'Zoho Desk'],
    ]);
  });

  it('loads a module by absolute path and by ~, and builds a source with it', async () => {
    const path = writePlugin('forum', plugin('forum'));
    writePlugin('desk', plugin('desk'));
    const registry = new PluginRegistry(temp.home);
    const set = await registry.use([path, '~/plugins/desk.mjs']);

    expect(set.errors).toEqual([]);
    expect(set.all().map((entry) => entry.kind)).toEqual(['github', 'zoho', 'forum', 'desk']);
    expect(set.get('forum')!.create('support', { kind: 'forum', pollIntervalSeconds: 300, repoRoot: '', triagePlaybook: '', setupPrompt: '', namespace: '', options: {} }, { bash: 'bash' })).toMatchObject({ source: { name: 'support' } });
  });

  it('reports a missing module, a bad export and a kind already taken, and leaves those kinds out', async () => {
    const missing = join(temp.home, 'plugins', 'missing.mjs');
    const bad = writePlugin('bad', 'export default { kind: "Bad Kind", label: "x", optionsError() {}, create() {} };');
    const github = writePlugin('github', plugin('github'));
    const first = writePlugin('forum', plugin('forum'));
    const second = writePlugin('forum2', plugin('forum'));
    const set = await new PluginRegistry(temp.home).use([missing, bad, github, first, second]);

    expect(set.errors).toEqual([
      expect.stringMatching(new RegExp(`^plugins: ${missing.replaceAll('\\', '\\\\')}: it could not be loaded: `)),
      `plugins: ${bad}: its kind must be lowercase letters, digits and hyphens.`,
      `plugins: ${github}: another plugin has kind github.`,
      `plugins: ${second}: another plugin has kind forum.`,
    ]);
    expect(set.all().map((entry) => entry.kind)).toEqual(['github', 'zoho', 'forum']);
    expect(set.get('github')!.label).toBe('GitHub');
  });

  it('imports a path once, and resolving a draft leaves the set in force alone', async () => {
    const imported: string[] = [];
    const registry = new PluginRegistry(temp.home, async (url) => {
      imported.push(url);
      return { default: { kind: 'forum', label: 'Forum', optionsError: () => null, create: () => ({ error: 'x' }) } };
    });

    // An absolute path on this platform, and its file URL.
    const [plugin, url] = process.platform === 'win32' ? ['D:/plugins/forum.mjs', 'file:///D:/plugins/forum.mjs'] : ['/plugins/forum.mjs', 'file:///plugins/forum.mjs'];

    await registry.use([]);
    const draft = await registry.resolve([plugin]);

    expect(draft.get('forum')?.label).toBe('Forum');
    expect(registry.current.get('forum')).toBeUndefined();
    await registry.use([plugin]);
    expect(registry.current.get('forum')?.label).toBe('Forum');
    expect(imported).toEqual([url]);
  });
});

describe('pluginError', () => {
  it('accepts filled path icons and rejects malformed icon metadata', () => {
    const check = (icon: unknown) => pluginError({ kind: 'forum', label: 'Forum', icon, optionsError: () => null, create: () => null });
    const icon = { viewBox: '0 0 24 24', path: 'M0 0H24V24H0Z' };

    expect(check(icon)).toBeNull();
    expect(check({ ...icon, color: '#357a', width: 24, fillRule: 'evenodd' })).toBeNull();
    for (const value of [null, {}, { ...icon, viewBox: '0 0 0 24' }, { ...icon, viewBox: '0 0 0x10 24' }, { ...icon, viewBox: '0 0 Infinity 24' }, { ...icon, path: '' }, { ...icon, color: 'url(https://example.test/icon)' }, { ...icon, width: 0 }, { ...icon, width: 65 }, { ...icon, width: NaN }, { ...icon, fillRule: 'other' }]) {
      expect(check(value)).toMatch(/^its icon needs/);
    }
  });

  it('names what a default export lacks', () => {
    expect(pluginError(undefined)).toBe('its default export is not a source plugin.');
    expect(pluginError({ kind: 'forum', label: '', optionsError: () => null, create: () => null })).toBe('it needs a label, optionsError and create.');
    expect(pluginError({ kind: 'forum', label: 'Forum', optionsError: () => null })).toBe('it needs a label, optionsError and create.');
    expect(pluginError({ kind: 'forum', label: 'Forum', optionsError: () => null, create: () => null })).toBeNull();
    const withFields = (fields: unknown) => pluginError({ kind: 'forum', label: 'Forum', fields, optionsError: () => null, create: () => null });
    expect(withFields([{ key: 'userId', label: 'User ID', type: 'text', help: 'h', placeholder: '1', advanced: true }])).toBeNull();
    for (const fields of [{}, [{ key: 7, label: 'User', type: 'text' }], [{ key: 'a', label: 'A', type: 'date' }], [{ key: 'a', label: 'A', type: 'text', placeholder: 500 }], [{ key: 'a', label: 'A', type: 'text', advanced: 'yes' }], [null]]) {
      expect(withFields(fields)).toMatch(/^its fields must each have a key/);
    }
  });
});
