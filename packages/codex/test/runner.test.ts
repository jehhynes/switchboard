import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_HOOK_SOURCE } from '../src/hooks.js';
import { CodexRunner, EXEC_RETIRED } from '../src/runner.js';

let home: string;
let codexHome: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'switchboard-codex-runner-'));
  codexHome = join(home, '.codex');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** The trust call and the running hubs the hook install sees. */
class Fake {
  trusted: ReadonlySet<string>[] = [];
  trustResult: string | null = null;
  /** Switchboard homes whose hub holds its lock. */
  runningHubs = new Set<string>();

  runner(): CodexRunner {
    return new CodexRunner({
      codexPath: () => 'codex',
      home,
      codexHome,
      env: { CODEX_HOME: codexHome },
      nodePath: () => 'node',
      trust: async (commands) => {
        this.trusted.push(commands);
        return this.trustResult;
      },
      hubRunning: async (other) => this.runningHubs.has(other),
    });
  }
}

describe('sessions (PRD R107)', () => {
  it('starts, follows and stops no codex exec run, and fails one a stopped hub left starting', async () => {
    const runner = new Fake().runner();

    expect(await runner.start({ type: 'start-session', sessionId: 's1', workItemId: 1, kind: 'task', provider: 'codex', cwd: 'D:/git/widgets', prompt: 'p', contract: 'c', name: 'n', permissionMode: 'bypassPermissions', model: null })).toEqual({ error: EXEC_RETIRED });
    expect(await runner.observe([])).toEqual({ sessions: [] });
    expect(runner.markers([]).size).toBe(0);
    expect(await runner.isBackground({ sessionId: 's1', shortId: 'thread-1' })).toBe(false);
    expect(await runner.stop({ sessionId: 's1', shortId: 'thread-1' }, 'operator')).toEqual({ error: EXEC_RETIRED });
    expect(await runner.reconcile([{ id: 's1' } as never])).toEqual([{ sessionId: 's1', failed: 'Switchboard stopped while the session was starting.' }]);
  });
});

describe('installHooks', () => {
  it("writes the hook script and Switchboard's entries, then has Codex trust them", async () => {
    const fake = new Fake();

    expect(await fake.runner().installHooks()).toBeNull();
    expect(readFileSync(join(home, 'codex-hook.mjs'), 'utf8')).toBe(CODEX_HOOK_SOURCE);
    expect(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).toContain('codex-hook.mjs');
    expect([...fake.trusted[0]!]).toEqual([`node "${join(home, 'codex-hook.mjs').replaceAll('\\', '/')}"`, `node "${join(home, 'contract.mjs').replaceAll('\\', '/')}"`]);
  });

  it("removes the entries of a Switchboard home whose hub does not run, and keeps a running hub's", async () => {
    const fake = new Fake();
    const stopped = 'C:/Temp/sb-live-home-a/.switchboard';
    const running = 'C:/Temp/sb-live-home-b/.switchboard';
    const entry = (other: string) => ({ hooks: [{ type: 'command', command: `node "${other}/codex-hook.mjs"`, timeout: 5 }] });

    fake.runningHubs.add(running);
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { Stop: [entry(stopped), entry(running)] } }));

    expect(await fake.runner().installHooks()).toBeNull();
    const stop = (JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')) as { hooks: { Stop: unknown[] } }).hooks.Stop;

    expect(stop).toEqual([entry(running), { hooks: [{ type: 'command', command: `node "${join(home, 'codex-hook.mjs').replaceAll('\\', '/')}"`, timeout: 5 }] }]);
  });

  it('reports a hooks file it must not change and a trust failure', async () => {
    const fake = new Fake();

    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'hooks.json'), '{ not json');
    expect(await fake.runner().installHooks()).toBe('Codex hooks.json is not valid JSON, so Switchboard left it alone.');
    expect(fake.trusted).toHaveLength(0);

    rmSync(join(codexHome, 'hooks.json'));
    fake.trustResult = "Codex did not trust Switchboard's hooks: no app-server";
    expect(await fake.runner().installHooks()).toBe("Codex did not trust Switchboard's hooks: no app-server");
    expect(existsSync(join(codexHome, 'hooks.json'))).toBe(true);
  });
});

