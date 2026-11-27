import { readdirSync, existsSync, mkdtempSync, utimesSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELD, takeSlot } from '../../../tools/check-lock.mjs';
import { fileURLToPath } from 'node:url';
import { checkPlan, loadWorkspaces, touchedWorkspaces, unchecked } from '../../../tools/check-plan.mjs';
import { unitTests } from '../../../tools/run-tests.mjs';

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

  it('CheckPlan_WebChangedInThisRepository_TestsTheExtensionWhoseTestReadsItsTheme', () => {
    const affected = checkPlan(loadWorkspaces(fileURLToPath(new URL('../../..', import.meta.url))), ['@switchboard/web']).affected;

    expect(affected.has('@switchboard/chrome')).toBe(true);
    expect(affected.has('@switchboard/hub-app')).toBe(true);
    expect(affected.has('@switchboard/core')).toBe(false);
  });
});

describe('touchedWorkspaces', () => {
  it('TouchedWorkspaces_Files_NamesTheirWorkspacesAndListsTheRest', () => {
    const workspaces = [{ dir: 'packages/core', name: 'core' }, { dir: 'packages/web', name: 'web' }];
    const { touched, outside } = touchedWorkspaces(workspaces, ['packages/web/src/a.ts', 'packages/core/b.ts', 'packages/web/c.ts', 'packages/webx/d.ts', 'tools/verify.mjs']);

    expect([...touched]).toEqual(['web', 'core']);
    expect(outside).toEqual(['packages/webx/d.ts', 'tools/verify.mjs']);
  });

  it('Unchecked_DocumentationAndTextOutsideEveryWorkspace_OnlyThem', () => {
    const workspaces = [{ dir: 'packages/core' }];

    expect(['docs/a.md', 'AGENTS.MD', 'notes.txt', 'packages/corex/a.md'].every((f) => unchecked(f, workspaces))).toBe(true);
    expect(['a.mdx', 'md.ts', 'packages/core/src/a.ts', 'packages/core/test/fixtures/a.txt', 'packages/core/README.md'].some((f) => unchecked(f, workspaces))).toBe(false);
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

  it('TakeSlot_StaleLockWhileAnotherWaiterTakesItOver_LeavesItUntilTheRecoveryLockIsOld', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slot-'));
    const lock = join(dir, 'switchboard-check-1.lock');
    const recovery = `${lock}.takeover`;
    const naps: number[] = [];
    let clock = Date.now();

    writeFileSync(lock, '777');
    writeFileSync(recovery, '');
    // Another waiter's takeover for 12 s: its recovery lock is old after 10 s, and is removed then.
    takeSlot({ dir, env: {}, pid: 888, alive: () => false, sleep: (ms: number) => { naps.push(ms); clock += 6000; }, log: () => {}, now: () => clock });
    expect(naps).toEqual([1000, 1000]);
    expect(readFileSync(lock, 'utf8')).toBe('888');
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

describe('unitTests', () => {
  it('UnitTests_NamedProjects_PassWithNoTestsOnlyThen', () => {
    // apps/hub has only integration tests, so a named project may have none; every workspace's run, or named files, must find some.
    expect(unitTests({ projects: ['@switchboard/hub-app'] }).args).toEqual(['vitest', 'run', '--coverage.enabled=false', '--passWithNoTests', '--exclude', '**/*.int.test.ts', '--exclude', '**/node_modules/**', '--project', '@switchboard/hub-app']);
    expect(unitTests().args).not.toContain('--passWithNoTests');
    expect(unitTests({ projects: ['@switchboard/web'], files: ['packages/web/test/page.test.ts'] }).args).not.toContain('--passWithNoTests');
  });
});
