import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loudness, normalize, pitch, pitchTooHigh, sherpaEmbedder, TTS_PRINTS_FILE, VOICEPRINT_FILE, Voiceprint } from '../src/voiceprint.js';
import type { SherpaRuntime } from '../src/sherpa.js';
import type { Embedder } from '../src/voiceprint.js';

const RATE = 16_000;
const SETTINGS = { matchThreshold: 0.6, pitchLowFactor: 1.22, pitchMinLowShare: 0.2 };

/** `seconds` of a voice-like tone at `hz`: three harmonics with a slight vibrato, so its period, not a multiple of it, correlates best. */
function tone(seconds: number, hz: number, amplitude = 0.3): Float32Array {
  let phase = 0;

  return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, index) => {
    phase += (2 * Math.PI * hz * (1 + 0.03 * Math.sin((2 * Math.PI * 5 * index) / RATE))) / RATE;
    return (amplitude * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase))) / 1.8;
  });
}

/** An embedder that reads loud audio as the enrolled voice, [1, 0], and quiet audio as another, [0, 1]; a fixed vector when given one. */
function fakeEmbedder(fixed?: number[]): Embedder & { calls: number } {
  const embedder = {
    calls: 0,
    embed: (samples: Float32Array) => {
      embedder.calls++;
      return samples.length < RATE / 2 ? null : normalize(fixed ?? (loudness(samples) > 0.1 ? [1, 0] : [0, 1]));
    },
  };

  return embedder;
}

function home(): string {
  return mkdtempSync(join(tmpdir(), 'sb-voiceprint-'));
}

describe('pitch', () => {
  it('reads a voice\'s pitch from its voiced frames, and none from silence', () => {
    const low = pitch(tone(1, 120));
    const high = pitch(tone(1, 300));

    expect(low.median).toBeGreaterThanOrEqual(118);
    expect(low.median).toBeLessThanOrEqual(122);
    expect(low.voiced).toBeGreaterThanOrEqual(40);
    expect(high.median).toBeGreaterThanOrEqual(296);
    expect(high.median).toBeLessThanOrEqual(304);
    expect(pitch(new Float32Array(RATE))).toMatchObject({ median: null, voiced: 0 });
  });

  it('counts a clip too high only with enough voiced frames, too few of them at or under the low factor times the enrolled p90', () => {
    const enrolled = { median: 110, p10: 95, p90: 131, voiced: 300 };

    expect(pitchTooHigh(pitch(tone(1, 300)), enrolled, SETTINGS)).toBe(true);
    expect(pitchTooHigh(pitch(tone(1, 150)), enrolled, SETTINGS)).toBe(false);
    // 150 Hz is over 1.22 × 100, the low limit of an enrolled p90 of 100.
    expect(pitchTooHigh(pitch(tone(1, 150)), { ...enrolled, p90: 100 }, SETTINGS)).toBe(true);
    expect(pitchTooHigh(pitch(tone(1, 300)), enrolled, { ...SETTINGS, pitchMinLowShare: 0 })).toBe(false);
    expect(pitchTooHigh(pitch(tone(0.3, 300)), enrolled, SETTINGS)).toBe(false);
    expect(pitchTooHigh(pitch(tone(1, 300)), null, SETTINGS)).toBe(false);
  });
});

describe('Voiceprint', () => {
  it('passes every piece unscored until a voice is enrolled', () => {
    const embedder = fakeEmbedder();
    const voiceprint = new Voiceprint({ dir: home(), embedder: () => embedder, log: () => undefined });

    expect(voiceprint.enrolled).toBe(false);
    expect(voiceprint.check(tone(2, 300, 0.01), 'someone else talking', SETTINGS)).toEqual({ score: null, f0: null, dropped: false, reason: null });
    expect(embedder.calls).toBe(0);
  });

  it('enrols from 3 s windows, saves the print with its pitch range and level, and a new process reads it back', () => {
    const dir = home();
    const voiceprint = new Voiceprint({ dir, embedder: () => fakeEmbedder(), log: () => undefined, now: () => Date.parse('2026-11-20T10:00:00Z') });
    const result = voiceprint.enroll(tone(13, 120));
    const saved = JSON.parse(readFileSync(join(dir, VOICEPRINT_FILE), 'utf8')) as Record<string, unknown>;

    expect(result.windows).toBe(4);
    expect(result.f0).toBeGreaterThanOrEqual(118);
    expect(saved).toMatchObject({ at: '2026-11-20T10:00:00.000Z', windows: 4, vector: [1, 0], pitch: { median: result.f0, voiced: expect.any(Number) } });
    expect(saved['level']).toBeCloseTo(loudness(tone(13, 120)), 4);

    const reread = new Voiceprint({ dir, embedder: () => fakeEmbedder(), log: () => undefined });

    expect([reread.enrolled, reread.enrolledAt, reread.enrolledPitch?.p90]).toEqual([true, '2026-11-20T10:00:00.000Z', (saved['pitch'] as { p90: number }).p90]);
    expect(reread.level).toBeCloseTo(loudness(tone(13, 120)), 4);
  });

  it('refuses an enrolment under 9 s of windows or without the model, keeping the print it had', () => {
    const dir = home();
    const voiceprint = new Voiceprint({ dir, embedder: () => fakeEmbedder(), log: () => undefined });

    expect(() => voiceprint.enroll(tone(8, 120))).toThrow('The recording was too short: speak for at least 9 seconds.');
    expect(voiceprint.enrolled).toBe(false);

    const missing = new Voiceprint({ dir, embedder: () => ({ error: 'No speaker model at x.' }), log: () => undefined });

    expect(missing.unavailable()).toBe('No speaker model at x.');
    expect(() => missing.enroll(tone(13, 120))).toThrow('No speaker model at x.');
  });

  it('drops a piece under the match threshold or pitched too high, gives one or two words a lower bar, and passes audio too short to score', () => {
    const dir = home();

    new Voiceprint({ dir, embedder: () => fakeEmbedder(), log: () => undefined }).enroll(tone(13, 120));

    const voiceprint = new Voiceprint({ dir, embedder: () => fakeEmbedder(), log: () => undefined });
    const mine = voiceprint.check(tone(2, 120), 'fix the login flow', SETTINGS);

    expect(mine).toMatchObject({ score: 1, dropped: false, reason: null });
    expect(mine.f0).toBeGreaterThanOrEqual(118);
    expect(voiceprint.check(tone(2, 110, 0.05), 'fix the login flow', SETTINGS)).toMatchObject({ score: 0, dropped: true, reason: 'score' });
    expect(voiceprint.check(tone(2, 300), 'fix the login flow', SETTINGS)).toMatchObject({ score: 1, dropped: true, reason: 'pitch' });
    expect(voiceprint.check(tone(0.5, 110, 0.05), 'yes', SETTINGS)).toMatchObject({ score: null, dropped: false });
    expect(voiceprint.check(tone(2, 120), 'fix the login flow', { ...SETTINGS, matchThreshold: 1 })).toMatchObject({ dropped: false });

    const half = new Voiceprint({ dir, embedder: () => fakeEmbedder([1, 1.732]), log: () => undefined });

    // A score of 0.5 fails a sentence and passes two words, whose bar is 0.45.
    expect(half.check(tone(2, 120), 'fix the login flow', SETTINGS)).toMatchObject({ score: 0.5, dropped: true, reason: 'score' });
    expect(half.check(tone(2, 120), 'ship it', SETTINGS)).toMatchObject({ score: 0.5, dropped: false });
  });

  it('fails an enrolment whose print cannot be saved and keeps the print it had', () => {
    const dir = home();

    writeFileSync(join(dir, 'blocked'), '');

    const voiceprint = new Voiceprint({ dir: join(dir, 'blocked'), embedder: () => fakeEmbedder(), log: () => undefined });

    expect(() => voiceprint.enroll(tone(13, 120))).toThrow(/^The voiceprint could not be saved: /);
    expect(voiceprint.enrolled).toBe(false);
  });

  it('reads a print claude-collab enrolled, which has no level, and ignores an unreadable one', () => {
    const dir = home();

    writeFileSync(join(dir, VOICEPRINT_FILE), JSON.stringify({ at: '2026-11-18T09:00:00.000Z', windows: 20, vector: [0, 1], pitch: { median: 107, p10: 90, p90: 131, voiced: 900 } }));
    expect(new Voiceprint({ dir, embedder: () => fakeEmbedder(), log: () => undefined })).toMatchObject({ enrolled: true, level: 0, enrolledPitch: { p90: 131 } });

    writeFileSync(join(dir, VOICEPRINT_FILE), 'not json');
    expect(new Voiceprint({ dir, embedder: () => fakeEmbedder(), log: () => undefined }).enrolled).toBe(false);
  });

  it('learns a reply voice\'s print from up to 20 windows of its audio and keeps it across runs', () => {
    const dir = home();
    const voiceprint = new Voiceprint({ dir, embedder: () => fakeEmbedder(), log: () => undefined });

    expect(voiceprint.voicePrint('marin')).toBeNull();
    voiceprint.learnVoice('marin', tone(3, 200));
    voiceprint.learnVoice('marin', tone(3, 200, 0.05));
    expect(Array.from(voiceprint.voicePrint('marin')!).map((value) => Math.round(value * 1000) / 1000)).toEqual([0.707, 0.707]);

    for (let index = 0; index < 25; index++) {
      voiceprint.learnVoice('cedar', tone(3, 200));
    }

    const saved = JSON.parse(readFileSync(join(dir, TTS_PRINTS_FILE), 'utf8')) as Record<string, { windows: number }>;

    expect([saved['marin']!.windows, saved['cedar']!.windows]).toEqual([2, 20]);
    expect(new Voiceprint({ dir, embedder: () => fakeEmbedder(), log: () => undefined }).voicePrint('cedar')).not.toBeNull();
  });
});

describe('sherpaEmbedder', () => {
  it('scores audio against the closest learnt reply voice, and none before one is learnt or for audio too short', () => {
    const voiceprint = new Voiceprint({ dir: home(), embedder: () => fakeEmbedder(), log: () => undefined });

    expect(voiceprint.replyVoiceScore(tone(2, 200))).toBeNull();
    // Loud audio reads as [1, 0], quiet as [0, 1]: marin learnt from loud audio, cedar from quiet.
    voiceprint.learnVoice('marin', tone(3, 200));
    voiceprint.learnVoice('cedar', tone(3, 200, 0.01));
    expect(voiceprint.replyVoiceScore(tone(2, 200))).toBe(1);
    expect(voiceprint.replyVoiceScore(tone(2, 200, 0.01))).toBe(1);
    expect(voiceprint.replyVoiceScore(tone(0.5, 200))).toBeNull();
  });

  it('scores a voice unlike every learnt reply voice low', () => {
    const voiceprint = new Voiceprint({ dir: home(), embedder: () => fakeEmbedder(), log: () => undefined });

    voiceprint.learnVoice('marin', tone(3, 200));
    expect(voiceprint.replyVoiceScore(tone(2, 200, 0.01))).toBe(0);
  });

  it('runs the speaker model on the CPU through the build recognition uses, and says why when it cannot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'embedder-'));
    const model = join(dir, 'speaker.onnx');
    const configs: unknown[] = [];
    const module = {
      SpeakerEmbeddingExtractor: class {
        constructor(config: unknown) {
          configs.push(config);
        }

        createStream() {
          return { acceptWaveform: () => undefined, inputFinished: () => undefined };
        }

        isReady() {
          return true;
        }

        compute() {
          return new Float32Array([3, 4]);
        }
      },
    };
    const runtime = (loaded: unknown) => ({ get: () => loaded }) as unknown as SherpaRuntime;

    expect(sherpaEmbedder(model, runtime({ device: 'gpu', module }))).toEqual({ error: `No speaker model at ${model}.` });
    writeFileSync(model, '');
    expect(sherpaEmbedder(model, runtime({ error: 'sherpa-onnx did not load: gone' }))).toEqual({ error: 'The speaker model could not load: sherpa-onnx did not load: gone' });

    const embedder = sherpaEmbedder(model, runtime({ device: 'gpu', module }));

    // No provider: the extractor runs on the CPU, even in the CUDA build.
    expect(configs).toEqual([{ model, numThreads: 1, debug: false }]);
    expect([...(embedder as Embedder).embed(new Float32Array(16_000))!]).toEqual([0.6000000238418579, 0.800000011920929]);
  });
});
