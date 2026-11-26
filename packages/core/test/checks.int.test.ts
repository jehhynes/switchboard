import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanTree, passed, recordPass, verifiedFile } from '../../../tools/verified.mjs';

describe('verified trees', () => {
  /** A scratch repository with one commit, isolated as docs/testing.md requires. */
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'verified-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });

    git('init', '-q');
    expect(execFileSync('git', ['-C', dir, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim().replaceAll('\\', '/')).toBe(join(dir, '.git').replaceAll('\\', '/'));
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'a');
    return dir;
  }

  it('CleanTree_ChangedOrUntrackedFile_IsNull', () => {
    const dir = repo();
    const tree = cleanTree(dir);

    expect(tree).toMatch(/^[0-9a-f]{40}-none$/);
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    execFileSync('git', ['-C', dir, 'add', '.gitignore']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ignore']);
    writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{}');
    const installed = cleanTree(dir);

    expect(installed).toMatch(/^[0-9a-f]{40}-[0-9a-f]{16}$/);
    writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{"a":1}');
    expect(cleanTree(dir)).not.toBe(installed);
    writeFileSync(join(dir, 'b.txt'), 'b');
    expect(cleanTree(dir)).toBeNull();
  });

  it('RecordPass_Tree_IsPassedAndOthersAreNot', () => {
    const dir = repo();
    const tree = cleanTree(dir)!;
    const file = verifiedFile(dir);

    expect(file.replaceAll('\\', '/')).toBe(join(dir, '.git', 'switchboard-verified').replaceAll('\\', '/'));
    expect(passed(file, tree)).toBe(false);
    recordPass(file, tree);
    expect(passed(file, tree)).toBe(true);
    expect(passed(file, '0'.repeat(40))).toBe(false);

    for (let n = 0; n < 200; n++) recordPass(file, n.toString(16).padStart(40, '0'));
    // The oldest pass falls off once 200 newer trees passed.
    expect(passed(file, tree)).toBe(false);
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(200);
  });
});
