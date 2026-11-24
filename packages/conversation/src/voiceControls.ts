/**
 * The composer's voice controls, drawn by the web page (architecture.md § Voice, § Dictation): the mic
 * button with its states, Speak replies and Talk here. They control the computer's one voice process through the hub. Imports nothing, for
 * browser bundles.
 */

/** The fields of a window's or a page's `VoiceView` the controls read. */
export interface VoiceControlsView {
  enabled: boolean;
  here: boolean;
  mic?: string;
  speaking: string | null;
  speakReplies: boolean;
  error: string | null;
  recognizer?: 'gpu' | 'cpu' | null;
  halfDuplex?: string;
  fullDuplex?: string;
  roomHold?: boolean;
  /** The voice is here but no device has it, after the phone left: nothing plays or listens until it is taken back. */
  deviceOff?: boolean;
}

/** Where the controls are drawn, which their Talk here tooltip names. */
export type VoicePlace = 'window' | 'page';

/** The mic's tooltip while the operator paused it by voice. */
export const PAUSED_BY_VOICE_TIP = 'Paused: you said "stop listening". Say "start listening", or click to listen again.';
/** Talk here's tooltip while the voice is here but no device has it. */
export const DEVICE_OFF_TIP = 'Voice is off. Click to use it on this computer.';
/** Speak replies' tooltip while it is on and this window's session speaks: its click stops the reply too. */
export const SPEAKING_TIP = 'Speak replies: on. Click to stop and stop speaking replies (Escape stops only this reply).';
/** The speaker's tooltip while Speak replies is off and a Replay plays: its click stops the Replay and leaves Speak replies off. */
export const REPLAY_TIP = 'Speak replies: off. Click to stop this replay (Escape).';
/** The mic's tooltip while a room hold keeps dictation in the box. */
export const ROOM_HOLD_TIP = 'Dictation is waiting after another voice was detected. Press Enter to send it.';

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The composer footer's voice controls (architecture.md § Voice), ghost icon buttons as in Claude Code's footer, in one cluster with the mic
 * beside Send: Speak replies as a speaker toggle while the voice is here, which also stops the reply playing, so the composer has no separate Stop
 * (Escape stops speaking from the keyboard); one Talk here in its place while it is elsewhere, only for a session it can speak for (`live`). Nothing while voice is off. `place` names where it is drawn, for
 * the Talk here tooltip; the web page passes `page`. Every page controls the same voice process on this computer. While the voice is here but no device has it, after the phone
 * left, "Voice is off — Talk here" stands before Speak replies, so a reply is not skipped unnoticed.
 */
export function renderVoiceControls(voice: VoiceControlsView | null, live = true, place: VoicePlace = 'window'): string {
  if (voice === null || !voice.enabled) {
    return '';
  }

  const icon = (name: string, title: string, data: string, extra = ''): string =>
    `<button class="ghost icon" type="button" data-key="voice-${data}" data-voice="${data}" title="${escape(title)}" aria-label="${escape(title)}"${extra}><span class="codicon codicon-${name}" aria-hidden="true"></span></button>`;
  // While this window's session speaks, a click stops the reply: turning Speak replies off stops it with everything offered (the hub sends `stop`
  // first), and while it is off, a reply still plays only as a Replay, which the click stops, leaving Speak replies off.
  const speaking = voice.here && voice.speaking !== null;
  const speakReplies = voice.speakReplies
    ? icon('unmute', speaking ? SPEAKING_TIP : 'Speak replies: on. Click to stop speaking replies.', 'speak-replies', ' aria-pressed="true"')
    : speaking
      ? icon('mute', REPLAY_TIP, 'stop')
      : icon('mute', 'Speak replies: off. Click to speak replies.', 'speak-replies', ' aria-pressed="false"');
  const talkHere =
    !voice.here && live
      ? `<button class="ghost talk-here" type="button" data-key="voice-talk-here" data-voice="talk-here" title="Click to use voice for this session.">Talk here</button>`
      : '';

  const deviceOff =
    voice.here && voice.deviceOff === true
      ? `<button class="ghost talk-here" type="button" data-key="voice-talk-here" data-voice="talk-here" title="${escape(DEVICE_OFF_TIP)}">Talk here</button>`
      : '';

  return voice.here ? `${deviceOff}${speakReplies}` : talkHere;
}

/** A mic glyph: slashed while off, outlined, or filled; with a badge while paused, or while half-duplex capture holds it for a reply playing; ringed while it starts. */
function micGlyph(kind: 'off' | 'outline' | 'filled', badge: 'pause' | 'held' | 'ring' | null = null): string {
  const mic = `<span class="codicon codicon-${kind === 'filled' ? 'mic-filled' : 'mic'}" aria-hidden="true"></span>`;
  const mark =
    badge === null
      ? ''
      : badge === 'ring'
        ? '<span class="mic-ring" aria-hidden="true"></span>'
        : `<span class="mic-badge ${badge}" aria-hidden="true"><span class="codicon codicon-${badge === 'pause' ? 'debug-pause' : 'unmute'}"></span></span>`;

  return `<span class="mic-glyph ${kind}">${mic}${mark}</span>`;
}

/** The mic button's tooltip from the tap that turns the mic on until the voice process says it listens. */
export const MIC_STARTING_TIP = 'Starting microphone… Click to turn it off.';

/** The mic states in which a tap's Mic on is not yet confirmed: the voice process has not opened capture, or the hub has not heard of the tap. */
const UNCONFIRMED = new Set<string | undefined>([undefined, 'off', 'idle-off', 'starting']);

/** Why a start the voice view never confirmed failed. */
export const MIC_START_TIMEOUT = 'The mic did not start within 30 seconds.';

/** What the page or the view knows of its own Mic on tap before the voice view confirms it: starting, or why it failed. */
export type MicPending = 'starting' | { error: string } | null;

/**
 * A tap's Mic on until the voice view confirms it (architecture.md § Dictation): the button shows starting from the tap, before the hub or the
 * voice process answers, and the error if the tap failed. Ends when the voice view's mic leaves the unconfirmed states, when it falls back to off
 * after the voice process said starting, or fails after `limitMs`. A failure answered for an earlier attempt changes nothing.
 */
export class MicStart {
  pending: MicPending = null;
  #sawStarting = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly changed: () => void,
    private readonly limitMs = 30_000,
  ) {}

  #attempt = 0;

  /** Starts an attempt, and returns it for its failure. */
  start(): number {
    this.#clearTimer();
    this.pending = 'starting';
    this.#sawStarting = false;

    const attempt = ++this.#attempt;

    this.#timer = setTimeout(() => {
      this.#timer = null;

      if (this.pending === 'starting') {
        this.pending = { error: MIC_START_TIMEOUT };
        this.changed();
      }
    }, this.limitMs);

    return attempt;
  }

  /** The attempt failed; one still starting shows why. False for an attempt a later start or clear ended, whose failure is not shown. */
  fail(error: string, attempt = this.#attempt): boolean {
    if (attempt !== this.#attempt) {
      return false;
    }

    if (this.pending === 'starting') {
      this.#clearTimer();
      this.pending = { error };
    }

    return true;
  }

  /** Mic off, or the page left: ends the attempt. */
  clear(): void {
    this.#clearTimer();
    this.#attempt++;
    this.pending = null;
  }

  /** The voice view's mic while the voice is here; ends a pending start it confirms or ends. */
  view(mic: string | undefined): void {
    if (this.pending === null) {
      return;
    }

    if (this.pending === 'starting' && mic === 'starting') {
      this.#sawStarting = true;
      return;
    }

    if (!UNCONFIRMED.has(mic) || (this.pending === 'starting' && this.#sawStarting && (mic === 'off' || mic === 'idle-off'))) {
      this.#clearTimer();
      this.pending = null;
    }
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

/**
 * The composer's one mic button (architecture.md § Dictation), whose glyph and tooltip carry the mic's state, each drawn apart: a slashed mic while
 * off, unavailable or in a window the voice is not in, whose click talks here and turns the mic on; an outlined mic after the idle timeout; a
 * filled mic in the accent colour that pulses while it listens, faster while it hears, and ringed by a turning arc while it starts, from the
 * tap until the voice process listens (`pending`, from MicStart), or a slashed mic in the warning colour when the tap failed; a pause badge while the composer
 * has the focus or another app records; and a speaker badge while half-duplex capture holds it for a reply playing. While the mic is on, in any
 * state, a click turns it off. Empty with voice off.
 */
export function renderMicButton(voice: VoiceControlsView | null, pending: MicPending = null): string {
  if (voice === null || !voice.enabled) {
    return '';
  }

  const button = (glyph: string, title: string, on: boolean, kind: string, extra = ''): string =>
    `<button class="mic ${kind}" type="button" data-voice="mic" data-on="${on}" title="${escape(title)}" aria-label="${escape(title)}" aria-pressed="${!on}"${extra}>${glyph}</button>`;

  // While the voice is elsewhere, Talk here takes the cluster's place (renderVoiceControls).
  if (!voice.here) {
    return '';
  }

  // The tap's own failure until the next tap, and from the tap until the voice process listens (MicStart).
  if (pending !== null && pending !== 'starting' && UNCONFIRMED.has(voice.mic)) {
    return button(micGlyph('off'), `The mic did not start: ${pending.error} Click to try again.`, true, 'unavailable');
  }

  if (voice.mic === 'starting' || (pending === 'starting' && UNCONFIRMED.has(voice.mic))) {
    return button(micGlyph('filled', 'ring'), MIC_STARTING_TIP, false, 'starting', ' aria-busy="true"');
  }

  // Where recognition runs, once the recogniser loaded; half-duplex capture does not listen while the voice speaks, and full duplex with no echo
  // cancellation says why it does (architecture.md § Dictation).
  const where = voice.recognizer === null ? '' : ` Speech recognition runs on the ${voice.recognizer === 'gpu' ? 'GPU' : 'CPU'}.`;
  const halfDuplex = voice.halfDuplex !== undefined ? ` Listening pauses while a reply plays (${voice.halfDuplex}), so talking over it does not stop it.` : voice.fullDuplex !== undefined ? ` Full duplex (${voice.fullDuplex}): talking over a reply stops it.` : '';
  // The room hold (architecture.md § Voice check and barge-in): spoken turns stay in the box.
  const held = voice.roomHold === true ? ` ${ROOM_HOLD_TIP}` : '';

  // Half-duplex capture holding the mic while this window's reply plays.
  if (voice.halfDuplex !== undefined && voice.speaking !== null && (voice.mic === 'listening' || voice.mic === 'hearing')) {
    return button(micGlyph('filled', 'held'), `Mic on, held while the reply plays (${voice.halfDuplex}): it listens again when the reply ends.${where} Click to turn the mic off.`, false, 'held');
  }

  switch (voice.mic) {
    case 'listening':
      return button(micGlyph('filled'), `Mic on: listening. ${held === '' ? 'Dictation sends when you stop talking.' : ROOM_HOLD_TIP}${where}${halfDuplex} Click to turn the mic off.`, false, 'listening');
    case 'hearing':
      return button(micGlyph('filled'), `Mic on: hearing you.${held}${where}${halfDuplex} Click to turn the mic off.`, false, 'hearing');
    case 'typing':
      return button(micGlyph('outline', 'pause'), `Mic paused while you type: dictation goes on when you send or leave the box.${where} Click to turn the mic off.`, false, 'paused');
    case 'paused-other-app':
      return button(micGlyph('outline', 'pause'), `Mic paused: another app is using the microphone.${where} Click to turn the mic off.`, false, 'paused');
    case 'paused-by-voice':
      // Only "start listening" is heard: a click listens again rather than turning the mic off.
      return button(micGlyph('outline', 'pause'), `Mic ${PAUSED_BY_VOICE_TIP.charAt(0).toLowerCase()}${PAUSED_BY_VOICE_TIP.slice(1)}`, true, 'paused');
    case 'unavailable':
      // The mic is on but cannot run: a click turns it off, and turning it on again tries again.
      return button(micGlyph('off'), `Mic on but unavailable: ${voice.error ?? 'unknown error'} Click to turn the mic off.`, false, 'unavailable');
    case 'idle-off':
      return button(micGlyph('outline'), 'Mic turned off after inactivity. Click to turn it on (Ctrl+Alt+M).', true, 'idle');
    default:
      return button(micGlyph('off'), 'Mic off. Click to turn it on (Ctrl+Alt+M).', true, 'off');
  }
}
