import { describe, expect, it } from 'vitest';
import { metaLine, stamped, toneMark, voiceMark } from '../src/messageMeta.js';

const at = new Date(2026, 10, 20, 9, 5, 7).getTime();

describe('the message meta line shared by the Conversation view and the web page', () => {
  it('stamps every timed item with message details on, and otherwise only the first after a day divider', () => {
    expect([stamped(true, true, false), stamped(true, false, true), stamped(true, false, false), stamped(false, true, true)]).toEqual([true, true, false, false]);
  });

  it('puts the marks left and the time right, or the time as the tooltip, and nothing with neither', () => {
    expect(metaLine(['<b>x</b>', ''], at, true)).toMatch(/^<div class="meta"><span class="meta-marks"><b>x<\/b><\/span><time class="stamp" datetime="[^"]+" title="2026-11-20 09:05:07 [^"]+">9:05 AM<\/time><\/div>$/);
    expect(metaLine(['<b>x</b>'], at, false)).toMatch(/^<div class="meta" title="2026-11-20 09:05:07 [^"]+"><span class="meta-marks"><b>x<\/b><\/span><\/div>$/);
    expect(metaLine([''], at, false)).toBe('');
  });

  it('marks a dictated message and a tone only with message details on, escaping their text', () => {
    const dictated = { origin: 'voice', partial: true, pieces: [{ text: 'a <b>', score: null, f0: null, dropped: true }], interrupted: { said: 'so' } };

    expect(voiceMark(dictated, false)).toBe('');
    expect(voiceMark({ origin: 'typed' }, true)).toBe('');
    expect(voiceMark(dictated, true)).toBe('<span class="voice-mark" title="Dictated in 1 piece:&#10;(dropped) a &#60;b&#62;&#10;Spoke over the reply after &#34;so&#34;.">'.replace(/&#10;/g, '\n') + '<span class="codicon codicon-mic" aria-hidden="true"></span><span>partial · interrupted the reply</span></span>');
    expect(voiceMark({ origin: 'voice', interrupted: { said: '' } }, true)).toContain('title="Dictated\nSpoke over the reply before its first words."');
    expect(toneMark('calm', false)).toBe('');
    expect(toneMark(null, true)).toBe('');
    expect(toneMark('<calm>', true)).toBe('<span class="tone" title="How the reply sounds when spoken: &#60;calm&#62;">&#60;calm&#62;</span>');
  });
});
