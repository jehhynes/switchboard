import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseHolderRecord, recordPath } from '@switchboard/holder';
import type { SessionEntry } from '@switchboard/holder';
import { afterEach, describe, expect, it } from 'vitest';
import { HolderLink } from '../src/holder.js';
import type { HolderConnection, HolderLinkDeps } from '../src/holder.js';

const MAIN = join(import.meta.dirname, '..', '..', 'holder', 'dist', 'main.js');
const BUILD = '0123456789abcdef';
const homes: string[] = [];
const pids: number[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const pid of pids.splice(0).filter(alive)) {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  }

  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

/** A Switchboard home with a holder build installed as activation installs it, whose script runs the checkout's built holder. */
function newHome(installed = true): string {
  const home = mkdtempSync(join(tmpdir(), 'hub-holder-'));
  const dir = join(home, 'holder', BUILD);

  homes.push(home);

  if (installed) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'holder.js'), `import(${JSON.stringify(pathToFileURL(MAIN).href)});\n`);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ build: BUILD, files: ['holder.js'] }));
    writeFileSync(join(home, 'holder', 'current.json'), JSON.stringify({ build: BUILD }));
  }

  return home;
}

function link(home: string, extra: Partial<HolderLinkDeps> = {}): { link: HolderLink; logs: string[] } {
  const logs: string[] = [];

  return { link: new HolderLink({ home, nodePath: () => process.execPath, log: (line) => logs.push(line), now: Date.now, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), ...extra }), logs };
}

const nodeProgram = { file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: tmpdir(), env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), cols: 80, rows: 24 };

describe('HolderLink (architecture.md § Terminal holder)', () => {
  it('finds no holder in a home where none runs, and starts none unless asked', async () => {
    const home = newHome();

    expect(await link(home).link.find(false)).toEqual({ gone: true });
    expect(existsSync(recordPath(home))).toBe(false);
  });

  it('refuses to start a holder that is not installed', async () => {
    const home = newHome(false);

    expect(await link(home).link.find(true)).toEqual({ error: `The terminal holder is not installed in ${join(home, 'holder')}; reload a VS Code window to install it.` });
  });

  it('starts the installed build detached, and a later hub finds the same holder with its sessions', async () => {
    const home = newHome();
    const first = link(home);
    const started = await first.link.find(true);

    if (!('holder' in started)) {
      throw new Error(JSON.stringify(started));
    }

    const record = parseHolderRecord(readFileSync(recordPath(home), 'utf8'))!;

    pids.push(record.pid);
    expect(started.holder.welcome).toMatchObject({ build: BUILD, pid: record.pid });
    expect(first.logs).toEqual([`started the terminal holder ${BUILD}`]);
    expect(existsSync(join(home, 'holder', BUILD, 'in-use'))).toBe(true);

    const { pid } = await started.holder.spawn({ session: 's1', label: 'github 7 native', ...nodeProgram });

    pids.push(pid);
    expect(await first.link.find(true)).toEqual(started);
    first.link.close();

    // A restarted hub: a new link, which starts no second holder.
    const second = link(home);
    const found = await second.link.find(true);

    if (!('holder' in found)) {
      throw new Error(JSON.stringify(found));
    }

    expect(found.holder.welcome.pid).toBe(record.pid);
    expect(second.logs).toEqual([]);
    expect((await found.holder.list()).map((entry) => [entry.session, entry.pid, entry.exitedAt])).toEqual([['s1', pid, null]]);
    await found.holder.kill('s1');
    await found.holder.shutdown();

    for (const until = Date.now() + 10_000; alive(record.pid) && Date.now() < until; ) {
      await new Promise((done) => setTimeout(done, 50));
    }

    expect(alive(record.pid)).toBe(false);
    expect(await second.link.find(false)).toEqual({ gone: true });
  }, 30_000);

  describe('a holder of another protocol', () => {
    function fake(protocol: number, live: number): HolderConnection & { shutdowns: number } {
      const entries: SessionEntry[] = Array.from({ length: live }, (_, index) => ({ session: `s${index}`, label: '', pid: 10 + index, cwd: '', startedAt: 0, lastInputAt: null, lastOutputAt: null, exitedAt: null, exitCode: null, clients: 0, memoryBytes: null }));
      const connection = {
        welcome: { protocol, build: 'old', pid: 4242 },
        compatible: protocol === 1,
        shutdowns: 0,
        spawn: async () => ({ session: 's', pid: 1 }),
        list: async () => entries,
        kill: async () => 0,
        screen: async () => ({ head: '', text: '' }),
        shutdown: async () => {
          connection.shutdowns += 1;
        },
        onClose: () => {},
        close: () => {},
      };

      return connection;
    }

    function recorded(home: string): void {
      writeFileSync(recordPath(home), JSON.stringify({ protocol: 2, build: 'old', port: 1, token: 'secret', pid: 4242, startedAt: '2026-11-18T00:00:00Z' }));
    }

    it('keeps one that holds live sessions, listing them, and refuses starts', async () => {
      const home = newHome();
      const old = fake(2, 2);
      const launched: string[][] = [];
      const { link: holder } = link(home, { connect: async () => old, lockHeld: async () => true, launch: (_node, args) => launched.push(args) });

      recorded(home);
      expect(await holder.find(false)).toMatchObject({ holder: old });
      expect(await holder.find(true)).toEqual({ error: 'The terminal holder is from another version of Switchboard; it is replaced once its 2 sessions end.' });
      expect(old.shutdowns).toBe(0);
      expect(launched).toEqual([]);
    });

    it('says a holder is gone each time a lookup finds the lock free, before starting one', async () => {
      const home = newHome();
      const events: string[] = [];
      let clock = 0;
      const { link: holder } = link(home, { lockHeld: async () => false, gone: () => events.push('gone'), launch: () => events.push('launch'), now: () => (clock += 6_000) });

      await holder.find(false);
      expect(await holder.find(true)).toEqual({ error: `The terminal holder did not start within 10 seconds. Log: ${join(home, 'holder.log')}` });

      expect(events.slice(0, 3)).toEqual(['gone', 'gone', 'launch']);
    });

    it('asks one that holds none to exit, then starts this build', async () => {
      const home = newHome();
      const old = fake(2, 0);
      const current = { ...fake(1, 0), welcome: { protocol: 1, build: BUILD, pid: 4243 } };
      let held = true;
      const launched: string[][] = [];
      const { link: holder, logs } = link(home, {
        connect: async () => (launched.length === 0 ? old : current),
        lockHeld: async () => held,
        launch: (_node, args) => {
          launched.push(args);
          writeFileSync(recordPath(home), JSON.stringify({ protocol: 1, build: BUILD, port: 2, token: 'new', pid: 4243, startedAt: '2026-11-18T00:00:01Z' }));
        },
      });

      recorded(home);
      old.shutdown = async () => {
        old.shutdowns += 1;
        held = false;
      };

      expect(await holder.find(true)).toMatchObject({ holder: current });
      expect(old.shutdowns).toBe(1);
      expect(launched).toEqual([[join(home, 'holder', BUILD, 'holder.js'), `--home=${home}`, `--build=${BUILD}`]]);
      expect(logs).toEqual(['terminal holder of protocol 2 replaced by protocol 1', `started the terminal holder ${BUILD}`]);
    });
  });

  it('shares one connection between lookups made together', async () => {
    const home = newHome();
    let connects = 0;
    const connection = { welcome: { protocol: 1, build: BUILD, pid: 4243 }, compatible: true, spawn: async () => ({ session: 's', pid: 1 }), list: async () => [], kill: async () => 0, screen: async () => ({ head: '', text: '' }), shutdown: async () => {}, onClose: () => {}, close: () => {} };
    const { link: holder } = link(home, {
      connect: async () => {
        connects += 1;
        await new Promise((done) => setTimeout(done, 10));
        return connection;
      },
    });

    writeFileSync(recordPath(home), JSON.stringify({ protocol: 1, build: BUILD, port: 2, token: 't', pid: 4243, startedAt: '2026-11-18T00:00:01.000Z' }));

    const found = await Promise.all([holder.find(false), holder.find(false), holder.find(true)]);

    expect(connects).toBe(1);
    expect(found).toEqual([0, 1, 2].map(() => ({ holder: connection })));
  });

  it('gives the port and token of the holder it is connected to, and none before it connects or after the connection closes', async () => {
    const home = newHome();
    let close = (): void => {};
    const connection = { welcome: { protocol: 1, build: BUILD, pid: 4243 }, compatible: true, spawn: async () => ({ session: 's', pid: 1 }), list: async () => [], kill: async () => 0, screen: async () => ({ head: '', text: '' }), shutdown: async () => {}, onClose: (listener: () => void) => (close = listener), close: () => {} };
    const { link: holder } = link(home, { connect: async () => connection });

    writeFileSync(recordPath(home), JSON.stringify({ protocol: 1, build: BUILD, port: 2, token: 't', pid: 4243, startedAt: '2026-11-18T00:00:01.000Z' }));
    expect(holder.record()).toBeNull();
    await holder.find(false);
    expect(holder.record()).toEqual({ port: 2, token: 't' });
    close();
    expect(holder.record()).toBeNull();
  });

  it('reports a holder that holds its lock but does not answer as a failed read, not as gone', async () => {
    const home = newHome();
    const { link: holder } = link(home, { lockHeld: async () => true });

    expect(await holder.find(false)).toEqual({ error: 'The terminal holder holds its lock but does not answer.' });
  });
});
