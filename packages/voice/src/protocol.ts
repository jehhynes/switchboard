import type { VoiceSettings } from '@switchboard/core/settings';

/** The voice protocol (architecture.md § Voice): JSON lines in UTF-8 over loopback TCP, the hub its only client. */
export const PROTOCOL = 1;
/** A longer line closes the connection. */
export const MAX_LINE_BYTES = 1024 * 1024;
export const HELLO_DEADLINE_MS = 5_000;

/** A session the voice can speak for: a `full` session with a connected scoped window. */
export interface VoiceTarget {
  sessionId: string;
  workItemId: number;
}

/** The focused scoped window's selected conversation's current session, or null while no scoped window has the focus. */
export type VoiceFocus = { sessionId: string; via: 'window' } | null;

/** What became of a reply's speech, as the voice process reports it. */
export type SpeechState = 'playing' | 'played' | 'interrupted' | 'skipped' | 'failed';

/** Why the voice target changed: the focus after its debounce, Talk here, or the target dropped (away timeout, or no longer a target). */
export type ActiveReason = 'focus' | 'talk-here' | 'gone';

export type HubMessage =
  | { type: 'hello'; token: string }
  | { type: 'targets'; targets: VoiceTarget[]; focus: VoiceFocus }
  | { type: 'talk-here'; sessionId: string }
  | { type: 'settings'; settings: VoiceSettings }
  /** A reply's passage to speak; `turn` names the message it answers, so the replies of one turn play in order (decision 24). */
  | { type: 'speak'; gen: number; replyId: string; sessionId: string; text: string; tone: string | null; turn: string | null }
  /** Stop or drop an offered reply: it was rewritten, or Speak replies was turned off; reported `skipped`. */
  | { type: 'cancel'; replyId: string }
  /** Stop speaking: the playing reply is `interrupted` where it stopped, and the queued ones `skipped`. */
  | { type: 'stop' }
  | { type: 'earcon'; kind: 'needs-you' }
  | { type: 'shutdown' };

export type VoiceMessage =
  | { type: 'welcome'; protocol: number; build: string; pid: number; features: string[] }
  | { type: 'error'; message: string }
  | { type: 'active'; gen: number; sessionId: string | null; reason: ActiveReason }
  | { type: 'speech'; gen: number; replyId: string; sessionId: string; state: SpeechState; atMs: number | null; said: number | null }
  | { type: 'progress'; gen: number; replyId: string; sessionId: string; chars: number; atMs: number }
  /** Playback's state: `mic` is `off` until capture (slice 10); `error` the last playback or speech failure, or null. */
  | { type: 'audio'; mic: 'off'; engine: string; device: string | null; error: string | null };

/** Splits a byte stream into lines; a line over the limit is an error, since the peer is not following the protocol. */
export class LineReader {
  #parts: Buffer[] = [];
  #length = 0;

  constructor(private readonly limit = MAX_LINE_BYTES) {}

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

export function encode(message: HubMessage | VoiceMessage): string {
  return JSON.stringify(message) + '\n';
}

type Fields = Record<string, unknown>;

const isText = (value: unknown): value is string => typeof value === 'string';
const isId = (value: unknown): value is string => isText(value) && value !== '' && value.length <= 200;
const isGen = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isObject = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A hub message, or why it is refused: malformed JSON, an unknown type or an invalid field. */
export function parseHubMessage(line: string): HubMessage | { error: string } {
  let raw: unknown;

  try {
    raw = JSON.parse(line);
  } catch {
    return { error: 'The message is not JSON.' };
  }

  if (!isObject(raw)) {
    return { error: 'The message is not an object.' };
  }

  const m = raw;
  const invalid = { error: `Invalid ${String(m.type)} message.` };

  switch (m.type) {
    case 'hello':
      return isText(m.token) ? { type: 'hello', token: m.token } : invalid;
    case 'targets': {
      const focus = m.focus;
      const targets = Array.isArray(m.targets) ? m.targets : null;

      if (targets === null || !targets.every((one) => isObject(one) && isId(one.sessionId) && Number.isInteger(one.workItemId))) {
        return invalid;
      }

      if (!(focus === null || (isObject(focus) && isId(focus.sessionId) && focus.via === 'window'))) {
        return invalid;
      }

      return {
        type: 'targets',
        targets: targets.map((one) => ({ sessionId: (one as Fields).sessionId as string, workItemId: (one as Fields).workItemId as number })),
        focus: focus === null ? null : { sessionId: (focus as Fields).sessionId as string, via: 'window' },
      };
    }
    case 'talk-here':
      return isId(m.sessionId) ? { type: 'talk-here', sessionId: m.sessionId } : invalid;
    case 'settings':
      return isObject(m.settings) ? { type: 'settings', settings: m.settings as unknown as VoiceSettings } : invalid;
    case 'speak':
      return isGen(m.gen) && isId(m.replyId) && isId(m.sessionId) && isText(m.text) && (m.tone === null || isText(m.tone)) && (m.turn === null || isId(m.turn))
        ? { type: 'speak', gen: m.gen, replyId: m.replyId, sessionId: m.sessionId, text: m.text, tone: m.tone, turn: m.turn }
        : invalid;
    case 'cancel':
      return isId(m.replyId) ? { type: 'cancel', replyId: m.replyId } : invalid;
    case 'stop':
    case 'shutdown':
      return { type: m.type };
    case 'earcon':
      return m.kind === 'needs-you' ? { type: 'earcon', kind: 'needs-you' } : invalid;
    default:
      return { error: `Unknown message type ${JSON.stringify(m.type)}.` };
  }
}

/** A voice message, or null for anything that is not an object with a type; the hub trusts the process it authenticated. */
export function parseVoiceMessage(line: string): VoiceMessage | null {
  try {
    const raw: unknown = JSON.parse(line);

    return isObject(raw) && typeof raw.type === 'string' ? (raw as VoiceMessage) : null;
  } catch {
    return null;
  }
}
