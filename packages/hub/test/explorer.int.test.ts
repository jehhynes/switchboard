import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@switchboard/core';
import type { Settings } from '@switchboard/core';
import { DEFAULT_EXPLORER_FOLDERS, explorerFolders, hiddenPath, insideFolders, learnExplorerFolder, shownIgnored } from '../src/explorer.js';
import type { ExplorerDeps } from '../src/explorer.js';
import type { WindowScope } from '../src/windows.js';
import { isolateGit, makeRepo } from './gitFixture.js';

beforeAll(() => isolateGit());

const gitTimeout = { timeout: process.platform === 'win32' ? 30_000 : 10_000 };

/** Explore's deps over an in-memory record of learned folders, a work item 7 of ticket 1 from `source`, and that source's settings. */
function deps(source = 'github', folders: string[] = []): ExplorerDeps & { learned: Map<string, string[]> } {
  const learned = new Map<string, string[]>();
  const settings: Settings = { ...DEFAULT_SETTINGS, sources: { github: { kind: 'github', pollIntervalSeconds: 300, repoRoot: '', triagePlaybook: '', setupPrompt: '', namespace: '', explorerFolders: folders, options: {} } } };

  return {
    learned,
    store: {
      explorerFolders: (root) => learned.get(root) ?? [],
      addExplorerFolder: (root, path) => {
        const kept = learned.get(root) ?? [];

        if (kept.includes(path)) {
          return false;
        }

        learned.set(root, [...kept, path]);
        return true;
      },
      workItem: (id) => (id === 7 ? ({ id: 7, ticketId: 1 } as never) : null),
      ticket: (id) => (id === 1 ? ({ id: 1, source } as never) : null),
    },
    settings: () => settings,
    now: () => 1,
  };
}

const scopeOf = (cwd: string | null, workItemId: number | null = 7): WindowScope => ({ kind: 'page', key: 'p', folder: cwd ?? '', title: '', scopeGen: 1, conversations: [], workItemId, cwd, sessionId: null });

describe('explorer folder rules', () => {
  it('hides .git and node_modules at any depth, in any case', () => {
    expect(['.git', 'a/.GIT/x', 'node_modules', 'pkg/Node_Modules/x.js'].every(hiddenPath)).toBe(true);
    expect(['.github/x', 'my_node_modules/x', 'src/git'].some(hiddenPath)).toBe(false);
  });

  it('shows an entry inside a shown folder, and a folder on the way to one, but not a file beside it or a folder that only starts the same', () => {
    const folders = ['.wip', 'out/reports'];

    expect(['.wip/', '.wip/a.md', 'out/', 'out/reports/', 'out/reports/deep/r.md'].every((entry) => shownIgnored(folders, entry))).toBe(true);
    expect(['out', 'out/other.txt', 'out/report/', '.wipe/', 'dist/'].some((entry) => shownIgnored(folders, entry))).toBe(false);
    expect(insideFolders(folders, 'out/reports')).toBe(true);
    expect(insideFolders(folders, 'out')).toBe(false);
  });
});

describe('explorerFolders', gitTimeout, () => {
  it("is the defaults, the work item's artifact folder, its source's folders and the learned ones, without a hidden one", async () => {
    const made = makeRepo({ 'a.md': 'a\n' });
    const explorer = deps('github', ['out/reports', 'pkg/node_modules/x']);

    explorer.learned.set(realpathSync.native(made.root), ['tmp/learned']);
    expect(await explorerFolders(explorer, scopeOf(made.root))).toEqual([...DEFAULT_EXPLORER_FOLDERS, '.wip/artifacts/w7', 'out/reports', 'tmp/learned']);
  });

  it("takes no other source's folders, and only the defaults with no folder", async () => {
    const made = makeRepo({ 'a.md': 'a\n' });

    expect(await explorerFolders(deps('zoho', ['out/reports']), scopeOf(made.root))).toEqual(['.wip', '.wip/artifacts/w7']);
    expect(await explorerFolders(deps(), scopeOf(null))).toEqual(['.wip']);
  });
});

describe('learnExplorerFolder', gitTimeout, () => {
  it("learns an ignored folder of the worktree an artifact tag named a file in, once, keyed by the worktree's real path", async () => {
    const made = makeRepo({ '.gitignore': 'out/\n' });
    const explorer = deps();

    made.write('out/reports/r.md', 'r\n');

    const real = realpathSync.native(join(made.root, 'out', 'reports', 'r.md'));

    expect(await learnExplorerFolder(explorer, join(made.root, 'out'), real)).toBe(true);
    expect(await learnExplorerFolder(explorer, made.root, real)).toBe(false);
    expect(explorer.learned.get(realpathSync.native(made.root))).toEqual(['out/reports']);
  });

  it('learns the folder of an ignored file in a folder git does not ignore', async () => {
    const made = makeRepo({ '.gitignore': '*.log\n', 'docs/x.md': 'x\n' });
    const explorer = deps();

    made.write('docs/run.log', 'l\n');
    expect(await learnExplorerFolder(explorer, made.root, realpathSync.native(join(made.root, 'docs', 'run.log')))).toBe(true);
    expect(explorer.learned.get(realpathSync.native(made.root))).toEqual(['docs']);
  });

  it('learns nothing for a file git does not ignore, one already shown, a hidden one, the top, or a file outside the worktree', async () => {
    const made = makeRepo({ '.gitignore': '.wip/\nnode_modules/\n*.log\n', 'docs/x.md': 'x\n' });
    const outside = makeRepo({ 'y.md': 'y\n' });
    const explorer = deps();

    made.write('.wip/n.md', 'n\n');
    made.write('node_modules/m/i.js', 'i\n');
    made.write('top.log', 'l\n');

    const real = (root: string, path: string) => realpathSync.native(join(root, ...path.split('/')));
    const results = await Promise.all([
      learnExplorerFolder(explorer, made.root, real(made.root, 'docs/x.md')),
      learnExplorerFolder(explorer, made.root, real(made.root, '.wip/n.md')),
      learnExplorerFolder(explorer, made.root, real(made.root, 'node_modules/m/i.js')),
      learnExplorerFolder(explorer, made.root, real(made.root, 'top.log')),
      learnExplorerFolder(explorer, made.root, real(outside.root, 'y.md')),
    ]);

    expect(results).toEqual([false, false, false, false, false]);
    expect(explorer.learned.size).toBe(0);
  });
});
