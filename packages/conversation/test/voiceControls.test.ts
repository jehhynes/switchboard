import { describe, expect, it } from 'vitest';
import { DEVICE_OFF_TIP, ELSEWHERE_TIP, renderMicButton, renderVoiceControls } from '../src/voiceControls.js';
import type { VoiceControlsView } from '../src/voiceControls.js';

const voice = (patch: Partial<VoiceControlsView> = {}): VoiceControlsView => ({ enabled: true, here: true, mic: 'off', speaking: null, speakReplies: false, error: null, recognizer: null, ...patch });
const attr = (html: string, name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];

describe('renderMicButton', () => {
  it('names each on state first in the accessible name, with no visible label, and leaves an off mic named by its tooltip', () => {
    const cases: Array<[Partial<VoiceControlsView>, string | null, string]> = [
      [{ mic: 'listening' }, 'Listening', 'listening'],
      [{ mic: 'hearing' }, 'Hearing', 'hearing'],
      [{ mic: 'starting' }, 'Starting', 'starting'],
      [{ mic: 'typing' }, 'Paused', 'paused'],
      [{ mic: 'paused-other-app' }, 'Paused', 'paused'],
      [{ mic: 'paused-by-voice' }, 'Paused', 'paused'],
      [{ mic: 'unavailable', error: 'No microphone found.' }, 'Mic unavailable', 'unavailable'],
      [{ mic: 'listening', speaking: 'r1', halfDuplex: 'Windows' }, 'Paused', 'held'],
      [{ mic: 'off' }, null, 'off'],
      [{ mic: 'idle-off' }, null, 'idle'],
    ];

    for (const [patch, name, kind] of cases) {
      const html = renderMicButton(voice(patch));

      expect(attr(html, 'class')).toBe(`mic ${kind}`);
      expect(attr(html, 'aria-label')).toBe(name === null ? attr(html, 'title') : `${name}. ${attr(html, 'title')}`);
      expect(html.replace(/<[^>]*>/g, '')).toBe('');
    }

    expect(attr(renderMicButton(voice(), { error: 'Denied.' }), 'aria-label')).toBe('Mic failed. The mic did not start: Denied. Click to try again.');
  });

  it('draws the mic off while the voice is on another session or device, whatever its state there, so one tap takes the voice here with the mic on', () => {
    for (const mic of ['off', 'listening', 'hearing', 'unavailable', 'typing']) {
      const html = renderMicButton(voice({ here: false, mic, speaking: 'r1', error: 'No microphone found.', roomHold: true }));

      expect([attr(html, 'class'), attr(html, 'data-on'), attr(html, 'title')]).toEqual(['mic off', 'true', ELSEWHERE_TIP]);
    }

    // A tap there shows starting until the voice view confirms it, and its failure.
    expect(attr(renderMicButton(voice({ here: false, mic: 'listening' }), 'starting'), 'class')).toBe('mic starting');
    expect(attr(renderMicButton(voice({ here: false }), { error: 'Voice is on another device.' }), 'class')).toBe('mic unavailable');
    // After the phone left, the mic says the voice is off and takes it back.
    expect(attr(renderMicButton(voice({ deviceOff: true })), 'title')).toBe(DEVICE_OFF_TIP);
    expect(renderMicButton(voice({ enabled: false }))).toBe('');
  });
});

describe('renderVoiceControls', () => {
  it('draws no Talk here: nothing while the voice is elsewhere or no device has it, and Spoken replies only while it is here', () => {
    expect(renderVoiceControls(voice({ here: false, speakReplies: true }))).toBe('');
    expect(renderVoiceControls(voice({ deviceOff: true }))).toBe('');
    expect(renderVoiceControls(voice({ deviceOff: true, speakReplies: true }))).toContain('data-voice="speak-replies"');
    expect(renderVoiceControls(voice({ speakReplies: true }))).not.toContain('talk-here');
  });
});
