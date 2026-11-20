import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseDisplaySession, parseLockLine, parseLogindLine, watchLock } from '../src/lockWatch.js';
import type { LockEvent } from '../src/lockWatch.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;

  kill(): void {
    this.killed = true;
  }
}

function fakeSpawn() {
  const runs: Array<{ command: string; args: string[]; child: FakeChild }> = [];
  const spawn = ((command: string, args: string[]) => {
    const child = new FakeChild();

    runs.push({ command, args, child });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  return { runs, spawn };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const SESSION = '/org/freedesktop/login1/session/_32';

describe('the computer locking', () => {
  it("reads the Windows watcher's lines and logind's signals for the operator's session only", () => {
    expect(parseLockLine('{"event":"locked"}')).toBe('locked');
    expect(parseLockLine('{"event":"connected"}')).toBe('connected');
    expect(parseLockLine('{"event":"logoff"}')).toBeNull();
    expect(parseLockLine('Add-Type failed')).toBeNull();

    expect(parseDisplaySession(`(<('2', objectpath '${SESSION}')>,)`)).toBe(SESSION);
    expect(parseDisplaySession("(<('', objectpath '/')>,)")).toBeNull();
    expect(parseDisplaySession('')).toBeNull();

    expect(parseLogindLine('/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (true,)', null)).toEqual(['asleep']);
    expect(parseLogindLine('/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (false,)', SESSION)).toEqual(['awake']);
    expect(parseLogindLine(`${SESSION}: org.freedesktop.login1.Session.Lock ()`, SESSION)).toEqual(['locked']);
    expect(parseLogindLine(`${SESSION}: org.freedesktop.login1.Session.Unlock ()`, SESSION)).toEqual(['unlocked']);
    expect(parseLogindLine(`${SESSION}: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'LockedHint': <true>}, @as [])`, SESSION)).toEqual(['locked']);
    expect(parseLogindLine(`${SESSION}: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'Active': <false>, 'IdleHint': <true>}, @as [])`, SESSION)).toEqual(['disconnected']);
    expect(parseLogindLine(`${SESSION}: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'Active': <true>, 'LockedHint': <false>}, @as [])`, SESSION)).toEqual(['connected', 'unlocked']);
    expect(parseLogindLine(`${SESSION}: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'IdleHint': <true>}, @as [])`, SESSION)).toBeNull();
    // Another user's session, and our session's lock with no session known.
    expect(parseLogindLine('/org/freedesktop/login1/session/_33: org.freedesktop.login1.Session.Lock ()', SESSION)).toBeNull();
    expect(parseLogindLine(`${SESSION}: org.freedesktop.login1.Session.Lock ()`, null)).toBeNull();
    expect(parseLogindLine('Monitoring signals from all objects owned by org.freedesktop.login1', SESSION)).toBeNull();
  });

  it('runs lockwatch.ps1 on Windows, follows its lines, logs its errors, and ends it by closing its input', async () => {
    const { runs, spawn } = fakeSpawn();
    const events: LockEvent[] = [];
    const logs: string[] = [];
    const watch = watchLock({ script: 'C:/v/lockwatch.ps1', changed: (event) => events.push(event), log: (line) => logs.push(line), spawn, platform: 'win32' })!;

    expect(runs[0]!.command).toBe('powershell.exe');
    expect(runs[0]!.args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:/v/lockwatch.ps1']);
    runs[0]!.child.stdout.write('{"event":"locked"}\nnoise\n{"event":"unlocked"}\n');
    runs[0]!.child.stderr.write('reading the session\'s state failed: unexpected WTSINFOEX');
    await tick();
    expect(events).toEqual(['locked', 'unlocked']);
    runs[0]!.child.emit('exit', 1);
    runs[0]!.child.emit('error', new Error('ENOENT'));
    expect(logs).toEqual(["lockwatch: reading the session's state failed: unexpected WTSINFOEX", "watching the session's lock stopped with exit code 1", "watching the session's lock failed: ENOENT"]);

    let ended = false;

    runs[0]!.child.stdin.on('finish', () => (ended = true));
    watch.close();
    await tick();
    expect(ended).toBe(true);
  });

  it("finds the operator's session on Linux, reports it already locked, follows logind's signals, and stops the monitor on close", async () => {
    const { runs, spawn } = fakeSpawn();
    const events: LockEvent[] = [];
    const watch = watchLock({ script: '', changed: (event) => events.push(event), log: () => undefined, spawn, platform: 'linux' })!;
    const answer = async (run: number, output: string): Promise<void> => {
      runs[run]!.child.stdout.end(output);
      await tick();
      runs[run]!.child.emit('close', 0);
    };

    expect(runs.map((run) => `${run.command} ${run.args.join(' ')}`)).toEqual([
      'gdbus call --system --dest org.freedesktop.login1 --object-path /org/freedesktop/login1/user/self --method org.freedesktop.DBus.Properties.Get org.freedesktop.login1.User Display',
    ]);
    await answer(0, `(<('2', objectpath '${SESSION}')>,)\n`);
    expect(runs.slice(1).map((run) => `${run.command} ${run.args.join(' ')}`)).toEqual([
      'gdbus monitor --system --dest org.freedesktop.login1',
      `gdbus call --system --dest org.freedesktop.login1 --object-path ${SESSION} --method org.freedesktop.DBus.Properties.Get org.freedesktop.login1.Session LockedHint`,
    ]);
    await answer(2, '(<true>,)\n');
    expect(events).toEqual(['locked']);
    runs[1]!.child.stdout.write(
      [
        '/org/freedesktop/login1/session/_33: org.freedesktop.login1.Session.Unlock ()',
        `${SESSION}: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'LockedHint': <false>}, @as [])`,
        '/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (true,)',
        '',
      ].join('\n'),
    );
    await tick();
    expect(events).toEqual(['locked', 'unlocked', 'asleep']);
    watch.close();
    expect(runs[1]!.child.killed).toBe(true);
  });

  it('watches only sleep on Linux with no graphical session, reports nothing unlocked at start, and has no watcher elsewhere', async () => {
    const { runs, spawn } = fakeSpawn();
    const events: LockEvent[] = [];
    const logs: string[] = [];

    watchLock({ script: '', changed: (event) => events.push(event), log: (line) => logs.push(line), spawn, platform: 'linux' });
    runs[0]!.child.emit('error', new Error('ENOENT'));
    runs[0]!.child.emit('close', null);
    await tick();
    expect(logs).toEqual(["watching the session's lock: no graphical logind session found; only sleep is watched"]);
    expect(runs.map((run) => run.args[0])).toEqual(['call', 'monitor']);
    runs[1]!.child.stdout.write('/org/freedesktop/login1/session/_32: org.freedesktop.login1.Session.Lock ()\n/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForSleep (true,)\n');
    await tick();
    expect(events).toEqual(['asleep']);

    // Closed before the session was found: no monitor starts.
    const late = fakeSpawn();
    const watch = watchLock({ script: '', changed: () => undefined, log: () => undefined, spawn: late.spawn, platform: 'linux' })!;

    watch.close();
    late.runs[0]!.child.emit('close', 0);
    await tick();
    expect(late.runs).toHaveLength(1);
    expect(watchLock({ script: '', changed: () => undefined, log: () => undefined, spawn, platform: 'darwin' })).toBeNull();
  });
});
