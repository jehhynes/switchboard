import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { cliEnvironment } from '@switchboard/core';
import type { Exec } from '@switchboard/core';

/** A process named by its PID and creation time together, because Windows reuses PIDs (mechanics M31). */
export interface ProcessIdentity {
  pid: number;
  /** The creation time as a Windows file time, in 100-nanosecond units, as text. */
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
export async function queryProcesses(exec: Exec, pids: number[]): Promise<Map<number, ProcessInfo> | { error: string }> {
  const unique = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);

  if (unique.length === 0) {
    return new Map();
  }

  const found = await cimQuery(exec, unique.map((pid) => `ProcessId=${pid}`).join(' OR '));

  return 'error' in found ? found : new Map(found.map((info) => [info.pid, info]));
}

/** The tag every Codex run Switchboard starts carries, so a restarted hub can find its process (mechanics M31). */
export function runTag(sessionId: string, attempt: number): string {
  return `${sessionId}-${attempt}`;
}

/** Whether the command line carries exactly this run tag, as `-c switchboard_run="<tag>"` quoted for Windows. */
export function carriesTag(commandLine: string, tag: string): boolean {
  return new RegExp(`switchboard_run=\\\\?"${tag}\\\\?"`).test(commandLine);
}

/** The Codex process whose command line carries the tag, or null; more than one is an error, because each tag is unique. */
export async function findTagged(exec: Exec, tag: string): Promise<ProcessIdentity | null | { error: string }> {
  if (!/^[A-Za-z0-9-]+$/.test(tag)) {
    return { error: `Invalid run tag ${tag}.` };
  }

  const found = await cimQuery(exec, `Name='codex.exe' AND CommandLine LIKE '%switchboard_run=%${tag}%'`);

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

/** Whether a process with the PID exists; EPERM means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Ends the process and its children. */
export async function killTree(exec: Exec, pid: number): Promise<{ error: string } | null> {
  const result = await exec('taskkill', ['/pid', String(pid), '/T', '/F'], { timeoutMs: QUERY_TIMEOUT_MS });

  // 128: no such process, which counts as ended.
  return result.code === 0 || result.code === 128 ? null : { error: result.stderr.trim() || result.stdout.trim() || `taskkill exited with code ${String(result.code)}.` };
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
