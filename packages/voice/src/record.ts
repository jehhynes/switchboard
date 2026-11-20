import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, win32 } from 'node:path';

/** Contents of `voice.json` in the Switchboard home: how the hub reaches the running voice process. */
export interface VoiceRecord {
  protocol: number;
  build: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

export const RECORD_FILE = 'voice.json';

/** When the operator's voice was enrolled, from the voice process's `<home>/voice/voiceprint.json`, or null when it was not. */
export function enrolledAt(home: string): string | null {
  try {
    const at = (JSON.parse(readFileSync(join(home, 'voice', 'voiceprint.json'), 'utf8')) as { at?: unknown }).at;

    return typeof at === 'string' ? at : null;
  } catch {
    return null;
  }
}
export const LOG_FILE = 'voice.log';

export function voiceRecordPath(home: string): string {
  return join(home, RECORD_FILE);
}

/** The single-instance lock of a Switchboard home's voice process: a named pipe on Windows, a socket file elsewhere. */
export function voiceLockAddress(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\switchboard-voice-${createHash('sha256').update(win32.resolve(home).toLowerCase()).digest('hex').slice(0, 16)}`;
  }

  return join(resolve(home), 'voice.sock');
}

const isInteger = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Null for anything that is not a complete record, such as a file caught mid-write. */
export function parseVoiceRecord(text: string): VoiceRecord | null {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }

  const r = raw as Record<string, unknown>;

  if (!isInteger(r.protocol, 1) || !isInteger(r.port, 1, 65535) || !isInteger(r.pid, 1) || typeof r.build !== 'string' || typeof r.token !== 'string' || r.token === '' || typeof r.startedAt !== 'string') {
    return null;
  }

  return { protocol: r.protocol, build: r.build, port: r.port, token: r.token, pid: r.pid, startedAt: r.startedAt };
}
