import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * When the operator has left the computer (architecture.md § Dictation): the session locked, the computer going to sleep, or the session
 * disconnected, from a Remote Desktop client or from the console, and when each ends. Windows: `lockwatch.ps1` beside the voice process's
 * script. Linux: logind over D-Bus, through `gdbus`.
 */
export const LOCK_EVENTS = ['locked', 'unlocked', 'asleep', 'awake', 'disconnected', 'connected'] as const;

export type LockEvent = (typeof LOCK_EVENTS)[number];

export interface LockWatch {
  close(): void;
}

/** A line of `lockwatch.ps1`; null for a line that is not one. */
export function parseLockLine(line: string): LockEvent | null {
  try {
    const raw = JSON.parse(line) as { event?: unknown };

    return (LOCK_EVENTS as readonly unknown[]).includes(raw.event) ? (raw.event as LockEvent) : null;
  } catch {
    return null;
  }
}

/** The object path of the operator's graphical session, from `gdbus call` reading logind's `User.Display`; null when there is none. */
export function parseDisplaySession(output: string): string | null {
  const path = /objectpath '([^']+)'/.exec(output)?.[1] ?? null;

  // logind's "no display session" is the path `/`.
  return path === null || path === '/' ? null : path;
}

/**
 * A line of `gdbus monitor --system --dest org.freedesktop.login1`: the manager's `PrepareForSleep`, and for the operator's session its
 * `Lock` and `Unlock` and changes of its `LockedHint` (set by the screen locker) and `Active` (false while another session has the seat,
 * as after switching users). Null for any other line.
 */
export function parseLogindLine(line: string, session: string | null): LockEvent[] | null {
  const match = /^(\/\S*): ([\w.]+) (.*)$/.exec(line.trim());

  if (match === null) {
    return null;
  }

  const [, path, member, args] = match as unknown as [string, string, string, string];

  if (member === 'org.freedesktop.login1.Manager.PrepareForSleep') {
    return [/\btrue\b/.test(args) ? 'asleep' : 'awake'];
  }

  if (session === null || path !== session) {
    return null;
  }

  if (member === 'org.freedesktop.login1.Session.Lock') {
    return ['locked'];
  }

  if (member === 'org.freedesktop.login1.Session.Unlock') {
    return ['unlocked'];
  }

  if (member !== 'org.freedesktop.DBus.Properties.PropertiesChanged' || !args.includes("'org.freedesktop.login1.Session'")) {
    return null;
  }

  const events: LockEvent[] = [];
  const active = /'Active': <(true|false)>/.exec(args)?.[1];
  const locked = /'LockedHint': <(true|false)>/.exec(args)?.[1];

  if (active !== undefined) {
    events.push(active === 'true' ? 'connected' : 'disconnected');
  }

  if (locked !== undefined) {
    events.push(locked === 'true' ? 'locked' : 'unlocked');
  }

  return events.length === 0 ? null : events;
}

export interface LockWatchDeps {
  /** `lockwatch.ps1` on Windows. */
  script: string;
  changed(event: LockEvent): void;
  log(line: string): void;
  spawn?: typeof spawn;
  platform?: NodeJS.Platform;
}

/**
 * Starts watching; null on a platform with no watcher. A watcher that cannot run is logged, and the voice then never turns the mic off for a
 * lock, sleep or disconnect.
 */
export function watchLock(deps: LockWatchDeps): LockWatch | null {
  const run = deps.spawn ?? spawn;
  const platform = deps.platform ?? process.platform;

  if (platform === 'win32') {
    const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', deps.script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    failures(child, deps);
    child.stderr?.on('data', (data: Buffer) => deps.log(`lockwatch: ${data.toString('utf8').trim()}`));
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const event = parseLockLine(line);

      if (event !== null) {
        deps.changed(event);
      }
    });
    // The script exits when its stdin closes, as when this process exits.
    return { close: () => child.stdin?.end() };
  }

  if (platform === 'linux') {
    let closed = false;
    let monitor: ChildProcess | null = null;
    const call = (path: string, iface: string, property: string, done: (output: string) => void): void => {
      const child = run('gdbus', ['call', '--system', '--dest', 'org.freedesktop.login1', '--object-path', path, '--method', 'org.freedesktop.DBus.Properties.Get', iface, property], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      let answered = false;
      const answer = (output: string): void => {
        if (!answered) {
          answered = true;
          done(output);
        }
      };

      child.stdout?.on('data', (data: Buffer) => (out += data.toString('utf8')));
      child.on('error', () => answer(''));
      child.on('close', () => answer(out));
    };

    // The session first, so the monitor's lines can be told apart from other sessions' ones; then whether it is already locked.
    call('/org/freedesktop/login1/user/self', 'org.freedesktop.login1.User', 'Display', (output) => {
      if (closed) {
        return;
      }

      const session = parseDisplaySession(output);

      if (session === null) {
        deps.log("watching the session's lock: no graphical logind session found; only sleep is watched");
      }

      monitor = run('gdbus', ['monitor', '--system', '--dest', 'org.freedesktop.login1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      failures(monitor, deps);
      createInterface({ input: monitor.stdout! }).on('line', (line) => {
        for (const event of parseLogindLine(line, session) ?? []) {
          deps.changed(event);
        }
      });

      if (session !== null) {
        call(session, 'org.freedesktop.login1.Session', 'LockedHint', (hint) => {
          if (!closed && /<true>/.test(hint)) {
            deps.changed('locked');
          }
        });
      }
    });

    return {
      close: () => {
        closed = true;
        monitor?.kill();
      },
    };
  }

  return null;
}

function failures(child: ChildProcess, deps: LockWatchDeps): void {
  child.on('error', (error) => deps.log(`watching the session's lock failed: ${error.message}`));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      deps.log(`watching the session's lock stopped with exit code ${code}`);
    }
  });
}
