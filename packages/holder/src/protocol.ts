/** The terminal holder's wire protocol: JSON lines in UTF-8 over loopback TCP. */

/** Bumped for any change other than an added optional field. `hello`, `welcome`, `list`, `kill` and `shutdown` keep their shape in every protocol, so any client can list and stop the sessions of a holder of another version. */
export const PROTOCOL = 1;
/** A longer line from a client closes the connection. */
export const MAX_LINE_BYTES = 1024 * 1024;
/** The longest line a client accepts from the holder it authenticated: a `list` or `screen` reply can pass `MAX_LINE_BYTES`. */
export const MAX_HOST_LINE_BYTES = 64 * 1024 * 1024;
/** A replay or output message carries at most this much encoded data, so its line stays under `MAX_LINE_BYTES`. */
export const DATA_CHUNK_BYTES = 512 * 1024;
/** Output queued for a client beyond this drops the client, never the session. */
export const CLIENT_QUEUE_BYTES = 8 * 1024 * 1024;
export const HELLO_DEADLINE_MS = 5_000;
export const KILL_DEADLINE_MS = 15_000;
/** How long a program has to exit after its pseudo-terminal closed before `kill` ends its process tree. */
export const CLOSE_GRACE_MS = 5_000;
/** How long an exited session's last screen and exit code stay attachable. */
export const EXIT_RETENTION_MS = 10 * 60_000;
export const SCROLLBACK_LINES = 10_000;
/** The start of a session's output kept for start checks after it has scrolled away, in characters. */
export const HEAD_CHARS = 64 * 1024;

/** One session in a `list` reply. Times are milliseconds since the epoch. */
export interface SessionEntry {
  session: string;
  label: string;
  pid: number;
  cwd: string;
  startedAt: number;
  lastInputAt: number | null;
  lastOutputAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  clients: number;
  /** The process tree's memory, or null when it has not been read. */
  memoryBytes: number | null;
  /** A live session's process tree as last read, with creation times, so a later check can tell a reused PID; absent before the first read. */
  tree?: Array<{ pid: number; created: string }>;
}

export interface SpawnRequest {
  session: string;
  label: string;
  file: string;
  args: string[];
  cwd: string;
  /** The whole environment of the program. */
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type ClientMessage =
  | { type: 'hello'; token: string }
  | ({ type: 'spawn'; id: number } & SpawnRequest)
  | { type: 'list'; id: number }
  | { type: 'kill'; id: number; session: string }
  | { type: 'screen'; id: number; session: string }
  | { type: 'watch'; id: number }
  | { type: 'shutdown'; id: number }
  | { type: 'attach'; session: string; cols: number; rows: number }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type HostMessage =
  | { type: 'welcome'; protocol: number; build: string; pid: number }
  | { type: 'error'; message: string; re?: number }
  | { type: 'spawned'; re: number; session: string; pid: number }
  | { type: 'sessions'; re: number; sessions: SessionEntry[] }
  | { type: 'killed'; re: number; session: string; exitCode: number | null }
  | { type: 'screen'; re: number; session: string; head: string; text: string }
  | { type: 'watching'; re: number }
  | { type: 'bye'; re: number }
  | { type: 'exited'; session?: string; exitCode: number | null }
  | { type: 'attached'; session: string; clients: number }
  | { type: 'detached'; session: string; clients: number }
  | { type: 'replay'; data: string }
  | { type: 'replayed' }
  | { type: 'output'; data: string };

/** Splits a byte stream into lines; a line over the limit is an error, since the peer is not following the protocol. */
export class LineReader {
  #parts: Buffer[] = [];
  #length = 0;

  constructor(private readonly limit = MAX_LINE_BYTES) {}

  /** The complete lines in the chunk, or an error once a line is too long. */
  push(chunk: Buffer): string[] | { error: string } {
    const lines: string[] = [];
    let start = 0;

    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
      if (this.#length + index - start > this.limit) {
        return { error: 'The message is too long.' };
      }

      this.#parts.push(chunk.subarray(start, index));
      lines.push(Buffer.concat(this.#parts).toString('utf8'));
      this.#parts = [];
      this.#length = 0;
      start = index + 1;
    }

    if (start < chunk.length) {
      this.#length += chunk.length - start;

      if (this.#length > this.limit) {
        return { error: 'The message is too long.' };
      }

      this.#parts.push(chunk.subarray(start));
    }

    return lines;
  }
}

export function encode(message: ClientMessage | HostMessage): string {
  return JSON.stringify(message) + '\n';
}

/** The size of a character in a JSON string in UTF-8. */
function encodedSize(code: number): number {
  if (code < 0x20) {
    return 6;
  }

  if (code === 0x22 || code === 0x5c) {
    return 2;
  }

  return code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
}

/** Splits data so that each part's JSON encoding stays within the limit, keeping surrogate pairs whole. */
export function chunkData(data: string, limit = DATA_CHUNK_BYTES): string[] {
  const chunks: string[] = [];
  let start = 0;
  let size = 0;

  for (let index = 0; index < data.length; index++) {
    const code = data.charCodeAt(index);
    const pair = code >= 0xd800 && code <= 0xdbff && index + 1 < data.length;
    const width = pair ? 4 : encodedSize(code);

    if (size + width > limit && index > start) {
      chunks.push(data.slice(start, index));
      start = index;
      size = 0;
    }

    size += width;

    if (pair) {
      index++;
    }
  }

  if (start < data.length) {
    chunks.push(data.slice(start));
  }

  return chunks;
}

type Fields = Record<string, unknown>;

const isText = (value: unknown): value is string => typeof value === 'string';
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1000;
const isName = (value: unknown): value is string => isText(value) && value !== '' && value.length <= 200;
const isPath = (value: unknown): value is string => isText(value) && value !== '' && value.length <= 4096;
const isLabel = (value: unknown): value is string => isText(value) && value.length <= 1000;

function isEnvironment(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isText);
}

/** A client message, or why it is refused: malformed JSON, an unknown type or an invalid field. */
export function parseClientMessage(line: string): ClientMessage | { error: string } {
  let raw: unknown;

  try {
    raw = JSON.parse(line);
  } catch {
    return { error: 'The message is not JSON.' };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'The message is not an object.' };
  }

  const m = raw as Fields;
  const invalid = { error: `Invalid ${String(m.type)} message.` };

  switch (m.type) {
    case 'hello':
      return isText(m.token) ? { type: 'hello', token: m.token } : invalid;
    case 'spawn':
      return isId(m.id) && isName(m.session) && isLabel(m.label) && isPath(m.file) && Array.isArray(m.args) && m.args.every(isText) && isPath(m.cwd) && isEnvironment(m.env) && isSize(m.cols) && isSize(m.rows)
        ? { type: 'spawn', id: m.id, session: m.session, label: m.label, file: m.file, args: m.args as string[], cwd: m.cwd, env: m.env, cols: m.cols, rows: m.rows }
        : invalid;
    case 'list':
    case 'watch':
    case 'shutdown':
      return isId(m.id) ? { type: m.type, id: m.id } : invalid;
    case 'kill':
    case 'screen':
      return isId(m.id) && isName(m.session) ? { type: m.type, id: m.id, session: m.session } : invalid;
    case 'attach':
      return isName(m.session) && isSize(m.cols) && isSize(m.rows) ? { type: 'attach', session: m.session, cols: m.cols, rows: m.rows } : invalid;
    case 'input':
      return isText(m.data) ? { type: 'input', data: m.data } : invalid;
    case 'resize':
      return isSize(m.cols) && isSize(m.rows) ? { type: 'resize', cols: m.cols, rows: m.rows } : invalid;
    default:
      return { error: `Unknown message type ${JSON.stringify(m.type)}.` };
  }
}

/** A host message, or null for anything that is not an object with a type; the client trusts the host it authenticated. */
export function parseHostMessage(line: string): HostMessage | null {
  try {
    const raw: unknown = JSON.parse(line);

    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && typeof (raw as Fields).type === 'string' ? (raw as HostMessage) : null;
  } catch {
    return null;
  }
}
