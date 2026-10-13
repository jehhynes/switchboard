/** What a `codex exec --json` run's stdout log says so far (mechanics M31). */
export interface RunLog {
  threadId: string | null;
  /** How the turn ended, or null while it runs or when the process died first. */
  end: { state: 'idle' } | { state: 'failed'; message: string } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A failure message, unwrapped from the API error JSON Codex puts in it when it holds one. */
export function failureMessage(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    const inner = isRecord(parsed) && isRecord(parsed['error']) ? parsed['error']['message'] : undefined;

    return typeof inner === 'string' && inner.trim() !== '' ? inner : raw;
  } catch {
    return raw;
  }
}

/** Reads the events of a run's log; a partial last line, still being written, is skipped. */
export function parseRunLog(text: string): RunLog {
  const log: RunLog = { threadId: null, end: null };

  for (const line of text.split('\n')) {
    let event: unknown;

    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRecord(event)) {
      continue;
    }

    switch (event['type']) {
      case 'thread.started':
        log.threadId = typeof event['thread_id'] === 'string' ? event['thread_id'] : log.threadId;
        break;
      case 'turn.completed':
        log.end = { state: 'idle' };
        break;
      case 'turn.failed': {
        const error = event['error'];
        const message = isRecord(error) && typeof error['message'] === 'string' ? failureMessage(error['message']) : 'unknown error';

        log.end = { state: 'failed', message };
        break;
      }
    }
  }

  return log;
}

/** The last non-empty line of a run's stderr, which holds Codex's refusal, such as the repository check (mechanics M31). */
export function lastErrorLine(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== 'Reading additional input from stdin...');

  return lines.at(-1) ?? null;
}
