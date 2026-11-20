import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactFolder, artifactType, parseArtifact, realInside } from '../src/artifacts.js';
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
