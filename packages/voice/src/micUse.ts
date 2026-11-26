import type { LogLevel } from '@switchboard/core/log';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Whether another app records from a microphone (architecture.md § Dictation, voice-design § 2.3), so the voice stops listening while it does, as
 * during a Teams call. Windows: the Core Audio session API on every active capture endpoint, through `micuse.ps1` beside the voice process's
 * script, which re-attaches when the endpoints change (claude-collab `.wip/mic-spike/findings.md`). Linux: PipeWire's recording streams, read
 * through its PulseAudio interface (`pactl`), the source GNOME's microphone indicator uses. The voice process's own capture never counts.
 */
export interface MicUse {
  close(): void;
}

/** A line of `micuse.ps1`: whether another process records, and which. Null for a line that is not one. */
export function parseMicUseLine(line: string): { busy: boolean; apps: string[] } | null {
  try {
    const raw = JSON.parse(line) as { busy?: unknown; apps?: unknown };

    return typeof raw.busy === 'boolean' ? { busy: raw.busy, apps: Array.isArray(raw.apps) ? raw.apps.filter((app): app is string => typeof app === 'string') : [] } : null;
  } catch {
    return null;
  }
}

/** The devices the echo check depends on, from `micuse.ps1` on Windows (architecture.md § Dictation). */
export interface AudioDevices {
  /** The playback device's name and its form factor, such as `headphones`, `headset`, `speakers` or `remote network device`. */
  output: string;
  /** The endpoints' IDs: a device recreated under the same name, as at a Remote Desktop reconnect, gets another. */
  outputId: string;
  formFactor: string;
  /** The default capture device's name. */
  input: string;
  inputId: string;
  /** Whether the voice process runs in a Remote Desktop session. */
  remote: boolean;
}

/** A devices line of `micuse.ps1`; null for a line that is not one. */
export function parseDevicesLine(line: string): AudioDevices | null {
  try {
    const raw = (JSON.parse(line) as { devices?: Record<string, unknown> }).devices;

    if (raw === undefined || typeof raw !== 'object' || raw === null || typeof raw['remote'] !== 'boolean') {
      return null;
    }

    const text = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '');

    return { output: text('output'), outputId: text('outputId'), formFactor: text('formFactor') || 'unknown', input: text('input'), inputId: text('inputId'), remote: raw['remote'] };
  } catch {
    return null;
  }
}

/**
 * The apps recording, from `pactl -f json list source-outputs`: every stream not corked, other than this process's and a level meter's
 * (`pavucontrol`'s peak detection), which reads a source without recording it.
 */
export function pactlRecording(json: string, ownPid: number): string[] {
  let outputs: unknown;

  try {
    outputs = JSON.parse(json);
  } catch {
    return [];
  }

  if (!Array.isArray(outputs)) {
    return [];
  }

  return outputs.flatMap((output: unknown) => {
    if (typeof output !== 'object' || output === null) {
      return [];
    }

    const stream = output as { corked?: unknown; properties?: Record<string, unknown> };
    const properties = stream.properties ?? {};
    const pid = Number(properties['application.process.id']);
    const peak = String(properties['media.name'] ?? '').toLowerCase().includes('peak detect');

    if (stream.corked === true || pid === ownPid || peak) {
      return [];
    }

    return [String(properties['application.name'] ?? properties['application.process.binary'] ?? `process ${Number.isNaN(pid) ? '?' : pid}`)];
  });
}

export interface MicUseDeps {
  /** `micuse.ps1` on Windows. */
  script: string;
  changed(busy: boolean, apps: string[]): void;
  /** The playback and capture devices or the Remote Desktop session changed (Windows only); the first call says what they are. */
  devices?(devices: AudioDevices): void;
  /** The playback device the voice uses, part of its name; null for the default. */
  speakers?: string | null;
  /** Watching cannot run, as when PowerShell or `pactl` is missing: the voice then listens as if no other app recorded. */
  failed(): void;
  log(line: string, level?: LogLevel): void;
  spawn?: typeof spawn;
  platform?: NodeJS.Platform;
}

/** Starts watching; null on a platform with neither path, where the voice never pauses for another app. */
export function watchMicUse(deps: MicUseDeps): MicUse | null {
  const run = deps.spawn ?? spawn;
  const platform = deps.platform ?? process.platform;

  if (platform === 'win32') {
    const speakers = deps.speakers ?? null;
    const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', deps.script, '-ExcludePid', String(process.pid), ...(speakers === null ? [] : ['-Speakers', speakers])], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    follow(child, deps, (line) => parseMicUseLine(line));
    // The script exits when its stdin closes, as when this process exits.
    return { close: () => child.stdin?.end() };
  }

  if (platform === 'linux') {
    let closed = false;
    let reading = false;
    let again = false;
    let last = '';
    const read = (): void => {
      if (reading) {
        again = true;
        return;
      }

      reading = true;

      const list = run('pactl', ['-f', 'json', 'list', 'source-outputs'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';

      list.stdout?.on('data', (data: Buffer) => (out += data.toString('utf8')));
      list.on('error', () => undefined);
      list.on('close', () => {
        reading = false;

        const apps = pactlRecording(out, process.pid);
        const state = JSON.stringify(apps);

        if (!closed && state !== last) {
          last = state;
          deps.changed(apps.length > 0, apps);
        }

        if (again) {
          again = false;
          read();
        }
      });
    };
    const events = run('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] });

    events.on('error', (error) => {
      deps.log(`watching other apps' recording failed: ${error.message}`, 'warn');
      deps.failed();
    });
    createInterface({ input: events.stdout! }).on('line', (line) => {
      if (/source-output/.test(line)) {
        read();
      }
    });
    read();

    return {
      close: () => {
        closed = true;
        events.kill();
      },
    };
  }

  return null;
}

function follow(child: ChildProcess, deps: MicUseDeps, parse: (line: string) => { busy: boolean; apps: string[] } | null): void {
  child.on('error', (error) => {
    deps.log(`watching other apps' recording failed: ${error.message}`, 'warn');
    deps.failed();
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      deps.log(`watching other apps' recording stopped with exit code ${code}`, 'warn');
      deps.failed();
    }
  });
  child.stderr?.on('data', (data: Buffer) => deps.log(`micuse: ${data.toString('utf8').trim()}`));
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const state = parse(line);

    if (state !== null) {
      deps.changed(state.busy, state.apps);
      return;
    }

    const devices = parseDevicesLine(line);

    if (devices !== null) {
      deps.devices?.(devices);
    }
  });
}
