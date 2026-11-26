import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync, mkdtempSync, utimesSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELD, takeSlot } from '../../../tools/check-lock.mjs';
import { checkPlan } from '../../../tools/check-plan.mjs';
import { cleanTree, passed, recordPass, verifiedFile } from '../../../tools/verified.mjs';

// The workspace graph in package.json order, cut down: hub takes web, the app takes hub and chrome.
const WORKSPACES = [
  { name: 'core', deps: [] },
  { name: 'web', deps: ['core'] },
  { name: 'chrome', deps: ['core'] },
  { name: 'hub', deps: ['core', 'web'] },
  { name: 'app', deps: ['hub', 'chrome'] },
];
const NARROW = { hub: { web: ['test/page.test.ts'] }, app: { web: ['test/install.test.ts'], chrome: ['test/install.test.ts'] } };

describe('checkPlan', () => {
  it('CheckPlan_NarrowedDependency_RunsOnlyTheListedFilesOfItsDependents', () => {
    const plan = checkPlan(WORKSPACES, ['web'], NARROW);

    expect([...plan.affected]).toEqual(['web']);
    expect([...plan.partial]).toEqual([['hub', ['test/page.test.ts']], ['app', ['test/install.test.ts']]]);
    expect([...plan.checked].sort()).toEqual(['app', 'hub', 'web']);
    expect([...plan.toBuild].sort()).toEqual(['app', 'chrome', 'core', 'hub', 'web']);
  });

  it('CheckPlan_DependencyNotNarrowed_RunsEveryDependentInFull', () => {
    expect([...checkPlan(WORKSPACES, ['core'], NARROW).affected].sort()).toEqual(['app', 'chrome', 'core', 'hub', 'web']);
    expect(checkPlan(WORKSPACES, ['core'], NARROW).partial.size).toBe(0);
    // Hub itself changed: the app runs in full, even though it narrows web too.
    expect([...checkPlan(WORKSPACES, ['web', 'hub'], NARROW).affected].sort()).toEqual(['app', 'hub', 'web']);
    expect([...checkPlan(WORKSPACES, ['chrome', 'web'], NARROW).partial]).toEqual([['hub', ['test/page.test.ts']], ['app', ['test/install.test.ts']]]);
    expect([...checkPlan(WORKSPACES, ['web']).affected].sort()).toEqual(['app', 'hub', 'web']);
  });
});

describe('takeSlot', () => {
  const sleepless = (calls: number[]) => (ms: number) => { calls.push(ms); };

  it('TakeSlot_FreeSlot_TakesItAndFreesItOnce', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slot-'));
    const env: Record<string, string | undefined> = {};
    const free = takeSlot({ dir, env, pid: 4242, log: () => {} });
    const lock = join(dir, 'switchboard-check-1.lock');

    expect(readFileSync(lock, 'utf8')).toBe('4242');
    expect(env[HELD]).toBe(lock);
    // A nested check sees the parent's slot and takes none.
    expect(takeSlot({ dir, env, pid: 4343, sleep: () => { throw new Error('waited'); } })).toBeTypeOf('function');
    free();
    expect(existsSync(lock)).toBe(false);
    expect(env[HELD]).toBeUndefined();
  });

  it('TakeSlot_HeldByALiveProcess_WaitsAndTakesOverOnceItIsGone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slot-'));
    const lock = join(dir, 'switchboard-check-1.lock');
    const naps: number[] = [];
    const logged: string[] = [];
    let holderAlive = 3;

    writeFileSync(lock, '777');
    takeSlot({ dir, env: {}, pid: 888, alive: (pid: number) => pid === 777 && holderAlive-- > 0, sleep: sleepless(naps), log: (line: string) => logged.push(line), pollMs: 5 });
    expect(naps).toEqual([5, 5, 5]);
    expect(logged).toEqual(["checks: waiting for another session's checks (pid 777) to finish"]);
    expect(readFileSync(lock, 'utf8')).toBe('888');
  });

  it('TakeSlot_EmptyOrHourOldLock_TakesItOverEvenWithItsProcessAlive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slot-'));
    const lock = join(dir, 'switchboard-check-1.lock');
    const naps: number[] = [];
    let clock = Date.now();

    writeFileSync(lock, '');
    // Empty for under 10 s: its holder may still be writing its ID.
    takeSlot({ dir, env: {}, pid: 888, alive: () => true, sleep: (ms: number) => { naps.push(ms); clock += 6000; }, log: () => {}, now: () => clock });
    expect(naps).toEqual([1000, 1000]);
    expect(readFileSync(lock, 'utf8')).toBe('888');

    // A live ID on a lock made over an hour ago, which another process may have reused.
    utimesSync(lock, Date.now() / 1000 - 3601, Date.now() / 1000 - 3601);
    takeSlot({ dir, env: {}, pid: 999, alive: () => true, sleep: () => { throw new Error('waited'); }, log: () => {} });
    expect(readFileSync(lock, 'utf8')).toBe('999');
    expect(readdirSync(dir)).toEqual(['switchboard-check-1.lock']);
  });

  it('TakeSlot_TwoSlots_TakesTheSecondWhileTheFirstIsHeld', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slot-'));

    writeFileSync(join(dir, 'switchboard-check-1.lock'), '777');
    takeSlot({ dir, env: {}, pid: 888, slots: 2, alive: () => true, sleep: () => { throw new Error('waited'); }, log: () => {} });
    expect(readFileSync(join(dir, 'switchboard-check-1.lock'), 'utf8')).toBe('777');
    expect(readFileSync(join(dir, 'switchboard-check-2.lock'), 'utf8')).toBe('888');
  });
});

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
