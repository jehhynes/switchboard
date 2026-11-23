import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactFolder, artifactType, EXTERNAL_NAME, ExternalArtifacts, externalFile, parseArtifact, realInside } from '../src/artifacts.js';
import type { Artifact } from '../src/artifacts.js';

let root: string;
let dir: string;
let folders: ArtifactFolder[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'artifacts-'));
  dir = join(root, 'w7');
  folders = [];
});

afterEach(() => {
  for (const folder of folders) {
    folder.close();
  }

  rmSync(root, { recursive: true, force: true });
});

type Change = { artifact: Artifact } | { path: string; removed: true };

function watchFolder(at = dir, now = () => 5_000): { folder: ArtifactFolder; changes: Change[]; logged: string[] } {
  const changes: Change[] = [];
  const logged: string[] = [];
  const folder = new ArtifactFolder(at, { onChange: (change) => changes.push(change), now, log: (line) => logged.push(line), settleMs: 20, lookMs: 30 });

  folders.push(folder);

  return { folder, changes, logged };
}

function put(name: string, text: string, mtime?: number): void {
  const file = join(dir, ...name.split('/'));

  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);

  if (mtime !== undefined) {
    utimesSync(file, mtime / 1000, mtime / 1000);
  }
}

describe('artifact files', () => {
  it('reads kind and title from front matter, else the first heading, an HTML title or the file name', () => {
    expect(parseArtifact('---\nkind: plan\ntitle: "How artifacts reach the view"\n---\n# Other', 'sb-plan/plan.md')).toEqual({ owner: 'sb-plan', kind: 'plan', title: 'How artifacts reach the view' });
    expect(parseArtifact('Intro\n# Speech engines\n', 'chat/comparison-speech.md')).toEqual({ owner: 'chat', kind: 'comparison', title: 'Speech engines' });
    expect(parseArtifact('<html><head><title>Voices</title></head></html>', 'chat/report-voices.html')).toEqual({ owner: 'chat', kind: 'report', title: 'Voices' });
    expect(parseArtifact('', 'chat/2026-shot.png')).toEqual({ owner: 'chat', kind: 'note', title: '2026-shot' });
  });

  it('types a file by its extension, and anything else as a file', () => {
    expect(['a.md', 'a.MARKDOWN', 'a.htm', 'a.svg', 'a.wav', 'a.webm', 'a.pdf', 'a'].map(artifactType)).toEqual(['markdown', 'markdown', 'html', 'image', 'audio', 'video', 'file', 'file']);
  });

  it('resolves a path inside the folder by its real path, and refuses one a link takes outside it', () => {
    put('chat/plan.md', 'x');
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', 'secret.md'), 'secret');
    symlinkSync(join(root, 'outside'), join(dir, 'chat', 'out'), 'junction');

    expect(realInside(dir, 'chat/plan.md')).toMatch(/plan\.md$/);
    expect(realInside(dir, 'chat/out/secret.md')).toBeNull();
    expect(realInside(dir, 'chat/missing.md')).toBeNull();
    expect(realInside(dir, '../outside/secret.md')).toBeNull();
  });
});

describe('ArtifactFolder', () => {
  it('lists the artifacts one level down, newest first, without dotfiles, files deeper down or links that leave the folder', () => {
    put('chat/comparison-a.md', '---\nkind: comparison\ntitle: A vs B\n---\n', 2_000_000);
    put('sb-plan/plan.md', '# The plan', 3_000_000);
    put('chat/comparison-a/chart.png', 'png');
    put('.gitignore', '*');
    put('chat/.draft.md', 'x');
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', 'secret.md'), '# Secret');
    symlinkSync(join(root, 'outside'), join(dir, 'linked'), 'junction');

    const { folder, changes } = watchFolder();

    expect(folder.list()).toEqual([
      { path: 'sb-plan/plan.md', owner: 'sb-plan', kind: 'plan', title: 'The plan', ext: 'md', type: 'markdown', updatedAt: 3_000_000 },
      { path: 'chat/comparison-a.md', owner: 'chat', kind: 'comparison', title: 'A vs B', ext: 'md', type: 'markdown', updatedAt: 2_000_000 },
    ]);
    // The first read is the list; nothing is published for it.
    expect(changes).toEqual([]);
  });

  it('publishes an artifact written, rewritten, changed through a file it uses, and deleted', async () => {
    mkdirSync(dir);
    const { folder, changes, logged } = watchFolder();

    put('chat/report.md', '# First', 2_000_000);
    await vi.waitFor(() => expect(changes).toEqual([{ artifact: expect.objectContaining({ path: 'chat/report.md', title: 'First', updatedAt: 2_000_000 }) }]));
    put('chat/report.md', '# Second', 2_500_000);
    await vi.waitFor(() => expect(changes.at(-1)).toEqual({ artifact: expect.objectContaining({ title: 'Second', updatedAt: 2_500_000 }) }));
    put('chat/report/shot.png', 'png');
    await vi.waitFor(() => expect(changes.at(-1)).toEqual({ artifact: expect.objectContaining({ path: 'chat/report.md', updatedAt: 2_500_001 }) }));
    rmSync(join(dir, 'chat', 'report.md'));
    await vi.waitFor(() => expect(changes.at(-1)).toEqual({ path: 'chat/report.md', removed: true }));
    expect(folder.list()).toEqual([]);
    expect(logged).toContain('artifact changed: chat/report.md');
  });

  it('counts a rewrite that keeps the file\'s older time as a change at the time it was read', () => {
    put('chat/report.md', '# First', 2_000_000);
    const { folder, changes } = watchFolder(dir, () => 9_000_000);

    put('chat/report.md', '# Copy', 1_000_000);
    folder.rescan();
    expect(changes).toEqual([{ artifact: expect.objectContaining({ title: 'Copy', updatedAt: 9_000_000 }) }]);
    folder.rescan();
    expect(changes).toHaveLength(1);
  });

  it('removes the artifacts of a deleted folder and lists them again when it is back, and watches a folder made after it started', async () => {
    const { folder, changes } = watchFolder();

    expect(folder.list()).toEqual([]);
    put('chat/plan.md', '# Plan', 2_000_000);
    await vi.waitFor(() => expect(folder.list().map((one) => one.path)).toEqual(['chat/plan.md']));
    rmSync(dir, { recursive: true, force: true });
    await vi.waitFor(() => expect(changes).toContainEqual({ path: 'chat/plan.md', removed: true }));
    expect(folder.list()).toEqual([]);
    put('chat/again.md', '# Again', 2_000_000);
    await vi.waitFor(() => expect(folder.list().map((one) => one.path)).toEqual(['chat/again.md']));
  });

  it('changes every artifact of a stem when the folder of files they use is renamed, and reads a rewrite that kept the file\'s time', async () => {
    put('chat/page.md', '# Page', 2_000_000);
    put('chat/page.html', '<title>Page</title>', 2_000_000);
    put('chat/page/a.png', 'png');
    const { changes } = watchFolder(dir, () => 9_000_000);

    renameSync(join(dir, 'chat', 'page'), join(dir, 'chat', 'renamed'));
    await vi.waitFor(() => expect(changes.map((change) => ('artifact' in change ? change.artifact.path : change.path)).sort()).toEqual(['chat/page.html', 'chat/page.md']));
    put('chat/page.md', '# Same time, new title', 2_000_000);
    await vi.waitFor(() => expect(changes.at(-1)).toEqual({ artifact: expect.objectContaining({ path: 'chat/page.md', title: 'Same time, new title' }) }));
  });

  it('stops publishing once closed', async () => {
    mkdirSync(dir);
    const { folder, changes } = watchFolder();

    folder.close();
    put('chat/plan.md', '# Plan');
    await new Promise((done) => setTimeout(done, 100));
    expect(changes).toEqual([]);
  });
});

describe('ExternalArtifacts', () => {
  function external(entries: Array<{ id: number; path: string; title?: string | null; kind?: string | null }>) {
    const changes: Change[] = [];
    const list = new ExternalArtifacts(entries.map((one) => ({ title: null, kind: null, ...one })), { onChange: (change) => changes.push(change), now: () => 9_000_000, log: () => {}, pollMs: 40, settleMs: 20 });

    folders.push(list as unknown as ArtifactFolder);

    return { list, changes };
  }

  it("lists each named file with its type, the tag's title and kind or the file's own, and its time, by a name no folder artifact has", () => {
    const real = realpathSync.native(root);
    const report = join(real, 'research', 'report', 'summary.md');

    mkdirSync(join(report, '..'), { recursive: true });
    writeFileSync(report, '---\nkind: research\ntitle: Speech engines\n---\n# Other');
    utimesSync(report, 2_000, 2_000);
    writeFileSync(join(real, 'page.html'), '<title>A page</title>');
    utimesSync(join(real, 'page.html'), 3_000, 3_000);

    const { list } = external([{ id: 4, path: report }, { id: 5, path: join(real, 'page.html'), title: 'Tagged', kind: 'demo' }, { id: 6, path: join(real, 'missing.md') }]);

    expect(list.list()).toEqual([
      { path: '@5/page.html', owner: 'external', kind: 'demo', title: 'Tagged', ext: 'html', type: 'html', updatedAt: 3_000_000, file: join(real, 'page.html').replaceAll('\\', '/') },
      { path: '@4/summary.md', owner: 'external', kind: 'research', title: 'Speech engines', ext: 'md', type: 'markdown', updatedAt: 2_000_000, file: report.replaceAll('\\', '/') },
    ]);
    expect(list.entry(4)?.path).toBe(report);
    expect(list.entry(6)).toBeNull();
    expect(EXTERNAL_NAME.test('chat/plan.md')).toBe(false);
  });

  it('publishes a change, a removal when the file goes and its return, and a file named later', async () => {
    const real = realpathSync.native(root);
    const file = join(real, 'notes.md');

    writeFileSync(file, '# First');
    utimesSync(file, 2_000, 2_000);

    const { list, changes } = external([{ id: 1, path: file }]);

    writeFileSync(file, '# Second');
    utimesSync(file, 2_500, 2_500);
    await vi.waitFor(() => expect(changes.at(-1)).toEqual({ artifact: expect.objectContaining({ path: '@1/notes.md', title: 'Second', updatedAt: 2_500_000 }) }));
    rmSync(file);
    await vi.waitFor(() => expect(changes.at(-1)).toEqual({ path: '@1/notes.md', removed: true }));
    expect(list.list()).toEqual([]);
    writeFileSync(file, '# Back');
    await vi.waitFor(() => expect(changes.at(-1)).toEqual({ artifact: expect.objectContaining({ title: 'Back' }) }));

    const later = join(real, 'later.png');

    writeFileSync(later, '');
    list.set([{ id: 1, path: file, title: null, kind: null }, { id: 2, path: later, title: null, kind: null }]);
    expect(changes.at(-1)).toEqual({ artifact: expect.objectContaining({ path: '@2/later.png', type: 'image', kind: 'later' }) });
    list.set([{ id: 2, path: later, title: null, kind: null }]);
    expect(changes.at(-1)).toEqual({ path: '@1/notes.md', removed: true });
  });

  it('lists no file whose path became a link, or that lies in a .git folder', () => {
    const real = realpathSync.native(root);

    mkdirSync(join(real, '.git'));
    writeFileSync(join(real, '.git', 'config'), '');
    writeFileSync(join(real, 'target.md'), '');
    symlinkSync(join(real, 'target.md'), join(real, 'link.md'), 'file');

    expect(external([{ id: 1, path: join(real, '.git', 'config') }, { id: 2, path: join(real, 'link.md') }]).list.list()).toEqual([]);
  });

  it("reads only the artifact's own file and the files under the folder named after its stem", async () => {
    const real = realpathSync.native(root);
    const entry = { id: 1, path: join(real, 'report.html'), title: null, kind: null };

    mkdirSync(join(real, 'report', 'img'), { recursive: true });
    writeFileSync(entry.path, '');
    writeFileSync(join(real, 'report', 'img', 'a.png'), '');
    writeFileSync(join(real, 'secret.txt'), '');

    expect(externalFile(entry, 'report.html')).toBe(entry.path);
    expect(externalFile(entry, 'report/img/a.png')).toBe(join(real, 'report', 'img', 'a.png'));
    expect(externalFile(entry, 'secret.txt')).toBeNull();
    expect(externalFile(entry, 'report/../secret.txt')).toBeNull();
    expect(externalFile(entry, 'report/.hidden')).toBeNull();
    expect(externalFile(entry, 'other/a.png')).toBeNull();

    // A stem folder that is a junction out of the file's own folder serves nothing of where it leads.
    const away = mkdtempSync(join(tmpdir(), 'artifacts-away-'));

    try {
      writeFileSync(join(away, 'keys.json'), '{}');
      rmSync(join(real, 'report'), { recursive: true });
      symlinkSync(away, join(real, 'report'), 'junction');
      expect(externalFile(entry, 'report/keys.json')).toBeNull();

      // Nor does its version read where the junction leads.
      const { list, changes } = external([entry]);

      writeFileSync(join(away, 'keys.json'), '{"changed": true}');
      await new Promise((done) => setTimeout(done, 150));
      expect(changes).toEqual([]);
      expect(list.list()).toHaveLength(1);
    } finally {
      rmSync(join(real, 'report'), { force: true, recursive: false });
      rmSync(away, { recursive: true, force: true });
    }
  });

  it('marks an artifact changed when a file in the folder named after its stem changes, its own file unchanged', async () => {
    const real = realpathSync.native(root);
    const page = join(real, 'page.html');

    mkdirSync(join(real, 'page', 'img'), { recursive: true });
    writeFileSync(page, '<title>Page</title>');
    writeFileSync(join(real, 'page', 'img', 'a.png'), 'one');

    const { list, changes } = external([{ id: 1, path: page }]);
    const before = list.list()[0]!.updatedAt;

    writeFileSync(join(real, 'page', 'img', 'a.png'), 'two, longer');
    await vi.waitFor(() => expect(changes.at(-1)).toEqual({ artifact: expect.objectContaining({ path: '@1/page.html' }) }));
    expect(list.list()[0]!.updatedAt).toBeGreaterThan(before);
  });
});
