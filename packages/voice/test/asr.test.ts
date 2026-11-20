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
  const transcriber = new Transcriber(engine, { onWords: (text) => events.push(`words ${text}`), onPiece: (text) => events.push(`piece ${text}`), onQuiet: () => events.push('quiet') });
  const feed = (text: string, chunks = 1): void => {
    engine.text = text;

    for (let index = 0; index < chunks; index++) {
      transcriber.feed(CHUNK);
    }
  };

  return { engine, events, transcriber, feed };
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
    expect(transcriber.take()).toBe('world');
    expect(transcriber.take()).toBeNull();
  });

  it('drains the words the model held back, and starts each message on a fresh stream, with the last half second unless told not to', () => {
    const { engine, transcriber, feed } = setup();

    feed('rename the', 3);
    engine.held = 'button';
    transcriber.drain();
    expect(transcriber.take()).toBe('rename the button');
    transcriber.end();
    expect(engine.streams).toBe(2);
    expect(transcriber.words).toBe('');
    transcriber.end(false);
    expect(engine.streams).toBe(3);
    expect(transcriber.total).toBe(4800);
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
