import { spawn } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { cliEnvironment } from '@switchboard/core';
import type { Exec } from '@switchboard/core';

/** A process named by its PID and creation time together, because PIDs are reused (mechanics M31). */
export interface ProcessIdentity {
  pid: number;
  /**
   * The creation time as text: on Windows a file time in 100-nanosecond units; on Linux the start time in clock ticks since boot,
   * field 22 of `/proc/<pid>/stat`.
   */
  created: string;
}

export function sameProcess(a: ProcessIdentity | null, b: ProcessIdentity | null): boolean {
  return a !== null && b !== null && a.pid === b.pid && a.created === b.created;
}

export interface ProcessInfo extends ProcessIdentity {
  name: string;
  commandLine: string;
}

const QUERY_TIMEOUT_MS = 15_000;

/** Where the process table is read: Windows PowerShell's CIM, or a `/proc` folder elsewhere. Tests pass their own `/proc` and signal. */
export interface ProcessTable {
  platform?: NodeJS.Platform;
  proc?: string;
  /** Ends a process off Windows; `process.kill` with `SIGKILL` by default. */
  signal?: (pid: number) => void;
}

/**
 * Whether the process is Codex itself. On Linux the npm launcher (`codex.js`, run by Node) starts Codex as its child, which carries
 * the same arguments; the child is the process Codex's hooks find (mechanics M31).
 */
export function isCodex(name: string): boolean {
  return /^codex(\.exe)?$/i.test(name);
}

/** The process in `<proc>/<pid>`, or null when it is gone or a zombie. */
function readProc(proc: string, pid: number): (ProcessInfo & { ppid: number }) | null {
  let stat: string;
  let commandLine: string;

  try {
    stat = readFileSync(`${proc}/${pid}/stat`, 'utf8');
    commandLine = readFileSync(`${proc}/${pid}/cmdline`, 'utf8');
  } catch {
    return null;
  }

  // The name may hold spaces and parentheses, so the fields are counted from the last ')'.
  const close = stat.lastIndexOf(')');
  const fields = stat.slice(close + 2).split(' ');

  if (fields[0] === 'Z' || fields[19] === undefined) {
    return null;
  }

  return {
    pid,
    ppid: Number.parseInt(fields[1]!, 10),
    created: fields[19],
    name: stat.slice(stat.indexOf('(') + 1, close),
    commandLine: commandLine.split('\0').filter((arg) => arg !== '').join(' '),
  };
}

function procPids(proc: string): number[] | { error: string } {
  try {
    return readdirSync(proc)
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  } catch (error) {
    return { error: `${proc} could not be read: ${(error as Error).message}` };
  }
}

/** Runs one CIM query in Windows PowerShell and returns the processes it found, or the error. */
async function cimQuery(exec: Exec, filter: string): Promise<ProcessInfo[] | { error: string }> {
  const script = [
    `$found = @(Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction Stop | ForEach-Object {`,
    "  [pscustomobject]@{ pid = $_.ProcessId; created = $_.CreationDate.ToFileTimeUtc().ToString(); name = $_.Name; commandLine = [string]$_.CommandLine }",
    '})',
    'ConvertTo-Json -InputObject $found -Compress',
  ].join('\n');
  const result = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: QUERY_TIMEOUT_MS });

  if (result.code !== 0) {
    return { error: result.stderr.trim() || `The process query exited with code ${String(result.code)}.` };
  }

  try {
    const parsed: unknown = JSON.parse(result.stdout.trim() || '[]');

    return Array.isArray(parsed) ? (parsed as ProcessInfo[]) : { error: 'The process query returned an unexpected answer.' };
  } catch {
    return { error: 'The process query returned output that is not JSON.' };
  }
}

/** The live processes among the PIDs, by PID; a PID with no process is left out. */
export async function queryProcesses(exec: Exec, pids: number[], table: ProcessTable = {}): Promise<Map<number, ProcessInfo> | { error: string }> {
  const unique = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);

  if (unique.length === 0) {
    return new Map();
  }

  if ((table.platform ?? process.platform) !== 'win32') {
    const proc = table.proc ?? '/proc';

    return new Map(unique.flatMap((pid) => {
      const found = readProc(proc, pid);

      return found === null ? [] : [[pid, { pid, created: found.created, name: found.name, commandLine: found.commandLine }]];
    }));
  }

  const found = await cimQuery(exec, unique.map((pid) => `ProcessId=${pid}`).join(' OR '));

  return 'error' in found ? found : new Map(found.map((info) => [info.pid, info]));
}

/** The tag every Codex run Switchboard starts carries, so a restarted hub can find its process (mechanics M31). */
export function runTag(sessionId: string): string {
  return sessionId;
}

/** Whether the command line carries exactly this run tag, as `-c switchboard_run="<tag>"`, quoted for Windows or not. */
export function carriesTag(commandLine: string, tag: string): boolean {
  return new RegExp(`switchboard_run=\\\\?"${tag}\\\\?"`).test(commandLine);
}

/** The Codex process whose command line carries the tag, or null; more than one is an error, because each tag is unique. */
export async function findTagged(exec: Exec, tag: string, table: ProcessTable = {}): Promise<ProcessIdentity | null | { error: string }> {
  if (!/^[A-Za-z0-9-]+$/.test(tag)) {
    return { error: `Invalid run tag ${tag}.` };
  }

  const found = (table.platform ?? process.platform) === 'win32' ? await cimQuery(exec, `Name='codex.exe' AND CommandLine LIKE '%switchboard_run=%${tag}%'`) : procCodex(table.proc ?? '/proc');

  if ('error' in found) {
    return found;
  }

  // The LIKE pattern also matches a longer tag with this one as its prefix, so the exact value is checked.
  const exact = found.filter((info) => carriesTag(info.commandLine, tag));

  if (exact.length > 1) {
    return { error: `${exact.length} Codex processes carry the run tag ${tag}.` };
  }

  return exact[0] === undefined ? null : { pid: exact[0].pid, created: exact[0].created };
}

/** Every Codex process in the process table. */
function procCodex(proc: string): ProcessInfo[] | { error: string } {
  const pids = procPids(proc);

  return 'error' in pids ? pids : pids.flatMap((pid) => {
    const found = readProc(proc, pid);

    return found !== null && isCodex(found.name) ? [found] : [];
  });
}

/** Whether a process with the PID exists; EPERM means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Ends the process and its descendants at once, as `taskkill /T /F` does. A process that is already gone counts as ended. */
export async function killTree(exec: Exec, pid: number, table: ProcessTable = {}): Promise<{ error: string } | null> {
  if ((table.platform ?? process.platform) !== 'win32') {
    return killProcTree(table.proc ?? '/proc', pid, table.signal ?? ((member) => process.kill(member, 'SIGKILL')));
  }

  const result = await exec('taskkill', ['/pid', String(pid), '/T', '/F'], { timeoutMs: QUERY_TIMEOUT_MS });

  // 128: no such process, which counts as ended.
  return result.code === 0 || result.code === 128 ? null : { error: result.stderr.trim() || result.stdout.trim() || `taskkill exited with code ${String(result.code)}.` };
}

function killProcTree(proc: string, pid: number, signal: (pid: number) => void): { error: string } | null {
  const pids = procPids(proc);

  if ('error' in pids) {
    return pids;
  }

  const children = new Map<number, number[]>();
  const created = new Map<number, string>();

  for (const other of pids) {
    const found = readProc(proc, other);

    if (found !== null) {
      children.set(found.ppid, [...(children.get(found.ppid) ?? []), other]);
      created.set(other, found.created);
    }
  }

  const tree = created.has(pid) ? [pid] : [];

  for (let index = 0; index < tree.length; index++) {
    tree.push(...(children.get(tree[index]!) ?? []));
  }

  for (const member of tree) {
    // A member that exited since the scan may have passed its PID to another process, which must not be ended.
    if (readProc(proc, member)?.created !== created.get(member)) {
      continue;
    }

    try {
      signal(member);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        return { error: `Process ${member} could not be ended: ${(error as Error).message}` };
      }
    }
  }

  return null;
}

export interface DetachedSpawn {
  pid: number | null;
  error: string | null;
}

/**
 * Starts a process that outlives the hub, with stdout and stderr in files and stdin closed, and no shell, so a prompt's text
 * reaches it unchanged (mechanics M31).
 */
export function spawnDetached(file: string, args: string[], options: { cwd: string; stdout: string; stderr: string; env?: Record<string, string> }): Promise<DetachedSpawn> {
  return new Promise((resolve) => {
    const out = openSync(options.stdout, 'w');
    const err = openSync(options.stderr, 'w');

    try {
      const child = spawn(file, args, { cwd: options.cwd, env: { ...cliEnvironment(process.env), ...options.env }, detached: true, windowsHide: true, stdio: ['ignore', out, err] });

      child.once('error', (error) => resolve({ pid: null, error: error.message }));
      child.once('spawn', () => {
        child.unref();
        resolve({ pid: child.pid ?? null, error: null });
      });
    } catch (error) {
      resolve({ pid: null, error: (error as Error).message });
    } finally {
      closeSync(out);
      closeSync(err);
    }
  });
}
