import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationMessage, ConversationReply, Interruption, Persona, Piece, Session, SpokenState, ViewSettings, VoiceSettings } from '@switchboard/core';
import { PERMISSION_PROMPT, QUESTION_CARD, START_PROMPT } from '@switchboard/core/group';
import { spokenText } from '@switchboard/conversation';
import type { HeardTag } from '@switchboard/conversation';
import { ENROLL_SECONDS } from '@switchboard/voice';
import type { AlertCause, AwayReason, EnrollmentState, HubMessage, MicState, UtteranceTiming, VoiceDevice, VoiceMessage, VoiceTarget } from '@switchboard/voice';
import type { VoiceConnection } from './voiceLink.js';
import type { WindowScope } from './windows.js';

/** A window's voice state (architecture.md § Voice): only whether the voice is here and what its own session's speech is doing. */
export interface VoiceView {
  enabled: boolean;
  /** This window's selected conversation's session is the voice target; a window never learns where else the voice is. */
  here: boolean;
  /** What capture is doing for this window: `off` in a window that is not here (architecture.md § Dictation). */
  mic: MicState;
  /** The reply of this window's session playing now, or null. */
  speaking: string | null;
  speakReplies: boolean;
  /** Why capture cannot run, while the mic is `unavailable` here; playback and speech errors are the voice's, which the dock shows. */
  error: string | null;
  /**
   * Only while the voice is here and its capture cancels no echo: why, such as "no echo cancellation on Remote Audio". Listening then pauses
   * while the voice plays, and talking over a reply does not stop it (architecture.md § Dictation).
   */
  halfDuplex?: string;
  /** Where speech recognition runs, here once the recogniser loaded, else null (architecture.md § Dictation). */
  recognizer: 'gpu' | 'cpu' | null;
  /** Only while the voice is here and a room hold runs: dictated turns stay in the composer (architecture.md § Voice check and barge-in). */
  roomHold?: true;
  /**
   * Only in a window or page on this computer while the voice is here and no device has it, after the phone left: nothing plays or listens
   * until Talk here, the mic or a typed message takes it back (PRD R119).
   */
  deviceOff?: true;
  /** Only while the voice is here and its capture cancels no echo but listens anyway: why, such as "echo check: none heard"; talking over a reply then stops it. */
  fullDuplex?: string;
}

/** Why the voice process turned the mic off, as the hub's log says it. */
const MIC_OFF_TEXT: Record<AwayReason, string> = { locked: 'computer locked', asleep: 'computer going to sleep', disconnected: 'session disconnected' };

/** What the composer shows when a dictated turn is held, while the room hold runs and after it. */
export const HELD_NOTE = 'Dictation is waiting while another voice is detected. Press Enter to send it.';
export const HELD_AFTER_NOTE = 'Dictation is still waiting after another voice was detected. Press Enter to send it.';

/** The key dictation uses for the target's session terminal window, which no window key can equal (architecture.md § Voice). */
const TERMINAL = '\0terminal';

/** A composer's name: a window's draft belongs to one conversation, so a switch never carries it to another session. */
const composerKey = (key: string, sessionId: string): string => `${key}|${sessionId}`;

/** How often a long dictated message still being spoken goes as a `[partial]` while its session works (claude-collab `FRAGMENT_FLUSH_MS`). */
export const FRAGMENT_FLUSH_MS = 10_000;
/** How often open utterances are checked for a `[partial]`. */
const FLUSH_CHECK_MS = 1_000;

/** A window's composer as the hub keeps it for the focus rule (architecture.md § Dictation): its text, its focus, and the dictation in it. */
interface Composer {
  focused: boolean;
  draft: string;
  /** The pieces dictated into the draft since it was last sent or emptied; empty while it holds no dictation. */
  pieces: Piece[];
  /** The reply the dictation in the draft spoke over, which the message that sends it names; null with none. */
  interrupted: Interruption | null;
  /** A room hold kept a spoken turn in the draft: no turn's end or `[partial]` sends it until the operator sends or empties it. */
  held: boolean;
}

/**
 * Voiceprint enrolment as the dock's Voice page shows it (architecture.md § Voice check and barge-in): `idle` before any this run, `starting`
 * while the voice process starts, `recording` until `endsAt`, then how it ended; `enrolledAt` when the saved voiceprint was made, or null.
 */
export interface EnrollmentView {
  state: 'idle' | 'starting' | EnrollmentState;
  endsAt: number | null;
  error: string | null;
  enrolledAt: string | null;
}

/** An utterance the voice process is hearing, and the window whose draft it goes into. */
interface Heard {
  key: string;
  sessionId: string;
  gen: number;
  startedAt: number;
  /** When it last went as a `[partial]`, or null. */
  flushedAt: number | null;
}

/** What one line of the fragments log records (architecture.md § Dictation). */
export interface Fragment {
  event: 'heard' | 'dropped' | 'submitted' | 'sent' | 'not-sent' | 'refused' | 'held' | 'command';
  sessionId: string;
  utteranceId: string | null;
  pieceId: string | null;
  messageId: string | null;
  text: string;
  score?: number | null;
  f0?: number | null;
  error?: string | null;
}

/** How many dictated messages' voice steps are kept for their timing lines. */
const TIMINGS_KEPT = 50;
/** How long the voice process runs on after the last demand ends. */
export const VOICE_LINGER_MS = 10 * 60_000;
/** A crashed voice process is started again at most this often. */
export const VOICE_RESTART_MS = 60_000;
/** What a dock row click answers when its session has no window to talk to. */
export const OPEN_ITS_WINDOW = 'Open a window for this session to use voice.';
/** The mic codicon in codicon.ttf, which marks the voice target's dock row while the mic is on (architecture.md § Voice). */
export const VOICE_GLYPH = '\u{ec12}';
/** The speaker codicon (`unmute`), which marks the voice target's row while the mic is off: the voice speaks there, but nothing listens. */
export const SPEAKER_GLYPH = '\u{eb75}';

/** The voice target's row mark: the mic while the mic is on, else the speaker, with where the voice is in its tooltip. */
export function voiceMark(micLive: boolean, onPhone: boolean): { glyph: string; title: string } {
  const where = onPhone ? 'Voice is on a paired device for this session' : 'Voice is set to this session';

  return micLive ? { glyph: VOICE_GLYPH, title: `${where}. Mic on.` } : { glyph: SPEAKER_GLYPH, title: `${where}. Mic off.` };
}
/** Why a dock click leaves the voice where it is while the phone has it. */
export const PHONE_HAS_VOICE = 'Voice is on a paired device. Select Talk here in the session\'s window to use it on this computer.';
/** How long after a session's change an alert for it is sent, so the transcript has given the turn's last reply and a passing state is not called out. */
export const ALERT_DELAY_MS = 1_500;
/** The longest detail an alert reads, cut at a sentence. */
export const ALERT_DETAIL_MAX = 400;

/** What a live session is doing, as spoken alerts read it (architecture.md § Spoken alerts). */
export type AlertKind = 'running' | 'idle' | 'question' | 'permission' | 'other';

/** A live `full` session's kind, for its alert transitions. */
export interface AlertSession {
  sessionId: string;
  workItemId: number;
  kind: AlertKind;
}

/** A session's kind: in a turn, idle after one, waiting on a question (a menu or an unanswered question card) or a permission prompt, or else. */
export function alertKind(session: Pick<Session, 'state' | 'stateDetail'>): AlertKind {
  switch (session.state) {
    case 'starting':
    case 'running':
      return 'running';
    case 'idle':
      return session.stateDetail === QUESTION_CARD ? 'question' : 'idle';
    case 'waiting':
      return session.stateDetail === PERMISSION_PROMPT ? 'permission' : session.stateDetail === START_PROMPT ? 'other' : 'question';
    default:
      return 'other';
  }
}

/**
 * What an answered alert reads: a permission prompt or a question menu waits in the session's terminal, which the hub cannot read; otherwise the
 * latest reply's primary response, else its text, else the latest status, as speech without Markdown, cut at a sentence to `ALERT_DETAIL_MAX`.
 */
export function alertDetail(cause: AlertCause, inTerminal: boolean, reply: { speak: string | null; opening: string } | null, status: string | null, questions: { count: number; first: string } | null = null): string {
  const base = alertText(cause, inTerminal, reply, status);

  // A session idle on open questions reads its passage, then how many questions it has and the current one only (design § 7).
  return questions === null || questions.count === 0 || cause === 'permission' || inTerminal ? base : `${base} It has ${questions.count === 1 ? 'one question' : `${questions.count} questions`}; ${questions.count === 1 ? 'it is' : 'the first'}: ${questions.first}`;
}

function alertText(cause: AlertCause, inTerminal: boolean, reply: { speak: string | null; opening: string } | null, status: string | null): string {
  if (cause === 'permission') {
    return 'It is waiting for your permission in its terminal.';
  }

  if (cause === 'question' && inTerminal) {
    return 'It is waiting for your answer in its terminal.';
  }

  const text = spokenText(reply?.speak ?? (reply !== null && reply.opening.trim() !== '' ? reply.opening : (status ?? '')))
    .replace(/\s+/g, ' ')
    .trim();

  if (text === '') {
    return cause === 'question' ? 'It is waiting for your answer.' : 'It has no reply to read.';
  }

  if (text.length <= ALERT_DETAIL_MAX) {
    return text;
  }

  const head = text.slice(0, ALERT_DETAIL_MAX);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));

  return sentence >= ALERT_DETAIL_MAX / 4 ? head.slice(0, sentence + 1) : `${head.slice(0, head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : ALERT_DETAIL_MAX)}…`;
}

export interface VoiceControlDeps {
  link: { find(): Promise<VoiceConnection | { error: string }>; connected(): VoiceConnection | null; stop(): void };
  settings(): VoiceSettings;
  /** The settings windows and pages read, sent to each when the settings are reloaded; `expandReplies` alone when left out. */
  viewSettings?(): ViewSettings;
  store: {
    reply(id: string): ConversationReply | null;
    updateReply(id: string, patch: Partial<Pick<ConversationReply, 'spokenState' | 'spokenAtMs' | 'saidChars'>>): void;
    message(id: string): { spokenRequested?: boolean } | null;
    markSeen(sessionId: string, ids: string[], at: number): unknown;
  };
  /** The connected windows' keys and scopes. */
  windows: { keys(): string[]; scope(key: string): WindowScope | null };
  /** The key of the focused window, or null. */
  focusedWindow(): string | null;
  /** Whether the session is a live, observed Code Mode session (`full`), the only kind the voice speaks for. */
  full(sessionId: string): boolean;
  /** A session's work item and folder, for a session whose terminal window counts as a target; null for one the store does not have. */
  session?(sessionId: string): { workItemId: number; cwd: string | null } | null;
  /** The session's persona, whose voice, style and personality its replies are spoken with; null for the settings' (architecture.md § Personas). */
  persona?(sessionId: string): Persona | null;
  /** A spoken alert's title, its work item's, and the detail an answer reads (`alertDetail`); null for a session the store does not have. */
  alertText?(sessionId: string, cause: AlertCause): { title: string; detail: string } | null;
  /**
   * The current question of a reply's open card as speech (design § 7), offered after the reply's passage: its speak item's ID,
   * `card:<reply ID>#<slug>`, and text; null when the reply has no open question.
   */
  cardSpeech?(sessionId: string, replyId: string): { id: string; text: string } | null;
  /**
   * Applies a whole utterance to the session's open card when it matches the card grammar (design § 7): what to say back, or null for ordinary
   * dictation, which is sent as a message.
   */
  cardUtterance?(key: string, sessionId: string, text: string): { say: string } | null;
  /** Whether the session is in a turn, when a long dictated message goes in `[partial]` parts. */
  busy?(sessionId: string): boolean;
  /** The text of the session's latest reply, which the turn model reads; null with none. */
  lastReply?(sessionId: string): string | null;
  /** The `owner/name` of the repository a folder belongs to, from its `origin` remote, or null. */
  originRepo?(cwd: string): Promise<string | null>;
  /**
   * Types dictated text into the window's selected conversation's session, or with a null key into the session through its terminal, as a
   * `[voice]` message, or a `[partial]` part (architecture.md § Dictation): the message, or why it was refused.
   */
  dictate?(key: string | null, sessionId: string, text: string, pieces: Piece[], partial: boolean, interrupted?: Interruption | null): { message: ConversationMessage } | { refused: string };
  /** When the saved voiceprint was made, from `<home>/voice/voiceprint.json`, or null. */
  enrolledAt?(): string | null;
  /** Where the fragments log goes, `<home>/voice`; none when left out. */
  fragmentsDir?: string;
  /** A reply's speech changed; the windows showing its session get it again. */
  replyChanged(replyId: string): void;
  /** Sends a window's stream an event. */
  notify(key: string, type: string, payload: Record<string, unknown>): void;
  /** The voice target or the dock's voice problem changed, so the dock view is built again. */
  dockChanged(): void;
  now(): number;
  log(line: string): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
  every?(run: () => void, ms: number): { stop(): void };
  /** The voice socket of the paired phone that holds it (architecture.md § Remote access, Voice on a phone); without it the voice stays on this computer. */
  phone?: { send(message: Record<string, unknown>): boolean; sendBinary(data: Buffer): boolean; close(reason: string): void };
  /** Whether a page reported that it has the focus and is visible. */
  pageFocused?(key: string): boolean;
  /** Whether a page key is a paired device's page, which never takes the voice to this computer. */
  remotePage?(key: string): boolean;
  /** The session's latest replies that came at or after `since`, for a hub that took over to offer those neither hub offered. */
  repliesSince?(sessionId: string, since: number): ConversationReply[];
}

/** The first byte of a binary frame the hub sends the phone: a playback's 24 kHz PCM, after its playback number (Voice on a phone). */
export const PHONE_PCM_FRAME = 1;
/** The first byte of a binary frame the phone sends: its microphone's 16 kHz PCM (Voice on a phone). */
export const PHONE_MIC_FRAME = 2;
/** Why a paired device's page cannot turn on this computer's microphone. */
export const PHONE_MIC_HERE = 'Select Voice on this device before turning on the mic.';
/** How long a hub that took over waits for the phone that had the voice to take it back, before the voice is off (architecture.md § Hub lifecycle). */
export const PHONE_RESUME_MS = 30_000;
/** Why a phone's page that asks to take the voice back after a hub restart is refused. */
export const NOT_RESUMED = 'Voice did not resume after Switchboard restarted. Select Voice on this device to start it here.';

/**
 * The voice's state a restarting hub hands to the hub that takes over, in `hub-handover.json` (architecture.md § Hub lifecycle): the device and
 * the paired device's sign-in (`phoneHash`) that holds it, the target, Speak replies and the mic, so the restart changes none of them.
 */
export interface VoiceHandover {
  device: VoiceDevice;
  phoneHash: string | null;
  target: { gen: number; sessionId: string | null };
  speakReplies: boolean;
  micOn: boolean;
  mic: MicState;
  phoneCapture: boolean;
  phoneBusy: boolean;
  /** When it was handed over: a reply that came after it was offered by neither hub, so the hub that takes over offers it. */
  at: number;
  /** The replies that asked to be heard and waited for the voice, which the hub that takes over offers. */
  held: string[];
  /** With no device: whether the phone was lost rather than left by the operator (`VoiceControl.phoneLost`); absent from an older hub's. */
  phoneLost?: boolean;
}

/** How long before the handover a reply may have come and still not been offered by the hub that handed over, which saw it too late. */
const HANDOVER_REPLY_MARGIN_MS = 60_000;

/** A handed-over voice state read from the handover file, or null for anything malformed. */
export function parseVoiceHandover(raw: unknown): VoiceHandover | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const one = raw as Record<string, unknown>;
  const target = one['target'] as Record<string, unknown> | null | undefined;
  const device = one['device'];
  const hash = one['phoneHash'];

  if (
    (device !== 'computer' && device !== 'phone' && device !== 'none') ||
    (hash !== null && typeof hash !== 'string') ||
    typeof target !== 'object' ||
    target === null ||
    typeof target['gen'] !== 'number' ||
    !Number.isSafeInteger(target['gen']) ||
    (target['sessionId'] !== null && typeof target['sessionId'] !== 'string') ||
    typeof one['speakReplies'] !== 'boolean' ||
    typeof one['micOn'] !== 'boolean' ||
    typeof one['mic'] !== 'string' ||
    typeof one['phoneCapture'] !== 'boolean' ||
    typeof one['phoneBusy'] !== 'boolean' ||
    typeof one['at'] !== 'number' ||
    !Array.isArray(one['held']) ||
    !(one['held'] as unknown[]).every((id) => typeof id === 'string')
  ) {
    return null;
  }

  return {
    device,
    phoneHash: hash,
    target: { gen: target['gen'], sessionId: target['sessionId'] as string | null },
    speakReplies: one['speakReplies'],
    micOn: one['micOn'],
    mic: one['mic'] as MicState,
    phoneCapture: one['phoneCapture'],
    phoneBusy: one['phoneBusy'],
    at: one['at'],
    held: one['held'] as string[],
    ...(one['phoneLost'] === true ? { phoneLost: true } : {}),
  };
}

interface Offered {
  gen: number;
  sessionId: string;
  /** The voice it was offered in, for the log. */
  voice: string;
  /** How far it played, from its last progress or speech report, for the log. */
  atMs: number | null;
  said: number | null;
}

const FINAL: ReadonlySet<SpokenState> = new Set(['played', 'interrupted', 'skipped', 'stopped-moved', 'failed']);

/**
 * The hub's side of voice (architecture.md § Voice): it starts the voice process on demand and supervises it through `VoiceLink`, sends it
 * the eligible targets and the focus, offers it the replies that asked to be heard, records what became of their speech, and tells each window
 * only whether the voice is here. The voice process decides the target; the hub mirrors it.
 */
export class VoiceControl {
  /** The runtime toggle, one per machine; on until turned off. */
  speakReplies = true;
  #target: { gen: number; sessionId: string | null } = { gen: 0, sessionId: null };
  #client: VoiceConnection | null = null;
  #starting = false;
  #lastStart = -Infinity;
  #restart: unknown = null;
  #linger: unknown = null;
  /** Why the voice process cannot run, or its last playback error, for the dock. */
  #processError: string | null = null;
  #audioError: string | null = null;
  readonly #offered = new Map<string, Offered>();
  /** The reply playing now, by session. */
  readonly #playing = new Map<string, string>();
  #targetsSent = '';
  readonly #viewSent = new Map<string, string>();
  #closed = false;
  /** The mic as the operator set it, one per machine; the process gets it after each start. */
  #micOn = false;
  /** When Mic on was asked and from where, until the voice process says the mic listens or cannot, for the hub log's timing line. */
  #micAsked: { at: number; from: string } | null = null;
  /** What capture is doing, as the process last said. */
  #mic: MicState = 'off';
  /** Why the open capture cancels no echo, as the process last said; null while it does or nothing captures. */
  #halfDuplex: string | null = null;
  /** Where speech recognition runs, as the process last said. */
  #recognizer: 'gpu' | 'cpu' | null = null;
  /** When the room hold ends, as the process last said; null with none. */
  #roomHoldUntil: number | null = null;
  /** Why the open capture listens while the voice plays though it cancels no echo, as the process last said; null otherwise. */
  #fullDuplex: string | null = null;
  readonly #composers = new Map<string, Composer>();
  readonly #heard = new Map<string, Heard>();
  /** A dictated message's steps before it was queued for typing, by message ID, until its timing line is written. */
  readonly #timings = new Map<string, UtteranceTiming & { receivedAt: number }>();
  /** The window the voice last moved to by its own command, which hears dictation when no focused window shows the target. */
  #talkedFrom: string | null = null;
  #typingSent: boolean | null = null;
  readonly #contextSent = new Map<string, string>();
  readonly #repos = new Map<string, string | null | 'pending'>();
  #flushTimer: { stop(): void } | null = null;
  /** The session whose terminal window the dock last reported in front, or null (architecture.md § Voice). */
  #terminalFocus: string | null = null;
  /** When the latest focus change the terminal focus heeded happened, by the reporter's clock, so a late report cannot undo a newer one. */
  #focusAt = -Infinity;
  /** The live sessions whose terminal window the dock has reported in front, which stay targets while the focus is in another app. */
  readonly #terminals = new Set<string>();
  #enrollment: Omit<EnrollmentView, 'enrolledAt'> = { state: 'idle', endsAt: null, error: null };
  /** Each live `full` session's kind as last seen, for its alert transitions (architecture.md § Spoken alerts). */
  readonly #alertKinds = new Map<string, AlertKind>();
  /** The alert of each session waiting to be sent or sent and not ended, with the kind it was for. */
  readonly #alerts = new Map<string, { alertId: string; kind: AlertKind; timer: unknown }>();
  #alertCount = 0;
  /** Where the voice's microphone and speaker are, and the page key of the phone that has it (PRD R119). */
  #device: VoiceDevice = 'computer';
  #phoneKey: string | null = null;
  /** With no device, whether the phone was lost rather than left by the operator (`phoneLost`). */
  #phoneWasLost = false;
  /** The phone's page said it leaves by the operator's choice, said it is hidden, or stopped playing, for how its close counts (`phoneClosed`). */
  #phoneLeaving = false;
  #phoneHidden = false;
  #phoneStalled = false;
  /**
   * Whether this hub has chosen the device itself: a move, or an action on this computer that takes the voice back. Until then, a voice process
   * that greets it with another device keeps the voice off; after, the hub's own device wins.
   */
  #deviceChosen = false;
  /** The mic state the rows' mark last showed (`micLive`). */
  #micLiveShown = false;
  /** Whether the voice process has the phone's capture open, so the phone's audio is relayed. */
  #phoneCapture = false;
  /** Whether the phone's microphone cannot be heard, as its page last said, for a voice process started again. */
  #phoneBusy = true;
  /** The sign-in (`VoiceDevice.hash`) of the paired device whose page holds the voice, which alone may take it back after a hub restart. */
  #phoneHash: string | null = null;
  /** After a hub restart that took over the voice on a phone: the phone that may take it back without a tap, until the timer turns the voice off. */
  #resume: { hash: string; timer: unknown } | null = null;
  /** Replies that asked to be heard while the phone had not taken the voice back yet, offered once it did, or the wait ended. */
  readonly #heldReplies = new Set<string>();
  /** After a hub restart: the target the hub before handed over, a target while no page or window shows it, until the phone's page shows a conversation or the voice moves. */
  #carried: string | null = null;
  /** After a hub restart: when the hub before handed over, so the replies that came since are offered once the voice can take them. */
  #handedAt: number | null = null;
  /** The voice process's connection after the hub handed over, which only `close` uses: nothing more is sent to it. */
  #handedOver: VoiceConnection | null = null;

  constructor(private readonly deps: VoiceControlDeps) {}

  /** Where the voice's microphone and speaker are: this computer, a paired phone, or none after the phone left. */
  get device(): VoiceDevice {
    return this.#device;
  }

  /**
   * Whether no device has the voice because the phone was lost, which the dock and the page note (PRD R119): its connection dropped or stalled,
   * or it did not come back after a hub restart. False after the operator's own Voice off, a hidden or closed page, or a refusal for a sign-out,
   * a forbidden device or voice turned off, since the operator chose those.
   */
  get phoneLost(): boolean {
    return this.#device === 'none' && this.#phoneWasLost;
  }

  /**
   * A paired phone's page took the voice with its tap (PRD R119): the voice moves to its speaker, and to the conversation it shows, as Talk
   * here there would move it.
   */
  phoneOpened(key: string, hash: string | null = null): void {
    this.#phoneLeaving = false;
    this.#phoneHidden = false;
    this.#phoneStalled = false;

    // After a hub restart the phone that had the voice takes it back as it was, its mic and capture too, with nothing played or heard
    // elsewhere meanwhile (architecture.md § Hub lifecycle).
    if (this.#resume !== null && hash !== null && hash === this.#resume.hash && this.#device === 'phone') {
      this.#endResume();
      this.#phoneKey = key;
      this.deps.log('voice: device phone: the phone took the voice back after the hub restart');

      if (this.#phoneCapture) {
        this.deps.phone?.send({ type: 'capture', on: true });
      }

      if (this.#target.sessionId === null && this.deps.windows.scope(key)?.sessionId != null) {
        this.talkHere(key);
      }

      this.#targetsSent = '';
      this.viewsChanged();
      this.deps.dockChanged();
      this.update();
      this.#offerHeld();
      return;
    }

    this.#endResume();
    this.#carried = null;

    // Another phone's page taking over is a move: what played on the first stops before anything plays on this one.
    if (this.#device === 'phone' && this.#phoneKey !== key) {
      this.#setDevice('none', 'another phone takes the voice');
    }

    this.#phoneKey = key;
    this.#phoneHash = hash;
    this.#setDevice('phone', 'a paired phone took the voice');

    if (this.deps.windows.scope(key)?.sessionId != null) {
      this.talkHere(key);
    }

    this.update();
    this.#offerHeld();
  }

  /**
   * Whether a phone's page may take the voice back without a tap after a hub restart: only the paired device that had it, while this hub waits
   * for it (`PHONE_RESUME_MS`). Why not, or null.
   */
  resumable(hash: string): string | null {
    return !this.#closed && this.#resume !== null && this.#resume.hash === hash ? null : NOT_RESUMED;
  }

  /**
   * The hub hands over to the hub that takes over (architecture.md § Hub lifecycle): what the voice is doing goes to that hub, and from now on this
   * hub sends the voice process nothing, so neither the phone's socket closing nor the windows leaving move the voice, its target or its mic.
   */
  handOver(): VoiceHandover {
    const state = this.handoverState();

    this.#handedOver = this.#client;
    this.#client = null;
    this.#closed = true;
    this.#endResume();
    this.#stopFlush();
    this.#clear('linger');
    this.#clear('restart');
    this.deps.log(`voice: handed over: device ${state.device}, target ${state.target.sessionId ?? 'none'}, generation ${state.target.gen}, mic ${state.micOn ? 'on' : 'off'}`);
    return state;
  }

  /** What `handOver` hands over, changing nothing, so the handover file is written before this hub lets go of the voice. */
  handoverState(): VoiceHandover {
    return {
      device: this.#device,
      phoneHash: this.#device === 'phone' ? (this.#resume?.hash ?? this.#phoneHash) : null,
      target: { ...this.#target },
      speakReplies: this.speakReplies,
      micOn: this.#micOn,
      mic: this.#mic,
      phoneCapture: this.#phoneCapture,
      phoneBusy: this.#phoneBusy,
      at: this.deps.now(),
      held: [...this.#heldReplies],
      ...(this.phoneLost ? { phoneLost: true } : {}),
    };
  }

  /**
   * In a hub that took over (architecture.md § Hub lifecycle): the voice as the hub before it handed it over. A phone that had the voice keeps it
   * while this hub waits `PHONE_RESUME_MS` for its page to take it back; the voice is off after that, never on this computer's speakers.
   */
  restore(raw: unknown): void {
    const state = parseVoiceHandover(raw);

    if (state === null) {
      return;
    }

    this.speakReplies = state.speakReplies;
    this.#target = { ...state.target };
    this.#carried = state.target.sessionId;
    this.#handedAt = state.at;

    for (const id of state.held) {
      this.#heldReplies.add(id);
    }
    this.#micOn = state.micOn;
    this.#mic = state.mic;

    if (state.device === 'phone' && state.phoneHash !== null) {
      this.#device = 'phone';
      this.#deviceChosen = true;
      this.#phoneHash = state.phoneHash;
      this.#phoneCapture = state.phoneCapture;
      this.#phoneBusy = state.phoneBusy;
      this.#resume = { hash: state.phoneHash, timer: this.#timer(() => this.#resumeEnded(), PHONE_RESUME_MS) };
      this.deps.log(`voice: device phone: waiting up to ${PHONE_RESUME_MS / 1000} seconds for the phone to take the voice back after the hub restart`);
    } else if (state.device !== 'computer') {
      // A phone whose sign-in is not known cannot take the voice back: it is off, as when the phone was lost.
      this.#device = 'none';
      this.#deviceChosen = true;
      this.#micOn = false;
      this.#phoneWasLost = state.device === 'phone' || state.phoneLost === true;
    }

    this.update();
  }

  /** The phone did not take the voice back in time: the voice is off (PRD R119, decision 1). */
  #resumeEnded(): void {
    if (this.#resume === null) {
      return;
    }

    this.#resume = null;
    this.#phoneHash = null;
    this.#carried = null;
    this.#setDevice('none', `the phone did not take the voice back within ${PHONE_RESUME_MS / 1000} seconds of the hub restart`, true);
    this.update();
    this.#offerHeld();
  }

  #endResume(): void {
    if (this.#resume === null) {
      return;
    }

    if (this.deps.clearTimer === undefined) {
      clearTimeout(this.#resume.timer as NodeJS.Timeout);
    } else {
      this.deps.clearTimer(this.#resume.timer);
    }

    this.#resume = null;
  }

  /** Offers the replies held while the phone had not taken the voice back, now that the wait ended, wherever the voice is now. */
  #offerHeld(): void {
    if (this.#resume !== null || this.#client === null) {
      return;
    }

    // Replies that came while the hubs changed over, which neither offered, as the one before had let go and this one had no voice process yet.
    if (this.#handedAt !== null && this.#target.sessionId !== null) {
      for (const reply of this.deps.repliesSince?.(this.#target.sessionId, this.#handedAt - HANDOVER_REPLY_MARGIN_MS) ?? []) {
        this.#heldReplies.add(reply.id);
      }
    }

    this.#handedAt = null;

    const held = [...this.#heldReplies];

    this.#heldReplies.clear();

    for (const id of held) {
      const reply = this.deps.store.reply(id);

      if (reply !== null) {
        this.replyChanged(reply);
      }
    }
  }

  /**
   * The phone's voice socket closed: the voice stays off, never moving back to this computer's speakers on its own (PRD R119, decision 1).
   * `refused`: the hub closed it for a sign-out, a forbidden device, voice turned off or the page that opened it closing. The phone counts as
   * lost unless the operator chose its leaving: a refusal, the page's own `leave` (Voice off) or a page hidden when it closed.
   */
  phoneClosed(reason: string, refused = false): void {
    // A hub that handed over leaves the device to the hub that takes over.
    if (this.#closed || this.#device !== 'phone') {
      return;
    }

    const lost = !this.#phoneLeaving && !this.#phoneHidden && (this.#phoneStalled || !refused);

    this.#phoneKey = null;
    this.#phoneHash = null;
    this.#micOn = false;
    this.#setDevice('none', `the phone left${lost ? ' unexpectedly' : ''}: ${reason}`, lost);
    this.update();
  }

  /**
   * A binary frame from the phone's page: its microphone's PCM after the kind byte, relayed to the voice process only while it has the phone's
   * capture open, in whole samples.
   */
  phoneAudio(key: string, data: Buffer): void {
    if (this.#device !== 'phone' || key !== this.#phoneKey || !this.#phoneCapture || data.length < 3 || data.readUInt8(0) !== PHONE_MIC_FRAME || (data.length - 1) % 2 !== 0) {
      return;
    }

    this.#client?.send({ type: 'phone-mic', pcm: data.subarray(1).toString('base64') });
  }

  /**
   * A JSON message from the phone's page: `played {id, ms, done, out?}`, the position of one of its playbacks, or `state {busy}`, whether its
   * microphone cannot be heard now (no track open, the track muted, the page hidden).
   */
  phoneMessage(data: Record<string, unknown>): void {
    const { type, id, ms, done, busy, out, hidden } = data;

    // The page leaves by the operator's choice (Voice off, or its page hidden) just before it closes the socket, so the close notes nothing.
    if (this.#device === 'phone' && type === 'leave') {
      this.#phoneLeaving = true;
      return;
    }

    if (this.#device === 'phone' && type === 'visibility' && typeof hidden === 'boolean') {
      this.#phoneHidden = hidden;
      return;
    }

    if (this.#device === 'phone' && type === 'state' && typeof busy === 'boolean') {
      this.#phoneBusy = busy;
      this.#client?.send({ type: 'phone-state', busy });
      return;
    }

    if (this.#device === 'phone' && type === 'played' && typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 && typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && typeof done === 'boolean') {
      // `out`, what the phone's output took before its latency, sets how far ahead the voice may send; a bad one is left out.
      const taken = typeof out === 'number' && Number.isFinite(out) && out >= 0 ? { out } : {};

      this.#client?.send({ type: 'phone-played', id, ms, done, ...taken });
    }
  }

  /**
   * Voice on the computer, from this computer's page (PRD R119): the voice comes back from the phone, or after it left, to this computer's
   * microphone and speaker, with the mic off. Why not, or null.
   */
  toComputer(key: string): string | null {
    if (this.deps.remotePage?.(key) === true) {
      return 'Select Voice on the computer on the computer running Switchboard.';
    }

    if (!this.deps.settings().enabled) {
      return 'Voice is off (voice.enabled).';
    }

    if (this.#device === 'computer') {
      return 'The voice is already on this computer.';
    }

    this.#takeBack(null);
    this.update();
    return null;
  }

  /** The voice comes back to this computer from the phone, or from none, by an action taken on this computer. */
  #takeBack(key: string | null): void {
    this.#deviceChosen = true;

    if (this.#device === 'computer' || (key !== null && key === this.#phoneKey)) {
      return;
    }

    const fromPhone = this.#device === 'phone';

    this.#endResume();
    this.#carried = null;
    this.#phoneKey = null;
    this.#phoneHash = null;
    this.#setDevice('computer', 'taken back on this computer');

    if (fromPhone) {
      this.deps.phone?.close('Voice is now on the computer running Switchboard.');
    }

    this.#offerHeld();
  }

  /** Moves the voice; `lost`, with none, marks the phone as lost rather than left (`phoneLost`). */
  #setDevice(device: VoiceDevice, why: string, lost = false): void {
    if (device === this.#device) {
      return;
    }

    this.#device = device;
    this.#phoneWasLost = device === 'none' && lost;
    this.#phoneLeaving = false;
    this.#phoneHidden = false;
    this.#phoneStalled = false;
    this.#deviceChosen = true;
    // The voice process turns the mic off with any move, closing what it captured from; the operator turns it on where the voice is now.
    this.#micOn = false;
    this.#phoneCapture = false;
    this.#phoneBusy = true;
    this.deps.log(`voice: device ${device}: ${why}`);
    this.#client?.send({ type: 'device', device });
    this.#targetsSent = '';
    this.viewsChanged();
    this.deps.dockChanged();
  }

  /** The voice target's session, or null. */
  get target(): string | null {
    return this.#target.sessionId;
  }

  /** The dock's voice problem: the voice process cannot start or run, or playback fails. */
  dockError(): string | null {
    return this.deps.settings().enabled ? (this.#processError ?? this.#audioError) : null;
  }

  /**
   * Whether a message typed to this session now asks for a spoken reply, and an expressive one; never for a slash command. One typed in a window
   * or page on this computer (`key`) to the voice target's session after the phone left takes the voice back here, as Talk here does, so its
   * reply is heard (PRD R119).
   */
  spokenFor(sessionId: string, command: boolean, key: string | null = null): { spoken: boolean; expressive: boolean } {
    const settings = this.deps.settings();

    if (key !== null && this.#device === 'none' && this.deps.remotePage?.(key) !== true && settings.enabled && this.#client !== null && this.#target.sessionId === sessionId) {
      this.#takeBack(key);
      this.update();
    }

    const spoken = !command && settings.enabled && this.speakReplies && this.#client !== null && this.#target.sessionId === sessionId;

    return { spoken, expressive: spoken && settings.expressive };
  }

  view(key: string): VoiceView {
    const settings = this.deps.settings();
    const session = this.deps.windows.scope(key)?.sessionId ?? null;
    const here = settings.enabled && session !== null && this.#target.sessionId === session;

    // A playback or speech error is the voice's, not this window's, so only the dock shows it; a reply it failed shows so in its window. Capture
    // that cannot run is this window's mic's.
    return {
      enabled: settings.enabled,
      here,
      mic: here ? this.#mic : 'off',
      speaking: session === null ? null : (this.#playing.get(session) ?? null),
      speakReplies: this.speakReplies,
      error: here && this.#mic === 'unavailable' ? this.#audioError : null,
      recognizer: here ? this.#recognizer : null,
      ...(here && this.#halfDuplex !== null ? { halfDuplex: this.#halfDuplex } : {}),
      ...(here && this.#roomHeld() ? { roomHold: true as const } : {}),
      ...(here && this.#fullDuplex !== null ? { fullDuplex: this.#fullDuplex } : {}),
      ...(here && this.#device === 'none' && this.deps.remotePage?.(key) !== true ? { deviceOff: true as const } : {}),
    };
  }

  /** Whether a room hold runs: the voice process heard someone else within `voice.roomHoldSeconds`. */
  #roomHeld(): boolean {
    return this.#roomHoldUntil !== null && this.#roomHoldUntil > this.deps.now();
  }

  /**
   * Whether the mic is on where the voice is: turned on, and capture neither off, stopped by the idle timeout nor unavailable. The voice
   * target's row shows the mic mark only then, else the speaker mark (architecture.md § Dock, PRD R109).
   */
  get micLive(): boolean {
    return this.#micOn && this.#mic !== 'off' && this.#mic !== 'idle-off' && this.#mic !== 'unavailable';
  }

  /** Sends each window its voice state when it changed, and the dock and the page's list their row mark when the mic came on or went off. */
  viewsChanged(): void {
    if (this.micLive !== this.#micLiveShown) {
      this.#micLiveShown = this.micLive;
      this.deps.dockChanged();
    }

    for (const key of this.deps.windows.keys()) {
      const view = this.view(key);
      const text = JSON.stringify(view);

      if (this.#viewSent.get(key) !== text) {
        this.#viewSent.set(key, text);
        this.deps.notify(key, 'voice', { voice: view });
      }
    }
  }

  /** A window's `hello` carries its voice state; later changes are events. */
  shown(key: string): VoiceView {
    const view = this.view(key);

    this.#viewSent.set(key, JSON.stringify(view));
    return view;
  }

  windowClosed(key: string): void {
    this.#viewSent.delete(key);
    for (const one of [...this.#composers.keys()].filter((name) => name.startsWith(`${key}|`))) {
      this.#composers.delete(one);
    }

    if (this.#talkedFrom === key) {
      this.#talkedFrom = null;
    }

    this.update();
  }

  /**
   * The dock reports the session whose terminal window came to the front, or null when the window in front is no session's terminal; a VS Code
   * window or the web page taking the focus also clears it (architecture.md § Voice). That session stays a target while it is live, so the voice
   * stays with it in another app until the away timeout.
   */
  terminalFocused(sessionId: string | null, at: number): void {
    // A report older than the last change, terminal or window, arrived late and changes nothing.
    if (at < this.#focusAt) {
      return;
    }

    this.#focusAt = at;

    if (sessionId === this.#terminalFocus) {
      return;
    }

    this.#terminalFocus = sessionId;
    this.update();
  }

  /** A VS Code window or the web page gained the focus at `at`: the terminal reported before it is no longer in front. */
  windowGained(at: number): void {
    if (at >= this.#focusAt) {
      this.terminalFocused(null, at);
    }
  }

  /**
   * Windows, their selections, the focus or the sessions changed: starts or stops the process for the demand, and sends it the eligible targets
   * and the focus when they changed.
   */
  update(): void {
    if (this.#closed) {
      return;
    }

    const settings = this.deps.settings();
    const scopes = this.deps.windows.keys().flatMap((key) => {
      const scope = this.deps.windows.scope(key);

      return scope === null ? [] : [{ key, scope }];
    });
    const terminals = this.#terminalTargets();
    const wanted = settings.enabled && (scopes.length > 0 || this.#enrolling() || this.#terminalFocus !== null || this.#resume !== null || (this.#target.sessionId !== null && terminals.has(this.#target.sessionId)));

    this.#demand(wanted);
    this.viewsChanged();

    const targets = new Map<string, VoiceTarget>();

    for (const { scope } of scopes) {
      if (scope.sessionId !== null && scope.workItemId !== null && this.deps.full(scope.sessionId)) {
        targets.set(scope.sessionId, { sessionId: scope.sessionId, workItemId: scope.workItemId, repo: this.#repoOf(scope.cwd) });
      }
    }

    for (const [sessionId, target] of terminals) {
      if (!targets.has(sessionId)) {
        targets.set(sessionId, target);
      }
    }

    // After a hub restart the target stays one, though no window or page shows it yet, until the phone's page shows a conversation again.
    if (this.#carried !== null && this.#phoneKey !== null && this.deps.windows.scope(this.#phoneKey)?.sessionId != null) {
      this.#carried = null;
    }

    const carried = this.#device === 'phone' ? this.#carried : null;
    const carriedSession = carried === null || targets.has(carried) || !this.deps.full(carried) ? null : (this.deps.session?.(carried) ?? null);

    if (carried !== null && carriedSession !== null) {
      targets.set(carried, { sessionId: carried, workItemId: carriedSession.workItemId, repo: this.#repoOf(carriedSession.cwd) });
    }

    // While the phone has the voice only its page's focus moves it: nobody may be at this computer (PRD R119, decision 2). That holds too while
    // its page has not taken the voice back after a hub restart, when nothing is focused.
    const onPhone = this.#device === 'phone';
    const phone = onPhone ? this.#phoneKey : null;
    const focused = onPhone ? (phone !== null && this.deps.pageFocused?.(phone) === true ? phone : null) : this.deps.focusedWindow();
    const session = focused === null ? null : (this.deps.windows.scope(focused)?.sessionId ?? null);
    // The dock reports a terminal only while it is in front, so its focus wins over a window that has not reported its blur yet.
    const focus = this.#terminalFocus !== null && !onPhone ? { sessionId: this.#terminalFocus, via: 'terminal' as const } : session === null ? null : { sessionId: session, via: 'window' as const };
    const message: HubMessage = { type: 'targets', targets: [...targets.values()], focus };
    const text = JSON.stringify(message);

    if (this.#client !== null && text !== this.#targetsSent) {
      this.#targetsSent = text;
      this.#client.send(message);
    }

    this.#syncTyping();
  }

  /** The live sessions whose terminal window the dock has reported in front, as targets; one that is no longer `full` is forgotten. */
  #terminalTargets(): Map<string, VoiceTarget> {
    if (this.#terminalFocus !== null) {
      this.#terminals.add(this.#terminalFocus);
    }

    const targets = new Map<string, VoiceTarget>();

    for (const sessionId of [...this.#terminals]) {
      const session = this.deps.full(sessionId) ? (this.deps.session?.(sessionId) ?? null) : null;

      if (session === null) {
        this.#terminals.delete(sessionId);
      } else {
        targets.set(sessionId, { sessionId, workItemId: session.workItemId, repo: this.#repoOf(session.cwd) });
      }
    }

    return targets;
  }

  /** A folder's repository, looked up once; null until the lookup answers, which sends the targets again. */
  #repoOf(cwd: string | null): string | null {
    if (cwd === null || this.deps.originRepo === undefined) {
      return null;
    }

    const known = this.#repos.get(cwd);

    if (known === undefined) {
      this.#repos.set(cwd, 'pending');
      void this.deps.originRepo(cwd).then(
        (repo) => {
          this.#repos.set(cwd, repo);

          if (repo !== null) {
            this.update();
          }
        },
        () => this.#repos.set(cwd, null),
      );
    }

    return known === undefined || known === 'pending' ? null : known;
  }

  /** The settings were reloaded: the process and the windows get them; with voice turned off, nothing goes on speaking. */
  settingsChanged(): void {
    this.#client?.send({ type: 'settings', settings: this.deps.settings() });

    if (!this.deps.settings().enabled) {
      this.#client?.send({ type: 'stop' });
      this.#micOn = false;

      if (this.#enrolling()) {
        this.enroll('cancel');
      }
    }

    for (const key of this.deps.windows.keys()) {
      this.deps.notify(key, 'settings', { settings: this.deps.viewSettings?.() ?? { expandReplies: this.deps.settings().expandReplies } });
    }

    this.update();
    this.deps.dockChanged();
  }

  /**
   * A reply was added or changed: it is offered for speech when it is the transcript copy of a reply with a primary response, answering a message
   * that asked for a spoken reply, in the voice target's session, while Speak replies is on (architecture.md § Voice); a rewritten one that was
   * offered is cancelled.
   */
  replyChanged(reply: ConversationReply): void {
    const offered = this.#offered.get(reply.id);

    if (offered !== undefined) {
      if (reply.rewrittenBy !== null || reply.withdrawn) {
        this.#client?.send({ type: 'cancel', replyId: reply.id });
      }

      return;
    }

    if ((reply.spokenState ?? 'none') !== 'none' || reply.rewrittenBy !== null || reply.withdrawn || reply.source !== 'transcript' || reply.kind !== 'reply' || reply.speak == null) {
      return;
    }

    const settings = this.deps.settings();
    const asked = reply.answers === null ? false : this.deps.store.message(reply.answers)?.spokenRequested === true;

    this.#sendContext(reply.sessionId);

    if (!settings.enabled || !this.speakReplies || !asked || this.#target.sessionId !== reply.sessionId) {
      return;
    }

    // It waits for the phone to take the voice back after a hub restart, or for the voice process, rather than play to a phone that cannot
    // hear it yet; after a restart, a reply before the voice process connects waits for it too.
    if (this.#resume !== null || (this.#client === null && this.#handedAt !== null)) {
      this.#heldReplies.add(reply.id);
      return;
    }

    if (this.#client === null) {
      return;
    }

    this.#offer(reply, reply.answers);
    this.#offerCard(reply);
  }

  /** After a reply's passage, the current question of its open card, in the same turn so it plays next (design § 7). */
  #offerCard(reply: ConversationReply): void {
    const item = this.deps.cardSpeech?.(reply.sessionId, reply.id) ?? null;

    if (item !== null && this.#client !== null) {
      this.#speakLine(reply.sessionId, item.id, item.text, reply.answers);
    }
  }

  /** Speaks a line that is not a reply's passage, as a card's question or the answer to a card command, in the session's voice. */
  #speakLine(sessionId: string, id: string, text: string, turn: string | null): void {
    const settings = this.deps.settings();
    const persona = this.deps.persona?.(sessionId) ?? null;
    const voice = persona?.voice ?? settings.voice;

    this.#offered.set(id, { gen: this.#target.gen, sessionId, voice, atMs: null, said: null });
    this.#client!.send({ type: 'speak', gen: this.#target.gen, replyId: id, sessionId, text, tone: null, turn, voice, style: persona?.style ?? settings.style, personality: persona === null || persona.personality === '' ? null : persona.personality });
  }

  /**
   * An utterance that is only a card command, such as "B" or "next", while the session has an open card: it changes the card's draft instead of
   * being sent, and the hub says what it did and the next question (design § 7). False for ordinary dictation.
   */
  #cardAnswer(heard: Heard, composer: Composer): boolean {
    const text = composer.draft.trim();
    const answer = text === '' ? null : (this.deps.cardUtterance?.(heard.key, heard.sessionId, text) ?? null);

    if (answer === null) {
      return false;
    }

    composer.draft = '';
    composer.pieces = [];
    composer.interrupted = null;
    composer.held = false;
    this.#notify(heard.key, 'draft', { text: '', sessionId: heard.sessionId });

    if (answer.say !== '' && this.#client !== null) {
      // Each answer is its own turn, so one still waiting, as while the operator goes on speaking, is skipped by the next rather than read late.
      const id = `card-say:${this.deps.now()}`;

      this.#speakLine(heard.sessionId, id, answer.say, id);
    }

    return true;
  }

  /** The target's latest reply, for the turn model, when it changed. */
  #sendContext(sessionId: string | null): void {
    const lastReply = sessionId === null ? null : (this.deps.lastReply?.(sessionId) ?? null);

    if (this.#client !== null && sessionId !== null && sessionId === this.#target.sessionId && lastReply !== null && this.#contextSent.get(sessionId) !== lastReply) {
      this.#contextSent.set(sessionId, lastReply);
      this.#client.send({ type: 'context', sessionId, lastReply });
    }
  }

  /**
   * The mic command (architecture.md § Dictation): turning it on also moves the voice to this window's session, so the mic is on where the
   * operator turned it on; turning it off stops capture wherever the voice is. Why not, or null.
   */
  mic(key: string, on: boolean): string | null {
    // A paired device's mic is its own, used only while it has the voice: it never turns on this computer's microphone (PRD R119).

    if (on && this.deps.remotePage?.(key) === true && !(this.#device === 'phone' && key === this.#phoneKey)) {
      return PHONE_MIC_HERE;
    }

    if (on) {
      const refused = this.talkHere(key);

      if (refused !== null) {
        return refused;
      }
    } else if (!this.view(key).here && this.#micOn) {
      return 'Voice is not in this window.';
    }

    this.#micOn = on;
    // Timed only from a mic that is not listening already, whose next state is the voice process's answer to this one.
    this.#micAsked = on && this.#mic !== 'listening' && this.#mic !== 'hearing' ? { at: this.deps.now(), from: this.deps.remotePage?.(key) === true ? 'a paired device' : 'this computer' } : null;
    this.#client?.send({ type: 'mic', on });
    this.viewsChanged();
    return null;
  }

  /**
   * A page's Mic on tap timed (architecture.md § Dictation): each step as milliseconds from the tap, logged in one hub log line, since the page's
   * steps (the microphone's permission, the voice socket, the audio worklet, the hub's answer) are the start's part this computer cannot see.
   */
  micTiming(key: string, steps: Array<{ step: string; ms: number }>, outcome: string): void {
    const from = this.deps.remotePage?.(key) === true ? "a paired device's page" : "this computer's page";

    this.deps.log(`voice: mic on tap on ${from} → ${outcome}: ${steps.map((one) => `${one.step} at ${Math.round(one.ms)} ms`).join(', ')}`);
  }

  /**
   * The composer's focus and draft (architecture.md § Dictation, the focus rule): the hub keeps each window's draft as the one text dictation
   * joins, and while the here window's composer has the focus the voice process holds every send and stops listening. A draft emptied by the
   * operator no longer holds dictation.
   */
  composer(key: string, focused: boolean, draft: string): void {
    const composer = this.#composer(key, this.deps.windows.scope(key)?.sessionId ?? '');

    composer.focused = focused;
    composer.draft = draft;

    if (draft.trim() === '') {
      composer.pieces = [];
      composer.interrupted = null;
      composer.held = false;
    }

    this.#syncTyping();
  }

  /**
   * A message the window sends from its composer: the pieces of the dictation it holds, so it goes as a `[voice]` message, or null for one with
   * none. The draft is then the composer's again, empty.
   */
  dictated(key: string, sessionId: string): Piece[] | null {
    const composer = this.#composers.get(composerKey(key, sessionId));

    if (composer === undefined || composer.pieces.length === 0) {
      return null;
    }

    const pieces = composer.pieces;

    composer.pieces = [];
    composer.draft = '';
    composer.held = false;
    return pieces;
  }

  /** The reply the dictation in a window's draft spoke over, taken as the window sends the draft; null with none. */
  interruption(key: string, sessionId: string): Interruption | null {
    const composer = this.#composers.get(composerKey(key, sessionId));
    const interrupted = composer?.interrupted ?? null;

    if (composer !== undefined) {
      composer.interrupted = null;
    }

    return interrupted;
  }

  /**
   * Voiceprint enrolment from the dock's Voice page (architecture.md § Voice check and barge-in): `start` starts the voice process if it is not
   * running and has it record; `cancel` stops a recording. Why not, or null.
   */
  enroll(action: 'start' | 'cancel'): string | null {
    if (action === 'cancel') {
      if (this.#enrolling() && this.#client !== null) {
        // The start may have reached the process: it records until told to stop, and reports the cancel after its recording.
        this.#client.send({ type: 'enroll', action: 'cancel' });
      } else if (this.#enrollment.state === 'starting') {
        this.#enrollment = { state: 'cancelled', endsAt: null, error: null };
        this.deps.dockChanged();
        this.update();
      }

      return null;
    }

    if (!this.deps.settings().enabled) {
      return 'Voice is off (voice.enabled).';
    }

    if (this.#enrolling()) {
      return null;
    }

    this.#enrollment = { state: 'starting', endsAt: null, error: null };

    if (this.#client !== null) {
      this.#client.send({ type: 'enroll', action: 'start' });
    } else {
      this.update();
    }

    this.deps.dockChanged();
    return null;
  }

  enrollment(): EnrollmentView {
    return { ...this.#enrollment, enrolledAt: this.deps.enrolledAt?.() ?? null };
  }

  #enrolling(): boolean {
    return this.#enrollment.state === 'starting' || this.#enrollment.state === 'recording';
  }

  #enrollmentChanged(state: EnrollmentState, error: string | null): void {
    this.#enrollment = { state, endsAt: state === 'recording' ? this.deps.now() + ENROLL_SECONDS * 1000 : null, error };
    this.deps.log(`voice: enrolment ${state}${error === null ? '' : `: ${error}`}`);
    this.deps.dockChanged();
    this.update();
  }

  /** A reply's heard tags go to the glossary (architecture.md § Dictation). */
  heard(tags: HeardTag[]): void {
    for (const tag of tags) {
      this.#client?.send({ type: 'heard', heard: tag.heard, meant: tag.meant });
    }
  }

  /**
   * The voice's steps of a dictated message, for its timing line in the hub log (architecture.md § Dictation): from the last recognised word to
   * the end decision, to the end sent after the last piece's voice check, and to the hub; null for a message turn detection did not end.
   */
  timing(messageId: string): string | null {
    const timing = this.#timings.get(messageId);

    this.#timings.delete(messageId);

    if (timing === undefined) {
      return null;
    }

    return `last word → ${timing.endedBy} decision ${timing.decidedAt - timing.lastWordAt} ms, decision → voice sent ${timing.endedAt - timing.decidedAt} ms, voice → hub ${Math.max(0, timing.receivedAt - timing.endedAt)} ms`;
  }

  /** A dictated message settled: its pieces go to the fragments log with its delivery. */
  delivered(message: ConversationMessage): void {
    if (message.origin !== 'voice' || (message.delivery !== 'sent' && message.delivery !== 'not-sent')) {
      return;
    }

    for (const piece of message.pieces ?? []) {
      this.#fragment({ event: message.delivery, sessionId: message.sessionId, utteranceId: null, pieceId: null, messageId: message.id, text: piece.text, error: message.error });
    }
  }

  #composer(key: string, sessionId: string): Composer {
    let composer = this.#composers.get(composerKey(key, sessionId));

    if (composer === undefined) {
      composer = { focused: false, draft: '', pieces: [], interrupted: null, held: false };
      this.#composers.set(composerKey(key, sessionId), composer);
    }

    return composer;
  }

  /**
   * Where dictation goes: the target's terminal window while it is in front (`TERMINAL`), else the focused window showing the target, else the
   * one that last moved the voice there, else any showing it, else the target's terminal when the voice came to it from there.
   */
  #hereKey(): string | null {
    const session = this.#target.sessionId;

    if (session === null) {
      return null;
    }

    if (this.#terminalFocus === session) {
      return TERMINAL;
    }

    const showing = this.deps.windows.keys().filter((key) => this.deps.windows.scope(key)?.sessionId === session);
    const focused = this.deps.focusedWindow();

    if (focused !== null && showing.includes(focused)) {
      return focused;
    }

    return this.#talkedFrom !== null && showing.includes(this.#talkedFrom) ? this.#talkedFrom : (showing[0] ?? (this.#terminals.has(session) ? TERMINAL : null));
  }

  /** Tells the process whether the here window's composer has the focus, when that changed. */
  #syncTyping(): void {
    const key = this.#hereKey();
    const typing = key !== null && this.#composers.get(composerKey(key, this.#target.sessionId ?? ''))?.focused === true;

    if (this.#client !== null && typing !== this.#typingSent) {
      this.#typingSent = typing;
      this.#client.send({ type: 'typing', on: typing });
    }
  }

  /** The window an utterance's dictation goes to, chosen at its first report while its generation is current; null for one of another. */
  #heardFor(gen: number, utteranceId: string, sessionId: string): Heard | null {
    const known = this.#heard.get(utteranceId);

    if (known !== undefined) {
      return known;
    }

    const key = this.#hereKey();

    if (gen !== this.#target.gen || sessionId !== this.#target.sessionId || key === null) {
      return null;
    }

    const heard = { key, sessionId, gen, startedAt: this.deps.now(), flushedAt: null };

    this.#heard.set(utteranceId, heard);
    this.#armFlush();
    return heard;
  }

  /** A piece settled: it joins its window's draft after the text already there, and goes to the fragments log. */
  #piece(message: Extract<VoiceMessage, { type: 'piece' }>): void {
    const heard = this.#heardFor(message.gen, message.utteranceId, message.sessionId);

    if (heard === null) {
      this.deps.log(`voice: piece of utterance ${message.utteranceId} dropped: generation ${message.gen} is not ${this.#target.gen}`);
      return;
    }

    const piece: Piece = { text: message.text, score: message.score, f0: message.f0, dropped: message.dropped };

    this.#fragment({ event: message.dropped ? 'dropped' : 'heard', sessionId: message.sessionId, utteranceId: message.utteranceId, pieceId: message.pieceId, messageId: null, text: message.text, score: message.score, f0: message.f0 });

    if (message.dropped) {
      return;
    }

    const composer = this.#composer(heard.key, heard.sessionId);

    composer.draft = composer.draft === '' || /\s$/.test(composer.draft) ? `${composer.draft}${message.text}` : `${composer.draft} ${message.text}`;
    composer.pieces.push(piece);
    this.#notify(heard.key, 'draft', { text: composer.draft, sessionId: heard.sessionId });
  }

  /**
   * An utterance ended. Turn detection's end, while its generation is current and its window's composer does not have the focus, sends the
   * whole draft as one `[voice]` message and empties it; a refusal leaves the draft and says why in that window. An utterance cut short sends
   * nothing and leaves its words in the draft; in a terminal, which has no composer to keep them, they are dropped, so they are never typed
   * later with another utterance.
   */
  #utterance(message: Extract<VoiceMessage, { type: 'utterance' }>): void {
    const heard = this.#heard.get(message.utteranceId);

    this.#heard.delete(message.utteranceId);

    if (heard === undefined) {
      return;
    }

    if (heard.key === TERMINAL && (!message.final || message.gen !== this.#target.gen)) {
      const composer = this.#composer(heard.key, heard.sessionId);

      if (composer.draft.trim() !== '') {
        this.deps.log(`voice: utterance ${message.utteranceId} for the terminal of session ${heard.sessionId} was cut off; its words were not typed`);
      }

      composer.draft = '';
      composer.pieces = [];
      composer.interrupted = null;
      return;
    }

    if (message.gen !== this.#target.gen) {
      return;
    }

    const composer = this.#composer(heard.key, heard.sessionId);

    // The reply it spoke over goes with the message that sends this dictation, by voice or by Enter.
    if (message.interrupted !== null && composer.pieces.length > 0) {
      composer.interrupted = message.interrupted;
    }

    if (!message.final || composer.focused) {
      return;
    }

    if (this.#roomHeld() || composer.held) {
      this.#hold(heard, composer);
      return;
    }

    if (heard.key !== TERMINAL && this.#cardAnswer(heard, composer)) {
      return;
    }

    this.#submit(heard, composer, false, message.timing === undefined ? null : { ...message.timing, receivedAt: this.deps.now() });
  }

  /**
   * The room hold (architecture.md § Voice check and barge-in): a spoken turn's end sends nothing while someone else is talking in the room, or
   * while the draft holds a turn kept that way. Its words stay in the draft and the window says so; in a terminal, with no composer to keep
   * them, they are dropped, so they are never typed later with another turn.
   */
  #hold(heard: Heard, composer: Composer): void {
    for (const piece of composer.pieces) {
      this.#fragment({ event: 'held', sessionId: heard.sessionId, utteranceId: null, pieceId: null, messageId: null, text: piece.text });
    }

    if (heard.key === TERMINAL) {
      this.deps.log(`voice: a spoken turn for the terminal of session ${heard.sessionId} was not typed: someone else is talking in the room`);
      composer.draft = '';
      composer.pieces = [];
      composer.interrupted = null;
      return;
    }

    this.deps.log(`voice: a spoken turn for session ${heard.sessionId} stays in the composer: someone else ${this.#roomHeld() ? 'is' : 'was'} talking in the room`);
    composer.held = true;
    this.#notify(heard.key, 'held', { sessionId: heard.sessionId, note: this.#roomHeld() ? HELD_NOTE : HELD_AFTER_NOTE });
  }

  /**
   * Types the window's draft as a dictated message or a `[partial]` part, and empties the draft once it was taken; false when refused. `timing`
   * is kept for the message's timing line.
   */
  #submit(heard: Heard, composer: Composer, partial: boolean, timing: (UtteranceTiming & { receivedAt: number }) | null = null): boolean {
    let text = composer.draft.trim();
    let pieces = composer.pieces;
    // A [partial] part leaves the last settled piece in the draft, so the message that ends the utterance always has words to carry.
    const kept = partial ? pieces.at(-1) : undefined;

    if (partial) {
      const draft = composer.draft.trimEnd();

      if (kept === undefined || pieces.length < 2 || !draft.endsWith(kept.text)) {
        return false;
      }

      text = draft.slice(0, draft.length - kept.text.length).trim();
      pieces = pieces.slice(0, -1);
    }

    if (text === '' || this.deps.dictate === undefined) {
      return false;
    }

    const sent = this.deps.dictate(heard.key === TERMINAL ? null : heard.key, heard.sessionId, text, pieces, partial, partial ? null : composer.interrupted);

    if ('refused' in sent) {
      this.deps.log(`voice: dictated message refused: ${sent.refused}`);

      for (const piece of pieces) {
        this.#fragment({ event: 'refused', sessionId: heard.sessionId, utteranceId: null, pieceId: null, messageId: null, text: piece.text, error: sent.refused });
      }

      this.#notify(heard.key, 'refused', { error: sent.refused });
      return false;
    }

    for (const piece of pieces) {
      this.#fragment({ event: 'submitted', sessionId: heard.sessionId, utteranceId: null, pieceId: null, messageId: sent.message.id, text: piece.text });
    }

    if (timing !== null) {
      this.#timings.set(sent.message.id, timing);

      // A message can settle before this, as a refused Codex one does at once; its steps are then never taken, so only the latest are kept.
      for (const id of [...this.#timings.keys()].slice(0, -TIMINGS_KEPT)) {
        this.#timings.delete(id);
      }
    }

    composer.draft = kept?.text ?? '';
    composer.pieces = kept === undefined ? [] : [kept];
    composer.held = false;

    if (!partial) {
      composer.interrupted = null;
    }

    this.#notify(heard.key, 'draft', { text: composer.draft, sessionId: heard.sessionId });
    return true;
  }

  /** Words heard for a terminal and not typed are dropped, since no composer shows them and a later utterance must not carry them. */
  #dropTerminalDrafts(why: string): void {
    for (const [name, composer] of this.#composers) {
      if (name.startsWith(`${TERMINAL}|`)) {
        if (composer.draft.trim() !== '') {
          this.deps.log(`voice: words heard for the terminal of session ${name.slice(TERMINAL.length + 1)} were not typed: ${why}`);
        }

        composer.draft = '';
        composer.pieces = [];
      }
    }
  }

  /** Sends a window an event; the terminal has no view to send it to. */
  #notify(key: string, type: string, payload: Record<string, unknown>): void {
    if (key !== TERMINAL) {
      this.deps.notify(key, type, payload);
    }
  }

  /**
   * While an utterance is open in a window whose composer does not have the focus and its session works, the draft goes as a `[partial]` at most
   * every `FRAGMENT_FLUSH_MS` (architecture.md § Dictation).
   */
  #flush(): void {
    const now = this.deps.now();

    for (const heard of new Set(this.#heard.values())) {
      const composer = this.#composers.get(composerKey(heard.key, heard.sessionId));

      if (
        composer === undefined ||
        composer.focused ||
        composer.held ||
        this.#roomHeld() ||
        this.#mic === 'paused-other-app' ||
        heard.gen !== this.#target.gen ||
        this.deps.busy?.(heard.sessionId) !== true ||
        now - (heard.flushedAt ?? heard.startedAt) < FRAGMENT_FLUSH_MS
      ) {
        continue;
      }

      if (this.#submit(heard, composer, true)) {
        heard.flushedAt = now;
      }
    }

    if (this.#heard.size === 0) {
      this.#stopFlush();
    }
  }

  #armFlush(): void {
    this.#flushTimer ??= (this.deps.every ?? every)(() => this.#flush(), FLUSH_CHECK_MS);
  }

  #stopFlush(): void {
    this.#flushTimer?.stop();
    this.#flushTimer = null;
  }

  /** Appends a line to the day's fragments log, `<home>/voice/fragments-<local date>.jsonl`. */
  #fragment(fragment: Fragment): void {
    if (this.deps.fragmentsDir === undefined) {
      return;
    }

    const at = new Date(this.deps.now());
    const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

    try {
      mkdirSync(this.deps.fragmentsDir, { recursive: true });
      appendFileSync(join(this.deps.fragmentsDir, `fragments-${date}.jsonl`), `${JSON.stringify({ at: at.toISOString(), ...fragment })}\n`);
    } catch (error) {
      this.deps.log(`voice: the fragments log could not be written: ${(error as Error).message}`);
    }
  }

  /** Talk here from a window: the voice moves to its selected conversation's session; why not, or null. */
  talkHere(key: string): string | null {
    const session = this.deps.windows.scope(key)?.sessionId ?? null;

    // Another paired device's page cannot take the voice from the phone, nor to this computer after the phone left (PRD R119).
    if (this.#device !== 'computer' && key !== this.#phoneKey && this.deps.remotePage?.(key) === true) {
      return this.#device === 'phone' ? 'Voice is on another device.' : 'Select Voice on this device to start voice here.';
    }

    // Talk here on this computer takes the voice back from the phone, or after the phone left (PRD R119).
    if (session !== null && this.deps.settings().enabled && this.#client !== null && this.deps.full(session)) {
      this.#takeBack(key);
    }

    const refused = session === null ? 'This window has no session to talk to.' : this.#talkTo(session);

    if (refused === null) {
      this.#talkedFrom = key;
      this.#carried = null;
    }

    return refused;
  }

  /** A dock row's click (architecture.md § Dock): Talk here for that work item's session when one of its windows is connected; why not, or null. */
  dockSelect(workItemId: number): string | null {
    // A dock click is no Talk here: it does not take the voice from the phone (PRD R119, decision 2).
    if (this.#device === 'phone') {
      return PHONE_HAS_VOICE;
    }

    const key = this.deps.windows.keys().find((one) => this.deps.windows.scope(one)?.workItemId === workItemId && this.deps.windows.scope(one)?.sessionId != null);

    return key === undefined ? OPEN_ITS_WINDOW : this.talkHere(key);
  }

  /** The window selected another conversation: while it has the focus, Talk here for it, without the focus debounce (voice-design § 2.3). */
  selected(key: string): void {
    if (this.#device === 'phone' && key !== this.#phoneKey) {
      return;
    }

    // While the phone has the voice its page's own focus counts, whatever window on this computer was focused last.
    const focused = this.#device === 'phone' ? this.deps.pageFocused?.(key) === true : this.deps.focusedWindow() === key;

    if (this.deps.settings().enabled && this.#client !== null && focused) {
      this.talkHere(key);
    }
  }

  /** Stop speaking, only from the window the voice is in. */
  stopSpeaking(key: string): string | null {
    if (!this.view(key).here) {
      return 'Voice is not in this window.';
    }

    this.#client?.send({ type: 'stop' });
    return null;
  }

  /**
   * Speak replies on or off. Turning it off cancels every reply offered with `off`, so the voice process stops the one playing at once,
   * `interrupted` where it stopped, whether or not its `playing` has reached the hub, and leaves alert lines alone; the composer's speaker is how
   * the operator stops a reply (architecture.md § Conversation view).
   */
  setSpeakReplies(on: boolean): void {
    this.speakReplies = on;

    if (!on) {
      for (const replyId of this.#offered.keys()) {
        this.#client?.send({ type: 'cancel', replyId, off: true });
      }
    }

    this.viewsChanged();
  }

  /** Speaks a reply of the window's session again, only while the voice is here. */
  replay(key: string, replyId: string): string | null {
    const scope = this.deps.windows.scope(key);
    const reply = this.deps.store.reply(replyId);

    if (scope === null || reply === null || reply.sessionId !== scope.sessionId) {
      return 'Not in this window.';
    }

    if (!this.view(key).here || this.#client === null) {
      return 'Voice is not in this window.';
    }

    if (reply.speak == null) {
      return 'This reply has nothing to read aloud.';
    }

    // One request per reply at a time, so its reports stay its own.
    if (this.#offered.has(replyId)) {
      return 'This reply is being spoken.';
    }

    this.#offer(reply, reply.answers);
    this.#offerCard(reply);
    return null;
  }

  /**
   * The live `full` sessions after a change (architecture.md § Spoken alerts): a session that finished a turn, or started waiting on a question
   * or a permission prompt, gets an alert after `ALERT_DELAY_MS` when spoken alerts are on for that event and it is neither the voice target nor
   * the focused conversation; one whose kind changes again first, or ends, has its alert cancelled. The first sight of a session alerts nothing.
   * Returns the work items alerted, which the needs-you sound leaves out.
   */
  sessionsChanged(sessions: AlertSession[]): number[] {
    const alerted: number[] = [];
    const live = new Set(sessions.map((one) => one.sessionId));

    for (const sessionId of [...this.#alertKinds.keys()].filter((id) => !live.has(id))) {
      this.#alertKinds.delete(sessionId);
      this.#cancelAlert(sessionId);
    }

    for (const one of sessions) {
      const was = this.#alertKinds.get(one.sessionId);

      this.#alertKinds.set(one.sessionId, one.kind);

      if (was === one.kind) {
        continue;
      }

      this.#cancelAlert(one.sessionId);

      const cause: AlertCause | null = one.kind === 'question' || one.kind === 'permission' ? one.kind : one.kind === 'idle' && was === 'running' ? 'turn-finished' : null;

      if (was !== undefined && cause !== null && this.#alerting(one.sessionId, cause)) {
        const alertId = `${this.deps.now()}-${++this.#alertCount}`;
        const timer = this.#timer(() => this.#sendAlert(one.sessionId, alertId, cause), ALERT_DELAY_MS);

        this.#alerts.set(one.sessionId, { alertId, kind: one.kind, timer });
        alerted.push(one.workItemId);
      }
    }

    return alerted;
  }

  /** Whether an alert of this cause goes out for the session now: alerts on for it, a voice process, and the session out of focus. */
  #alerting(sessionId: string, cause: AlertCause): boolean {
    const settings = this.deps.settings();

    return (
      settings.enabled &&
      settings.spokenAlerts &&
      settings.alertOn[cause === 'turn-finished' ? 'finished' : cause] &&
      this.#client !== null &&
      this.#target.sessionId !== sessionId &&
      this.#focusedSession() !== sessionId &&
      this.#canBeHeard()
    );
  }

  #sendAlert(sessionId: string, alertId: string, cause: AlertCause): void {
    const pending = this.#alerts.get(sessionId);

    if (pending?.alertId !== alertId) {
      return;
    }

    pending.timer = null;

    const text = this.deps.alertText?.(sessionId, cause) ?? null;

    if (!this.#alerting(sessionId, cause) || text === null) {
      this.#alerts.delete(sessionId);
      return;
    }

    const settings = this.deps.settings();
    const persona = this.deps.persona?.(sessionId) ?? null;

    this.#client!.send({
      type: 'alert',
      alertId,
      sessionId,
      cause,
      title: text.title,
      persona: persona?.name ?? null,
      detail: text.detail,
      voice: persona?.voice ?? settings.voice,
      style: persona?.style ?? settings.style,
      personality: persona === null || persona.personality === '' ? null : persona.personality,
    });
    this.deps.log(`voice: alert ${alertId} for session ${sessionId}: ${cause}`);
  }

  /** Drops a session's alert not sent yet, or tells the process to cancel one sent. */
  #cancelAlert(sessionId: string): void {
    const alert = this.#alerts.get(sessionId);

    if (alert === undefined) {
      return;
    }

    this.#alerts.delete(sessionId);

    if (alert.timer !== null) {
      if (this.deps.clearTimer === undefined) {
        clearTimeout(alert.timer as NodeJS.Timeout);
      } else {
        this.deps.clearTimer(alert.timer);
      }
    } else {
      this.#client?.send({ type: 'alert-cancel', alertId: alert.alertId });
    }
  }

  /** The session of the focused conversation: a session terminal window in front, else the focused window's selected conversation's. */
  #focusedSession(): string | null {
    // While the phone has the voice its page is where the operator is, whatever this computer shows (PRD R119).
    if (this.#device === 'phone') {
      return this.#phoneKey !== null && this.deps.pageFocused?.(this.#phoneKey) === true ? (this.deps.windows.scope(this.#phoneKey)?.sessionId ?? null) : null;
    }

    const focused = this.deps.focusedWindow();

    return this.#terminalFocus ?? (focused === null ? null : (this.deps.windows.scope(focused)?.sessionId ?? null));
  }

  /**
   * Whether a web page may play its own needs-you sound: any while the voice is on this computer; while it is on the phone, only that phone's
   * page in front, where the voice would play it; none after the phone left (PRD R119).
   */
  pageMaySound(key: string): boolean {
    return this.#device === 'computer' || (this.#device === 'phone' && key === this.#phoneKey && this.deps.pageFocused?.(key) === true);
  }

  /**
   * Whether a spoken alert or the needs-you sound can be heard where the voice is: on this computer, or on the phone while its page is in front
   * (PRD R119); never with no device. A hidden phone page plays and hears nothing.
   */
  #canBeHeard(): boolean {
    return this.#device === 'computer' || (this.#device === 'phone' && this.#phoneKey !== null && this.deps.pageFocused?.(this.#phoneKey) === true);
  }

  /** A work item other than the voice target's started needing the operator: the process plays the needs-you sound. Returns whether it was sent. */
  needsYou(workItemIds: number[], targetWorkItem: number | null): boolean {
    const settings = this.deps.settings();

    if (settings.enabled && settings.needsYouSound && this.#client !== null && this.#canBeHeard() && workItemIds.some((id) => id !== targetWorkItem)) {
      this.#client.send({ type: 'earcon', kind: 'needs-you' });
      return true;
    }

    return false;
  }

  /** Whether a reply is offered to the voice process or being spoken, or a voice enrolment runs. */
  speaking(): boolean {
    return this.#offered.size > 0 || this.#playing.size > 0 || this.#enrolling();
  }

  /**
   * Why a hub restart waits (architecture.md § Hub lifecycle): a reply offered or playing, an enrolment, the operator being heard, or a phone that
   * has not taken the voice back since the last restart; null when the voice lets it go ahead.
   */
  restartBlocker(): string | null {
    // Replies held for the phone count, as its wait is short; ones held for a voice process that does not connect are handed over instead.
    if (this.#offered.size > 0 || this.#playing.size > 0 || (this.#resume !== null && this.#heldReplies.size > 0)) {
      return 'the voice is speaking a reply';
    }

    if (this.#enrolling()) {
      return 'a voice enrolment is recording';
    }

    if (this.#mic === 'hearing') {
      return 'the voice is hearing the operator';
    }

    return this.#resume === null ? null : 'the phone has not taken the voice back since the last restart';
  }

  close(): void {
    this.#closed = true;
    this.#endResume();
    this.#stopFlush();
    this.#clear('linger');
    this.#clear('restart');
    this.#client?.close();
    this.#client = null;
    this.#handedOver?.close();
    this.#handedOver = null;
  }

  #talkTo(sessionId: string): string | null {
    if (!this.deps.settings().enabled) {
      return 'Voice is off (voice.enabled).';
    }

    if (!this.deps.full(sessionId)) {
      return 'Voice is not available for this session.';
    }

    if (this.#client === null) {
      return this.#processError ?? 'The voice process is starting.';
    }

    this.update();
    this.#client.send({ type: 'talk-here', sessionId });
    return null;
  }

  #offer(reply: ConversationReply, turn: string | null): void {
    const gen = this.#target.gen;

    const settings = this.deps.settings();
    // The persona is read at each offer, so a pin changes the voice from the next spoken reply.
    const persona = this.deps.persona?.(reply.sessionId) ?? null;

    const voice = persona?.voice ?? settings.voice;

    this.#offered.set(reply.id, { gen, sessionId: reply.sessionId, voice, atMs: null, said: null });
    this.#client!.send({
      type: 'speak',
      gen,
      replyId: reply.id,
      sessionId: reply.sessionId,
      text: spokenText(reply.speak!),
      tone: reply.tone ?? null,
      turn,
      voice,
      style: persona?.style ?? settings.style,
      personality: persona === null || persona.personality === '' ? null : persona.personality,
    });
    this.#setState(reply.id, 'queued', null, null);
  }

  #setState(replyId: string, state: SpokenState, atMs: number | null, said: number | null): void {
    if (this.deps.store.reply(replyId) === null) {
      return;
    }

    this.deps.store.updateReply(replyId, { spokenState: state, spokenAtMs: atMs, saidChars: said });
    this.deps.replyChanged(replyId);
  }

  #receive(message: VoiceMessage): void {
    switch (message.type) {
      case 'active': {
        const moved = message.gen !== this.#target.gen;

        this.#target = { gen: message.gen, sessionId: message.sessionId };

        // Everything offered before the move was stopped or dropped by it.
        if (moved) {
          for (const [replyId, offered] of [...this.#offered]) {
            if (offered.gen !== message.gen) {
              const atMs = offered.atMs ?? this.deps.store.reply(replyId)?.spokenAtMs ?? null;
              const said = offered.said ?? this.deps.store.reply(replyId)?.saidChars ?? null;

              this.#offered.delete(replyId);
              this.#playing.delete(offered.sessionId);
              this.#logSpeech(replyId, offered, 'stopped: voice moved', atMs, said);
              this.#setState(replyId, 'stopped-moved', atMs, said);
            }
          }
        }

        this.deps.log(`voice target ${message.sessionId ?? 'none'} (${message.reason}), generation ${message.gen}`);
        this.viewsChanged();
        this.deps.dockChanged();
        this.#syncTyping();
        this.#sendContext(message.sessionId);

        // A dropped terminal target can end the demand, with no window connected.
        if (message.sessionId === null) {
          this.update();
        }

        return;
      }
      case 'words': {
        const heard = message.text === '' ? (this.#heard.get(message.utteranceId) ?? null) : this.#heardFor(message.gen, message.utteranceId, message.sessionId);

        // Live words show in every window and page showing the session, whichever one dictation goes to, since they are display only; none
        // while dictation types into the session's terminal, whose words no composer receives.
        if (heard !== null && heard.gen === this.#target.gen && heard.key !== TERMINAL) {
          for (const key of this.deps.windows.keys().filter((one) => this.deps.windows.scope(one)?.sessionId === heard.sessionId)) {
            this.deps.notify(key, 'words', { messageId: message.utteranceId, text: message.text });
          }
        }

        return;
      }
      case 'piece':
        this.#piece(message);
        return;
      case 'utterance':
        this.#utterance(message);
        return;
      case 'device':
        // A hub that started again begins on this computer, while the voice process kept the device it had: the phone that had the voice left
        // with the hub that stopped, so the voice stays off until the operator takes it back (PRD R119, decision 1). Once this hub chose the
        // device itself, as Talk here before the greeting came, its own device wins.
        if (message.device !== this.#device) {
          const had = message.device === 'phone' ? 'the phone' : message.device === 'none' ? 'no device' : 'this computer';

          if (this.#deviceChosen) {
            this.deps.log(`voice: device ${this.#device}: the voice process had ${had} when the hub connected, and is told this hub's device`);
            this.#client?.send({ type: 'device', device: this.#device });
          } else if (message.device !== 'computer') {
            // The phone's socket closed with the hub that stopped, a loss; none was already off, as the operator may have chosen.
            this.#setDevice('none', `the voice process had ${had} when the hub connected`, message.device === 'phone');
            this.update();
          }
        }

        return;
      case 'speech': {
        if (message.gen !== this.#target.gen || !this.#offered.has(message.replyId)) {
          return;
        }

        this.#setState(message.replyId, message.state, message.atMs, message.said);

        if (message.state === 'playing') {
          this.#playing.set(message.sessionId, message.replyId);
        } else if (FINAL.has(message.state)) {
          const offered = this.#offered.get(message.replyId)!;

          this.#logSpeech(message.replyId, offered, message.reason === undefined ? message.state : `${message.state} (${message.reason})`, message.atMs ?? offered.atMs, message.said ?? offered.said);
          this.#offered.delete(message.replyId);

          if (this.#playing.get(message.sessionId) === message.replyId) {
            this.#playing.delete(message.sessionId);
          }

          // A reply whose whole text was its passage, heard to the end, has been seen (architecture.md § Unread).
          const reply = this.deps.store.reply(message.replyId);

          if (message.state === 'played' && reply !== null && reply.speak != null && reply.speak.trim() === reply.opening.trim()) {
            this.deps.store.markSeen(reply.sessionId, [reply.id], this.deps.now());
            this.deps.replyChanged(reply.id);
          }
        }

        this.viewsChanged();
        return;
      }
      case 'progress': {
        const offered = this.#offered.get(message.replyId);

        if (message.gen !== this.#target.gen || offered === undefined) {
          return;
        }

        offered.atMs = message.atMs;
        offered.said = message.chars;

        for (const key of this.deps.windows.keys()) {
          if (this.deps.windows.scope(key)?.sessionId === message.sessionId) {
            this.deps.notify(key, 'progress', { replyId: message.replyId, chars: message.chars, atMs: message.atMs });
          }
        }

        return;
      }
      case 'enrollment':
        this.#enrollmentChanged(message.state, message.error);
        return;
      case 'mic-off':
        // The operator left the computer: the mic stays off, also for a voice process started later, until they turn it on.
        this.#micOn = false;
        this.deps.log(`voice: mic off: ${MIC_OFF_TEXT[message.reason]}`);
        this.viewsChanged();
        return;
      case 'alert-done':
        if (this.#alerts.get(message.sessionId)?.alertId === message.alertId) {
          this.#alerts.delete(message.sessionId);
        }

        this.deps.log(`voice: alert ${message.alertId} for session ${message.sessionId} ${message.outcome}`);
        return;
      case 'command':
        // A spoken command goes to no session: it is only logged (architecture.md § Dictation).
        this.deps.log(`voice: spoken command ${message.command} ("${message.text}")`);
        this.#fragment({ event: 'command', sessionId: message.sessionId ?? '', utteranceId: message.utteranceId, pieceId: null, messageId: null, text: message.text, score: message.score, f0: message.f0 });
        return;
      case 'phone-play':
      case 'phone-end':
      case 'phone-flush':
        if (this.#device === 'phone') {
          this.deps.phone?.send({ type: message.type.slice('phone-'.length), id: message.id });
        }

        return;
      case 'phone-capture':
        this.#phoneCapture = this.#device === 'phone' && message.on;

        if (this.#device === 'phone') {
          this.deps.phone?.send({ type: 'capture', on: message.on });
        }

        return;
      case 'phone-stalled':
        // The phone stopped playing while its socket stayed open: the voice leaves it, as when it is lost.
        if (this.#device === 'phone') {
          this.deps.log(`voice: the phone stopped playing: ${message.reason}`);
          this.#phoneStalled = true;
          this.deps.phone?.close(message.reason);
        }

        return;
      case 'phone-pcm':
        if (this.#device === 'phone') {
          const pcm = Buffer.from(message.pcm, 'base64');
          const frame = Buffer.alloc(5 + pcm.length);

          frame.writeUInt8(PHONE_PCM_FRAME, 0);
          frame.writeUInt32LE(message.id, 1);
          pcm.copy(frame, 5);
          this.deps.phone?.sendBinary(frame);
        }

        return;
      case 'audio':
        if (message.mic !== this.#mic || (message.halfDuplex ?? null) !== this.#halfDuplex || (message.fullDuplex ?? null) !== this.#fullDuplex || message.recognizer !== this.#recognizer || (message.roomHold ?? null) !== this.#roomHoldUntil) {
          this.#mic = message.mic;
          this.#halfDuplex = message.halfDuplex ?? null;
          this.#fullDuplex = message.fullDuplex ?? null;
          this.#recognizer = message.recognizer;
          this.#roomHoldUntil = message.roomHold ?? null;
          this.viewsChanged();
        }

        // Mic on as the hub saw it: from the command to the voice process's first state past starting.
        if (this.#micAsked !== null && message.mic !== 'off' && message.mic !== 'starting') {
          this.deps.log(`voice: mic on from ${this.#micAsked.from} → ${message.mic} in ${Math.round(this.deps.now() - this.#micAsked.at)} ms`);
          this.#micAsked = null;
        }

        if (message.error !== this.#audioError) {
          this.#audioError = message.error;

          if (message.error !== null) {
            this.deps.log(`voice: ${message.error}`);
          }

          this.viewsChanged();
          this.deps.dockChanged();
        }

        return;
      default:
        return;
    }
  }

  /** Starts the process while it is wanted, restarting it after a crash at most once a minute, and stops it 10 minutes after it is not. */
  #demand(wanted: boolean): void {
    if (!wanted) {
      if (this.#client !== null && this.#linger === null) {
        this.#linger = this.#timer(() => {
          this.#linger = null;
          this.deps.log('stopped the voice process: no window has wanted it for 10 minutes');
          this.#client = null;
          this.deps.link.stop();
        }, VOICE_LINGER_MS);
      }

      this.#clear('restart');
      return;
    }

    this.#clear('linger');

    if (this.#client !== null || this.#starting || this.#restart !== null) {
      return;
    }

    const wait = this.#lastStart + VOICE_RESTART_MS - this.deps.now();

    if (wait > 0) {
      this.#restart = this.#timer(() => {
        this.#restart = null;
        this.update();
      }, wait);
      return;
    }

    void this.#start();
  }

  async #start(): Promise<void> {
    this.#starting = true;
    this.#lastStart = this.deps.now();

    const found = await this.deps.link.find();

    this.#starting = false;

    if (this.#closed) {
      if (!('error' in found)) {
        found.close();
      }

      return;
    }

    if ('error' in found) {
      if (this.#enrollment.state === 'starting') {
        this.#enrollment = { state: 'failed', endsAt: null, error: found.error };
        this.deps.dockChanged();
      }

      if (this.#processError !== found.error) {
        this.#processError = found.error;
        this.deps.log(`voice: ${found.error}`);
        this.deps.dockChanged();
      }

      this.update();
      return;
    }

    this.#client = found;
    this.#processError = null;
    this.#targetsSent = '';
    found.onClose(() => {
      if (this.#client !== found) {
        return;
      }

      this.#client = null;
      this.#processError = 'The voice process stopped; it is started again within a minute.';
      this.deps.log('voice: the voice process stopped');
      this.#lost();
      this.deps.dockChanged();
      this.update();
    });
    found.onMessage((message) => this.#receive(message));
    found.send({ type: 'settings', settings: this.deps.settings() });

    if (this.#device !== 'computer') {
      found.send({ type: 'device', device: this.#device });
    }

    if (this.#device === 'phone' && !this.#phoneBusy) {
      found.send({ type: 'phone-state', busy: false });
    }

    this.#typingSent = null;
    this.#contextSent.clear();

    if (this.#micOn) {
      // A restore: the process keeps the mic off if it turned it off on its own while no hub heard it, as for a lock.
      found.send({ type: 'mic', on: true, restore: true });
    }

    if (this.#enrollment.state === 'starting') {
      found.send({ type: 'enroll', action: 'start' });
    }

    this.deps.dockChanged();
    this.update();
    this.#offerHeld();
  }

  /** The process is gone, so nothing it was speaking will play. */
  #lost(): void {
    if (this.#enrolling()) {
      this.#enrollment = { state: 'failed', endsAt: null, error: 'The voice process stopped.' };
    }

    for (const [replyId, offered] of this.#offered) {
      this.#logSpeech(replyId, offered, 'failed: the voice process stopped', offered.atMs, offered.said);
      this.#setState(replyId, 'failed', null, null);
    }

    this.#offered.clear();
    this.#playing.clear();
    this.#heard.clear();

    // Its alerts are gone with it; one not sent yet goes to the next process.
    for (const [sessionId, alert] of [...this.#alerts]) {
      if (alert.timer === null) {
        this.#alerts.delete(sessionId);
      }
    }

    this.#dropTerminalDrafts('the voice process stopped');
    this.#stopFlush();

    // Its phone capture is gone with it: the phone stops sending.
    if (this.#phoneCapture) {
      this.#phoneCapture = false;
      this.deps.phone?.send({ type: 'capture', on: false });
    }

    this.#mic = 'off';
    this.#halfDuplex = null;
    this.#recognizer = null;
    this.#roomHoldUntil = null;
    this.#fullDuplex = null;
    this.#target = { gen: this.#target.gen, sessionId: null };
    this.viewsChanged();
  }

  /** What became of an offered reply's speech, in the hub log beside the voice process's own line in voice.log. */
  #logSpeech(replyId: string, offered: Offered, outcome: string, atMs: number | null, said: number | null): void {
    this.deps.log(`voice: reply ${replyId} of session ${offered.sessionId} ${outcome}, voice ${offered.voice}, ${atMs ?? 0} ms played, ${said ?? 0} characters said`);
  }

  #timer(run: () => void, ms: number): unknown {
    return this.deps.setTimer === undefined ? setTimeout(run, ms) : this.deps.setTimer(run, ms);
  }

  #clear(which: 'linger' | 'restart'): void {
    const timer = which === 'linger' ? this.#linger : this.#restart;

    if (timer !== null) {
      if (this.deps.clearTimer === undefined) {
        clearTimeout(timer as NodeJS.Timeout);
      } else {
        this.deps.clearTimer(timer);
      }
    }

    if (which === 'linger') {
      this.#linger = null;
    } else {
      this.#restart = null;
    }
  }
}

function every(run: () => void, ms: number): { stop(): void } {
  const timer = setInterval(run, ms);

  timer.unref();
  return { stop: () => clearInterval(timer) };
}
