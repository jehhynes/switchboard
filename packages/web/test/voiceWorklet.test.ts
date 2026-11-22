import { describe, expect, it } from 'vitest';
import { CAPTURE_RATE, CaptureResampler, FRAME_SAMPLES, PLAY_RATE, PlayQueue, REPORT_MS, START_AFTER_UNDERRUN_MS, START_MS } from '../src/voiceWorklet.js';
import type { PlayReport } from '../src/voiceWorklet.js';

const QUANTUM = 128;
const OUTPUT_RATE = 48_000;
/** Int16 samples of `ms` at 24 kHz, all `value`. */
const pcm = (ms: number, value = 16_384): Int16Array => new Int16Array(Math.round((PLAY_RATE * ms) / 1000)).fill(value);

function setup() {
  const reports: PlayReport[] = [];
  const queue = new PlayQueue(OUTPUT_RATE, (report) => reports.push(report));
  /** Renders quanta, answering whether any held sound. */
  const render = (count = 1): boolean => {
    let sound = false;

    for (let index = 0; index < count; index++) {
      const out = new Float32Array(QUANTUM);

      queue.render(out);
      sound ||= out.some((sample) => sample !== 0);
    }

    return sound;
  };

  return { queue, reports, render };
}

describe('the phone\'s playback worklet (architecture.md § Remote access, Voice on a phone)', () => {
  it('waits for its start buffer, then plays the 24 kHz audio at the output rate and reports the frames played', () => {
    const { queue, reports, render } = setup();

    queue.command({ type: 'open', id: 1 });
    queue.command({ type: 'pcm', id: 1, samples: pcm(START_MS - 10) });
    expect(render(4)).toBe(false);
    queue.command({ type: 'pcm', id: 1, samples: pcm(500) });
    expect(render()).toBe(true);

    // One quantum at 48 kHz plays 64 frames at 24 kHz, half a sample each, at the value sent.
    const out = new Float32Array(QUANTUM);

    queue.render(out);
    expect(out[0]).toBeCloseTo(0.5);
    // A report goes about every 50 ms of output.
    render(Math.ceil((REPORT_MS * OUTPUT_RATE) / 1000 / QUANTUM));
    expect(reports.at(-1)).toMatchObject({ type: 'played', id: 1, done: false, underruns: 0 });
    expect(reports.at(-1)!.frames).toBeGreaterThan(0);
  });

  it('reports done once it played everything sent before its end, and starts an ended short playback at once', () => {
    const { queue, reports, render } = setup();

    queue.command({ type: 'open', id: 2 });
    queue.command({ type: 'pcm', id: 2, samples: pcm(20) });
    queue.command({ type: 'end', id: 2 });
    expect(render()).toBe(true);
    render(10);
    expect(reports.at(-1)).toEqual({ type: 'played', id: 2, frames: 480, done: true, underruns: 0 });
    // Nothing more plays or reports after the end.
    const count = reports.length;

    expect(render(20)).toBe(false);
    expect(reports).toHaveLength(count);
  });

  it('counts an underrun and waits for the larger start buffer, flushes at once, and drops commands of another playback', () => {
    const { queue, reports, render } = setup();

    queue.command({ type: 'open', id: 3 });
    queue.command({ type: 'pcm', id: 3, samples: pcm(START_MS) });
    render(30);
    // The queue ran dry with no end: an underrun; it waits for 200 ms now.
    queue.command({ type: 'pcm', id: 3, samples: pcm(START_AFTER_UNDERRUN_MS - 20) });
    expect(render()).toBe(false);
    queue.command({ type: 'pcm', id: 3, samples: pcm(40) });
    expect(render()).toBe(true);
    render(10);
    expect(reports.at(-1)!.underruns).toBe(1);

    queue.command({ type: 'pcm', id: 9, samples: pcm(100, 1) });
    queue.command({ type: 'flush', id: 3 });
    expect(render(5)).toBe(false);
    // A new playback starts with the larger start buffer still.
    queue.command({ type: 'open', id: 4 });
    queue.command({ type: 'pcm', id: 4, samples: pcm(START_MS + 10) });
    expect(render()).toBe(false);
  });
});

describe('CaptureResampler (architecture.md § Remote access, Voice on a phone)', () => {
  /** Feeds `seconds` of a sine at `hz` and `rate` in render quanta; answers the frames emitted, joined. */
  function resample(rate: number, hz: number, seconds = 0.5, amplitude = 0.5): { frames: Int16Array[]; samples: Int16Array } {
    const frames: Int16Array[] = [];
    const resampler = new CaptureResampler(rate, (frame) => frames.push(frame));
    const total = Math.round(rate * seconds);

    for (let at = 0; at < total; at += QUANTUM) {
      const block = new Float32Array(Math.min(QUANTUM, total - at));

      for (let index = 0; index < block.length; index++) {
        block[index] = Math.sin((2 * Math.PI * hz * (at + index)) / rate) * amplitude;
      }

      resampler.push(block);
    }

    const samples = new Int16Array(frames.length * FRAME_SAMPLES);

    frames.forEach((frame, index) => samples.set(frame, index * FRAME_SAMPLES));
    return { frames, samples };
  }

  const rms = (samples: Int16Array, from: number): number => Math.sqrt(samples.subarray(from).reduce((sum, value) => sum + (value / 32768) ** 2, 0) / (samples.length - from));

  it('turns 48 kHz and 44.1 kHz input into 20 ms frames of 16 kHz audio, keeping speech and its loudness', () => {
    for (const rate of [48_000, 44_100]) {
      const { frames, samples } = resample(rate, 1_000);

      // Half a second is 25 frames, less the filter's delay.
      expect(frames.length).toBeGreaterThanOrEqual(24);
      expect(frames.length).toBeLessThanOrEqual(25);
      expect(frames.every((frame) => frame.length === FRAME_SAMPLES)).toBe(true);
      // A 1 kHz sine at half scale keeps its RMS (0.354) and crosses zero 2,000 times a second at 16 kHz.
      expect(rms(samples, 400)).toBeCloseTo(0.5 / Math.SQRT2, 2);

      let crossings = 0;

      for (let index = 401; index < samples.length; index++) {
        if (samples[index - 1]! < 0 !== samples[index]! < 0) {
          crossings++;
        }
      }

      expect((crossings * CAPTURE_RATE) / (samples.length - 401)).toBeCloseTo(2_000, -2);
    }
  });

  it('filters out what 16 kHz audio cannot hold, rather than folding it into speech', () => {
    // 12 kHz would fold to 4 kHz without the filter.
    expect(rms(resample(48_000, 12_000).samples, 400)).toBeLessThan(0.005);
    // 3 kHz, well inside speech, passes.
    expect(rms(resample(48_000, 3_000).samples, 400)).toBeGreaterThan(0.34);
  });

  it('clips input over full scale instead of wrapping it', () => {
    const { samples } = resample(48_000, 500, 0.2, 1.5);

    expect(Math.max(...samples)).toBe(32767);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-32767);
  });
});
