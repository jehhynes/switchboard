import { SPEECH_STYLES, TTS_VOICES } from '@switchboard/core/settings';
import type { SpeechStyle, TtsVoice, VoiceSettings } from '@switchboard/core/settings';

/** The voice protocol (architecture.md § Voice): JSON lines in UTF-8 over loopback TCP, the hub its only client. */
export const PROTOCOL = 1;
/** A longer line closes the connection. */
export const MAX_LINE_BYTES = 1024 * 1024;
export const HELLO_DEADLINE_MS = 5_000;

/** A session the voice can speak for: a `full` session with a connected scoped window, or whose terminal window the dock has seen in front. */
export interface VoiceTarget {
  sessionId: string;
  workItemId: number;
  /** The session's repository as `owner/name`, from its folder's `origin` remote, whose fixed terms the recogniser loads; null or left out with none. */
  repo?: string | null;
}

/** What capture is doing (architecture.md § Dictation), as the window's `VoiceView.mic` shows it. */
export const MIC_STATES = ['off', 'listening', 'hearing', 'typing', 'idle-off', 'paused-other-app', 'paused-by-voice', 'unavailable', 'starting'] as const;

export type MicState = (typeof MIC_STATES)[number];

/**
 * The focused scoped window's selected conversation's current session (`window`), or the session whose terminal window is in front
 * (`terminal`), or null while neither has the focus.
 */
export type VoiceFocus = { sessionId: string; via: 'window' | 'terminal' } | null;

/** What became of a reply's speech, as the voice process reports it. */
export type SpeechState = 'playing' | 'played' | 'interrupted' | 'skipped' | 'failed';

/** The reply an utterance spoke over: the part of its passage played before it stopped (`said`) and the part never played (`rest`). */
export interface Interrupted {
  replyId: string;
  said: string;
  rest: string;
}

/** A spoken command (architecture.md § Dictation): "stop listening" or "pause listening", and "start listening" or "resume listening". */
export type SpokenCommand = 'stop-listening' | 'start-listening';

/** What ended an utterance: the turn model's early close, or the end-of-message pause. */
export type EndedBy = 'turn model' | 'pause';

/**
 * When turn detection ended an utterance, in epoch milliseconds, for the hub's timing line of the message it sends: its last recognised word, the
 * end decision, and the end being sent, after the last piece's voice check.
 */
export interface UtteranceTiming {
  lastWordAt: number;
  decidedAt: number;
  endedAt: number;
  endedBy: EndedBy;
}

/** How long voiceprint enrolment records (voice-design § 3.2). */
export const ENROLL_SECONDS = 60;

/** Where voiceprint enrolment stands: recording, ended with a print saved, failed with why, or cancelled. */
export type EnrollmentState = 'recording' | 'enrolled' | 'failed' | 'cancelled';

/** Why the voice process turned the mic off on its own: the session locked, the computer went to sleep, or the session disconnected. */
export type AwayReason = 'locked' | 'asleep' | 'disconnected';

/** What a spoken alert is for (architecture.md § Spoken alerts): a turn finished, or the session waits on a question or a permission prompt. */
export const ALERT_CAUSES = ['turn-finished', 'question', 'permission'] as const;

export type AlertCause = (typeof ALERT_CAUSES)[number];

/** How a spoken alert ended: answered and read, not answered in time, refused by the answer, or dropped before or during its handshake. */
export type AlertOutcome = 'announced' | 'unanswered' | 'declined' | 'cancelled';

/** Why the voice target changed: the focus after its debounce, Talk here, or the target dropped (away timeout, or no longer a target). */
export type ActiveReason = 'focus' | 'talk-here' | 'gone';

export type HubMessage =
  | { type: 'hello'; token: string }
  | { type: 'targets'; targets: VoiceTarget[]; focus: VoiceFocus }
  | { type: 'talk-here'; sessionId: string }
  | { type: 'settings'; settings: VoiceSettings }
  /**
   * A reply's passage to speak; `turn` names the message it answers, so the replies of one turn play in order (decision 24). `voice`, `style`
   * and `personality` are the session's persona's, or the settings' (architecture.md § Personas).
   */
  | { type: 'speak'; gen: number; replyId: string; sessionId: string; text: string; tone: string | null; turn: string | null; voice: TtsVoice; style: SpeechStyle; personality: string | null }
  /** Stop or drop an offered reply: it was rewritten, or Speak replies was turned off; reported `skipped`. */
  | { type: 'cancel'; replyId: string }
  /** Stop speaking: the playing reply is `interrupted` where it stopped, and the queued ones `skipped`. */
  | { type: 'stop' }
  | { type: 'earcon'; kind: 'needs-you' }
  /**
   * A session that is not the voice target needs the operator (architecture.md § Spoken alerts): `title` is its work item's title, `persona`
   * its persona's name or null, `detail` what an answer reads, and `voice`, `style` and `personality` how it is spoken.
   */
  | { type: 'alert'; alertId: string; sessionId: string; cause: AlertCause; title: string; persona: string | null; detail: string; voice: TtsVoice; style: SpeechStyle; personality: string | null }
  /** The alert's cause was resolved: it is dropped, or its handshake ends. */
  | { type: 'alert-cancel'; alertId: string }
  /**
   * Capture on or off, as the operator set it (architecture.md § Dictation). `restore` marks the hub sending its mic again to a process it
   * connected to, which turns the mic on only if the process has not turned it off on its own since the operator last set it.
   */
  | { type: 'mic'; on: boolean; restore?: boolean }
  /** The here window's composer has the focus: recognition in flight is finished, nothing is sent, and listening pauses until it is off. */
  | { type: 'typing'; on: boolean }
  /** The target's latest reply, which the turn model reads with the operator's words. */
  | { type: 'context'; sessionId: string; lastReply: string }
  /** A reply's heard tag, for the glossary. */
  | { type: 'heard'; heard: string; meant: string }
  /** Voiceprint enrolment: record `ENROLL_SECONDS` of the operator's speech and save the print, or stop recording and save nothing. */
  | { type: 'enroll'; action: 'start' | 'cancel' }
  /**
   * Where the voice's microphone and speaker are (architecture.md § Remote access, Voice on a phone): this computer's, a paired phone's, or
   * none, after the phone that had the voice left, when nothing plays or listens until the operator moves it.
   */
  | { type: 'device'; device: VoiceDevice }
  /** The phone's report for one of its playbacks: the milliseconds heard, and `done` once everything sent before its end played. */
  | { type: 'phone-played'; id: number; ms: number; done: boolean }
  | { type: 'shutdown' };

/** Where the voice's microphone and speaker are. */
export type VoiceDevice = 'computer' | 'phone' | 'none';

export type VoiceMessage =
  | { type: 'welcome'; protocol: number; build: string; pid: number; features: string[] }
  | { type: 'error'; message: string }
  | { type: 'active'; gen: number; sessionId: string | null; reason: ActiveReason }
  | { type: 'speech'; gen: number; replyId: string; sessionId: string; state: SpeechState; atMs: number | null; said: number | null }
  | { type: 'progress'; gen: number; replyId: string; sessionId: string; chars: number; atMs: number }
  /**
   * Capture's state and the last capture, playback or speech failure, or null; `device` the capture device in use, or null; `recognizer` where
   * speech recognition runs, or null before the recogniser loads. `halfDuplex`, only while the open capture has no working echo cancellation,
   * says why, and listening then pauses while the voice plays. `roomHold`, only during a room hold, is when it ends (epoch milliseconds): the voice
   * check heard someone else, so dictated turns are not to be sent on their own until then. `fullDuplex`, only while the open capture has no
   * working echo cancellation and listens anyway, says why, such as "echo check: none heard" (architecture.md § Dictation).
   */
  | { type: 'audio'; mic: MicState; engine: string; device: string | null; recognizer: 'gpu' | 'cpu' | null; error: string | null; halfDuplex?: string; fullDuplex?: string; roomHold?: number }
  /** The live words of an utterance, not settled yet; empty once they settled or were dropped. */
  | { type: 'words'; gen: number; utteranceId: string; sessionId: string; text: string }
  /** A piece of an utterance settled, with its voice check: its match score and median pitch (null when not judged), and whether it failed. */
  | { type: 'piece'; gen: number; utteranceId: string; sessionId: string; pieceId: string; text: string; score: number | null; f0: number | null; dropped: boolean }
  /**
   * An utterance ended: `final` when turn detection ended it, so the hub may send it; false when it was cut off (the composer took the focus,
   * the mic went off, another app started recording, the voice moved), so the hub sends nothing. `text` is its kept pieces' words; `interrupted`
   * the reply it spoke over (barge-in), or null; `timing`, when turn detection ended it, when its steps happened.
   */
  | { type: 'utterance'; gen: number; utteranceId: string; sessionId: string; text: string; final: boolean; interrupted: Interrupted | null; timing?: UtteranceTiming }
  /**
   * A spoken command was heard alone, as a whole utterance that passed the voice check, and done; it goes to no session. `sessionId` is the
   * voice target then, or null; `utteranceId` the utterance it was, or null when heard while listening was paused by voice.
   */
  | { type: 'command'; command: SpokenCommand; text: string; sessionId: string | null; utteranceId: string | null; score: number | null; f0: number | null }
  /** Voiceprint enrolment changed state; `error` says why it failed. */
  | { type: 'enrollment'; state: EnrollmentState; error: string | null }
  /**
   * The operator left the computer, so the process turned the mic off and stopped speech; the mic stays off until the operator turns it on, and
   * a `mic {on: true}` while they are still away is answered with this again (architecture.md § Dictation).
   */
  | { type: 'mic-off'; reason: AwayReason }
  /** A spoken alert ended. */
  | { type: 'alert-done'; alertId: string; sessionId: string; outcome: AlertOutcome }
  /** A playback on the phone opens, its 24 kHz PCM follows in base64 pieces, its end is sent, or it is flushed at once (Voice on a phone). */
  | { type: 'phone-play'; id: number }
  | { type: 'phone-pcm'; id: number; pcm: string }
  | { type: 'phone-end'; id: number }
  | { type: 'phone-flush'; id: number }
  /** The phone stopped reporting what it played for longer than `PHONE_STALL_MS`, so the hub closes its socket. */
  | { type: 'phone-stalled'; reason: string };

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

      if (targets === null || !targets.every((one) => isObject(one) && isId(one.sessionId) && Number.isInteger(one.workItemId) && (one.repo === undefined || one.repo === null || isId(one.repo)))) {
        return invalid;
      }

      if (!(focus === null || (isObject(focus) && isId(focus.sessionId) && (focus.via === 'window' || focus.via === 'terminal')))) {
        return invalid;
      }

      return {
        type: 'targets',
        targets: targets.map((one) => ({ sessionId: (one as Fields).sessionId as string, workItemId: (one as Fields).workItemId as number, repo: ((one as Fields).repo as string | null | undefined) ?? null })),
        focus: focus === null ? null : { sessionId: (focus as Fields).sessionId as string, via: (focus as Fields).via as 'window' | 'terminal' },
      };
    }
    case 'talk-here':
      return isId(m.sessionId) ? { type: 'talk-here', sessionId: m.sessionId } : invalid;
    case 'settings':
      return isObject(m.settings) ? { type: 'settings', settings: m.settings as unknown as VoiceSettings } : invalid;
    case 'speak':
      return isGen(m.gen) &&
        isId(m.replyId) &&
        isId(m.sessionId) &&
        isText(m.text) &&
        (m.tone === null || isText(m.tone)) &&
        (m.turn === null || isId(m.turn)) &&
        (TTS_VOICES as readonly unknown[]).includes(m.voice) &&
        (SPEECH_STYLES as readonly unknown[]).includes(m.style) &&
        (m.personality === null || isText(m.personality))
        ? { type: 'speak', gen: m.gen, replyId: m.replyId, sessionId: m.sessionId, text: m.text, tone: m.tone, turn: m.turn, voice: m.voice as TtsVoice, style: m.style as SpeechStyle, personality: m.personality }
        : invalid;
    case 'cancel':
      return isId(m.replyId) ? { type: 'cancel', replyId: m.replyId } : invalid;
    case 'stop':
    case 'shutdown':
      return { type: m.type };
    case 'earcon':
      return m.kind === 'needs-you' ? { type: 'earcon', kind: 'needs-you' } : invalid;
    case 'alert':
      return isId(m.alertId) &&
        isId(m.sessionId) &&
        (ALERT_CAUSES as readonly unknown[]).includes(m.cause) &&
        isText(m.title) &&
        (m.persona === null || isText(m.persona)) &&
        isText(m.detail) &&
        (TTS_VOICES as readonly unknown[]).includes(m.voice) &&
        (SPEECH_STYLES as readonly unknown[]).includes(m.style) &&
        (m.personality === null || isText(m.personality))
        ? { type: 'alert', alertId: m.alertId, sessionId: m.sessionId, cause: m.cause as AlertCause, title: m.title, persona: m.persona, detail: m.detail, voice: m.voice as TtsVoice, style: m.style as SpeechStyle, personality: m.personality }
        : invalid;
    case 'alert-cancel':
      return isId(m.alertId) ? { type: 'alert-cancel', alertId: m.alertId } : invalid;
    case 'mic':
      return typeof m.on === 'boolean' && (m.restore === undefined || typeof m.restore === 'boolean') ? { type: 'mic', on: m.on, ...(m.restore === true ? { restore: true } : {}) } : invalid;
    case 'typing':
      return typeof m.on === 'boolean' ? { type: 'typing', on: m.on } : invalid;
    case 'context':
      return isId(m.sessionId) && isText(m.lastReply) ? { type: 'context', sessionId: m.sessionId, lastReply: m.lastReply } : invalid;
    case 'enroll':
      return m.action === 'start' || m.action === 'cancel' ? { type: 'enroll', action: m.action } : invalid;
    case 'device':
      return m.device === 'computer' || m.device === 'phone' || m.device === 'none' ? { type: 'device', device: m.device } : invalid;
    case 'phone-played':
      return isGen(m.id) && typeof m.ms === 'number' && Number.isFinite(m.ms) && m.ms >= 0 && typeof m.done === 'boolean' ? { type: 'phone-played', id: m.id, ms: m.ms, done: m.done } : invalid;
    case 'heard':
      return isText(m.heard) && isText(m.meant) && m.heard.trim() !== '' && m.meant.trim() !== '' && m.heard.length <= 200 && m.meant.length <= 200 ? { type: 'heard', heard: m.heard, meant: m.meant } : invalid;
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
