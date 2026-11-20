import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pcmToSamples, sherpaEngine, Transcriber } from '../src/asr.js';
import { FakeEngine } from './fakes.js';

const CHUNK = new Float32Array(1600);

function setup() {
  const engine = new FakeEngine();
  const events: string[] = [];
  const audios: Float32Array[] = [];
  const transcriber = new Transcriber(engine, { onWords: (text) => events.push(`words ${text}`), onPiece: (text, audio) => {
      events.push(`piece ${text}`);
      audios.push(audio);
    }, onQuiet: () => events.push('quiet') });
  const feed = (text: string, chunks = 1): void => {
    engine.text = text;

    for (let index = 0; index < chunks; index++) {
      transcriber.feed(CHUNK);
    }
  };

  return { engine, events, audios, transcriber, feed };
}

describe('Transcriber', () => {
  it('reports live words, a quiet after 0.4 s and a piece after 1.2 s, and only the words since the last piece', () => {
    const { events, transcriber, feed } = setup();

    feed('hello there');
    feed('hello there', 4);
    expect(events).toEqual(['words hello there', 'quiet']);
    feed('hello there', 8);
    expect(events.slice(2)).toEqual(['piece hello there', 'words ']);
    feed('hello there world');
    expect(events.slice(4)).toEqual(['words world']);
    expect(transcriber.words).toBe('world');
    expect(transcriber.take()).toMatchObject({ text: 'world' });
    expect(transcriber.take()).toBeNull();
  });

  it('drains the words the model held back, and starts each message on a fresh stream, with the last half second unless told not to', () => {
    const { engine, transcriber, feed } = setup();

    feed('rename the', 3);
    engine.held = 'button';
    transcriber.drain();
    expect(transcriber.take()).toMatchObject({ text: 'rename the button' });
    transcriber.end();
    expect(engine.streams).toBe(2);
    expect(transcriber.words).toBe('');
    transcriber.end(false);
    expect(engine.streams).toBe(3);
    expect(transcriber.total).toBe(4800);
  });

  it('gives a piece the audio since the last piece, at least the last 4 s and at most the last 8 s, for the voice check', () => {
    const { audios, transcriber, feed } = setup();

    feed('hello', 13);
    expect(audios.map((audio) => audio.length)).toEqual([20_800]);
    feed('hello', 100);
    feed('hello there', 13);
    // 11 s since the first piece: the last 8 s, all the ring keeps.
    expect(audios.map((audio) => audio.length)).toEqual([20_800, 128_000]);
    feed('hello there again', 13);
    expect(audios[2]!.length).toBe(64_000);
    feed('hello there again', 1);
    expect(transcriber.take()).toBeNull();
    expect(transcriber.samples(transcriber.total - 3200).length).toBe(3200);
    expect(transcriber.samples(0).length).toBe(128_000);
  });

  it('starts recognition again from a barge-in\'s onset, and keeps the audio before it out of the next piece\'s voice check', () => {
    const { engine, audios, transcriber, feed } = setup();

    feed('the session token is', 30);
    expect(engine.streams).toBe(1);
    transcriber.restartFrom(transcriber.total - 8000);
    expect([engine.streams, transcriber.words]).toEqual([2, '']);
    feed('hold on', 13);
    expect(transcriber.words).toBe('');
    expect(audios.at(-1)!.length).toBe(8000 + 13 * 1600);
    transcriber.end();
    feed('next', 13);
    // After the message ends, a piece's audio is no longer cut at the onset.
    expect(audios.at(-1)!.length).toBe(64_000);
  });

  it('reads 16-bit PCM as samples from -1 to 1', () => {
    const pcm = Buffer.alloc(6);

    pcm.writeInt16LE(-32768, 0);
    pcm.writeInt16LE(16384, 2);
    pcm.writeInt16LE(0, 4);
    expect([...pcmToSamples(pcm)]).toEqual([-1, 0.5, 0]);
  });
});

describe('sherpaEngine', () => {
  it('says why it cannot run: no model in the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asr-'));

    try {
      expect(sherpaEngine(dir, { bpeVocab: 'x', hotwordsFile: null }, join(dir, 'x.js'))).toEqual({ error: `No speech recognition model in ${dir}.` });
      writeFileSync(join(dir, 'encoder.int8.onnx'), '');
      expect(sherpaEngine(dir, { bpeVocab: 'x', hotwordsFile: null }, join(dir, 'x.js'))).toMatchObject({ error: expect.stringMatching(/^Speech recognition is not available: /) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
