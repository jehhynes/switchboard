import { describe, expect, it } from 'vitest';
import { PLAY_RATE, PlayQueue, REPORT_MS, START_AFTER_UNDERRUN_MS, START_MS } from '../src/voiceWorklet.js';
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
