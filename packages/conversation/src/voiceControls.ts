/**
 * The composer's voice controls, drawn alike by the VS Code Conversation view and the web page (architecture.md § Voice, § Dictation): the mic
 * button with its states, Speak replies, Stop and Talk here. Both control the computer's one voice process through the hub. Imports nothing, for
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
export const DEVICE_OFF_TIP = 'Voice is off: the phone that had it left, so replies are not spoken. Click to speak them on this computer; the mic stays off.';
/** The mic's tooltip while a room hold keeps dictation in the box. */
export const ROOM_HOLD_TIP = 'Held: someone else is talking in the room, so dictation stays in the box until you press Enter.';

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The composer footer's voice controls (architecture.md § Voice), ghost icon buttons as in Claude Code's footer, in one cluster with the mic
 * beside Send: Stop while this window's session speaks and Speak replies as a speaker toggle while the voice is here; one Talk here in their
 * place while it is elsewhere, only for a session it can speak for (`live`). Nothing while voice is off. `place` names where it is drawn: a VS Code
 * window or the web page, which control the same voice process on this computer. While the voice is here but no device has it, after the phone
 * left, "Voice is off — Talk here" stands before Speak replies, so a reply is not skipped unnoticed.
 */
export function renderVoiceControls(voice: VoiceControlsView | null, live = true, place: VoicePlace = 'window'): string {
  if (voice === null || !voice.enabled) {
    return '';
  }

  const icon = (name: string, title: string, data: string, extra = ''): string =>
    `<button class="ghost icon" type="button" data-key="voice-${data}" data-voice="${data}" title="${escape(title)}" aria-label="${escape(title)}"${extra}><span class="codicon codicon-${name}" aria-hidden="true"></span></button>`;
  const speakReplies = icon(
    voice.speakReplies ? 'unmute' : 'mute',
    voice.speakReplies ? 'Speak replies: on. Click to stop speaking replies.' : 'Speak replies: off. Click to speak replies.',
    'speak-replies',
    ` aria-pressed="${voice.speakReplies}"`,
  );
  const stop = voice.here && voice.speaking !== null ? icon('debug-stop', 'Stop speaking (Escape)', 'stop') : '';
  const talkHere =
    !voice.here && live
      ? `<button class="ghost talk-here" type="button" data-key="voice-talk-here" data-voice="talk-here" title="The voice is not ${place === 'page' ? 'on this page' : 'in this window'}. Click to move it here.">Talk here</button>`
      : '';

  const deviceOff =
    voice.here && voice.deviceOff === true
      ? `<button class="ghost talk-here" type="button" data-key="voice-talk-here" data-voice="talk-here" title="${escape(DEVICE_OFF_TIP)}">Voice is off — Talk here</button>`
      : '';

  return voice.here ? `${deviceOff}${stop}${speakReplies}` : talkHere;
}

/** A mic glyph: slashed while off, outlined, or filled; with a badge while paused, or while half-duplex capture holds it for a reply playing. */
function micGlyph(kind: 'off' | 'outline' | 'filled', badge: 'pause' | 'held' | null = null): string {
  const mic = `<span class="codicon codicon-${kind === 'filled' ? 'mic-filled' : 'mic'}" aria-hidden="true"></span>`;
  const mark = badge === null ? '' : `<span class="mic-badge ${badge}" aria-hidden="true"><span class="codicon codicon-${badge === 'pause' ? 'debug-pause' : 'unmute'}"></span></span>`;

  return `<span class="mic-glyph ${kind}">${mic}${mark}</span>`;
}

/**
 * The composer's one mic button (architecture.md § Dictation), whose glyph and tooltip carry the mic's state, each drawn apart: a slashed mic while
 * off, unavailable or in a window the voice is not in, whose click talks here and turns the mic on; an outlined mic after the idle timeout; a
 * filled mic in the accent colour that pulses while it listens, faster while it hears, and still while it starts; a pause badge while the composer
 * has the focus or another app records; and a speaker badge while half-duplex capture holds it for a reply playing. While the mic is on, in any
 * state, a click turns it off. Empty with voice off.
 */
export function renderMicButton(voice: VoiceControlsView | null): string {
  if (voice === null || !voice.enabled) {
    return '';
  }

  const button = (glyph: string, title: string, on: boolean, kind: string): string =>
    `<button class="mic ${kind}" type="button" data-voice="mic" data-on="${on}" title="${escape(title)}" aria-label="${escape(title)}" aria-pressed="${!on}">${glyph}</button>`;

  // While the voice is elsewhere, Talk here takes the cluster's place (renderVoiceControls).
  if (!voice.here) {
    return '';
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
    case 'starting':
      return button(micGlyph('filled'), 'Mic starting. Click to turn it off.', false, 'starting');
    case 'paused-other-app':
      return button(micGlyph('outline', 'pause'), `Mic paused: another app is using the microphone.${where} Click to turn the mic off.`, false, 'paused');
    case 'paused-by-voice':
      // Only "start listening" is heard: a click listens again rather than turning the mic off.
      return button(micGlyph('outline', 'pause'), `Mic ${PAUSED_BY_VOICE_TIP.charAt(0).toLowerCase()}${PAUSED_BY_VOICE_TIP.slice(1)}`, true, 'paused');
    case 'unavailable':
      // The mic is on but cannot run: a click turns it off, and turning it on again tries again.
      return button(micGlyph('off'), `Mic on but unavailable: ${voice.error ?? 'unknown error'} Click to turn the mic off.`, false, 'unavailable');
    case 'idle-off':
      return button(micGlyph('outline'), 'Mic off after a quiet spell. Click to turn it on (Ctrl+Alt+M).', true, 'idle');
    default:
      return button(micGlyph('off'), 'Mic off. Click to turn it on (Ctrl+Alt+M).', true, 'off');
  }
}
