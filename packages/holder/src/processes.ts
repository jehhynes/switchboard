import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

/** One process: its parent, its creation time as text (PIDs are reused) and its resident memory in bytes. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  created: string;
  memoryBytes: number;
}

export type RunFile = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const runFile: RunFile = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;

      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? '') });
    });
  });

const TABLE_SCRIPT = [
  '$rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {',
  '  ,@($_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc().ToString() } else { "" }), [int64]$_.WorkingSetSize)',
  '})',
  'ConvertTo-Json -InputObject $rows -Compress',
].join('\n');

/** Every process on Windows, from one CIM query in Windows PowerShell. */
export async function windowsTable(run: RunFile = runFile): Promise<ProcessRow[] | { error: string }> {
  const result = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', TABLE_SCRIPT], 30_000);

  if (result.code !== 0) {
    return { error: result.stderr.trim() || `The process query exited with code ${String(result.code)}.` };
  }

  try {
    const rows: unknown = JSON.parse(result.stdout.trim() || '[]');

    if (!Array.isArray(rows)) {
      return { error: 'The process query returned an unexpected answer.' };
    }

    return rows.flatMap((row: unknown) =>
      Array.isArray(row) && typeof row[0] === 'number' && typeof row[1] === 'number' && typeof row[2] === 'string' && typeof row[3] === 'number'
        ? [{ pid: row[0], ppid: row[1], created: row[2], memoryBytes: row[3] }]
        : [],
    );
  } catch {
    return { error: 'The process query returned output that is not JSON.' };
  }
}

/** Every live process in a `/proc` folder: memory from `statm`'s resident pages. */
export function procTable(proc = '/proc', pageBytes = 4096): ProcessRow[] | { error: string } {
  let names: string[];

  try {
    names = readdirSync(proc).filter((name) => /^\d+$/.test(name));
  } catch (error) {
    return { error: `${proc} could not be read: ${(error as Error).message}` };
  }

  return names.flatMap((name) => {
    const row = procRow(proc, name, pageBytes);

    return row === null ? [] : [row];
  });
}

/** One process from a `/proc` folder, or null when it is gone, a zombie or unreadable. */
function procRow(proc: string, name: string, pageBytes = 4096): ProcessRow | null {
  try {
    const stat = readFileSync(`${proc}/${name}/stat`, 'utf8');
    const statm = readFileSync(`${proc}/${name}/statm`, 'utf8');
    // The name may hold spaces and parentheses, so the fields are counted from the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const resident = Number.parseInt(statm.split(' ')[1] ?? '', 10);

    if (fields[0] === 'Z' || fields[19] === undefined || Number.isNaN(resident)) {
      return null;
    }

    return { pid: Number(name), ppid: Number.parseInt(fields[1]!, 10), created: fields[19], memoryBytes: resident * pageBytes };
  } catch {
    return null;
  }
}

export async function processTable(platform: NodeJS.Platform = process.platform, run: RunFile = runFile): Promise<ProcessRow[] | { error: string }> {
  return platform === 'win32' ? windowsTable(run) : procTable();
}

/** The process and its descendants, root first. */
export function treeOf(rows: ProcessRow[], pid: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  const root = rows.find((row) => row.pid === pid);

  for (const row of rows) {
    // A process whose parent exited can be listed under a parent PID that a later process reused; it was created before that parent.
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  }

  if (root === undefined) {
    return [];
  }

  const tree = [root];

  for (let index = 0; index < tree.length; index++) {
    const parent = tree[index]!;

    for (const child of children.get(parent.pid) ?? []) {
      if (child.pid !== parent.pid && !tree.includes(child) && !(parent.created !== '' && child.created !== '' && BigInt(child.created) < BigInt(parent.created))) {
        tree.push(child);
      }
    }
  }

  return tree;
}

/**
 * Ends the process and its descendants at once: `taskkill /T /F` on Windows, `SIGKILL` to each member of the tree elsewhere. A process
 * that is already gone counts as ended.
 */
export async function killTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: RunFile = runFile,
  signal: (pid: number) => void = (member) => process.kill(member, 'SIGKILL'),
  proc = '/proc',
): Promise<{ error: string } | null> {
  if (platform === 'win32') {
    const result = await run('taskkill', ['/pid', String(pid), '/T', '/F'], 15_000);

    // 128: no such process.
    return result.code === 0 || result.code === 128 ? null : { error: result.stderr.trim() || result.stdout.trim() || `taskkill exited with code ${String(result.code)}.` };
  }

  const rows = procTable(proc);

  if (!Array.isArray(rows)) {
    return rows;
  }

  for (const member of treeOf(rows, pid)) {
    // A member that exited since the scan may have passed its PID to another process, which must not be ended.
    if (procRow(proc, String(member.pid))?.created !== member.created) {
      continue;
    }

    try {
      signal(member.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        return { error: `Process ${member.pid} could not be ended: ${(error as Error).message}` };
      }
    }
  }

  return null;
}

/**
 * Reads each held process tree's memory in the background, because one read of the process table takes over a second on Windows
 * (mechanics M75), and `list` answers from the last read.
 */
export class MemorySampler {
  #memory = new Map<number, number>();
  #trees = new Map<number, ProcessRow[]>();
  #timer: NodeJS.Timeout | null = null;
  #reading = false;

  constructor(
    private readonly pids: () => number[],
    private readonly read: () => Promise<ProcessRow[] | { error: string }> = () => processTable(),
    private readonly intervalMs = 30_000,
    private readonly onError: (error: string) => void = () => undefined,
  ) {}

  start(): void {
    this.#timer ??= setInterval(() => void this.sample(), this.intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async sample(): Promise<void> {
    const pids = this.pids();

    if (this.#reading || pids.length === 0) {
      return;
    }

    this.#reading = true;

    try {
      const rows = await this.read();

      if (!Array.isArray(rows)) {
        this.onError(rows.error);
        return;
      }

      this.#memory = new Map();
      this.#trees = new Map();

      for (const pid of pids) {
        const tree = treeOf(rows, pid);

        if (tree.length > 0) {
          this.#memory.set(pid, tree.reduce((sum, row) => sum + row.memoryBytes, 0));
          this.#trees.set(pid, tree);
        }
      }
    } finally {
      this.#reading = false;
    }
  }

  memory(pids: number[]): Map<number, number> {
    return new Map(pids.flatMap((pid) => (this.#memory.has(pid) ? [[pid, this.#memory.get(pid)!] as const] : [])));
  }

  /** The members of the process tree last read, with their creation times. */
  tree(pid: number): Array<{ pid: number; created: string }> {
    return (this.#trees.get(pid) ?? []).map((row) => ({ pid: row.pid, created: row.created }));
  }
}
